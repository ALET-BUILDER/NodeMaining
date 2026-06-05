const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static('.'));

// ============ DATABASE ============
const db = new Database('nodemaster.db');

// Create tables
db.exec(`
  PRAGMA journal_mode = WAL;
  
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    gmail TEXT UNIQUE,
    balance REAL DEFAULT 0,
    total_withdrawn REAL DEFAULT 0,
    monthly_earning REAL DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    referral_code TEXT,
    referred_by TEXT,
    referral_count INTEGER DEFAULT 0,
    valid_referral_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_active INTEGER DEFAULT (strftime('%s', 'now')),
    upgrade_date INTEGER,
    account_tier TEXT DEFAULT 'trial',
    checkin_streak INTEGER DEFAULT 0,
    last_checkin TEXT
  );
  
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    amount REAL,
    type TEXT,
    status TEXT,
    label TEXT,
    method TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    amount REAL,
    package_name TEXT,
    email TEXT,
    status TEXT DEFAULT 'pending',
    proof_url TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Insert default config
const defaultConfig = {
  mining_rate: '0.005',
  welcome_bonus: '5',
  min_withdraw: '10',
  maintenance: 'false',
  maintenance_msg: '',
  announcement: ''
};
for (const [key, val] of Object.entries(defaultConfig)) {
  db.prepare(`INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)`).run(key, val);
}

// Create test user if not exists (for testing)
const testUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-TEST001');
if (!testUser) {
  const testPinHash = bcrypt.hashSync('123456', 10);
  db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, account_tier, balance) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('USR-TEST001', testPinHash, 'test@gmail.com', 1, 'basic', 25.50);
  console.log('✅ Test user created: USR-TEST001 / PIN: 123456');
}

const ADMIN_PIN_HASH = bcrypt.hashSync('043011', 10);

// ============ HELPER ============
function generateUserId() {
  return 'USR-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ============ API ENDPOINTS ============
app.post('/api', async (req, res) => {
  const { action, userId, pinCode, appData, isRegister } = req.body;
  
  // LOGIN - Load Data
  if (action === 'load_data') {
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) return res.json({ status: 'error', message: 'User not found' });
    if (user.is_banned) return res.json({ status: 'error', message: 'BANNED' });
    
    const pinValid = bcrypt.compareSync(pinCode, user.pin_hash);
    if (!pinValid) return res.json({ status: 'error', message: 'wrong_pin' });
    
    // Update last active
    db.prepare(`UPDATE users SET last_active = strftime('%s', 'now') WHERE user_id = ?`).run(userId);
    
    const transactions = db.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(userId);
    const referredCount = db.prepare(`SELECT COUNT(*) as count FROM users WHERE referred_by = ? AND is_verified = 1`).get(userId).count;
    
    res.json({
      status: 'success',
      server_time: Date.now(),
      appData: {
        userId: user.user_id,
        balance: user.balance,
        totalWD: user.total_withdrawn,
        monthly: user.monthly_earning,
        serverVerified: user.is_verified === 1,
        accountTier: user.account_tier,
        paymentEmail: user.gmail,
        referralCount: user.referral_count,
        validReferralCount: referredCount,
        upgradeDate: user.upgrade_date,
        history: transactions,
        server_unlocked_balance: Math.min(user.balance, user.balance),
        rate: 17000,
        isLoggedIn: true
      },
      global_settings: {
        maintenance: db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance'`).get()?.value === 'true',
        maintenance_msg: db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance_msg'`).get()?.value || '',
        announcement: db.prepare(`SELECT value FROM system_config WHERE key = 'announcement'`).get()?.value || '',
        broadcast_active: false,
        broadcast_msg: '',
        notifications: []
      }
    });
    return;
  }
  
  // REGISTER - Save Data
  if (action === 'save_data' && isRegister) {
    const existingGmail = db.prepare(`SELECT user_id FROM users WHERE gmail = ?`).get(appData.paymentEmail);
    if (existingGmail) {
      return res.json({ status: 'error', message: 'GMAIL_TAKEN', desc: 'Gmail sudah digunakan' });
    }
    
    const newUserId = generateUserId();
    const pinHash = bcrypt.hashSync(pinCode, 10);
    const referredBy = appData.referredBy || null;
    const welcomeBonus = parseFloat(db.prepare(`SELECT value FROM system_config WHERE key = 'welcome_bonus'`).get()?.value || 5);
    
    db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, referral_code, referred_by, balance) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newUserId, pinHash, appData.paymentEmail, newUserId, referredBy, welcomeBonus);
    
    db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) VALUES (?, ?, 'plus', 'success', 'Welcome Bonus', strftime('%s', 'now'))`)
      .run(newUserId, welcomeBonus);
    
    if (referredBy) {
      db.prepare(`UPDATE users SET referral_count = referral_count + 1 WHERE user_id = ?`).run(referredBy);
    }
    
    io.emit('admin:new_user', { userId: newUserId });
    
    res.json({
      status: 'success',
      userId: newUserId,
      appData: {
        userId: newUserId,
        balance: welcomeBonus,
        totalWD: 0,
        monthly: 0,
        serverVerified: false,
        accountTier: 'trial',
        paymentEmail: appData.paymentEmail,
        referralCount: 0,
        validReferralCount: 0,
        history: [],
        rate: 17000,
        isLoggedIn: true
      }
    });
    return;
  }
  
  // UPDATE existing user
  if (action === 'save_data' && userId && appData) {
    db.prepare(`UPDATE users SET balance = ?, total_withdrawn = ?, monthly_earning = ?, account_tier = ?, upgrade_date = ? WHERE user_id = ?`)
      .run(appData.balance || 0, appData.totalWD || 0, appData.monthly || 0, appData.account_tier || 'trial', appData.upgradeDate || null, userId);
    
    if (appData.paymentEmail) {
      db.prepare(`UPDATE users SET gmail = ? WHERE user_id = ?`).run(appData.paymentEmail, userId);
    }
    
    res.json({ status: 'success' });
    return;
  }
  
  // CHECK-IN
  if (action === 'claim_checkin') {
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) return res.json({ status: 'error', message: 'User not found' });
    
    const today = new Date().toDateString();
    if (user.last_checkin === today) {
      return res.json({ status: 'already_claimed' });
    }
    
    let streak = user.checkin_streak || 0;
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (user.last_checkin === yesterday) {
      streak++;
    } else {
      streak = 1;
    }
    if (streak > 7) streak = 7;
    
    const rewards = [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0];
    const reward = rewards[streak - 1];
    const isJackpot = streak === 7;
    
    db.prepare(`UPDATE users SET balance = balance + ?, checkin_streak = ?, last_checkin = ? WHERE user_id = ?`)
      .run(reward, streak, today, userId);
    
    db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) VALUES (?, ?, 'plus', 'success', ?, strftime('%s', 'now'))`)
      .run(userId, reward, isJackpot ? 'Jackpot Check-In (Hari 7)' : `Hadiah Check-In (Hari ${streak})`);
    
    res.json({ status: 'success', newStreak: streak, reward: reward, isJackpot: isJackpot, newBalance: user.balance + reward });
    return;
  }
  
  // GET REFERRALS
  if (action === 'get') {
    const referrals = db.prepare(`SELECT user_id as id, created_at as joined, is_verified as valid FROM users WHERE referred_by = ?`).all(userId);
    const validCount = referrals.filter(r => r.valid === 1).length;
    res.json({ status: 'success', count: referrals.length, valid: validCount, list: referrals, commission_total: validCount * 3 });
    return;
  }
  
  res.json({ status: 'error', message: 'Unknown action' });
});

