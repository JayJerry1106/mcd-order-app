/**
 * 麦当劳点餐助手 · 服务端
 * 零依赖 Node 服务：
 *  1. 托管 public/ 静态资源（前端 SPA）
 *  2. /api/* 代理麦当劳 MCP（https://mcp.mcd.cn，Streamable HTTP + Bearer Token）
 *  3. 未配置 MCD_MCP_TOKEN 时返回 503，前端展示「需配置后端」提示（不提供任何模拟数据）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------- 环境变量（简易 .env 解析，避免引入依赖） ----------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const PORT = Number(process.env.PORT || 3210);
const MCP_URL = process.env.MCD_MCP_URL || 'https://mcp.mcd.cn/';
const MCP_TOKEN = (process.env.MCD_MCP_TOKEN || '').trim();

// ---------- MCP 客户端 ----------
let rpcId = 1;
const menuCache = new Map(); // key -> { at, data }，降低 MCP 调用频率（限流 600 次/分钟）

async function callMcp(tool, args = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + MCP_TOKEN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message || 'MCP 调用失败');
      err.rpc = json.error;
      throw err;
    }
    const result = json.result || {};
    if (result.isError) {
      const text = (result.content || []).map((c) => c.text || '').join(' ');
      const err = new Error(text.slice(0, 300) || 'MCP 工具返回错误');
      err.isError = true;
      throw err;
    }
    // structuredContent 为结构化数据；部分工具仅返回文本，这里尽量解析
    if (result.structuredContent) return result.structuredContent;
    const text = (result.content || []).map((c) => c.text || '').join(' ');
    try { return JSON.parse(text); } catch (_) { return { text }; }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 工具函数 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

// ---------- API 路由 ----------
const routes = {
  'GET /api/status': async () => ({
    mode: MCP_TOKEN ? 'live' : 'unconfigured',
    mcp: !!MCP_TOKEN,
    message: MCP_TOKEN ? undefined : '未配置 MCD_MCP_TOKEN，无法调用真实后端',
    time: new Date().toISOString(),
    server: 'mcd-order-app/1.0.0',
  }),

  'POST /api/stores': async (body) => {
    const { city, keyword, beType = 1 } = body || {};
    return callMcp('query-nearby-stores', {
      beType, searchType: 2, city: city || '北京市', keyword: keyword || '国贸',
    });
  },

  'POST /api/menu': async (body) => {
    const { storeCode, orderType = 1, beType = 1, beCode, reservationDate } = body || {};
    if (!storeCode) throw new HttpError(400, '缺少 storeCode');
    const key = `${storeCode}|${orderType}|${beType || ''}|${beCode || ''}|${reservationDate || ''}`;
    const hit = menuCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const data = await callMcp('query-meals', { storeCode, orderType, beType, beCode, reservationDate });
    menuCache.set(key, { at: Date.now(), data });
    return data;
  },

  'POST /api/meal': async (body) => {
    const { storeCode, code, orderType = 1, beType = 1, beCode } = body || {};
    if (!storeCode || !code) throw new HttpError(400, '缺少 storeCode 或 code');
    return callMcp('query-meal-detail', { storeCode, orderType, beType, code, beCode });
  },

  'GET /api/coupons/available': async () => callMcp('available-coupons'),
  'POST /api/coupons/claim': async () => callMcp('auto-bind-coupons'),
  'GET /api/coupons/mine': async () => callMcp('query-my-coupons', { page: '1', pageSize: '200' }),

  'POST /api/coupons/store': async (body) => {
    const { storeCode, orderType = 1, beType = 1, beCode } = body || {};
    if (!storeCode) throw new HttpError(400, '缺少 storeCode');
    return callMcp('query-store-coupons', { storeCode, orderType, beType, beCode });
  },

  'POST /api/price': async (body) => {
    const { storeCode, orderType = 1, beType = 1, beCode, items, needTableware, withOrder } = body || {};
    if (!storeCode || !Array.isArray(items) || !items.length) throw new HttpError(400, '缺少 storeCode 或 items');
    return callMcp('calculate-price', { storeCode, orderType, beType, beCode, items, needTableware, withOrder });
  },

  'POST /api/order': async (body) => {
    const { storeCode, orderType = 1, beType = 1, beCode, items, takeWayCode, addressId, needTableware, remark, withOrder } = body || {};
    if (!storeCode || !Array.isArray(items) || !items.length) throw new HttpError(400, '缺少 storeCode 或 items');
    return callMcp('create-order', { storeCode, orderType, beType, beCode, items, takeWayCode, addressId, needTableware, remark, withOrder });
  },

  'GET /api/nutrition': async () => callMcp('list-nutrition-foods'),
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- 静态资源 ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const abs = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA 回退
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('Not Found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      res.writeHead(404); return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': abs.includes(`${path.sep}data${path.sep}`) ? 'public, max-age=300' : 'no-cache',
    });
    res.end(data);
  });
}

// ---------- 启动 ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const routeKey = `${req.method} ${pathname}`;

  if (routes[routeKey]) {
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const data = await routes[routeKey](body);
      sendJson(res, 200, { success: true, data });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      sendJson(res, status, { success: false, error: err.message || '服务异常' });
    }
    return;
  }

  // 真实接口需要 Token：未配置时统一返回 503（前端据此展示「需配置后端」，不回退模拟数据）
  if (pathname.startsWith('/api/') && pathname !== '/api/status' && !MCP_TOKEN) {
    return sendJson(res, 503, { success: false, error: '后端未配置 MCD_MCP_TOKEN，无法调用真实接口' });
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { success: false, error: '接口不存在' });
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const mode = MCP_TOKEN ? '实时模式（麦当劳 MCP 已连接）' : '未配置 Token（/api/status 返回 unconfigured，前端将提示需配置后端）';
  console.log(`🍔 麦当劳点餐助手已启动: http://localhost:${PORT}`);
  console.log(`   运行模式: ${mode}`);
});
