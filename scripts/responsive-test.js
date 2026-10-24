/* 响应式与布局回归测试（真实浏览器）：
 * 用 puppeteer-core 驱动本机 Edge，在多个视口宽度下验证：
 *   1. 无横向溢出（scrollWidth <= clientWidth）——手机头部溢出 bug 回归
 *   2. 桌面端购物车路由不出现双份购物车——重复渲染 bug 回归
 *   3. 底部导航 / 侧栏在各断点的显隐符合预期
 * 无 Edge/Chrome 时自动跳过（不视为失败）。
 * 用法：node scripts/responsive-test.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures.json'), 'utf8'));

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isBF = (() => { const n = new Date(); return (n.getHours() * 60 + n.getMinutes()) < 10 * 60 + 30; })();

/** 模拟后端 /api 响应：以真实门店/菜单数据驱动应用进入实时模式，用于布局回归 */
function apiResponse(pathname, body) {
  const ok = (data) => ({ status: 200, json: { success: true, data } });
  if (pathname === '/api/status') return ok({ mode: 'live', mcp: true });
  if (pathname === '/api/stores') return ok({ data: fixtures.stores.map((s) => ({ ...s })) });
  if (pathname === '/api/menu') return ok({ data: fixtures.menus[isBF ? 'breakfast' : 'regular'] });
  if (pathname === '/api/meal') {
    const d = (body && body.code && fixtures.mealDetails[body.code]) || Object.values(fixtures.mealDetails)[0];
    return ok({ data: d });
  }
  if (pathname === '/api/nutrition') return ok({ data: fixtures.nutrition });
  if (pathname === '/api/coupons/available') return ok(fixtures.coupons.available);
  if (pathname === '/api/coupons/mine') return ok({ coupons: fixtures.coupons.mine });
  if (pathname === '/api/coupons/store') return ok(fixtures.coupons.store);
  if (pathname === '/api/coupons/claim') return ok({ message: 'ok' });
  if (pathname === '/api/price') return ok({ data: { productOriginalPrice: 0, productPrice: 0, price: 9999, discount: 0, productList: [], takeWayList: [{ code: 'eat-in', title: '堂食' }], enjoyed: null, enjoyable: null } });
  if (pathname === '/api/order') return ok({ data: { orderId: 'MCP1', pickupCode: '4321', status: '待支付' } });
  return { status: 404, json: { success: false, error: '接口不存在' } };
}

