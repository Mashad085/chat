/**
 * src/routes/status.js
 * Status (24 jam) & Channel routes
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { StatusRepo, ChannelRepo, ChannelPostRepo, UserRepo, AuditRepo, FriendRepo, run, query, queryOne } = require('../config/database');
const { requireAuth } = require('../middleware/security');
const { publish, TOPICS } = require('../services/broker');
const logger = require('../utils/logger');

const UPLOAD_DIR = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => { const ext = path.extname(file.originalname); cb(null, uuidv4() + ext); },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|mp4/.test(path.extname(file.originalname).toLowerCase().replace('.',''));
    cb(null, ok);
  }
});

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

// ═══════════════════════════════════════════════
// STATUS ROUTES
// ═══════════════════════════════════════════════

// GET /api/status — get all statuses visible to me
router.get('/status', requireAuth, (req, res) => {
  StatusRepo.cleanExpired();
  const statuses = StatusRepo.getForUser(req.user.id);
  // Group by user
  const byUser = {};
  statuses.forEach(s => {
    if (!byUser[s.user_id]) byUser[s.user_id] = { userId: s.user_id, username: s.username, color: s.color, avatarUrl: s.avatar_url, items: [] };
    byUser[s.user_id].items.push({
      id: s.id, mediaUrl: s.media_url, mediaType: s.media_type,
      caption: s.caption, bgColor: s.bg_color, time: fmtTime(s.created_at),
      expiresAt: s.expires_at, viewCount: s.view_count, viewed: !!s.viewed,
      isOwn: s.user_id === req.user.id,
    });
  });
  res.json(Object.values(byUser));
});

// POST /api/status — create text status
router.post('/status', requireAuth, (req, res) => {
  const { caption, bgColor } = req.body;
  if (!caption?.trim()) return res.status(400).json({ error: 'Caption diperlukan' });
  const id = uuidv4();
  StatusRepo.create({ id, userId: req.user.id, mediaType: 'text', caption: caption.trim(), bgColor: bgColor || '#00a884' });
  logger.info('[status] Created text status', { userId: req.user.id });
  res.json({ ok: true, id });
});

// POST /api/status/media — create media status
router.post('/status/media', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File diperlukan' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mediaType = /\.(jpg|jpeg|png|gif|webp)$/.test(ext) ? 'image' : 'video';
  const mediaUrl = '/uploads/' + req.file.filename;
  const { caption, bgColor } = req.body;
  const id = uuidv4();
  StatusRepo.create({ id, userId: req.user.id, mediaUrl, mediaType, caption: caption||'', bgColor: bgColor||'#00a884' });
  res.json({ ok: true, id, mediaUrl, mediaType });
});

// POST /api/status/:id/view
router.post('/status/:id/view', requireAuth, (req, res) => {
  StatusRepo.markViewed(req.params.id, req.user.id);
  res.json({ ok: true });
});

// DELETE /api/status/:id
router.delete('/status/:id', requireAuth, (req, res) => {
  StatusRepo.delete(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// CHANNEL ROUTES
// ═══════════════════════════════════════════════

// GET /api/channels — list all public + subscribed channels
router.get('/channels', requireAuth, (req, res) => {
  const channels = ChannelRepo.getAll(req.user.id);
  res.json(channels);
});

// GET /api/channels/subscribed
router.get('/channels/subscribed', requireAuth, (req, res) => {
  res.json(ChannelRepo.getSubscribed(req.user.id));
});

// POST /api/channels — create channel
router.post('/channels', requireAuth, (req, res) => {
  const { name, description, isPublic, link } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nama saluran diperlukan' });
  const id = 'ch-' + uuidv4().slice(0, 12);
  ChannelRepo.create({ id, name: name.trim(), description: description||'', ownerId: req.user.id, isPublic: isPublic !== false, link: link||'' });
  AuditRepo.log(req.user.id, 'create_channel', id, name.trim(), req.ip);
  logger.info('[channel] Created', { id, name, by: req.user.username });
  res.json({ ok: true, channel: ChannelRepo.findById(id, req.user.id) });
});

// GET /api/channels/:id
router.get('/channels/:id', requireAuth, (req, res) => {
  const ch = ChannelRepo.findById(req.params.id, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Saluran tidak ditemukan' });
  res.json(ch);
});

// PUT /api/channels/:id — update channel (owner only)
router.put('/channels/:id', requireAuth, upload.fields([{ name:'avatar', maxCount:1 }, { name:'bg', maxCount:1 }]), (req, res) => {
  const ch = ChannelRepo.findById(req.params.id, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (ch.owner_id !== req.user.id) return res.status(403).json({ error: 'Bukan pemilik saluran' });

  const { name, description, isPublic, link } = req.body;
  const avatarUrl = req.files?.avatar ? '/uploads/' + req.files.avatar[0].filename : undefined;
  const bgUrl = req.files?.bg ? '/uploads/' + req.files.bg[0].filename : undefined;

  ChannelRepo.update(req.params.id, {
    name: name?.trim(), description, isPublic: isPublic === 'true' || isPublic === true,
    avatarUrl, bgUrl, link,
  });
  res.json({ ok: true, channel: ChannelRepo.findById(req.params.id, req.user.id) });
});

// DELETE /api/channels/:id
router.delete('/channels/:id', requireAuth, (req, res) => {
  const ch = ChannelRepo.findById(req.params.id, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (ch.owner_id !== req.user.id) return res.status(403).json({ error: 'Bukan pemilik' });
  ChannelRepo.delete(req.params.id);
  res.json({ ok: true });
});

// POST /api/channels/:id/subscribe
router.post('/channels/:id/subscribe', requireAuth, (req, res) => {
  const ch = ChannelRepo.findById(req.params.id, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (!ch.is_public) return res.status(403).json({ error: 'Saluran privat' });
  ChannelRepo.subscribe(req.params.id, req.user.id);
  res.json({ ok: true });
});

// DELETE /api/channels/:id/subscribe
router.delete('/channels/:id/subscribe', requireAuth, (req, res) => {
  ChannelRepo.unsubscribe(req.params.id, req.user.id);
  res.json({ ok: true });
});

// GET /api/channels/:id/posts
router.get('/channels/:id/posts', requireAuth, (req, res) => {
  const ch = ChannelRepo.findById(req.params.id, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Tidak ditemukan' });
  // Check access for private channel
  if (!ch.is_public && !ch.is_subscribed && ch.owner_id !== req.user.id)
    return res.status(403).json({ error: 'Tidak ada akses' });
  const posts = ChannelPostRepo.getByChannel(req.params.id);
  res.json(posts.map(p => ({
    id: p.id, channelId: p.channel_id,
    text: p.text, fileUrl: p.file_url, fileName: p.file_name, fileType: p.file_type,
    isProduct: !!p.is_product, productName: p.product_name, productPrice: p.product_price, productDesc: p.product_desc,
    senderId: p.sender_id, senderName: p.sender_name, senderColor: p.sender_color, senderAvatar: p.sender_avatar,
    time: fmtTime(p.created_at), createdAt: p.created_at,
  })));
});

// POST /api/channels/:id/posts — post to channel (owner/admin)
router.post('/channels/:id/posts', requireAuth, upload.single('file'), (req, res) => {
  const ch = ChannelRepo.findById(req.params.id, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (ch.owner_id !== req.user.id && ch.my_role !== 'admin')
    return res.status(403).json({ error: 'Hanya pemilik/admin yang bisa posting' });

  const { text, isProduct, productName, productPrice, productDesc } = req.body;
  let fileUrl = null, fileName = null, fileType = null;
  if (req.file) {
    fileUrl = '/uploads/' + req.file.filename;
    fileName = req.file.originalname;
    const ext = path.extname(req.file.originalname).toLowerCase();
    fileType = /\.(jpg|jpeg|png|gif|webp)$/.test(ext) ? 'image' : /\.(mp4|webm)$/.test(ext) ? 'video' : 'document';
  }

  if (!text && !fileUrl) return res.status(400).json({ error: 'Konten diperlukan' });

  const id = uuidv4();
  ChannelPostRepo.create({
    id, channelId: req.params.id, senderId: req.user.id,
    text: text||null, fileUrl, fileName, fileType,
    isProduct: isProduct === 'true' || isProduct === true,
    productName: productName||null, productPrice: productPrice||null, productDesc: productDesc||null,
  });

  const post = { id, channelId: req.params.id, text: text||null, fileUrl, fileName, fileType,
    isProduct: !!isProduct, productName, productPrice, productDesc,
    senderName: req.user.username, time: fmtTime(Math.floor(Date.now()/1000)) };

  logger.info('[channel] Post created', { channelId: req.params.id, by: req.user.username });
  res.json({ ok: true, post });
});

// DELETE /api/channels/:chId/posts/:postId
router.delete('/channels/:chId/posts/:postId', requireAuth, (req, res) => {
  const ch = ChannelRepo.findById(req.params.chId, req.user.id);
  if (!ch) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (ch.owner_id !== req.user.id) return res.status(403).json({ error: 'Bukan pemilik' });
  ChannelPostRepo.delete(req.params.postId);
  res.json({ ok: true });
});

// GET /api/users/:id/profile — view friend's profile
router.get('/users/:id/profile', requireAuth, (req, res) => {
  const u = UserRepo.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User tidak ditemukan' });
  // Only show to friends or self
  const isSelf = req.params.id === req.user.id;
  const isFriend = FriendRepo && FriendRepo.exists(req.user.id, req.params.id);
  if (!isSelf && !isFriend) return res.status(403).json({ error: 'Tidak ada akses' });
  res.json({
    id: u.id, username: u.username, color: u.color,
    bio: u.bio||'', email: isSelf ? u.email : undefined,
    avatarUrl: u.avatar_url||'', bgUrl: u.bg_url||'',
    website: u.website||'', status: u.status, role: u.role,
  });
});

module.exports = router;
