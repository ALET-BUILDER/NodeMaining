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

// ============ DATABASE INITIALIZATION ============
let db;
try {
  db = new Database('nodemaster.db');
  console.log('✅ Database connected');
} catch (err) {
  console.error('❌ Database error:', err.message);
  process.exit(1);
}

// Create all tables
try {
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      gmail TEXT UNIQUE,
      balance REAL DEFAULT 0,
      total_withdrawn REAL DEFAULT 0,
      monthly_earning REAL DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      account_tier TEXT DEFAULT 'trial',
      referral_code TEXT,
      referred_by TEXT,
      referral_count INTEGER DEFAULT 0,
      valid_referral_count INTEGER DEFAULT 0,
      checkin_streak INTEGER DEFAULT 0,
      last_checkin TEXT,
      upgrade_date INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      last_active INTEGER DEFAULT (strftime('%s', 'now')),
      admin_note TEXT
    );
    
    -- Transactions table
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount REAL,
      type TEXT,
      status TEXT,
      label TEXT,
      method TEXT,
      reject_reason TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );
    
    -- Withdrawals table
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      amount REAL,
      fee REAL,
      net_amount REAL,
      method TEXT,
      recipient_name TEXT,
      phone TEXT,
      status TEXT DEFAULT 'pending',
      reject_reason TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      processed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );
    
    -- Payments table
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
    
    -- System config
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    
    -- Admin sessions
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER
    );
  `);
  
  // Insert default configs
  const defaultConfigs = [
    ['maintenance', 'false'],
    ['maintenance_msg', ''],
    ['mining_rate', '0.005'],
    ['welcome_bonus', '5'],
    ['min_withdraw', '10'],
    ['referral_pct_basic', '25'],
    ['referral_pct_pro', '50'],
    ['referral_pct_vip', '75'],
    ['verification_fee', '17000'],
    ['pro_price', '85000'],
    ['vip_price', '170000']
  ];
  
  for (const [key, val] of defaultConfigs) {
    db.prepare(`INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)`).run(key, val);
  }
  
  console.log('✅ Tables ready');
} catch (err) {
  console.error('❌ Table creation error:', err.message);
}

// Create test users
const ADMIN_PIN_HASH = bcrypt.hashSync('043011', 10);

try {
  const testUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-TEST001');
  if (!testUser) {
    const hash = bcrypt.hashSync('123456', 10);
    db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('USR-TEST001', hash, 'test@gmail.com', 1, 25.50, 'basic', 'Test user');
    console.log('✅ Test user created: USR-TEST001 / PIN: 123456');
  }
  
  const demoUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-DEMO001');
  if (!demoUser) {
    const hash = bcrypt.hashSync('000000', 10);
    db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('USR-DEMO001', hash, 'demo@gmail.com', 0, 5.00, 'trial', 'Demo user');
    console.log('✅ Demo user created: USR-DEMO001 / PIN: 000000');
  }
} catch (err) {
  console.log('⚠️ Test user creation skipped:', err.message);
}

// Online users tracking
const onlineUsers = new Map();

// ============ HELPER FUNCTIONS ============
function getUser(userId) {
  return db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
}

function getUserByGmail(gmail) {
  return db.prepare(`SELECT * FROM users WHERE gmail = ?`).get(gmail);
}

function getAllUsers() {
  const users = db.prepare(`SELECT 
    user_id, 
    gmail, 
    balance, 
    total_withdrawn, 
    monthly_earning,
    is_verified, 
    is_banned, 
    account_tier, 
    referral_count,
    created_at,
    last_active,
    admin_note
    FROM users ORDER BY created_at DESC`).all();
  
  console.log('📊 Users loaded:', users.map(u => ({ id: u.user_id, verified: u.is_verified })));
  return users;
}

function createUser(userId, pinHash, gmail, referredBy = null) {
  const welcomeBonus = 5;
  
  const stmt = db.prepare(`INSERT INTO users 
    (user_id, pin_hash, gmail, balance, referral_code, referred_by, admin_note, created_at) 
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))`);
  
  stmt.run(userId, pinHash, gmail, welcomeBonus, userId, referredBy, 'New registration');
  
  db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) 
    VALUES (?, ?, 'plus', 'success', 'Welcome Bonus', strftime('%s', 'now'))`)
    .run(userId, welcomeBonus);
  
  if (referredBy) {
    db.prepare(`UPDATE users SET referral_count = referral_count + 1 WHERE user_id = ?`).run(referredBy);
  }
  
  return { userId, balance: welcomeBonus };
}

