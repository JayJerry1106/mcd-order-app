/* 实时定位专项测试：jsdom 模拟浏览器
 * 覆盖：纯函数（距离/格式化）→ 定位引擎（成功/缓存/拒绝/降级重试/软失败）
 *       → UI 状态机（定位按钮/成功芯片/异常横幅/手动兜底/雷达图/距离徽章/顶栏联动）
 * 不触达真实 MCP 与真实定位：geolocation 与逆向地理编码均为 mock。
 */
'use strict';

const fs = require('fs');
const path = require('path');
let JSDOM;
try {
  ({ JSDOM } = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/jsdom'));
} catch (_) {
  ({ JSDOM } = require('jsdom'));
}

const ROOT = path.join(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures.json'), 'utf8'));
const isBF = (() => { const n = new Date(); return (n.getHours() * 60 + n.getMinutes()) < 10 * 60 + 30; })();

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 8000, interval = 80) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = fn(); if (v) return v; } catch (_) { /* retry */ }
    await sleep(interval);
  }
  return null;
}

/* ---------- mock：设备定位 ---------- */
const geoMock = {
  calls: [],
  mode: 'success', // success | denied | unavailable | timeout
  position: { latitude: 39.9088, longitude: 116.4676, accuracy: 15 }, // 北京建外SOHO（纬度 39.9，经度 116.4）
};
const permMock = { state: 'granted' };

