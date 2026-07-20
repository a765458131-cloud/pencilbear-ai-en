import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import initSqlJs from 'sql.js';
import { config } from './config.js';

// sql.js ships a wasm file. Resolve it from the installed package location,
// falling back to a cwd-relative path (works when run from the server dir).
function resolveWasm(): string {
  try {
    const main = createRequire(import.meta.url).resolve('sql.js');
    return path.join(path.dirname(main), 'sql-wasm.wasm');
  } catch {
    return path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  }
}
const wasmPath = resolveWasm();

let db: any = null;
let SQL: any = null;

const defaultCases = [
  { image_url: '/assets/logo-case-2.jpg', tag: 'LUMINA — Logo Collection', sort_order: 1 },
  { image_url: '/assets/logo-case-3.jpg', tag: 'SELENE — Minimal Series', sort_order: 2 },
  { image_url: '/assets/logo-case-4.jpg', tag: 'AMARIS — Logo Collection', sort_order: 3 },
  { image_url: '/assets/logo-case-ion.jpg', tag: 'ION — Monogram Series', sort_order: 4 },
  { image_url: '/assets/logo-case-nex.jpg', tag: 'NEX — Wordmark Series', sort_order: 5 },
];

export async function initDb(dbPath: string): Promise<void> {
  SQL = await initSqlJs({ locateFile: () => wasmPath });
  if (fs.existsSync(dbPath)) {
    const fileBuf = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuf);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    total_points INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    brand_name TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );`);
  try { db.run(`ALTER TABLE users ADD COLUMN total_points INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE users ADD COLUMN brand_name TEXT DEFAULT ''`); } catch { /* exists */ }

  db.run(`CREATE TABLE IF NOT EXISTS verify_codes (
    email TEXT NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL, created_at INTEGER NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    out_trade_no TEXT,
    email TEXT NOT NULL,
    plan_key TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    credited INTEGER DEFAULT 0,
    paid_at INTEGER,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  );`);
  try { db.run(`ALTER TABLE orders ADD COLUMN out_trade_no TEXT`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE orders ADD COLUMN paid_at INTEGER`); } catch { /* exists */ }
  try { db.run(`ALTER TABLE orders ADD COLUMN consumed_at INTEGER`); } catch { /* exists */ }

  db.run(`CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    credits INTEGER NOT NULL,
    gift_type TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, visitor_id TEXT, referrer TEXT, created_at INTEGER NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT NOT NULL,
    tag TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS design_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    industry TEXT DEFAULT '',
    color_mode TEXT DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    resolved_at INTEGER,
    created_at INTEGER NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS design_request_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );`);

  // Seed admin account
  seedAdmin();
  // Seed default showcase cases if empty
  const caseCount = get('SELECT COUNT(*) AS c FROM cases');
  if (!caseCount || caseCount.c === 0) {
    defaultCases.forEach((c) => {
      exec('INSERT INTO cases (image_url, tag, sort_order, created_at) VALUES (?, ?, ?, ?)', [
        c.image_url, c.tag, c.sort_order, Date.now(),
      ]);
    });
  }

  await saveDb(dbPath);
}

function seedAdmin() {
  const email = config.adminEmail.toLowerCase();
  const existing = get('SELECT id, role FROM users WHERE email = ?', [email]);
  if (!existing) {
    const hash = bcrypt.hashSync(config.adminPassword, 10);
    exec(
      'INSERT INTO users (email, username, password_hash, points, total_points, role, brand_name, created_at) VALUES (?, ?, ?, 0, 0, \'admin\', \'\', ?)',
      [email, 'Admin', hash, Date.now()]
    );
    console.log(`Seeded admin account: ${email}`);
  } else if (existing.role !== 'admin') {
    exec('UPDATE users SET role = \'admin\' WHERE email = ?', [email]);
  }
}

export function saveDb(dbPath: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const data = db.export();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (e) {
      console.error('DB save error', e);
    }
    resolve();
  });
}

export function exec(sql: string, params: any[] = []): void {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
}

export function all(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql: string, params: any[] = []): any {
  return all(sql, params)[0];
}
