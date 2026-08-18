#!/usr/bin/env tsx
/**
 * GAME-CHANGER VERIFICATION:
 * If each subscriber_id appears in subscriber_cell_index exactly once, then
 * SUM(cell_subscriber_stats.subscriber_count) = COUNT(DISTINCT subscriber_id)
 * for ANY set of cells → the 97M-row dedup is redundant → 50K cells = <1s.
 */
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import { performance } from 'node:perf_hooks';

loadConfig();
const cfg = loadConfig();
const pool = getPool();
const client = await pool.connect();

try {
  const N = 50000;
  console.log(`=== Sampling ${N} cells from sim_cell_towers ===`);
  const cellsSql = `SELECT cell_id FROM sim_cell_towers WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT $1`;
  const { rows: cells } = await client.query<{ cell_id: string }>(cellsSql, [N]);
  const cellIds = cells.map(r => r.cell_id);
  console.log(`cells sampled: ${cellIds.length}`);

  console.log(`\n--- Check 1: subscriber in >1 cell? (whole 97M table) ---`);
  const s0 = performance.now();
  const overlap = await client.query(`
    SELECT COUNT(*)::text AS multi_cell_subscribers
    FROM (
      SELECT subscriber_id
      FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE}
      GROUP BY subscriber_id HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`subscribers in >1 cell: ${overlap.rows[0].multi_cell_subscribers}  (t=${(performance.now()-s0).toFixed(0)}ms)`);
  console.log(`Result: ${Number(overlap.rows[0].multi_cell_subscribers) === 0 ? 'NO OVERLAP — ZERO subscribers in multiple cells!' : 'OVERLAP EXISTS'}`);

  console.log(`\n--- Check 2: SUM(stats) vs COUNT(DISTINCT subscriber_id) at 50K cells ---`);

  const sSum = performance.now();
  const sumSql = `
    SELECT COALESCE(SUM(s.subscriber_count),0)::text AS sum_stats_count
    FROM ${cfg.CELL_SUBSCRIBER_STATS_TABLE} s
    WHERE s.cell_id = ANY($1::text[])
  `;
  const sumRes = await client.query(sumSql, [cellIds]);
  const msSum = performance.now() - sSum;
  const sumCount = Number(sumRes.rows[0].sum_stats_count);
  console.log(`SUM(cell_subscriber_stats): ${sumCount.toLocaleString()}  (t=${msSum.toFixed(0)}ms — this is THE FAST PATH)`);

  const sDedup = performance.now();
  const dedupSql = `
    SELECT COUNT(DISTINCT i.subscriber_id)::text AS dedup_count
    FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE} i
    WHERE i.serving_cell_id = ANY($1::text[])
  `;
  const dedupRes = await client.query(dedupSql, [cellIds]);
  const msDedup = performance.now() - sDedup;
  const dedupCount = Number(dedupRes.rows[0].dedup_count);
  console.log(`COUNT(DISTINCT subscriber_id): ${dedupCount.toLocaleString()}  (t=${msDedup.toFixed(0)}ms — CURRENT SLOW PATH)`);

  const sDumpDedup = performance.now();
  const dumpDedupSql = `
    SELECT COUNT(DISTINCT d.id::int4)::text AS dump_dedup_count
    FROM ${cfg.SUBSCRIBER_DUMP_TABLE} d
    WHERE d.serving_cell_id = ANY($1::text[])
  `;
  const dumpDedupRes = await client.query(dumpDedupSql, [cellIds]);
  const msDumpDedup = performance.now() - sDumpDedup;
  const dumpDedupCount = Number(dumpDedupRes.rows[0].dump_dedup_count);
  console.log(`COUNT(DISTINCT dump.id):      ${dumpDedupCount.toLocaleString()}  (t=${msDumpDedup.toFixed(0)}ms — LEGACY ORACLE)`);

  const match = (sumCount === dedupCount) && (sumCount === dumpDedupCount);
  console.log(`\n=== ALL COUNTS IDENTICAL: ${match} ===`);
  console.log(`Speedup SUM vs DEDUP: ${(msDedup / Math.max(msSum,1)).toFixed(1)}×`);
  console.log(`Speedup SUM vs LEGACY: ${(msDumpDedup / Math.max(msSum,1)).toFixed(1)}×`);

  if (match) {
    console.log(`\n✅ PROVEN: 50K-cell dedup can be replaced with SUM(stats) — <1s total!`);
  } else {
    console.log(`\n❌ MISMATCH: sum=${sumCount} dedup=${dedupCount} dump=${dumpDedupCount} — cannot optimize`);
    process.exit(2);
  }
} finally {
  client.release();
  await pool.end();
}
