require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const { helmetMiddleware, corsMiddleware, apiLimiter } = require('./src/middleware/security');
const logger  = require('./src/utils/logger');

function createApp() {
  const app = express();
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(apiLimiter);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan('combined', { stream: logger.stream }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

  app.use('/api/auth',    require('./src/routes/auth'));
  app.use('/api',         require('./src/routes/chat'));
  app.use('/api/admin',   require('./src/routes/admin'));
  app.use('/api/profile', require('./src/routes/profile'));
  app.use('/api',         require('./src/routes/status'));

  app.get(['/admin', '/admin/*path'], (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
  app.get('/*path', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.use((err, req, res, next) => {
    logger.error('[app] error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
module.exports = { createApp };
