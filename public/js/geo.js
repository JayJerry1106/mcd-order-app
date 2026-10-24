/* 定位引擎：设备定位 + 权限处理 + 逆向地理编码（多提供商降级）+ 距离计算
 *
 * 设计要点：
 * 1. 权限：先用 Permissions API 预检（Safari 无此 API，try/catch 兜底）；
 *    拒绝/不可用/超时均有明确错误码与引导文案，并保留手动搜索兜底。
 * 2. 精度与性能：首次 enableHighAccuracy，失败降级为网络定位；
 *    位置结果缓存 5 分钟（避免重复唤醒 GPS），逆向地理编码缓存 30 分钟。
 * 3. 逆向地理编码：Nominatim 与 BigDataCloud 并行请求、各自超时控制，
 *    优先采用道路/小区级精度结果；全部失败时降级为「已定位但无地址」。
 * 4. 距离：Haversine 公式；MCP 门店距离（米）由 searchType=2 按关键词
 *    参考点计算，故定位地址的精确度直接决定门店距离的精确度。
 */
'use strict';

const Geo = {
  status: 'idle',        // 'idle' | 'locating' | 'success' | 'error'
  position: null,        // { lat, lng, accuracy, ts }
  place: null,           // { city, keyword, label, shortLabel, refLat, refLng, refDistance, source }
  error: null,           // { code, reason, hint }

  _posCacheKey: 'mcd_geo_pos_v1',   // 位置缓存 5 分钟
  _placeCacheKey: 'mcd_geo_place_v1', // 逆地理编码缓存 30 分钟
  _POS_TTL: 5 * 60 * 1000,
  _PLACE_TTL: 30 * 60 * 1000,
  _GEO_TIMEOUT_HIGH: 8000,
  _GEO_TIMEOUT_LOW: 12000,
  _REVERSE_TIMEOUT: 2500,

  /** 浏览器是否支持定位 */
  supported() {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  },

  /** 安全上下文要求（HTTPS 或 localhost）；非安全上下文下浏览器直接拒绝定位 */
  secureContext() {
    return typeof window === 'undefined' || window.isSecureContext !== false;
  },

  /** 权限状态预检：'granted' | 'denied' | 'prompt' | 'unsupported' */
  async permissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return 'unsupported';
      const st = await navigator.permissions.query({ name: 'geolocation' });
      return st.state || 'unsupported';
    } catch (_) {
      return 'unsupported';
    }
  },

  /** 清除本地缓存（设置页「重新定位」或调试用） */
  clearCache() {
    try {
      localStorage.removeItem(this._posCacheKey);
      localStorage.removeItem(this._placeCacheKey);
    } catch (_) { /* ignore */ }
  },

  /**
   * 定位主入口。
   * @returns {Promise<{position: object, place: object|null}>}
   *   硬失败（不支持/非安全上下文/权限拒绝/不可用/超时）会 reject（GeoError）；
   *   逆向地理编码失败是软失败：position 正常返回、place 为 null。
   */
  async locate({ force = false } = {}) {
    if (!this.supported()) throw this._err('UNSUPPORTED', '当前浏览器不支持定位', '请手动输入城市与位置关键词搜索门店');
    if (!this.secureContext()) throw this._err('INSECURE', '当前环境不安全（非 HTTPS/localhost），浏览器已禁用定位', '请通过 https 或 localhost 访问，或手动搜索门店');

    // 权限预检：已拒绝时直接给出引导，不再触发浏览器弹窗
    const perm = await this.permissionState();
    if (perm === 'denied' && !force) {
      throw this._err('DENIED', '定位权限已被拒绝', '请点击浏览器地址栏左侧的「位置」图标，将本站设为「允许」后重试；也可以手动搜索门店');
    }

    // 缓存命中（5 分钟内复用，避免重复唤醒 GPS）
    if (!force) {
      const cached = this._readCache();
      if (cached) {
        this.position = cached.position;
        this.place = cached.place;
        this.status = 'success';
        this.error = null;
        return cached;
      }
    }

    this.status = 'locating';
    this.error = null;

    // 渐进精度：先高精度（GPS），失败/超时降级为网络定位
    let position = null;
    try {
      position = await this._getOnce({ enableHighAccuracy: true, timeout: this._GEO_TIMEOUT_HIGH, maximumAge: 30000 });
    } catch (e) {
      if (e.geoCode === 1) throw e; // 权限拒绝：重试无意义，直接向上抛
      try {
        position = await this._getOnce({ enableHighAccuracy: false, timeout: this._GEO_TIMEOUT_LOW, maximumAge: 60000 });
      } catch (e2) {
        throw e2.geoCode ? e2 : e;
      }
    }

    this.position = position;
    this.status = 'success';
    this.error = null;

    // 逆向地理编码（软失败：失败也能继续，只是无法自动生成搜索关键词）
    const place = await this.reverseGeocode(position.lat, position.lng);
    this.place = place;
    this._writeCache(position, place);
    return { position, place };
  },

  /** 单次 getCurrentPosition 封装（超时/不可用/拒绝 → GeoError） */
  _getOnce(options) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this._err('TIMEOUT', '定位超时', '可能处于室内或信号不佳，已自动降级重试；也可手动搜索门店'));
      }, options.timeout + 500);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          const c = pos.coords || {};
          resolve({
            lat: c.latitude, lng: c.longitude,
            accuracy: c.accuracy != null ? Math.round(c.accuracy) : null,
            ts: pos.timestamp || Date.now(),
          });
        },
        (err) => {
          clearTimeout(timer);
          const code = err && err.code;
          if (code === 1) reject(this._err('DENIED', '定位权限被拒绝', '请点击浏览器地址栏左侧的「位置」图标，将本站设为「允许」后重试；也可以手动搜索门店'));
          else if (code === 3) reject(this._err('TIMEOUT', '定位超时', '可能处于室内或信号不佳，已自动降级重试；也可手动搜索门店'));
          else reject(this._err('UNAVAILABLE', '无法获取位置信息', '请检查系统定位服务与网络后重试；也可以手动搜索门店'));
        },
        options
      );
    });
  },

  /** 构造业务错误（带 code/reason/hint 三段，供 UI 分层展示） */
  _err(code, reason, hint) {
    const e = new Error(reason);
    e.geoCode = code;
    e.reason = reason;
    e.hint = hint;
    return e;
  },

  /* ---------- 逆向地理编码（多提供商并行 + 超时 + 缓存） ---------- */

  async reverseGeocode(lat, lng) {
    // 缓存：坐标按约 100m 网格取整
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    try {
      const raw = localStorage.getItem(this._placeCacheKey);
      if (raw) {
        const cache = JSON.parse(raw);
        const hit = cache[key];
        if (hit && Date.now() - hit.at < this._PLACE_TTL) return hit.place;
      }
    } catch (_) { /* ignore */ }

    // 并行请求，任一提供商给出「小区/道路级」结果即采用；
    // 否则等待全部结束后取精度最高者（国内网络下 Nominatim 常不可达，
    // BigDataCloud 约几百毫秒返回区县级，总耗时由最慢的可用提供商决定）
    const providers = [this._reverseNominatim(lat, lng), this._reverseBigDataCloud(lat, lng)];
    let best = null;
    await new Promise((resolve) => {
      let remaining = providers.length;
      // 硬性兜底：即使某提供商的超时未生效，也保证整体有界
      const timer = setTimeout(resolve, this._REVERSE_TIMEOUT + 1500);
      const done = () => { clearTimeout(timer); resolve(); };
      providers.forEach((p) => {
        p.then((r) => {
          if (r && (!best || r.precision > best.precision)) best = r;
          if (best && best.precision >= 3) done();
        }).catch(() => { /* 单提供商失败忽略 */ })
          .finally(() => { if (--remaining === 0) done(); });
      });
    });

    const place = best ? { ...best, approx: best.precision <= 1 } : null;
    if (place) {
      try {
        const raw = localStorage.getItem(this._placeCacheKey);
        const cache = raw ? JSON.parse(raw) : {};
        cache[key] = { at: Date.now(), place };
        localStorage.setItem(this._placeCacheKey, JSON.stringify(cache));
      } catch (_) { /* ignore */ }
    }
    return place;
  },

  /** Nominatim（OSM）：zoom=18 可拿到道路/小区级地址，精度最高 */
  async _reverseNominatim(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=zh-CN`;
    const json = await this._fetchJson(url, this._REVERSE_TIMEOUT);
    const a = (json && json.address) || {};
    const keyword = a.neighbourhood || a.residential || a.quarter || a.road || a.suburb || a.city_district || a.town || a.city;
    const city = a.city || a.town || a.city_district || a.suburb || a.municipality || a.state;
    if (!keyword || !city) return null;
    const refLat = parseFloat(json.lat);
    const refLng = parseFloat(json.lon);
    const refDistance = Number.isFinite(refLat) ? Math.round(haversine(lat, lng, refLat, refLng)) : null;
    const parts = [keyword, a.suburb, a.city_district, city].filter(Boolean);
    return {
      city: t2s(city), keyword: t2s(keyword),
      shortLabel: t2s(keyword),
      label: t2s(parts.join(' · ')),
      refLat: Number.isFinite(refLat) ? refLat : null,
      refLng: Number.isFinite(refLng) ? refLng : null,
      refDistance,
      source: 'nominatim',
      precision: a.neighbourhood || a.residential || a.quarter ? 3 : (a.road ? 2 : 1),
    };
  },

  /** BigDataCloud：免密钥、国内可达性较好，但只到区县级 */
  async _reverseBigDataCloud(lat, lng) {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=zh`;
    const json = await this._fetchJson(url, this._REVERSE_TIMEOUT);
    if (!json) return null;
    const city = json.city || json.locality || json.principalSubdivision;
    const keyword = json.locality || json.city || json.principalSubdivision;
    if (!keyword || !city) return null;
    const labelParts = [keyword];
    if (json.principalSubdivision && !labelParts.includes(json.principalSubdivision)) labelParts.push(json.principalSubdivision);
    if (city && !labelParts.includes(city)) labelParts.push(city);
    return {
      city: t2s(city), keyword: t2s(keyword),
      shortLabel: t2s(keyword),
      label: t2s(labelParts.join(' · ')),
      refLat: null, refLng: null, refDistance: null,
      source: 'bigdatacloud',
      precision: 1,
    };
  },

  async _fetchJson(url, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },

  /* ---------- 本地缓存 ---------- */

  _readCache() {
    try {
      const raw = localStorage.getItem(this._posCacheKey);
      if (!raw) return null;
      const cache = JSON.parse(raw);
      if (Date.now() - cache.at > this._POS_TTL) return null;
      if (!cache.position || !Number.isFinite(cache.position.lat)) return null;
      return cache;
    } catch (_) { return null; }
  },

  _writeCache(position, place) {
    try {
      localStorage.setItem(this._posCacheKey, JSON.stringify({ at: Date.now(), position, place }));
    } catch (_) { /* ignore */ }
  },

  /** 供测试/调试：重置内存状态 */
  reset() {
    this.status = 'idle';
    this.position = null;
    this.place = null;
    this.error = null;
  },
};

