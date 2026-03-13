/**
 * src/services/socket.js — Socket.IO event handlers
 */
const { v4: uuidv4 } = require('uuid');

const { UserRepo, RoomRepo, MessageRepo, AuditRepo } = require('../config/database');
const { OnlineUsers } = require('../config/redis');
const { socketAuth, checkSocketRateLimit, sanitizeText, isSuspicious } = require('../middleware/security');
const { publish, subscribe, TOPICS } = require('./broker');
const logger = require('../utils/logger');

const BOT_COLORS = {
  'room-reza':'#7c3aed','room-anisa':'#db2777','room-dika':'#d97706',
  'room-network':'#059669','room-audio':'#7c3aed',
};
const BOT_MAP = {
  'room-reza':'bot-reza','room-anisa':'bot-anisa','room-dika':'bot-dika',
  'room-network':'bot-farhan','room-audio':'bot-tono',
};
const BOT_NAMES  = { 'bot-reza':'Reza','bot-anisa':'Anisa','bot-dika':'Dika','bot-farhan':'Farhan','bot-tono':'Tono' };
const BOT_COLORS2 = { 'bot-reza':'#7c3aed','bot-anisa':'#db2777','bot-dika':'#d97706','bot-farhan':'#059669','bot-tono':'#dc2626' };
const BOT_REPLIES = ['Oke siap! 👍','Makasih infonya!','Mantap bro 🔥','Roger that! 🫡','Noted, thanks','Gas! 💪','Sip, dikonfirmasi ya','Wah oke banget 😎','Hmmm paham paham','Keren! 🌟'];

