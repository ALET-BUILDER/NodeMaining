/**
 * server.js — NodeMaster / AXKA Builder
 * ══════════════════════════════════════════════════════════════
 * Express + Socket.IO + SQLite
 * Semua API yang dibutuhkan app.html, admin.html, dan index.html
 * tersedia di sini — TANPA api.php.
 *
 * Deploy Railway:
 *   Set ADMIN_PIN, JWT_SECRET, DB_PATH di Railway Variables.
 *   PORT otomatis dari env.
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const path       = require('path');
const crypto     = require('crypto');
const Database   = require('better-sqlite3');

// ── ENV ───────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const ADMIN_PIN  = process.env.ADMIN_PIN  || '043011';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'nodemaster.db');
const DOMAIN     = process.env.DOMAIN     || '';

if (!process.env.JWT_SECRET) console.warn('⚠️  JWT_SECRET tidak di-set di env! Set di Railway Variables.');
if (!process.env.ADMIN_PIN)  console.warn('⚠️  ADMIN_PIN menggunakan default. Set di Railway Variables.');

// ── DATABASE ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId        TEXT PRIMARY KEY,
    paymentEmail  TEXT,
    pinHash       TEXT,
    balance       REAL    DEFAULT 0,
    lockedBalance REAL    DEFAULT 0,
    unlockedBalance REAL  DEFAULT 0,
    totalWD       REAL    DEFAULT 0,
    isVerified    INTEGER DEFAULT 0,
    isBanned      INTEGER DEFAULT 0,
    banReason     TEXT,
    accountTier   TEXT    DEFAULT 'trial',
    referralCode  TEXT,
    referredBy    TEXT,
    referralCount INTEGER DEFAULT 0,
    validReferralCount INTEGER DEFAULT 0,
    upgradeDate   INTEGER,
    lastSeen      INTEGER,
    createdAt     INTEGER DEFAULT (strftime('%s','now') * 1000),
    extra         TEXT    DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id          TEXT PRIMARY KEY,
    userId      TEXT NOT NULL,
    amount      REAL NOT NULL,
    netAmount   REAL,
    netIdr      REAL,
    provider    TEXT DEFAULT 'DANA',
    number      TEXT,
    name        TEXT,
    whatsapp    TEXT,
    status      TEXT DEFAULT 'pending',
    rejectReason TEXT,
    createdAt   INTEGER DEFAULT (strftime('%s','now') * 1000),
    updatedAt   INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    userId      TEXT NOT NULL,
    type        TEXT,
    amount      REAL,
    description TEXT,
    createdAt   INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT,
    message   TEXT,
    createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS admin_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    action    TEXT,
    targetId  TEXT,
    adminIp   TEXT,
    detail    TEXT,
    createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_wd_status   ON withdrawals(status);
  CREATE INDEX IF NOT EXISTS idx_wd_userId   ON withdrawals(userId);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(paymentEmail);
`);

// Default config
const defaultConfig = {
  miningRate:      '0.005',
  welcomeBonus:    '5.00',
  minWithdraw:     '1.00',
  maintenance:     '0',
  maintenanceMsg:  'Server sedang dalam perbaikan.',
  announcement:    '',
  rate_idr:        '17000',
  ref_pct_basic:   '25',
  ref_pct_pro:     '50',
  ref_pct_vip:     '75',
  verif_base_rp:   '17000',
  broadcast_active:'0',
  broadcast_msg:   '',
};
const insertCfg = db.prepare(`INSERT OR IGNORE INTO config(key,value) VALUES(?,?)`);
for (const [k, v] of Object.entries(defaultConfig)) insertCfg.run(k, v);

// ── CONFIG HELPERS ────────────────────────────────────────────
const getCfg = (key) => { const r = db.prepare(`SELECT value FROM config WHERE key=?`).get(key); return r ? r.value : null; };
const setCfg = (key, value) => db.prepare(`INSERT OR REPLACE INTO config(key,value) VALUES(?,?)`).run(key, String(value));
const getAllCfg = () => {
  const cfg = {};
  db.prepare(`SELECT key,value FROM config`).all().forEach(r => cfg[r.key] = r.value);
  return cfg;
};

// ── JWT ───────────────────────────────────────────────────────
function signToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}
function verifyToken(token) {
  try {
    const [h, b, s] = (token||'').split('.');
    if (!h||!b||!s) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── PIN HASH ──────────────────────────────────────────────────
const hashPin = (pin) => crypto.createHash('sha256').update(pin + '_nm_salt_2024').digest('hex');
const checkPin = (pin, hash) => {
  try {
    const a = Buffer.from(hashPin(pin));
    const b = Buffer.from(hash);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
};

// ── USER HELPERS ──────────────────────────────────────────────
function getUserById(userId) {
  return db.prepare(`SELECT * FROM users WHERE userId=?`).get(userId);
}
function userToAppData(u) {
  if (!u) return null;
  let extra = {};
  try { extra = JSON.parse(u.extra || '{}'); } catch {}
  return {
    userId:               u.userId,
    paymentEmail:         u.paymentEmail || '',
    gmail:                u.paymentEmail || '',
    balance:              u.balance || 0,
    lockedBalance:        u.lockedBalance || 0,
    server_unlocked_balance: u.unlockedBalance || 0,
    totalWD:              u.totalWD || 0,
    serverVerified:       !!u.isVerified,
    isBanned:             !!u.isBanned,
    accountTier:          u.accountTier || 'trial',
    referralCode:         u.referralCode || u.userId,
    referredBy:           u.referredBy || '',
    referralCount:        u.referralCount || 0,
    validReferralCount:   u.validReferralCount || 0,
    upgradeDate:          u.upgradeDate || null,
    startDate:            u.createdAt || Date.now(),
    isLoggedIn:           true,
    rate:                 parseInt(getCfg('rate_idr') || '17000'),
    monthly:              extra.monthly || 0,
    history:              extra.history || [],
    lastBoostDate:        extra.lastBoostDate || null,
    checkInStreak:        extra.checkInStreak || 0,
    manualUnlocked:       extra.manualUnlocked || 0,
    private_message:      extra.private_message || null,
    bypassDailyWd:        extra.bypassDailyWd || false,
    bypassMinBal:         extra.bypassMinBal || false,
    minBalanceToWD:       extra.minBalanceToWD || 10,
    customSpeedMultiplier:extra.customSpeedMultiplier || 1.0,
    ...extra,
  };
}

function buildGlobalSettings() {
  const cfg = getAllCfg();
  const notifications = db.prepare(`SELECT id,title,message FROM notifications ORDER BY id DESC`).all();
  return {
    maintenance:     cfg.maintenance === '1',
    maintenanceMsg:  cfg.maintenanceMsg || '',
    announcement:    cfg.announcement || '',
    broadcast_active:cfg.broadcast_active === '1',
    broadcast_msg:   cfg.broadcast_msg || '',
    notifications,
    ref_cfg: {
      pct: {
        basic: parseInt(cfg.ref_pct_basic || '25'),
        pro:   parseInt(cfg.ref_pct_pro   || '50'),
        vip:   parseInt(cfg.ref_pct_vip   || '75'),
      },
      verif_base_rp: parseInt(cfg.verif_base_rp || '17000'),
      pkg_rp: { pro: 85000, vip: 170000 }
    }
  };
}

// ── ID GENERATOR ──────────────────────────────────────────────
function genId(prefix = 'USR-') {
  return prefix + crypto.randomBytes(3).toString('hex').toUpperCase();
}
function genTxId() {
  return 'TX' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
}
function genWdId() {
  return 'WD' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// ── EXPRESS ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ── HELMET ────────────────────────────────────────────────────
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

// ── RATE LIMITING ─────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs:60000, max:200, standardHeaders:true, legacyHeaders:false });
const apiLimiter     = rateLimit({ windowMs:60000, max:60,  standardHeaders:true, legacyHeaders:false });
const loginLimiter   = rateLimit({ windowMs:60000, max:10,  standardHeaders:true, legacyHeaders:false, message:{status:'error',message:'TOO_MANY_LOGIN_ATTEMPTS'} });
const adminLimiter   = rateLimit({ windowMs:60000, max:60,  standardHeaders:true, legacyHeaders:false });

app.use(generalLimiter);

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [`http://localhost:${PORT}`, DOMAIN].filter(Boolean);
  const origin  = req.headers.origin;
  if (!origin || allowed.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── BOT FILTER ────────────────────────────────────────────────
const botAgents = /HeadlessChrome|PhantomJS|Selenium|scrapy|curl\/|python-requests|Go-http-client/i;
app.use('/api', (req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  if (!ua || botAgents.test(ua)) return res.status(403).json({ status:'error', message:'BOT_DETECTED' });
  next();
});
app.use('/api', apiLimiter);

// ── SOCKET.IO ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin:'*', methods:['GET','POST'] },
  pingTimeout: 20000,
  pingInterval: 10000,
});

const onlineUsers  = new Map();
const adminSockets = new Set();

io.on('connection', (socket) => {
  socket.on('user:join', ({ userId }) => {
    if (!userId) return;
    onlineUsers.set(socket.id, { userId, since: new Date().toLocaleTimeString('id-ID') });
    db.prepare(`UPDATE users SET lastSeen=? WHERE userId=?`).run(Date.now(), userId);
    broadcastOnlineUsers();
  });
  socket.on('user:subscribe', ({ userId }) => {
    socket.join('user_' + userId);
  });
  socket.on('admin:join', ({ token }) => {
    const p = verifyToken(token);
    if (!p || p.role !== 'admin') { socket.disconnect(); return; }
    adminSockets.add(socket.id);
    socket.join('admins');
    broadcastStatsToAdmins();
    broadcastOnlineUsers();
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
function getStats() {
  return {
    totalUsers:      db.prepare(`SELECT COUNT(*) as n FROM users`).get().n,
    activeToday:     db.prepare(`SELECT COUNT(*) as n FROM users WHERE lastSeen > ?`).get(Date.now()-86400000).n,
    bannedUsers:     db.prepare(`SELECT COUNT(*) as n FROM users WHERE isBanned=1`).get().n,
    pendingPayments: db.prepare(`SELECT COUNT(*) as n FROM withdrawals WHERE status='pending'`).get().n,
    totalBalance:    db.prepare(`SELECT COALESCE(SUM(balance),0) as s FROM users WHERE isBanned=0`).get().s,
    totalRevenue:    0,
    totalWdToday:    db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM withdrawals WHERE status='approved' AND updatedAt > ?`).get(Date.now()-86400000).s,
    totalReferrals:  db.prepare(`SELECT COALESCE(SUM(referralCount),0) as s FROM users`).get().s,
  };
}
function broadcastStatsToAdmins() { io.to('admins').emit('admin:stats_update', getStats()); }
setInterval(broadcastStatsToAdmins, 30000);

// ══════════════════════════════════════════════════════════════
//  USER API  —  /api?action=...  atau POST /api
// ══════════════════════════════════════════════════════════════
app.all('/api', (req, res) => {
  const body   = req.body   || {};
  const query  = req.query  || {};
  const action = body.action || query.action || '';

  // ── load_data ──────────────────────────────────────────────
  if (action === 'load_data') {
    const userId = body.user_id || query.user_id || body.userId || '';
    const pin    = body.pin     || '';
    if (!userId) return res.json({ status:'error', message:'MISSING_USER_ID' });

    const user = getUserById(userId);
    if (!user) return res.json({ status:'error', message:'User not found' });
    if (user.isBanned) return res.json({ status:'error', message:'BANNED' });

    // PIN check hanya jika PIN dikirim (saat explicit login)
    if (pin && user.pinHash) {
      if (!checkPin(pin, user.pinHash)) {
        return res.json({ status:'wrong_pin', message:'PIN salah' });
      }
    }

    const appData = userToAppData(user);
    return res.json({
      status:          'success',
      appData,
      server_time:     Date.now(),
      global_settings: buildGlobalSettings(),
      require_pin_setup: !user.pinHash,
    });
  }

  // ── save_data ──────────────────────────────────────────────
  if (action === 'save_data') {
    const userId     = body.userId || '';
    const appData    = body.appData || {};
    const pinCode    = body.pinCode || '';
    const isRegister = !!body.isRegister;

    if (!userId) return res.json({ status:'error', message:'MISSING_USER_ID' });

    const existing = getUserById(userId);

    if (isRegister) {
      // Check gmail duplicate
      const email = (appData.paymentEmail || appData.gmail || '').toLowerCase().trim();
      if (email) {
        const emailExists = db.prepare(`SELECT userId FROM users WHERE paymentEmail=? AND userId!=?`).get(email, userId);
        if (emailExists) return res.json({ status:'error', message:'GMAIL_TAKEN', desc:'Gmail sudah digunakan akun lain.' });
      }
      // Check userId duplicate
      if (existing) {
        return res.json({ status:'error', message:'USER_ID_DUPLICATE' });
      }
      // Create new user
      const extra = buildExtra(appData);
      db.prepare(`INSERT INTO users (userId,paymentEmail,balance,lockedBalance,accountTier,referralCode,referredBy,extra,pinHash,createdAt)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        userId,
        email || null,
        parseFloat(appData.balance) || 0,
        parseFloat(appData.lockedBalance) || 0,
        'trial',
        userId,
        appData.referredBy || null,
        JSON.stringify(extra),
        pinCode ? hashPin(pinCode) : null,
        Date.now()
      );

      // Notify admin
      io.to('admins').emit('admin:new_user', { userId, email });
      broadcastStatsToAdmins();

      return res.json({ status:'success', userId, referralCount:0, validReferralCount:0 });
    }

    // Update existing user
    if (!existing) return res.json({ status:'error', message:'User not found' });
    if (existing.isBanned) return res.json({ status:'error', message:'BANNED' });

    const email = (appData.paymentEmail || appData.gmail || existing.paymentEmail || '').toLowerCase().trim();
    const extra = buildExtra(appData);
    const pinHash = pinCode ? hashPin(pinCode) : existing.pinHash;

    db.prepare(`UPDATE users SET
      paymentEmail=?, balance=?, lockedBalance=?, accountTier=?,
      upgradeDate=?, lastSeen=?, extra=?, pinHash=?
      WHERE userId=?`).run(
      email || null,
      parseFloat(appData.balance) || existing.balance,
      parseFloat(appData.lockedBalance) || existing.lockedBalance,
      appData.accountTier || existing.accountTier,
      appData.upgradeDate || existing.upgradeDate,
      Date.now(),
      JSON.stringify(extra),
      pinHash,
      userId
    );

    // Private message: kalau ada di appData (user acknowledge), hapus
    if (appData.private_message === null || appData.private_message === '') {
      const ex2 = JSON.parse(db.prepare(`SELECT extra FROM users WHERE userId=?`).get(userId)?.extra || '{}');
      delete ex2.private_message;
      db.prepare(`UPDATE users SET extra=? WHERE userId=?`).run(JSON.stringify(ex2), userId);
    }

    const updated = getUserById(userId);
    return res.json({
      status:              'success',
      referralCount:       updated.referralCount,
      validReferralCount:  updated.validReferralCount,
    });
  }

  // ── check_ref ──────────────────────────────────────────────
  if (action === 'check_ref') {
    const ref = (body.ref || query.ref || '').trim().toUpperCase();
    if (!ref) return res.json({ status:'error', message:'MISSING_REF' });
    const user = db.prepare(`SELECT userId FROM users WHERE referralCode=? OR userId=?`).get(ref, ref);
    if (!user) return res.json({ status:'error', message:'Kode undangan tidak terdaftar.' });
    return res.json({ status:'success' });
  }

  // ── add (klaim referral) ───────────────────────────────────
  if (action === 'add') {
    const ref     = (body.ref     || query.ref     || '').trim().toUpperCase();
    const newUser = (body.new_user|| query.new_user|| '').trim().toUpperCase();
    if (!ref || !newUser) return res.json({ status:'error', message:'MISSING_PARAMS' });

    const referer = db.prepare(`SELECT userId FROM users WHERE referralCode=? OR userId=?`).get(ref, ref);
    if (!referer) return res.json({ status:'error', message:'REF_NOT_FOUND' });

    const nu = getUserById(newUser);
    if (!nu) return res.json({ status:'error', message:'NEW_USER_NOT_FOUND' });
    if (nu.referredBy) return res.json({ status:'error', message:'ALREADY_REFERRED' });

    db.prepare(`UPDATE users SET referredBy=? WHERE userId=?`).run(referer.userId, newUser);
    db.prepare(`UPDATE users SET referralCount=referralCount+1 WHERE userId=?`).run(referer.userId);

    return res.json({ status:'success' });
  }

  // ── get (polling saldo user) ───────────────────────────────
  if (action === 'get') {
    const userId = body.user_id || query.user_id || body.userId || '';
    if (!userId) return res.json({ status:'error', message:'MISSING_USER_ID' });
    const user = getUserById(userId);
    if (!user) return res.json({ status:'error', message:'User not found' });
    if (user.isBanned) return res.json({ status:'error', message:'BANNED' });

    const appData = userToAppData(user);
    return res.json({
      status:          'success',
      appData,
      server_time:     Date.now(),
      global_settings: buildGlobalSettings(),
    });
  }

  // ── event_status ───────────────────────────────────────────
  if (action === 'event_status') {
    const userId = body.user_id || query.user_id || '';
    return res.json({ status:'success', event_active: false, user_points: 0, rank: 0, leaderboard: [] });
  }

  // ── claim_checkin ──────────────────────────────────────────
  if (action === 'claim_checkin') {
    const userId = body.userId || body.user_id || query.user_id || '';
    if (!userId) return res.json({ status:'error', message:'MISSING_USER_ID' });
    const user = getUserById(userId);
    if (!user) return res.json({ status:'error', message:'User not found' });

    let extra = {};
    try { extra = JSON.parse(user.extra || '{}'); } catch {}
    const today = new Date().toDateString();
    if (extra.lastBoostDate === today) return res.json({ status:'error', message:'ALREADY_CLAIMED_TODAY' });

    const streak   = (extra.checkInStreak || 0) + 1;
    const bonus    = streak >= 7 ? 0.5 : 0.05;
    extra.checkInStreak = streak % 7;
    extra.lastBoostDate = today;
    if (!extra.history) extra.history = [];
    const txId = genTxId();
    extra.history.unshift({ id: txId, type:'checkin', amount: bonus, desc:'Check-In Harian #'+streak, date: new Date().toISOString() });

    db.prepare(`UPDATE users SET balance=balance+?, extra=? WHERE userId=?`).run(bonus, JSON.stringify(extra), userId);
    io.to('user_' + userId).emit('balance:updated', { balance: (user.balance||0) + bonus });

    return res.json({ status:'success', bonus, streak });
  }

  // ── request_withdraw ───────────────────────────────────────
  if (action === 'request_withdraw') {
    const {
      userId, amount, provider='DANA', number, name, whatsapp, email
    } = body;

    if (!userId || !amount || !number || !name) {
      return res.json({ status:'error', message:'MISSING_FIELDS' });
    }

    const user = getUserById(userId);
    if (!user) return res.json({ status:'error', message:'User not found' });
    if (user.isBanned) return res.json({ status:'error', message:'BANNED' });
    if (!user.isVerified) return res.json({ status:'error', message:'NOT_VERIFIED' });

    const amt    = parseFloat(amount);
    const rate   = parseInt(getCfg('rate_idr') || '17000');
    const fee    = amt * 0.10;
    const net    = amt - fee;
    const netIdr = Math.floor(net * rate);
    const wdId   = genWdId();

    // Cek saldo siap tarik
    if ((user.unlockedBalance || 0) < amt) {
      return res.json({ status:'error', message:'INSUFFICIENT_UNLOCKED', desc:'Saldo Siap Tarik tidak cukup.' });
    }

    db.prepare(`INSERT INTO withdrawals(id,userId,amount,netAmount,netIdr,provider,number,name,whatsapp,status)
                VALUES(?,?,?,?,?,?,?,?,?,'pending')`).run(wdId, userId, amt, net, netIdr, provider, number, name, whatsapp||'');

    // Kurangi saldo & unlockedBalance
    db.prepare(`UPDATE users SET balance=balance-?, unlockedBalance=unlockedBalance-?, totalWD=totalWD+? WHERE userId=?`)
      .run(amt, amt, amt, userId);

    // Tambah ke history
    let extra = {};
    try { extra = JSON.parse(user.extra||'{}'); } catch {}
    if (!extra.history) extra.history = [];
    extra.history.unshift({
      id: wdId, type:'withdraw', amount: -amt, desc: `WD ke ${provider} ${number}`,
      date: new Date().toISOString(), status:'pending', ref: wdId,
      method: name, number, net, netIdr, fee
    });
    db.prepare(`UPDATE users SET extra=? WHERE userId=?`).run(JSON.stringify(extra), userId);

    // Notify admin real-time
    io.to('admins').emit('admin:withdrawal_request', { userId, amount: amt, wdId, provider, number, name });
    broadcastStatsToAdmins();

    const ref = wdId.slice(-8);
    return res.json({ status:'success', wdId, ref, net, netIdr, fee });
  }

  // ── submit_report ──────────────────────────────────────────
  if (action === 'submit_report') {
    const { userId='anon', category='', message='' } = body;
    db.prepare(`INSERT INTO admin_log(action,targetId,adminIp,detail) VALUES('user_report',?,?,?)`).run(userId, '', `${category}: ${message}`);
    io.to('admins').emit('admin:report', { userId, category, message });
    return res.json({ status:'success' });
  }

  // ── set_acquisition_source ─────────────────────────────────
  if (action === 'set_acquisition_source') {
    return res.json({ status:'success' });
  }

  // ── verify_upgrade (Lynk.id webhook / manual) ──────────────
  if (action === 'verify_upgrade') {
    const { email, tier='pro' } = body;
    if (!email) return res.json({ status:'error', message:'MISSING_EMAIL' });
    const user = db.prepare(`SELECT * FROM users WHERE paymentEmail=?`).get(email.toLowerCase().trim());
    if (!user) return res.json({ status:'error', message:'User not found' });
    db.prepare(`UPDATE users SET isVerified=1, accountTier=?, upgradeDate=? WHERE userId=?`).run(tier, Date.now(), user.userId);
    io.to('user_' + user.userId).emit('user:verified', { tier });
    return res.json({ status:'success' });
  }

  // Unknown action
  return res.json({ status:'error', message:'UNKNOWN_ACTION', action });
});

// Helper: ambil fields extra dari appData client
function buildExtra(appData) {
  const KEEP = ['monthly','history','lastBoostDate','checkInStreak','manualUnlocked',
    'bypassDailyWd','bypassMinBal','minBalanceToWD','customSpeedMultiplier',
    'miningTaskEndTime','missionClaimedDate','private_message',
    'wdRecipient','wdTelegram','hasEnteredRefCode','lastLimitResetDate',
    'dailyMined','lastMiningDay','missionPhase','lastSaveTime'];
  const extra = {};
  for (const k of KEEP) {
    if (appData[k] !== undefined) extra[k] = appData[k];
  }
  return extra;
}

// ══════════════════════════════════════════════════════════════
//  ADMIN API  —  /admin/api/...
// ══════════════════════════════════════════════════════════════
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ status:'error', message:'UNAUTHORIZED' });
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') return res.status(401).json({ status:'error', message:'UNAUTHORIZED' });
  req.admin = payload;
  next();
}
function logAdmin(action, targetId, ip, detail='') {
  db.prepare(`INSERT INTO admin_log(action,targetId,adminIp,detail) VALUES(?,?,?,?)`).run(action, targetId, ip, detail);
}

const adminRouter = express.Router();

// ── Admin Login ───────────────────────────────────────────────
adminRouter.post('/login', loginLimiter, (req, res) => {
  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string') return res.status(400).json({ status:'error', message:'INVALID_PIN' });
  const expected = Buffer.from(ADMIN_PIN);
  const received = Buffer.from(pin.substring(0, 64));
  const match = expected.length === received.length && crypto.timingSafeEqual(expected, received);
  if (!match) { logAdmin('login_fail','—',req.ip,'Wrong PIN'); return res.status(401).json({ status:'error', message:'WRONG_PIN' }); }
  const token = signToken({ role:'admin', iat:Date.now(), exp:Date.now()+8*3600*1000 });
  logAdmin('login_success','—',req.ip);
  res.json({ status:'ok', token });
});

// ── All protected routes ──────────────────────────────────────
adminRouter.use(adminAuth, adminLimiter);

// Stats
adminRouter.post('/stats', (_req, res) => res.json({ ...getStats(), status:'ok' }));

// Users list
adminRouter.post('/users', (req, res) => {
  const { filter='all', search='', page=1, limit=100 } = req.body || {};
  let q = `SELECT userId,paymentEmail,balance,unlockedBalance,totalWD,isVerified,isBanned,accountTier,referralCount,validReferralCount,createdAt,lastSeen FROM users`;
  const params = [];
  if (filter === 'banned')   q += ` WHERE isBanned=1`;
  else if (filter === 'active')    q += ` WHERE isBanned=0`;
  else if (filter === 'verified')  q += ` WHERE isVerified=1 AND isBanned=0`;
  else if (filter === 'trial')     q += ` WHERE accountTier='trial'`;
  if (search) {
    const cond = filter !== 'all' ? ' AND' : ' WHERE';
    q += `${cond} (userId LIKE ? OR paymentEmail LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  q += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, (page-1)*limit);
  res.json({ status:'ok', users: db.prepare(q).all(...params) });
});

// Withdrawals list
adminRouter.post('/withdrawals', (req, res) => {
  const { status='pending', page=1, limit=100 } = req.body || {};
  let q = `SELECT * FROM withdrawals`;
  const params = [];
  if (status !== 'all') { q += ` WHERE status=?`; params.push(status); }
  q += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, (page-1)*limit);
  res.json({ status:'ok', withdrawals: db.prepare(q).all(...params) });
});

// Process withdrawal (approve/reject)
adminRouter.post('/process_wd', (req, res) => {
  const { wdId, status, rejectReason='' } = req.body || {};
  if (!wdId || !status) return res.status(400).json({ status:'error', message:'MISSING_FIELDS' });
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ status:'error', message:'INVALID_STATUS' });

  const wd = db.prepare(`SELECT * FROM withdrawals WHERE id=?`).get(wdId);
  if (!wd) return res.status(404).json({ status:'error', message:'WD_NOT_FOUND' });

  db.prepare(`UPDATE withdrawals SET status=?,rejectReason=?,updatedAt=? WHERE id=?`).run(status, rejectReason, Date.now(), wdId);

  if (status === 'rejected') {
    // Kembalikan saldo ke user
    db.prepare(`UPDATE users SET balance=balance+?, unlockedBalance=unlockedBalance+?, totalWD=totalWD-? WHERE userId=?`)
      .run(wd.amount, wd.amount, wd.amount, wd.userId);
    io.to('user_' + wd.userId).emit('withdrawal:rejected', { wdId, rejectReason });
  } else {
    io.to('user_' + wd.userId).emit('withdrawal:approved', { wdId });
  }

  // Update history di user
  const user = getUserById(wd.userId);
  if (user) {
    let extra = {};
    try { extra = JSON.parse(user.extra||'{}'); } catch {}
    if (extra.history) {
      const idx = extra.history.findIndex(h => h.id === wdId);
      if (idx !== -1) {
        extra.history[idx].status = status === 'approved' ? 'success' : 'failed';
        if (status === 'rejected') extra.history[idx].rejectReason = rejectReason;
        db.prepare(`UPDATE users SET extra=? WHERE userId=?`).run(JSON.stringify(extra), wd.userId);
      }
    }
  }

  logAdmin('process_wd', wdId, req.ip, `status=${status}`);
  io.to('admins').emit('admin:wd_processed', { wdId, status, userId: wd.userId });
  broadcastStatsToAdmins();
  res.json({ status:'ok' });
});

// Ban/Unban user
adminRouter.post('/ban_user', (req, res) => {
  const { userId, ban, reason='' } = req.body || {};
  if (!userId) return res.status(400).json({ status:'error', message:'MISSING_USER_ID' });
  db.prepare(`UPDATE users SET isBanned=?,banReason=? WHERE userId=?`).run(ban?1:0, reason, userId);
  if (ban) { io.to('user_'+userId).emit('force:banned', { reason }); }
  else { io.to('user_'+userId).emit('force:unbanned'); }
  logAdmin(ban?'ban_user':'unban_user', userId, req.ip, reason);
  broadcastStatsToAdmins();
  res.json({ status:'ok' });
});

// Update balance
adminRouter.post('/update_balance', (req, res) => {
  const { userId, balance } = req.body || {};
  if (!userId || balance===undefined) return res.status(400).json({ status:'error', message:'MISSING_FIELDS' });
  const b = parseFloat(balance);
  if (isNaN(b)||b<0) return res.status(400).json({ status:'error', message:'INVALID_BALANCE' });
  db.prepare(`UPDATE users SET balance=? WHERE userId=?`).run(b, userId);
  io.to('user_'+userId).emit('balance:updated', { balance:b });
  logAdmin('update_balance', userId, req.ip, `balance=${b}`);
  res.json({ status:'ok' });
});

// Unlock balance (tambah unlockedBalance)
adminRouter.post('/unlock_balance', (req, res) => {
  const { userId, amount } = req.body || {};
  if (!userId || !amount) return res.status(400).json({ status:'error', message:'MISSING_FIELDS' });
  const amt = parseFloat(amount);
  if (isNaN(amt)||amt<=0) return res.status(400).json({ status:'error', message:'INVALID_AMOUNT' });
  db.prepare(`UPDATE users SET unlockedBalance=unlockedBalance+? WHERE userId=?`).run(amt, userId);
  io.to('user_'+userId).emit('balance:unlocked', { amount:amt });
  logAdmin('unlock_balance', userId, req.ip, `amount=${amt}`);
  res.json({ status:'ok' });
});

// Verify user
adminRouter.post('/verify_user', (req, res) => {
  const { userId, tier='basic', note='' } = req.body || {};
  if (!userId) return res.status(400).json({ status:'error', message:'MISSING_USER_ID' });
  db.prepare(`UPDATE users SET isVerified=1, accountTier=? WHERE userId=?`).run(tier, userId);
  io.to('user_'+userId).emit('user:verified', { tier });
  logAdmin('verify_user', userId, req.ip, `tier=${tier} ${note}`);
  res.json({ status:'ok' });
});

// Set tier
adminRouter.post('/set_tier', (req, res) => {
  const { userId, tier, serverVerified } = req.body || {};
  if (!userId || !tier) return res.status(400).json({ status:'error', message:'MISSING_FIELDS' });
  db.prepare(`UPDATE users SET accountTier=?,isVerified=?,upgradeDate=? WHERE userId=?`).run(tier, serverVerified?1:0, Date.now(), userId);
  io.to('user_'+userId).emit('tier:updated', { tier });
  logAdmin('set_tier', userId, req.ip, `tier=${tier}`);
  res.json({ status:'ok' });
});

// Reset PIN
adminRouter.post('/reset_pin', (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ status:'error', message:'MISSING_USER_ID' });
  db.prepare(`UPDATE users SET pinHash=NULL WHERE userId=?`).run(userId);
  io.to('user_'+userId).emit('pin:reset');
  logAdmin('reset_pin', userId, req.ip);
  res.json({ status:'ok' });
});

// Delete user
adminRouter.post('/delete_user', (req, res) => {
  const { userId, reason='' } = req.body || {};
  if (!userId) return res.status(400).json({ status:'error', message:'MISSING_USER_ID' });
  db.prepare(`DELETE FROM users WHERE userId=?`).run(userId);
  db.prepare(`DELETE FROM withdrawals WHERE userId=?`).run(userId);
  io.to('user_'+userId).emit('account:deleted');
  logAdmin('delete_user', userId, req.ip, reason);
  broadcastStatsToAdmins();
  res.json({ status:'ok' });
});

// Send private message
adminRouter.post('/send_private_msg', (req, res) => {
  const { userId, message } = req.body || {};
  if (!userId || !message) return res.status(400).json({ status:'error', message:'MISSING_FIELDS' });
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ status:'error', message:'USER_NOT_FOUND' });
  let extra = {};
  try { extra = JSON.parse(user.extra||'{}'); } catch {}
  extra.private_message = message;
  db.prepare(`UPDATE users SET extra=? WHERE userId=?`).run(JSON.stringify(extra), userId);
  io.to('user_'+userId).emit('private:message', { message });
  logAdmin('private_msg', userId, req.ip, message.substring(0,100));
  res.json({ status:'ok' });
});

// Broadcast
adminRouter.post('/broadcast', (req, res) => {
  const { message, type='info' } = req.body || {};
  if (!message) return res.status(400).json({ status:'error', message:'EMPTY_MESSAGE' });
  setCfg('broadcast_active', '1');
  setCfg('broadcast_msg', message);
  io.emit('system:broadcast', { message, type, time:Date.now() });
  logAdmin('broadcast','—',req.ip, `${type}: ${message.substring(0,100)}`);
  res.json({ status:'ok' });
});

// Clear broadcast
adminRouter.post('/clear_broadcast', (_req, res) => {
  setCfg('broadcast_active', '0');
  setCfg('broadcast_msg', '');
  res.json({ status:'ok' });
});

// Add notification
adminRouter.post('/add_notification', (req, res) => {
  const { title, message } = req.body || {};
  if (!title || !message) return res.status(400).json({ status:'error', message:'MISSING_FIELDS' });
  db.prepare(`INSERT INTO notifications(title,message) VALUES(?,?)`).run(title, message);
  io.emit('system:notification_update', buildGlobalSettings().notifications);
  res.json({ status:'ok' });
});

// Remove notification
adminRouter.post('/remove_notification', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ status:'error', message:'MISSING_ID' });
  db.prepare(`DELETE FROM notifications WHERE id=?`).run(id);
  res.json({ status:'ok' });
});

// Config get
adminRouter.post('/config', (_req, res) => {
  const cfg = getAllCfg();
  res.json({ status:'ok', ...cfg, maintenance: cfg.maintenance==='1' });
});

// Config save
adminRouter.post('/save_config', (req, res) => {
  const { miningRate, welcomeBonus, minWithdraw, rate_idr } = req.body || {};
  if (miningRate   !== undefined) setCfg('miningRate',  miningRate);
  if (welcomeBonus !== undefined) setCfg('welcomeBonus',welcomeBonus);
  if (minWithdraw  !== undefined) setCfg('minWithdraw', minWithdraw);
  if (rate_idr     !== undefined) setCfg('rate_idr',    rate_idr);
  logAdmin('save_config','—',req.ip, JSON.stringify({miningRate,welcomeBonus,minWithdraw,rate_idr}));
  io.emit('system:config_update', { miningRate, welcomeBonus, minWithdraw, rate_idr });
  res.json({ status:'ok' });
});

// Save ref config
adminRouter.post('/save_ref_config', (req, res) => {
  const { ref_cfg } = req.body || {};
  if (ref_cfg?.pct) {
    if (ref_cfg.pct.basic !== undefined) setCfg('ref_pct_basic', ref_cfg.pct.basic);
    if (ref_cfg.pct.pro   !== undefined) setCfg('ref_pct_pro',   ref_cfg.pct.pro);
    if (ref_cfg.pct.vip   !== undefined) setCfg('ref_pct_vip',   ref_cfg.pct.vip);
  }
  if (ref_cfg?.verif_base_rp !== undefined) setCfg('verif_base_rp', ref_cfg.verif_base_rp);
  io.emit('system:ref_cfg_update', buildGlobalSettings().ref_cfg);
  res.json({ status:'ok' });
});

// Maintenance
adminRouter.post('/maintenance', (req, res) => {
  const { enabled, message='' } = req.body || {};
  setCfg('maintenance',    enabled?'1':'0');
  setCfg('maintenanceMsg', message);
  io.emit('system:maintenance', { enabled, message });
  logAdmin('maintenance','—',req.ip, `enabled=${enabled}`);
  res.json({ status:'ok' });
});

// Announcement
adminRouter.post('/announcement', (req, res) => {
  const { text='' } = req.body || {};
  setCfg('announcement', text);
  io.emit('system:announcement', { text });
  logAdmin('announcement','—',req.ip, text.substring(0,100));
  res.json({ status:'ok' });
});

// Danger actions
adminRouter.post('/danger_action', (req, res) => {
  const { action } = req.body || {};
  if (action === 'reset_pending_payments') {
    db.prepare(`DELETE FROM withdrawals WHERE status='pending'`).run();
    logAdmin('danger_reset_pending','—',req.ip);
  } else if (action === 'clear_banned_users') {
    db.prepare(`DELETE FROM users WHERE isBanned=1`).run();
    logAdmin('danger_clear_banned','—',req.ip);
  } else {
    return res.status(400).json({ status:'error', message:'UNKNOWN_ACTION' });
  }
  broadcastStatsToAdmins();
  res.json({ status:'ok' });
});

app.use('/admin/api', adminRouter);

// ══════════════════════════════════════════════════════════════
//  STATIC FILES & ROUTES
// ══════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname), {
  index: false,
  etag:  true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
      res.setHeader('Pragma','no-cache');
      res.setHeader('Expires','0');
    }
  },
}));

app.get('/',              (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/app','/app/'], (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get(['/admin','/admin/'], (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/health', (_req, res) => res.json({ status:'ok', time:new Date().toISOString(), online:onlineUsers.size, users:db.prepare('SELECT COUNT(*) as n FROM users').get().n }));

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ status:'error', message:'INTERNAL_SERVER_ERROR' });
});

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`✅  NodeMaster running on http://localhost:${PORT}`);
  console.log(`    /         → index.html`);
  console.log(`    /app      → app.html`);
  console.log(`    /admin    → admin.html`);
  console.log(`    /api      → User API (semua actions)`);
  console.log(`    /admin/api → Admin API (JWT protected)`);
  console.log(`    /health   → Health check`);
  console.log(`    DB        → ${DB_PATH}`);
});
