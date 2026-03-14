/**
 * src/services/broker.js
 * Hybrid broker: RabbitMQ jika tersedia, fallback ke in-process EventEmitter
 * Interface identik di kedua mode - kode lain tidak perlu berubah
 */
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const TOPICS = {
  CHAT_MESSAGE:'chat.message', CHAT_TYPING:'chat.typing', CHAT_READ:'chat.read',
  USER_STATUS:'user.status',   USER_LOGIN:'user.login',   USER_LOGOUT:'user.logout',
  USER_BANNED:'user.banned',   ADMIN_ACTION:'admin.action',
  SYSTEM_ALERT:'system.alert', SYSTEM_BROADCAST:'system.broadcast',
};

// ─── STATE ────────────────────────────────────────────────
let amqpConnection = null, publishCh = null, consumeCh = null;
let useAmqp = false;
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const eventHandlers = new Map();
const stats = { published: 0, consumed: 0, errors: 0, topics: {}, mode: 'initializing' };
let adminFeed = [];

// ─── INIT ─────────────────────────────────────────────────
async function initBroker() {
  try {
    const amqplib = require('amqplib');
    const url = process.env.RABBITMQ_URL || 'amqp://localhost';
    amqpConnection = await amqplib.connect(url);

    publishCh = await amqpConnection.createChannel();
    consumeCh = await amqpConnection.createChannel();
    await consumeCh.prefetch(10);

    const EX_TOPIC  = 'chatapp.topic';
    const EX_FANOUT = 'chatapp.fanout';
    await publishCh.assertExchange(EX_TOPIC,  'topic',  { durable: true });
    await publishCh.assertExchange(EX_FANOUT, 'fanout', { durable: true });

    const queues = ['q.chat','q.audit','q.notifications','q.admin'];
    for (const q of queues) await consumeCh.assertQueue(q, { durable: true });
    await consumeCh.bindQueue('q.chat',  EX_TOPIC, 'chat.#');
    await consumeCh.bindQueue('q.audit', EX_TOPIC, 'user.#');
    await consumeCh.bindQueue('q.audit', EX_TOPIC, 'admin.#');
    await consumeCh.bindQueue('q.notifications', EX_TOPIC, 'user.#');
    await consumeCh.bindQueue('q.admin', EX_TOPIC, '#');
    await consumeCh.bindQueue('q.admin', EX_FANOUT, '');

    queues.forEach(q => _startAmqpConsumer(q));
    useAmqp = true;
    stats.mode = 'rabbitmq';
    logger.info('[broker] Mode: RabbitMQ ✅');
    amqpConnection.on('error', () => { useAmqp = false; stats.mode = 'in-process (rmq error)'; });
  } catch (e) {
    useAmqp = false;
    stats.mode = 'in-process (fallback)';
    logger.warn('[broker] RabbitMQ unavailable, using in-process broker', { reason: e.message });
  }
}

// ─── PUBLISH ─────────────────────────────────────────────
function publish(topic, payload, publisherId = 'system') {
  const event = { id: uuidv4(), topic, payload, publisherId, timestamp: Date.now() };
  stats.published++;
  stats.topics[topic] = (stats.topics[topic] || 0) + 1;
  adminFeed.push(event);
  if (adminFeed.length > 200) adminFeed.shift();

  if (useAmqp && publishCh) {
    try {
      const buf = Buffer.from(JSON.stringify(event));
      publishCh.publish('chatapp.topic', topic, buf, { persistent: true });
      if (topic === TOPICS.SYSTEM_BROADCAST)
        publishCh.publish('chatapp.fanout', '', buf, { persistent: true });
      return event;
    } catch (e) { stats.errors++; }
  }

  // In-process fallback: dispatch immediately
  _dispatch(event);
  return event;
}

// ─── SUBSCRIBE ───────────────────────────────────────────
function subscribe(topic, handler) {
  if (!eventHandlers.has(topic)) eventHandlers.set(topic, []);
  eventHandlers.get(topic).push(handler);
  return () => {
    const arr = eventHandlers.get(topic) || [];
    const i = arr.indexOf(handler);
    if (i > -1) arr.splice(i, 1);
  };
}

function _startAmqpConsumer(queue) {
  consumeCh.consume(queue, (msg) => {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString());
      stats.consumed++;
      _dispatch(event);
      consumeCh.ack(msg);
    } catch (e) {
      stats.errors++;
      consumeCh.nack(msg, false, false);
    }
  });
}

function _dispatch(event) {
  if (!useAmqp) stats.consumed++;
  const { topic } = event;
  (eventHandlers.get(topic) || []).forEach(h => { try { h(event); } catch (e) { stats.errors++; } });
  eventHandlers.forEach((handlers, pattern) => {
    if (pattern !== topic && _match(pattern, topic))
      handlers.forEach(h => { try { h(event); } catch {} });
  });
}

function _match(pattern, topic) {
  if (pattern === '#') return true;
  if (!pattern.includes('*') && !pattern.includes('#')) return false;
  const re = new RegExp('^' + pattern.replace(/\./g,'\\.').replace(/\*/g,'[^.]+').replace(/#/g,'.*') + '$');
  return re.test(topic);
}

// ─── STATUS ──────────────────────────────────────────────
function getBrokerStatus() {
  const topTopics = Object.entries(stats.topics)
    .sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([topic,count])=>({ topic, count }));

  const subscriptions = {};
  eventHandlers.forEach((h, t) => { subscriptions[t] = h.length; });
  const activeTopics = Object.keys(subscriptions).length;

  return {
    connected:     useAmqp || true,   // in-process is always "connected"
    mode:          stats.mode,
    published:     stats.published,
    consumed:      stats.consumed,    // FIX: tidak lagi undefined
    errors:        stats.errors,
    activeTopics,                     // FIX: tidak lagi undefined
    deadLetterCount: stats.errors,    // FIX: tidak lagi undefined
    topTopics,
    subscriptions,
    adminFeedCount: adminFeed.length,
  };
}

function getAdminFeed(limit = 50) { return adminFeed.slice(-limit).reverse(); }

async function closeBroker() {
  try {
    if (publishCh) await publishCh.close();
    if (consumeCh) await consumeCh.close();
    if (amqpConnection) await amqpConnection.close();
  } catch {}
}

module.exports = { initBroker, publish, subscribe, getBrokerStatus, getAdminFeed, closeBroker, TOPICS };
