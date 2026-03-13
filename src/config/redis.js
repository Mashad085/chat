/**
 * src/config/redis.js — Redis client via ioredis
 * Digunakan untuk: session cache, online users, rate limit data, pub-sub ringan
 */
const Redis = require('ioredis');
const logger = require('../utils/logger');

let client = null;
let subscriber = null;

async function initRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  client = new Redis(url, {
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: 3,
  });

  subscriber = new Redis(url, {
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  client.on('connect',      () => logger.info('[redis] Connected'));
  client.on('error',        (e) => logger.error('[redis] Error', { error: e.message }));
  client.on('reconnecting', () => logger.warn('[redis] Reconnecting...'));

  await client.connect();
  await subscriber.connect();

  logger.info('[redis] Client + subscriber ready');
  return { client, subscriber };
}

function getClient()     { return client; }
function getSubscriber() { return subscriber; }

// ─── HELPERS ──────────────────────────────────────────────
const Cache = {
  async set(key, value, ttlSeconds = 3600) {
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (ttlSeconds) await client.setex(key, ttlSeconds, v);
    else            await client.set(key, v);
  },
  async get(key) {
    const v = await client.get(key);
    if (!v) return null;
    try { return JSON.parse(v); } catch { return v; }
  },
  async del(key)              { return client.del(key); },
  async exists(key)           { return client.exists(key); },
  async incr(key)             { return client.incr(key); },
  async expire(key, seconds)  { return client.expire(key, seconds); },
  async keys(pattern)         { return client.keys(pattern); },
  async hset(key, field, val) { return client.hset(key, field, typeof val==='object'?JSON.stringify(val):val); },
  async hget(key, field)      { const v=await client.hget(key,field); try{return JSON.parse(v)}catch{return v} },
  async hgetall(key)          { return client.hgetall(key); },
  async hdel(key, field)      { return client.hdel(key, field); },
  async sadd(key, ...members) { return client.sadd(key, ...members); },
  async smembers(key)         { return client.smembers(key); },
  async srem(key, member)     { return client.srem(key, member); },
};

// ─── ONLINE USERS ─────────────────────────────────────────
const OnlineUsers = {
  KEY: 'online:users',
  async set(userId, data) {
    await Cache.hset(this.KEY, userId, data);
    await client.expire(this.KEY, 86400);
  },
  async remove(userId) { await Cache.hdel(this.KEY, userId); },
  async getAll() {
    const raw = await Cache.hgetall(this.KEY);
    if (!raw) return {};
    const result = {};
    for (const [k, v] of Object.entries(raw)) {
      try { result[k] = JSON.parse(v); } catch { result[k] = v; }
    }
    return result;
  },
  async count() {
    const all = await this.getAll();
    return Object.keys(all).length;
  },
};

// ─── SESSION CACHE ────────────────────────────────────────
const SessionCache = {
  async set(token, userData) { await Cache.set(`session:${token}`, userData, 86400); },
  async get(token)            { return Cache.get(`session:${token}`); },
  async del(token)            { return Cache.del(`session:${token}`); },
};

module.exports = { initRedis, getClient, getSubscriber, Cache, OnlineUsers, SessionCache };
