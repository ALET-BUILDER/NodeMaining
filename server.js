const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static('.')); // Serve HTML, CSS, JS

// ============ DATABASE ============
const db = new Database('nodemaster.db');
const ADMIN_PIN_HASH = bcrypt.hashSync('043011', 10);

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
    account_tier TEXT DEFAULT 'trial'
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

// Insert default config if not exists
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

// ============ HELPER FUNCTIONS ============
function generateUserId() {
  return 'USR-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createUser(userId, pinHash, gmail, referredBy = null) {
  const stmt = db.prepare(`
    INSERT INTO users (user_id, pin_hash, gmail, referral_code, referred_by, is_verified, account_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(userId, pinHash, gmail, userId, referredBy, 0, 'trial');
  
  // Add welcome bonus to history
  const welcomeBonus = parseFloat(db.prepare(`SELECT value FROM system_config WHERE key = 'welcome_bonus'`).get()?.value || 5);
  if (welcomeBonus > 0) {
    db.prepare(`UPDATE users SET balance = balance + ? WHERE user_id = ?`).run(welcomeBonus, userId);
    db.prepare(`
      INSERT INTO transactions (user_id, amount, type, status, label, created_at)
      VALUES (?, ?, 'plus', 'success', 'Welcome Bonus', strftime('%s', 'now'))
    `).run(userId, welcomeBonus);
  }
  
  // Update referrer's valid count if referredBy exists
  if (referredBy) {
    db.prepare(`UPDATE users SET referral_count = referral_count + 1 WHERE user_id = ?`).run(referredBy);
  }
  
  return userId;
}

// ============ API ENDPOINTS ============

// Main API endpoint
app.post('/api', async (req, res) => {
  const { action, userId, pinCode, appData, isRegister, paymentId, status, amount, method, accountInfo, recipientName, email, telegram } = req.body;
  
  // LOAD DATA (Login)
  if (action === 'load_data') {
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) return res.json({ status: 'error', message: 'User not found' });
    if (user.is_banned) return res.json({ status: 'error', message: 'BANNED' });
    
    // Verify PIN
    const pinValid = bcrypt.compareSync(pinCode, user.pin_hash);
    if (!pinValid) return res.json({ status: 'error', message: 'wrong_pin' });
    
    // Get transactions
    const transactions = db.prepare(`
      SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(userId);
    
    // Calculate unlocked balance from referrals
    const referredUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE referred_by = ? AND is_verified = 1`).get(userId);
    const unlockedMultiplier = user.account_tier === 'vip' ? 0.75 : (user.account_tier === 'pro' ? 0.5 : 0.25);
    const unlockedBalance = (referredUsers.count * 17) * unlockedMultiplier; // Rp17k base
    
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
        validReferralCount: referredUsers.count,
        upgradeDate: user.upgrade_date,
        history: transactions,
        server_unlocked_balance: Math.min(unlockedBalance, user.balance),
        rate: 17000,
        isLoggedIn: true
      },
      require_pin_setup: false,
      global_settings: {
        maintenance: db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance'`).get()?.value === 'true',
        maintenance_msg: db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance_msg'`).get()?.value || '',
        broadcast_active: false,
        broadcast_msg: '',
        notifications: []
      }
    });
    return;
  }
  
  // SAVE DATA (Register or Update)
  if (action === 'save_data') {
    if (isRegister) {
      // Check if gmail already exists
      const existing = db.prepare(`SELECT user_id FROM users WHERE gmail = ?`).get(appData.paymentEmail);
      if (existing) {
        return res.json({ status: 'error', message: 'GMAIL_TAKEN', desc: 'Gmail sudah digunakan akun lain' });
      }
      
      const newUserId = generateUserId();
      const pinHash = bcrypt.hashSync(pinCode, 10);
      const referredBy = appData.referredBy || null;
      
      createUser(newUserId, pinHash, appData.paymentEmail, referredBy);
      
      // Emit to admin
      io.emit('admin:new_user', { userId: newUserId });
      
      res.json({
        status: 'success',
        userId: newUserId,
        appData: {
          userId: newUserId,
          balance: parseFloat(db.prepare(`SELECT value FROM system_config WHERE key = 'welcome_bonus'`).get()?.value || 5),
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
    
    // Update existing user data
    if (userId && appData) {
      db.prepare(`UPDATE users SET balance = ?, total_withdrawn = ?, monthly_earning = ?, account_tier = ?, upgrade_date = ? WHERE user_id = ?`)
        .run(appData.balance || 0, appData.totalWD || 0, appData.monthly || 0, appData.accountTier || 'trial', appData.upgradeDate || null, userId);
      
      // Update gmail if changed
      if (appData.paymentEmail) {
        db.prepare(`UPDATE users SET gmail = ? WHERE user_id = ?`).run(appData.paymentEmail, userId);
      }
      
      res.json({ status: 'success' });
      return;
    }
  }
  
  // REQUEST WITHDRAW
  if (action === 'request_withdraw') {
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) return res.json({ status: 'error', message: 'User not found' });
    if (user.balance < amount) return res.json({ status: 'error', message: 'Insufficient balance' });
    
    const fee = amount * 0.1;
    const netAmount = amount - fee;
    
    // Create withdrawal transaction (pending)
    const stmt = db.prepare(`
      INSERT INTO transactions (user_id, amount, type, status, label, method, created_at)
      VALUES (?, ?, 'minus', 'pending', 'Penarikan Uang', ?, strftime('%s', 'now'))
    `);
    stmt.run(userId, amount, `${method} | ${recipientName} | WA: ${telegram || email}`);
    
    // Deduct balance temporarily
    db.prepare(`UPDATE users SET balance = balance - ? WHERE user_id = ?`).run(amount, userId);
    
    // Emit to admin
    io.emit('admin:withdrawal_request', { userId, amount, netAmount });
    
    res.json({ status: 'success', message: 'Withdrawal request submitted' });
    return;
  }
  
  // CHECK-IN CLAIM
  if (action === 'claim_checkin') {
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) return res.json({ status: 'error', message: 'User not found' });
    
    const today = new Date().toDateString();
    const lastCheckin = user.last_checkin;
    
    if (lastCheckin === today) {
      return res.json({ status: 'already_claimed' });
    }
    
    let streak = user.checkin_streak || 0;
    if (lastCheckin === new Date(Date.now() - 86400000).toDateString()) {
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
    
    db.prepare(`
      INSERT INTO transactions (user_id, amount, type, status, label, created_at)
      VALUES (?, ?, 'plus', 'success', ?, strftime('%s', 'now'))
    `).run(userId, reward, isJackpot ? 'Jackpot Check-In (Hari 7)' : `Hadiah Check-In (Hari ${streak})`);
    
    res.json({
      status: 'success',
      newStreak: streak,
      reward: reward,
      isJackpot: isJackpot,
      newBalance: user.balance + reward
    });
    return;
  }
  
  // GET REFERRAL DATA
  if (action === 'get') {
    const referrals = db.prepare(`
      SELECT user_id as id, created_at as joined, is_verified as valid
      FROM users WHERE referred_by = ?
    `).all(userId);
    
    const validCount = referrals.filter(r => r.valid === 1).length;
    
    res.json({
      status: 'success',
      count: referrals.length,
      valid: validCount,
      list: referrals,
      commission_total: validCount * 3 // $3 per valid referral (Rp51k)
    });
    return;
  }
  
  // VERIFY UPGRADE PAYMENT
  if (action === 'verify_upgrade') {
    const { email, tier } = req.query;
    const payment = db.prepare(`
      SELECT * FROM payments WHERE email = ? AND package_name LIKE ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(email, `%${tier}%`);
    
    if (!payment) {
      return res.json({ status: 'error', message: 'PAYMENT_NOT_FOUND' });
    }
    
    // Check amount
    const requiredAmount = tier === 'VIP' ? 800000 : 160000;
    if (payment.amount < requiredAmount) {
      return res.json({ status: 'error', message: tier === 'VIP' ? 'INSUFFICIENT_FUNDS_VIP' : 'INSUFFICIENT_FUNDS_PRO' });
    }
    
    // Update payment status
    db.prepare(`UPDATE payments SET status = 'verified' WHERE id = ?`).run(payment.id);
    
    // Update user tier
    db.prepare(`UPDATE users SET account_tier = ?, upgrade_date = strftime('%s', 'now'), is_verified = 1 WHERE gmail = ?`)
      .run(tier.toLowerCase(), email);
    
    res.json({ status: 'success' });
    return;
  }
  
  res.json({ status: 'error', message: 'Unknown action' });
});

// ============ ADMIN API ============
app.post('/admin/api/login', async (req, res) => {
  const { pin } = req.body;
  const isValid = bcrypt.compareSync(pin, ADMIN_PIN_HASH) || pin === '043011';
  
  if (isValid) {
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + (8 * 3600);
    db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)`).run(token, expiresAt);
    res.json({ status: 'ok', token });
  } else {
    res.json({ status: 'error', message: 'Invalid PIN' });
  }
});

function verifyAdminToken(token) {
  const session = db.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > strftime('%s', 'now')`).get(token);
  return !!session;
}

app.post('/admin/api/stats', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users`).get().count;
  const activeToday = db.prepare(`SELECT COUNT(*) as count FROM users WHERE last_active > strftime('%s', 'now', '-1 day')`).get().count;
  const pendingPayments = db.prepare(`SELECT COUNT(*) as count FROM payments WHERE status = 'pending'`).get().count;
  const bannedUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`).get().count;
  const totalBalance = db.prepare(`SELECT SUM(balance) as sum FROM users WHERE is_banned = 0`).get().sum || 0;
  const totalWdToday = db.prepare(`
    SELECT SUM(amount) as sum FROM transactions 
    WHERE type = 'minus' AND status = 'success' AND created_at > strftime('%s', 'now', '-1 day')
  `).get().sum || 0;
  const totalRevenue = db.prepare(`SELECT SUM(amount) as sum FROM payments WHERE status = 'verified'`).get().sum || 0;
  const totalReferrals = db.prepare(`SELECT SUM(referral_count) as sum FROM users`).get().sum || 0;
  
  res.json({
    totalUsers, activeToday, pendingPayments, bannedUsers,
    totalBalance, totalWdToday, totalRevenue, totalReferrals
  });
});

app.post('/admin/api/users', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { filter } = req.body;
  let query = `SELECT * FROM users`;
  if (filter === 'banned') query += ` WHERE is_banned = 1`;
  else if (filter === 'verified') query += ` WHERE is_verified = 1`;
  else if (filter === 'active') query += ` WHERE is_banned = 0`;
  query += ` ORDER BY created_at DESC`;
  
  const users = db.prepare(query).all();
  res.json({ users });
});

app.post('/admin/api/payments', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { status } = req.body;
  let query = `SELECT * FROM payments`;
  if (status && status !== 'all') query += ` WHERE status = '${status}'`;
  query += ` ORDER BY created_at DESC`;
  
  const payments = db.prepare(query).all();
  res.json({ payments });
});

app.post('/admin/api/verify_payment', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  
  const { paymentId, status, userId } = req.body;
  db.prepare(`UPDATE payments SET status = ? WHERE id = ?`).run(status, paymentId);
  
  if (status === 'verified') {
    db.prepare(`UPDATE users SET is_verified = 1 WHERE user_id = ?`).run(userId);
    io.emit('payment:verified', { userId });
  }
  
  res.json({ status: 'ok' });
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
  
  socket.on('admin:force_ban', ({ userId }) => {
    io.to(`user_${userId}`).emit('force:banned');
  });
  
  socket.on('admin:payment_action', ({ paymentId, status, userId }) => {
    io.to(`user_${userId}`).emit('payment:updated', { status });
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
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📱 App: http://localhost:${PORT}/app.html`);
  console.log(`👑 Admin: http://localhost:${PORT}/admin.html`);
});