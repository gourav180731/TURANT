/**
 * Phase-1 profiler: EXPLAIN (ANALYZE, BUFFERS) for the CURRENT 50K-cell
 * subscriber stats query at tiers 10K / 25K / 50K. Logs to .explain-phase1.log
 * and full plans to .explain-phase1.json. Read-only; does not modify data.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

const logPath = resolve(process.cwd(), '.explain-phase1.log');
const jsonPath = resolve(process.cwd(), '.explain-phase1.json');
const pool = getPool();

function log(line: string): void {
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  // eslint-disable-next-line no-console
  console.log(line);
}

async function sampleCellIds(count: number): Promise<string[]> {
  const { rows } = await pool.query<{ cell_id: string }>(
    `SELECT cell_id FROM sim_cell_towers WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT $1`,
    [count],
  );
  return rows.map((r) => r.cell_id);
}

const TIER_SQL = `
  EXPLAIN (ANALYZE, BUFFERS, COSTS, SETTINGS, SUMMARY)
  WITH target AS (
    SELECT cell_id FROM unnest($1::text[]) AS t(cell_id)
  ),
  resolved_cells AS (
    SELECT DISTINCT serving_cell_id AS cell_id
    FROM subscriber_dump
    WHERE serving_cell_id = ANY($1::text[]) AND serving_cell_id IS NOT NULL
  ),
  agg AS (
    SELECT COUNT(*) AS matched_rows,
           COUNT(DISTINCT msisdn) AS unique_msisdns
    FROM subscriber_dump
    WHERE serving_cell_id = ANY($1::text[])
      AND serving_cell_id IS NOT NULL
      AND msisdn IS NOT NULL
  ),
  counts AS (
    SELECT (SELECT COUNT(*) FROM target)                         AS target_cells,
           (SELECT COUNT(*) FROM resolved_cells)                 AS resolved_cells,
           (SELECT COUNT(*) FROM target t
             WHERE NOT EXISTS (SELECT 1 FROM resolved_cells r
                               WHERE r.cell_id = t.cell_id))     AS unmatched_cells,
           (SELECT matched_rows FROM agg)                        AS matched_rows,
           (SELECT unique_msisdns FROM agg)                      AS unique_msisdns
  )
  SELECT * FROM counts;`;

async function main(): Promise<void> {
  writeFileSync(logPath, '');
  const cfg = loadConfig();
  log(`phase1-profiler-start table=${cfg.SUBSCRIBER_DUMP_TABLE}`);
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), tiers: [] };
  for (const tier of [10_000, 25_000, 50_000]) {
    const cells = await sampleCellIds(tier);
    log(`tier=${tier} cells=${cells.length}`);
    const started = Date.now();
    const { rows } = await pool.query(TIER_SQL, [cells]);
    const elapsedMs = Date.now() - started;
    const plan = rows[0] as { 'QUERY PLAN': string };
    const text = plan['QUERY PLAN'];
    const exec = text.match(/Execution Time:\s*([\d.]+)/)?.[1] ?? '';
    const planning = text.match(/Planning Time:\s*([\d.]+)/)?.[1] ?? '';
    const spilled = text.includes('Temporary file') ? 'YES' : 'NO';
    const heapFetches = text.match(/Heap Fetches:\s*(\d+)/g)?.join('; ') ?? 'n/a';
    const sharedRead = text.match(/Shared read:\s*([\d.]+[KMG]?)/)?.[0] ?? 'n/a';
    const sorts = text.match(/Sort Method:\s*[^\n]+/g)?.join(' | ') ?? 'none';
    const peakMem = text.match(/Peak Memory Usage:\s*(\d+)[kK]?B/g)?.join('; ') ?? 'n/a';
    report.tiers.push({
      tier,
      cells: cells.length,
      elapsedMs,
      executionMs: exec,
      planningMs: planning,
      spilled,
      heapFetches,
      sharedRead,
      sorts,
      peakMem,
    });
    log(`tier=${tier} elapsedMs=${elapsedMs} execMs=${exec} spill=${spilled} heap=${heapFetches} ${sharedRead}`);
  }
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await pool.end();
  log(`phase1-profiler-done json=${jsonPath}`);
}

if (process.argv[1]?.endsWith('explain-phase1-profiler.ts')) {
  main().catch((err) => {
    log(`phase1-error ${String(err?.message ?? err)}`);
    process.exit(1);
  });
}