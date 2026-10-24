/* 静态部署验证：把 public/ 当纯静态站点托管（Cloudflare Pages），
 * 验证两种形态：
 *   A. 含 Pages Function（后端）：/api/* 由 Function 代理真实 MCP → 应用启动实时模式、渲染门店与菜单
 *   B. 无后端（未配置 Token）：/api/status 返回 unconfigured/404 → 应用展示「需配置后端」，绝不回退演示数据
 * 同时验证 SPA 回退、静态资源可达，以及演示快照文件已不再随站发布。
 * 用法：node scripts/static-deploy-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
let JSDOM;
try {
  ({ JSDOM } = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/jsdom'));
} catch (_) {
  ({ JSDOM } = require('jsdom'));
}

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures.json'), 'utf8'));

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

const isBF = (() => { const n = new Date(); return (n.getHours() * 60 + n.getMinutes()) < 10 * 60 + 30; })();

/** 模拟 Pages Function 的 /api 响应（与 functions/api/[[path]].js 行为一致） */
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

/** 纯静态服务器；backendEnabled=true 时额外实现 /api/*（模拟 Pages Function） */
function makeServer(backendEnabled) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname.startsWith('/api/')) {
      if (!backendEnabled) { res.writeHead(404); return res.end('Not Found'); }
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => raw += c);
        req.on('end', () => { try { body = JSON.parse(raw || '{}'); } catch (_) {} finish(); });
      } else { finish(); }
      function finish() {
        const r = apiResponse(pathname, body);
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.json));
      }
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) {
        // 已知路径（含扩展名 / 数据目录 / api）缺失 → 404；其余未知路径走 SPA 回退到 index.html
        if (path.extname(pathname) || pathname.startsWith('/data/') || pathname.startsWith('/api/')) {
          res.writeHead(404); return res.end('Not Found');
        }
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
}

(async () => {
  const apiServer = makeServer(true);
  await new Promise((r) => apiServer.listen(3213, r));
  const noBackendServer = makeServer(false);
  await new Promise((r) => noBackendServer.listen(3214, r));
  console.log('静态服务器已启动：3213（含后端）/ 3214（无后端）\n');

  /** 在指定基础 URL 下启动应用并断言；baseUrl 决定 fetch 打到哪个服务器 */
  async function bootAndVerify(baseUrl, label, port, withPicker) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace(/<script src="[^"]*"><\/script>/g, '');
    const dom = new JSDOM(html, { url: baseUrl, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const { document } = window;
    window.addEventListener('error', (e) => console.log(`⚠️ [${label}] PAGE ERROR:`, e.message));
    window.speechSynthesis = { cancel() {}, speak() {} };

    window.fetch = (url) => new Promise((resolve, reject) => {
      const u = new URL(String(url), baseUrl);
      http.get({ hostname: '127.0.0.1', port, path: u.pathname + u.search }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => res.headers[name.toLowerCase()] || null },
          json: async () => JSON.parse(body || '{}'),
          text: async () => body,
        }));
      }).on('error', reject);
    });

    const bundle = ['config.js', 'geo.js', 'api.js', 'state.js', 'checkout.js', 'budget.js', 'voice.js', 'views.js', 'app.js']
      .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
      + '\n;window.__app = { Store, Api, Geo };';
    window.eval(bundle);
    const st = window.__app.Store;

    let rendered = false;
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if (document.querySelectorAll('.product-card').length > 0 || document.querySelector('.backend-required')) { rendered = true; break; }
    }
    // 开启门店选择器以验证营业状态等真实门店字段（仅在含后端场景）
    let storeStatusCount = 0;
    if (withPicker && document.querySelector('#store-pill')) {
      st.setStorePicker(true);
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if (document.querySelector('.store-status')) break;
      }
      storeStatusCount = document.querySelectorAll('.store-status').length;
    }
    window.close();
    return { st, rendered, doc: document, storeStatusCount };
  }

  // 场景 A：含后端的静态托管（Pages Function 启用）→ 实时模式
  console.log('--- 场景 A：含后端（Pages Function）→ 实时模式 ---');
  {
    const { st, doc, storeStatusCount } = await bootAndVerify('http://localhost:3213/', '含后端]', 3213, true);
    check('[含后端] 应用启动并渲染菜单（实时）', doc.querySelectorAll('.product-card').length > 0, doc.querySelectorAll('.product-card').length + ' 个商品卡片');
    check('[含后端] 模式为实时', st.state.mode === 'live', 'mode=' + st.state.mode);
    check('[含后端] 门店来自真实后端', !!st.state.store && /麦当劳/.test(st.state.store.storeName || ''), st.state.store ? st.state.store.storeName : '无门店');
    check('[含后端] 门店卡片含营业状态徽章', storeStatusCount > 0, storeStatusCount + ' 个');
    check('[含后端] 不展示演示数据占位', !/演示快照|模拟下单/.test(doc.body.textContent), '');
  }

  // 场景 B：无后端（未配置 Token）→ 展示「需配置后端」，绝不回退演示数据
  console.log('\n--- 场景 B：无后端 → 需配置后端（无演示回退） ---');
  {
    const { st, doc } = await bootAndVerify('http://localhost:3214/', '无后端]', 3214, false);
    check('[无后端] 不渲染演示菜单（无 product-card）', doc.querySelectorAll('.product-card').length === 0, doc.querySelectorAll('.product-card').length + ' 个');
    check('[无后端] 展示「需配置后端」提示', !!doc.querySelector('.backend-required') && /未连接真实后端/.test(doc.body.textContent), '');
    check('[无后端] 模式为 offline', st.state.mode === 'offline', 'mode=' + st.state.mode);
    check('[无后端] 无演示数据占位（无门店/菜单）', doc.querySelectorAll('.product-card').length === 0 && doc.querySelectorAll('.store-list .round-choice').length === 0, '');
  }

  // 静态资源可达性（演示快照文件已移除，应 404）
  console.log('\n--- 静态资源可达性 ---');
  for (const p of ['/', '/js/app.js', '/css/style.css']) {
    const r = await fetch('http://localhost:3213' + p);
    check(`静态资源 ${p}`, r.status === 200, 'HTTP ' + r.status);
  }
  const snapR = await fetch('http://localhost:3213/data/snapshot.json');
  check('演示快照文件已移除（/data/snapshot.json → 404）', snapR.status === 404, 'HTTP ' + snapR.status);

  apiServer.close();
  noBackendServer.close();

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 静态部署验证：${pass}/${results.length} 通过 ==========`);
  if (pass !== results.length) process.exitCode = 1;
})().catch((e) => { console.error('测试异常：', e); process.exitCode = 1; });
