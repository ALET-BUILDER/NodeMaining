const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');

// Import database module
const dbModule = require('./database');

// Initialize database
dbModule.initDatabase();
const db = dbModule.getDb();

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

// Admin PIN hash
const ADMIN_PIN_HASH = bcrypt.hashSync('043011', 10);

// Online users tracking
const onlineUsers = new Map();

// ============ MAIN API ============
app.post('/api', async (req, res) => {
  console.log('📡 API called:', req.body.action);
  
  const { action, userId, pinCode, appData, isRegister, amount, method, recipientName, email, telegram } = req.body;
  
  // LOAD DATA / LOGIN
  if (action === 'load_data') {
    try {
      const user = dbModule.getUser(userId);
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
      dbModule.updateUser(userId, { last_active: Math.floor(Date.now() / 1000) });
      
      // Get transactions
      const transactions = dbModule.getUserTransactions(userId, 50);
      
      // Get configs
      const maintenance = dbModule.getConfig('maintenance') === 'true';
      const maintenanceMsg = dbModule.getConfig('maintenance_msg') || '';
      
      // Get referrals
      const referrals = dbModule.getReferrals(userId);
      
      // Calculate unlocked balance (server side)
      const refRewardRate = user.account_tier === 'vip' ? 0.75 : (user.account_tier === 'pro' ? 0.5 : 0.25);
      const verifFee = parseFloat(dbModule.getConfig('verification_fee') || 17000);
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
      console.error('Load data error:', err);
      return res.json({ status: 'error', message: 'Server error' });
    }
  }
  
  // REGISTER
  if (action === 'save_data' && isRegister === true) {
    try {
      const existingGmail = dbModule.getUserByGmail(appData?.paymentEmail);
      if (existingGmail) {
        return res.json({ status: 'error', message: 'GMAIL_TAKEN' });
      }
      
      const newUserId = 'USR-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const pinHash = bcrypt.hashSync(pinCode, 10);
      const referredBy = appData?.referredBy || null;
      
      const result = dbModule.createUser(newUserId, pinHash, appData.paymentEmail, referredBy);
      
      // Notify admin
      io.emit('admin:new_user', { userId: newUserId, email: appData.paymentEmail });
      
      return res.json({
        status: 'success',
        userId: newUserId,
        appData: {
          userId: newUserId,
          balance: result.balance,
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
    } catch (err) {
      console.error('Register error:', err);
      return res.json({ status: 'error', message: 'Registration failed' });
    }
  }
  
  // UPDATE USER DATA
  if (action === 'save_data' && userId && appData && !isRegister) {
    try {
      dbModule.updateUser(userId, {
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
      const result = dbModule.processCheckIn(userId);
      
      if (result.error) {
        return res.json({ status: result.error });
      }
      
      // Notify user via socket
      io.to(`user_${userId}`).emit('balance:updated', { balance: result.newBalance });
      
      return res.json({
        status: 'success',
        newStreak: result.newStreak,
        reward: result.reward,
        isJackpot: result.isJackpot,
        newBalance: result.newBalance
      });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // GET REFERRALS
  if (action === 'get') {
    try {
      const referrals = dbModule.getReferrals(userId);
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
      const user = dbModule.getUser(userId);
      if (!user) return res.json({ status: 'error', message: 'User not found' });
      if (user.is_banned) return res.json({ status: 'error', message: 'Account banned' });
      if (user.balance < amount) return res.json({ status: 'error', message: 'Insufficient balance' });
      
      const fee = amount * 0.1;
      const netAmount = amount - fee;
      
      // Create withdrawal record
      dbModule.createWithdrawal(userId, amount, fee, netAmount, method, recipientName, email);
      
      // Deduct from balance
      dbModule.updateUserBalance(userId, user.balance - amount, 'Withdrawal request');
      
      // Add transaction record
      dbModule.addTransaction(userId, amount, 'minus', 'pending', 'Penarikan Uang', `${method} | ${recipientName}`);
      
      // Notify admin
      io.emit('admin:withdrawal_request', { userId, amount, netAmount, recipientName });
      
      return res.json({ status: 'success', message: 'Withdrawal request submitted' });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // SUBMIT REPORT
  if (action === 'submit_report') {
    try {
      const { userId, category, message } = req.body;
      console.log(`📝 Report from ${userId}: [${category}] ${message}`);
      // Notify admin
      io.emit('admin:new_report', { userId, category, message, timestamp: Date.now() });
      return res.json({ status: 'success' });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  // VERIFY PAYMENT (for user to check)
  if (action === 'check_payment') {
    try {
      const { email, tier } = req.body;
      const pendingPayment = db.prepare(`
        SELECT * FROM payments WHERE email = ? AND package_name = ? AND status = 'pending'
      `).get(email, tier);
      
      if (pendingPayment) {
        return res.json({ status: 'pending' });
      }
      
      const verifiedPayment = db.prepare(`
        SELECT * FROM payments WHERE email = ? AND package_name = ? AND status = 'verified'
      `).get(email, tier);
      
      if (verifiedPayment) {
        // Upgrade user
        const tierMap = { 'PRO': 'pro', 'VIP': 'vip' };
        dbModule.upgradeUserTier(userId, tierMap[tier]);
        dbModule.updatePaymentStatus(verifiedPayment.id, 'verified');
        return res.json({ status: 'verified' });
      }
      
      return res.json({ status: 'not_found' });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }
  
  return res.json({ status: 'error', message: 'Unknown action: ' + action });
});

// ============ ADMIN API ============

// Middleware untuk admin
function verifyAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !dbModule.verifyAdminToken(token)) {
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
    dbModule.createAdminSession(token, expiresAt);
    return res.json({ status: 'ok', token });
  }
  return res.json({ status: 'error', message: 'Invalid PIN' });
});

// Get all users
app.post('/admin/api/users', verifyAdmin, (req, res) => {
  try {
    const users = dbModule.getAllUsers();
    
    const formattedUsers = users.map(u => ({
      userId: u.user_id,
      gmail: u.gmail || '-',
      balance: u.balance,
      total_withdrawn: u.total_withdrawn,
      monthly_earning: u.monthly_earning,
      is_verified: u.is_verified === 1,
      is_banned: u.is_banned === 1,
      account_tier: u.account_tier,
      referral_count: u.referral_count,
      created_at: u.created_at,
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
    const stats = dbModule.getStats();
    const onlineCount = onlineUsers.size;
    
    return res.json({
      totalUsers: stats.totalUsers,
      activeToday: onlineCount,
      pendingPayments: stats.pendingPayments,
      pendingWithdrawals: stats.pendingWithdrawals,
      bannedUsers: stats.bannedUsers,
      verifiedUsers: stats.verifiedUsers,
      totalBalance: stats.totalBalance,
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
    dbModule.banUser(userId, ban, reason || '');
    io.to(`user_${userId}`).emit('force:banned', { banned: ban, reason });
    io.emit('admin:user_banned', { userId, banned: ban, reason });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Update balance
app.post('/admin/api/update_balance', verifyAdmin, (req, res) => {
  const { userId, balance, reason } = req.body;
  try {
    dbModule.updateUserBalance(userId, balance, reason || 'Admin adjustment');
    io.to(`user_${userId}`).emit('balance:updated', { balance });
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
  }
});

// Verify user
app.post('/admin/api/verify_user', verifyAdmin, (req, res) => {
  const { userId, note } = req.body;
  try {
    dbModule.verifyUser(userId, true);
    if (note) dbModule.updateUser(userId, { admin_note: note });
    io.to(`user_${userId}`).emit('user:verified', { userId });
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
    dbModule.updateUser(userId, { pin_hash: newHash });
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
    dbModule.deleteUser(userId);
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
    
    dbModule.updateWithdrawalStatus(withdrawalId, status, rejectReason);
    
    if (status === 'rejected' && withdrawal.user_id) {
      // Refund balance
      const user = dbModule.getUser(withdrawal.user_id);
      if (user) {
        dbModule.updateUserBalance(withdrawal.user_id, user.balance + withdrawal.amount, 'Refund from rejected withdrawal');
        io.to(`user_${withdrawal.user_id}`).emit('balance:updated', { balance: user.balance + withdrawal.amount });
      }
      io.to(`user_${withdrawal.user_id}`).emit('withdrawal:rejected', { reason: rejectReason });
    } else if (status === 'approved') {
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
    dbModule.updatePaymentStatus(paymentId, status);
    
    if (status === 'verified' && userId) {
      const payment = db.prepare(`SELECT package_name FROM payments WHERE id = ?`).get(paymentId);
      const tierMap = { 'PRO': 'pro', 'VIP': 'vip' };
      const tier = tierMap[payment?.package_name];
      if (tier) {
        dbModule.upgradeUserTier(userId, tier);
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
    dbModule.setConfig('maintenance', enabled ? 'true' : 'false');
    dbModule.setConfig('maintenance_msg', message || '');
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
    const config = dbModule.getAllConfigs();
    return res.json({
      miningRate: parseFloat(config.mining_rate || 0.005),
      welcomeBonus: parseFloat(config.welcome_bonus || 5),
      minWithdraw: parseFloat(config.min_withdraw || 10),
      maintenance: config.maintenance === 'true',
      maintenanceMsg: config.maintenance_msg || '',
      referralPctBasic: parseInt(config.referral_pct_basic || 25),
      referralPctPro: parseInt(config.referral_pct_pro || 50),
      referralPctVip: parseInt(config.referral_pct_vip || 75),
      verificationFee: parseInt(config.verification_fee || 17000),
      proPrice: parseInt(config.pro_price || 85000),
      vipPrice: parseInt(config.vip_price || 170000),
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
app.post('/admin/api/save_config', verifyAdmin, (req, res) => {
  const configs = req.body;
  try {
    for (const [key, value] of Object.entries(configs)) {
      if (value !== undefined && key !== 'maintenance' && key !== 'maintenanceMsg') {
        dbModule.setConfig(key, value);
      }
    }
    return res.json({ status: 'ok' });
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
    if (action === 'reset_all_data') {
      db.prepare(`DELETE FROM users WHERE user_id NOT LIKE 'USR-TEST%'`).run();
      db.prepare(`DELETE FROM transactions`).run();
      db.prepare(`DELETE FROM withdrawals`).run();
      db.prepare(`DELETE FROM payments`).run();
      createTestUsers();
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.json({ status: 'error', message: err.message });
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
    if (dbModule.verifyAdminToken(token)) {
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
  
  socket.on('admin:config_update', (config) => {
    io.emit('system:config_updated', config);
  });
  
  socket.on('admin:maintenance', ({ enabled, message }) => {
    io.emit('system:maintenance', { enabled, message });
  });
  
  socket.on('admin:announcement', ({ text }) => {
    io.emit('system:announcement', { text });
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

// Helper function to create test users (for reset)
function createTestUsers() {
  try {
    const testUser = dbModule.getUser('USR-TEST001');
    if (!testUser) {
      const hash = bcrypt.hashSync('123456', 10);
      db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('USR-TEST001', hash, 'test@gmail.com', 1, 25.50, 'basic', 'Test user for development');
    }
    
    const demoUser = dbModule.getUser('USR-DEMO001');
    if (!demoUser) {
      const hash = bcrypt.hashSync('000000', 10);
      db.prepare(`INSERT INTO users (user_id, pin_hash, gmail, is_verified, balance, account_tier, admin_note) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('USR-DEMO001', hash, 'demo@gmail.com', 0, 5.00, 'trial', 'Demo user for testing');
    }
  } catch (err) {}
}

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
  console.log('║  👑 VIP User: USR-VIP001 / 777777      ║');
  console.log('╚════════════════════════════════════════╝\n');
});