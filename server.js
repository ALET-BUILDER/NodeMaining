/**
 * server.js — NodeMaster / AXKA Builder
 * ──────────────────────────────────────
 * Express + Socket.IO server dengan:
 *  - Admin panel real-time (Socket.IO)
 *  - SQLite untuk penyimpanan lokal (aman di Railway, zero config)
 *  - JWT untuk autentikasi admin session
 *  - Rate limiting & security headers
 *
 * Cara pakai:
 *   npm install
 *   node server.js
 *
 * Deploy Railway/Render:
 *   PORT otomatis dari env. Set ADMIN_PIN & JWT_SECRET di Railway Variables.
 */

'use strict';

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const path         = require('path');
const crypto       = require('crypto');
const Database     = require('better-sqlite3');

// ── ENV ───────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const ADMIN_PIN  = process.env.ADMIN_PIN  || '043011';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
// NOTE: Kalau JWT_SECRET tidak di-set via env, tiap restart server token lama invalid.
// Wajib set JWT_SECRET di Railway Variables agar session admin tetap valid setelah deploy.

// ── DATABASE (SQLite) ─────────────────────────────────────────────────────────
// SQLite disimpan di folder yang sama. Di Railway, data persisten kalau pakai volume.
// Untuk produksi: set DB_PATH ke path volume Railway, contoh: /data/nodemaster.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'nodemaster.db');
const db = new Database(DB_PATH);

// Aktifkan WAL mode untuk performa lebih baik
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA INIT ───────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId        TEXT PRIMARY KEY,
    paymentEmail  TEXT UNIQUE,
    balance       REAL    DEFAULT 0,
    lockedBalance REAL    DEFAULT 0,
    pinHash       TEXT,
    isVerified    INTEGER DEFAULT 0,
    isBanned      INTEGER DEFAULT 0,
    banReason     TEXT,
    referralCode  TEXT    UNIQUE,
    referredBy    TEXT,
    referralCount INTEGER DEFAULT 0,
    packageLevel  INTEGER DEFAULT 0,
    lastSeen      INTEGER,
    createdAt     INTEGER DEFAULT (strftime('%s','now') * 1000),
    extra         TEXT    DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          TEXT PRIMARY KEY,
    userId      TEXT NOT NULL,
    amount      REAL NOT NULL,
    packageName TEXT,
    status      TEXT DEFAULT 'pending',
    proofUrl    TEXT,
    adminNote   TEXT,
    createdAt   INTEGER DEFAULT (strftime('%s','now') * 1000),
    updatedAt   INTEGER DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (userId) REFERENCES users(userId)
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    action    TEXT,
    targetId  TEXT,
    adminIp   TEXT,
    detail    TEXT,
    createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_users_banned    ON users(isBanned);
  CREATE INDEX IF NOT EXISTS idx_users_verified  ON users(isVerified);
`);

// Default config
const defaultConfig = {
  miningRate:    '0.005',
  welcomeBonus:  '5.00',
  minWithdraw:   '10.00',
  maintenance:   '0',
  maintenanceMsg:'Server sedang dalam perbaikan. Kembali beberapa saat lagi.',
  announcement:  '',
};
const insertCfg = db.prepare(`INSERT OR IGNORE INTO config(key,value) VALUES(?,?)`);
for (const [k, v] of Object.entries(defaultConfig)) insertCfg.run(k, v);

// ── CONFIG HELPERS ─────────────────────────────────────────────────────────────
function getCfg(key) {
  const row = db.prepare(`SELECT value FROM config WHERE key=?`).get(key);
  return row ? row.value : null;
}
function setCfg(key, value) {
  db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES(?,?)`).run(key, String(value));
}

// ── JWT (tanpa library, ringan) ───────────────────────────────────────────────
function signToken(payload) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── ADMIN AUTH MIDDLEWARE ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ status: 'error', message: 'UNAUTHORIZED' });
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') return res.status(401).json({ status: 'error', message: 'UNAUTHORIZED' });
  req.admin = payload;
  next();
}

