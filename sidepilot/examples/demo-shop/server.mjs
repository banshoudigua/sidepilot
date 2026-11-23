// 示例一：带动态数据管理的咖啡店后台
// 原生 http + node:sqlite，零依赖；挂载 SidePilot 后获得 AI 助手
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPilot } from '../../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

// ---------- 数据准备 ----------
mkdirSync(join(HERE, 'data'), { recursive: true });
const db = new DatabaseSync(join(HERE, 'data', 'shop.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  price    REAL NOT NULL,
  stock    INTEGER NOT NULL DEFAULT 0,
  category TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  qty        INTEGER NOT NULL,
  amount     REAL NOT NULL,
  created_at TEXT NOT NULL
);
`);

// 首次运行灌入演示数据，保证统计结果稳定可复现
if (db.prepare('SELECT COUNT(*) AS c FROM products').get().c === 0) {
  const insP = db.prepare('INSERT INTO products (name, price, stock, category) VALUES (?,?,?,?)');
  [
    ['手冲咖啡壶', 328, 18, '器具'],
    ['云南小粒咖啡豆', 89, 240, '咖啡豆'],
    ['冷萃瓶', 156, 62, '器具'],
    ['埃塞俄比亚耶加雪菲', 128, 35, '咖啡豆'],
    ['电子秤', 219, 12, '器具'],
    ['曼特宁咖啡豆', 98, 88, '咖啡豆']
  ].forEach((r) => insP.run(r[0], r[1], r[2], r[3]));

  const insO = db.prepare('INSERT INTO orders (product_id, qty, amount, created_at) VALUES (?,?,?,?)');
  const prices = [328, 89, 156, 128, 219, 98];
  const days = [1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 16, 18, 20, 22, 25, 27, 28, 29, 30, 30];
  days.forEach((ago, i) => {
    const pid = (i % 6) + 1;
    const qty = (i % 4) + 1;
    const d = new Date(Date.now() - ago * 86400000);
    insO.run(pid, qty, prices[pid - 1] * qty, d.toISOString().slice(0, 10));
  });
}

// ---------- 接口 ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((done) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return done({});
      try { done(JSON.parse(text)); } catch (e) { done({}); }
    });
  });
}

async function handleApi(req, res, url) {
  const path = url.pathname;

  // 商品列表：支持关键词与分类筛选
  if (path === '/api/products' && req.method === 'GET') {
    const kw = url.searchParams.get('keyword');
    const cat = url.searchParams.get('category');
    let sql = 'SELECT * FROM products WHERE 1=1';
    const args = [];
    if (kw) { sql += ' AND name LIKE ?'; args.push('%' + kw + '%'); }
    if (cat) { sql += ' AND category = ?'; args.push(cat); }
    sql += ' ORDER BY id ASC';
    json(res, 200, { ok: true, items: db.prepare(sql).all(...args) });
    return true;
  }

  // 新增商品
  if (path === '/api/products' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.name || b.price == null) {
      json(res, 400, { ok: false, error: 'name 和 price 必填' });
      return true;
    }
    const info = db.prepare('INSERT INTO products (name, price, stock, category) VALUES (?,?,?,?)')
      .run(String(b.name), Number(b.price), Number(b.stock || 0), b.category || '未分类');
    json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
    return true;
  }

  // 销售统计：总额、订单数、热销 TOP、按天趋势
  if (path === '/api/stats/sales' && req.method === 'GET') {
    const days = Number(url.searchParams.get('days') || 30);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const total = db.prepare('SELECT COUNT(*) AS cnt, SUM(amount) AS amt FROM orders WHERE created_at >= ?').get(since);
    const top = db.prepare(`
      SELECT p.name, SUM(o.qty) AS qty, SUM(o.amount) AS amount
      FROM orders o JOIN products p ON p.id = o.product_id
      WHERE o.created_at >= ?
      GROUP BY o.product_id ORDER BY amount DESC LIMIT 5
    `).all(since);
    const trend = db.prepare(`
      SELECT created_at AS day, SUM(amount) AS amount, COUNT(*) AS cnt
      FROM orders WHERE created_at >= ? GROUP BY created_at ORDER BY created_at ASC
    `).all(since);

    json(res, 200, {
      ok: true,
      range: { days, since },
      orders: total.cnt || 0,
      revenue: Math.round((total.amt || 0) * 100) / 100,
      top,
      trend
    });
    return true;
  }

  // 订单列表
  if (path === '/api/orders' && req.method === 'GET') {
    const rows = db.prepare(`
      SELECT o.id, p.name AS product, o.qty, o.amount, o.created_at
      FROM orders o JOIN products p ON p.id = o.product_id
      ORDER BY o.created_at DESC, o.id DESC LIMIT 20
    `).all();
    json(res, 200, { ok: true, items: rows });
    return true;
  }

  return false;
}

// ---------- 静态页面 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(res, path) {
  const file = path === '/' ? 'index.html' : path.slice(1);
  const abs = join(HERE, 'public', file);
  if (!existsSync(abs)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(abs)] || 'text/plain; charset=utf-8' });
  res.end(readFileSync(abs));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  handleApi(req, res, url).then((handled) => {
    if (handled) return;
    serveStatic(res, url.pathname);
  }, () => {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('服务端错误');
  });
});

// ---------- 挂载 AI 助手 ----------
const pilot = createPilot({ config: join(HERE, '.sidepilot', 'config.json') });
pilot.attach(server);

server.listen(PORT, () => {
  console.log('');
  console.log('  咖啡店后台已启动');
  console.log('  管理页面  http://localhost:' + PORT + '/');
  console.log('  AI 助手   http://localhost:' + PORT + '/pilot');
  console.log('  接口文档  http://localhost:' + PORT + '/pilot/docs');
  console.log('');
});
