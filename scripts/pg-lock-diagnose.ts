#!/usr/bin/env tsx
/**
 * PostgreSQL lock & session diagnostics.
 * Checks for blocking sessions (especially AccessExclusiveLock waits on
 * subscriber_cell_index / cell_subscriber_stats / cell_postings during TRUNCATE).
 */
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

async function main(): Promise<void> {
  loadConfig();
  const pool = getPool();
  try {
    // ---- pg_stat_activity (long-running / idle in transaction) ----
    console.log('\n=== pg_stat_activity: non-idle sessions ===');
    const act = await pool.query(`
      SELECT pid, usename, state, wait_event_type, wait_event,
             TO_CHAR(now()-query_start, 'HH24:MI:SS') AS q_age,
             LEFT(query, 120) AS query_preview
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state <> 'idle'
      ORDER BY query_start ASC
    `);
    console.table(act.rows);

    // ---- Blocking locks ----
    console.log('\n=== pg_locks: granted + waiting (filtered to our 3 tables) ===');
    const locks = await pool.query(`
      SELECT
        l.pid,
        c.relname,
        l.mode,
        CASE l.granted WHEN true THEN 'GRANTED' ELSE 'WAITING' END AS g,
        a.state AS sess_state,
        TO_CHAR(now()-a.query_start, 'HH24:MI:SS') AS q_age,
        LEFT(a.query, 100) AS q
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE c.relname IN ('subscriber_cell_index','cell_subscriber_stats','cell_postings','subscriber_dump','sim_cell_towers')
         OR c.relname LIKE '%subscriber%index%' OR c.relname LIKE '%cell%subscriber%'
      ORDER BY c.relname, g DESC, l.mode DESC
    `);
    console.table(locks.rows);

    // ---- Blocking chains ----
    console.log('\n=== pg_blocking_pids: blocker → blocked pid chains ===');
    const chains = await pool.query(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, state,
             TO_CHAR(now()-query_start, 'HH24:MI:SS') AS age,
             LEFT(query, 80) AS q
      FROM pg_stat_activity
      WHERE cardinality(pg_blocking_pids(pid)) > 0
      ORDER BY age DESC
    `);
    console.table(chains.rows);

    if (chains.rows.length > 0) {
      console.log('\n--- Suggested resolution — issue:  SELECT pg_terminate_backend(<blocker_pid>); ---');
    }

    // ---- Existing row counts for our 3 tables ----
    console.log('\n=== Rows in target tables (pg_class.reltuples, instant) ===');
    const counts = await pool.query(`
      SELECT relname, reltuples::bigint AS est_rows, relpages
      FROM pg_class
      WHERE relname::text IN ('subscriber_dump','subscriber_cell_index','cell_subscriber_stats','cell_postings','sim_cell_towers')
      ORDER BY relname
    `);
    console.table(counts.rows);

  } finally {
    await pool.end();
  }
}
main().catch(err => {
  console.error('DIAG FAILED:', String(err?.message ?? err));
  process.exit(1);
});