// Admin log helper
function logAdmin(action, targetId, ip, detail = '') {
  db.prepare(`INSERT INTO admin_log(action,targetId,adminIp,detail) VALUES(?,?,?,?)`).run(action, targetId, ip, detail);
}

// ── EXPRESS APP ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ── HELMET (Security Headers) ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdn.tailwindcss.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      connectSrc:  ["'self'", 'wss:', 'ws:'],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
const apiLimiter     = rateLimit({ windowMs: 60000, max: 30,  standardHeaders: true, legacyHeaders: false });
const adminLimiter   = rateLimit({ windowMs: 60000, max: 60,  standardHeaders: true, legacyHeaders: false, message: { status: 'error', message: 'TOO_MANY_REQUESTS' } });

// Login endpoint: ketat, max 10 per menit per IP
const loginLimiter = rateLimit({
  windowMs: 60000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'TOO_MANY_LOGIN_ATTEMPTS' }
});

app.use(generalLimiter);

// ── ANTI-BOT ──────────────────────────────────────────────────────────────────
const botAgents = /HeadlessChrome|PhantomJS|Selenium|scrapy|curl\/|python-requests|Go-http-client/i;
app.use('/api', (req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  if (!ua || botAgents.test(ua)) return res.status(403).json({ status: 'error', message: 'BOT_DETECTED' });
  next();
});
app.use('/api', apiLimiter);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowedOrigins = [`http://localhost:${PORT}`, process.env.DOMAIN || ''].filter(Boolean);
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ════ SOCKET.IO ═══════════════════════════════════════════════════════════════
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  20000,
  pingInterval: 10000,
});

// Track online users & admin sockets
const onlineUsers  = new Map(); // socketId → { userId, since }
const adminSockets = new Set(); // socketIds milik admin

io.on('connection', (socket) => {

  // ── User join ──
  socket.on('user:join', ({ userId }) => {
    if (!userId) return;
    onlineUsers.set(socket.id, { userId, since: new Date().toLocaleTimeString('id-ID') });
    // Update lastSeen di DB
    db.prepare(`UPDATE users SET lastSeen=? WHERE userId=?`).run(Date.now(), userId);
    broadcastOnlineUsers();
  });

  // ── Admin join ──
  socket.on('admin:join', ({ token }) => {
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'admin') { socket.disconnect(); return; }
    adminSockets.add(socket.id);
    socket.join('admins');
    broadcastStatsToAdmins();
    broadcastOnlineUsers();
  });

  // ── Admin actions (Socket emit untuk force-push) ──
  socket.on('admin:force_ban', ({ userId }) => {
    if (!adminSockets.has(socket.id)) return;
    // Push ke semua socket user yang bersangkutan
    io.to('user_' + userId).emit('force:banned');
  });

  socket.on('admin:payment_action', ({ paymentId, status, userId }) => {
    if (!adminSockets.has(socket.id)) return;
    io.to('user_' + userId).emit('payment:updated', { paymentId, status });
  });

  socket.on('admin:maintenance', (data) => {
    if (!adminSockets.has(socket.id)) return;
    io.emit('system:maintenance', data);
  });

  socket.on('admin:announcement', (data) => {
    if (!adminSockets.has(socket.id)) return;
    io.emit('system:announcement', data);
  });

  socket.on('admin:config_update', (data) => {
    if (!adminSockets.has(socket.id)) return;
    io.emit('system:config_update', data);
  });

  // ── User join personal room ──
  socket.on('user:subscribe', ({ userId }) => {
    socket.join('user_' + userId);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    adminSockets.delete(socket.id);
    broadcastOnlineUsers();
  });
});

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.values());
  io.to('admins').emit('admin:online_users', { users, count: users.length });
}

function broadcastStatsToAdmins() {
  const stats = getStats();
  io.to('admins').emit('admin:stats_update', stats);
}

