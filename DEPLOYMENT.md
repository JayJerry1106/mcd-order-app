# 永久链接部署方案（DEPLOYMENT.md）

> 目标：把当前基于临时隧道的公网访问方式，改造为**永久固定 URL**。
> 本文覆盖：现状分析 → 方案对比（含本机网络实测）→ 推荐架构 → 完整配置步骤 → 需修改的文件与参数 → 验证方法 → 权限控制与域名绑定。

---

## 1. 现状分析：临时链接是什么形态

| 项 | 当前状态 |
| --- | --- |
| 形式 | localhost.run SSH 反向隧道（`ssh -R 80:localhost:3211 nokey@localhost.run`） |
| 链接形如 | `https://<随机串>.lhr.life`（指向本机 3211 端口） |
| 实测寿命 | 40 分钟内域名轮换 3 次，随后 `tunnel activity timeout` 断开 |
| 免费档限制 | 官方文档明确：**域名定期更换 + 限速**（防钓鱼政策）；固定域名需付费 Custom Domain 套餐 |
| 依赖 | 本机必须常开、隧道进程必须常驻、断线不自动恢复 |

**结论**：临时隧道无法"熬成"永久链接，必须迁移到托管平台。所有候选平台的网络可达性已在本机实测（见下表）。

---

## 2. 需求与约束（基于实际使用场景）

| 需求 | 来源 |
| --- | --- |
| 永久固定 URL，HTTPS（手机浏览器定位权限要求安全上下文） | 手机使用场景 |
| 可公开分享（大赛评审） | 大赛交付 |
| 零或低成本 | 个人项目 |
| 公网链接**不能**暴露真实 MCP Token | 安全红线（否则任何人可用你的账号真实下单） |
| 实时模式保留在本机/局域网自用 | 日常使用 |

由此确定核心架构原则：

> **公网永久链接与本地都连接真实麦当劳 MCP（分别经 Pages Function / 本机 server.js 代理）；未配置 Token 时展示「需配置后端」提示，不提供任何模拟数据。**

技术前提已验证：`scripts/static-deploy-test.js`（13/13 通过）证明把 `public/` 当纯静态站点托管时，含后端（Pages Function 代理 MCP）能实时渲染门店与菜单、无后端时前端检测到 `/api/status` 不可达会展示「需配置后端」提示（绝不回退模拟数据），且**同时兼容根域名、子路径与 SPA 回退三种托管形态**。

> **✅ 已执行（2026-10-21）**：方案 1 Cloudflare Pages 部署完成，永久链接 **https://mcd-order-app.pages.dev**（详见第 8 节验证结果）。

---

## 3. 候选方案对比（本机 2026-10-21 实测）

| 方案 | 永久 URL | 运行形态 | 免费额度 | 休眠 | 需要账号 | 网络实测 |
| --- | --- | --- | --- | --- | --- | --- |
| **Cloudflare Pages** | `https://<名>.pages.dev` | 静态 | 无限流量 | 无 | Cloudflare（免费） | ✅ 可达 |
| **GitHub Pages** | `https://<用户>.github.io/<仓库>/` | 静态 | 100GB/月 | 无 | GitHub（免费） | ✅ 可达 |
| Netlify | `https://<名>.netlify.app` | 静态 | 100GB/月 | 无 | Netlify（免费） | ✅ 可达 |
| Vercel | `https://<名>.vercel.app` | 静态 | 100GB/月 | 无 | Vercel（免费） | ✅ 可达 |
| Render | `https://<名>.onrender.com` | **Node 服务** | 750 小时/月 | **15 分钟休眠** | Render（免费） | ✅ 可达 |
| Fly.io | `https://<名>.fly.dev` | Node 服务 | 小额额度 | 无 | Fly（需绑卡） | ✅ 可达 |
| 自有域名 + CF Tunnel | `https://<你的域名>` | Node 服务 | 取决于主机 | 无 | 域名（约 ¥60/年） | ✅ 可达 |
| ~~localhost.run 免费档~~ | ~~随机域名~~ | — | — | — | — | ❌ 域名轮换，不可用 |
| ~~WorkBuddy 内置发布~~ | — | — | — | — | — | ❌ 本会话工具不可用 |

---

## 4. 推荐架构（分层）

```
                    ┌─────────────────────────────┐
   任何人（手机/评审）│  公网永久链接（真实 MCP，经 Pages Function） │  静态站点 + Functions
                    │  https://<名>.pages.dev      │  CF Pages（含后端代理）
                    └─────────────────────────────┘
                    ┌─────────────────────────────┐
   仅你自己          │  实时模式（真实 MCP/下单）    │  本机
                    │  http://localhost:3210       │  + 局域网 http://<IP>:3210
                    └─────────────────────────────┘
```

