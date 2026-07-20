#!/usr/bin/env bash
#
# PencilBear AI — 一键部署脚本（在 Ubuntu 22.04 服务器上以 root 运行）
# 用法：bash deploy/deploy.sh
#
set -e

APP_DIR=/www/pencilbear-ai
SERVER_DIR=$APP_DIR/server
DOMAIN="pencilbear.ai"   # ← 改成你的域名

echo "==> [1/6] 安装基础依赖 (curl, nginx, certbot)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl nginx certbot python3-certbot-nginx

echo "==> [2/6] 安装 Node.js 22 (NodeSource)"
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "==> [3/6] 安装 PM2 进程守护"
npm install -g pm2

echo "==> [4/6] 安装后端依赖"
cd "$SERVER_DIR"
npm install --omit=dev
# 确保 tsx 在（用于直接跑 TS）
npm install tsx dotenv

echo "==> [5/6] 配置 Nginx"
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/pencilbear-ai
ln -sf /etc/nginx/sites-available/pencilbear-ai /etc/nginx/sites-enabled/pencilbear-ai
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/letsencrypt
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> [6/6] 启动应用 (PM2) 并申请 SSL 证书"
cd "$APP_DIR"
pm2 startup -u root --hp /root
pm2 delete pencilbear-ai 2>/dev/null || true
pm2 start deploy/ecosystem.config.js
pm2 save

# 申请 Let's Encrypt 证书（需域名已解析到本机）
echo "==> 申请 Let's Encrypt 证书（确保域名已解析到本服务器 IP）"
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
  --non-interactive --agree-tos -m admin@pencilbear.ai --redirect || \
  echo "⚠️ 证书申请失败：请确认域名已解析到本机 IP 后重新运行 certbot"

echo ""
echo "✅ 部署完成！"
echo "   前台： https://$DOMAIN"
echo "   后台： https://$DOMAIN/admin.html"
echo "   日志： pm2 logs pencilbear-ai"
