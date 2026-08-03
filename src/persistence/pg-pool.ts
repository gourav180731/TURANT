import pg from 'pg';
import { loadConfig } from '../config/env.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * PostgreSQL / PostGIS connection pool.
 *
 * Lazily created on first use so the process can start without a DB when no
 * connection string is configured (e.g. parser-only environments). Once C-DOT
 * provides DATABASE_URL, no code change is required.
 */
export function getPool(): pg.Pool {
  if (pool) return pool;

  const cfg = loadConfig();
  if (!cfg.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured. Add the real C-DOT PostGIS connection string to .env.');
  }

  pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.PG_POOL_MAX,
    idleTimeoutMillis: cfg.PG_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: cfg.PG_POOL_CONNECTION_TIMEOUT_MS,
  });

  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg-pool] idle client error:', err.message);
  });

  return pool;
}

export function hasPool(): boolean {
  return pool !== null;
}

/** One-off connectivity check; returns a human-readable failure reason. */
export async function pingPool(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await getPool().query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
