/**
 * Phase-12/13 benchmark: cell→subscriber IDENTIFICATION per access path.
 *
 * VERSION comparison:
 *   A = current matchCells on dump (serving_cell_id index, heap fetches)
 *   B = covering index (dump) INCLUDE(id)   [requires migration 010b index]
 *   C = subscriber_cell_index mapping (int4 PK, clustered)
 *   D = cell_postings intarray
 *   E = mapping + streaming (same as C; the pipeline consumes C's stream)
 *
 * One PASS (no multi-iteration; multi-iteration lives in the tier tables of
 * benchmark:subscriber-matching). Measures per tier and version:
 *   - count resolution time (uncapped)
 *   - first-batch latency (stream start)
 *   - full identification time (all numeric ids streamed, no giant Set)
 *   - ids streamed vs DB count (count-equivalence at all tiers)
 *   - identity-set equality vs the raw-dump oracle at tiers <= 5K
 *
 * Writes .benchmark-cell-access.json + .benchmark-cell-access.md
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import {
  createCellAccessPath,
  type CellAccessPath,
} from '../src/telecom/matcher/cell-access-path.js';
import { PostgresSubscriberCellMatcher } from '../src/telecom/matcher/subscriber-cell-matcher.js';
import { getLogger } from '../src/utils/logger.js';

const logger = getLogger();
const logPath = resolve(process.cwd(), '.benchmark-cell-access.log');
const jsonPath = resolve(process.cwd(), '.benchmark-cell-access.json');
const mdPath = resolve(process.cwd(), '.benchmark-cell-access.md');
const pool = getPool();

function log(line: string): void {
  const ts = new Date().toISOString();
  appendFileSync(logPath, `${ts} ${line}\n`);
  // eslint-disable-next-line no-console
  console.log(line);
}

export interface TierAccessResult {
  version: string;
  tier: number;
  requestedCells: number;
  resolvedCells: number;
  countMs: number;
  firstStreamMs: number;
  fullIdMs: number;
  idsStreamed: number;
  statsMatchedRows: number;
  countEquivalent: boolean;
  duplicatesInStream: number;
  monotonicOrdered: boolean;
  batches: number;
  nodeHeapUsedMB: number;
  identityVerified: boolean;
  missing: number;
  unexpected: number;
}

async function sampleCellIds(count: number): Promise<string[]> {
  const { rows } = await pool.query<{ cell_id: string }>(
    `SELECT cell_id FROM sim_cell_towers WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT $1`,
    [count],
  );
  return rows.map((r) => r.cell_id);
}

/** Single streaming pass. Never materializes the full id list for big tiers. */
async function streamMetrics(
  path: CellAccessPath,
  cells: readonly string[],
  batchSize: number,
  collectSet: boolean,
): Promise<{
  firstMs: number;
  totalMs: number;
  idsStreamed: number;
  duplicatesInStream: number;
  monotonicOrdered: boolean;
  batches: number;
  candidate: Set<number> | null;
}> {
  const started = performance.now();
  let firstMs: number | null = null;
  let idsStreamed = 0;
  let duplicatesInStream = 0;
  let monotonicOrdered = true;
  let prev = -1;
  let batches = 0;
  const candidate = collectSet ? new Set<number>() : null;
  const batchLocal = new Set<number>();
  for await (const b of path.streamIds(cells, batchSize)) {
    if (firstMs === null) firstMs = b.elapsedMs;
    batches += 1;
    batchLocal.clear();
    for (const id of b.ids) {
      if (id <= prev) monotonicOrdered = false;
      if (batchLocal.has(id)) duplicatesInStream += 1;
      else batchLocal.add(id);
      if (collectSet) candidate!.add(id);
      prev = id;
    }
    idsStreamed += b.ids.length;
  }
  return {
    firstMs: firstMs ?? 0,
    totalMs: performance.now() - started,
    idsStreamed,
    duplicatesInStream,
    monotonicOrdered,
    batches,
    candidate,
  };
}

