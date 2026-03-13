/**
 * src/middleware/security.js
 * JWT, Rate limiting, Helmet, CORS, Joi validation, Socket auth
 */
const jwt          = require('jsonwebtoken');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const cors         = require('cors');
const Joi          = require('joi');
const { v4: uuidv4 } = require('uuid');
const { SessionRepo, AuditRepo } = require('../config/database');
const { SessionCache } = require('../config/redis');
const logger       = require('../utils/logger');

const JWT_SECRET  = process.env.JWT_SECRET  || 'fallback-secret-change-me';
const JWT_EXPIRES = parseInt(process.env.JWT_EXPIRES_IN || '86400');

// ─── JWT ──────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

async function createSession(userId, ip, userAgent) {
  const token = signToken({ userId });
  const id = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + JWT_EXPIRES;
  SessionRepo.create({ id, userId, token, ip, userAgent, expiresAt });
  return token;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header?.startsWith('Bearer ') ? header.slice(7)
               : req.cookies?.token || req.query?.token;

  if (!token) return res.status(401).json({ error: 'Token diperlukan' });

  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token tidak valid atau kadaluarsa' });

  // Check Redis cache first
  let session = await SessionCache.get(token);
  if (!session) {
    session = SessionRepo.findByToken(token);
    if (session) await SessionCache.set(token, session);
  }

  if (!session)          return res.status(401).json({ error: 'Session tidak valid' });
  if (session.is_banned) return res.status(403).json({ error: `Akun diblokir: ${session.ban_reason || ''}` });

  req.user  = { id: session.user_id, username: session.username, role: session.role };
  req.token = token;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      AuditRepo.log(req.user?.id, 'unauthorized_admin', req.path, null, req.ip);
      return res.status(403).json({ error: 'Akses admin diperlukan' });
    }
    next();
  });
}

// ─── SOCKET AUTH ──────────────────────────────────────────
async function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('AUTH_REQUIRED'));

  const decoded = verifyToken(token);
  if (!decoded) return next(new Error('INVALID_TOKEN'));

  let session = await SessionCache.get(token);
  if (!session) {
    session = SessionRepo.findByToken(token);
    if (session) await SessionCache.set(token, session);
  }

  if (!session)          return next(new Error('SESSION_INVALID'));
  if (session.is_banned) return next(new Error(`BANNED:${session.ban_reason || 'Akun diblokir'}`));

  socket.userId   = session.user_id;
  socket.username = session.username;
  socket.role     = session.role;
  socket.token    = token;
  next();
}

// ─── RATE LIMITERS ───────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_MAX || '10'),
  message: { error: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '120'),
  message: { error: 'Rate limit tercapai.' },
});

// Socket-level per-user message rate
const socketMsgCounts = new Map();
function checkSocketRateLimit(userId) {
  const now  = Date.now();
  const entry = socketMsgCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    socketMsgCounts.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 60) return false;
  entry.count++;
  return true;
}

// ─── HELMET & CORS ────────────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: false, // disabled — kita serve dari Express sendiri
  crossOriginEmbedderPolicy: false,
});

const corsMiddleware = cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// ─── JOI SCHEMAS ─────────────────────────────────────────
const schemas = {
  register: Joi.object({
    username: Joi.string().alphanum().min(3).max(30).required()
      .messages({ 'string.alphanum': 'Username hanya boleh huruf dan angka', 'string.min': 'Username minimal 3 karakter' }),
    password: Joi.string().min(6).max(100).required()
      .messages({ 'string.min': 'Password minimal 6 karakter' }),
  }),
  login: Joi.object({
    username: Joi.string().required(),
    password: Joi.string().required(),
  }),
  message: Joi.object({
    text: Joi.string().trim().min(1).max(4096).required(),
  }),
  broadcast: Joi.object({
    message: Joi.string().trim().min(1).max(500).required(),
  }),
  ban: Joi.object({
    reason: Joi.string().trim().max(200).default('Melanggar ketentuan'),
  }),
};

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schemas[schema].validate(req.body, { abortEarly: false });
    if (error) {
      const messages = error.details.map(d => d.message);
      return res.status(400).json({ error: messages.join('; '), details: messages });
    }
    req.body = value;
    next();
  };
}

// ─── INPUT SANITIZER ─────────────────────────────────────
const XSS_PATTERNS = [/<script[\s\S]*?>[\s\S]*?<\/script>/gi, /javascript:/gi, /on\w+\s*=/gi];
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  let safe = text.trim().slice(0, 4096);
  XSS_PATTERNS.forEach(p => { safe = safe.replace(p, ''); });
  return safe;
}

// Suspicious content detector
const SUSPICIOUS_KW = ['DROP TABLE', 'SELECT *', '<script', 'eval(', 'exec('];
function isSuspicious(text) {
  return SUSPICIOUS_KW.some(k => text.toLowerCase().includes(k.toLowerCase()));
}

module.exports = {
  signToken, verifyToken, createSession,
  requireAuth, requireAdmin, socketAuth,
  loginLimiter, apiLimiter, checkSocketRateLimit,
  helmetMiddleware, corsMiddleware,
  validate, sanitizeText, isSuspicious,
};
