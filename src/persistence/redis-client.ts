import { Redis } from 'ioredis';
import { loadConfig } from '../config/env.js';

let client: Redis | null = null;

/**
 * Redis client used by the subscriber prefetch layer (module 03) and pipeline
 * coordination (module 13). Lazily connected on first use.
 */
export function getRedis(): Redis {
  if (client) return client;

  const cfg = loadConfig();
  if (!cfg.REDIS_URL) {
    throw new Error('REDIS_URL is not configured. Add the real C-DOT Redis endpoint to .env.');
  }

  client = new Redis(cfg.REDIS_URL, {
    keyPrefix: cfg.REDIS_KEY_PREFIX,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  return client;
}

export function hasRedis(): boolean {
  return client !== null;
}

export async function pingRedis(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await getRedis().ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
