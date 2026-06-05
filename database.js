// database.js
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

let db;

function initDatabase() {
  try {
    db = new Database('nodemaster.db');
    console.log('✅ Database connected');
    
    // Create all tables
    db.exec(`
      -- Users table
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
      
      -- Payments table (upgrade payments)
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
      
      -- Notifications
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        message TEXT,
        type TEXT DEFAULT 'info',
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      -- Broadcast messages
      CREATE TABLE IF NOT EXISTS broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT,
        type TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
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
    
    // Create test users
    createTestUsers();
    
    return db;
  } catch (err) {
    console.error('❌ Database error:', err.message);
    process.exit(1);
  }
}

function createTestUsers() {
  try {
    // Admin test user
    const testUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-TEST001');
    if (!testUser) {
      const hash = bcrypt.hashSync('123456', 10);
      db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('USR-TEST001', hash, 'test@gmail.com', 1, 25.50, 'basic', 'Test user for development');
      console.log('✅ Test user created: USR-TEST001 / PIN: 123456');
    }
    
    // Demo trial user
    const demoUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-DEMO001');
    if (!demoUser) {
      const hash = bcrypt.hashSync('000000', 10);
      db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('USR-DEMO001', hash, 'demo@gmail.com', 0, 5.00, 'trial', 'Demo user for testing');
      console.log('✅ Demo user created: USR-DEMO001 / PIN: 000000');
    }
    
    // VIP test user
    const vipUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get('USR-VIP001');
    if (!vipUser) {
      const hash = bcrypt.hashSync('777777', 10);
      db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('USR-VIP001', hash, 'vip@gmail.com', 1, 150.00, 'vip', 'VIP user for testing');
      console.log('✅ VIP user created: USR-VIP001 / PIN: 777777');
    }
  } catch (err) {
    console.log('⚠️ Test user creation skipped:', err.message);
  }
}

// User CRUD operations
function getUser(userId) {
  return db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
}

function getUserByGmail(gmail) {
  return db.prepare(`SELECT * FROM users WHERE gmail = ?`).get(gmail);
}

function getAllUsers() {
  return db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all();
}

function createUser(userId, pinHash, gmail, referredBy = null) {
  const welcomeBonus = parseFloat(getConfig('welcome_bonus') || 5);
  
  const stmt = db.prepare(`INSERT INTO users 
    (user_id, pin_hash, gmail, balance, referral_code, referred_by, admin_note) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  
  stmt.run(userId, pinHash, gmail, welcomeBonus, userId, referredBy, 'New registration');
  
  // Add welcome bonus transaction
  db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) 
    VALUES (?, ?, 'plus', 'success', 'Welcome Bonus', strftime('%s', 'now'))`)
    .run(userId, welcomeBonus);
  
  // Update referrer if exists
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

function updateUserBalance(userId, newBalance, reason = '') {
  const oldUser = getUser(userId);
  if (!oldUser) return false;
  
  db.prepare(`UPDATE users SET balance = ? WHERE user_id = ?`).run(newBalance, userId);
  
  // Log balance change if significant
  const diff = newBalance - oldUser.balance;
  if (Math.abs(diff) > 0.01 && reason) {
    db.prepare(`INSERT INTO transactions (user_id, amount, type, status, label, created_at) 
      VALUES (?, ?, 'plus', 'success', ?, strftime('%s', 'now'))`)
      .run(userId, diff, `Admin adjustment: ${reason}`);
  }
  
  return true;
}

function banUser(userId, banned = true, reason = '') {
  db.prepare(`UPDATE users SET is_banned = ?, admin_note = ? WHERE user_id = ?`)
    .run(banned ? 1 : 0, reason, userId);
}

function verifyUser(userId, verified = true) {
  db.prepare(`UPDATE users SET is_verified = ? WHERE user_id = ?`).run(verified ? 1 : 0, userId);
}

function upgradeUserTier(userId, tier) {
  const validTiers = ['basic', 'pro', 'vip'];
  if (!validTiers.includes(tier)) return false;
  
  db.prepare(`UPDATE users SET account_tier = ?, upgrade_date = strftime('%s', 'now') WHERE user_id = ?`)
    .run(tier, userId);
  return true;
}

function deleteUser(userId) {
  db.prepare(`DELETE FROM transactions WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM withdrawals WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM users WHERE user_id = ?`).run(userId);
}

// Transaction operations
function addTransaction(userId, amount, type, status, label, method = null) {
  return db.prepare(`INSERT INTO transactions 
    (user_id, amount, type, status, label, method, created_at) 
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))`)
    .run(userId, amount, type, status, label, method);
}

function getUserTransactions(userId, limit = 50) {
  return db.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
}

// Withdrawal operations
function createWithdrawal(userId, amount, fee, netAmount, method, recipientName, phone) {
  return db.prepare(`INSERT INTO withdrawals 
    (user_id, amount, fee, net_amount, method, recipient_name, phone, status, created_at) 
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', strftime('%s', 'now'))`)
    .run(userId, amount, fee, netAmount, method, recipientName, phone);
}

