/**
 * src/routes/admin.js
 */
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

const { UserRepo, RoomRepo, MessageRepo, SessionRepo, AuditRepo, getStats, run, query, queryOne } = require('../config/database');
const { SessionCache, OnlineUsers } = require('../config/redis');
const { requireAdmin, validate }    = require('../middleware/security');
const { publish, getBrokerStatus, getAdminFeed, TOPICS } = require('../services/broker');
const logger = require('../utils/logger');

// Lazy-load LabelRepo (added after module.exports)
function getLabelRepo() {
  return require('../config/database').LabelRepo;
}

// All admin routes require admin
router.use(requireAdmin);

router.get('/stats',    (req, res) => res.json(getStats()));
router.get('/users',    (req, res) => res.json(UserRepo.getAll()));
router.get('/rooms',    (req, res) => {
  const rooms = RoomRepo.getAll();
  // Attach labels to each room
  const LabelRepo = getLabelRepo();
  return res.json(rooms.map(r => ({
    ...r,
    labels: LabelRepo ? LabelRepo.getByRoom(r.id) : [],
  })));
});
router.get('/sessions', (req, res) => res.json(SessionRepo.getActive()));
router.get('/audit',    (req, res) => res.json(AuditRepo.getAll(200)));
router.get('/flagged',  (req, res) => res.json(MessageRepo.getFlagged()));
router.get('/broker',   (req, res) => res.json({ status: getBrokerStatus(), recentEvents: getAdminFeed(50) }));
router.get('/online',   async (req, res) => {
  const all = await OnlineUsers.getAll();
  res.json(Object.values(all));
});

// ─── BAN / UNBAN ─────────────────────────────────────────
router.post('/ban/:userId', validate('ban'), (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  UserRepo.ban(userId, reason);
  SessionRepo.revokeAll(userId);
  AuditRepo.log(req.user.id, 'ban_user', userId, reason, req.ip);
  publish(TOPICS.USER_BANNED, { userId, reason, by: req.user.id }, req.user.id);
  logger.info('[admin] Ban user', { userId, reason, by: req.user.username });
  res.json({ ok: true });
});

router.post('/unban/:userId', (req, res) => {
  UserRepo.unban(req.params.userId);
  AuditRepo.log(req.user.id, 'unban_user', req.params.userId, null, req.ip);
  res.json({ ok: true });
});

// ─── DELETE BOT ──────────────────────────────────────────
router.delete('/bots/:userId', (req, res) => {
  const { userId } = req.params;
  const user = UserRepo.findById(userId);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (user.role !== 'bot') return res.status(400).json({ error: 'User bukan bot' });
  // Delete bot's messages
  run('UPDATE messages SET is_deleted=1 WHERE sender_id=?', [userId]);
  // Delete bot's rooms (rooms that are named after the bot and bot is sole participant)
  run(`DELETE FROM rooms WHERE id IN (
    SELECT r.id FROM rooms r WHERE r.created_by=? OR r.name=?
  )`, [userId, user.username]);
  // Delete bot user
  run('DELETE FROM users WHERE id=?', [userId]);
  AuditRepo.log(req.user.id, 'delete_bot', userId, user.username, req.ip);
  logger.info('[admin] Bot deleted', { botId: userId, by: req.user.username });
  res.json({ ok: true });
});

// Delete ALL bots
router.delete('/bots', (req, res) => {
  const bots = query(`SELECT id, username FROM users WHERE role='bot'`);
  bots.forEach(b => {
    run('UPDATE messages SET is_deleted=1 WHERE sender_id=?', [b.id]);
    run('DELETE FROM users WHERE id=?', [b.id]);
  });
  // Clean bot-only rooms (rooms where all messages were from bots)
  run(`DELETE FROM rooms WHERE id IN (
    SELECT DISTINCT r.id FROM rooms r
    WHERE r.type='private'
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=r.created_by AND u.role!='bot')
    AND r.id LIKE 'room-%'
  )`);
  AuditRepo.log(req.user.id, 'delete_all_bots', null, `${bots.length} bots dihapus`, req.ip);
  logger.info('[admin] All bots deleted', { count: bots.length, by: req.user.username });
  res.json({ ok: true, count: bots.length });
});

// Get all bots
router.get('/bots', (req, res) => {
  const bots = query(`SELECT u.*, COUNT(m.id) msg_count
    FROM users u LEFT JOIN messages m ON m.sender_id=u.id AND m.is_deleted=0
    WHERE u.role='bot' GROUP BY u.id ORDER BY u.created_at DESC`);
  res.json(bots);
});

