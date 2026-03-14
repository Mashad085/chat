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
  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit ON audit_logs(created_at DESC)`);
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
function updateProfile(userId, { email, bio, avatarUrl, color }) {
  const parts = [], vals = [];
  if (email !== undefined)     { parts.push('email=?');      vals.push(email); }
  if (bio !== undefined)       { parts.push('bio=?');        vals.push(bio); }
  if (avatarUrl !== undefined) { parts.push('avatar_url=?'); vals.push(avatarUrl); }
  if (color !== undefined)     { parts.push('color=?');      vals.push(color); }
  if (parts.length) { vals.push(userId); run(`UPDATE users SET ${parts.join(',')} WHERE id=?`, vals); }
}

function updatePassword(userId, newHash) {
  run('UPDATE users SET password=? WHERE id=?', [newHash, userId]);
}

module.exports = Object.assign(module.exports || {}, { FriendRepo, updateProfile, updatePassword });
