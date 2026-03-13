/**
 * app.js — Express application setup
 */
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');

const { helmetMiddleware, corsMiddleware, apiLimiter } = require('./src/middleware/security');
const authRouter  = require('./src/routes/auth');
const chatRouter  = require('./src/routes/chat');
const adminRouter = require('./src/routes/admin');
const logger      = require('./src/utils/logger');

function createApp() {
  const app = express();

  // ─── SECURITY HEADERS ──────────────────────────────
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(apiLimiter);

  // ─── BODY PARSING ──────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ─── HTTP LOGGING (Morgan → Winston) ───────────────
  app.use(morgan('combined', { stream: logger.stream }));

  // ─── STATIC FILES ──────────────────────────────────
  app.use(express.static(path.join(__dirname, 'public')));

  // ─── API ROUTES ────────────────────────────────────
  app.use('/api/auth',  authRouter);
  app.use('/api',       chatRouter);
  app.use('/api/admin', adminRouter);

  // ─── SPA FALLBACK ──────────────────────────────────
  app.get(['/admin', '/admin/*path'], (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
  app.get('/*path', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

  // ─── ERROR HANDLER ─────────────────────────────────
  app.use((err, req, res, next) => {
    logger.error('[app] Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
