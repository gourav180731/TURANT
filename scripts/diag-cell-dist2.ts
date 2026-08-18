import { appendFileSync } from 'node:fs';
import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

const LOG = 'C:/Users/91958/OneDrive/Desktop/TURANT/.diag-cell-dist.log';
const log = (s: string) => appendFileSync(LOG, s + '\n');

loadConfig();
const pool = getPool();

async function main() {
  const t0 = performance.now();
  log(`probe start ${new Date().toISOString()}`);

  // Per-cell distribution over the mapped Delhi rows.
  // Uses idx_subscriber_dump_serving_cell (index-only) — no state filter needed
  // because expansion rows (serving_cell_id IS NOT NULL) are all Delhi.
  const t1 = performance.now();
  const dist = await pool.query(`
    WITH per_cell AS (
      SELECT serving_cell_id, COUNT(*) AS n
      FROM subscriber_dump
      WHERE serving_cell_id IS NOT NULL
      GROUP BY serving_cell_id
    )
    SELECT
      COUNT(*) AS cells,
      MIN(n) AS min_c,
      MAX(n) AS max_c,
      AVG(n) AS avg_c,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY n) AS p50,
      percentile_cont(0.9)  WITHIN GROUP (ORDER BY n) AS p90,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY n) AS p99,
      stddev(n) AS stddev_c
    FROM per_cell`);
  log(`per-cell stats (${((performance.now()-t1)/1000).toFixed(1)}s): ${JSON.stringify(dist.rows[0])}`);

  // Histogram buckets of 200 wide.
  const t2 = performance.now();
  const hist = await pool.query(`
    WITH per_cell AS (
      SELECT serving_cell_id, COUNT(*) AS n
      FROM subscriber_dump
      WHERE serving_cell_id IS NOT NULL
      GROUP BY serving_cell_id
    )
    SELECT width_bucket(n, 0, 5000, 25) AS bucket, COUNT(*) AS cells, MIN(n) AS lo, MAX(n) AS hi
    FROM per_cell
    GROUP BY bucket ORDER BY bucket`);
  log(`histogram (${((performance.now()-t2)/1000).toFixed(1)}s):`);
  for (const r of hist.rows) log(`  bucket ${String(r.bucket).padStart(3)} (${String(r.lo).padStart(5)}-${String(r.hi).padStart(5)}): ${r.cells} cells`);

  // Uniformity check: how many cells share the exact modal/avg count.
  const t3 = performance.now();
  const unif = await pool.query(`
    WITH per_cell AS (
      SELECT serving_cell_id, COUNT(*) AS n
      FROM subscriber_dump
      WHERE serving_cell_id IS NOT NULL
      GROUP BY serving_cell_id
    ),
    avg AS (SELECT AVG(n) AS a FROM per_cell)
    SELECT
      COUNT(*) FILTER (WHERE n = 3278 OR n = 3279) AS cells_at_3278_3279,
      COUNT(*) FILTER (WHERE n = ROUND((SELECT a FROM avg))) AS cells_at_avg,
      COUNT(*) AS total_cells,
      (SELECT ROUND(a) FROM avg) AS avg_rounded
    FROM per_cell`);
  log(`uniformity check (${((performance.now()-t3)/1000).toFixed(1)}s): ${JSON.stringify(unif.rows[0])}`);

  // Distinct counts sanity.
  const t4 = performance.now();
  const tot = await pool.query(`
    SELECT COUNT(*) AS mapped, COUNT(DISTINCT serving_cell_id) AS cells
    FROM subscriber_dump WHERE serving_cell_id IS NOT NULL`);
  log(`mapped totals (${((performance.now()-t4)/1000).toFixed(1)}s): ${JSON.stringify(tot.rows[0])}`);

  log(`elapsed ${((performance.now()-t0)/1000).toFixed(1)}s — DONE`);
  await closePool();
  process.exit(0);
}
main().catch((e) => { log(`FAILED: ${e.message}`); console.error(e); process.exit(1); });