function getStats() {
  const totalUsers      = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
  const activeToday     = db.prepare(`SELECT COUNT(*) as n FROM users WHERE lastSeen > ?`).get(Date.now() - 86400000).n;
  const bannedUsers     = db.prepare(`SELECT COUNT(*) as n FROM users WHERE isBanned=1`).get().n;
  const pendingPayments = db.prepare(`SELECT COUNT(*) as n FROM payments WHERE status='pending'`).get().n;
  const totalBalance    = db.prepare(`SELECT COALESCE(SUM(balance),0) as s FROM users WHERE isBanned=0`).get().s;
  const totalRevenue    = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE status='verified'`).get().s;
  const totalWdToday    = 0; // Implementasi sesuai struktur WD kamu
  const totalReferrals  = db.prepare(`SELECT COALESCE(SUM(referralCount),0) as s FROM users`).get().s;
  return { totalUsers, activeToday, bannedUsers, pendingPayments, totalBalance, totalRevenue, totalWdToday, totalReferrals };
}

// Stats push otomatis tiap 30 detik
setInterval(broadcastStatsToAdmins, 30000);

// ════ ADMIN API ROUTES ═════════════════════════════════════════════════════════
const adminRouter = express.Router();

// ── Login (public) ────────────────────────────────────────────────────────────
adminRouter.post('/login', loginLimiter, (req, res) => {
  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string') return res.status(400).json({ status: 'error', message: 'INVALID_PIN' });

  // Timing-safe compare
  const expected = Buffer.from(ADMIN_PIN);
  const received = Buffer.from(pin.substring(0, 64)); // max 64 char
  const match = expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!match) {
    logAdmin('login_fail', '—', req.ip, 'Wrong PIN');
    return res.status(401).json({ status: 'error', message: 'WRONG_PIN' });
  }

  const token = signToken({ role: 'admin', iat: Date.now(), exp: Date.now() + 8 * 3600 * 1000 });
  logAdmin('login_success', '—', req.ip);
  res.json({ status: 'ok', token });
});

// ── Protected routes (semua butuh adminAuth) ──────────────────────────────────
adminRouter.use(adminAuth);
adminRouter.use(adminLimiter);

// Stats
adminRouter.post('/stats', (_req, res) => {
  res.json(getStats());
});

// Users list
adminRouter.post('/users', (req, res) => {
  const { filter = 'all', search = '', page = 1, limit = 50 } = req.body || {};
  let query = `SELECT userId, paymentEmail, balance, lockedBalance, isVerified, isBanned, referralCount, packageLevel, createdAt, lastSeen FROM users`;
  const params = [];

  if (filter === 'banned')   { query += ` WHERE isBanned=1`; }
  else if (filter === 'active')   { query += ` WHERE isBanned=0`; }
  else if (filter === 'verified') { query += ` WHERE isVerified=1`; }

  if (search) {
    const cond = filter !== 'all' ? ' AND' : ' WHERE';
    query += `${cond} (userId LIKE ? OR paymentEmail LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, (page - 1) * limit);

  const users = db.prepare(query).all(...params);
  res.json({ status: 'ok', users });
});

// Payments list
adminRouter.post('/payments', (req, res) => {
  const { status = 'pending', page = 1, limit = 50 } = req.body || {};
  let query = `SELECT id, userId, amount, packageName, status, proofUrl, createdAt FROM payments`;
  const params = [];

  if (status !== 'all') { query += ` WHERE status=?`; params.push(status); }
  query += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, (page - 1) * limit);

  const payments = db.prepare(query).all(...params);
  res.json({ status: 'ok', payments });
});