/* ---------- 距离工具 ---------- */

/**
 * 常见繁体字 → 简体。
 * 背景：BigDataCloud 的 localityLanguage=zh 实际返回繁体（濟南市/天橋區），
 * 而麦当劳 MCP 只认简体城市名——历史上转换表遗漏「濟」字导致「濟南市」原样透传，
 * 定位搜门店直接报 600014「没有查询到该地址」（2026-10-24 线上实测复现并修复）。
 *
 * 覆盖范围：中国省级/地级行政区名用字 + 常见街道/建筑/POI 用字 + 常见姓氏用字。
 * 转换正则由映射表的键自动生成——新增映射只需改 T2S_MAP 一处，
 * 不会再出现「映射表里有、正则里漏」的两处不同步问题。
 */
const T2S_MAP = {
  // 行政区划与省市地名用字
  區: '区', 縣: '县', 鎮: '镇', 鄉: '乡', 邨: '邨', 町: '町',
  遼: '辽', 寧: '宁', 蘇: '苏', 浙: '浙', 徽: '徽', 雲: '云', 陝: '陕', 肅: '肃',
  臺: '台', 灣: '湾', 爾: '尔', 濱: '滨', 瀋: '沈', 連: '连', 撫: '抚', 錦: '锦',
  營: '营', 盤: '盘', 張: '张', 邯: '邯', 鄲: '郸', 邢: '邢', 滄: '沧', 晉: '晋',
  臨: '临', 呂: '吕', 烏: '乌', 滿: '满', 齊: '齐', 慶: '庆', 鹽: '盐', 揚: '扬',
  宿: '宿', 溫: '温', 紹: '绍', 衢: '衢', 蕪: '芜', 蚌: '蚌', 淮: '淮', 銅: '铜',
  阜: '阜', 馬: '马', 莆: '莆', 漳: '漳', 巖: '岩', 鷹: '鹰', 贛: '赣', 饒: '饶',
  濟: '济', 棗: '枣', 煙: '烟', 濰: '潍', 菏: '菏', 頂: '顶', 許: '许', 漯: '漯',
  駐: '驻', 漢: '汉', 襄: '襄', 鄂: '鄂', 荊: '荆', 邵: '邵', 嶽: '岳', 懷: '怀',
  婁: '娄', 韶: '韶', 關: '关', 汕: '汕', 莞: '莞', 欽: '钦', 貴: '贵', 賀: '贺',
  賓: '宾', 瀘: '泸', 綿: '绵', 貢: '贡', 內: '内', 樂: '乐', 資: '资', 畢: '毕',
  紅: '红', 雙: '双', 薩: '萨', 寶: '宝', 鹹: '咸', 渭: '渭', 蘭: '兰', 衛: '卫',
  魯: '鲁', 勒: '勒', 澳: '澳', 滬: '沪', 潁: '颍', 濮: '濮', 滕: '滕', 漣: '涟',
  沂: '沂', 泗: '泗', 淶: '涞', 淺: '浅', 淞: '淞', 潿: '涠', 潯: '浔',
  // POI / 街道 / 建筑用字
  學: '学', 圖: '图', 體: '体', 劇: '剧', 廟: '庙', 灘: '滩', 碼: '码',
  藥: '药', 貨: '货', 紀: '纪', 機: '机', 遊: '游', 萬: '万', 嚴: '严', 覃: '覃',
  鐵: '铁', 鋼: '钢', 錫: '锡', 廠: '厂', 廳: '厅', 閣: '阁', 節: '节', 簡: '简',
  範: '范', 築: '筑', 籃: '篮', 籠: '笼', 竇: '窦', 窯: '窑', 嶺: '岭', 嶼: '屿',
  恆: '恒', 巔: '巅', 巒: '峦', 巋: '岿', 隴: '陇', 陰: '阴', 階: '阶', 際: '际',
  澤: '泽', 榮: '荣', 橫: '横', 莊: '庄', 萊: '莱', 蓮: '莲', 獲: '获', 喬: '乔',
  蓋: '盖', 蘆: '芦', 趙: '赵', 軟: '软', 較: '较', 輔: '辅', 輛: '辆', 輝: '辉',
  輩: '辈', 輪: '轮', 轉: '转', 轟: '轰', 轎: '轿', 過: '过', 邁: '迈', 遲: '迟',
  適: '适', 選: '选', 遺: '遗', 邊: '边',
  // 地地名高频补充字（按中国地级市名单逐城核对补齐）
  無: '无', 鶴: '鹤', 峽: '峡', 隨: '随', 遠: '远', 來: '来', 達: '达',
  義: '义', 順: '顺', 瑪: '玛', 庫: '库', 裏: '里', 麵: '面', 於: '于',
  餘: '余', 羅: '罗', 禪: '禅', 鏡: '镜', 鐘: '钟', 並: '并',
  // 姓氏与常见人名用字（POI 名常见）
  陳: '陈', 劉: '刘', 黃: '黄', 吳: '吴', 鄭: '郑', 蔡: '蔡', 葉: '叶', 魏: '魏',
  傅: '傅', 鍾: '钟', 譚: '谭', 陸: '陆', 廖: '廖', 韋: '韦', 賈: '贾', 鄒: '邹',
  熊: '熊', 閻: '阎', 陶: '陶', 顧: '顾', 龔: '龚', 盧: '卢', 鄧: '邓', 馮: '冯',
  彭: '彭', 蔣: '蒋', 蕭: '萧', 韓: '韩', 戴: '戴',
  // 通用常见字
  陽: '阳', 國: '国', 銀: '银', 龍: '龙', 鳳: '凤', 華: '华', 東: '东', 門: '门',
  樓: '楼', 廈: '厦', 環: '环', 岡: '冈', 島: '岛', 橋: '桥', 廣: '广', 豐: '丰',
  園: '园', 麗: '丽', 亞: '亚', 運: '运', 業: '业', 場: '场', 館: '馆', 店: '店', 舖: '铺',
};
const T2S_RE = new RegExp('[' + Object.keys(T2S_MAP).join('') + ']', 'g');
function t2s(s) {
  return String(s || '').replace(T2S_RE, (c) => T2S_MAP[c] || c);
}

/** Haversine 距离（米） */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 距离格式化：107 → "107m"；1268 → "1.3km" */
function formatDistance(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return Math.round(n) + 'm';
  const km = n / 1000;
  return (km >= 10 ? km.toFixed(0) : km.toFixed(1).replace(/\.0$/, '')) + 'km';
}

/** 精度文案：±15m */
function formatAccuracy(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return '±' + Math.round(n) + 'm';
  return '±' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'km';
}
