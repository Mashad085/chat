require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const { createApp }  = require('./app');
const { initDB }     = require('./src/config/database');
const { initRedis }  = require('./src/config/redis');
const { initBroker, closeBroker } = require('./src/services/broker');
const { initSocket } = require('./src/services/socket');
const logger         = require('./src/utils/logger');

async function start() {
  await initDB();
  await initRedis();
  await initBroker();

  const app    = createApp();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: '*', credentials: true }, pingTimeout: 60000 });
  initSocket(io);

  const PORT = parseInt(process.env.PORT || '3000');
  server.listen(PORT, () => {
    logger.info(`\n${'─'.repeat(52)}`);
    logger.info(`  🚀  ChatApp  →  http://localhost:${PORT}`);
    logger.info(`  🛡️   Admin   →  http://localhost:${PORT}/admin`);
    logger.info(`  Login admin  →  admin / admin123`);
    logger.info(`${'─'.repeat(52)}\n`);
  });

  const stop = async () => { server.close(async () => { await closeBroker(); process.exit(0); }); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
start().catch(e => { console.error(e); process.exit(1); });
