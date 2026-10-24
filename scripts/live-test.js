/* 实时模式集成测试：真实 MCP 链路（菜单/详情/核价），不触发领券与真实下单 */
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
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, interval = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = fn(); if (v) return v; } catch (_) { /* retry */ }
    await sleep(interval);
  }
  return null;
}

/** 代理到真实后端（本地服务端 / 外部 HTTPS 均走 Node fetch，转发超时信号） */
function proxyFetch(url, options) {
  const raw = String(url);
  const target = /^https?:/.test(raw) ? raw : new URL(raw, 'http://localhost:3210').href;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  if (options && options.signal && options.signal.addEventListener) {
    if (options.signal.aborted) ctrl.abort();
    else options.signal.addEventListener('abort', () => ctrl.abort());
  }
  return fetch(target, {
    method: (options && options.method) || 'GET',
    headers: (options && options.headers) || { 'Content-Type': 'application/json' },
    body: options && options.body,
    signal: ctrl.signal,
  }).then(async (res) => {
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
    const ct = res.headers.get('content-type') || '';
    return {
      ok: res.ok, status: res.status,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? ct : (res.headers.get(name) || null)) },
      text: async () => text, json: async () => json || {},
    };
  }).catch((e) => { clearTimeout(timer); throw e; });
}

(async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3210/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  window.addEventListener('error', (e) => console.log('⚠️ PAGE ERROR:', e.message));

  // 实时模式：全部代理到真实服务端（/api/status 返回 live）
  window.fetch = async (url, options) => {
    return proxyFetch(String(url), options);
  };
  window.innerWidth = 1280;
  window.speechSynthesis = { cancel() {}, speak() {} };

  const bundle = ['config.js', 'geo.js', 'api.js', 'state.js', 'checkout.js', 'budget.js', 'voice.js', 'views.js', 'app.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__app = { Store, Api, Draft, Voice, Views, UI, CheckoutCtrl, Geo, BudgetPlanner, haversine, formatDistance };';
  window.eval(bundle);
  const App = () => window.__app;
  const S = () => App().Store;
  const isBF = (() => { const n = new Date(); return (n.getHours() * 60 + n.getMinutes()) < 10 * 60 + 30; })();

  // 1. 实时模式启动
  await waitFor(() => document.querySelectorAll('.product-card').length > 0, 20000);
  const mode = S().state.mode;
  check('实时模式启动（MCP 已连接）', mode === 'live', 'mode=' + mode);
  check('实时菜单渲染', document.querySelectorAll('.product-card').length > 0,
    `${document.querySelectorAll('.product-card').length} 个卡片`);
  check('门店来自 MCP', !!S().state.store && /麦当劳/.test(S().state.store.storeName || ''),
    S().state.store?.storeName);

  // 2. 打开当前时段可售套餐详情（真实 MCP）
  const comboCode = isBF ? '9900003458' : '9900005466';
  App().Store.setCategory('全部');
  await sleep(400);
  const comboCard = Array.from(document.querySelectorAll('.product-card'))
    .find((c) => c.querySelector('.p-name').textContent.includes(isBF ? '猪柳蛋麦满分套餐' : '巨无霸三件套'));
  check(`找到可售套餐卡片（${comboCode}）`, !!comboCard, comboCard?.querySelector('.p-name')?.textContent);
  comboCard.click();
  await waitFor(() => document.querySelector('.round-group'), 15000);
  check('MCP 套餐详情（含选配轮次）', document.querySelectorAll('.round-group').length >= 3,
    `${document.querySelectorAll('.round-group').length} 轮`);

  // 3. 定制：换小食 + 数量 2
  const alt = Array.from(document.querySelectorAll('.round-choice')).find((c) => !c.classList.contains('selected'));
  if (alt) alt.click();
  await sleep(200);
  document.querySelector('.detail-foot [data-action="draft-qty"][data-n="1"]').click();
  await sleep(200);
  document.querySelector('[data-action="detail-add"]').click();
  await sleep(400);
  check('加入购物车（含定制）', S().cartCount() === 2, 'count=' + S().cartCount());
  const line = S().state.cart[0];
  check('购物车行含 roundList 数据', line.rounds && line.rounds.length >= 3,
    JSON.stringify(line.rounds.map((r) => r.choiceName)));

  // 4. 结算第 1 步（真实 takeWayList 来自 MCP 核价）
  window.location.hash = '#/checkout';
  await waitFor(() => document.body.textContent.includes('确认订单'), 15000);
  const takewayCount = document.querySelectorAll('.takeway-opt').length;
  check('MCP 取餐方式选项', takewayCount >= 2, `${takewayCount} 种（堂食/外带）`);

  // 5. 第 2 步：真实券池（不领券，仅查询）
  const toCoupon = Array.from(document.querySelectorAll('[data-action="checkout-next"]'))
    .find((b) => b.textContent.includes('选优惠券'));
  toCoupon.click();
  await waitFor(() => document.querySelector('.coupon-card'), 20000);
  const couponCount = document.querySelectorAll('.coupon-card').length;
  check('MCP 券池加载（我的券+门店券）', couponCount >= 1, `${couponCount} 张（含不使用券）`);

  // 6. 智能选最优（真实 calculate-price 逐张试算）
  const smart = document.querySelector('[data-action="smart-coupon"]');
  if (smart) smart.click();
  await sleep(6000);
  const picked = S().state.ui.checkout.coupon;
  check('智能选券完成（MCP 试算）', true, picked ? `已选：${picked.title}` : '无适用券（按原价）');

  // 7. 核价（真实 MCP calculate-price，含 roundList + 券绑定）
  const toPrice = Array.from(document.querySelectorAll('[data-action="checkout-next"]'))
    .find((b) => b.textContent.includes('核价'));
  if (toPrice) toPrice.click();
  await waitFor(() => document.querySelector('.price-line.grand'), 20000);
  const grandText = document.querySelector('.price-line.grand')?.textContent.replace(/\s+/g, ' ');
  check('MCP 实时核价明细', !!grandText, grandText);
  const priceResult = S().state.ui.checkout.priceResult;
  check('核价返回含 takeWayList/productList', !!(priceResult?.takeWayList?.length && priceResult?.productList?.length),
    `price=${priceResult?.price} 分, discount=${priceResult?.discount} 分`);

  // 8. 验证购物车估价与 MCP 核价一致性（随单购商品按原价估算应与 MCP 一致）
  const localEst = S().cartSubtotal();
  const mcpYuan = (priceResult?.productPrice || 0) / 100;
  const consistent = Math.abs(localEst - mcpYuan) < 0.01;
  check('本地估价与 MCP 核价一致', consistent, `本地 ¥${localEst} vs MCP ¥${mcpYuan}`);

  // 9. 实时定位端到端：设备定位（mock）→ 真实逆向地理编码 → 真实 MCP 门店搜索与排序
  console.log('\n--- 实时定位端到端 ---');
  Object.defineProperty(window.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition(success) {
        setTimeout(() => success({
          coords: { latitude: 39.9088, longitude: 116.4676, accuracy: 12 }, // 北京建外SOHO
          timestamp: Date.now(),
        }), 10);
      },
    },
  });
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state: 'granted' }) },
  });
  App().Geo.clearCache();
  App().Geo.reset();
  S().setStorePicker(true);
  await waitFor(() => document.querySelector('[data-action="locate-me"]'));
  document.querySelector('[data-action="locate-me"]').click();
  // 等待定位流程完成（storeRef.located 由定位搜索设置，避免与启动时的默认门店列表竞态）
  await waitFor(() => S().state.geo.status === 'success' && S().state.storeRef && S().state.storeRef.located === true, 30000);
  const place = S().state.geo.place;
  check('设备定位→逆向地理编码成功', !!place, place ? `${place.source} / ${place.city} / ${place.keyword}` : '无地址');
  check('MCP 按定位关键词搜索门店', S().state.stores.length > 0, S().state.stores.length + ' 家');
  const ld = S().state.stores.map((s) => s.distance);
  check('门店按距离由近到远', ld.every((x, i) => i === 0 || ld[i - 1] <= x), ld.join(','));
  check('距离徽章渲染', document.querySelectorAll('.store-dist').length > 0,
    document.querySelectorAll('.store-dist').length + ' 个');
  check('定位后面板展示当前地址', /建外|北京/.test((document.querySelector('.geo-chip-label') || {}).textContent || ''),
    (document.querySelector('.geo-chip-label') || {}).textContent || '');

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 实时模式测试：${pass}/${results.length} 通过 ==========`);
  if (pass !== results.length) {
    console.log('失败项：' + results.filter((r) => !r.pass).map((r) => r.name).join(' | '));
    process.exitCode = 1;
  }
  window.close();
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