(async () => {
  const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  let puppeteer = null;
  try {
    puppeteer = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
  } catch (_) {
    try { puppeteer = require('puppeteer-core'); } catch (_) { /* ignore */ }
  }
  if (!edgePath || !puppeteer) {
    console.log('⚠️ 未找到 Edge/Chrome 或 puppeteer-core，跳过响应式实测（不影响其他测试）');
    return;
  }

  // 静态服务器：含 /api 模拟后端（fixtures 真实数据）→ 应用以实时模式渲染真实 UI 用于布局回归
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { /* 非 JSON */ }
        const r = apiResponse(p, body);
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.json));
      });
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? '/index.html' : p));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('NF'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars'],
  });

  try {
    /* ---- 1. 多视口无横向溢出 ---- */
    for (const [w, h, label] of [[320, 800, '超小屏 320'], [375, 812, 'iPhone 375'], [390, 844, 'iPhone 390'], [414, 896, 'Plus 414'], [768, 1024, '平板 768'], [1440, 900, '桌面 1440']]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.goto(`${base}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });
      // 打开门店选择器与详情弹层后再测一次（弹层内也可能溢出）
      await page.click('#store-pill');
      await sleep(300);
      const pickerOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => { document.querySelector('[data-action="close-modal"]')?.click(); });
      await sleep(200);
      await page.click('.product-card');
      await sleep(400);
      const detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${label}：菜单页无横向溢出`, pickerOverflow <= 0, `溢出 ${pickerOverflow}px`);
      check(`${label}：详情弹层无横向溢出`, detailOverflow <= 0, `溢出 ${detailOverflow}px`);
      await page.close();
    }

    /* ---- 2. 桌面端购物车路由无双份渲染 ---- */
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });
    await page.click('.product-card .p-add');
    await sleep(400);
    await page.evaluate(() => { location.hash = '#/cart'; });
    await sleep(500);
    const dup = await page.evaluate(() => ({
      mainCarts: document.querySelectorAll('#view-root .cart-head').length,
      railHTML: document.querySelector('#cart-rail').innerHTML.trim(),
      cartItems: document.querySelectorAll('#view-root .cart-item').length,
    }));
    check('桌面端购物车路由：主区域恰好一份购物车', dup.mainCarts === 1, 'mainCarts=' + dup.mainCarts);
    check('桌面端购物车路由：侧栏不重复渲染', dup.railHTML === '', 'rail=' + dup.railHTML.slice(0, 30));
    check('桌面端购物车路由：商品行渲染', dup.cartItems >= 1, dup.cartItems + ' 行');

    // 菜单路由下侧栏摘要恢复
    await page.evaluate(() => { location.hash = '#/menu'; });
    await sleep(400);
    const railBack = await page.evaluate(() => !!document.querySelector('#cart-rail .cart-head'));
    check('桌面端菜单路由：侧栏购物车摘要恢复', railBack);

    /* ---- 3. 断点行为：底部导航与侧栏 ---- */
    for (const [w, h, expectNav, label] of [[375, 812, true, '手机 375'], [768, 1024, true, '平板 768'], [1440, 900, false, '桌面 1440']]) {
      const p2 = await browser.newPage();
      await p2.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await p2.goto(`${base}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
      await p2.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });
      const navVisible = await p2.evaluate(() => getComputedStyle(document.querySelector('#bottom-nav')).display !== 'none');
      const railVisible = await p2.evaluate(() => {
        const r = document.querySelector('#cart-rail');
        return getComputedStyle(r).display !== 'none' && r.innerHTML.trim() !== '';
      });
      check(`${label}：底部导航${expectNav ? '显示' : '隐藏'}`, navVisible === expectNav, 'display=' + (navVisible ? 'flex' : 'none'));
      check(`${label}：桌面侧栏购物车${expectNav ? '隐藏' : '显示'}`, railVisible === !expectNav, 'rail=' + railVisible);
      await p2.close();
    }

    /* ---- 4. 键盘无障碍（P2-1/P2-2）：Esc 关闭 / 焦点陷阱 / 焦点环 ---- */
    const pa = await browser.newPage();
    await pa.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
    await pa.goto(`${base}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
    await pa.waitForFunction(() => document.querySelectorAll('.product-card').length > 0, { timeout: 15000 });

    // Esc 关闭模态框
    await pa.click('#store-pill');
    await pa.waitForSelector('.modal-mask', { timeout: 5000 });
    await pa.keyboard.press('Escape');
    await sleep(300);
    check('真实浏览器：Esc 关闭门店选择器', await pa.$('.modal-mask') === null);

    // 焦点陷阱：打开后连按 12 次 Tab，焦点应始终圈在模态框内
    await pa.click('#store-pill');
    await pa.waitForSelector('.modal-mask', { timeout: 5000 });
    let trapped = true;
    for (let i = 0; i < 12; i++) {
      await pa.keyboard.press('Tab');
      const inside = await pa.evaluate(() => {
        const a = document.activeElement;
        return !!a && !!a.closest('.modal-box');
      });
      if (!inside) { trapped = false; break; }
    }
    check('真实浏览器：Tab 焦点圈定在模态框内', trapped);
    await pa.keyboard.press('Escape');
    await sleep(200);

    // 焦点环：按钮聚焦后应有可见 outline，且不破坏自身圆角
    const ring = await pa.evaluate(() => {
      const btn = document.querySelector('#header-mic-btn');
      btn.focus();
      const cs = getComputedStyle(btn);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, radius: cs.borderRadius };
    });
    check('真实浏览器：键盘焦点有可见轮廓（2px 实线）',
      ring.outlineStyle === 'solid' && parseFloat(ring.outlineWidth) >= 2, JSON.stringify(ring));
    check('焦点环不破坏元素自身圆角', ring.radius.includes('50'), ring.radius);

    // 输入框焦点环（box-shadow 替代被移除的 outline）
    await pa.evaluate(() => { document.querySelector('#store-pill').click(); });
    await pa.waitForSelector('.modal-mask', { timeout: 5000 });
    const inputRing = await pa.evaluate(() => {
      const inp = document.querySelector('#manual-city');
      inp.focus();
      const cs = getComputedStyle(inp);
      return { outline: cs.outlineStyle, shadow: cs.boxShadow };
    });
    check('真实浏览器：输入框焦点有光环（非裸 outline:none）',
      inputRing.shadow && inputRing.shadow !== 'none', JSON.stringify(inputRing));
    await pa.keyboard.press('Escape');

    // 语音浮层 Esc
    await pa.click('#header-mic-btn');
    await pa.waitForFunction(() => !document.querySelector('#voice-overlay').hidden, { timeout: 5000 });
    await pa.keyboard.press('Escape');
    await sleep(300);
    check('真实浏览器：Esc 关闭语音浮层', await pa.evaluate(() => document.querySelector('#voice-overlay').hidden === true));
    await pa.close();

    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 响应式布局测试：${pass}/${results.length} 通过 ==========`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(' ❌', f.name, f.extra));
    process.exitCode = 1;
  }
})().catch((e) => { console.error('测试异常：', e); process.exitCode = 1; });