// ============ ADMIN API ============
app.post('/admin/api/login', (req, res) => {
  const { pin } = req.body;
  const isValid = bcrypt.compareSync(pin, ADMIN_PIN_HASH) || pin === '043011';
  
  if (isValid) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + (8 * 3600);
    db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)`).run(token, expiresAt);
    res.json({ status: 'ok', token });
  } else {
    res.json({ status: 'error', message: 'Invalid PIN' });
  }
});

function verifyAdminToken(token) {
  if (!token) return false;
  const session = db.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > strftime('%s', 'now')`).get(token);
  return !!session;
}

app.post('/admin/api/stats', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  res.json({
    totalUsers: db.prepare(`SELECT COUNT(*) as count FROM users`).get().count,
    activeToday: db.prepare(`SELECT COUNT(*) as count FROM users WHERE last_active > strftime('%s', 'now', '-1 day')`).get().count,
    pendingPayments: db.prepare(`SELECT COUNT(*) as count FROM payments WHERE status = 'pending'`).get().count,
    bannedUsers: db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`).get().count,
    totalBalance: db.prepare(`SELECT SUM(balance) as sum FROM users WHERE is_banned = 0`).get().sum || 0,
    totalWdToday: db.prepare(`SELECT SUM(amount) as sum FROM transactions WHERE type = 'minus' AND status = 'success' AND created_at > strftime('%s', 'now', '-1 day')`).get().sum || 0,
    totalRevenue: db.prepare(`SELECT SUM(amount) as sum FROM payments WHERE status = 'verified'`).get().sum || 0,
    totalReferrals: db.prepare(`SELECT SUM(referral_count) as sum FROM users`).get().sum || 0
  });
});

app.post('/admin/api/users', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { filter } = req.body;
  let query = `SELECT user_id, gmail, balance, is_verified, is_banned, referral_count, created_at FROM users`;
  if (filter === 'banned') query += ` WHERE is_banned = 1`;
  else if (filter === 'verified') query += ` WHERE is_verified = 1`;
  query += ` ORDER BY created_at DESC`;
  
  res.json({ users: db.prepare(query).all() });
});

app.post('/admin/api/payments', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { status } = req.body;
  let query = `SELECT * FROM payments`;
  if (status && status !== 'all') query += ` WHERE status = '${status}'`;
  query += ` ORDER BY created_at DESC`;
  
  res.json({ payments: db.prepare(query).all() });
});

app.post('/admin/api/ban_user', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { userId, ban } = req.body;
  db.prepare(`UPDATE users SET is_banned = ? WHERE user_id = ?`).run(ban ? 1 : 0, userId);
  io.emit('admin:user_banned', { userId, banned: ban });
  if (ban) io.to(`user_${userId}`).emit('force:banned');
  else io.to(`user_${userId}`).emit('force:unbanned');
  res.json({ status: 'ok' });
});

app.post('/admin/api/update_balance', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { userId, balance } = req.body;
  db.prepare(`UPDATE users SET balance = ? WHERE user_id = ?`).run(balance, userId);
  io.to(`user_${userId}`).emit('balance:updated', { balance });
  res.json({ status: 'ok' });
});

app.post('/admin/api/verify_user', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { userId } = req.body;
  db.prepare(`UPDATE users SET is_verified = 1 WHERE user_id = ?`).run(userId);
  io.to(`user_${userId}`).emit('user:verified');
  res.json({ status: 'ok' });
});

app.post('/admin/api/reset_pin', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { userId } = req.body;
  const newPin = Math.floor(100000 + Math.random() * 900000).toString();
  const newPinHash = bcrypt.hashSync(newPin, 10);
  db.prepare(`UPDATE users SET pin_hash = ? WHERE user_id = ?`).run(newPinHash, userId);
  io.to(`user_${userId}`).emit('pin:reset');
  res.json({ status: 'ok', newPin });
});

app.post('/admin/api/delete_user', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { userId } = req.body;
  db.prepare(`DELETE FROM transactions WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM users WHERE user_id = ?`).run(userId);
  io.emit('account:deleted', { userId });
  res.json({ status: 'ok' });
});

app.post('/admin/api/broadcast', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { message, type } = req.body;
  io.emit('system:broadcast', { message, type });
  res.json({ status: 'ok' });
});

app.post('/admin/api/maintenance', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { enabled, message } = req.body;
  db.prepare(`UPDATE system_config SET value = ? WHERE key = 'maintenance'`).run(enabled ? 'true' : 'false');
  db.prepare(`UPDATE system_config SET value = ? WHERE key = 'maintenance_msg'`).run(message || '');
  io.emit('system:maintenance', { enabled, message });
  res.json({ status: 'ok' });
});

app.post('/admin/api/announcement', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { text } = req.body;
  db.prepare(`UPDATE system_config SET value = ? WHERE key = 'announcement'`).run(text || '');
  io.emit('system:announcement', { text });
  res.json({ status: 'ok' });
});

app.post('/admin/api/save_config', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { miningRate, welcomeBonus, minWithdraw } = req.body;
  if (miningRate) db.prepare(`UPDATE system_config SET value = ? WHERE key = 'mining_rate'`).run(miningRate.toString());
  if (welcomeBonus) db.prepare(`UPDATE system_config SET value = ? WHERE key = 'welcome_bonus'`).run(welcomeBonus.toString());
  if (minWithdraw) db.prepare(`UPDATE system_config SET value = ? WHERE key = 'min_withdraw'`).run(minWithdraw.toString());
  
  res.json({ status: 'ok' });
});

app.post('/admin/api/config', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  res.json({
    miningRate: parseFloat(db.prepare(`SELECT value FROM system_config WHERE key = 'mining_rate'`).get()?.value || 0.005),
    welcomeBonus: parseFloat(db.prepare(`SELECT value FROM system_config WHERE key = 'welcome_bonus'`).get()?.value || 5),
    minWithdraw: parseFloat(db.prepare(`SELECT value FROM system_config WHERE key = 'min_withdraw'`).get()?.value || 10),
    maintenance: db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance'`).get()?.value === 'true',
    maintenanceMsg: db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance_msg'`).get()?.value || '',
    announcement: db.prepare(`SELECT value FROM system_config WHERE key = 'announcement'`).get()?.value || ''
  });
});

