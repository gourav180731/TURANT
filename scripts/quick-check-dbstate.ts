#!/usr/bin/env tsx
import { getPool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

const cfg = loadConfig();
const pool = getPool();

async function main() {
  const c = await pool.connect();
  try {
    console.log('=== PG_CLASS ROW ESTIMATES (instant, no scan) ===');
    const tables = [
      cfg.SUBSCRIBER_DUMP_TABLE,
      cfg.SUBSCRIBER_CELL_INDEX_TABLE,
      cfg.CELL_SUBSCRIBER_STATS_TABLE,
      cfg.CELL_POSTINGS_TABLE,
      'sim_cell_towers',
    ];
    for (const t of tables) {
      const r1 = await c.query(
        `SELECT reltuples::bigint AS est, relpages FROM pg_class WHERE relname::text = $1`,
        [t]
      );
      const r2 = await c.query(
        `SELECT pg_size_pretty(pg_relation_size($1::text)) AS sz`,
        [t]
      );
      console.log(`${t.padEnd(35)} est_rows=${String(r1.rows[0]?.est ?? 'NULL').padStart(12)} pages=${String(r1.rows[0]?.relpages ?? '?').padStart(8)} size=${r2.rows[0]?.sz ?? '?'}`);
    }
    console.log('\n=== QUICK COUNT via stats table / limit samples ===');
    // Check stats table with limit 5 to see sample data
    const st = await c.query(`SELECT * FROM ${cfg.CELL_SUBSCRIBER_STATS_TABLE} ORDER BY subscriber_count DESC LIMIT 5`);
    console.log(`${cfg.CELL_SUBSCRIBER_STATS_TABLE} top 5 cells:`);
    for (const row of st.rows) console.log('  ', JSON.stringify(row));
    // Check subscriber_cell_index sample data
    const it = await c.query(`SELECT * FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE} LIMIT 5`);
    console.log(`${cfg.SUBSCRIBER_CELL_INDEX_TABLE} sample 5:`);
    for (const row of it.rows) console.log('  ', JSON.stringify(row));
    // Check cell_postings sample
    const pt = await c.query(`SELECT cell_id, array_length(subscriber_ids,1) AS arr_len FROM ${cfg.CELL_POSTINGS_TABLE} LIMIT 5`);
    console.log(`${cfg.CELL_POSTINGS_TABLE} sample 5 (cell_id, arr_len):`);
    for (const row of pt.rows) console.log('  ', JSON.stringify(row));
    
    // Now run the count queries separately: ONLY the stats + mapping (not the 191M dump COUNT)
    console.log('\n=== COUNT on optimization tables (fast, small tables) ===');
    const qs = [
      [`${cfg.CELL_SUBSCRIBER_STATS_TABLE} COUNT`, `SELECT COUNT(*)::text AS n FROM ${cfg.CELL_SUBSCRIBER_STATS_TABLE}`],
      [`${cfg.CELL_SUBSCRIBER_STATS_TABLE} SUM`, `SELECT SUM(subscriber_count)::text AS n FROM ${cfg.CELL_SUBSCRIBER_STATS_TABLE}`],
      [`${cfg.SUBSCRIBER_CELL_INDEX_TABLE} COUNT`, `SELECT COUNT(*)::text AS n FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE}`],
      [`${cfg.SUBSCRIBER_CELL_INDEX_TABLE} DISTINCT sub_id`, `SELECT COUNT(DISTINCT subscriber_id)::text AS n FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE}`],
      [`${cfg.CELL_POSTINGS_TABLE} COUNT`, `SELECT COUNT(*)::text AS n FROM ${cfg.CELL_POSTINGS_TABLE}`],
    ];
    for (const [label, sql] of qs) {
      const s = performance.now();
      const r = await c.query(sql);
      const e = performance.now() - s;
      console.log(`  ${label.padEnd(45)} = ${String(r.rows[0]?.n ?? 'NULL').padStart(12)} (${e.toFixed(0)}ms)`);
    }
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
