const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ============ DATABASE ============
let db;
try {
  db = new Database('nodemaster.db');
  console.log('✅ Database connected');
} catch (err) {
  console.error('❌ Database error:', err.message);
  process.exit(1);
}

// Create tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      gmail TEXT,
      balance REAL DEFAULT 0,
      total_withdrawn REAL DEFAULT 0,
      monthly_earning REAL DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      account_tier TEXT DEFAULT 'trial',
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      last_active INTEGER DEFAULT (strftime('%s', 'now'))
    );
    
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount REAL,
      type TEXT,
      status TEXT,
      label TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER
    );
  `);
  console.log('✅ Tables ready');
} catch (err) {
  console.error('❌ Table creation error:', err.message);
}

// Insert default config
const defaultConfigs = [
  ['maintenance', 'false'],
  ['maintenance_msg', ''],
  ['mining_rate', '0.005'],
  ['welcome_bonus', '5'],
  ['min_withdraw', '10']
];
for (const [key, val] of defaultConfigs) {
  try {
    db.prepare(`INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)`).run(key, val);
  } catch (err) {}
}

// Create test user if not exists
try {
  const testUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-TEST001');
  if (!testUser) {
    const hash = bcrypt.hashSync('123456', 10);
    db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance) VALUES (?, ?, ?, ?, ?)`)
      .run('USR-TEST001', hash, 'test@gmail.com', 1, 25.50);
    console.log('✅ Test user created: USR-TEST001 / PIN: 123456');
  }
} catch (err) {
  console.log('⚠️ Test user creation skipped');
}

const ADMIN_PIN_HASH = bcrypt.hashSync('043011', 10);

// ============ ONLINE USERS (REAL-TIME) ============
const onlineUsers = new Map();