app.post('/admin/api/danger_action', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { action } = req.body;
  if (action === 'reset_pending_payments') {
    db.prepare(`DELETE FROM payments WHERE status = 'pending'`).run();
  } else if (action === 'clear_banned_users') {
    const bannedUsers = db.prepare(`SELECT user_id FROM users WHERE is_banned = 1`).all();
    for (const u of bannedUsers) {
      db.prepare(`DELETE FROM transactions WHERE user_id = ?`).run(u.user_id);
      db.prepare(`DELETE FROM users WHERE user_id = ?`).run(u.user_id);
    }
  }
  res.json({ status: 'ok' });
});

// ============ SOCKET.IO ============
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token && verifyAdminToken(token)) {
    socket.isAdmin = true;
  }
  next();
});

io.on('connection', (socket) => {
  socket.on('user:join', ({ userId }) => {
    if (userId) {
      socket.join(`user_${userId}`);
      onlineUsers.set(userId, { socketId: socket.id, joinedAt: Date.now() });
      io.emit('admin:online_users', {
        users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
        count: onlineUsers.size
      });
    }
  });
  
  socket.on('admin:join', ({ token }) => {
    if (verifyAdminToken(token)) {
      socket.join('admin_room');
      socket.isAdmin = true;
    }
  });
  
  socket.on('disconnect', () => {
    for (const [userId, data] of onlineUsers.entries()) {
      if (data.socketId === socket.id) {
        onlineUsers.delete(userId);
        break;
      }
    }
    io.emit('admin:online_users', {
      users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
      count: onlineUsers.size
    });
  });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ SERBER BERJALAN!`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📱 App: http://localhost:${PORT}/app.html`);
  console.log(`👑 Admin: http://localhost:${PORT}/admin.html`);
  console.log(`\n🔐 PIN Admin: 043011`);
  console.log(`🧪 Test User: USR-TEST001 / PIN: 123456\n`);
});