// Verify payment
adminRouter.post('/verify_payment', (req, res) => {
  const { paymentId, status, userId } = req.body || {};
  if (!paymentId || !status || !userId) return res.status(400).json({ status: 'error', message: 'MISSING_FIELDS' });
  if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ status: 'error', message: 'INVALID_STATUS' });

  const payment = db.prepare(`SELECT * FROM payments WHERE id=?`).get(paymentId);
  if (!payment) return res.status(404).json({ status: 'error', message: 'PAYMENT_NOT_FOUND' });

  db.prepare(`UPDATE payments SET status=?, updatedAt=? WHERE id=?`).run(status, Date.now(), paymentId);

  if (status === 'verified') {
    // Upgrade user
    db.prepare(`UPDATE users SET isVerified=1, packageLevel=packageLevel+1 WHERE userId=?`).run(userId);
    // Real-time push
    io.to('user_' + userId).emit('payment:verified', { paymentId });
    io.to('admins').emit('admin:payment_verified', { paymentId, userId });
  } else {
    io.to('user_' + userId).emit('payment:rejected', { paymentId });
  }

  logAdmin('verify_payment', paymentId, req.ip, `status=${status}`);
  broadcastStatsToAdmins();
  res.json({ status: 'ok' });
});

// Ban/Unban user
adminRouter.post('/ban_user', (req, res) => {
  const { userId, ban, reason = '' } = req.body || {};
  if (!userId) return res.status(400).json({ status: 'error', message: 'MISSING_USER_ID' });

  db.prepare(`UPDATE users SET isBanned=?, banReason=? WHERE userId=?`).run(ban ? 1 : 0, reason, userId);

  if (ban) {
    io.to('user_' + userId).emit('force:banned', { reason });
    io.to('admins').emit('admin:user_banned', { userId, reason });
  } else {
    io.to('user_' + userId).emit('force:unbanned');
  }

  logAdmin(ban ? 'ban_user' : 'unban_user', userId, req.ip, reason);
  broadcastStatsToAdmins();
  res.json({ status: 'ok' });
});

// Update balance
adminRouter.post('/update_balance', (req, res) => {
  const { userId, balance } = req.body || {};
  if (!userId || balance === undefined) return res.status(400).json({ status: 'error', message: 'MISSING_FIELDS' });
  const b = parseFloat(balance);
  if (isNaN(b) || b < 0) return res.status(400).json({ status: 'error', message: 'INVALID_BALANCE' });

  db.prepare(`UPDATE users SET balance=? WHERE userId=?`).run(b, userId);
  io.to('user_' + userId).emit('balance:updated', { balance: b });
  logAdmin('update_balance', userId, req.ip, `balance=${b}`);
  res.json({ status: 'ok' });
});

// Verify user manual
adminRouter.post('/verify_user', (req, res) => {
  const { userId, note = '' } = req.body || {};
  if (!userId) return res.status(400).json({ status: 'error', message: 'MISSING_USER_ID' });
  db.prepare(`UPDATE users SET isVerified=1 WHERE userId=?`).run(userId);
  io.to('user_' + userId).emit('user:verified');
  logAdmin('verify_user', userId, req.ip, note);
  res.json({ status: 'ok' });
});

// Reset PIN
adminRouter.post('/reset_pin', (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ status: 'error', message: 'MISSING_USER_ID' });
  // Set PIN ke null — user wajib setup baru saat login
  db.prepare(`UPDATE users SET pinHash=NULL WHERE userId=?`).run(userId);
  io.to('user_' + userId).emit('pin:reset');
  logAdmin('reset_pin', userId, req.ip);
  res.json({ status: 'ok' });
});

// Delete user
adminRouter.post('/delete_user', (req, res) => {
  const { userId, reason = '' } = req.body || {};
  if (!userId || !reason) return res.status(400).json({ status: 'error', message: 'REASON_REQUIRED' });
  db.prepare(`DELETE FROM users WHERE userId=?`).run(userId);
  io.to('user_' + userId).emit('account:deleted');
  logAdmin('delete_user', userId, req.ip, reason);
  broadcastStatsToAdmins();
  res.json({ status: 'ok' });
});

