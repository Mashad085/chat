/**
 * src/routes/auth.js
 */
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();

const { UserRepo, AuditRepo } = require('../config/database');
const { SessionCache }        = require('../config/redis');
const { createSession, loginLimiter, requireAuth, validate } = require('../middleware/security');
const { publish, TOPICS }     = require('../services/broker');
const logger                  = require('../utils/logger');

const COLORS = ['#7c3aed','#db2777','#059669','#d97706','#1d4ed8','#dc2626','#0891b2','#65a30d','#c2410c','#0e7490'];

// POST /api/auth/register
router.post('/register', loginLimiter, validate('register'), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (UserRepo.findByUsername(username))
      return res.status(409).json({ error: 'Username sudah digunakan' });

    const userId = uuidv4();
    const color  = COLORS[Math.floor(Math.random() * COLORS.length)];
    UserRepo.create({ id: userId, username, password, color });

    const token = await createSession(userId, req.ip, req.headers['user-agent']);
    AuditRepo.log(userId, 'register', null, null, req.ip);
    publish(TOPICS.USER_LOGIN, { userId, username }, userId);

    logger.info('[auth] Register', { username, userId });
    res.status(201).json({ token, user: { id: userId, username, role: 'user', color } });
  } catch (e) {
    logger.error('[auth] Register error', { error: e.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, validate('login'), async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = UserRepo.findByUsername(username);

    if (!user || !bcrypt.compareSync(password, user.password)) {
      if (user) AuditRepo.log(user.id, 'login_failed', null, 'Wrong password', req.ip);
      return res.status(401).json({ error: 'Username atau password salah' });
    }
    if (user.is_banned)
      return res.status(403).json({ error: `Akun diblokir: ${user.ban_reason || ''}` });

    const token = await createSession(user.id, req.ip, req.headers['user-agent']);
    AuditRepo.log(user.id, 'login', null, null, req.ip);
    publish(TOPICS.USER_LOGIN, { userId: user.id, username }, user.id);

    logger.info('[auth] Login', { username });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, color: user.color } });
  } catch (e) {
    logger.error('[auth] Login error', { error: e.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  const { SessionRepo } = require('../config/database');
  SessionRepo.revoke(req.token);
  await SessionCache.del(req.token);
  UserRepo.updateStatus(req.user.id, 'offline');
  AuditRepo.log(req.user.id, 'logout', null, null, req.ip);
  publish(TOPICS.USER_LOGOUT, { userId: req.user.id }, req.user.id);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = UserRepo.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ id: user.id, username: user.username, role: user.role, color: user.color, status: user.status });
});

module.exports = router;
