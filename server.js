/**
 * server.js — Entry point
 * Inisialisasi semua services lalu start HTTP server
 */
require('dotenv').config();

const http   = require('http');
const { Server } = require('socket.io');

const { createApp }   = require('./app');
const { initDB }      = require('./src/config/database');
const { initRedis }   = require('./src/config/redis');
const { initBroker, closeBroker } = require('./src/services/broker');
const { initSocket }  = require('./src/services/socket');
const logger          = require('./src/utils/logger');

async function start() {
  try {
    // 1. Database
    await initDB();
    logger.info('[boot] ✅ Database ready');

    // 2. Redis
    await initRedis();
    logger.info('[boot] ✅ Redis ready');

    // 3. RabbitMQ broker
    await initBroker();
    logger.info('[boot] ✅ RabbitMQ broker ready');

    // 4. Express app + HTTP server
    const app    = createApp();
    const server = http.createServer(app);

    // 5. Socket.IO
    const io = new Server(server, {
      cors: { origin: process.env.CORS_ORIGIN || '*', credentials: true },
      pingTimeout: 60000,
    });
    initSocket(io);
    logger.info('[boot] ✅ Socket.IO ready');

    // 6. Listen
    const PORT = parseInt(process.env.PORT || '3000');
    server.listen(PORT, () => {
      logger.info(`\n${'─'.repeat(55)}`);
      logger.info(`  🚀  ChatApp     →  http://localhost:${PORT}`);
      logger.info(`  🛡️   Admin Panel →  http://localhost:${PORT}/admin`);
      logger.info(`  📡  RabbitMQ    →  amqp://localhost:5672`);
      logger.info(`  🗄️   Redis       →  redis://localhost:6379`);
      logger.info(`  🔐  Admin login →  admin / admin123`);
      logger.info(`${'─'.repeat(55)}\n`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`[shutdown] ${signal} received`);
      server.close(async () => {
        await closeBroker();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (e) {
    logger.error('[boot] Startup failed', { error: e.message, stack: e.stack });
    process.exit(1);
  }
}

start();