- **第一推荐：Cloudflare Pages**——永久子域、无休眠、全球 CDN、部署一条命令。
- **第二推荐：GitHub Pages**——顺便满足大赛「公开 GitHub 仓库」要求，代码与站点同仓。
- 公网默认即真实点餐（经 Pages Function + Token）；如需自定义 Node 运行时再考虑 Render/Fly，并必须按第 7 节加只读/鉴权保护。

---

## 5. 完整配置步骤

### 方案 A：Cloudflare Pages（推荐）

```bash
# 1. 安装 CLI（一次性；本机 npm 源实测可达）
npm install -g wrangler

# 2. 登录（浏览器 OAuth，免费账号即可）
npx wrangler login

# 3. 部署（在项目根目录执行；public/ 为静态站点，functions/ 为 Pages Function，自动一并发布）
cd D:\下载\2026-10-21-09-25-55\mcd-order-app
npx wrangler pages deploy public --project-name=mcd-order-app --commit-dirty=true

# 4. 配置麦当劳 MCP Token 为 Pages 密钥（公开站点据此拉取真实门店/菜单/下单；密钥不出现在前端代码）
npx wrangler pages secret put MCD_MCP_TOKEN --project-name=mcd-order-app

# 5.（推荐）公开站点开启只读，阻断任意访客真实下单 / 领券
npx wrangler pages secret put MCD_PUBLIC_READONLY --project-name=mcd-order-app
#    粘贴 1 即可；此后公开站点仅可读门店/菜单/核价，POST /api/order 与 /api/coupons/claim 返回 403
```

- 首次执行自动创建项目并返回 `https://mcd-order-app.pages.dev`；**以后每次部署沿用同一链接**（内容覆盖更新）。
- 配置文件：`deploy/wrangler.toml`（已生成，含项目名与输出目录）。
- 自定义域名：Pages 项目后台 → Custom domains → 添加域名 → 按提示将 DNS CNAME 指向 `<项目>.pages.dev`（域名托管在 Cloudflare 时全自动）。

#### 本地部署（在你自己机器上执行，交互登录 Cloudflare）

> 交互式 `wrangler login`（浏览器 OAuth）无法在沙箱/远端替你完成，因此这套命令由你在本机终端运行。前置：`npm install -g wrangler`（Node ≥18）；项目根目录已含 `wrangler.toml`（`name=mcd-order-app`、`pages_build_output_dir=public`、`compatibility_date`），`wrangler pages deploy` 直接可用，无需 `--project-name` 等参数。

```bash
cd mcd-order-app
wrangler login                                  # 浏览器授权（交互）
wrangler pages deploy                           # 建项目 + 部署静态资源与 Functions
wrangler pages secret put MCD_MCP_TOKEN         # 提示时粘贴真实 MCP Token
wrangler pages secret put MCD_PUBLIC_READONLY    # 值填 1（公网只读，防链接外泄被他人下单）；要公网也能下单则跳过或填 0
wrangler pages deploy                           # 再次部署，使 secret 生效
```

要点：
- 设置 secret 后**必须再部署一次**才生效（Pages 的 secret 绑定到具体部署）。
- `.env` 已被 `.gitignore` 排除，不会随站上传；线上 Token 仅通过 `secret put` 注入，前端代码与静态资源均拿不到。
- `functions/api/[[path]].js` 会读取 `env.MCD_MCP_TOKEN` 代理麦当劳 MCP；未配置则返回 503，前端展示「需配置后端」，不回退任何模拟数据。
- **嫌逐条手敲麻烦**：项目根目录已提供 `deploy-local.sh`——先 `wrangler login`，再 `bash deploy-local.sh` 即可自动完成「部署 → 从 `.env` 读 MCP Token 写入 secret → 设只读 → 再部署生效」全流程（无需手动粘贴密钥）。

部署后验证（`<你的域名>` 换成 `mcd-order-app.pages.dev`）：

```bash
curl -s https://<你的域名>/api/status          # 已配 Token 期望 {"mode":"live"}
curl -s -X POST https://<你的域名>/api/stores \
  -H 'Content-Type: application/json' \
  -d '{"city":"北京市","keyword":"国贸","beType":1}'   # 期望真实门店（名称/距离/营业状态）
```

### 方案 B：GitHub Pages（大赛仓库 + 演示一站完成）

