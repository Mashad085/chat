/**
 * src/config/database.js
 * SQLite (sql.js) dengan interface mirip Mongoose.
 * Swap ke MongoDB: ganti initDB() dengan mongoose.connect(MONGODB_URI)
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const DB_PATH = path.resolve(process.env.SQLITE_PATH || './data/chatapp.db');
let db = null;
let saveTimer = null;

async function initDB() {
  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    logger.info('[db] Loaded existing SQLite database');
  } else {
    db = new SQL.Database();
    logger.info('[db] Created new SQLite database');
  }

  applySchema();
  seedData();
  setInterval(persist, 10000);
  return db;
}

function persist() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  catch (e) { logger.error('[db] persist error', { error: e.message }); }
}

function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 2000);
}

// ─── SCHEMA ──────────────────────────────────────────────
function applySchema() {
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    role TEXT DEFAULT 'user', color TEXT, status TEXT DEFAULT 'offline',
    last_seen INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')),
    is_banned INTEGER DEFAULT 0, ban_reason TEXT,
    email TEXT,
    bio TEXT,
    avatar_url TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'private',
    created_by TEXT, created_at INTEGER DEFAULT (strftime('%s','now')), is_active INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender_id TEXT NOT NULL,
    text TEXT, file_url TEXT, file_name TEXT, file_type TEXT, created_at INTEGER DEFAULT (strftime('%s','now')),
    is_deleted INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
    ip TEXT, user_agent TEXT, created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL,
    target TEXT, detail TEXT, ip TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    room_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, friend_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#00a884',
    created_by TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS room_labels (
    room_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    PRIMARY KEY(room_id, label_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    media_url TEXT,
    media_type TEXT DEFAULT 'text',
    caption TEXT,
    bg_color TEXT DEFAULT '#00a884',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER,
    view_count INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS status_views (
    status_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    viewed_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY(status_id, viewer_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    owner_id TEXT NOT NULL,
    is_public INTEGER DEFAULT 1,
    avatar_url TEXT,
    bg_url TEXT,
    link TEXT,
    subscriber_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'subscriber',
    joined_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY(channel_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS channel_posts (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT,
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    is_product INTEGER DEFAULT 0,
    product_name TEXT,
    product_price TEXT,
    product_desc TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    is_deleted INTEGER DEFAULT 0
  )`);
  try { db.run(`ALTER TABLE rooms ADD COLUMN description TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE users ADD COLUMN bg_url TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE users ADD COLUMN website TEXT`); } catch(e) {}
  db.run(`CREATE INDEX IF NOT EXISTS idx_room_labels ON room_labels(room_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit ON audit_logs(created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_statuses ON statuses(user_id, expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_channel_posts ON channel_posts(channel_id, created_at)`);
  logger.info('[db] Schema applied');
}

// ─── SEED ────────────────────────────────────────────────
function seedData() {
  if (queryOne('SELECT id FROM users WHERE username=?', ['admin'])) return;
  const adminId = uuidv4();
  run('INSERT INTO users(id,username,password,role,color) VALUES(?,?,?,?,?)',
    [adminId, 'admin', bcrypt.hashSync('admin123', 10), 'admin', '#00a884']);

  const bots = [
    { id: 'bot-reza', u: 'reza', c: '#7c3aed' }, { id: 'bot-anisa', u: 'anisa', c: '#db2777' },
    { id: 'bot-dika', u: 'dika', c: '#d97706' }, { id: 'bot-farhan', u: 'farhan', c: '#059669' },
    { id: 'bot-tono', u: 'tono', c: '#dc2626' },
  ];
  const pw = bcrypt.hashSync('bot123', 10);
  bots.forEach(b => run('INSERT OR IGNORE INTO users(id,username,password,role,color) VALUES(?,?,?,?,?)',
    [b.id, b.u, pw, 'bot', b.c]));

  const rooms = [
    ['room-reza','Reza Pratama','private'], ['room-anisa','Anisa Rahayu','private'],
    ['room-network','Tim Network 🌐','group'], ['room-dika','Dika Santoso','private'],
    ['room-audio','Audio Engineers 🎵','group'],
  ];
  rooms.forEach(([id, name, type]) => run('INSERT OR IGNORE INTO rooms(id,name,type,created_by) VALUES(?,?,?,?)',
    [id, name, type, adminId]));

  [
    ['room-reza','bot-reza','Gimana progress dokumentasi network nya?'],
    ['room-reza', adminId, 'Udah 80% tinggal VLAN sama firewall rules'],
    ['room-anisa','bot-anisa','Makasih ya udah bantu kemarin 🙏'],
    ['room-network','bot-reza','Semua update firmware MikroTik ke versi terbaru'],
    ['room-network', adminId, 'Router lab utama udah selesai ✅'],
    ['room-network','bot-farhan','Update firmware selesai, semua node OK'],
    ['room-audio','bot-dika','Settingan limiter SPL TD60000 untuk sub gimana?'],
    ['room-audio', adminId, 'Threshold -6dBFS, ratio 10:1, attack 2ms release 50ms'],
    ['room-audio','bot-tono','Crossover 250Hz udah di-tune, sounds clean 🎵'],
  ].forEach(([rid, sid, text]) => run('INSERT INTO messages(id,room_id,sender_id,text) VALUES(?,?,?,?)',
    [uuidv4(), rid, sid, text]));

  persist();
  logger.info('[db] Seed data applied — admin/admin123');
}

// ─── QUERY HELPERS ───────────────────────────────────────
function run(sql, params = []) {
  db.run(sql, params);
  debouncedSave();
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  return query(sql, params)[0] || null;
}

// ─── USER REPO ───────────────────────────────────────────
const UserRepo = {
  create({ id, username, password, role = 'user', color = '#00a884' }) {
    run('INSERT INTO users(id,username,password,role,color) VALUES(?,?,?,?,?)',
      [id, username, bcrypt.hashSync(password, 10), role, color]);
  },
  findByUsername: (username) => queryOne('SELECT * FROM users WHERE username=?', [username]),
  findById: (id) => queryOne('SELECT * FROM users WHERE id=?', [id]),
  updateStatus: (id, status) => run(`UPDATE users SET status=?,last_seen=strftime('%s','now') WHERE id=?`, [status, id]),
  getAll: () => query('SELECT id,username,role,color,status,last_seen,created_at,is_banned,ban_reason FROM users ORDER BY created_at DESC'),
  ban: (id, reason) => run('UPDATE users SET is_banned=1,ban_reason=? WHERE id=?', [reason, id]),
  unban: (id) => run('UPDATE users SET is_banned=0,ban_reason=NULL WHERE id=?', [id]),
};

// ─── ROOM REPO ───────────────────────────────────────────
const RoomRepo = {
  getAll: () => query(`SELECT r.*,
    (SELECT COUNT(*) FROM messages m WHERE m.room_id=r.id AND m.is_deleted=0) msg_count
    FROM rooms r ORDER BY r.created_at DESC`),
  getMessages: (roomId, limit = 100) => query(`
    SELECT m.*, u.username sender_name, u.color sender_color
    FROM messages m JOIN users u ON m.sender_id=u.id
    WHERE m.room_id=? AND m.is_deleted=0 ORDER BY m.created_at ASC LIMIT ?`, [roomId, limit]),
};

// ─── MESSAGE REPO ────────────────────────────────────────
const MessageRepo = {
  save: ({ id, roomId, senderId, text }) =>
    run('INSERT INTO messages(id,room_id,sender_id,text) VALUES(?,?,?,?)', [id, roomId, senderId, text]),
  delete: (id) => run('UPDATE messages SET is_deleted=1 WHERE id=?', [id]),
  flag: (id) => run('UPDATE messages SET flagged=1 WHERE id=?', [id]),
  getFlagged: () => query(`SELECT m.*,u.username sender_name,r.name room_name
    FROM messages m JOIN users u ON m.sender_id=u.id JOIN rooms r ON m.room_id=r.id
    WHERE m.flagged=1 AND m.is_deleted=0 ORDER BY m.created_at DESC LIMIT 50`),
};

// ─── SESSION REPO ────────────────────────────────────────
const SessionRepo = {
  create: ({ id, userId, token, ip, userAgent, expiresAt }) =>
    run('INSERT INTO sessions(id,user_id,token,ip,user_agent,expires_at) VALUES(?,?,?,?,?,?)',
      [id, userId, token, ip, userAgent, expiresAt]),
  findByToken: (token) => queryOne(`
    SELECT s.*,u.username,u.role,u.is_banned,u.ban_reason FROM sessions s
    JOIN users u ON s.user_id=u.id
    WHERE s.token=? AND s.revoked=0 AND s.expires_at>strftime('%s','now')`, [token]),
  revoke: (token) => run('UPDATE sessions SET revoked=1 WHERE token=?', [token]),
  revokeAll: (userId) => run('UPDATE sessions SET revoked=1 WHERE user_id=?', [userId]),
  getActive: () => query(`SELECT s.id,s.user_id,s.ip,s.user_agent,s.created_at,s.expires_at,u.username,u.role
    FROM sessions s JOIN users u ON s.user_id=u.id
    WHERE s.revoked=0 AND s.expires_at>strftime('%s','now') ORDER BY s.created_at DESC`),
};

// ─── AUDIT REPO ──────────────────────────────────────────
const AuditRepo = {
  log: (userId, action, target = null, detail = null, ip = null) =>
    run('INSERT INTO audit_logs(id,user_id,action,target,detail,ip) VALUES(?,?,?,?,?,?)',
      [uuidv4(), userId, action, target, detail, ip]),
  getAll: (limit = 200) => query(`
    SELECT a.*,u.username FROM audit_logs a LEFT JOIN users u ON a.user_id=u.id
    ORDER BY a.created_at DESC LIMIT ?`, [limit]),
};

// ─── STATS ───────────────────────────────────────────────
function getStats() {
  return {
    totalUsers:  queryOne("SELECT COUNT(*) c FROM users WHERE role!='bot'")?.c || 0,
    totalMsgs:   queryOne("SELECT COUNT(*) c FROM messages WHERE is_deleted=0")?.c || 0,
    totalRooms:  queryOne("SELECT COUNT(*) c FROM rooms")?.c || 0,
    activeSess:  queryOne(`SELECT COUNT(*) c FROM sessions WHERE revoked=0 AND expires_at>strftime('%s','now')`)?.c || 0,
    flagged:     queryOne("SELECT COUNT(*) c FROM messages WHERE flagged=1 AND is_deleted=0")?.c || 0,
    banned:      queryOne("SELECT COUNT(*) c FROM users WHERE is_banned=1")?.c || 0,
    msgPerDay:   query(`SELECT date(created_at,'unixepoch') day, COUNT(*) count
      FROM messages WHERE created_at>strftime('%s','now')-604800 GROUP BY day ORDER BY day ASC`),
    topRooms:    query(`SELECT r.name, COUNT(m.id) msg_count
      FROM messages m JOIN rooms r ON m.room_id=r.id WHERE m.is_deleted=0
      GROUP BY m.room_id ORDER BY msg_count DESC LIMIT 5`),
  };
}

module.exports = { initDB, persist, UserRepo, RoomRepo, MessageRepo, SessionRepo, AuditRepo, getStats, run, query, queryOne };

// ─── FRIENDSHIP REPO ─────────────────────────────────────
const FriendRepo = {
  addFriend({ id, userId, friendId, roomId }) {
    run('INSERT OR IGNORE INTO friendships(id,user_id,friend_id,room_id,status) VALUES(?,?,?,?,?)',
      [id, userId, friendId, roomId, 'accepted']);
    // Mirror
    run('INSERT OR IGNORE INTO friendships(id,user_id,friend_id,room_id,status) VALUES(?,?,?,?,?)',
      [require('uuid').v4(), friendId, userId, roomId, 'accepted']);
  },
  getFriends(userId) {
    return query(`SELECT f.*, u.username, u.color, u.status, u.avatar_url, u.bio
      FROM friendships f JOIN users u ON f.friend_id=u.id
      WHERE f.user_id=? AND f.status='accepted'`, [userId]);
  },
  exists(userId, friendId) {
    return !!queryOne('SELECT id FROM friendships WHERE user_id=? AND friend_id=?', [userId, friendId]);
  },
};

// ─── PROFILE UPDATE ──────────────────────────────────────
function updateProfile(userId, { email, bio, avatarUrl, color, bgUrl, website }) {
  const parts = [], vals = [];
  if (email !== undefined)     { parts.push('email=?');      vals.push(email); }
  if (bio !== undefined)       { parts.push('bio=?');        vals.push(bio); }
  if (avatarUrl !== undefined) { parts.push('avatar_url=?'); vals.push(avatarUrl); }
  if (color !== undefined)     { parts.push('color=?');      vals.push(color); }
  if (bgUrl !== undefined)     { parts.push('bg_url=?');     vals.push(bgUrl); }
  if (website !== undefined)   { parts.push('website=?');    vals.push(website); }
  if (parts.length) { vals.push(userId); run(`UPDATE users SET ${parts.join(',')} WHERE id=?`, vals); }
}

function updatePassword(userId, newHash) {
  run('UPDATE users SET password=? WHERE id=?', [newHash, userId]);
}

// ─── LABEL REPO ──────────────────────────────────────────
const LabelRepo = {
  getAll: () => query(`SELECT l.*, COUNT(rl.room_id) room_count
    FROM labels l LEFT JOIN room_labels rl ON l.id=rl.label_id
    GROUP BY l.id ORDER BY l.created_at DESC`),
  create({ id, name, color, createdBy }) {
    run('INSERT INTO labels(id,name,color,created_by) VALUES(?,?,?,?)', [id, name, color, createdBy]);
  },
  delete: (id) => {
    run('DELETE FROM room_labels WHERE label_id=?', [id]);
    run('DELETE FROM labels WHERE id=?', [id]);
  },
  getByRoom: (roomId) => query(`SELECT l.* FROM labels l JOIN room_labels rl ON l.id=rl.label_id WHERE rl.room_id=?`, [roomId]),
  assignToRoom: (roomId, labelId) => run('INSERT OR IGNORE INTO room_labels(room_id,label_id) VALUES(?,?)', [roomId, labelId]),
  removeFromRoom: (roomId, labelId) => run('DELETE FROM room_labels WHERE room_id=? AND label_id=?', [roomId, labelId]),
  findById: (id) => queryOne('SELECT * FROM labels WHERE id=?', [id]),
};

module.exports = Object.assign(module.exports||{}, { LabelRepo });
// ─── STATUS REPO ─────────────────────────────────────────
const StatusRepo = {
  create({ id, userId, mediaUrl, mediaType, caption, bgColor }) {
    const expiresAt = Math.floor(Date.now()/1000) + 86400; // 24 hours
    run('INSERT INTO statuses(id,user_id,media_url,media_type,caption,bg_color,expires_at) VALUES(?,?,?,?,?,?,?)',
      [id, userId, mediaUrl||null, mediaType||'text', caption||null, bgColor||'#00a884', expiresAt]);
  },
  getForUser(viewerId) {
    // Get statuses from friends + self, not expired
    return query(`
      SELECT s.*, u.username, u.color, u.avatar_url,
        CASE WHEN sv.viewer_id IS NOT NULL THEN 1 ELSE 0 END as viewed
      FROM statuses s
      JOIN users u ON s.user_id=u.id
      LEFT JOIN status_views sv ON sv.status_id=s.id AND sv.viewer_id=?
      WHERE s.expires_at > strftime('%s','now')
      AND (s.user_id=? OR s.user_id IN (
        SELECT friend_id FROM friendships WHERE user_id=? AND status='accepted'
      ))
      ORDER BY s.created_at DESC`, [viewerId, viewerId, viewerId]);
  },
  getByUser(userId) {
    return query(`SELECT s.*, u.username, u.color, u.avatar_url FROM statuses s
      JOIN users u ON s.user_id=u.id
      WHERE s.user_id=? AND s.expires_at > strftime('%s','now')
      ORDER BY s.created_at DESC`, [userId]);
  },
  markViewed(statusId, viewerId) {
    run('INSERT OR IGNORE INTO status_views(status_id,viewer_id) VALUES(?,?)', [statusId, viewerId]);
    run('UPDATE statuses SET view_count=view_count+1 WHERE id=? AND user_id!=?', [statusId, viewerId]);
  },
  delete(id, userId) { run('DELETE FROM statuses WHERE id=? AND user_id=?', [id, userId]); },
  cleanExpired() { run(`DELETE FROM statuses WHERE expires_at <= strftime('%s','now')`); },
};

// ─── CHANNEL REPO ─────────────────────────────────────────
const ChannelRepo = {
  create({ id, name, description, ownerId, isPublic, avatarUrl, link }) {
    run('INSERT INTO channels(id,name,description,owner_id,is_public,avatar_url,link) VALUES(?,?,?,?,?,?,?)',
      [id, name, description||'', ownerId, isPublic?1:0, avatarUrl||null, link||null]);
    // Owner auto-subscribes
    run('INSERT OR IGNORE INTO channel_members(channel_id,user_id,role) VALUES(?,?,?)', [id, ownerId, 'owner']);
  },
  getAll(userId) {
    return query(`SELECT c.*, u.username owner_name,
      CASE WHEN cm.user_id IS NOT NULL THEN 1 ELSE 0 END as is_subscribed,
      (SELECT COUNT(*) FROM channel_members WHERE channel_id=c.id) sub_count,
      (SELECT COUNT(*) FROM channel_posts WHERE channel_id=c.id AND is_deleted=0) post_count
      FROM channels c JOIN users u ON c.owner_id=u.id
      LEFT JOIN channel_members cm ON cm.channel_id=c.id AND cm.user_id=?
      ORDER BY c.created_at DESC`, [userId]);
  },
  findById(id, userId) {
    return queryOne(`SELECT c.*, u.username owner_name,
      CASE WHEN cm.user_id IS NOT NULL THEN 1 ELSE 0 END as is_subscribed,
      cm.role as my_role,
      (SELECT COUNT(*) FROM channel_members WHERE channel_id=c.id) sub_count
      FROM channels c JOIN users u ON c.owner_id=u.id
      LEFT JOIN channel_members cm ON cm.channel_id=c.id AND cm.user_id=?
      WHERE c.id=?`, [userId||'', id]);
  },
  subscribe(channelId, userId) {
    run('INSERT OR IGNORE INTO channel_members(channel_id,user_id,role) VALUES(?,?,?)', [channelId, userId, 'subscriber']);
  },
  unsubscribe(channelId, userId) {
    run('DELETE FROM channel_members WHERE channel_id=? AND user_id=? AND role!=?', [channelId, userId, 'owner']);
  },
  getSubscribed(userId) {
    return query(`SELECT c.*, u.username owner_name, cm.role my_role,
      (SELECT COUNT(*) FROM channel_members WHERE channel_id=c.id) sub_count
      FROM channel_members cm JOIN channels c ON cm.channel_id=c.id
      JOIN users u ON c.owner_id=u.id
      WHERE cm.user_id=? ORDER BY cm.joined_at DESC`, [userId]);
  },
  update(id, { name, description, isPublic, avatarUrl, bgUrl, link }) {
    const parts=[], vals=[];
    if (name!==undefined){parts.push('name=?');vals.push(name);}
    if (description!==undefined){parts.push('description=?');vals.push(description);}
    if (isPublic!==undefined){parts.push('is_public=?');vals.push(isPublic?1:0);}
    if (avatarUrl!==undefined){parts.push('avatar_url=?');vals.push(avatarUrl);}
    if (bgUrl!==undefined){parts.push('bg_url=?');vals.push(bgUrl);}
    if (link!==undefined){parts.push('link=?');vals.push(link);}
    if (parts.length){vals.push(id);run(`UPDATE channels SET ${parts.join(',')} WHERE id=?`,vals);}
  },
  delete(id) {
    run('DELETE FROM channel_members WHERE channel_id=?', [id]);
    run('DELETE FROM channel_posts WHERE channel_id=?', [id]);
    run('DELETE FROM channels WHERE id=?', [id]);
  },
};

// ─── CHANNEL POST REPO ────────────────────────────────────
const ChannelPostRepo = {
  create({ id, channelId, senderId, text, fileUrl, fileName, fileType, isProduct, productName, productPrice, productDesc }) {
    run(`INSERT INTO channel_posts(id,channel_id,sender_id,text,file_url,file_name,file_type,is_product,product_name,product_price,product_desc)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, channelId, senderId, text||null, fileUrl||null, fileName||null, fileType||null,
       isProduct?1:0, productName||null, productPrice||null, productDesc||null]);
  },
  getByChannel(channelId, limit=50) {
    return query(`SELECT cp.*, u.username sender_name, u.color sender_color, u.avatar_url sender_avatar
      FROM channel_posts cp JOIN users u ON cp.sender_id=u.id
      WHERE cp.channel_id=? AND cp.is_deleted=0
      ORDER BY cp.created_at DESC LIMIT ?`, [channelId, limit]);
  },
  delete(id) { run('UPDATE channel_posts SET is_deleted=1 WHERE id=?', [id]); },
};

module.exports = Object.assign(module.exports||{}, { StatusRepo, ChannelRepo, ChannelPostRepo, updateProfile, updatePassword, FriendRepo });

