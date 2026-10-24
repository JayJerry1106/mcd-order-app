/* 限流测试：启动服务端子进程（无 MCP Token 路径），验证 IP 限流与 429 行为。
 * 写操作（下单/领券）每 IP 10 分钟 20 次；读操作每 IP 每分钟 600 次；
 * 阈值通过环境变量 RATE_LIMIT_WRITE_MAX / RATE_LIMIT_READ_MAX 注入，便于测试。 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3215;

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 10000, interval = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* retry */ }
    await sleep(interval);
  }
  return null;
}
const post = (p) => fetch(`http://localhost:${PORT}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

(async () => {
  // 阈值调小以加速测试：写 3 次 / 读 5 次
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), RATE_LIMIT_WRITE_MAX: '3', RATE_LIMIT_READ_MAX: '5' },
    stdio: 'ignore',
  });
  const up = await waitFor(async () => {
    try { const r = await fetch(`http://localhost:${PORT}/api/status`); return r.ok; } catch (_) { return false; }
  });
  check('服务端子进程启动', !!up);

  // 写接口：POST /api/order 体为 {} → 缺 storeCode 走 400（不触达 MCP），第 4 次起应 429
  const writeCodes = [];
  for (let i = 0; i < 6; i++) writeCodes.push((await post('/api/order')).status);
  check('写接口：前 3 次放行（400 缺参数，未触达 MCP）', writeCodes.slice(0, 3).every((c) => c !== 429), writeCodes.join(','));
  check('写接口：第 4 次起限流 429', writeCodes.slice(3).every((c) => c === 429), writeCodes.join(','));

  // 读接口：POST /api/menu 体为 {} → 400，第 6 次起应 429
  const readCodes = [];
  for (let i = 0; i < 8; i++) readCodes.push((await post('/api/menu')).status);
  check('读接口：前 5 次放行', readCodes.slice(0, 5).every((c) => c !== 429), readCodes.join(','));
  check('读接口：第 6 次起限流 429', readCodes.slice(5).every((c) => c === 429), readCodes.join(','));

  // 429 响应体带可读原因
  const rl = await fetch(`http://localhost:${PORT}/api/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const rlJson = await rl.json().catch(() => ({}));
  check('429 响应体包含原因说明', rlJson.success === false && /频繁/.test(rlJson.error || ''), rlJson.error || '');

  // /api/status 豁免限流（健康探测永可达）
  const st = await fetch(`http://localhost:${PORT}/api/status`);
  check('/api/status 不受限流影响', st.status === 200, 'HTTP ' + st.status);

  child.kill();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass === results.length ? '✅' : '❌'} 限流测试: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
