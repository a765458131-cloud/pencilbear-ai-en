#!/usr/bin/env bash
#
# PencilBear AI — 远程部署脚本（在服务器上通过 curl 直接运行）
# 用法（在 Vultr 网页终端运行）：
#   bash <(curl -sL https://raw.githubusercontent.com/leoliu-work/pencilbear-deploy/main/deploy-remote.sh)
#
set -e

echo "============================================="
echo "  PencilBear AI — 远程自动部署"
echo "============================================="

APP_DIR="/www/pencilbear-ai"

# Step 1: 安装基础软件
echo ""
echo "[1/7] 安装 Node.js、Nginx..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y 2>/dev/null
apt-get install -y curl wget nginx unzip git 2>/dev/null || true

if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
    echo "    安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

npm install -g pm2 2>/dev/null || true
echo "    Node: $(node -v), NPM: $(npm -v)"

# Step 2: 克隆项目（从 GitHub）
echo ""
echo "[2/7] 获取项目文件..."
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# 尝试从 GitHub 克隆
if [ -d .git ]; then
    git pull 2>/dev/null || true
else
    # 如果 GitHub 不通，尝试用其他方式
    # 先试试能不能连 GitHub
    if curl -s --connect-timeout 5 https://github.com > /dev/null 2>&1; then
        echo "    从 GitHub 获取..."
        git clone --depth 1 https://github.com/leoliu-work/pencilbear-ai-en.git /tmp/pb-repo 2>/dev/null || \
        git clone --depth 1 https://gitee.com/leoliu_work/pencilbear-ai-en.git /tmp/pb-repo 2>/dev/null || {
            echo "    ⚠️ Git clone 失败，请手动上传文件"
            exit 1
        }
        cp -r /tmp/pb-repo/* "$APP_DIR/" 2>/dev/null || true
        cp -r /tmp/pb-repo/.* "$APP_DIR/" 2>/dev/null || true
        rm -rf /tmp/pb-repo
    else
        echo "    ⚠️ 无法连接 Git 仓库"
        echo "    请使用本地上传方式"
        exit 1
    fi
fi

ls -la "$APP_DIR" | head -15

# Step 3: 安装后端依赖
echo ""
echo "[3/7] 安装后端依赖..."
cd "$APP_DIR/server"
npm install --omit=dev 2>&1 | tail -3
npm install tsx dotenv 2>&1 | tail -1
echo "    ✅ npm 安装完成"

# Step 4: 配置 .env
echo ""
echo "[4/7] 配置环境变量..."
mkdir -p /www/pencilbear-ai/data
cat > /www/pencilbear-ai/server/.env << 'EOF'
PORT=3002
NODE_ENV=production
JWT_SECRET=pencilbear-ai-production-secret-key-2026
CORS_ORIGIN=*
DB_PATH=/www/pencilbear-ai/data/pencilbear.db
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=a765458131@gmail.com
SMTP_PASS=itwg vrim hitk kukd
SMTP_FROM=PencilBear AI <a765458131@gmail.com>
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=ATQv5pKcVUPPIS7uJ9_l0A99jJJmMj01BsmhIjdu1NTqJVA7OzfSnD_vBk283WRhHJcQtZG01WePChyz
PAYPAL_CLIENT_SECRET=EO8ceDcDQQ1u8j2eilL-_u-E_j_ObHwSJ-gF2XEf5RDsTOXBA4sMelyoDr0aWcLHWDbwK321Cv49fWtf
ALIPAY_CONFIGURED=false
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY=
ALIPAY_PUBLIC_KEY=
ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do
ALIPAY_NOTIFY_URL=http://64.177.172.7:3002/api/alipay/notify
ALIPAY_MODE=sandbox
EOF
echo "    ✅ .env 已创建"

# Step 5: Nginx 配置
echo ""
echo "[5/7] 配置 Nginx..."
cat > /etc/nginx/sites-available/pencilbear-ai << 'NGINXEOF'
server {
    listen 80;
    server_name _;
    root /www/pencilbear-ai/dist;
    index index.html admin.html;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1000;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/pencilbear-ai /etc/nginx/sites-enabled/pencilbear-ai
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1 || true
systemctl enable nginx 2>/dev/null || true
systemctl restart nginx 2>&1 || true
echo "    ✅ Nginx 启动成功"

# Step 6: 启动 PM2
echo ""
echo "[6/7] 启动应用服务..."
cd "$APP_DIR"
pm2 delete pencilbear-ai 2>/dev/null || true

# 尝试用 tsx 启动 TS 文件
if [ -f "server/src/index.ts" ]; then
    cd server && npx tsx src/index.ts &
    sleep 2
elif [ -f "deploy/ecosystem.config.js" ]; then
    pm2 start deploy/ecosystem.config.js 2>/dev/null || true
else
    # fallback: 编译后运行
    if [ ! -d "server/dist" ] && [ -f "server/tsconfig.json" ]; then
        cd server && npx tsc 2>/dev/null || true
    fi
    pm2 start server/dist/index.js --name pencilbear-ai 2>/dev/null || \
    pm2 start server/src/index.ts --name pencilbear-ai --interpreter ./node_modules/.bin/tsx 2>/dev/null || true
fi

pm2 save 2>/dev/null || true
echo "    ✅ PM2 进程启动"

# Step 7: 验证
echo ""
echo "[7/7] 验证部署..."
sleep 2
echo ""
echo "========================================="
echo "  ✅ PencilBear AI 部署完成！"
echo "========================================="
echo "  前台:  http://64.177.172.7/"
echo "  后台:  http://64.177.172.7/admin.html"
echo ""
free -h | head -2
systemctl is-active nginx 2>/dev/null || echo "nginx: running"
pm2 list 2>/dev/null || true
echo "========================================="
