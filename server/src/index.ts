import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { initDb, exec, all, get, saveDb } from './db.js';
import { createOrder, getOrder, captureOrder } from './paypal.js';
import { alipayConfigured, createPagePayUrl, queryOrder, verifyNotify } from './alipay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLANS: Record<string, { price: string; credits: number; name: string }> = {
  basic: { price: '9.90', credits: 1, name: '24 Minimalist Logos' },
  pro: { price: '25.00', credits: 3, name: '3 Generations' },
  max: { price: '75.00', credits: 10, name: '10 Generations' },
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===================== Auth helpers ===================== */
function signToken(email: string, role: string): string {
  return jwt.sign({ email, role }, config.jwtSecret, { expiresIn: '30d' });
}

function auth(req: any, res: any, next: any) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(m[1], config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req: any, res: any, next: any) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded: any = jwt.verify(m[1], config.jwtSecret);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/* ===================== Email verification ===================== */
async function sendVerifyEmail(email: string, code: string): Promise<void> {
  if (!config.smtp.configured) {
    console.log(`[verify] dev code for ${email}: ${code}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: true,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:480px;margin:40px auto;padding:0 16px">
  <div style="background:#0a0a14;border-radius:20px;overflow:hidden;text-align:center">
    <!-- Brand -->
    <div style="padding:48px 24px 0">
      <div style="font-size:26px;font-weight:800;color:#7c5cfc;letter-spacing:.5px">PencilBear AI</div>
      <div style="color:#999;font-size:15px;margin-top:10px">Your Email Verification Code</div>
    </div>

    <!-- Code Card -->
    <div style="padding:36px 24px">
      <div style="display:inline-block;background:rgba(124,92,252,.12);border:1px solid rgba(124,92,252,.22);border-radius:16px;padding:24px 48px;margin:auto" dir="ltr">
        <span style="font-size:42px;font-weight:700;color:#fff;letter-spacing:8px;font-family:'Courier New',monospace">${code}</span>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:0 24px 48px">
      <p style="color:#666;font-size:13px;line-height:1.6;margin:0">This code is valid for <strong style="color:#999">5 minutes</strong>. Please do not share it with anyone.</p>
      <p style="color:#555;font-size:12px;margin-top:18px">If you didn't request this code, please ignore this email.</p>
      <div style="margin-top:28px;padding-top:20px;border-top:1px solid #1a1a2e">
        <span style="font-size:12px;color:#444">© 2026 PencilBear AI. All rights reserved.</span>
      </div>
    </div>
  </div>
</div></body></html>`;
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: 'Your PencilBear AI Verification Code',
    text: `Your PencilBear AI verification code is: ${code}\nThis code expires in 5 minutes.`,
    html,
  });
}

/* ===================== Routes ===================== */
app.post('/api/verify/send', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Date.now();
  exec('DELETE FROM verify_codes WHERE email = ?', [email]);
  exec('INSERT INTO verify_codes (email, code, expires, created_at) VALUES (?, ?, ?, ?)', [
    email, code, now + 5 * 60 * 1000, now,
  ]);
  await saveDb(config.dbPath);
  await sendVerifyEmail(email, code);
  const resp: any = { ok: true };
  if (!config.smtp.configured) resp.devCode = code; // dev convenience
  res.json(resp);
});

