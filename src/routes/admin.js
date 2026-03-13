/**
 * src/routes/admin.js
 */
const express = require('express');
const router  = express.Router();

const { UserRepo, RoomRepo, MessageRepo, SessionRepo, AuditRepo, getStats } = require('../config/database');
const { SessionCache, OnlineUsers } = require('../config/redis');
const { requireAdmin, validate }    = require('../middleware/security');
const { publish, getBrokerStatus, getAdminFeed, TOPICS } = require('../services/broker');
const logger = require('../utils/logger');

// All admin routes require admin
router.use(requireAdmin);

router.get('/stats',    (req, res) => res.json(getStats()));
router.get('/users',    (req, res) => res.json(UserRepo.getAll()));
router.get('/rooms',    (req, res) => res.json(RoomRepo.getAll()));
router.get('/sessions', (req, res) => res.json(SessionRepo.getActive()));
router.get('/audit',    (req, res) => res.json(AuditRepo.getAll(200)));
router.get('/flagged',  (req, res) => res.json(MessageRepo.getFlagged()));
router.get('/broker',   (req, res) => res.json({ status: getBrokerStatus(), recentEvents: getAdminFeed(50) }));
router.get('/online',   async (req, res) => {
  const all = await OnlineUsers.getAll();
  res.json(Object.values(all));
});

// Ban user
router.post('/ban/:userId', validate('ban'), (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  UserRepo.ban(userId, reason);
  SessionRepo.revokeAll(userId);
  AuditRepo.log(req.user.id, 'ban_user', userId, reason, req.ip);
  publish(TOPICS.USER_BANNED, { userId, reason, by: req.user.id }, req.user.id);
  logger.info('[admin] Ban user', { userId, reason, by: req.user.username });
  // emit via socket is handled in server.js via broker subscription
  res.json({ ok: true });
});

// Unban user
router.post('/unban/:userId', (req, res) => {
  UserRepo.unban(req.params.userId);
  AuditRepo.log(req.user.id, 'unban_user', req.params.userId, null, req.ip);
  res.json({ ok: true });
});

// Delete message
router.delete('/messages/:msgId', (req, res) => {
  MessageRepo.delete(req.params.msgId);
  AuditRepo.log(req.user.id, 'delete_message', req.params.msgId, null, req.ip);
  publish(TOPICS.ADMIN_ACTION, { action: 'delete_message', msgId: req.params.msgId }, req.user.id);
  res.json({ ok: true });
});

// Flag message
router.post('/flag/:msgId', (req, res) => {
  MessageRepo.flag(req.params.msgId);
  AuditRepo.log(req.user.id, 'flag_message', req.params.msgId, null, req.ip);
  res.json({ ok: true });
});

// Revoke session
router.delete('/sessions/:sessionId', async (req, res) => {
  const sess = SessionRepo.getActive().find(s => s.id === req.params.sessionId);
  if (sess) {
    SessionRepo.revoke(sess.token);
    await SessionCache.del(sess.token);
  }
  AuditRepo.log(req.user.id, 'revoke_session', req.params.sessionId, null, req.ip);
  res.json({ ok: true });
});

// Broadcast
router.post('/broadcast', validate('broadcast'), (req, res) => {
  const { message } = req.body;
  publish(TOPICS.SYSTEM_BROADCAST, { message, from: req.user.username, at: Date.now() }, req.user.id);
  AuditRepo.log(req.user.id, 'broadcast', null, message, req.ip);
  logger.info('[admin] Broadcast', { message, by: req.user.username });
  res.json({ ok: true });
});

module.exports = router;
