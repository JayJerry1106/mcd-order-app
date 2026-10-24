/* 饭点安排 · 预算搭配引擎测试（jsdom，无网络）：
 * 商品分类 / 桶提取 / 枚举 / 排序 / MCP 核实降级 / 完整 plan / 一键加购 / 订单映射 / 语音指令 */
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
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 8000, interval = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = fn(); if (v) return v; } catch (_) { /* retry */ }
    await sleep(interval);
  }
  return null;
}

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://localhost:3210/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.addEventListener('error', (e) => console.log('⚠️ PAGE ERROR:', e.message));
  window.speechSynthesis = { cancel() {}, speak() {} };

  const ok = (data) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  window.fetch = async (url) => {
    const p = new URL(String(url), 'http://localhost:3210').pathname;
    if (p === '/api/status') return ok({ success: true, data: { mode: 'live', mcp: true } });
    if (p === '/api/stores') return ok({ success: true, data: { data: fixtures.stores.map((s) => ({ ...s })) } });
    if (p === '/api/menu') return ok({ success: true, data: { data: fixtures.menus.regular } });
    throw new Error('未预期的请求 ' + p);
  };
  window.innerWidth = 1280;

  const bundle = ['config.js', 'geo.js', 'api.js', 'state.js', 'checkout.js', 'budget.js', 'voice.js', 'views.js', 'app.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__app = { Store, Api, BudgetPlanner, Views, UI, Voice };';
  window.eval(bundle);
  const S = () => window.__app.Store;
  const B = () => window.__app.BudgetPlanner;

  await waitFor(() => document.querySelectorAll('.product-card').length > 0);
  check('启动：菜单渲染完成', document.querySelectorAll('.product-card').length > 0);

  /* ===== 1. 商品分类（分类名 + 名称正则双重判定） ===== */
  const cls = (name, cat) => B().classify({ name }, cat);
  check('分类：巨无霸 → main', cls('巨无霸') === 'main');
  check('分类：中薯条 → snack', cls('中薯条') === 'snack');
  check('分类：可口可乐（中杯）→ drink', cls('可口可乐（中杯）') === 'drink');
  check('分类：麦旋风 → dessert', cls('麦旋风') === 'dessert');
  check('分类：巨无霸三件套 → combo', cls('巨无霸三件套') === 'combo');
  check('分类：随心配1+1 → combo', cls('随心配1+1') === 'combo');
  check('分类：分类名「饮品」驱动 → drink', cls('元气菌', '饮品') === 'drink');
  check('分类：分类名「麦满分系列」驱动 → main', cls('芝蛋满', '麦满分系列') === 'main');
  check('分类：麦辣鸡翅 → snack（翅先于麦辣判定）', cls('麦辣鸡翅') === 'snack');
  check('分类：那么大鸡排 → snack', cls('那么大鸡排（椒盐风味）') === 'snack');
  check('分类：灰焰圆筒 → dessert', cls('灰焰圆筒') === 'dessert');
  check('分类：苹果片 → snack', cls('苹果片') === 'snack');
  check('分类：纯牛奶(盒装) → drink（盒不判小食）', cls('纯牛奶(盒装)') === 'drink');
  check('分类：100% 苹果汁(盒装) → drink', cls('100% 苹果汁(盒装)') === 'drink');
  check('分类：玉米杯 → snack（玉米先于杯判定）', cls('玉米杯') === 'snack');

  /* ===== 2. 桶提取 ===== */
  const b = B().buckets();
  check('桶提取：主食桶非空', b.main.length > 0);
  check('桶提取：小食桶非空', b.snack.length > 0);
  check('桶提取：饮料桶非空', b.drink.length > 0);
  check('桶提取：不含套餐类', ![...b.main, ...b.snack, ...b.drink, ...b.dessert].some((e) => /套餐|件套|随心配/.test(e.name)));
  check('桶提取：按价格升序截断', b.main.every((e, i, a) => i === 0 || a[i - 1].est <= e.est));
  check('桶提取：数量有上限', b.main.length <= 14 && b.snack.length <= 14 && b.drink.length <= 12);

  /* ===== 3. 枚举 ===== */
  const r50 = B().enumerate(50);
  check('枚举：¥50 有解', r50.combos.length > 0);
  check('枚举：组合均不超预算', r50.combos.every((c) => c.est <= 50 + 1e-9));
  check('枚举：组合为三项（主食+小食+饮料）', r50.combos.every((c) => c.entries.length === 3));
  check('枚举：组合项互不重复', r50.combos.every((c) => new Set(c.entries.map((e) => e.code)).size === c.entries.length));
  const r5 = B().enumerate(5);
  check('枚举：¥5 无解且给出最便宜提示', r5.combos.length === 0 && r5.cheapest && r5.cheapest.est > 5);

  /* ===== 4. 本地排序 ===== */
  B().mode = 'save';
  const ranked = B().rank(r50.combos);
  check('排序：省钱模式按估价升序', ranked.every((c, i, a) => i === 0 || a[i - 1].est <= c.est));
  B().mode = 'full';
  const rankedFull = B().rank(r50.combos);
  check('排序：吃饱模式返回全部组合（无热量数据时退化为贴近预算）', rankedFull.length === r50.combos.length);
  B().mode = 'save';

  /* ===== 5. MCP 核实与降级 ===== */
  const stubCalc = (fen) => { window.__app.Api.calculatePrice = async (storeCode, items) => ({ price: items.length * fen, productOriginalPrice: items.length * 1200 }); };
  stubCalc(1000);
  const verified = await B().verify(B().rank(r50.combos).slice(0, 4));
  check('核实：候选全部标记 verified', verified.every((v) => v.verified === true));
  check('核实：实时价 = 分转元（¥10/项）', verified.every((v) => Math.abs(v.realPrice - v.entries.length * 10) < 1e-9));
  const resort = B().resort(verified);
  check('核实后重排：按实时价升序', resort.every((c, i, a) => i === 0 || a[i - 1].realPrice <= c.realPrice));
  window.__app.Api.calculatePrice = async () => { throw new Error('MCP 不可用'); };
  const degraded = await B().verify(B().rank(r50.combos).slice(0, 2));
  check('核实失败：降级本地估价且标记未核实', degraded.every((v) => v.verified === false && v.realPrice === v.est));

  /* ===== 6. 完整 plan 流程 ===== */
  stubCalc(1000);
  B().budget = 50;
  await B().plan();
  check('plan：¥50 输出 3 套方案', !!(B().result && B().result.ok && B().result.combos.length === 3));
  check('plan：方案结构完整（items + realPrice）', B().result.combos.every((c) => c.entries.length >= 2 && c.realPrice > 0));
  B().budget = 5;
  await B().plan();
  check('plan：¥5 无解并提示最低预算', !!(B().result && !B().result.ok && B().result.cheapest));
  B().budget = 50;

  /* ===== 7. 一键加入购物车 ===== */
  await B().plan();
  const before = S().cartCount();
  const combo0 = B().result.combos[0];
  B().addCombo(0);
  check('加购：购物车增加组合全部项', S().cartCount() === before + combo0.entries.length, `${before} → ${S().cartCount()}`);
  check('加购：浮层关闭', B().open === false);

  /* ===== 8. 订单映射（MCP order-list → 展示结构 + 去重） ===== */
  S().setMcpOrders([{
    orderId: 'A1', orderStatus: '订单已取消', storeName: '麦当劳济南北园银座家居IS餐厅',
    orderType: '1', createTime: '2026-10-21 19:42:20', realTotalAmount: '29.9',
    orderProductList: [{ productCode: '9900016075', productName: '龙焰芝士棒鸡腿堡三件套', quantity: 1 }],
  }]);
  S().setRoute('orders');
  await sleep(80);
  const ordersHtml = document.querySelector('#view-root').innerHTML;
  check('订单页：渲染 MCP 实时订单（门店/金额）', ordersHtml.includes('济南北园') && ordersHtml.includes('29.9'));
  check('订单页：标注实时订单来源', ordersHtml.includes('已接入麦当劳账户实时订单'));
  S().addOrder({ orderId: 'A1', pickupCode: '1', status: '待支付', storeName: '本地测试店', items: [{ name: '本地商品', qty: 1 }], total: 10, time: 'x', takeWay: '到店' });
  await sleep(80);
  check('订单页：本地订单按 orderId 去重', !document.querySelector('#view-root').innerHTML.includes('本地测试店'));

  /* ===== 9. 语音指令 ===== */
  await window.__app.Voice.handleCommand('50元吃什么');
  check('语音：预算指令打开搭配浮层并带入预算', B().open === true && B().budget === 50);

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass === results.length ? '✅' : '❌'} 预算搭配测试: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