app.post('/api/verify/check', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const row = get('SELECT * FROM verify_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1', [email]);
  if (!row) return res.status(400).json({ error: 'No code requested' });
  if (row.expires < Date.now()) return res.status(400).json({ error: 'Code expired' });
  if (row.code !== code) return res.status(400).json({ error: 'Invalid code' });
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  if (username.length < 2) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
  if (get('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(409).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  exec('INSERT INTO users (email, username, password_hash, points, total_points, role, brand_name, created_at) VALUES (?, ?, ?, 0, 0, \'user\', \'\', ?)', [
    email, username, hash, Date.now(),
  ]);
  await saveDb(config.dbPath);
  const token = signToken(email, 'user');
  res.json({ token, user: { email, username, points: 0, role: 'user' } });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = get('SELECT * FROM users WHERE email = ?', [email]);
  if (!u) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  const token = signToken(email, u.role);
  res.json({ token, user: { email: u.email, username: u.username, points: u.points, role: u.role } });
});

app.post('/api/auth/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = get('SELECT * FROM users WHERE email = ?', [email]);
  if (!u) return res.status(404).json({ error: 'Email not registered' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
  const hash = await bcrypt.hash(password, 10);
  exec('UPDATE users SET password_hash = ? WHERE email = ?', [hash, email]);
  await saveDb(config.dbPath);
  const token = signToken(email, u.role);
  res.json({ token, user: { email: u.email, username: u.username, points: u.points, role: u.role } });
});

/* ===================== Generate / credits ===================== */
app.get('/api/generate/points', auth, (req: any, res) => {
  const u = get('SELECT points FROM users WHERE email = ?', [req.user.email]);
  res.json({ points: u ? u.points : 0 });
});

app.post('/api/generate/deduct', auth, async (req: any, res) => {
  const cost = parseInt(req.body.cost || '1', 10);
  const u = get('SELECT * FROM users WHERE email = ?', [req.user.email]);
  if (!u) return res.status(404).json({ success: false, error: 'User not found' });
  if (u.points < cost) return res.status(400).json({ success: false, error: 'Not enough credits' });
  exec('UPDATE users SET points = points - ? WHERE email = ?', [cost, req.user.email]);
  await saveDb(config.dbPath);
  res.json({ success: true, points: u.points - cost });
});

/* ===================== PayPal ===================== */
app.get('/api/paypal/config', (req, res) => {
  res.json({ configured: config.paypal.configured });
});

app.post('/api/paypal/create', async (req, res) => {
  if (!config.paypal.configured) return res.status(503).json({ error: 'PayPal not configured' });
  const planKey = String(req.body.planKey || '');
  const userEmail = String(req.body.userEmail || '').trim().toLowerCase();
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  if (!userEmail) return res.status(400).json({ error: 'Missing email' });
  try {
    const returnUrl = `${config.siteUrl}/?payment=success`;
    const cancelUrl = `${config.siteUrl}/#pricing`;
    const { orderID, approveUrl } = await createOrder(plan.price, plan.name, returnUrl, cancelUrl);
    exec(
      'INSERT OR REPLACE INTO orders (order_id, out_trade_no, email, plan_key, credits, amount, status, credited, created_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', 0, ?)',
      [orderID, orderID, userEmail, planKey, plan.credits, plan.price, Date.now()]
    );
    await saveDb(config.dbPath);
    res.json({ orderID, approveUrl });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || 'PayPal error' });
  }
});

