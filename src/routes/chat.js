/**
 * src/routes/chat.js
 */
const express = require('express');
const router  = express.Router();

const { RoomRepo } = require('../config/database');
const { requireAuth } = require('../middleware/security');

const BOT_COLORS = {
  'room-reza':'#7c3aed','room-anisa':'#db2777','room-dika':'#d97706',
  'room-network':'#059669','room-audio':'#7c3aed',
};

function fmt(ts) {
  const d = new Date(ts * 1000);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

router.get('/rooms', requireAuth, (req, res) => {
  const rooms = RoomRepo.getAll().map(r => {
    const msgs = RoomRepo.getMessages(r.id, 1);
    const last = msgs[msgs.length - 1];
    return {
      id: r.id, name: r.name, type: r.type,
      color: BOT_COLORS[r.id] || '#059669', status: 'online',
      lastMsg: last?.text || '', lastTime: last ? fmt(last.created_at) : '',
      unread: 0, msgCount: r.msg_count,
    };
  });
  res.json(rooms);
});

router.get('/rooms/:id/messages', requireAuth, (req, res) => {
  const msgs = RoomRepo.getMessages(req.params.id, 100);
  res.json(msgs.map(m => ({
    id: m.id, roomId: m.room_id, text: m.text,
    senderId: m.sender_id, senderName: m.sender_name, senderColor: m.sender_color,
    time: fmt(m.created_at), read: true,
  })));
});

module.exports = router;