function updateUser(userId, data) {
  const fields = [];
  const values = [];
  
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  
  if (fields.length === 0) return;
  
  values.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`).run(...values);
}

function addTransaction(userId, amount, type, status, label, method = null) {
  return db.prepare(`INSERT INTO transactions 
    (user_id, amount, type, status, label, method, created_at) 
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))`)
    .run(userId, amount, type, status, label, method);
}

function getUserTransactions(userId, limit = 50) {
  return db.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
}

function getReferrals(userId) {
  const referrals = db.prepare(`SELECT user_id as id, created_at as joined, is_verified as valid 
    FROM users WHERE referred_by = ?`).all(userId);
  
  const validCount = referrals.filter(r => r.valid === 1).length;
  
  return {
    count: referrals.length,
    valid: validCount,
    list: referrals,
    commission_total: validCount * 3
  };
}

function getConfig(key) {
  const result = db.prepare(`SELECT value FROM system_config WHERE key = ?`).get(key);
  return result?.value;
}

function verifyAdminToken(token) {
  if (!token) return false;
  const session = db.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > strftime('%s', 'now')`).get(token);
  return !!session;
}

// ============ MAIN API ============
app.post('/api', async (req, res) => {
  console.log('📡 API called:', req.body.action);
  
  const { action, userId, pinCode, appData, isRegister, amount, method, recipientName, email, telegram, refCode } = req.body;
  
  // REGISTER
  if (action === 'save_data' && isRegister === true) {
    console.log('📝 Processing registration...');
    console.log('  - Gmail:', appData?.paymentEmail);
    console.log('  - Referral code:', refCode || 'none');
    
    try {
      const gmail = appData?.paymentEmail?.trim().toLowerCase();
      if (!gmail || !gmail.includes('@')) {
        return res.json({ status: 'error', message: 'Invalid email' });
      }
      
      const existingUser = getUserByGmail(gmail);
      if (existingUser) {
        console.log('  ❌ Gmail already taken:', gmail);
        return res.json({ status: 'error', message: 'GMAIL_TAKEN', desc: 'Gmail sudah terdaftar' });
      }
      
      let newUserId;
      let isUnique = false;
      let attempts = 0;
      
      while (!isUnique && attempts < 10) {
        const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
        newUserId = `USR-${randomPart}`;
        const existing = getUser(newUserId);
        if (!existing) isUnique = true;
        attempts++;
      }
      
      console.log('  ✅ Generated User ID:', newUserId);
      
      const pinHash = bcrypt.hashSync(pinCode, 10);
      
      let referredBy = null;
      if (refCode) {
        const referrer = getUser(refCode);
        if (referrer && !referrer.is_banned) {
          referredBy = refCode;
          console.log('  ✅ Referral from:', referredBy);
        }
      }
      
      const welcomeBonus = 5;
      
      const stmt = db.prepare(`INSERT INTO users 
        (user_id, pin_hash, gmail, balance, referral_code, referred_by, admin_note, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))`);
      
      stmt.run(newUserId, pinHash, gmail, welcomeBonus, newUserId, referredBy, 'New registration');
      
      db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) 
        VALUES (?, ?, 'plus', 'success', 'Welcome Bonus', strftime('%s', 'now'))`)
        .run(newUserId, welcomeBonus);
      
      if (referredBy) {
        db.prepare(`UPDATE users SET referral_count = referral_count + 1 WHERE user_id = ?`).run(referredBy);
      }
      
      console.log('  ✅ User created successfully!');
      console.log('  - User ID:', newUserId);
      console.log('  - Balance:', welcomeBonus);
      
      const newUser = getUser(newUserId);
      
      io.emit('admin:new_user', { userId: newUserId, email: gmail });
      
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
          paymentEmail: gmail,
          referralCount: 0,
          validReferralCount: 0,
          history: [],
          rate: 17000,
          isLoggedIn: true,
          created_at: newUser?.created_at
        }
      });
      
    } catch (err) {
      console.error('❌ Registration error:', err);
      return res.json({ status: 'error', message: 'Registration failed: ' + err.message });
    }
  }
  
  // LOAD DATA / LOGIN
  if (action === 'load_data') {
    console.log('🔐 Login attempt for:', userId);
    
    try {
      const user = getUser(userId);
      
      if (!user) {
        console.log('  ❌ User not found:', userId);
        return res.json({ status: 'error', message: 'User not found' });
      }
      
      if (user.is_banned) {
        console.log('  ❌ User is banned:', userId);
        return res.json({ status: 'error', message: 'BANNED' });
      }
      
      const pinValid = bcrypt.compareSync(pinCode, user.pin_hash);
      if (!pinValid) {
        console.log('  ❌ Wrong PIN for user:', userId);
        return res.json({ status: 'error', message: 'wrong_pin' });
      }
      
      console.log('  ✅ Login successful:', userId);
      
      updateUser(userId, { last_active: Math.floor(Date.now() / 1000) });
      
      const transactions = getUserTransactions(userId, 50);
      
      const maintenance = getConfig('maintenance') === 'true';
      const maintenanceMsg = getConfig('maintenance_msg') || '';
      
      const referrals = getReferrals(userId);
      
      const refRewardRate = user.account_tier === 'vip' ? 0.75 : (user.account_tier === 'pro' ? 0.5 : 0.25);
      const verifFee = parseFloat(getConfig('verification_fee') || 17000);
      const unlockedFromRefs = (referrals.valid || 0) * refRewardRate * (verifFee / 17000);
      const serverUnlockedBalance = Math.min(unlockedFromRefs, user.balance);
      
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
          referralCount: user.referral_count || 0,
          validReferralCount: referrals.valid || 0,
          upgradeDate: user.upgrade_date,
          history: transactions || [],
          server_unlocked_balance: serverUnlockedBalance,
          rate: 17000,
          isLoggedIn: true,
          admin_note: user.admin_note
        },
        global_settings: {
          maintenance: maintenance,
          maintenance_msg: maintenanceMsg,
          broadcast_active: false,
          broadcast_msg: '',
          notifications: []
        }
      });
    } catch (err) {
      console.error('❌ Load data error:', err);
      return res.json({ status: 'error', message: 'Server error' });
    }
  }
  
  // UPDATE USER DATA
  if (action === 'save_data' && userId && appData && !isRegister) {
    try {
      updateUser(userId, {
        balance: appData.balance || 0,
        total_withdrawn: appData.totalWD || 0,
        monthly_earning: appData.monthly || 0,
        account_tier: appData.account_tier || 'trial',
        upgrade_date: appData.upgradeDate || null,
        gmail: appData.paymentEmail
      });
      
      return res.json({ status: 'success' });
    } catch (err) {
      console.error('Update error:', err);
      return res.json({ status: 'error', message: 'Update failed' });
    }
  }
  
  // CHECK-IN CLAIM
  if (action === 'claim_checkin') {
    try {
      const user = getUser(userId);
      if (!user) return res.json({ status: 'error', message: 'User not found' });
      
      const today = new Date().toDateString();
      if (user.last_checkin === today) {
        return res.json({ status: 'already_claimed' });
      }
      
      let streak = user.checkin_streak || 0;
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      
      if (user.last_checkin === yesterday) {
        streak = Math.min(streak + 1, 7);
      } else {
        streak = 1;
      }
      
      const rewards = [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0];
      const reward = rewards[streak - 1];
      const isJackpot = streak === 7;
      
      updateUser(userId, {
        balance: user.balance + reward,
        checkin_streak: streak,
        last_checkin: today
      });
      
      addTransaction(userId, reward, 'plus', 'success', 
        isJackpot ? 'Jackpot Check-In (Hari 7)' : `Hadiah Check-In (Hari ${streak})`);
      
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
      const referrals = getReferrals(userId);
      return res.json({
        status: 'success',
        count: referrals.count,
        valid: referrals.valid,
        list: referrals.list,
        commission_total: referrals.commission_total
      });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // REQUEST WITHDRAW
  if (action === 'request_withdraw') {
    try {
      const user = getUser(userId);
      if (!user) return res.json({ status: 'error', message: 'User not found' });
      if (user.is_banned) return res.json({ status: 'error', message: 'Account banned' });
      if (user.balance < amount) return res.json({ status: 'error', message: 'Insufficient balance' });
      
      const fee = amount * 0.1;
      const netAmount = amount - fee;
      
      updateUser(userId, { balance: user.balance - amount });
      
      addTransaction(userId, amount, 'minus', 'pending', 'Penarikan Uang', `${method} | ${recipientName}`);
      
      io.emit('admin:withdrawal_request', { userId, amount, netAmount, recipientName });
      
      return res.json({ status: 'success', message: 'Withdrawal request submitted' });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // SUBMIT REPORT
  if (action === 'submit_report') {
    try {
      console.log(`📝 Report from ${userId}: [${req.body.category}] ${req.body.message}`);
      io.emit('admin:new_report', { userId, category: req.body.category, message: req.body.message, timestamp: Date.now() });
      return res.json({ status: 'success' });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  return res.json({ status: 'error', message: 'Unknown action: ' + action });
});

// ============ ADMIN API ============

function verifyAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Admin login
app.post('/admin/api/login', (req, res) => {
  const { pin } = req.body;
  const isValid = bcrypt.compareSync(pin, ADMIN_PIN_HASH) || pin === '043011';
  
  if (isValid) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + (8 * 3600);
    db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)`).run(token, expiresAt);
    return res.json({ status: 'ok', token });
  }
  return res.json({ status: 'error', message: 'Invalid PIN' });
});