// ============ API FOR APP ============
app.post('/api', (req, res) => {
  console.log('📡 API called:', req.body.action);
  
  const { action, userId, pinCode, appData, isRegister } = req.body;
  
  // LOAD DATA / LOGIN
  if (action === 'load_data') {
    try {
      const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
      if (!user) {
        return res.json({ status: 'error', message: 'User not found' });
      }
      if (user.is_banned) {
        return res.json({ status: 'error', message: 'BANNED' });
      }
      
      const pinValid = bcrypt.compareSync(pinCode, user.pin_hash);
      if (!pinValid) {
        return res.json({ status: 'error', message: 'wrong_pin' });
      }
      
      // Update last active
      db.prepare(`UPDATE users SET last_active = strftime('%s', 'now') WHERE user_id = ?`).run(userId);
      
      // Get transactions
      const transactions = db.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).all(userId);
      
      // Get maintenance status
      const maintenance = db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance'`).get();
      const maintenanceMsg = db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance_msg'`).get();
      
      return res.json({
        status: 'success',
        server_time: Date.now(),
        appData: {
          userId: user.user_id,
          balance: user.balance,
          totalWD: user.total_withdrawn,
          monthly: user.monthly_earning,
          serverVerified: user.is_verified === 1,
          accountTier: user.account_tier,
          paymentEmail: user.gmail || '',
          referralCount: 0,
          validReferralCount: 0,
          history: transactions || [],
          rate: 17000,
          isLoggedIn: true
        },
        global_settings: {
          maintenance: maintenance?.value === 'true',
          maintenance_msg: maintenanceMsg?.value || '',
          broadcast_active: false,
          broadcast_msg: '',
          notifications: []
        }
      });
    } catch (err) {
      console.error('Load data error:', err);
      return res.json({ status: 'error', message: 'Server error' });
    }
  }
  
  // REGISTER
  if (action === 'save_data' && isRegister === true) {
    try {
      const existingGmail = db.prepare(`SELECT user_id FROM users WHERE gmail = ?`).get(appData?.paymentEmail);
      if (existingGmail) {
        return res.json({ status: 'error', message: 'GMAIL_TAKEN' });
      }
      
      const newUserId = 'USR-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const pinHash = bcrypt.hashSync(pinCode, 10);
      const welcomeBonus = 5;
      
      db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, balance) VALUES (?, ?, ?, ?)`)
        .run(newUserId, pinHash, appData.paymentEmail, welcomeBonus);
      
      db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) VALUES (?, ?, 'plus', 'success', 'Welcome Bonus', strftime('%s', 'now'))`)
        .run(newUserId, welcomeBonus);
      
      // REAL-TIME: Notify admin about new user
      io.emit('admin:new_user', { userId: newUserId, email: appData.paymentEmail });
      
      return res.json({
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
          history: [],
          rate: 17000,
          isLoggedIn: true
        }
      });
    } catch (err) {
      console.error('Register error:', err);
      return res.json({ status: 'error', message: 'Registration failed' });
    }
  }
  
  // UPDATE USER DATA
  if (action === 'save_data' && userId && appData && !isRegister) {
    try {
      db.prepare(`UPDATE users SET balance = ?, total_withdrawn = ?, monthly_earning = ?, account_tier = ? WHERE user_id = ?`)
        .run(appData.balance || 0, appData.totalWD || 0, appData.monthly || 0, appData.account_tier || 'trial', userId);
      
      if (appData.paymentEmail) {
        db.prepare(`UPDATE users SET gmail = ? WHERE user_id = ?`).run(appData.paymentEmail, userId);
      }
      
      return res.json({ status: 'success' });
    } catch (err) {
      return res.json({ status: 'error', message: 'Update failed' });
    }
  }
  
  // CHECK-IN CLAIM
  if (action === 'claim_checkin') {
    try {
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
      
      // REAL-TIME: Update balance to user
      io.to(`user_${userId}`).emit('balance:updated', { balance: user.balance + reward });
      
      return res.json({
        status: 'success',
        newStreak: streak,
        reward: reward,
        isJackpot: isJackpot,
        newBalance: user.balance + reward
      });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // GET REFERRALS
  if (action === 'get') {
    try {
      const referrals = db.prepare(`SELECT user_id as id, created_at as joined, is_verified as valid FROM users WHERE referred_by = ?`).all(userId);
      const validCount = referrals.filter(r => r.valid === 1).length;
      return res.json({
        status: 'success',
        count: referrals.length,
        valid: validCount,
        list: referrals,
        commission_total: validCount * 3
      });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // REQUEST WITHDRAW
  if (action === 'request_withdraw') {
    try {
      const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
      if (!user) return res.json({ status: 'error', message: 'User not found' });
      if (user.balance < amount) return res.json({ status: 'error', message: 'Insufficient balance' });
      
      const fee = amount * 0.1;
      const netAmount = amount - fee;
      
      db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, method, created_at) VALUES (?, ?, 'minus', 'pending', 'Penarikan Uang', ?, strftime('%s', 'now'))`)
        .run(userId, amount, `${method} | ${recipientName}`);
      
      db.prepare(`UPDATE users SET balance = balance - ? WHERE user_id = ?`).run(amount, userId);
      
      // REAL-TIME: Notify admin about withdrawal request
      io.emit('admin:withdrawal_request', { userId, amount, netAmount });
      
      return res.json({ status: 'success', message: 'Withdrawal request submitted' });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  return res.json({ status: 'error', message: 'Unknown action: ' + action });
});

// ============ ADMIN API ============

// Middleware for admin
function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const session = db.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > strftime('%s', 'now')`).get(token);
    return !!session;
  } catch (err) {
    return false;
  }
}

// Admin login
app.post('/admin/api/login', (req, res) => {
  const { pin } = req.body;
  const isValid = bcrypt.compareSync(pin, ADMIN_PIN_HASH) || pin === '043011';
  
  if (isValid) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + (8 * 3600);
    try {
      db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)`).run(token, expiresAt);
    } catch (err) {}
    return res.json({ status: 'ok', token });
  }
  return res.json({ status: 'error', message: 'Invalid PIN' });
});

// Get all users
app.post('/admin/api/users', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT user_id, gmail, balance, is_verified, is_banned, account_tier, created_at 
      FROM users ORDER BY created_at DESC
    `).all();
    return res.json({ users });
  } catch (err) {
    return res.json({ users: [] });
  }
});

