# PencilBear AI — 英文版部署指南

面向海外用户的英文站点。后端：Node + Express + TypeScript（用 tsx 直接跑 TS）；
前端：纯静态 `dist/`；数据库：SQLite（sql.js，落盘到 `data/app.db`）。
支付：PayPal（sandbox/live）+ 支付宝（可选）。

---

## 一、购买服务器（境外，免备案）

推荐 **腾讯云国际站** `https://intl.cloud.tencent.com`（中文界面、支持微信/支付宝付款）：
- 节点选 **香港 (Hong Kong)** 或 **新加坡 (Singapore)**
- 配置：2 核 2G 起步（约 ¥50–80/月）
- 系统镜像：**Ubuntu 22.04 LTS**
- 安全组放行：**22 (SSH)、80 (HTTP)、443 (HTTPS)**

备选：**Vultr** `https://www.vultr.com`（全球节点，$6/月，支持 PayPal）。

---

## 二、购买域名并接 Cloudflare

1. 在 **Cloudflare Registrar** 或 **Namecheap** 注册 `pencilbear.ai`（或你喜欢的域名）。
2. 把域名 DNS 托管到 **Cloudflare**（免费）：
   - 添加站点 → 按提示改 Nameserver → 等待生效。
3. 在 Cloudflare 的 **DNS** 里加一条 **A 记录**：
   - `pencilbear.ai` → 你的服务器公网 IP
   - `www.pencilbear.ai` → 同上
4. Cloudflare **SSL/TLS** 设为 `Full`（稍后用 Origin 证书或 Let's Encrypt）。

> 必须等域名解析生效（ping 你的域名能通）后再跑部署脚本里的证书申请。

---

## 三、上传代码到服务器

本地把整个项目打包（已含构建好的前端）：

```bash
# 在本地项目根目录执行
cd pencilbear-ai-en-v2
tar czf pencilbear-deploy.tar.gz \
  --exclude='server/node_modules' \
  --exclude='server/data' \
  --exclude='.git' \
  dist server
```

上传到服务器（用你本地终端，不是在 WorkBuddy 里）：

```bash
scp pencilbear-deploy.tar.gz root@你的服务器IP:/root/
ssh root@你的服务器IP
mkdir -p /www/pencilbear-ai
tar xzf /root/pencilbear-deploy.tar.gz -C /www/pencilbear-ai
```

---

## 四、配置 .env（生产环境）

编辑 `/www/pencilbear-ai/server/.env`：

```ini
PORT=3002
NODE_ENV=production
SITE_URL=https://pencilbear.ai
JWT_SECRET=换成一段随机长字符串
DB_PATH=data/app.db

# PayPal（live 正式环境）
PAYPAL_MODE=live
PAYPAL_CLIENT_ID=你的LIVE_ClientID
PAYPAL_CLIENT_SECRET=你的LIVE_Secret

# 邮件（Gmail 应用专用密码，或换成 Resend/SES）
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=你的邮箱@gmail.com
SMTP_PASS=16位应用专用密码
SMTP_FROM=PencilBear AI <你的邮箱@gmail.com>

# 支付宝（可选，不接就留空）
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY=
ALIPAY_PUBLIC_KEY=
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_NOTIFY_URL=https://pencilbear.ai/api/alipay/notify
ALIPAY_RETURN_URL=https://pencilbear.ai/?payment=success
```

> 后台管理员账号已初始化：`admin@pencilbear.ai` / `a765458131`
> 登录地址：`https://pencilbear.ai/admin.html`

---

## 五、一键部署（在服务器上执行）

```bash
ssh root@你的服务器IP
cd /www/pencilbear-ai
bash deploy/deploy.sh
```

脚本会自动：安装 Node 22 → 安装依赖 → 配置 nginx → 用 PM2 守护进程 → 申请 Let's Encrypt 证书。

---

## 六、验证

- 前台：`https://pencilbear.ai`
- 后台：`https://pencilbear.ai/admin.html`
- 支付测试：点 Buy Now → PayPal 跳转 → 用真实卡或沙盒买家账号测试
- 进程守护：`pm2 status`（应显示 pencilbear-ai 在线）
- 查看日志：`pm2 logs pencilbear-ai`

---

## 七、常见问题

**Q: 改了代码 / .env 后怎么生效？**
```bash
cd /www/pencilbear-ai
# 重新上传改动的文件后：
pm2 restart pencilbear-ai
```

**Q: 想换域名？**
改 `.env` 的 `SITE_URL` + 支付宝 `ALIPAY_NOTIFY_URL`/`RETURN_URL`，
改 `deploy/nginx.conf` 的 `server_name`，然后：
```bash
cp deploy/nginx.conf /etc/nginx/sites-available/pencilbear-ai
systemctl reload nginx
pm2 restart pencilbear-ai
```

**Q: SQLite 数据备份？**
```bash
cp /www/pencilbear-ai/server/data/app.db ~/app.db.bak
```

**Q: 升级配置/重启服务器后进程还在吗？**
PM2 已设开机自启（`pm2 startup`）。重启服务器后进程会自动拉起。