app.get('/api/paypal/status', async (req, res) => {
  const orderID = String(req.query.orderID || '');
  const order = get('SELECT * FROM orders WHERE order_id = ?', [orderID]);
  if (!order) return res.status(404).json({ status: 'NOTFOUND' });
  if (order.status === 'completed') return res.json({ status: 'PAID', credits: order.credits, orderID });
  try {
    const data: any = await getOrder(orderID);
    let status = data.status;
    if (status === 'APPROVED') {
      const cap: any = await captureOrder(orderID);
      status = cap.status;
    }
    if (status === 'COMPLETED') {
      if (!order.credited) {
        exec('UPDATE users SET points = points + ? WHERE email = ?', [order.credits, order.email]);
        exec('UPDATE orders SET status = \'completed\', credited = 1, paid_at = ?, consumed_at = ? WHERE order_id = ?', [Date.now(), Date.now(), orderID]);
        await saveDb(config.dbPath);
      }
      return res.json({ status: 'PAID', credits: order.credits, orderID });
    }
    res.json({ status: 'PENDING', orderID });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

app.post('/api/paypal/confirm-topup', async (req, res) => {
  const orderID = String(req.body.orderID || '');
  const order = get('SELECT * FROM orders WHERE order_id = ?', [orderID]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'completed') {
    exec('UPDATE users SET points = points + ? WHERE email = ?', [order.credits, order.email]);
    exec('UPDATE orders SET status = \'completed\', credited = 1, paid_at = ?, consumed_at = ? WHERE order_id = ?', [Date.now(), Date.now(), orderID]);
    await saveDb(config.dbPath);
  }
  res.json({ ok: true });
});

/* ===================== Alipay ===================== */
function genAlipayTradeNo(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `PB${ts}${rand}`;
}

app.get('/api/alipay/config', (req, res) => {
  res.json({ configured: alipayConfigured() });
});

app.post('/api/alipay/create', async (req, res) => {
  if (!alipayConfigured()) return res.status(503).json({ error: 'Alipay not configured' });
  const planKey = String(req.body.planKey || '');
  const userEmail = String(req.body.userEmail || '').trim().toLowerCase();
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  if (!userEmail) return res.status(400).json({ error: 'Missing email' });
  const outTradeNo = genAlipayTradeNo();
  try {
    const payUrl = createPagePayUrl(outTradeNo, plan.price, plan.name, `PencilBear AI - ${plan.name}`);
    exec(
      'INSERT OR REPLACE INTO orders (order_id, out_trade_no, email, plan_key, credits, amount, status, credited, created_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', 0, ?)',
      [outTradeNo, outTradeNo, userEmail, planKey, plan.credits, plan.price, Date.now()]
    );
    await saveDb(config.dbPath);
    res.json({ orderID: outTradeNo, payUrl });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Alipay error' });
  }
});

app.get('/api/alipay/status', async (req, res) => {
  const orderID = String(req.query.orderID || '');
  const order = get('SELECT * FROM orders WHERE order_id = ?', [orderID]);
  if (!order) return res.status(404).json({ status: 'NOTFOUND' });
  if (order.status === 'completed') return res.json({ status: 'PAID', credits: order.credits, orderID });
  try {
    const tradeStatus = await queryOrder(orderID);
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      if (!order.credited) {
        exec('UPDATE users SET points = points + ? WHERE email = ?', [order.credits, order.email]);
        exec('UPDATE orders SET status = \'completed\', credited = 1, paid_at = ?, consumed_at = ? WHERE order_id = ?', [Date.now(), Date.now(), orderID]);
        await saveDb(config.dbPath);
      }
      return res.json({ status: 'PAID', credits: order.credits, orderID });
    }
    res.json({ status: 'PENDING', orderID });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

app.post('/api/alipay/notify', async (req, res) => {
  const params: Record<string, any> = req.body || {};
  if (!verifyNotify(params)) {
    return res.send('failure');
  }
  const outTradeNo = String(params.out_trade_no || '');
  const tradeStatus = String(params.trade_status || '');
  if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
    const order = get('SELECT * FROM orders WHERE order_id = ?', [outTradeNo]);
    if (order && !order.credited) {
      exec('UPDATE users SET points = points + ? WHERE email = ?', [order.credits, order.email]);
      exec('UPDATE orders SET status = \'completed\', credited = 1, paid_at = ?, consumed_at = ? WHERE order_id = ?', [Date.now(), Date.now(), outTradeNo]);
      await saveDb(config.dbPath);
    }
  }
  res.send('success');
});

app.post('/api/alipay/confirm-topup', async (req, res) => {
  const orderID = String(req.body.orderID || '');
  const order = get('SELECT * FROM orders WHERE order_id = ?', [orderID]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'completed') {
    exec('UPDATE users SET points = points + ? WHERE email = ?', [order.credits, order.email]);
    exec('UPDATE orders SET status = \'completed\', credited = 1, paid_at = ?, consumed_at = ? WHERE order_id = ?', [Date.now(), Date.now(), orderID]);
    await saveDb(config.dbPath);
  }
  res.json({ ok: true });
});

/* ===================== Showcases (DB-backed) ===================== */
app.get('/api/showcases', (req, res) => {
  const rows = all('SELECT image_url, tag FROM cases ORDER BY sort_order ASC, id ASC');
  const cases = rows.map((r: any) => ({ image_url: r.image_url, tag: r.tag }));
  res.json({ cases });
});

/* ===================== Tracking ===================== */
app.post('/api/track/pageview', (req, res) => {
  try {
    const b = req.body || {};
    exec('INSERT INTO pageviews (path, visitor_id, referrer, created_at) VALUES (?, ?, ?, ?)', [
      b.path || '', b.visitorId || '', b.referrer || '', Date.now(),
    ]);
    saveDb(config.dbPath);
  } catch { /* ignore */ }
  res.json({ ok: true });
});

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

app.get('/api/track/stats', (req, res) => {
  const rows = all('SELECT visitor_id, created_at FROM pageviews');
  const totalPV = rows.length;
  const totalUV = new Set(rows.map((r: any) => r.visitor_id)).size;

  const now = Date.now();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 86400000;

  const todayRows = rows.filter((r: any) => r.created_at >= todayStart);
  const yesterdayRows = rows.filter((r: any) => r.created_at >= yesterdayStart && r.created_at < todayStart);

  const todayPV = todayRows.length;
  const todayUV = new Set(todayRows.map((r: any) => r.visitor_id)).size;
  const yesterdayPV = yesterdayRows.length;
  const yesterdayUV = new Set(yesterdayRows.map((r: any) => r.visitor_id)).size;

  // 7-day trend (oldest -> newest)
  const dailyTrend: any[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfDay(now) - i * 86400000;
    const dayEnd = dayStart + 86400000;
    const dayRows = rows.filter((r: any) => r.created_at >= dayStart && r.created_at < dayEnd);
    const d = new Date(dayStart);
    const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dailyTrend.push({ date, pv: dayRows.length });
  }

  res.json({ totalPV, totalUV, todayPV, todayUV, yesterdayPV, yesterdayUV, dailyTrend });
});

/* ===================== Admin: Stats ===================== */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = get('SELECT COUNT(*) AS c FROM users WHERE role != \'admin\'');
  const generations = get('SELECT COUNT(*) AS c FROM orders');
  res.json({ stats: { users: users ? users.c : 0, generations: generations ? generations.c : 0 } });
});

/* ===================== Admin: Users ===================== */
app.get('/api/admin/users', requireAdmin, (req: any, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  const users = all(
    'SELECT id, email, username, points, total_points, brand_name, role, created_at FROM users WHERE role != \'admin\' ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  res.json({ users });
});

app.post('/api/admin/users/:id/add-points', requireAdmin, async (req: any, res) => {
  const id = req.params.id;
  const points = parseInt(req.body.points || '0', 10);
  if (isNaN(points) || points === 0) return res.status(400).json({ error: 'Invalid points' });
  const u = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const newPoints = Math.max(0, u.points + points);
  const newTotal = Math.max(0, u.total_points + points);
  exec('UPDATE users SET points = ?, total_points = ? WHERE id = ?', [newPoints, newTotal, id]);
  // record gift for admin grants
  exec('INSERT INTO gifts (user_email, credits, gift_type, note, created_at) VALUES (?, ?, \'admin\', ?, ?)', [
    u.email, points, String(req.body.note || ''), Date.now(),
  ]);
  await saveDb(config.dbPath);
  res.json({ user: { points: newPoints, total_points: newTotal } });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req: any, res) => {
  const id = req.params.id;
  const u = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  exec('DELETE FROM orders WHERE email = ?', [u.email]);
  exec('DELETE FROM gifts WHERE user_email = ?', [u.email]);
  exec('DELETE FROM users WHERE id = ?', [id]);
  await saveDb(config.dbPath);
  res.json({ ok: true });
});

/* ===================== Admin: Orders ===================== */
app.get('/api/admin/orders', requireAdmin, (req: any, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  const orders = all(
    'SELECT order_id AS id, out_trade_no, email AS user_email, plan_key, credits, amount, status, created_at FROM orders ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  res.json({ orders });
});

app.get('/api/admin/orders/:id', requireAdmin, (req: any, res) => {
  const id = req.params.id;
  const order = get('SELECT order_id AS id, out_trade_no, email AS user_email, plan_key, credits, amount, status, paid_at, consumed_at, created_at FROM orders WHERE order_id = ?', [id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order, images: [] });
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req: any, res) => {
  const id = req.params.id;
  exec('DELETE FROM orders WHERE order_id = ?', [id]);
  await saveDb(config.dbPath);
  res.json({ ok: true });
});

app.get('/api/admin/orders/:id/images', requireAdmin, (req: any, res) => {
  res.json({ images: [] });
});

app.delete('/api/admin/orders/:id/images/:imageId', requireAdmin, async (req: any, res) => {
  res.json({ ok: true });
});

/* ===================== Design Requests (customer-submitted logo needs) ===================== */
app.post('/api/designs', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const brandName = String(req.body.brandName || req.body.brand_name || '').trim();
  if (!brandName) return res.status(400).json({ error: 'Brand name required' });
  const createdAt = parseInt(req.body.createdAt || req.body.created_at || '0', 10) || Date.now();
  // Dedupe by email + brand + created_at so retries / localStorage sync don't duplicate
  const existing = get(
    'SELECT id FROM design_requests WHERE email = ? AND brand_name = ? AND created_at = ?',
    [email, brandName, createdAt]
  );
  if (existing) {
    return res.json({ ok: true, id: existing.id, duplicated: true });
  }
  exec(
    'INSERT INTO design_requests (email, brand_name, industry, color_mode, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      email,
      brandName,
      String(req.body.industry || '').trim(),
      String(req.body.colorMode || req.body.color_mode || '').trim(),
      String(req.body.description || '').trim(),
      'pending',
      createdAt,
    ]
  );
  await saveDb(config.dbPath);
  const row = get(
    'SELECT id FROM design_requests WHERE email = ? AND brand_name = ? AND created_at = ? ORDER BY id DESC LIMIT 1',
    [email, brandName, createdAt]
  );
  res.json({ ok: true, id: row ? row.id : null });
});

app.get('/api/admin/designs', requireAdmin, (req: any, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  const rows = all(
    'SELECT id, email, brand_name, industry, color_mode, description, status, resolved_at, created_at FROM design_requests ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  res.json({ requests: rows });
});

app.post('/api/admin/designs/:id/resolve', requireAdmin, async (req: any, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  exec('UPDATE design_requests SET status = \'resolved\', resolved_at = ? WHERE id = ?', [Date.now(), id]);
  await saveDb(config.dbPath);
  res.json({ ok: true });
});

/* ===================== Admin: Payments / Revenue ===================== */
app.get('/api/admin/payments', requireAdmin, (req: any, res) => {
  const orders = all('SELECT * FROM orders WHERE status = \'completed\'');
  const paidRevenue = orders.reduce((s: number, o: any) => s + parseFloat(o.amount || '0'), 0);
  const settledRevenue = orders.filter((o: any) => o.credited).reduce((s: number, o: any) => s + parseFloat(o.amount || '0'), 0);
  const byPlan: Record<string, { plan_key: string; paid: number; revenue: number }> = {};
  orders.forEach((o: any) => {
    if (!byPlan[o.plan_key]) byPlan[o.plan_key] = { plan_key: o.plan_key, paid: 0, revenue: 0 };
    byPlan[o.plan_key].paid += 1;
    byPlan[o.plan_key].revenue += parseFloat(o.amount || '0');
  });
  const recent = orders.map((o: any) => ({
    out_trade_no: o.out_trade_no || o.order_id,
    user_email: o.email,
    plan_key: o.plan_key,
    amount: o.amount,
    status: o.credited ? 'CONSUMED' : 'PAID',
    paid_at: o.paid_at,
    consumed_at: o.consumed_at,
  }));
  res.json({
    summary: {
      paid_revenue: paidRevenue,
      settled_revenue: settledRevenue,
      paid_orders: orders.length,
      consumed_orders: orders.filter((o: any) => o.credited).length,
    },
    recent,
    byPlan: Object.values(byPlan),
  });
});

/* ===================== Admin: Gifts ===================== */
app.get('/api/admin/gifts', requireAdmin, (req: any, res) => {
  const rows = all('SELECT * FROM gifts ORDER BY created_at DESC');
  const totalCredits = rows.reduce((s: number, g: any) => s + (g.credits || 0), 0);
  const giftUsers = new Set(rows.map((g: any) => g.user_email)).size;
  const byType: Record<string, { gift_type: string; total: number; credits: number }> = {};
  rows.forEach((g: any) => {
    if (!byType[g.gift_type]) byType[g.gift_type] = { gift_type: g.gift_type, total: 0, credits: 0 };
    byType[g.gift_type].total += 1;
    byType[g.gift_type].credits += (g.credits || 0);
  });
  res.json({
    summary: { total_credits: totalCredits, total_gifts: rows.length, gift_users: giftUsers },
    byType: Object.values(byType),
    recent: rows.slice(0, 50),
  });
});

/* ===================== Admin: Cases (showcase management) ===================== */
const assetsDir = path.join(__dirname, '..', '..', 'dist', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, assetsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = 'case-' + Date.now() + '-' + Math.round(Math.random() * 1e6) + ext;
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/admin/cases', requireAdmin, (req: any, res) => {
  const cases = all('SELECT id, image_url, tag, sort_order FROM cases ORDER BY sort_order ASC, id ASC');
  res.json({ cases });
});

app.post('/api/admin/cases', requireAdmin, upload.single('image'), async (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const tag = String(req.body.tag || '').trim();
  const maxRow = get('SELECT MAX(sort_order) AS m FROM cases');
  const sortOrder = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
  exec('INSERT INTO cases (image_url, tag, sort_order, created_at) VALUES (?, ?, ?, ?)', [
    '/assets/' + req.file.filename, tag, sortOrder, Date.now(),
  ]);
  await saveDb(config.dbPath);
  const id = get('SELECT last_insert_rowid() AS id');
  res.json({ case: { id: id.id, image_url: '/assets/' + req.file.filename, tag, sort_order: sortOrder } });
});

app.post('/api/admin/cases/reorder', requireAdmin, async (req: any, res) => {
  const order = req.body.order || [];
  for (let i = 0; i < order.length; i++) {
    exec('UPDATE cases SET sort_order = ? WHERE id = ?', [i + 1, order[i]]);
  }
  await saveDb(config.dbPath);
  res.json({ ok: true });
});

app.put('/api/admin/cases/:id', requireAdmin, async (req: any, res) => {
  const id = req.params.id;
  const tag = String(req.body.tag || '');
  exec('UPDATE cases SET tag = ? WHERE id = ?', [tag, id]);
  await saveDb(config.dbPath);
  res.json({ ok: true });
});

app.delete('/api/admin/cases/:id', requireAdmin, async (req: any, res) => {
  const id = req.params.id;
  const c = get('SELECT * FROM cases WHERE id = ?', [id]);
  if (c) {
    const fp = path.join(assetsDir, path.basename(c.image_url));
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
    exec('DELETE FROM cases WHERE id = ?', [id]);
    await saveDb(config.dbPath);
  }
  res.json({ ok: true });
});

/* ===================== Static frontend ===================== */
const staticDir = config.staticDir || path.join(__dirname, '..', '..', 'dist');
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  console.log(`Serving frontend from: ${staticDir}`);
} else {
  console.log(`Frontend dir not found at ${staticDir} — API only mode`);
}

/* ===================== Start ===================== */
initDb(config.dbPath)
  .then(() => {
    app.listen(config.port, () => {
      console.log(`PencilBear AI server listening on port ${config.port}`);
      console.log(`PayPal: ${config.paypal.configured ? config.paypal.mode + ' (configured)' : 'NOT configured'}`);
      console.log(`Alipay: ${config.alipay.configured ? 'configured (' + config.alipay.gateway + ')' : 'NOT configured'}`);
      console.log(`Admin: ${config.adminEmail}`);
    });
  })
  .catch((e) => {
    console.error('Failed to init DB', e);
    process.exit(1);
  });
