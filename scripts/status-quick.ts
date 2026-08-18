#!/usr/bin/env tsx
/**
 * Quick status check: active PG sessions + real on-disk table sizes
 * (no COUNT(*) scans, only catalog reads).
 */
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

async function main(): Promise<void> {
  loadConfig();
  const pool = getPool();
  try {
    const act = await pool.query(`
      SELECT pid, state, wait_event_type, wait_event,
             TO_CHAR(now()-query_start, 'HH24:MI:SS') AS age,
             LEFT(query, 80) AS q
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state <> 'idle'
      ORDER BY age DESC
    `);
    console.log('=== Active PG sessions ===');
    console.table(act.rows);

    const sizes = await pool.query(`
      SELECT relname, reltuples::bigint AS est_rows, relpages,
             pg_size_pretty(pg_relation_size(c.oid)) AS real_size
      FROM pg_class c
      WHERE relname::text IN ('subscriber_dump','subscriber_cell_index',
                              'cell_subscriber_stats','cell_postings',
                              'subscriber_cell_index_pkey')
      ORDER BY relname
    `);
    console.log('=== Table sizes (on-disk) ===');
    console.table(sizes.rows);

  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
