const { v4: uuidv4 } = require('uuid');
const { UserRepo, RoomRepo, MessageRepo, AuditRepo, run, query } = require('../config/database');
const { OnlineUsers } = require('../config/redis');
const { socketAuth, checkSocketRateLimit, sanitizeText, isSuspicious } = require('../middleware/security');
const { publish, subscribe, TOPICS } = require('./broker');
const logger = require('../utils/logger');

const BOT_COLORS = {'room-reza':'#7c3aed','room-anisa':'#db2777','room-dika':'#d97706','room-network':'#059669','room-audio':'#7c3aed'};
const BOT_MAP    = {'room-reza':'bot-reza','room-anisa':'bot-anisa','room-dika':'bot-dika','room-network':'bot-farhan','room-audio':'bot-tono'};
const BOT_NAMES  = {'bot-reza':'Reza','bot-anisa':'Anisa','bot-dika':'Dika','bot-farhan':'Farhan','bot-tono':'Tono'};
const BOT_C      = {'bot-reza':'#7c3aed','bot-anisa':'#db2777','bot-dika':'#d97706','bot-farhan':'#059669','bot-tono':'#dc2626'};
const BOT_REPLIES= ['Oke siap! 👍','Makasih infonya!','Mantap bro 🔥','Roger that! 🫡','Noted, thanks','Gas! 💪','Sip, dikonfirmasi ya','Wah oke banget 😎','👏👏'];

