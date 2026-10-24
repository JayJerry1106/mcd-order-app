#!/usr/bin/env bash
# 麦当劳点餐助手 · 一键本地部署到 Cloudflare Pages（自动写入 secret）
# 前置：先在本机执行一次 `wrangler login`（浏览器授权，免费 Cloudflare 账号即可）
# 用法：  bash deploy-local.sh
set -euo pipefail

cd "$(dirname "$0")"

# 0. 依赖检查
if ! command -v wrangler >/dev/null 2>&1; then
  echo "✗ 未找到 wrangler，请先安装：npm install -g wrangler（需 Node ≥18）"
  exit 1
fi

# 1. 部署静态资源 + Functions（functions/api/[[path]].js 一并发布；根目录 wrangler.toml 已含 name/pages_build_output_dir）
echo "==> [1/4] 部署静态资源与 Functions ..."
wrangler pages deploy

# 2. 从本地 .env 读取真实 MCP Token（不打印明文），写入 Pages secret
if [ ! -f .env ]; then
  echo "✗ 未找到 .env（应包含 MCD_MCP_TOKEN）"
  exit 1
fi
MCP_TOK=$(node -e "const fs=require('fs');const l=fs.readFileSync('.env','utf8').split(/\r?\n/).find(x=>/^MCD_MCP_TOKEN=/.test(x));if(!l){process.exit(2);}process.stdout.write(l.split('=').slice(1).join('=').trim());")
if [ -z "$MCP_TOK" ]; then
  echo "✗ .env 中未找到 MCD_MCP_TOKEN"
  exit 1
fi

echo "==> [2/4] 写入 MCD_MCP_TOKEN secret（从 .env 读取，未打印）..."
printf '%s' "$MCP_TOK" | wrangler pages secret put MCD_MCP_TOKEN

echo "==> [3/4] 写入 MCD_PUBLIC_READONLY=1（公网只读，防链接外泄被他人下单）..."
printf '1' | wrangler pages secret put MCD_PUBLIC_READONLY

# 3. 再次部署，使 secret 生效（Pages 的 secret 绑定到具体部署）
echo "==> [4/4] 再次部署使 secret 生效 ..."
wrangler pages deploy

echo
echo "✅ 部署完成。永久链接：https://mcd-order-app.pages.dev"
echo "验证："
echo "  curl -s https://mcd-order-app.pages.dev/api/status"
echo "  curl -s -X POST https://mcd-order-app.pages.dev/api/stores -H 'Content-Type: application/json' -d '{\"city\":\"北京市\",\"keyword\":\"国贸\",\"beType\":1}'"
