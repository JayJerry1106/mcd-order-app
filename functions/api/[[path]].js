/**
 * Cloudflare Pages Function：将 /api/* 代理到麦当劳 MCP（https://mcp.mcd.cn）。
 *
 * 设计要点：
 *  1. Token 取自 Cloudflare 环境变量 MCD_MCP_TOKEN（通过 `wrangler pages secret put` 配置），
 *     绝不进入前端代码或静态资源——浏览器拿不到 Token。
 *  2. 未配置 Token → 503；前端据此展示「需配置后端」，不回退任何模拟数据。
 *  3. 可选安全开关 MCD_PUBLIC_READONLY=1：公网部署时拦截写操作（下单 / 领券），
 *     避免链接外泄后被他人用你的账号真实下单。读操作（门店/菜单/核价）始终可用。
 *
 * 本地 Node 服务（server.js）逻辑与此一致，二者可并存：本地用 .env，线上用本 Function。
 */

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

let rpcId = 1;

// 简易 IP 限流（与 server.js 一致）：保护 MCP Token 配额与账户写操作。
// 注意：Workers 按 isolate 隔离，Map 为尽力而为防护，严格限流建议在 Cloudflare 仪表板配置 Rate Limiting 规则。
const RL = {
  write: { max: 20, window: 10 * 60 * 1000 },
  read: { max: 600, window: 60 * 1000 },
};
const rlBuckets = new Map();
function rlOk(ip, kind) {
  const { max, window } = RL[kind];
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now > b.reset) { b = { w: 0, r: 0, reset: now + window }; rlBuckets.set(ip, b); }
  const key = kind === 'write' ? 'w' : 'r';
  b[key] += 1;
  return b[key] <= max;
}

async function callMcp(env, tool, args) {
  const url = env.MCD_MCP_URL || 'https://mcp.mcd.cn/';
  const token = (env.MCD_MCP_TOKEN || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const jsonBody = await res.json();
    if (jsonBody.error) {
      const err = new Error(jsonBody.error.message || 'MCP 调用失败');
      err.status = 502;
      throw err;
    }
    const result = jsonBody.result || {};
    if (result.isError) {
      const text = (result.content || []).map((c) => c.text || '').join(' ');
      const err = new Error(text.slice(0, 300) || 'MCP 工具返回错误');
      err.status = 502;
      throw err;
    }
    if (result.structuredContent) return result.structuredContent;
    const text = (result.content || []).map((c) => c.text || '').join(' ');
    try { return JSON.parse(text); } catch (_) { return { text }; }
  } finally {
    clearTimeout(timer);
  }
}

const ROUTES = {
  'POST /api/stores': (b) => ({ tool: 'query-nearby-stores', args: { beType: 1, searchType: 2, city: b?.city || '北京市', keyword: b?.keyword || '国贸' } }),
  'POST /api/menu': (b) => ({ tool: 'query-meals', args: { storeCode: b?.storeCode, orderType: b?.orderType ?? 1, beType: b?.beType ?? 1, beCode: b?.beCode, reservationDate: b?.reservationDate } }),
  'POST /api/meal': (b) => ({ tool: 'query-meal-detail', args: { storeCode: b?.storeCode, orderType: b?.orderType ?? 1, beType: b?.beType ?? 1, code: b?.code, beCode: b?.beCode } }),
  'GET /api/coupons/available': () => ({ tool: 'available-coupons', args: {} }),
  'POST /api/coupons/claim': () => ({ tool: 'auto-bind-coupons', args: {} }),
  'GET /api/coupons/mine': () => ({ tool: 'query-my-coupons', args: { page: '1', pageSize: '200' } }),
  'POST /api/coupons/store': (b) => ({ tool: 'query-store-coupons', args: { storeCode: b?.storeCode, orderType: b?.orderType ?? 1, beType: b?.beType ?? 1, beCode: b?.beCode } }),
  'POST /api/price': (b) => ({ tool: 'calculate-price', args: { storeCode: b?.storeCode, orderType: b?.orderType ?? 1, beType: b?.beType ?? 1, beCode: b?.beCode, items: b?.items, needTableware: b?.needTableware, withOrder: b?.withOrder } }),
  'POST /api/order': (b) => ({ tool: 'create-order', args: { storeCode: b?.storeCode, orderType: b?.orderType ?? 1, beType: b?.beType ?? 1, beCode: b?.beCode, items: b?.items, takeWayCode: b?.takeWayCode, addressId: b?.addressId, needTableware: b?.needTableware, remark: b?.remark, withOrder: b?.withOrder } }),
  'GET /api/nutrition': () => ({ tool: 'list-nutrition-foods', args: {} }),
  'POST /api/orders': (b) => ({ tool: 'order-list', args: { page: String(b?.page ?? 1), pageSize: String(b?.pageSize ?? 20) } }),
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/status') {
    const ok = !!(env.MCD_MCP_TOKEN && env.MCD_MCP_TOKEN.trim());
    return json(200, { success: true, data: {
      mode: ok ? 'live' : 'unconfigured',
      mcp: ok,
      message: ok ? undefined : '未配置 MCD_MCP_TOKEN',
      time: new Date().toISOString(),
      server: 'mcd-order-app/pages-function',
    } });
  }

  const token = (env.MCD_MCP_TOKEN || '').trim();
  if (!token) {
    return json(503, { success: false, error: '后端未配置 MCD_MCP_TOKEN，无法调用真实接口' });
  }

  // IP 限流：/api/status 豁免；写操作（下单/领券）更严格
  if (pathname !== '/api/status') {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const isWrite = method === 'POST' && /^\/api\/(order|coupons\/claim)$/.test(pathname);
    if (!rlOk(ip, isWrite ? 'write' : 'read')) {
      return json(429, { success: false, error: isWrite
        ? '操作过于频繁（每 IP 每 10 分钟最多 20 次写操作），请稍后再试'
        : '请求过于频繁（每 IP 每分钟最多 600 次），请稍后再试' });
    }
  }

  // 公网只读：拦截写操作（下单 / 领券）
  const isWrite = method === 'POST' && /^\/api\/(order|coupons\/claim)$/.test(pathname);
  if (isWrite && /^(1|true|yes)$/i.test(env.MCD_PUBLIC_READONLY || '')) {
    return json(403, { success: false, error: '当前站点为只读模式，下单/领券已禁用。请在私有环境或关闭只读后操作。' });
  }

  const routeKey = `${method} ${pathname}`;
  const def = ROUTES[routeKey];
  if (!def) return json(404, { success: false, error: '接口不存在' });

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try { body = await request.json(); } catch (_) { body = {}; }
  }

  try {
    const { tool, args } = def(body);
    const data = await callMcp(env, tool, args);
    return json(200, { success: true, data });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return json(status, { success: false, error: err.message || '服务异常' });
  }
}
