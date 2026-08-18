#!/usr/bin/env tsx
/**
 * Terminate blocking sessions that are clogging the cell-access build.
 * Leaves the long-running INSERT (pid 28372).
 */
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

const LEAVE_ALIVE = new Set([28372]);  // the actual INSERT INTO subscriber_cell_index

async function main(): Promise<void> {
  loadConfig();
  const pool = getPool();
  try {
    const toKill = [37316, 30776, 4144, 36648, 41056];
    for (const pid of toKill) {
      try {
        const r = await pool.query(
          `SELECT pg_terminate_backend($1) AS killed, state, LEFT(query, 60) AS q
          FROM pg_stat_activity WHERE pid = $1`,
          [pid],
        );
        console.log(`pid=${pid} killed=${r.rows[0]?.killed} state=${r.rows[0]?.state} q=${r.rows[0]?.q ?? '(not-found)'}`);
      } catch (e) { console.log(`pid=${pid} err: ${e.message}`); }
    }
    // confirm clean
    const alive = await pool.query(`SELECT pid, state, TO_CHAR(now()-query_start,'HH24:MI:SS') age, LEFT(query,80) q
      FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state<>'idle' ORDER BY age DESC`);
    console.log('\nRemaining active sessions after cleanup:');
    console.table(alive.rows);
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
