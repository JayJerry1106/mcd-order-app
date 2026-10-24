/* 数据层：始终走服务端 MCP 代理（真实数据，无演示模式） */
'use strict';

const Api = {
  mode: 'offline',        // 'live' | 'offline'
  backendError: null,

  /**
   * 初始化：探测服务端是否提供真实后端（持有麦当劳 MCP Token）。
   * 后端不可用（无 Token / 404 / 非 JSON / 超时 / 网络错误）时，设置 mode='offline'
   * 并记录错误——前端据此展示「需配置后端」提示，绝不回退到任何模拟数据。
   */
  async init() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(appUrl('/api/status'), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('non-json response');
      const json = await res.json();
      if (json?.data?.mode === 'live') {
        this.mode = 'live';
        this.backendError = null;
        return this.mode;
      }
      throw new Error(json?.data?.message || '后端未提供真实数据接口');
    } catch (e) {
      this.mode = 'offline';
      this.backendError = e.message || '后端不可达';
      return this.mode;
    }
  },

  // ---------- 通用请求（实时模式） ----------
  async req(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!json.success) throw new Error(json.error || `接口 ${path} 调用失败`);
    // MCP 业务信封：success:false 时抛出真实原因（如商品已售罄）
    if (json.data && typeof json.data === 'object' && json.data.success === false) {
      throw new Error(json.data.message || '麦当劳返回业务错误');
    }
    return json.data;
  },

  // ---------- 对外统一接口（全部为真实后端调用） ----------

  /**
   * 搜索门店（手动搜索入口）。
   * city+keyword 透传 MCP，并校验返回门店是否真在目标城市——
   * MCP 对无法解析的关键词会静默回退到默认参考点（返回其它城市的门店），
   * 此时必须明确提示，避免用户把「北京的结果」误当成「目标城市的结果」。
   * @returns {Promise<{stores: Array, note: string|null}>}
   */
  async getStores(city, keyword) {
    const d = await this.req(appUrl('/api/stores'), { city, keyword, beType: 1 });
    const stores = d.data || [];
    return { stores, note: this._cityMismatchNote(city, keyword, stores) };
  },

  /** 实时模式诚实性校验：返回门店均不在目标城市 → 关键词未被正确解析（MCP 静默回退） */
  _cityMismatchNote(city, keyword, stores) {
    if (!city || !stores || !stores.length) return null;
    const core = String(city).replace(/[省市区县]$/g, '');
    if (core.length < 2) return null;
    const hit = stores.some((s) =>
      (s.storeName || '').includes(core) || (s.address || '').includes(core));
    if (hit) return null;
    return `搜索结果均不在「${city}」：关键词「${keyword}」可能未被正确解析（已回退到默认参考点），请换用更精确的位置关键词，如路名或商场名`;
  },

  /**
   * 按定位结果搜索门店并排序。
   * 用逆向地理编码得到的 city + POI 关键词调 MCP，MCP 返回的 distance 即为
   * 「距该参考点」的直线距离（米），升序即由近到远。
   * @returns {Promise<{stores: Array, geoNote: string|null, located: boolean}>}
   */
  async getStoresByLocation(place) {
    const located = !!place;
    if (!place) {
      // 定位成功但无法解析地址：保留当前列表，交由 UI 引导手动搜索
      return { stores: [], geoNote: null, located: false };
    }
    const d = await this.req(appUrl('/api/stores'), { city: place.city, keyword: place.keyword, beType: 1 });
    const stores = (d.data || []).slice().sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    let note = null;
    if (place.approx) {
      note = `当前仅解析到区县级（${place.keyword}），距离按区中心计算，可能偏差较大；可手动输入更精确的位置关键词`;
    } else if (place.refDistance > 300) {
      note = `定位参考点与当前位置偏差约 ${formatDistance(place.refDistance)}，距离可能存在误差`;
    } else if (stores.length && stores[0].distance > 8000) {
      // MCP 对无法解析的关键词会静默回退到默认参考点，距离会虚大
      note = '最近门店距离偏远，请确认定位地址或手动输入更精确的位置关键词';
    }
    return { stores, geoNote: note, located: true };
  },

  /** 菜单（自动区分早餐/正餐时段） */
  async getMenu(storeCode, orderType = 1) {
    const d = await this.req(appUrl('/api/menu'), { storeCode, orderType, beType: 1 });
    const menu = d.data || d;
    // 归一化：MCP 的 meals 映射以 code 为键但条目内不含 code 字段，需补齐
    for (const [code, item] of Object.entries(menu.meals || {})) {
      if (item && typeof item === 'object' && !item.code) item.code = code;
    }
    return menu;
  },

  /** 商品详情（含选配轮次与特调） */
  async getMealDetail(storeCode, code) {
    const d = await this.req(appUrl('/api/meal'), { storeCode, code, orderType: 1, beType: 1 });
    return d.data || d;
  },

  /** 麦麦省可领券 */
  async getAvailableCoupons() {
    const d = await this.req(appUrl('/api/coupons/available'));
    return Array.isArray(d) ? d : (d?.data ? (Array.isArray(d.data) ? d.data : Object.values(d.data)) : []);
  },

  /** 一键领取全部可领券 */
  async claimCoupons() {
    return this.req(appUrl('/api/coupons/claim'), {});
  },

  /** 我的券包 */
  async getMyCoupons() {
    const d = await this.req(appUrl('/api/coupons/mine'));
    return d?.coupons ? (Array.isArray(d.coupons) ? d.coupons : Object.values(d.coupons)) : [];
  },

  /** 当前门店可用券 */
  async getStoreCoupons(storeCode, orderType = 1) {
    const d = await this.req(appUrl('/api/coupons/store'), { storeCode, orderType, beType: 1 });
    return Array.isArray(d) ? d : [];
  },

  /** 营养数据 */
  async getNutrition() {
    const d = await this.req(appUrl('/api/nutrition'));
    return parseNutritionText(typeof d === 'string' ? d : d?.text || '');
  },

  /** 核价：组装 calculate-price 入参 */
  buildPriceItems(cart, coupon) {
    const matched = coupon ? this.couponMatchedCodes(coupon, cart) : null;
    return cart.map((line) => {
      const item = { productCode: line.code, quantity: line.qty };
      // 券只能绑定到适用商品，否则 MCP 报 600012
      if (coupon && coupon.id && coupon.source !== 'available' && matched && matched.has(line.code)) {
        item.couponId = coupon.id;
        item.couponCode = coupon.code;
      }
      // 套餐：传递选配轮次（roundList），特调放在对应子项内
      if (line.rounds && line.rounds.length) {
        item.roundList = line.rounds.map((r) => {
          const sub = { code: r.choiceCode, quantity: 1 };
          if (r.mods && r.mods.length) {
            sub.modification = { values: modsToValues(r.mods) };
          }
          return { round: String(r.roundId), comboItemList: [sub] };
        });
      }
      // 单品特调
      if (line.mods && line.mods.length) {
        item.modification = { values: modsToValues(line.mods) };
      }
      return item;
    });
  },

  /** 券与购物车的匹配商品编码集合 */
  couponMatchedCodes(coupon, cart) {
    if (!coupon) return new Set();
    const codes = new Set();
    if (coupon.products && coupon.products.length) {
      const pcodes = coupon.products.map((p) => p.productCode);
      cart.forEach((l) => { if (pcodes.includes(l.code)) codes.add(l.code); });
      return codes;
    }
    const kw = (coupon.title || '').replace(/^[\d.]+元?/, '').replace(/[（(].*?[)）]/g, '').trim();
    if (kw.length >= 2) {
      cart.forEach((l) => {
        const name = l.name.replace(/[（(].*?[)）]/g, '');
        if (name.includes(kw) || kw.includes(name)) codes.add(l.code);
      });
    }
    return codes;
  },

  /** 价格计算（MCP calculate-price） */
  async calculatePrice(storeCode, cart, coupon, needTableware) {
    const d = await this.req(appUrl('/api/price'), {
      storeCode, orderType: 1, beType: 1,
      items: this.buildPriceItems(cart, coupon),
      needTableware: !!needTableware,
    });
    return d.data || d;
  },

  /** 创建订单（MCP create-order，真实下单） */
  async createOrder(storeCode, cart, coupon, takeWayCode, needTableware) {
    const d = await this.req(appUrl('/api/order'), {
      storeCode, orderType: 1, beType: 1,
      items: this.buildPriceItems(cart, coupon),
      takeWayCode, needTableware: !!needTableware,
    });
    return d.data || d;
  },
};

/** 特调项序列化为 MCP values（选中传 selectedKey，未选中且带 unselectedKey 的也必须传） */
function modsToValues(mods) {
  return mods.map((m) => ({
    code: m.itemCode,
    key: m.key,
    quantity: m.selected ? (m.qty || 1) : 0,
  }));
}

/** 解析 MCP 营养文本为 map */
function parseNutritionText(text) {
  const map = {};
  const lines = String(text || '').split('\n').slice(1);
  for (const line of lines) {
    const parts = line.trim().split(',');
    if (parts.length < 9 || !parts[0]) continue;
    map[parts[0].trim()] = {
      energyKj: +parts[2] || 0, energyKcal: +parts[3] || 0,
      protein: +parts[4] || 0, fat: +parts[5] || 0, carbohydrate: +parts[6] || 0,
      sodium: +parts[7] || 0, calcium: +parts[8] || 0,
    };
  }
  return map;
}
