#!/bin/bash
# PencilBear AI (English) — one-shot server setup
# Run on the Vultr box AFTER:  git clone https://github.com/OWNER/pencilbear-ai-en.git /www/pencilbear-ai
set -e

APP_DIR="/www/pencilbear-ai"
cd "$APP_DIR"

echo "== [1/4] 安装后端依赖 (npm install) =="
cd "$APP_DIR/server"
npm install

echo "== [2/4] 生成 .env =="
if [ ! -f .env ]; then
  cp .env.example .env
  JWT=$(openssl rand -hex 24)
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=$JWT#" .env
  sed -i "s#^SITE_URL=.*#SITE_URL=http://64.177.172.7#" .env
  sed -i "s#^STATIC_DIR=.*#STATIC_DIR=../dist#" .env
  echo ".env 已生成（PayPal/SMTP 暂用沙箱占位，正式收款前请填真实密钥）"
else
  echo ".env 已存在，跳过"
fi

echo "== [3/4] 配置 Nginx =="
cp "$APP_DIR/deploy/nginx-ip.conf" /etc/nginx/sites-available/pencilbear
ln -sf /etc/nginx/sites-available/pencilbear /etc/nginx/sites-enabled/pencilbear
rm -f /etc/nginx/sites-enabled/default
nginx -t && (systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload 2>/dev/null || true)

echo "== [4/4] 启动后端 (PM2) =="
cd "$APP_DIR/server"
pm2 start "$APP_DIR/deploy/ecosystem.config.js" --env production
pm2 save

echo ""
echo "== 完成！浏览器打开 http://64.177.172.7 =="
echo "（如白页，运行：pm2 logs pencilbear-ai 查看后端报错）"
