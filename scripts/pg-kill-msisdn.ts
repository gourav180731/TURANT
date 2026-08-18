#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

loadConfig();
const pool = getPool();
const client = await pool.connect();
try {
  const victims = await client.query<{ pid: number; q: string }>(`
    SELECT pid, left(query, 60) AS q
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND query ILIKE '%SELECT DISTINCT msisdn%'
  `);
  for (const v of victims.rows) {
    const r = await client.query(`SELECT pg_terminate_backend(${v.pid}) AS k`);
    console.log(`killed pid=${v.pid} q=${v.q} -> ${r.rows[0].k}`);
  }
  if (victims.rows.length === 0) console.log('no hanging msisdn queries to kill');

  const remain = await client.query(`
    SELECT pid, state, now()-query_start AS age, left(query, 60) AS q
    FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'
  `);
  console.log('remaining active sessions:', JSON.stringify(remain.rows, null, 2));
} finally {
  client.release();
  await pool.end();
}