// Get stats (REAL-TIME via polling juga)
app.post('/admin/api/stats', (req, res) => {
  try {
    const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users`).get();
    const bannedUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`).get();
    const totalBalance = db.prepare(`SELECT SUM(balance) as sum FROM users WHERE is_banned = 0`).get();
    const onlineCount = onlineUsers.size;
    
    return res.json({
      totalUsers: totalUsers?.count || 0,
      activeToday: onlineCount,
      pendingPayments: 0,
      bannedUsers: bannedUsers?.count || 0,
      totalBalance: totalBalance?.sum || 0,
      totalWdToday: 0,
      totalRevenue: 0,
      totalReferrals: 0
    });
  } catch (err) {
    return res.json({
      totalUsers: 0, activeToday: 0, pendingPayments: 0, bannedUsers: 0,
      totalBalance: 0, totalWdToday: 0, totalRevenue: 0, totalReferrals: 0
    });
  }
});

// Ban/Unban user (REAL-TIME)
app.post('/admin/api/ban_user', (req, res) => {
  const { userId, ban } = req.body;
  try {
    db.prepare(`UPDATE users SET is_banned = ? WHERE user_id = ?`).run(ban ? 1 : 0, userId);
    // REAL-TIME: Notify user
    io.to(`user_${userId}`).emit('force:banned', { banned: ban });
    io.emit('admin:user_banned', { userId, banned: ban });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Update balance (REAL-TIME)
app.post('/admin/api/update_balance', (req, res) => {
  const { userId, balance } = req.body;
  try {
    db.prepare(`UPDATE users SET balance = ? WHERE user_id = ?`).run(balance, userId);
    // REAL-TIME: Update user's balance instantly
    io.to(`user_${userId}`).emit('balance:updated', { balance });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Verify user (REAL-TIME)
app.post('/admin/api/verify_user', (req, res) => {
  const { userId } = req.body;
  try {
    db.prepare(`UPDATE users SET is_verified = 1 WHERE user_id = ?`).run(userId);
    // REAL-TIME: Notify user
    io.to(`user_${userId}`).emit('user:verified', { userId });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Reset PIN (REAL-TIME)
app.post('/admin/api/reset_pin', (req, res) => {
  const { userId } = req.body;
  try {
    const newPin = Math.floor(100000 + Math.random() * 900000).toString();
    const newHash = bcrypt.hashSync(newPin, 10);
    db.prepare(`UPDATE users SET pin_hash = ? WHERE user_id = ?`).run(newHash, userId);
    // REAL-TIME: Notify user
    io.to(`user_${userId}`).emit('pin:reset', { newPin });
    return res.json({ status: 'ok', newPin });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Delete user (REAL-TIME)
app.post('/admin/api/delete_user', (req, res) => {
  const { userId } = req.body;
  try {
    db.prepare(`DELETE FROM transactions WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM users WHERE user_id = ?`).run(userId);
    // REAL-TIME: Force logout user
    io.to(`user_${userId}`).emit('account:deleted');
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Broadcast (REAL-TIME ke SEMUA user)
app.post('/admin/api/broadcast', (req, res) => {
  const { message, type } = req.body;
  // REAL-TIME: Send to ALL connected users
  io.emit('system:broadcast', { message, type, timestamp: Date.now() });
  console.log(`📢 Broadcast sent: ${message}`);
  return res.json({ status: 'ok' });
});

// Maintenance mode (REAL-TIME)
app.post('/admin/api/maintenance', (req, res) => {
  const { enabled, message } = req.body;
  try {
    db.prepare(`UPDATE system_config SET value = ? WHERE key = 'maintenance'`).run(enabled ? 'true' : 'false');
    db.prepare(`UPDATE system_config SET value = ? WHERE key = 'maintenance_msg'`).run(message || '');
    // REAL-TIME: Notify all users
    io.emit('system:maintenance', { enabled, message });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Announcement (REAL-TIME)
app.post('/admin/api/announcement', (req, res) => {
  const { text } = req.body;
  // REAL-TIME: Send to ALL users
  io.emit('system:announcement', { text, timestamp: Date.now() });
  return res.json({ status: 'ok' });
});

// Get config
app.post('/admin/api/config', (req, res) => {
  try {
    const maintenance = db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance'`).get();
    const maintenanceMsg = db.prepare(`SELECT value FROM system_config WHERE key = 'maintenance_msg'`).get();
    const miningRate = db.prepare(`SELECT value FROM system_config WHERE key = 'mining_rate'`).get();
    const welcomeBonus = db.prepare(`SELECT value FROM system_config WHERE key = 'welcome_bonus'`).get();
    const minWithdraw = db.prepare(`SELECT value FROM system_config WHERE key = 'min_withdraw'`).get();
    
    return res.json({
      miningRate: parseFloat(miningRate?.value || 0.005),
      welcomeBonus: parseFloat(welcomeBonus?.value || 5),
      minWithdraw: parseFloat(minWithdraw?.value || 10),
      maintenance: maintenance?.value === 'true',
      maintenanceMsg: maintenanceMsg?.value || '',
      announcement: ''
    });
  } catch (err) {
    return res.json({
      miningRate: 0.005, welcomeBonus: 5, minWithdraw: 10,
      maintenance: false, maintenanceMsg: '', announcement: ''
    });
  }
});

// Save config
app.post('/admin/api/save_config', (req, res) => {
  const { miningRate, welcomeBonus, minWithdraw } = req.body;
  try {
    if (miningRate) db.prepare(`UPDATE system_config SET value = ? WHERE key = 'mining_rate'`).run(miningRate.toString());
    if (welcomeBonus) db.prepare(`UPDATE system_config SET value = ? WHERE key = 'welcome_bonus'`).run(welcomeBonus.toString());
    if (minWithdraw) db.prepare(`UPDATE system_config SET value = ? WHERE key = 'min_withdraw'`).run(minWithdraw.toString());
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Danger action
app.post('/admin/api/danger_action', (req, res) => {
  const { action } = req.body;
  try {
    if (action === 'clear_banned_users') {
      const bannedUsers = db.prepare(`SELECT user_id FROM users WHERE is_banned = 1`).all();
      for (const u of bannedUsers) {
        io.to(`user_${u.user_id}`).emit('account:deleted');
      }
      db.prepare(`DELETE FROM users WHERE is_banned = 1`).run();
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Payments placeholder
app.post('/admin/api/payments', (req, res) => {
  return res.json({ payments: [] });
});

app.post('/admin/api/verify_payment', (req, res) => {
  const { paymentId, status, userId } = req.body;
  if (status === 'verified') {
    io.to(`user_${userId}`).emit('payment:verified', { status: 'verified' });
  }
  return res.json({ status: 'ok' });
});

// ============ SOCKET.IO REAL-TIME ============
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  // User joins their private room
  socket.on('user:join', ({ userId }) => {
    if (userId) {
      socket.join(`user_${userId}`);
      onlineUsers.set(userId, { socketId: socket.id, joinedAt: Date.now() });
      console.log(`👤 User ${userId} online (Total: ${onlineUsers.size})`);
      
      // Broadcast online users to admin
      io.emit('admin:online_users', {
        users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
        count: onlineUsers.size
      });
    }
  });
  
  // Admin joins admin room
  socket.on('admin:join', ({ token }) => {
    if (verifyAdminToken(token)) {
      socket.join('admin_room');
      socket.isAdmin = true;
      console.log('👑 Admin connected');
      
      // Send current online users
      socket.emit('admin:online_users', {
        users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
        count: onlineUsers.size
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    // Find and remove user
    for (const [userId, data] of onlineUsers.entries()) {
      if (data.socketId === socket.id) {
        onlineUsers.delete(userId);
        console.log(`👤 User ${userId} offline (Total: ${onlineUsers.size})`);
        break;
      }
    }
    
    // Update admin
    io.emit('admin:online_users', {
      users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
      count: onlineUsers.size
    });
    
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     ✅ SERVER REAL-TIME BERJALAN!     ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  📍 URL: http://localhost:${PORT}        ║`);
  console.log(`║  📱 App: http://localhost:${PORT}/app.html  ║`);
  console.log(`║  👑 Admin: http://localhost:${PORT}/admin.html ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log('║  🔐 PIN Admin: 043011                  ║');
  console.log('║  🧪 Test User: USR-TEST001 / 123456    ║');
  console.log('╚════════════════════════════════════════╝\n');
});