const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { RoomRepo, MessageRepo, UserRepo, FriendRepo, AuditRepo, run, query, queryOne } = require('../config/database');
const { requireAuth } = require('../middleware/security');
const { publish, TOPICS } = require('../services/broker');
const logger = require('../utils/logger');

const UPLOAD_DIR = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|pdf|doc|docx|xls|xlsx|zip|txt|ppt|pptx|mp3|ogg/;
    const ext = path.extname(file.originalname).toLowerCase().replace('.','');
    cb(null, allowed.test(ext));
  },
});

const BOT_COLORS = {
  'room-reza':'#7c3aed','room-anisa':'#db2777','room-dika':'#d97706',
  'room-network':'#059669','room-audio':'#7c3aed',
};

function fmt(ts) {
  const d = new Date(ts * 1000);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function fileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp)$/.test(ext)) return 'image';
  if (/\.(mp4|webm|ogg)$/.test(ext)) return 'video';
  if (/\.(mp3|ogg|wav)$/.test(ext)) return 'audio';
  if (/\.(pdf)$/.test(ext)) return 'pdf';
  return 'document';
}

// GET /api/rooms
router.get('/rooms', requireAuth, (req, res) => {
  // Seed rooms + friend rooms
  const allRooms = RoomRepo.getAll();
  const friendRooms = query(`
    SELECT r.*, u.username as friend_name, u.color as friend_color, u.status as friend_status, u.avatar_url
    FROM friendships f
    JOIN rooms r ON f.room_id = r.id
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id=? AND f.status='accepted'`, [req.user.id]);

  const result = [...allRooms, ...friendRooms.filter(fr => !allRooms.find(r => r.id === fr.id))].map(r => {
    const msgs = RoomRepo.getMessages(r.id, 1);
    const last = msgs[msgs.length - 1];
    const fr = friendRooms.find(x => x.id === r.id);
    return {
      id: r.id, name: fr ? fr.friend_name : r.name,
      type: r.type, color: fr ? (fr.friend_color || '#059669') : (BOT_COLORS[r.id] || '#059669'),
      status: fr ? (fr.friend_status || 'offline') : 'online',
      avatarUrl: fr?.avatar_url || null,
      lastMsg: last?.text || (last?.file_url ? '📎 Media' : ''),
      lastTime: last ? fmt(last.created_at) : '', unread: 0,
    };
  });
  res.json(result);
});

// GET /api/rooms/:id/messages
router.get('/rooms/:id/messages', requireAuth, (req, res) => {
  const msgs = RoomRepo.getMessages(req.params.id, 100);
  res.json(msgs.map(m => ({
    id: m.id, roomId: m.room_id, text: m.text || '',
    fileUrl: m.file_url || null, fileName: m.file_name || null, fileType: m.file_type || null,
    senderId: m.sender_id, senderName: m.sender_name, senderColor: m.sender_color,
    time: fmt(m.created_at), read: true,
  })));
});

// POST /api/upload — upload media/doc
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File tidak valid' });
  const type = fileType(req.file.originalname);
  const url  = '/uploads/' + req.file.filename;
  res.json({ url, name: req.file.originalname, type, size: req.file.size });
});

// POST /api/friends/add
router.post('/friends/add', requireAuth, (req, res) => {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'friendId diperlukan' });
  if (friendId === req.user.id) return res.status(400).json({ error: 'Tidak bisa tambah diri sendiri' });

  const friend = UserRepo.findById(friendId);
  if (!friend) return res.status(404).json({ error: 'User tidak ditemukan' });

  if (FriendRepo.exists(req.user.id, friendId))
    return res.status(409).json({ error: 'Sudah berteman' });

  // Create DM room
  const roomId = 'dm-' + [req.user.id, friendId].sort().join('-').slice(0, 40);
  run('INSERT OR IGNORE INTO rooms(id,name,type,created_by) VALUES(?,?,?,?)',
    [roomId, friend.username, 'private', req.user.id]);

  FriendRepo.addFriend({ id: uuidv4(), userId: req.user.id, friendId, roomId });
  AuditRepo.log(req.user.id, 'add_friend', friendId, null, req.ip);
  publish(TOPICS.USER_STATUS, { event: 'friend_added', userId: req.user.id, friendId }, req.user.id);

  logger.info('[chat] Friend added', { user: req.user.username, friend: friend.username });
  res.json({ ok: true, room: { id: roomId, name: friend.username, color: friend.color } });
});

// GET /api/friends
router.get('/friends', requireAuth, (req, res) => {
  res.json(FriendRepo.getFriends(req.user.id));
});

// GET /api/users/search?q=xxx
router.get('/users/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const users = query(`SELECT id,username,color,status,avatar_url,bio FROM users
    WHERE username LIKE ? AND role!='bot' AND id!=? LIMIT 10`,
    ['%' + q + '%', req.user.id]);
  res.json(users);
});

module.exports = router;