```bash
# 1. 初始化仓库并关联远程（替换为你的仓库地址）
cd D:\下载\2026-10-21-09-25-55\mcd-order-app
git init && git add -A && git commit -m "feat: 麦当劳点餐助手"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main

# 2. 放入已生成的工作流（仓库内路径 .github/workflows/deploy-pages.yml）
mkdir -p .github/workflows && cp deploy/github-pages.yml .github/workflows/
git add -A && git commit -m "ci: pages deploy" && git push

# 3. GitHub 仓库页面 → Settings → Pages → Source 选 "GitHub Actions"
```

- 之后每次 push 到 main 自动部署，永久链接 `https://<用户名>.github.io/<仓库名>/`。
- 子路径兼容已完成（见第 6 节），无需改任何代码。
- **切勿**把 `.env` 提交进仓库（`.gitignore` 已排除，push 前 `git status` 复核）。

### 方案 C：Render（仅当公网需要 Node 服务时）

1. 仓库推送到 GitHub（同方案 B 第 1 步）；
2. Render 后台 → New → Blueprint → 选仓库，自动读取 `deploy/render.yaml`；
3. 得到 `https://mcd-order-app.onrender.com`；
4. 确需公开真实点餐时配置 `MCD_MCP_TOKEN` 并加只读/鉴权保护；**不要**裸奔暴露可写 Token（任意访客可下单），务必按 `deploy/basic-auth.md` 加保护。

---

## 6. 需要修改的参数与文件清单

### 已完成的关键改造（本次）

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `public/js/config.js` | 新增 `BASE_PATH` / `appUrl()`：按当前文档目录推导部署基础路径 | 支持根域名与子路径（`/repo/`）两种托管 |
| `public/js/api.js` | 全部接口改为 `appUrl('/api/...')`（已彻底移除 `/data/snapshot.json` 演示快照） | 同上 |
| `public/index.html` | 10 处资源路径改相对路径（`js/…`、`css/…`、`manifest.webmanifest`） | 同上 |
| `scripts/static-deploy-test.js` | 新增：含后端实时渲染 / 无后端诚实提示 / SPA 回退 三场景验证（13/13） | 部署前自动化把关 |
| `deploy/` | 新增 wrangler.toml / github-pages.yml / render.yaml / netlify.toml / vercel.json / basic-auth.md | 即用型配置 |

### 应用源码本身**零修改**即可静态托管

前端 `Api.init()` 探测 `/api/status`，返回非 `live` 即展示「需配置后端」提示（不再有演示回退），这是既有能力，不是新增补丁。

### 各平台需用户提供的参数

| 平台 | 需要你提供 | 在哪里配 |
| --- | --- | --- |
| Cloudflare Pages | Cloudflare 账号（OAuth 登录）；项目名 `mcd-order-app` | `npx wrangler login` 交互完成 |
| GitHub Pages | GitHub 账号；仓库名 | `git remote add origin <url>` |
| Render | Render 账号；（可选）`BASIC_AUTH` | 后台环境变量 |
| 自定义域名 | 已注册的域名 + DNS 管理权 | 平台后台 → Custom domains |

---

## 7. 访问权限控制与身份验证

| 场景 | 是否需要鉴权 | 做法 |
| --- | --- | --- |
| 公网实时模式（默认，经 Pages Function + Token） | 推荐加 | 真实门店/菜单/下单；务必设置 `MCD_PUBLIC_READONLY=1` 阻断公开写操作，或加 CF Access / Basic Auth；建议在 Cloudflare 后台开启 Bot Fight Mode 防爬 |
| 公网实时模式（公开可写，慎） | **必须** | 三选一：① Cloudflare Access（免费 50 用户，零代码）；② `server.js`/Functions 加 Basic Auth（代码见 `deploy/basic-auth.md`，设 `BASIC_AUTH=user:pass` 环境变量启用）；③ 共享密钥查询参数（最低配）。更省心做法：默认只读（`MCD_PUBLIC_READONLY=1`），仅自己/评审用密码或 Access 解锁写操作 |
| 本机/局域网实时模式 | 不需要 | 仅信任网络内可访问 |

**权限申请与范围**：Cloudflare Pages / GitHub Pages 均无"申请"环节，注册即用；GitHub 仓库设为 Public 才能配 Pages 免费版（Private 仓库需 GitHub Pro——这也正是大赛要求公开仓库的原因）。

---

## 8. 验证永久链接

### 自动化（已内置）

```bash
node scripts/static-deploy-test.js   # 13/13：含后端实时渲染 + 无后端诚实提示 + SPA回退
npm test                             # 回归：定位 71/71 + 冒烟 38/38 + 静态部署 13/13 + 响应式 28/28
```