async function runTier(path: CellAccessPath, version: string, tier: number): Promise<TierAccessResult> {
  const cfg = loadConfig();
  const cells = await sampleCellIds(tier);
  const batchSize = cfg.CELL_STREAM_BATCH_SIZE;
  const collectSet = tier <= 5_000;

  const t0 = performance.now();
  const stats = await path.countCells(cells);
  const countMs = performance.now() - t0;

  global.gc?.();
  const m = await streamMetrics(path, cells, batchSize, collectSet);

  const heap = process.memoryUsage().heapUsed / 1024 / 1024;
  const countEquivalent = stats.matchedRows === m.idsStreamed;

  // Identity equality vs raw-dump oracle (<= 5K keeps memory sane).
  let missing = 0;
  let unexpected = 0;
  let identityVerified = false;
  if (collectSet && m.candidate) {
    const colCell = cfg.SUBSCRIBER_DUMP_CELL_COL;
    const idCol = cfg.SUBSCRIBER_DUMP_ID_COL;
    const { rows } = await pool.query<{ sid: number }>(
      `SELECT ${idCol} AS sid FROM subscriber_dump WHERE ${colCell} = ANY($1::text[]) AND ${colCell} IS NOT NULL`,
      [cells],
    );
    const oracle = new Set<number>();
    for (const r of rows) oracle.add(r.sid);
    for (const id of m.candidate) if (!oracle.has(id)) unexpected += 1;
    for (const id of oracle) if (!m.candidate.has(id)) missing += 1;
    identityVerified = true;
  }

  const result: TierAccessResult = {
    version,
    tier,
    requestedCells: cells.length,
    resolvedCells: stats.coveredCells,
    countMs: Math.round(countMs),
    firstStreamMs: Math.round(m.firstMs),
    fullIdMs: Math.round(m.totalMs),
    idsStreamed: m.idsStreamed,
    statsMatchedRows: stats.matchedRows,
    countEquivalent,
    duplicatesInStream: m.duplicatesInStream,
    monotonicOrdered: m.monotonicOrdered,
    batches: m.batches,
    nodeHeapUsedMB: Math.round(heap),
    identityVerified,
    missing,
    unexpected,
  };
  log(
    `v=${version} tier=${tier} cells=${cells.length} resolved=${stats.coveredCells} countMs=${Math.round(countMs)} firstMs=${Math.round(m.firstMs)} fullMs=${Math.round(m.totalMs)} ids=${m.idsStreamed} countEq=${countEquivalent} dup=${m.duplicatesInStream} missing=${missing} unexpected=${unexpected}`,
  );
  return result;
}

async function main(): Promise<void> {
  writeFileSync(logPath, '');
  const cfg = loadConfig();
  const versions = (process.env.CELL_ACCESS_VERSIONS ?? 'C,D').split(',').map((s) => s.trim());
  log(`benchmark-cell-access start versions=${versions.join(',')} batch=${cfg.CELL_STREAM_BATCH_SIZE} mode=${cfg.SUBSCRIBER_CELL_ACCESS_MODE}`);

  const paths = new Map<string, CellAccessPath>();
  for (const v of versions) {
    if (v === 'A') continue;
    try {
      paths.set(v, createCellAccessPath(v, cfg, pool));
    } catch (err) {
      log(`version ${v} unavailable: ${String((err as Error)?.message ?? err)}`);
    }
  }

  const legacy = new PostgresSubscriberCellMatcher(cfg, pool);
  const results: TierAccessResult[] = [];

  for (const tier of [100, 1_000, 5_000, 10_000, 25_000, 50_000]) {
    const cells = await sampleCellIds(tier);
    const t0 = performance.now();
    const st = await legacy.matchCells(cells, { alertId: `bench-access-A-${tier}` });
    results.push({
      version: 'A',
      tier,
      requestedCells: cells.length,
      resolvedCells: st.resolvedCellCount,
      countMs: Math.round(performance.now() - t0),
      firstStreamMs: -1,
      fullIdMs: Math.round(st.elapsedMs),
      idsStreamed: st.subscriberMatchCount,
      statsMatchedRows: st.subscriberMatchCount,
      countEquivalent: true,
      duplicatesInStream: st.subscriberMatchCount - st.uniqueMsisdnCount,
      monotonicOrdered: false,
      batches: 1,
      nodeHeapUsedMB: 0,
      identityVerified: false,
      missing: -1,
      unexpected: -1,
    });
    log(`v=A tier=${tier} fullMs=${Math.round(st.elapsedMs)} rows=${st.subscriberMatchCount}`);

    for (const v of paths.keys()) {
      results.push(await runTier(paths.get(v)!, v, tier));
    }
  }

  const report = { generatedAt: new Date().toISOString(), results };
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    '# Benchmark: Cell → Subscriber Identification (access paths)',
    '',
    `Generated: ${report.generatedAt}  Batch: ${cfg.CELL_STREAM_BATCH_SIZE}`,
    '',
    '| Ver | Tier | Cells | Resolved | Count ms | First ms | Full id ms | ids | Count-eq | dup | missing | unexpected |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.version} | ${r.tier} | ${r.requestedCells} | ${r.resolvedCells} | ${r.countMs} | ${r.firstStreamMs} | ${r.fullIdMs} | ${r.idsStreamed} | ${r.countEquivalent} | ${r.duplicatesInStream} | ${r.missing} | ${r.unexpected} |`,
    );
  }
  lines.push('', 'Notes:', '- Identity-set equality (missing/unexpected) verified at tiers ≤ 5K.',
    '- Larger tiers are count-equivalence checked (`idsStreamed == stats.matchedRows`).',
    '- A = current dump aggregate (heaps fetches, COUNT DISTINCT). C = mapping. D = intarray postings.', '');
  writeFileSync(mdPath, `${lines.join('\n')}\n`);
  log(`benchmark-cell-access-done json=${jsonPath}`);
}

if (process.argv[1]?.endsWith('benchmark-cell-access.ts')) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      logger.error({ err: String(err?.message ?? err) }, 'benchmark.cell.access.failed');
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}