// Get all users
app.post('/admin/api/users', verifyAdmin, (req, res) => {
  try {
    const users = getAllUsers();
    
    const formattedUsers = users.map(u => ({
      userId: u.user_id,
      paymentEmail: u.gmail || '-',
      balance: u.balance,
      total_withdrawn: u.total_withdrawn,
      monthly_earning: u.monthly_earning,
      isVerified: u.is_verified === 1,
      isBanned: u.is_banned === 1,
      account_tier: u.account_tier,
      referralCount: u.referral_count || 0,
      createdAt: u.created_at,
      last_active: u.last_active,
      admin_note: u.admin_note
    }));
    
    return res.json({ users: formattedUsers });
  } catch (err) {
    console.error('Get users error:', err);
    return res.json({ users: [] });
  }
});

// Get stats
app.post('/admin/api/stats', verifyAdmin, (req, res) => {
  try {
    const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users`).get();
    const bannedUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`).get();
    const verifiedUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_verified = 1`).get();
    const totalBalance = db.prepare(`SELECT SUM(balance) as sum FROM users WHERE is_banned = 0`).get();
    const pendingWithdrawals = db.prepare(`SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'`).get();
    const pendingPayments = db.prepare(`SELECT COUNT(*) as count FROM payments WHERE status = 'pending'`).get();
    const onlineCount = onlineUsers.size;
    
    return res.json({
      totalUsers: totalUsers?.count || 0,
      activeToday: onlineCount,
      pendingPayments: pendingPayments?.count || 0,
      pendingWithdrawals: pendingWithdrawals?.count || 0,
      bannedUsers: bannedUsers?.count || 0,
      verifiedUsers: verifiedUsers?.count || 0,
      totalBalance: totalBalance?.sum || 0,
      totalWdToday: 0,
      totalRevenue: 0,
      totalReferrals: 0
    });
  } catch (err) {
    return res.json({
      totalUsers: 0, activeToday: 0, pendingPayments: 0, pendingWithdrawals: 0,
      bannedUsers: 0, verifiedUsers: 0, totalBalance: 0, totalWdToday: 0,
      totalRevenue: 0, totalReferrals: 0
    });
  }
});

