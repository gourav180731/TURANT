#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

async function main(): Promise<void> {
  loadConfig();
  const p = getPool();
  try {
    const kills = [28372, 4068, 39640];
    for (const pid of kills) {
      try {
        const r = await p.query(
          `SELECT pg_terminate_backend($1) killed, state, LEFT(query,80) q
           FROM pg_stat_activity WHERE pid=$1`,
          [pid],
        );
        console.log(
          'pid=%s killed=%s state=%s q=%s',
          pid, r.rows[0]?.killed, r.rows[0]?.state, r.rows[0]?.q ?? 'nf',
        );
      } catch (e) { console.log('pid=' + pid + ' err: ' + e.message); }
    }
    const alive = await p.query(
      `SELECT pid, state, TO_CHAR(now()-query_start,'HH24:MI:SS') age, LEFT(query,120) q
       FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state<>'idle'
       ORDER BY age DESC`,
    );
    console.log('\nRemaining active sessions:');
    console.table(alive.rows);

    console.log('\n=== Stats table quick check ===');
    const sc = await p.query('SELECT COUNT(*) c, COALESCE(SUM(subscriber_count),0) s FROM cell_subscriber_stats');
    console.log('cell_subscriber_stats: count=%s sum=%s', sc.rows[0].c, sc.rows[0].s);
    const pc = await p.query('SELECT COUNT(*) c FROM cell_postings');
    console.log('cell_postings: count=%s', pc.rows[0].c);
    const ic = await p.query('SELECT COUNT(*) c FROM subscriber_cell_index LIMIT 1');
    console.log('subscriber_cell_index: ~%s rows (LIMIT 1 probe only)', ic.rows[0].c > 0 ? '97M+' : '0');
  } finally {
    await p.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