// Broadcast
adminRouter.post('/broadcast', (req, res) => {
  const { message, type = 'info' } = req.body || {};
  if (!message) return res.status(400).json({ status: 'error', message: 'EMPTY_MESSAGE' });
  io.emit('system:broadcast', { message, type, time: Date.now() });
  logAdmin('broadcast', '—', req.ip, `type=${type}: ${message.substring(0, 100)}`);
  res.json({ status: 'ok' });
});

// Config: get
adminRouter.post('/config', (_req, res) => {
  const cfg = {};
  db.prepare(`SELECT key, value FROM config`).all().forEach(r => { cfg[r.key] = r.value; });
  cfg.maintenance = cfg.maintenance === '1';
  res.json({ status: 'ok', ...cfg });
});

// Config: save
adminRouter.post('/save_config', (req, res) => {
  const { miningRate, welcomeBonus, minWithdraw } = req.body || {};
  if (miningRate   !== undefined) setCfg('miningRate',   miningRate);
  if (welcomeBonus !== undefined) setCfg('welcomeBonus', welcomeBonus);
  if (minWithdraw  !== undefined) setCfg('minWithdraw',  minWithdraw);
  logAdmin('save_config', '—', req.ip, JSON.stringify({ miningRate, welcomeBonus, minWithdraw }));
  io.emit('system:config_update', { miningRate, welcomeBonus, minWithdraw });
  res.json({ status: 'ok' });
});

// Maintenance
adminRouter.post('/maintenance', (req, res) => {
  const { enabled, message = '' } = req.body || {};
  setCfg('maintenance',    enabled ? '1' : '0');
  setCfg('maintenanceMsg', message);
  io.emit('system:maintenance', { enabled, message });
  logAdmin('maintenance', '—', req.ip, `enabled=${enabled}`);
  res.json({ status: 'ok' });
});

// Announcement
adminRouter.post('/announcement', (req, res) => {
  const { text = '' } = req.body || {};
  setCfg('announcement', text);
  io.emit('system:announcement', { text });
  logAdmin('announcement', '—', req.ip, text.substring(0, 100));
  res.json({ status: 'ok' });
});

// Danger actions
adminRouter.post('/danger_action', (req, res) => {
  const { action } = req.body || {};
  if (action === 'reset_pending_payments') {
    db.prepare(`DELETE FROM payments WHERE status='pending'`).run();
    logAdmin('danger_reset_pending', '—', req.ip);
  } else if (action === 'clear_banned_users') {
    db.prepare(`DELETE FROM users WHERE isBanned=1`).run();
    logAdmin('danger_clear_banned', '—', req.ip);
  } else {
    return res.status(400).json({ status: 'error', message: 'UNKNOWN_ACTION' });
  }
  broadcastStatsToAdmins();
  res.json({ status: 'ok' });
});

app.use('/admin/api', adminRouter);

// ════ STATIC FILES ═════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname), {
  index: false,
  etag:  true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma',  'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// ════ ROUTES ═══════════════════════════════════════════════════════════════════
app.get('/',            (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/app','/app/'], (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));

// Admin panel — serve tanpa listing direktori
// URL: /admin (bukan /admin.html untuk menghindari langsung ditebak)
app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString(), online: onlineUsers.size }));

// 404
app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'index.html')));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ status: 'error', message: 'INTERNAL_SERVER_ERROR' });
});

// ════ START ════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`✅  NodeMaster server running on http://localhost:${PORT}`);
  console.log(`    index.html  → http://localhost:${PORT}/`);
  console.log(`    app.html    → http://localhost:${PORT}/app`);
  console.log(`    admin.html  → http://localhost:${PORT}/admin`);
  console.log(`    Health      → http://localhost:${PORT}/health`);
  console.log(`    DB          → ${DB_PATH}`);
  if (!process.env.JWT_SECRET) {
    console.warn(`⚠️  JWT_SECRET tidak di-set di env! Set di Railway Variables agar session admin persisten setelah restart.`);
  }
  if (!process.env.ADMIN_PIN) {
    console.warn(`⚠️  ADMIN_PIN menggunakan default. Set di Railway Variables untuk keamanan.`);
  }
});
