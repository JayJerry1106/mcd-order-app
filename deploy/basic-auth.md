# 实时模式公开暴露时的鉴权方案（可选，高风险操作才需要）

> 默认立场：公网链接即真实数据（经 Pages Function + Token），建议默认开启只读（`MCD_PUBLIC_READONLY=1`）。仅当确需允许公开真实下单时，
> 才按本文加鉴权/只读保护——否则任何访问者都可用你的麦当劳账号真实下单。

## 方案一：Cloudflare Access（零代码，推荐）

适用：通过 Cloudflare Tunnel / Pages 暴露，且有自有域名。

1. Zero Trust 后台 → Access → Applications → Add an application
2. 选择 Self-hosted，填入应用域名
3. 添加策略：Allow → Emails，输入允许访问的邮箱（可加一次性 PIN 码验证）
4. 免费额度：50 个用户

效果：未登录者看到 CF 的登录页，通过后才能访问应用。

## 方案二：服务端 Basic Auth（零依赖，改 3 行代码）

适用：自托管 Node 服务（Render / Fly / 自己的服务器）且不使用 CF Access。

在 `server.js` 的 `const server = http.createServer(...)` 之前插入：

```js
// ---- 可选：公开暴露时的 Basic Auth 鉴权（设置 BASIC_AUTH 后启用，格式 user:pass） ----
const AUTH = process.env.BASIC_AUTH || '';
if (AUTH) {
  console.log('🔒 Basic Auth 已启用');
}
```

在 `http.createServer` 回调的最前面（`const { pathname } = ...` 之前）插入：

```js
if (AUTH) {
  const expected = 'Basic ' + Buffer.from(AUTH).toString('base64');
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="McDonald Order App"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('需要身份验证');
  }
}
```

部署平台环境变量中设置 `BASIC_AUTH=用户名:密码` 即启用；本地开发不设置则不受影响。

局限：Basic Auth 凭证明文传输依赖 HTTPS；所有人都共享同一组账号；浏览器会缓存。

## 方案三：共享密钥查询参数（最低配）

在 `server.js` 路由分发前增加：

```js
const KEY = process.env.ACCESS_KEY || '';
if (KEY && new URL(req.url, 'http://x').searchParams.get('key') !== KEY) {
  res.writeHead(403); return res.end('Forbidden');
}
```

访问方式变为 `https://<域名>/?key=<密钥>`。仅防无意闯入，不防链接转发，不推荐单独使用。

## 无论如何都要做的

- 公开暴露实时模式前，先在 MCP 平台确认 Token 的额度与风控策略
- 监控订单列表（`order-list` 工具），发现异常立即在 MCP 平台吊销 Token
- 公开站点默认仅读（`MCD_PUBLIC_READONLY=1`）是推荐形态；确需公开可写下单时务必加鉴权
