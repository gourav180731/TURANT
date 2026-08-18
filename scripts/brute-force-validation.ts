/**
 * Brute-force oracle vs optimized cell-indexed aggregation.
 *
 * Independently streams every dump row for a sample of serving cells and
 * computes the counts in Node (per-row JS), then compares against the
 * optimized single-statement `matchCells` aggregate. The two must agree EXACTLY
 * — same identity set, same row count, same distinct-MSDN count.
 *
 *   - default sample: 100 cells (light, ~330k rows streamed)
 *   - BRUTE_CELLS=1000  → heavier cross-check (3.3M rows)
 *
 * Writes `.brute-force-validation.json` + `.brute-force-validation.md`.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import { PostgresSubscriberCellMatcher } from '../src/telecom/matcher/subscriber-cell-matcher.js';

const logPath = resolve(process.cwd(), '.brute-force.log');
const jsonPath = resolve(process.cwd(), '.brute-force-validation.json');
const mdPath = resolve(process.cwd(), '.brute-force-validation.md');

function log(line: string): void {
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Independent oracle: per-cell index scans, per-row JS counting, global JS dedup. */
async function bruteForceCounts(cellIds: readonly string[], table: string, colCell: string, colMsisdn: string): Promise<{ rows: number; unique: number; ms: number }> {
  const pool = getPool();
  const started = performance.now();
  const uniqueSet = new Set<string>();
  let rows = 0;
  for (const cell of cellIds) {
    const { rows: cellRows } = await pool.query<Record<string, string>>(
      `SELECT ${colMsisdn} AS msisdn FROM ${table} WHERE ${colCell} = $1 AND ${colCell} IS NOT NULL AND ${colMsisdn} IS NOT NULL`,
      [cell],
    );
    rows += cellRows.length;
    for (const r of cellRows) uniqueSet.add(r.msisdn);
  }
  return { rows, unique: uniqueSet.size, ms: performance.now() - started };
}

async function sampleCellIds(count: number): Promise<string[]> {
  const cfg = loadConfig();
  const pool = getPool();
  const { rows } = await pool.query<{ cell_id: string }>(
    `SELECT cell_id FROM sim_cell_towers WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT $1`,
    [count],
  );
  return rows.map((r) => r.cell_id);
}

async function main(): Promise<void> {
  writeFileSync(logPath, '');
  const cfg = loadConfig();
  const count = Number(process.env.BRUTE_CELLS ?? 100);
  const cells = await sampleCellIds(count);
  log(`brute-force cells=${cells.length} table=${cfg.SUBSCRIBER_DUMP_TABLE}`);

  const matcher = new PostgresSubscriberCellMatcher(cfg);
  const optimized = await matcher.matchCells(cells, { alertId: 'brute-vs-opt' });
  log(`optimized rows=${optimized.subscriberMatchCount} unique=${optimized.uniqueMsisdnCount} ms=${Math.round(optimized.elapsedMs)}`);

  const bf = await bruteForceCounts(cells, cfg.SUBSCRIBER_DUMP_TABLE, cfg.SUBSCRIBER_DUMP_CELL_COL, cfg.SUBSCRIBER_DUMP_MSISDN_COL);
  log(`brute     rows=${bf.rows} unique=${bf.unique} ms=${Math.round(bf.ms)}`);

  const rowMatch = optimized.subscriberMatchCount === bf.rows;
  const uniqueMatch = optimized.uniqueMsisdnCount === bf.unique;
  const pass = rowMatch && uniqueMatch;

  const report = {
    generatedAt: new Date().toISOString(),
    cells,
    cellsCount: cells.length,
    table: cfg.SUBSCRIBER_DUMP_TABLE,
    optimized: { subscriberMatchCount: optimized.subscriberMatchCount, uniqueMsisdnCount: optimized.uniqueMsisdnCount, elapsedMs: Math.round(optimized.elapsedMs) },
    bruteForce: { rows: bf.rows, unique: bf.unique, elapsedMs: Math.round(bf.ms) },
    rowCountIdentical: rowMatch,
    uniqueMsisdnIdentical: uniqueMatch,
    pass,
  };
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    mdPath,
    [
      '# Brute-force vs Optimized (cell-indexed)',
      '',
      `Generated: ${report.generatedAt}`,
      `Sample: **${cells.length}** cells over \`${report.table}\``,
      '',
      '| Measure | Optimized (SQL agg) | Brute force (JS per-row) | Identical |',
      '|---|---:|---:|---|',
      `| Matched rows | ${report.optimized.subscriberMatchCount} | ${report.bruteForce.rows} | ${rowMatch} |`,
      `| Distinct MSISDN | ${report.optimized.uniqueMsisdnCount} | ${report.bruteForce.unique} | ${uniqueMatch} |`,
      `| Elapsed | ${report.optimized.elapsedMs} ms | ${report.bruteForce.elapsedMs} ms | — |`,
      '',
      `**Result: ${pass ? 'PASS — identical identity set & counts.' : 'FAIL — mismatch!'}**`,
      '',
    ].join('\n'),
  );
  log(`pass=${pass} json=${jsonPath} md=${mdPath}`);
  if (!pass) process.exit(2);
}

if (process.argv[1]?.endsWith('brute-force-validation.ts')) {
  main().catch((err) => {
    log(`brute-force-failed ${String(err?.message ?? err)}`);
    process.exit(1);
  });
}