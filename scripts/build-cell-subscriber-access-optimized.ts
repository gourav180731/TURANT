#!/usr/bin/env tsx
/**
 * Optimized continuation of build-cell-subscriber-access.ts.
 *
 * RATIONALE: The original build script scans subscriber_dump (37 GB) THREE times:
 *   Step 1: INSERT INTO subscriber_cell_index FROM dump  (already running/done)
 *   Step 2: INSERT INTO cell_subscriber_stats  GROUP BY FROM dump  (1.5h estimate)
 *   Step 3: INSERT INTO cell_postings          GROUP BY FROM dump  (1.5h estimate)
 *
 * THIS SCRIPT replaces steps 2 and 3 by reading from subscriber_cell_index
 * which already contains ALL (serving_cell_id, subscriber_id) pairs in a
 * 5.4 GB compact table — saving 2× full scans of the 37 GB dump.
 *
 * Run AFTER step 1 (subscriber_cell_index INSERT) has committed.
 * Then optionally CLUSTER + ANALYZE (or skip CLUSTER for fast benchmarks).
 */
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import { getLogger } from '../src/utils/logger.js';

const logger = getLogger();
const pool = getPool();

function log(line: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} ${line}`);
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  const s = Date.now();
  log(`start: ${label}`);
  await fn();
  log(`done:  ${label}  (${(Date.now() - s) / 1000}s)`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const idxTable = cfg.SUBSCRIBER_CELL_INDEX_TABLE;
  const statsTable = cfg.CELL_SUBSCRIBER_STATS_TABLE;
  const postTable = cfg.CELL_POSTINGS_TABLE;
  const skipCluster = process.env.SKIP_CLUSTER === '1';

  const t0 = Date.now();
  log(`optimized-build-start idx=${idxTable} stats=${statsTable} posts=${postTable} skipCluster=${skipCluster}`);

  const idxCountRes = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${idxTable}`);
  const idxRows = Number(idxCountRes.rows[0]?.n ?? 0);
  log(`source=${idxTable} rows=${idxRows}`);
  if (idxRows === 0) {
    throw new Error(`${idxTable} is EMPTY — run step-1 INSERT first (npm run build:cell-access)`);
  }

  await step('truncate stats + postings (derived caches, safe to rebuild)', async () => {
    await pool.query(`TRUNCATE ${statsTable}, ${postTable}`);
  });

  await step('build cell_subscriber_stats (GROUP BY from subscriber_cell_index, NOT dump)', async () => {
    await pool.query(`
      INSERT INTO ${statsTable} (cell_id, subscriber_count, unique_subscriber_count)
      SELECT serving_cell_id, COUNT(*), COUNT(*)
      FROM ${idxTable}
      GROUP BY serving_cell_id;
    `);
    const st = await pool.query<{ cells: string; sum: string }>(
      `SELECT COUNT(*)::text AS cells, COALESCE(SUM(subscriber_count),0)::text AS sum FROM ${statsTable}`,
    );
    log(`  stats: cells=${st.rows[0]?.cells} sum=${st.rows[0]?.sum}`);
  });

  await step('build cell_postings int4[] (GROUP BY + array_agg from subscriber_cell_index, NOT dump)', async () => {
    await pool.query(`
      INSERT INTO ${postTable} (cell_id, subscriber_ids)
      SELECT serving_cell_id, array_agg(subscriber_id ORDER BY subscriber_id)
      FROM ${idxTable}
      GROUP BY serving_cell_id;
    `);
  });

  if (!skipCluster) {
    await step('CLUSTER subscriber_cell_index (one-time physical sort by PK)', async () => {
      await pool.query(`CLUSTER ${idxTable} USING ${idxTable}_pkey`);
    });
  } else {
    log('skip: CLUSTER (SKIP_CLUSTER=1 — for immediate benchmarking; run CLUSTER later for optimal sequential locality)');
  }

  await step('ANALYZE all 3 tables (planner statistics critical for <60s plan)', async () => {
    await pool.query(`ANALYZE ${idxTable}`);
    await pool.query(`ANALYZE ${statsTable}`);
    await pool.query(`ANALYZE ${postTable}`);
  });

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  log(`optimized-build-done sourceRows=${idxRows} elapsedS=${elapsedS}`);
}

if (process.argv[1]?.endsWith('build-cell-subscriber-access-optimized.ts')) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      logger.error({ err: String(err?.message ?? err) }, 'cell.access.build.opt.failed');
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
