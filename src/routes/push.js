/**
 * src/routes/push.js
 * Web Push Notification — VAPID + subscription management
 */
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/security');
const { run, query, queryOne } = require('../config/database');
const logger = require('../utils/logger');

let webpush = null;
let vapidKeys = null;

// Lazy-init web-push (optional dep)
function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
    // Load or generate VAPID keys
    const stored = queryOne('SELECT value FROM kv_store WHERE key=?', ['vapid_keys']);
    if (stored) {
      vapidKeys = JSON.parse(stored.value);
    } else {
      vapidKeys = webpush.generateVAPIDKeys();
      try {
        run('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)');
        run('INSERT OR REPLACE INTO kv_store(key,value) VALUES(?,?)', ['vapid_keys', JSON.stringify(vapidKeys)]);
      } catch(e) { logger.warn('[push] Could not persist VAPID keys:', e.message); }
      logger.info('[push] Generated new VAPID keys');
    }
    webpush.setVapidDetails(
      'mailto:admin@chatapp.local',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
    return webpush;
  } catch(e) {
    logger.warn('[push] web-push not available:', e.message);
    return null;
  }
}

// Init push subscriptions table
function ensureTable() {
  try {
    run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, endpoint)
    )`);
  } catch(e) {}
}

ensureTable();

// GET /api/push/vapid-key — return public VAPID key
router.get('/push/vapid-key', (req, res) => {
  const wp = getWebPush();
  if (!wp || !vapidKeys) {
    return res.status(503).json({ error: 'Push notifications tidak tersedia. Install: npm install web-push' });
  }
  res.json({ publicKey: vapidKeys.publicKey });
});

// POST /api/push/subscribe — save subscription
router.post('/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Data subscription tidak valid' });
  }
  const { v4: uuidv4 } = require('uuid');
  try {
    run(`INSERT OR REPLACE INTO push_subscriptions(id, user_id, endpoint, p256dh, auth, user_agent)
      VALUES(?, ?, ?, ?, ?, ?)`,
      [uuidv4(), req.user.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, req.headers['user-agent'] || '']
    );
    logger.info('[push] Subscription saved', { userId: req.user.id });
    res.json({ ok: true });
  } catch(e) {
    logger.error('[push] Save subscription error:', e.message);
    res.status(500).json({ error: 'Gagal menyimpan subscription' });
  }
});

// DELETE /api/push/unsubscribe
router.delete('/push/unsubscribe', requireAuth, (req, res) => {
  try {
    run('DELETE FROM push_subscriptions WHERE user_id=?', [req.user.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Gagal' });
  }
});

// Helper: send push to a user (used internally by socket/broker)
async function sendPushToUser(userId, payload) {
  const wp = getWebPush();
  if (!wp) return;
  const subs = query('SELECT * FROM push_subscriptions WHERE user_id=?', [userId]);
  for (const sub of subs) {
    try {
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60 }
      );
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription expired — remove it
        run('DELETE FROM push_subscriptions WHERE endpoint=?', [sub.endpoint]);
        logger.info('[push] Removed expired subscription', { userId });
      } else {
        logger.warn('[push] Send error:', e.message);
      }
    }
  }
}

// Helper: broadcast push to all users (system broadcast)
async function sendPushBroadcast(payload) {
  const wp = getWebPush();
  if (!wp) return;
  const subs = query('SELECT * FROM push_subscriptions', []);
  for (const sub of subs) {
    try {
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 3600 }
      );
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        run('DELETE FROM push_subscriptions WHERE endpoint=?', [sub.endpoint]);
      }
    }
  }
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.sendPushBroadcast = sendPushBroadcast;
