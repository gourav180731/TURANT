import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

/**
 * Leakage + collision + performance validation for the cell-indexed matcher
 * (default `serving_cell_id = ANY($1)` path) against the 197M-row dump.
 *
 * Leakage  : every MSISDN matched from a DELHI cell set must be a Delhi row
 *            (state='Delhi') served by an actual DELHI tower — never a
 *            cross-state subscriber from the legacy (lac,cisac) era.
 * Collision: no MSISDN may appear in more than one distinct cell within the
 *            matched result (identity integrity), and total dup count = 0.
 * Perf     : EXPLAIN ANALYZE on the exact matcher SQL for Test B (1k) / D (50k).
 */
async function main() {
  loadConfig();
  const pool = getPool();

  // --- sample: 1k of the 29,727 Delhi cells (1k-cell Test B shape) ----------
  const sample = await pool.query(`
    SELECT cell_id FROM sim_cell_towers
    WHERE state='DELHI' ORDER BY cell_id LIMIT 1000`);
  const cellIds = sample.rows.map((r) => r.cell_id);
  console.log('sampled delhi cells       =', cellIds.length);
  const cellList = cellIds.map((c) => `'${c}'`).join(', ');

  // 1. Leakage: any matched row whose state != 'Delhi' or whose cell is not a
  //    DELHI tower would prove cross-state leakage.
  const leak = await pool.query(
    `SELECT COUNT(*)::text AS n
     FROM subscriber_dump s
     WHERE s.serving_cell_id IN (${cellList})
       AND (s.state IS DISTINCT FROM 'Delhi'
            OR NOT EXISTS (SELECT 1 FROM sim_cell_towers t
                           WHERE t.cell_id = s.serving_cell_id AND t.state='DELHI'))`);
  console.log('leakage rows (non-Delhi)  =', leak.rows[0].n);

  const matched = await pool.query(
    `SELECT COUNT(*)::text AS n FROM subscriber_dump
     WHERE serving_cell_id IN (${cellList})`);
  console.log('matched rows (1k cells)   =', matched.rows[0].n);

  // 2. Collision: an MSISDN living under 2+ cells in this result = duplicate
  //    identity across the matched set.
  const collision = await pool.query(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT s.msisdn FROM subscriber_dump s
       WHERE s.serving_cell_id IN (${cellList})
       GROUP BY s.msisdn HAVING COUNT(DISTINCT s.serving_cell_id) > 1
     ) x`);
  console.log('msisdn->multi-cell collisions =', collision.rows[0].n);

  // Global dup integrity within the matched slice.
  const dup = await pool.query(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT s.msisdn FROM subscriber_dump s
       WHERE s.serving_cell_id IN (${cellList})
       GROUP BY s.msisdn HAVING COUNT(*) > 1
     ) x`);
  console.log('duplicate msisdns (1k cells)=', dup.rows[0].n);

  // 3. EXPLAIN ANALYZE — the exact matcher query (Test B, LIMIT 100k).
  const explain = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT DISTINCT msisdn AS msisdn
     FROM subscriber_dump
     WHERE serving_cell_id = ANY($1::text[]) AND serving_cell_id IS NOT NULL AND msisdn IS NOT NULL
     LIMIT 100000`,
    [cellIds],
  );
  console.log('--- EXPLAIN ANALYZE (1k cells) ---');
  for (const r of explain.rows) console.log(r['QUERY PLAN']);

  // 4. Network-mapping bridge leakage comparison (legacy path) on same cells.
  const bridge = await pool.query(
    `WITH target AS (SELECT unnest($1::text[]) AS cell_id),
     resolved_areas AS (
       SELECT DISTINCT m.lac AS lac, m.cisac AS cisac
       FROM target t JOIN cell_network_mapping m ON m.cell_id = t.cell_id)
     SELECT COUNT(*)::text AS n, COUNT(DISTINCT s.msisdn)::text AS uniq
     FROM resolved_areas r JOIN subscriber_dump s
       ON s.lac = r.lac AND s.cisac = r.cisac`,
    [cellIds],
  );
  console.log('LEGACY BRIDGE matched =', bridge.rows[0].n, '| unique = ', bridge.rows[0].uniq);

  await closePool();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });