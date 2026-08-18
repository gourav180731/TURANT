import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

loadConfig();
const pool = getPool();

async function main() {
  const t0 = performance.now();

  // Lightweight totals: COUNT(*) over 197M is slow without an index on
  // (state, serving_cell_id). Use the existence of the two indexes:
  //   idx_subscriber_dump_serving_cell(btree serving_cell_id)
  //   idx_subscriber_dump_state(btree state)
  // Index-only scan via EXISTS path / index count is not supported directly,
  // so we query the two most selective indexable predicates in parallel.

  const [mappedCells, cells] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) AS n, COUNT(DISTINCT serving_cell_id) AS cells
      FROM subscriber_dump
      WHERE state='Delhi' AND serving_cell_id IS NOT NULL`),
    pool.query(`SELECT COUNT(*) AS n FROM subscriber_dump WHERE state='Delhi' AND serving_cell_id IS NULL`),
  ]);
  console.log('mapped rows (Delhi, idx):', mappedCells.rows[0].n, '| mapped cells:', mappedCells.rows[0].cells);
  console.log('unmapped rows (Delhi):', cells.rows[0].n);

  // Per-cell distribution: one GROUP BY over the serving_cell index — index
  // scan is index-only (no heap fetch). Fast.
  const stats = await pool.query(`
    SELECT
      MIN(c) AS min_per_cell,
      MAX(c) AS max_per_cell,
      AVG(c) AS avg_per_cell,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c) AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY c) AS p90
    FROM (
      SELECT COUNT(*)::float AS c
      FROM subscriber_dump
      WHERE state='Delhi' AND serving_cell_id IS NOT NULL
      GROUP BY serving_cell_id
    ) x`);
  console.log('per-cell dist (all Delhi cells):', stats.rows[0]);

  // Histogram of the distribution (sample)
  const hist = await pool.query(`
    SELECT bucket, COUNT(*) AS cell_count
    FROM (
      SELECT width_bucket(c, 0) AS bucket
      FROM (
        SELECT COUNT(*) AS c
        FROM subscriber_dump
        WHERE state='Delhi' AND serving_cell_id IS NOT NULL
        GROUP BY serving_cell_id
      ) x
    ) y
    GROUP BY bucket ORDER BY bucket`);
  console.log('histogram (rows-per-cell buckets of width 200):');
  for (const row of hist.rows) process.stdout.write(`  [${Number(row.bucket)*200}-${(Number(row.bucket)+1)*200}) => ${row.cell_count} cells\n`);

  console.log('elapsed', ((performance.now() - t0)/1000).toFixed(1), 's');
  await closePool();
}
main().catch((e)=>{ console.error(e); process.exit(1); });