function getPendingWithdrawals() {
  return db.prepare(`SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

function updateWithdrawalStatus(withdrawalId, status, rejectReason = null) {
  if (status === 'rejected') {
    db.prepare(`UPDATE withdrawals SET status = ?, reject_reason = ?, processed_at = strftime('%s', 'now') 
      WHERE id = ?`).run(status, rejectReason, withdrawalId);
  } else {
    db.prepare(`UPDATE withdrawals SET status = ?, processed_at = strftime('%s', 'now') WHERE id = ?`)
      .run(status, withdrawalId);
  }
}

// Payment operations
function createPayment(paymentId, userId, amount, packageName, email, proofUrl = null) {
  return db.prepare(`INSERT INTO payments 
    (id, user_id, amount, package_name, email, proof_url, status, created_at) 
    VALUES (?, ?, ?, ?, ?, ?, 'pending', strftime('%s', 'now'))`)
    .run(paymentId, userId, amount, packageName, email, proofUrl);
}

function getPendingPayments() {
  return db.prepare(`SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

function updatePaymentStatus(paymentId, status) {
  db.prepare(`UPDATE payments SET status = ? WHERE id = ?`).run(status, paymentId);
}

// Check-in operations
function processCheckIn(userId) {
  const user = getUser(userId);
  if (!user) return { error: 'User not found' };
  
  const today = new Date().toDateString();
  if (user.last_checkin === today) {
    return { error: 'already_claimed' };
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
  
  db.prepare(`UPDATE users SET balance = balance + ?, checkin_streak = ?, last_checkin = ? WHERE user_id = ?`)
    .run(reward, streak, today, userId);
  
  addTransaction(userId, reward, 'plus', 'success', 
    isJackpot ? 'Jackpot Check-In (Hari 7)' : `Hadiah Check-In (Hari ${streak})`);
  
  return {
    success: true,
    newStreak: streak,
    reward: reward,
    isJackpot: isJackpot,
    newBalance: user.balance + reward
  };
}

// Referral operations
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

// Config operations
function getConfig(key) {
  const result = db.prepare(`SELECT value FROM system_config WHERE key = ?`).get(key);
  return result?.value;
}

function setConfig(key, value) {
  db.prepare(`INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)`).run(key, String(value));
}

function getAllConfigs() {
  const rows = db.prepare(`SELECT * FROM system_config`).all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

// Admin session
function createAdminSession(token, expiresAt) {
  db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)`).run(token, expiresAt);
}

function verifyAdminToken(token) {
  const session = db.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > strftime('%s', 'now')`).get(token);
  return !!session;
}

// Stats
function getStats() {
  const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users`).get();
  const bannedUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`).get();
  const verifiedUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_verified = 1`).get();
  const totalBalance = db.prepare(`SELECT SUM(balance) as sum FROM users WHERE is_banned = 0`).get();
  const pendingWithdrawals = db.prepare(`SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'`).get();
  const pendingPayments = db.prepare(`SELECT COUNT(*) as count FROM payments WHERE status = 'pending'`).get();
  
  return {
    totalUsers: totalUsers?.count || 0,
    bannedUsers: bannedUsers?.count || 0,
    verifiedUsers: verifiedUsers?.count || 0,
    totalBalance: totalBalance?.sum || 0,
    pendingWithdrawals: pendingWithdrawals?.count || 0,
    pendingPayments: pendingPayments?.count || 0
  };
}

module.exports = {
  initDatabase,
  getDb: () => db,
  getUser,
  getUserByGmail,
  getAllUsers,
  createUser,
  updateUser,
  updateUserBalance,
  banUser,
  verifyUser,
  upgradeUserTier,
  deleteUser,
  addTransaction,
  getUserTransactions,
  createWithdrawal,
  getPendingWithdrawals,
  updateWithdrawalStatus,
  createPayment,
  getPendingPayments,
  updatePaymentStatus,
  processCheckIn,
  getReferrals,
  getConfig,
  setConfig,
  getAllConfigs,
  createAdminSession,
  verifyAdminToken,
  getStats
};