/* ---------- mock：逆向地理编码 ---------- */
const fetchMock = { mode: 'ok', urls: [] };

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://localhost:3210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.addEventListener('error', (e) => console.log('⚠️ PAGE ERROR:', e.message));

  const ok = (data) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  const fakePrice = () => ({
    productOriginalPrice: 0, productPrice: 0, packingPrice: 0, tablewarePrice: 0,
    price: 9999, discount: 0,
    productList: [],
    takeWayList: [ { code: 'eat-in', title: '堂食' }, { code: 'take-in-store', title: '外带' } ],
    enjoyed: null, enjoyable: null,
  });
  window.fetch = async (url, options) => {
    const u = new URL(String(url), 'http://localhost:3210');
    const p = u.pathname;
    if (p === '/api/status') return ok({ success: true, data: { mode: 'live', mcp: true } });
    if (p === '/api/stores') return ok({ success: true, data: { data: fixtures.stores.map((s) => ({ ...s })) } });
    if (p === '/api/menu') return ok({ success: true, data: { data: fixtures.menus[isBF ? 'breakfast' : 'regular'] } });
    if (p === '/api/meal') {
      const code = options && options.body ? JSON.parse(options.body).code : null;
      const d = (code && fixtures.mealDetails[code]) || Object.values(fixtures.mealDetails)[0];
      return ok({ success: true, data: { data: d } });
    }
    if (p === '/api/nutrition') return ok({ success: true, data: { data: fixtures.nutrition } });
    if (p === '/api/coupons/available') return ok({ success: true, data: fixtures.coupons.available });
    if (p === '/api/coupons/mine') return ok({ success: true, data: { coupons: fixtures.coupons.mine } });
    if (p === '/api/coupons/store') return ok({ success: true, data: fixtures.coupons.store });
    if (p === '/api/price') return ok({ success: true, data: { data: fakePrice() } });
    if (u.hostname.includes('nominatim.openstreetmap.org')) {
      fetchMock.urls.push('nominatim');
      if (fetchMock.mode === 'all-fail' || fetchMock.mode === 'nominatim-fail') throw new Error('network down');
      return ok({ address: { neighbourhood: '建外SOHO', suburb: '建国门外街道', city_district: '朝阳区', city: '北京市' }, lat: 39.9088, lon: 116.4675, display_name: '建外SOHO, 东三环中路, 朝阳区, 北京市' });
    }
    if (u.hostname.includes('bigdatacloud.net')) {
      fetchMock.urls.push('bigdatacloud');
      if (fetchMock.mode === 'all-fail') throw new Error('network down');
      // 与真实提供商一致：localityLanguage=zh 实际返回繁体
      return ok({ city: '北京市', locality: '朝陽區', principalSubdivision: '北京市' });
    }
    throw new Error('未预期的请求 ' + p);
  };

  // 注入定位与权限 mock（jsdom 均未实现）
  Object.defineProperty(window.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition(success, error, options) {
        geoMock.calls.push({ enableHighAccuracy: options && options.enableHighAccuracy });
        const n = geoMock.calls.length;
        const failFirst = (geoMock.mode === 'unavailable' || geoMock.mode === 'timeout') && n === 1;
        setTimeout(() => {
          if (geoMock.mode === 'denied') { error({ code: 1, message: 'denied' }); return; }
          if (failFirst) { error({ code: geoMock.mode === 'timeout' ? 3 : 2, message: 'fail' }); return; }
          success({ coords: { ...geoMock.position }, timestamp: Date.now() });
        }, 10);
      },
    },
  });
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state: permMock.state }) },
  });
  window.innerWidth = 1280;
  window.speechSynthesis = { cancel() {}, speak() {} };

  const bundle = ['config.js', 'geo.js', 'api.js', 'state.js', 'checkout.js', 'budget.js', 'voice.js', 'views.js', 'app.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__app = { Store, Api, Draft, Voice, Views, UI, CheckoutCtrl, Geo, haversine, formatDistance, formatAccuracy, hashAngle, BudgetPlanner };';
  window.eval(bundle);
  const App = () => window.__app;
  const S = () => App().Store;
  const G = () => App().Geo;

  await waitFor(() => document.querySelectorAll('.product-card').length > 0, 15000);
  await sleep(300);

  /* ========== 1. 纯函数 ========== */
  console.log('\n--- 距离与格式化工具 ---');
  const { haversine, formatDistance, formatAccuracy, hashAngle } = App();
  check('Haversine 同点为 0', haversine(39.9, 116.4, 39.9, 116.4) === 0);
  const dKnown = haversine(39.9087, 116.3975, 39.9029, 116.4272); // 天安门 → 北京站
  check('Haversine 已知距离合理（天安门→北京站 ≈2.6km）', dKnown > 2000 && dKnown < 3200, Math.round(dKnown) + 'm');
  check('formatDistance 米', formatDistance(107) === '107m');
  check('formatDistance 千米', formatDistance(1268) === '1.3km');
  check('formatDistance 整千米去零', formatDistance(2000) === '2km');
  check('formatDistance 十位千米取整', formatDistance(12300) === '12km');
  check('formatAccuracy 精度', formatAccuracy(15) === '±15m' && formatAccuracy(2500) === '±2.5km');
  check('hashAngle 确定且落在 0-359', hashAngle('1950564') === hashAngle('1950564') && hashAngle('1950564') >= 0 && hashAngle('1950564') < 360);

  /* ========== 2. 定位引擎 ========== */
  console.log('\n--- 定位引擎 ---');

  // 2.1 成功 + 逆向地理编码
  G().clearCache(); G().reset();
  geoMock.calls = []; geoMock.mode = 'success'; permMock.state = 'granted'; fetchMock.mode = 'ok';
  const r1 = await G().locate();
  check('定位成功返回坐标', r1.position && Math.abs(r1.position.lat - 39.9088) < 1e-6, JSON.stringify(r1.position));
  check('定位带精度信息', r1.position.accuracy === 15, '±' + r1.position.accuracy + 'm');
  check('逆向地理编码取到城市', r1.place && r1.place.city === '北京市', r1.place && r1.place.city);
  check('逆向地理编码取到小区级关键词', r1.place && r1.place.keyword === '建外SOHO', r1.place && r1.place.keyword);
  check('优先采用高精度提供商', r1.place && r1.place.source === 'nominatim' && r1.place.precision === 3);
  check('参考点偏差已计算', r1.place && Number.isFinite(r1.place.refDistance) && r1.place.refDistance < 300, r1.place && r1.place.refDistance + 'm');
  check('首次定位使用高精度', geoMock.calls.length === 1 && geoMock.calls[0].enableHighAccuracy === true);

  // 2.2 缓存复用（5 分钟内不重复唤醒 GPS）
  const r2 = await G().locate();
  check('缓存命中不再调用定位接口', geoMock.calls.length === 1, 'calls=' + geoMock.calls.length);
  check('缓存返回一致结果', r2.place && r2.place.keyword === '建外SOHO');
  // 强制刷新绕过缓存
  await G().locate({ force: true });
  check('强制刷新绕过缓存', geoMock.calls.length === 2, 'calls=' + geoMock.calls.length);

  // 2.3 权限预检拒绝（不触发浏览器弹窗）
  G().clearCache(); G().reset();
  geoMock.calls = []; permMock.state = 'denied';
  let denied = null;
  try { await G().locate(); } catch (e) { denied = e; }
  check('权限预检拒绝即报错', denied && denied.geoCode === 'DENIED', denied && denied.geoCode);
  check('拒绝时不触发 getCurrentPosition', geoMock.calls.length === 0, 'calls=' + geoMock.calls.length);
  check('拒绝错误含引导文案', denied && /地址栏|允许/.test(denied.hint || ''));

  // 2.4 getCurrentPosition 拒绝（Permissions API 不可用时）
  G().clearCache(); G().reset();
  geoMock.calls = []; permMock.state = 'granted'; geoMock.mode = 'denied';
  let denied2 = null;
  try { await G().locate(); } catch (e) { denied2 = e; }
  check('定位回调拒绝映射为 DENIED', denied2 && denied2.geoCode === 'DENIED', denied2 && denied2.geoCode);

  // 2.5 不可用 → 降级为网络定位重试
  G().clearCache(); G().reset();
  geoMock.calls = []; permMock.state = 'granted'; geoMock.mode = 'unavailable';
  const r3 = await G().locate();
  check('不可用后降级重试成功', !!r3.position, 'calls=' + geoMock.calls.length);
  check('第二次为低精度（网络定位）', geoMock.calls.length === 2 && geoMock.calls[1].enableHighAccuracy === false,
    JSON.stringify(geoMock.calls));

  // 2.6 超时 → 降级重试
  G().clearCache(); G().reset();
  geoMock.calls = []; geoMock.mode = 'timeout';
  const r4 = await G().locate();
  check('超时后降级重试成功', !!r4.position && geoMock.calls.length === 2);

  // 2.7 逆向地理编码全部失败 → 软失败（place=null，position 仍有效）
  G().clearCache(); G().reset();
  geoMock.calls = []; geoMock.mode = 'success'; fetchMock.mode = 'all-fail';
  const r5 = await G().locate();
  check('逆地理编码失败为软失败', !!r5.position && r5.place === null, 'place=' + JSON.stringify(r5.place));

  // 2.8 Nominatim 不可达（国内常见）→ 降级 BigDataCloud 区县级，并标记 approx
  G().clearCache(); G().reset();
  geoMock.calls = []; geoMock.mode = 'success'; fetchMock.mode = 'nominatim-fail';
  const r6 = await G().locate();
  check('Nominatim 失败降级到 BigDataCloud', r6.place && r6.place.source === 'bigdatacloud', r6.place && r6.place.source);
  check('区县级结果标记 approx', r6.place && r6.place.approx === true && r6.place.precision === 1,
    JSON.stringify(r6.place));
  check('繁体地名转换为简体（展示与搜索一致）', r6.place && r6.place.keyword === '朝阳区' && r6.place.city === '北京市',
    r6.place && r6.place.keyword + ' / ' + r6.place.city);
  check('标签去重拼接', r6.place && r6.place.label === '朝阳区 · 北京市', r6.place && r6.place.label);

  /* ========== 3. 数据层：门店排序与诚实性（实时） ========== */
  console.log('\n--- 数据层：门店排序与诚实性 ---');
  geoMock.mode = 'success'; fetchMock.mode = 'ok';
  const apiObj = App().Api;
  const origReq = apiObj.req;
  apiObj.req = async () => ({ data: fixtures.stores.map((s) => ({ ...s })) });
  const loc = await apiObj.getStoresByLocation({ city: '北京市', keyword: '建外SOHO', label: 'x', refDistance: 10, approx: false });
  const dists = loc.stores.map((s) => s.distance);
  check('实时：门店按距离升序', dists.every((d, i) => i === 0 || dists[i - 1] <= d), dists.join(','));
  check('实时：精确小区级定位无多余提示', loc.geoNote === null, String(loc.geoNote));

  // 区县级定位 → 精度提示与排序（打桩 req，不触达真实 MCP）
  apiObj.req = async () => ({ data: [
    { storeCode: 'B', storeName: '麦当劳测试B餐厅', distance: 642 },
    { storeCode: 'A', storeName: '麦当劳测试A餐厅', distance: 107 },
  ] });
  const liveApprox = await apiObj.getStoresByLocation({ city: '北京市', keyword: '朝阳区', label: 'x', refDistance: null, approx: true, precision: 1 });
  check('区县级定位返回精度提示', /区县级/.test(liveApprox.geoNote || ''), liveApprox.geoNote);
  check('实时分支按距离升序', liveApprox.stores.map((s) => s.distance).join(',') === '107,642');
  const livePrecise = await apiObj.getStoresByLocation({ city: '北京市', keyword: '建外SOHO', label: 'x', refDistance: 50, approx: false, precision: 3 });
  check('小区级定位无多余提示', livePrecise.geoNote === null, String(livePrecise.geoNote));
  const liveFar = await apiObj.getStoresByLocation({ city: '北京市', keyword: '建外SOHO', label: 'x', refDistance: 800, approx: false, precision: 3 });
  check('参考点偏差大时提示误差', /偏差/.test(liveFar.geoNote || ''), liveFar.geoNote);
  apiObj.req = async () => ({ data: [{ storeCode: 'R', storeName: '麦当劳偏远餐厅', distance: 9500 }] });
  const liveRemote = await apiObj.getStoresByLocation({ city: '北京市', keyword: '建外SOHO', label: 'x', refDistance: 50, approx: false, precision: 3 });
  check('最近门店过远时提示确认位置', /偏远/.test(liveRemote.geoNote || ''), liveRemote.geoNote);
  apiObj.req = origReq;

  /* ========== 3.6 门店搜索诚实性（济南搜索返回北京门店 bug 回归） ========== */
  console.log('\n--- 门店搜索诚实性 ---');
  // 实时模式：关键词未解析 → MCP 静默回退默认参考点返回北京门店 → 必须提示城市不匹配
  const apiObj2 = App().Api;
  const origReq2 = apiObj2.req;
  apiObj2.req = async () => ({ data: [
    { storeCode: 'BJ1', storeName: '麦当劳北京建外SOHO(A座)餐厅', address: '东三环中路39号院', distance: 269 },
    { storeCode: 'BJ2', storeName: '麦当劳北京光华东里餐厅', address: '光华东里8号院', distance: 394 },
  ] });
  const liveMismatch = await apiObj2.getStores('济南市', '无影山');
  check('实时模式搜济南返回北京门店时提示不匹配', /不在「济南市」/.test(liveMismatch.note || ''), liveMismatch.note);
  apiObj2.req = async () => ({ data: [
    { storeCode: 'JN1', storeName: '麦当劳济南金牛大厦餐厅', address: '济泺路', distance: 1130 },
  ] });
  const liveHit = await apiObj2.getStores('济南市', '无影山');
  check('实时模式正确返回济南门店时无提示', liveHit.note === null, String(liveHit.note));
  apiObj2.req = origReq2;

  /* ========== 4. UI 状态机 ========== */
  console.log('\n--- UI 状态机 ---');
  S().setStorePicker(true);
  await waitFor(() => document.querySelector('.geo-locate-btn'));
  check('门店选择器展示定位按钮', !!document.querySelector('.geo-locate-btn'));
  check('手动搜索兜底常驻', !!document.querySelector('#manual-city') && !!document.querySelector('#manual-kw'));

  // 4.1 定位成功 → 距离徽章 + 雷达 + 顶栏联动
  G().clearCache(); G().reset();
  geoMock.calls = []; geoMock.mode = 'success'; permMock.state = 'granted'; fetchMock.mode = 'ok';
  document.querySelector('[data-action="locate-me"]').click();
  await waitFor(() => S().state.geo.status === 'success' && document.querySelector('.store-dist'), 10000);
  check('定位后面板显示当前地址', /建外SOHO/.test((document.querySelector('.geo-chip-label') || {}).textContent || ''));
  check('门店列表显示距离徽章', document.querySelectorAll('.store-dist').length > 0,
    document.querySelectorAll('.store-dist').length + ' 个');
  check('门店卡片显示营业状态徽章', document.querySelectorAll('.store-status').length > 0,
    document.querySelectorAll('.store-status').length + ' 个');
  check('营业状态文案有效（营业中/暂停营业/即将打烊）', Array.from(document.querySelectorAll('.store-status'))
    .every((el) => /营业中|暂停营业|即将打烊/.test(el.textContent)), '');
  check('雷达图渲染（同心圆+标记）', !!document.querySelector('.store-radar svg') && document.querySelectorAll('.store-radar circle').length >= 3);
  check('实时模式不展示演示降级说明', !/演示模式/.test((document.querySelector('.geo-note') || {}).textContent || ''));
  check('顶栏显示定位地址', /建外SOHO/.test((document.querySelector('#store-pill-text') || {}).textContent || ''));
  const sortedDists = Array.from(document.querySelectorAll('.store-dist')).map((el) => parseFloat(el.textContent));
  check('列表按距离由近到远', sortedDists.every((d, i) => i === 0 || sortedDists[i - 1] <= d), sortedDists.join(','));

  // 4.2 权限拒绝 → 异常横幅 + 引导 + 手动兜底仍在
  G().clearCache(); G().reset();
  geoMock.calls = []; permMock.state = 'denied'; geoMock.mode = 'denied';
  document.querySelector('[data-action="retry-locate"]').click();
  await waitFor(() => document.querySelector('.geo-alert.error'), 8000);
  const alertText = (document.querySelector('.geo-alert.error') || {}).textContent || '';
  check('拒绝时展示异常横幅', /权限/.test(alertText), alertText.slice(0, 40));
  check('横幅含浏览器设置引导', /地址栏|允许/.test(alertText));
  check('拒绝时保留手动搜索兜底', !!document.querySelector('#manual-city'));
  check('定位按钮变为重试', !!document.querySelector('[data-action="retry-locate"]'));

  // 4.3 回调拒绝（Permissions 预检放行、回调仍拒绝的路径）
  G().clearCache(); G().reset();
  geoMock.calls = []; permMock.state = 'granted'; geoMock.mode = 'denied';
  document.querySelector('[data-action="retry-locate"]').click();
  await waitFor(() => document.querySelector('.geo-alert.error'), 8000);
  check('回调拒绝同样展示横幅', /权限/.test((document.querySelector('.geo-alert.error') || {}).textContent || ''));

  // 4.4 手动搜索兜底可用（复现用户反馈：演示模式搜「济南市/无影山」）
  geoMock.mode = 'success';
  document.querySelector('#manual-city').value = '济南市';
  document.querySelector('#manual-kw').value = '无影山';
  document.querySelector('[data-action="manual-store-search"]').click();
  await waitFor(() => S().state.storeRef && S().state.storeRef.label === '无影山', 8000);
  check('手动搜索更新参考点', S().state.storeRef.label === '无影山', JSON.stringify(S().state.storeRef));
  check('手动搜索后列表重渲染', document.querySelectorAll('.store-dist').length > 0);

  // 4.4b 诚实性：实时模式不得把北京门店伪装成「相对无影山排序的结果」，
  // 且必须提示城市不匹配（济南搜索返回北京门店的回归）
  await sleep(200);
  const descText = (document.querySelector('#store-picker-desc') || {}).textContent || '';
  check('实时模式描述标明数据来自实时查询', /实时查询/.test(descText), descText.slice(0, 70));
  const noteText = (document.querySelector('.geo-note') || {}).textContent || '';
  check('实时模式搜外地返回北京门店时展示城市不匹配提示', /不在「济南市」/.test(noteText), noteText.slice(0, 70));
  const radarText = (document.querySelector('.store-radar') || {}).textContent || '';
  check('雷达中心标签为搜索关键词（非国贸）', /无影山/.test(radarText) && !/国贸/.test(radarText));
  check('门店列表为返回的真实门店（5 家北京）', document.querySelectorAll('.store-list .round-choice').length === fixtures.stores.length,
    document.querySelectorAll('.store-list .round-choice').length + ' 家');
  const firstName = (document.querySelector('.store-list .rc-name') || {}).textContent || '';
  check('列表内容为北京门店（与提示一致）', /北京/.test(firstName), firstName.slice(0, 30));

  // 4.5 模态框键盘无障碍（P2-1）：ARIA 标注 / Esc 关闭 / 焦点恢复 / 焦点圈定
  console.log('\n--- 模态框键盘无障碍 ---');
  S().setStorePicker(false);
  await sleep(150);
  const pillBtn = document.querySelector('#store-pill');
  pillBtn.focus();
  S().setStorePicker(true);
  await waitFor(() => document.querySelector('.modal-mask'), 5000);
  const dialogBox = document.querySelector('.modal-box');
  check('模态框标注 role=dialog 与 aria-modal', dialogBox.getAttribute('role') === 'dialog' && dialogBox.getAttribute('aria-modal') === 'true');
  const modalFocusables = Array.from(document.querySelectorAll('.modal-mask button:not([disabled]), .modal-mask input:not([disabled])'));
  check('打开后焦点移入模态框首个可操作元素', modalFocusables.length > 0 && document.activeElement === modalFocusables[0],
    'active=' + ((document.activeElement || {}).className || document.activeElement.tagName));
  modalFocusables[modalFocusables.length - 1].focus();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check('Tab 到末尾圈回首元素（焦点陷阱）', document.activeElement === modalFocusables[0],
    'active=' + ((document.activeElement || {}).className || ''));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  check('Esc 关闭模态框', !document.querySelector('.modal-mask'));
  check('关闭后焦点还给触发按钮（门店 pill）', document.activeElement === pillBtn,
    'active=' + ((document.activeElement || {}).id || document.activeElement.tagName));

  /* ========== 5. 语音指令 ========== */
  console.log('\n--- 语音指令 ---');
  let spoke = '';
  App().Voice.reply = (t) => { spoke = t; };
  await App().Voice.handleCommand('定位附近门店');
  check('语音「定位附近门店」打开门店选择并触发定位', S().state.ui.storePickerOpen === true && /位置|定位/.test(spoke), spoke);
  await waitFor(() => S().state.geo.status === 'success', 10000);
  check('语音定位链路完成', S().state.geo.status === 'success');

  // 5.1 语音浮层键盘无障碍（P2-1）
  S().setStorePicker(false);
  await sleep(150);
  App().Voice.open();
  await sleep(200);
  check('语音浮层标注 role=dialog', document.querySelector('#voice-overlay').getAttribute('role') === 'dialog');
  check('语音浮层打开后焦点落在关闭按钮', document.activeElement === document.querySelector('#voice-close-btn'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(150);
  check('Esc 关闭语音浮层', document.querySelector('#voice-overlay').hidden === true);

  /* ========== 汇总 ========== */
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 定位功能测试：${pass}/${results.length} 通过 ==========`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(' ❌', f.name, f.extra));
    process.exitCode = 1;
  }
  window.close();
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exitCode = 1;
});