function fmt(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function getRoomsForUser(userId) {
  const allRooms = RoomRepo.getAll();
  const friendRooms = query(`
    SELECT r.*, u.username friend_name, u.color friend_color, u.status friend_status, u.avatar_url
    FROM friendships f JOIN rooms r ON f.room_id=r.id JOIN users u ON f.friend_id=u.id
    WHERE f.user_id=? AND f.status='accepted'`, [userId]);

  return [...allRooms, ...friendRooms.filter(fr => !allRooms.find(r => r.id === fr.id))].map(r => {
    const msgs = RoomRepo.getMessages(r.id, 1);
    const last = msgs[msgs.length - 1];
    const fr = friendRooms.find(x => x.id === r.id);
    return {
      id: r.id, name: fr ? fr.friend_name : r.name, type: r.type,
      color: fr ? (fr.friend_color || '#059669') : (BOT_COLORS[r.id] || '#059669'),
      status: fr ? (fr.friend_status || 'offline') : 'online',
      avatarUrl: fr?.avatar_url || null,
      lastMsg: last?.text || (last?.file_url ? '📎 Media' : ''),
      lastTime: last ? fmt(last.created_at) : '', unread: 0,
    };
  });
}

function initSocket(io) {
  io.use(socketAuth);

  // Broker bridges
  subscribe(TOPICS.SYSTEM_BROADCAST, (ev) => io.emit('system_broadcast', ev.payload));
  subscribe(TOPICS.USER_BANNED, async (ev) => {
    const { userId, reason } = ev.payload;
    const all = await OnlineUsers.getAll();
    const entry = all[userId];
    if (entry?.socketId) io.to(entry.socketId).emit('banned', { reason });
  });
  subscribe(TOPICS.ADMIN_ACTION, (ev) => {
    if (ev.payload?.action === 'delete_message')
      io.emit('message_deleted', { msgId: ev.payload.msgId });
  });

  io.on('connection', async (socket) => {
    const { userId, username, role } = socket;
    logger.info('[socket] connect', { username });

    await OnlineUsers.set(userId, { userId, username, role, socketId: socket.id, connectedAt: Date.now() });
    UserRepo.updateStatus(userId, 'online');
    publish(TOPICS.USER_STATUS, { userId, username, status: 'online' }, userId);
    io.emit('user_status', { userId, username, status: 'online' });

    socket.on('get_rooms', () => socket.emit('rooms', getRoomsForUser(userId)));

    socket.on('join_room', ({ roomId }) => {
      socket.join(roomId);
      const msgs = RoomRepo.getMessages(roomId, 100);
      socket.emit('room_messages', {
        roomId,
        messages: msgs.map(m => ({
          id: m.id, roomId: m.room_id,
          text: m.text || '', fileUrl: m.file_url || null,
          fileName: m.file_name || null, fileType: m.file_type || null,
          senderId: m.sender_id, senderName: m.sender_name,
          senderColor: m.sender_color, time: fmt(m.created_at * 1000), read: true,
        }))
      });
    });

    socket.on('send_message', ({ roomId, text, fileUrl, fileName, fileType }) => {
      if (!text?.trim() && !fileUrl) return;
      if (!checkSocketRateLimit(userId)) {
        return socket.emit('error', { code: 'RATE_LIMIT', message: 'Terlalu banyak pesan.' });
      }

      const safe = text ? sanitizeText(text) : '';
      const suspicious = safe ? isSuspicious(safe) : false;
      const msgId = uuidv4();
      const user = UserRepo.findById(userId);

      // Save with file support
      run(`INSERT INTO messages(id,room_id,sender_id,text,file_url,file_name,file_type) VALUES(?,?,?,?,?,?,?)`,
        [msgId, roomId, userId, safe, fileUrl||null, fileName||null, fileType||null]);
      if (suspicious) MessageRepo.flag(msgId);

      const msg = {
        id: msgId, roomId, text: safe,
        fileUrl: fileUrl || null, fileName: fileName || null, fileType: fileType || null,
        senderId: userId, senderName: username,
        senderColor: user?.color || '#00a884',
        time: fmt(), read: false, flagged: suspicious,
      };

      io.to(roomId).emit('new_message', msg);
      publish(TOPICS.CHAT_MESSAGE, { roomId, msgId, userId, username, preview: safe.slice(0,50) || '📎 Media' }, userId);
      if (suspicious) publish(TOPICS.SYSTEM_ALERT, { type: 'suspicious', msgId, userId, roomId }, 'system');

      // Bot reply (only for text, not media)
      const botId = BOT_MAP[roomId];
      if (botId && safe) {
        setTimeout(() => io.to(roomId).emit('typing', { roomId, name: BOT_NAMES[botId] }), 400);
        setTimeout(() => {
          io.to(roomId).emit('stop_typing', { roomId });
          const reply = BOT_REPLIES[Math.floor(Math.random() * BOT_REPLIES.length)];
          const rId = uuidv4();
          run('INSERT INTO messages(id,room_id,sender_id,text) VALUES(?,?,?,?)', [rId, roomId, botId, reply]);
          io.to(roomId).emit('new_message', {
            id: rId, roomId, text: reply, fileUrl: null,
            senderId: botId, senderName: BOT_NAMES[botId], senderColor: BOT_C[botId],
            time: fmt(), read: true,
          });
        }, 1800 + Math.random() * 2000);
      }
    });

    socket.on('typing',      ({ roomId }) => socket.to(roomId).emit('typing', { roomId, name: username }));
    socket.on('stop_typing', ({ roomId }) => socket.to(roomId).emit('stop_typing', { roomId }));

    // Friend added — refresh rooms
    socket.on('refresh_rooms', () => socket.emit('rooms', getRoomsForUser(userId)));

    socket.on('disconnect', async () => {
      await OnlineUsers.remove(userId);
      UserRepo.updateStatus(userId, 'offline');
      publish(TOPICS.USER_STATUS, { userId, username, status: 'offline' }, userId);
      io.emit('user_status', { userId, status: 'offline' });
      logger.info('[socket] disconnect', { username });
    });
  });

  // Admin namespace
  const adminNs = io.of('/admin-ws');
  adminNs.use((socket, next) => {
    socketAuth(socket, (err) => {
      if (err) return next(err);
      if (socket.role !== 'admin') return next(new Error('FORBIDDEN'));
      next();
    });
  });
  adminNs.on('connection', (socket) => {
    const unsub = subscribe('#', (ev) => socket.emit('broker_event', ev));
    socket.on('disconnect', unsub);
  });
}

module.exports = { initSocket };