function fmt(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function initSocket(io) {
  // Apply JWT auth middleware
  io.use(socketAuth);

  // Bridge: broker SYSTEM_BROADCAST → all sockets
  subscribe(TOPICS.SYSTEM_BROADCAST, (event) => {
    io.emit('system_broadcast', event.payload);
  });

  // Bridge: broker USER_BANNED → kick socket
  subscribe(TOPICS.USER_BANNED, async (event) => {
    const { userId, reason } = event.payload;
    const all = await OnlineUsers.getAll();
    const entry = all[userId];
    if (entry?.socketId) {
      io.to(entry.socketId).emit('banned', { reason });
    }
  });

  // Bridge: broker ADMIN_ACTION delete_message → all sockets
  subscribe(TOPICS.ADMIN_ACTION, (event) => {
    if (event.payload?.action === 'delete_message') {
      io.emit('message_deleted', { msgId: event.payload.msgId });
    }
  });

  io.on('connection', async (socket) => {
    const { userId, username, role } = socket;
    logger.info('[socket] connect', { username, userId });

    // Track online
    const userInfo = { userId, username, role, socketId: socket.id, connectedAt: Date.now() };
    await OnlineUsers.set(userId, userInfo);
    UserRepo.updateStatus(userId, 'online');
    publish(TOPICS.USER_STATUS, { userId, username, status: 'online' }, userId);
    io.emit('user_status', { userId, username, status: 'online' });

    // ─── GET ROOMS ──────────────────────────────────────
    socket.on('get_rooms', () => {
      const rooms = RoomRepo.getAll().map(r => {
        const msgs = RoomRepo.getMessages(r.id, 1);
        const last = msgs[msgs.length - 1];
        return {
          id: r.id, name: r.name, type: r.type,
          color: BOT_COLORS[r.id] || '#059669', status: 'online',
          lastMsg: last?.text || '', lastTime: last ? fmt(last.created_at * 1000) : '',
          unread: 0,
        };
      });
      socket.emit('rooms', rooms);
    });

    // ─── JOIN ROOM ───────────────────────────────────────
    socket.on('join_room', ({ roomId }) => {
      socket.join(roomId);
      const msgs = RoomRepo.getMessages(roomId, 100);
      socket.emit('room_messages', {
        roomId,
        messages: msgs.map(m => ({
          id: m.id, roomId: m.room_id, text: m.text,
          senderId: m.sender_id, senderName: m.sender_name,
          senderColor: m.sender_color, time: fmt(m.created_at * 1000), read: true,
        }))
      });
    });

    // ─── SEND MESSAGE ────────────────────────────────────
    socket.on('send_message', ({ roomId, text }) => {
      if (!text?.trim()) return;
      if (!checkSocketRateLimit(userId)) {
        return socket.emit('error', { code: 'RATE_LIMIT', message: 'Terlalu banyak pesan. Tunggu sebentar.' });
      }

      const safe = sanitizeText(text);
      if (!safe) return;
      const suspicious = isSuspicious(text);
      const msgId = uuidv4();
      const user = UserRepo.findById(userId);

      MessageRepo.save({ id: msgId, roomId, senderId: userId, text: safe });
      if (suspicious) MessageRepo.flag(msgId);

      const msg = {
        id: msgId, roomId, text: safe,
        senderId: userId, senderName: username,
        senderColor: user?.color || '#00a884',
        time: fmt(), read: false, flagged: suspicious,
      };

      io.to(roomId).emit('new_message', msg);
      publish(TOPICS.CHAT_MESSAGE, { roomId, msgId, userId, username, preview: safe.slice(0, 50) }, userId);

      if (suspicious) {
        publish(TOPICS.SYSTEM_ALERT, { type: 'suspicious_message', msgId, userId, roomId }, 'system');
        // Notify admin sockets
        io.emit('admin_alert', { type: 'suspicious', msgId, username, roomId, preview: safe.slice(0, 50) });
      }

      // Bot reply
      const botId = BOT_MAP[roomId];
      if (botId) {
        setTimeout(() => {
          io.to(roomId).emit('typing', { roomId, name: BOT_NAMES[botId] });
          publish(TOPICS.CHAT_TYPING, { roomId, userId: botId }, botId);
        }, 400);

        setTimeout(() => {
          io.to(roomId).emit('stop_typing', { roomId });
          const reply = BOT_REPLIES[Math.floor(Math.random() * BOT_REPLIES.length)];
          const replyId = uuidv4();
          MessageRepo.save({ id: replyId, roomId, senderId: botId, text: reply });
          io.to(roomId).emit('new_message', {
            id: replyId, roomId, text: reply,
            senderId: botId, senderName: BOT_NAMES[botId],
            senderColor: BOT_COLORS2[botId],
            time: fmt(), read: true,
          });
          publish(TOPICS.CHAT_MESSAGE, { roomId, msgId: replyId, userId: botId, preview: reply }, botId);
        }, 1800 + Math.random() * 2000);
      }
    });

    // ─── TYPING ─────────────────────────────────────────
    socket.on('typing',      ({ roomId }) => socket.to(roomId).emit('typing', { roomId, name: username }));
    socket.on('stop_typing', ({ roomId }) => socket.to(roomId).emit('stop_typing', { roomId }));

    // ─── DISCONNECT ──────────────────────────────────────
    socket.on('disconnect', async () => {
      await OnlineUsers.remove(userId);
      UserRepo.updateStatus(userId, 'offline');
      publish(TOPICS.USER_STATUS, { userId, username, status: 'offline' }, userId);
      io.emit('user_status', { userId, status: 'offline' });
      logger.info('[socket] disconnect', { username });
    });
  });

  // ─── ADMIN NAMESPACE ─────────────────────────────────
  const adminNs = io.of('/admin-ws');
  adminNs.use((socket, next) => {
    socketAuth(socket, (err) => {
      if (err) return next(err);
      if (socket.role !== 'admin') return next(new Error('FORBIDDEN'));
      next();
    });
  });

  adminNs.on('connection', (socket) => {
    logger.info('[admin-ws] connected', { username: socket.username });
    // Forward all broker events to admin dashboard
    const unsub = subscribe('#', (event) => socket.emit('broker_event', event));
    socket.on('disconnect', unsub);
  });
}

module.exports = { initSocket };
