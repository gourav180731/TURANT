#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

loadConfig();
const pool = getPool();
const client = await pool.connect();
try {
  const { rows } = await client.query(`
    SELECT
      pid,
      now() - query_start AS age,
      state,
      wait_event,
      wait_event_type,
      left(query, 160) AS q
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
    ORDER BY age DESC NULLS LAST
  `);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  client.release();
  await pool.end();
}