### 部署后手动清单

```bash
# 1. HTTPS 证书与可达性
curl -I https://<你的永久域名>          # 期望 HTTP 200 + valid certificate
curl -s https://<你的永久域名>/api/status   # 已配置 Token 期望 {"mode":"live"}；未配置/无 Function 期望 503 或 200+HTML（SPA 回退）→ 前端展示「需配置后端」
```

> 注意：Cloudflare Pages 对未命中静态文件的路径返回 **200 + index.html**（SPA 回退），不是 404——前端 `api.js` 的 `init()` 已显式校验 `res.ok` 与 content-type，无 Function 时正确展示「需配置后端」（`static-deploy-test.js` 的「SPA回退 / 无后端」场景覆盖）。

浏览器逐项确认：

- [x] 首页正常渲染，商品卡片/图片加载（线上已验证 200，7 商品卡片由 jsdom 链路验证）
- [x] 控制台无 404（重点看 js/css/manifest）——线上逐资源 curl 验证：css/style.css、js/*.js×8、manifest.webmanifest 全部 200（应用不再随站发布任何静态数据文件，门店/菜单均来自 /api）
- [ ] 门店选择器点「定位到当前位置」**能弹出浏览器定位权限框**（证明是安全上下文）——需真机浏览器验证
- [ ] 语音点餐浮层可打开（Chrome）
- [ ] 加购 → 结算 → 领券 → 核价 → 真实下单全流程（需配置 Token）
- [ ] 手机访问同一链接，重复以上；「添加到主屏幕」可用（PWA）

### 本次部署结果（2026-10-21，方案 1：Cloudflare Pages）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 生产域名可达 | `curl -I https://mcd-order-app.pages.dev/` | ✅ HTTP 200，CF 边缘节点，自动 HTTPS |
| 静态资源 | 逐个 curl css/js | ✅ 资源 200 |
| 需配置后端 | `/api/status` 返回 503（无 Token）或 200+HTML（SPA 回退，无 Function） | ✅ 正确展示「需配置后端」，不回退任何模拟数据 |
| 代码版本 | `curl .../js/api.js` 含显式校验逻辑 | ✅ 已上线 |
| 测试回归 | `npm test` | ✅ 215/215（定位 71 + 冒烟 38 + 静态部署 13 + 响应式 28 + 语音 23 + 预算搭配 42） |

### 稳定性验证

| 平台 | 稳定性特征 | 监控建议 |
| --- | --- | --- |
| Cloudflare Pages | 无休眠、CDN 边缘节点、官方 SLA | UptimeRobot 免费 50 个监控点，5 分钟粒度 |
| GitHub Pages | 无休眠；soft limit 100GB/月、10 次构建/小时 | 同上 |
| Render 免费档 | **15 分钟无访问休眠，冷启动 30-60s** | 若不能接受冷启动，用 UptimeRobot 每 14 分钟探活，或升级付费 |

---

## 9. 域名绑定汇总

| 平台 | 免费子域 | 绑定自有域名步骤 |
| --- | --- | --- |
| Cloudflare Pages | `<项目>.pages.dev` | Custom domains → 添加 → DNS 托管在 CF 则自动；否则按要求加 CNAME 记录 |
| GitHub Pages | `<用户>.github.io`（项目站为 `/<仓库>/`） | 仓库根加 `CNAME` 文件写入域名 → DNS 加 CNAME 到 `<用户>.github.io` → Settings 里 Enforce HTTPS |
| Render | `<名>.onrender.com` | Settings → Custom Domain → 加 CNAME |
| Vercel/Netlify | `<名>.vercel.app` / `<名>.netlify.app` | 项目后台 → Domains → Add |

大赛提交使用平台免费子域即可；自有域名仅在需要品牌一致性时绑定。

---

## 10. 一页决策树

```
需要公网永久链接？
├─ 只是分享/手机体验（推荐） ──→ Cloudflare Pages（方案 A，公开即真实数据 + 只读保护）
│                                 └─ 顺带交大赛仓库 ──→ GitHub Pages（方案 B）
├─ 公网也要真实点餐？
│  ├─ 能接受休眠/冷启动 ──→ Render（方案 C）+ Basic Auth 或 CF Access
│  └─ 不能 ──→ Fly.io / 自有服务器 + Cloudflare Tunnel + CF Access
└─ 只有你自己用 ──→ 无需公网：本机 localhost:3210 + 局域网 http://<IP>:3210
```
