/**
 * Build / rebuild the Phase-4/5 access structures (migration 010) FROM the
 * authoritative dump — never hard-coded, never independently-generated.
 *
 *   subscriber_cell_index   97,457,009 rows  (serving_cell_id, dump.id::int4)
 *   cell_subscriber_stats    29,727 rows     (per-cell COUNT(*))
 *   cell_postings            29,727 rows     (per-cell int4[] for intarray eval)
 *
 * Idempotent + resumable. CONCURRENT-safe-ish: TRUNCATE the derived tables
 * (they are derived, rebuildable caches — the authoritative data is untouched).
 *
 * Usage: npm run build:cell-access
 *   CELL_ACCESS_BUILD_ROW_LIMIT=0 (default) = full build
 *   CELL_ACCESS_BUILD_ROW_LIMIT=500000      = small smoke-runs (tests)
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import { getLogger } from '../src/utils/logger.js';

const logger = getLogger();
const pool = getPool();
const rowLimit = Number(process.env.CELL_ACCESS_BUILD_ROW_LIMIT ?? 0);
const whereLimit = rowLimit > 0 ? `AND s.id <= ${rowLimit}::bigint` : '';

function log(line: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`${ts} ${line}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const idxTable = cfg.SUBSCRIBER_CELL_INDEX_TABLE;
  const statsTable = cfg.CELL_SUBSCRIBER_STATS_TABLE;
  const postTable = cfg.CELL_POSTINGS_TABLE;
  const idCol = cfg.SUBSCRIBER_DUMP_ID_COL;
  const cellCol = cfg.SUBSCRIBER_DUMP_CELL_COL;
  if (rowLimit > 0) log(`SMOKE-BUILD rowLimit=${rowLimit}`);

  const t0 = Date.now();
  log(`build-start ${idxTable} mode=${cfg.SUBSCRIBER_CELL_ACCESS_MODE}`);

  // ---- 1. mapping table (resumable: clear then repopulate; derived cache) ----
  log('step=truncate mapping');
  await pool.query(`TRUNCATE ${idxTable}, ${statsTable}, ${postTable}`);
  log('step=populate mapping (INSERT ... SELECT serving_cell_id, id)');
  await pool.query(`
    INSERT INTO ${idxTable} (serving_cell_id, subscriber_id)
    SELECT serving_cell_id, ${idCol}::int4
    FROM subscriber_dump d
    WHERE serving_cell_id IS NOT NULL ${whereLimit};
  `);
  log(`step=mapping-rows check`);
  const mappingRows = Number((await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${idxTable}`)).rows[0]?.n ?? 0);
  log(`step=mapping rows=${mappingRows}`);

  // ---- 2. per-cell stats (COUNT(*) from the dump = DB-derived, no fabrication)
  log('step=populate stats');
  await pool.query(`
    INSERT INTO ${statsTable} (cell_id, subscriber_count, unique_subscriber_count)
    SELECT serving_cell_id, COUNT(*), COUNT(*)
    FROM subscriber_dump
    WHERE serving_cell_id IS NOT NULL ${whereLimit}
    GROUP BY serving_cell_id;
  `);
  const st = await pool.query<{ cells: string; sum: string }>(
    `SELECT COUNT(*)::text AS cells, COALESCE(SUM(subscriber_count),0)::text AS sum FROM ${statsTable}`,
  );
  log(`step=stats cells=${st.rows[0]?.cells} sum=${st.rows[0]?.sum}`);

  // ---- 3. intarray postings (VERSION D) ----
  log('step=populate postings');
  await pool.query(`
    INSERT INTO ${postTable} (cell_id, subscriber_ids)
    SELECT serving_cell_id, array_agg(${idCol}::int4 ORDER BY ${idCol})
    FROM subscriber_dump
    WHERE serving_cell_id IS NOT NULL ${whereLimit}
    GROUP BY serving_cell_id;
  `);

  // ---- 4. CLUSTER mapping by (serving_cell_id, subscriber_id) so per-cell
  // scans are physically sequential; ANALYZE everything.
  if (rowLimit === 0) {
    log('step=cluster mapping (one-time physical sort)');
    await pool.query(`CLUSTER ${idxTable} USING ${idxTable}_pkey`);
  }
  await pool.query(`ANALYZE ${idxTable}`);
  await pool.query(`ANALYZE ${statsTable}`);
  await pool.query(`ANALYZE ${postTable}`);

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  log(`build-done rows=${mappingRows} elapsedS=${elapsedS}`);
}

if (process.argv[1]?.endsWith('build-cell-subscriber-access.ts')) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      logger.error({ err: String(err?.message ?? err) }, 'cell.access.build.failed');
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}