// ─── ROOMS MANAGEMENT ────────────────────────────────────
// Create group room
router.post('/rooms', (req, res) => {
  const { name, description, type } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nama ruang diperlukan' });
  const roomId = 'room-' + uuidv4().slice(0, 12);
  run('INSERT INTO rooms(id,name,type,created_by,description) VALUES(?,?,?,?,?)',
    [roomId, name.trim(), type || 'group', req.user.id, description || '']);
  AuditRepo.log(req.user.id, 'create_room', roomId, name.trim(), req.ip);
  logger.info('[admin] Room created', { roomId, name, by: req.user.username });
  res.json({ ok: true, room: { id: roomId, name: name.trim(), type: type || 'group' } });
});

// Delete room
router.delete('/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = queryOne('SELECT * FROM rooms WHERE id=?', [roomId]);
  if (!room) return res.status(404).json({ error: 'Ruang tidak ditemukan' });
  run('UPDATE messages SET is_deleted=1 WHERE room_id=?', [roomId]);
  run('DELETE FROM room_labels WHERE room_id=?', [roomId]);
  run('DELETE FROM rooms WHERE id=?', [roomId]);
  AuditRepo.log(req.user.id, 'delete_room', roomId, room.name, req.ip);
  logger.info('[admin] Room deleted', { roomId, name: room.name, by: req.user.username });
  res.json({ ok: true });
});

// ─── LABELS ──────────────────────────────────────────────
router.get('/labels', (req, res) => {
  const LabelRepo = getLabelRepo();
  res.json(LabelRepo.getAll());
});

router.post('/labels', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nama label diperlukan' });
  const LabelRepo = getLabelRepo();
  const id = uuidv4();
  LabelRepo.create({ id, name: name.trim(), color: color || '#00a884', createdBy: req.user.id });
  AuditRepo.log(req.user.id, 'create_label', id, name.trim(), req.ip);
  res.json({ ok: true, label: { id, name: name.trim(), color: color || '#00a884' } });
});

router.delete('/labels/:labelId', (req, res) => {
  const LabelRepo = getLabelRepo();
  const label = LabelRepo.findById(req.params.labelId);
  if (!label) return res.status(404).json({ error: 'Label tidak ditemukan' });
  LabelRepo.delete(req.params.labelId);
  AuditRepo.log(req.user.id, 'delete_label', req.params.labelId, label.name, req.ip);
  res.json({ ok: true });
});

// Assign label to room
router.post('/rooms/:roomId/labels/:labelId', (req, res) => {
  const LabelRepo = getLabelRepo();
  LabelRepo.assignToRoom(req.params.roomId, req.params.labelId);
  res.json({ ok: true });
});

// Remove label from room
router.delete('/rooms/:roomId/labels/:labelId', (req, res) => {
  const LabelRepo = getLabelRepo();
  LabelRepo.removeFromRoom(req.params.roomId, req.params.labelId);
  res.json({ ok: true });
});

// ─── MESSAGE / SESSION / FLAG / AUDIT ────────────────────
router.delete('/messages/:msgId', (req, res) => {
  MessageRepo.delete(req.params.msgId);
  AuditRepo.log(req.user.id, 'delete_message', req.params.msgId, null, req.ip);
  publish(TOPICS.ADMIN_ACTION, { action: 'delete_message', msgId: req.params.msgId }, req.user.id);
  res.json({ ok: true });
});

router.post('/flag/:msgId', (req, res) => {
  MessageRepo.flag(req.params.msgId);
  AuditRepo.log(req.user.id, 'flag_message', req.params.msgId, null, req.ip);
  res.json({ ok: true });
});

router.delete('/sessions/:sessionId', async (req, res) => {
  const sess = SessionRepo.getActive().find(s => s.id === req.params.sessionId);
  if (sess) {
    SessionRepo.revoke(sess.token);
    await SessionCache.del(sess.token);
  }
  AuditRepo.log(req.user.id, 'revoke_session', req.params.sessionId, null, req.ip);
  res.json({ ok: true });
});

router.post('/broadcast', validate('broadcast'), (req, res) => {
  const { message } = req.body;
  publish(TOPICS.SYSTEM_BROADCAST, { message, from: req.user.username, at: Date.now() }, req.user.id);
  AuditRepo.log(req.user.id, 'broadcast', null, message, req.ip);
  logger.info('[admin] Broadcast', { message, by: req.user.username });
  res.json({ ok: true });
});

module.exports = router;
