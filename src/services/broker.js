/**
 * src/services/broker.js — RabbitMQ message broker via amqplib
 *
 * Exchanges:
 *   chatapp.topic  (topic exchange) — chat.message, chat.typing, user.status, etc.
 *   chatapp.fanout (fanout)         — system broadcasts
 *
 * Queues (durable, auto-ack):
 *   q.chat         — semua chat messages
 *   q.audit        — audit events
 *   q.notifications — notifikasi user
 *   q.admin        — admin monitoring feed
 */
const amqplib = require('amqplib');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const EXCHANGE_TOPIC  = 'chatapp.topic';
const EXCHANGE_FANOUT = 'chatapp.fanout';

const QUEUES = {
  CHAT:          'q.chat',
  AUDIT:         'q.audit',
  NOTIFICATIONS: 'q.notifications',
  ADMIN:         'q.admin',
};

const TOPICS = {
  CHAT_MESSAGE:  'chat.message',
  CHAT_TYPING:   'chat.typing',
  CHAT_READ:     'chat.read',
  USER_STATUS:   'user.status',
  USER_LOGIN:    'user.login',
  USER_LOGOUT:   'user.logout',
  USER_BANNED:   'user.banned',
  ADMIN_ACTION:  'admin.action',
  SYSTEM_ALERT:  'system.alert',
  SYSTEM_BROADCAST: 'system.broadcast',
};

// ─── STATE ────────────────────────────────────────────────
let connection = null;
let publishChannel = null;
let consumeChannel = null;
const eventHandlers = new Map();   // topic -> [handler]
const stats = { published: 0, consumed: 0, errors: 0, topics: {} };
let adminFeed = [];                // circular buffer untuk admin panel

async function initBroker() {
  const url = process.env.RABBITMQ_URL || 'amqp://localhost';
  try {
    connection = await amqplib.connect(url);
    logger.info('[broker] RabbitMQ connected');

    connection.on('error', (e) => { logger.error('[broker] Connection error', { error: e.message }); });
    connection.on('close', () => { logger.warn('[broker] Connection closed'); });

    // Publish channel
    publishChannel = await connection.createChannel();
    await publishChannel.assertExchange(EXCHANGE_TOPIC,  'topic',  { durable: true });
    await publishChannel.assertExchange(EXCHANGE_FANOUT, 'fanout', { durable: true });

    // Consume channel
    consumeChannel = await connection.createChannel();
    await consumeChannel.prefetch(10);

    // Assert all queues
    for (const q of Object.values(QUEUES)) {
      await consumeChannel.assertQueue(q, { durable: true });
    }

    // Bind queues to exchanges
    await consumeChannel.bindQueue(QUEUES.CHAT,          EXCHANGE_TOPIC,  'chat.#');
    await consumeChannel.bindQueue(QUEUES.AUDIT,         EXCHANGE_TOPIC,  'user.#');
    await consumeChannel.bindQueue(QUEUES.AUDIT,         EXCHANGE_TOPIC,  'admin.#');
    await consumeChannel.bindQueue(QUEUES.NOTIFICATIONS, EXCHANGE_TOPIC,  'user.#');
    await consumeChannel.bindQueue(QUEUES.ADMIN,         EXCHANGE_TOPIC,  '#');
    await consumeChannel.bindQueue(QUEUES.ADMIN,         EXCHANGE_FANOUT, '');

    // Start consuming
    _startConsumer(QUEUES.CHAT,          'chat');
    _startConsumer(QUEUES.AUDIT,         'audit');
    _startConsumer(QUEUES.NOTIFICATIONS, 'notifications');
    _startConsumer(QUEUES.ADMIN,         'admin');

    logger.info('[broker] Exchanges, queues, bindings ready');
  } catch (e) {
    logger.error('[broker] Init failed', { error: e.message });
    throw e;
  }
}

// ─── PUBLISH ─────────────────────────────────────────────
function publish(topic, payload, publisherId = 'system') {
  if (!publishChannel) { logger.warn('[broker] publish called before init'); return null; }

  const event = {
    id: uuidv4(),
    topic,
    payload,
    publisherId,
    timestamp: Date.now(),
  };

  try {
    const buf = Buffer.from(JSON.stringify(event));
    // Topic exchange
    publishChannel.publish(EXCHANGE_TOPIC, topic, buf, { persistent: true, contentType: 'application/json' });
    // Also fanout for system.broadcast
    if (topic === TOPICS.SYSTEM_BROADCAST) {
      publishChannel.publish(EXCHANGE_FANOUT, '', buf, { persistent: true });
    }

    stats.published++;
    stats.topics[topic] = (stats.topics[topic] || 0) + 1;

    // Admin feed (circular, last 200)
    adminFeed.push({ ...event, receivedAt: Date.now() });
    if (adminFeed.length > 200) adminFeed.shift();

    logger.debug('[broker] Published', { topic, publisherId, eventId: event.id });
    return event;
  } catch (e) {
    stats.errors++;
    logger.error('[broker] Publish error', { topic, error: e.message });
    return null;
  }
}

// ─── SUBSCRIBE (in-process handlers) ─────────────────────
function subscribe(topic, handler) {
  if (!eventHandlers.has(topic)) eventHandlers.set(topic, []);
  eventHandlers.get(topic).push(handler);
  return () => {
    const arr = eventHandlers.get(topic) || [];
    const i = arr.indexOf(handler);
    if (i > -1) arr.splice(i, 1);
  };
}

// ─── CONSUMER ────────────────────────────────────────────
function _startConsumer(queue, tag) {
  consumeChannel.consume(queue, (msg) => {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString());
      stats.consumed++;
      _dispatch(event);
      consumeChannel.ack(msg);
    } catch (e) {
      stats.errors++;
      logger.error('[broker] Consumer parse error', { queue, error: e.message });
      consumeChannel.nack(msg, false, false); // discard
    }
  }, { consumerTag: `chatapp.${tag}` });
}

function _dispatch(event) {
  const { topic } = event;

  // Exact match
  const exact = eventHandlers.get(topic) || [];
  exact.forEach(h => { try { h(event); } catch (e) { logger.error('[broker] Handler error', { topic, error: e.message }); } });

  // Wildcard match (e.g. 'chat.*', '#')
  eventHandlers.forEach((handlers, pattern) => {
    if (pattern !== topic && _matchPattern(pattern, topic)) {
      handlers.forEach(h => { try { h(event); } catch {} });
    }
  });
}

function _matchPattern(pattern, topic) {
  // AMQP-style: * matches one word, # matches zero or more
  const re = new RegExp('^' +
    pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+').replace(/#/g, '.*') + '$');
  return re.test(topic);
}

// ─── STATUS ──────────────────────────────────────────────
function getBrokerStatus() {
  const topTopics = Object.entries(stats.topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  const subs = {};
  eventHandlers.forEach((handlers, topic) => { subs[topic] = handlers.length; });

  return {
    connected: !!connection,
    published: stats.published,
    consumed:  stats.consumed,
    errors:    stats.errors,
    topTopics,
    subscriptions: subs,
    adminFeedCount: adminFeed.length,
  };
}

function getAdminFeed(limit = 50) {
  return adminFeed.slice(-limit).reverse();
}

async function closeBroker() {
  try {
    if (publishChannel) await publishChannel.close();
    if (consumeChannel) await consumeChannel.close();
    if (connection)     await connection.close();
    logger.info('[broker] Closed');
  } catch (e) { logger.warn('[broker] Close error', { error: e.message }); }
}

module.exports = { initBroker, publish, subscribe, getBrokerStatus, getAdminFeed, closeBroker, TOPICS, QUEUES };