// Ban/Unban user
app.post('/admin/api/ban_user', verifyAdmin, (req, res) => {
  const { userId, ban, reason } = req.body;
  try {
    db.prepare(`UPDATE users SET is_banned = ?, admin_note = ? WHERE user_id = ?`)
      .run(ban ? 1 : 0, reason || '', userId);
    io.to(`user_${userId}`).emit('force:banned', { banned: ban, reason });
    io.emit('admin:user_banned', { userId, banned: ban, reason });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Update balance
// ============ UPDATE BALANCE (FIXED) ============
app.post('/admin/api/update_balance', verifyAdmin, (req, res) => {
  const { userId, balance, reason } = req.body;
  console.log(`💰 [API] Updating balance for ${userId} to ${balance}`);
  
  try {
    // Validate input
    if (!userId) {
      return res.json({ status: 'error', message: 'User ID required' });
    }
    const newBalance = parseFloat(balance);
    if (isNaN(newBalance)) {
      return res.json({ status: 'error', message: 'Invalid balance amount' });
    }
    
    // Check if user exists
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) {
      return res.json({ status: 'error', message: 'User not found' });
    }
    
    // Update balance
    db.prepare(`UPDATE users SET balance = ? WHERE user_id = ?`).run(newBalance, userId);
    
    // Add transaction record
    const diff = newBalance - user.balance;
    if (Math.abs(diff) > 0.001) {
      db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) 
        VALUES (?, ?, 'plus', 'success', ?, strftime('%s', 'now'))`)
        .run(userId, diff, `Admin adjustment: ${reason || 'Manual update'}`);
    }
    
    // Send realtime update to user via socket
    io.to(`user_${userId}`).emit('balance:updated', { balance: newBalance });
    
    console.log(`✅ Balance updated: ${userId} → $${newBalance}`);
    return res.json({ status: 'ok', message: 'Balance updated successfully' });
  } catch (err) {
    console.error('Update balance error:', err);
    return res.json({ status: 'error', message: err.message });
  }
});

// ============ VERIFY USER (FIXED) ============
app.post('/admin/api/verify_user', verifyAdmin, (req, res) => {
  const { userId, note } = req.body;
  console.log(`🔐 [API] Verifying user: ${userId}`);
  
  try {
    // Validate input
    if (!userId) {
      return res.json({ status: 'error', message: 'User ID required' });
    }
    
    // Check if user exists
    const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    if (!user) {
      return res.json({ status: 'error', message: 'User not found' });
    }
    
    // Update is_verified = 1 and account_tier = 'basic'
    db.prepare(`UPDATE users SET is_verified = 1, account_tier = 'basic', admin_note = ? WHERE user_id = ?`)
      .run(note || 'Verified by admin', userId);
    
    // Verify the update was successful
    const updated = db.prepare(`SELECT is_verified, account_tier FROM users WHERE user_id = ?`).get(userId);
    console.log(`✅ User ${userId} verified:`, updated);
    
    // Send events to user via socket
    io.to(`user_${userId}`).emit('user:verified', { userId });
    io.to(`user_${userId}`).emit('verification:complete', { verified: true });
    io.to(`user_${userId}`).emit('balance:updated', { balance: user.balance });
    
    return res.json({ status: 'ok', message: 'User verified successfully' });
  } catch (err) {
    console.error('Verify error:', err);
    return res.json({ status: 'error', message: err.message });
  }
});

// Change user tier
app.post('/admin/api/change_tier', verifyAdmin, (req, res) => {
  const { userId, tier, reason } = req.body;
  const validTiers = ['basic', 'pro', 'vip'];
  
  if (!validTiers.includes(tier)) {
    return res.json({ status: 'error', message: 'Invalid tier' });
  }
  
  try {
    db.prepare(`UPDATE users SET account_tier = ?, upgrade_date = strftime('%s', 'now'), admin_note = ? WHERE user_id = ?`)
      .run(tier, reason || `Tier changed to ${tier}`, userId);
    
    io.to(`user_${userId}`).emit('tier:updated', { tier: tier });
    io.to(`user_${userId}`).emit('balance:updated', {});
    
    console.log(`👑 User ${userId} tier changed to ${tier}`);
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Reset PIN
app.post('/admin/api/reset_pin', verifyAdmin, (req, res) => {
  const { userId } = req.body;
  try {
    const newPin = Math.floor(100000 + Math.random() * 900000).toString();
    const newHash = bcrypt.hashSync(newPin, 10);
    db.prepare(`UPDATE users SET pin_hash = ? WHERE user_id = ?`).run(newHash, userId);
    io.to(`user_${userId}`).emit('pin:reset', { newPin });
    return res.json({ status: 'ok', newPin });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Delete user
app.post('/admin/api/delete_user', verifyAdmin, (req, res) => {
  const { userId, reason } = req.body;
  try {
    db.prepare(`DELETE FROM transactions WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM withdrawals WHERE user_id = ?`).run(userId);
    db.prepare(`DELETE FROM users WHERE user_id = ?`).run(userId);
    io.to(`user_${userId}`).emit('account:deleted', { reason });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Get withdrawals
app.post('/admin/api/withdrawals', verifyAdmin, (req, res) => {
  try {
    const { status } = req.body;
    let withdrawals;
    if (status && status !== 'all') {
      withdrawals = db.prepare(`SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at DESC`).all(status);
    } else {
      withdrawals = db.prepare(`SELECT * FROM withdrawals ORDER BY created_at DESC`).all();
    }
    return res.json({ withdrawals });
  } catch (err) {
    return res.json({ withdrawals: [] });
  }
});

// Update withdrawal status
app.post('/admin/api/update_withdrawal', verifyAdmin, (req, res) => {
  const { withdrawalId, status, rejectReason } = req.body;
  try {
    const withdrawal = db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(withdrawalId);
    if (!withdrawal) return res.json({ status: 'error', message: 'Withdrawal not found' });
    
    if (status === 'rejected') {
      db.prepare(`UPDATE withdrawals SET status = ?, reject_reason = ?, processed_at = strftime('%s', 'now') 
        WHERE id = ?`).run(status, rejectReason, withdrawalId);
      
      const user = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(withdrawal.user_id);
      if (user) {
        db.prepare(`UPDATE users SET balance = balance + ? WHERE user_id = ?`).run(withdrawal.amount, withdrawal.user_id);
        io.to(`user_${withdrawal.user_id}`).emit('balance:updated', { balance: user.balance + withdrawal.amount });
      }
      io.to(`user_${withdrawal.user_id}`).emit('withdrawal:rejected', { reason: rejectReason });
    } else {
      db.prepare(`UPDATE withdrawals SET status = ?, processed_at = strftime('%s', 'now') WHERE id = ?`)
        .run(status, withdrawalId);
      io.to(`user_${withdrawal.user_id}`).emit('withdrawal:approved', { amount: withdrawal.amount });
    }
    
    io.emit('admin:withdrawal_updated', { withdrawalId, status });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Get payments
app.post('/admin/api/payments', verifyAdmin, (req, res) => {
  try {
    const { status } = req.body;
    let payments;
    if (status && status !== 'all') {
      payments = db.prepare(`SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC`).all(status);
    } else {
      payments = db.prepare(`SELECT * FROM payments ORDER BY created_at DESC`).all();
    }
    return res.json({ payments });
  } catch (err) {
    return res.json({ payments: [] });
  }
});

// Verify payment
app.post('/admin/api/verify_payment', verifyAdmin, (req, res) => {
  const { paymentId, status, userId } = req.body;
  try {
    db.prepare(`UPDATE payments SET status = ? WHERE id = ?`).run(status, paymentId);
    
    if (status === 'verified' && userId) {
      const payment = db.prepare(`SELECT package_name FROM payments WHERE id = ?`).get(paymentId);
      const tierMap = { 'PRO': 'pro', 'VIP': 'vip' };
      const tier = tierMap[payment?.package_name];
      if (tier) {
        db.prepare(`UPDATE users SET account_tier = ?, upgrade_date = strftime('%s', 'now') WHERE user_id = ?`)
          .run(tier, userId);
      }
      io.to(`user_${userId}`).emit('payment:verified', { status: 'verified', package: payment?.package_name });
    }
    
    io.emit('admin:payment_verified', { paymentId, status, userId });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Broadcast message
app.post('/admin/api/broadcast', verifyAdmin, (req, res) => {
  const { message, type } = req.body;
  io.emit('system:broadcast', { message, type, timestamp: Date.now() });
  console.log(`📢 Broadcast sent: ${message}`);
  return res.json({ status: 'ok' });
});

// Maintenance mode
app.post('/admin/api/maintenance', verifyAdmin, (req, res) => {
  const { enabled, message } = req.body;
  try {
    db.prepare(`UPDATE system_config SET value = ? WHERE key = 'maintenance'`).run(enabled ? 'true' : 'false');
    db.prepare(`UPDATE system_config SET value = ? WHERE key = 'maintenance_msg'`).run(message || '');
    io.emit('system:maintenance', { enabled, message });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Announcement
app.post('/admin/api/announcement', verifyAdmin, (req, res) => {
  const { text } = req.body;
  io.emit('system:announcement', { text, timestamp: Date.now() });
  return res.json({ status: 'ok' });
});

// Get config
app.post('/admin/api/config', verifyAdmin, (req, res) => {
  try {
    const configs = {};
    const rows = db.prepare(`SELECT * FROM system_config`).all();
    for (const row of rows) {
      configs[row.key] = row.value;
    }
    
    let paymentConfig = {};
    try { paymentConfig = JSON.parse(configs.payment_config || '{}'); } catch(e) {}
    return res.json({
      miningRate: parseFloat(configs.mining_rate || 0.005),
      welcomeBonus: parseFloat(configs.welcome_bonus || 5),
      minWithdraw: parseFloat(configs.min_withdraw || 10),
      maintenance: configs.maintenance === 'true',
      maintenanceMsg: configs.maintenance_msg || '',
      referralPctBasic: parseInt(configs.referral_pct_basic || 25),
      referralPctPro: parseInt(configs.referral_pct_pro || 50),
      referralPctVip: parseInt(configs.referral_pct_vip || 75),
      verificationFee: parseInt(configs.verification_fee || 17000),
      proPrice: parseInt(configs.pro_price || 85000),
      vipPrice: parseInt(configs.vip_price || 170000),
      announcement: configs.announcement || '',
      paymentConfig: paymentConfig
    });
  } catch (err) {
    return res.json({
      miningRate: 0.005, welcomeBonus: 5, minWithdraw: 10,
      maintenance: false, maintenanceMsg: '', announcement: ''
    });
  }
});

// Save config
app.post('/admin/api/save_config', verifyAdmin, (req, res) => {
  const configs = req.body;
  try {
    for (const [key, value] of Object.entries(configs)) {
      if (value !== undefined) {
        if (key === 'paymentConfig' && typeof value === 'object') {
          db.prepare(`INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)`).run('payment_config', JSON.stringify(value));
        } else if (typeof value !== 'object') {
          db.prepare(`INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)`).run(key, String(value));
        }
      }
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// User submit manual payment proof
app.post('/api/submit_payment', (req, res) => {
  const { userId, tier, method, senderName, proofImage, amount, packageName } = req.body;
  if (!userId || !tier || !method || !senderName) {
    return res.json({ status: 'error', message: 'Data tidak lengkap' });
  }
  try {
    const paymentId = 'PAY_' + Date.now() + '_' + Math.random().toString(36).slice(2,7).toUpperCase();
    db.prepare(`INSERT INTO payments (id, user_id, amount, status, package_name, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(paymentId, userId, amount || 0, packageName || tier, new Date().toISOString());
    // Store extra fields if columns exist, or just use activity log
    try {
      db.prepare(`UPDATE payments SET method = ?, sender_name = ?, proof_url = ? WHERE id = ?`)
        .run(method, senderName, proofImage ? proofImage.substring(0,500) : '', paymentId);
    } catch(e2) {
      // Columns may not exist yet - that's OK
    }
    // Notify admin via socket
    io.to('admin_room').emit('admin:new_payment', {
      id: paymentId, userId, amount, packageName: packageName || tier,
      method, senderName, status: 'pending', createdAt: new Date().toISOString()
    });
    return res.json({ status: 'ok', paymentId });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Danger actions
app.post('/admin/api/danger_action', verifyAdmin, (req, res) => {
  const { action } = req.body;
  try {
    if (action === 'clear_banned_users') {
      const bannedUsers = db.prepare(`SELECT user_id FROM users WHERE is_banned = 1`).all();
      for (const u of bannedUsers) {
        io.to(`user_${u.user_id}`).emit('account:deleted');
      }
      db.prepare(`DELETE FROM users WHERE is_banned = 1`).run();
    }
    if (action === 'reset_pending_payments') {
      db.prepare(`DELETE FROM payments WHERE status = 'pending'`).run();
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// DEBUG: Cek status user (bisa diakses via browser)
app.get('/admin/debug/:userId', verifyAdmin, (req, res) => {
  const { userId } = req.params;
  try {
    const user = db.prepare(`SELECT user_id, is_verified, account_tier, balance, gmail FROM users WHERE user_id = ?`).get(userId);
    res.json(user || { error: 'User not found' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ============ SOCKET.IO REAL-TIME ============
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  socket.on('user:join', ({ userId }) => {
    if (userId) {
      socket.join(`user_${userId}`);
      onlineUsers.set(userId, { socketId: socket.id, joinedAt: Date.now() });
      console.log(`👤 User ${userId} online (Total: ${onlineUsers.size})`);
      
      io.emit('admin:online_users', {
        users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
        count: onlineUsers.size
      });
    }
  });
  
  socket.on('user:subscribe', ({ userId }) => {
    if (userId) {
      socket.join(`user_${userId}`);
    }
  });
  
  socket.on('admin:join', ({ token }) => {
    if (verifyAdminToken(token)) {
      socket.join('admin_room');
      socket.isAdmin = true;
      console.log('👑 Admin connected');
      
      socket.emit('admin:online_users', {
        users: Array.from(onlineUsers.keys()).map(id => ({ userId: id })),
        count: onlineUsers.size
      });
    }
  });
  
  socket.on('admin:force_ban', ({ userId }) => {
    io.to(`user_${userId}`).emit('force:banned', { banned: true });
  });
  
  socket.on('admin:payment_action', ({ paymentId, status, userId }) => {
    io.to(`user_${userId}`).emit('payment:verified', { status });
  });
  
  socket.on('disconnect', () => {
    for (const [userId, data] of onlineUsers.entries()) {
      if (data.socketId === socket.id) {
        onlineUsers.delete(userId);
        console.log(`👤 User ${userId} offline (Total: ${onlineUsers.size})`);
        break;
      }
    }
    
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
  console.log('║  🧪 Demo User: USR-DEMO001 / 000000    ║');
  console.log('╚════════════════════════════════════════╝\n');
});