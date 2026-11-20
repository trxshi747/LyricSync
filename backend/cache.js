const axios = require('axios');

// Two-level cache for lyrics and translations.
// - Memory: always on, bounded, lost on restart/redeploy.
// - Upstash Redis (REST): optional and persistent. Enabled when UPSTASH_REDIS_REST_URL and
//   UPSTASH_REDIS_REST_TOKEN are set. Any Redis error is ignored so the app keeps working.

const MAX_MEMORY_ENTRIES = 500;
const REDIS_TIMEOUT_MS = 2500;
const MEMORY_TTL_FOR_REMOTE_HITS_S = 60 * 60; // Remaining Redis TTL is unknown, keep remote hits in memory for 1 hour

const memory = new Map(); // key -> { value, expiresAt }

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redisCommand(command) {
  const { url, token } = redisConfig();
  const { data } = await axios.post(url, command, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REDIS_TIMEOUT_MS
  });
  return data.result;
}

function remember(key, value, ttlSeconds) {
  memory.delete(key); // Re-insert so the entry becomes the newest
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (memory.size > MAX_MEMORY_ENTRIES) {
    memory.delete(memory.keys().next().value); // Evict the oldest entry
  }
}

async function get(key) {
  const entry = memory.get(key);
  if (entry) {
    if (entry.expiresAt > Date.now()) return entry.value;
    memory.delete(key);
  }

  if (!redisConfig()) return null;
  try {
    const raw = await redisCommand(['GET', key]);
    if (!raw) return null;
    const value = JSON.parse(raw);
    remember(key, value, MEMORY_TTL_FOR_REMOTE_HITS_S);
    return value;
  } catch (e) {
    console.warn(`Cache read failed for ${key}: ${e.message}`);
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  remember(key, value, ttlSeconds);

  if (!redisConfig()) return;
  try {
    await redisCommand(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);
  } catch (e) {
    console.warn(`Cache write failed for ${key}: ${e.message}`);
  }
}

module.exports = { get, set };
