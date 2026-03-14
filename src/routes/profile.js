const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const { UserRepo, updateProfile, updatePassword, AuditRepo } = require('../config/database');
const { requireAuth } = require('../middleware/security');
const { SessionCache } = require('../config/redis');

// GET /api/profile
router.get('/', requireAuth, (req, res) => {
  const u = UserRepo.findById(req.user.id);
  if (!u) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ id: u.id, username: u.username, email: u.email||'', bio: u.bio||'', color: u.color, avatarUrl: u.avatar_url||'', bgUrl: u.bg_url||'', website: u.website||'', status: u.status });
});

// PUT /api/profile
router.put('/', requireAuth, (req, res) => {
  const { email, bio, color, bgUrl, website } = req.body;
  updateProfile(req.user.id, { email, bio, color, bgUrl, website });
  AuditRepo.log(req.user.id, 'update_profile');
  res.json({ ok: true });
});

// PUT /api/profile/password
router.put('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Field diperlukan' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

  const user = UserRepo.findById(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password))
    return res.status(401).json({ error: 'Password lama salah' });

  updatePassword(req.user.id, bcrypt.hashSync(newPassword, 10));
  // Revoke all sessions
  const { SessionRepo } = require('../config/database');
  SessionRepo.revokeAll(req.user.id);
  await SessionCache.del(req.token);
  AuditRepo.log(req.user.id, 'change_password');
  res.json({ ok: true, relogin: true });
});

module.exports = router;
