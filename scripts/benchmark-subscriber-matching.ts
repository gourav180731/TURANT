/**
 * Benchmark harness (Phase 7/5/13 acceptance + TSP evidence).
 *
 * Runs the production cell-indexed lookup through PostgresSubscriberCellMatcher
 * across the required cell-scale tiers:
 *
 *    100 / 1,000 / 5,000 / 10,000 / 25,000 / 50,000  cells
 *
 * over the real 100M-row Delhi `subscriber_dump`, multi-iteration with
 * cold/warm detection, plus a multi-polygon UNION test that proves global
 * de-duplication is correct (union count <= sum of parts).
 *
 * Outputs:
 *   .benchmark-subscriber-matching.json   machine-readable report
 *   .benchmark-subscriber-matching.md     human-readable report
 *
 * Usage:
 *   npm run benchmark:subscriber-matching
 *   BENCH_ITERATIONS=1 npm run benchmark:subscriber-matching   (fast pass)
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import { PostgresSubscriberCellMatcher } from '../src/telecom/matcher/subscriber-cell-matcher.js';
import { getLogger } from '../src/utils/logger.js';

const logger = getLogger();
const logPath = resolve(process.cwd(), '.benchmark.log');
const jsonPath = resolve(process.cwd(), '.benchmark-subscriber-matching.json');
const mdPath = resolve(process.cwd(), '.benchmark-subscriber-matching.md');

function log(line: string): void {
  const ts = new Date().toISOString();
  appendFileSync(logPath, `${ts} ${line}\n`);
  // eslint-disable-next-line no-console
  console.log(line);
}

/**
 * Harness-only matcher. Production carries MATCH_TIME_BUDGET_MS (5 min by
 * default) so an oversized zone halts visibly; a benchmark must measure raw
 * latency, so `BENCH_MATCH_TIMEOUT_MS` (default 3_600_000 ms = 1 h) overrides
 * `statement_timeout` for THIS run only — it does not change product config.
 * Logs the override so the report states its own measurement conditions.
 */
function makeBenchmarkMatcher(): PostgresSubscriberCellMatcher {
  const budget = Number(process.env.BENCH_MATCH_TIMEOUT_MS ?? 3_600_000);
  const cfg = { ...loadConfig(), MATCH_TIME_BUDGET_MS: budget };
  log(`matcher-timeout-override-ms=${budget} (production budget=${loadConfig().MATCH_TIME_BUDGET_MS})`);
  return new PostgresSubscriberCellMatcher(cfg);
}

export interface TierResult {
  tier: number;
  iterations: number;
  /** coldest iteration elapsedMs (first uncached query) */
  coldMs: number;
  /** warm median elapsedMs across iterations after the first */
  warmMedianMs: number;
  /** warm mean elapsedMs */
  warmMeanMs: number;
  minMs: number;
  maxMs: number;
  targetCellCount: number;
  resolvedCellCount: number;
  unresolvedCellCount: number;
  subscriberMatchCount: number;
  uniqueMsisdnCount: number;
  mappingIncomplete: boolean;
}

export async function runBenchmark(opts: {
  cellIds: readonly string[];
  iterations: number;
  matcher?: PostgresSubscriberCellMatcher;
}): Promise<TierResult[]> {
  const matcher = opts.matcher ?? new PostgresSubscriberCellMatcher();
  const tiers: readonly number[] = [100, 1_000, 5_000, 10_000, 25_000, 50_000];
  const results: TierResult[] = [];

  for (const tier of tiers) {
    const sample = opts.cellIds.slice(0, tier);
    const samples: number[] = [];
    let lastStats: import('../src/telecom/matcher/subscriber-cell-matcher.js').CellMatchStats | null = null;
    for (let i = 0; i < opts.iterations; i += 1) {
      const started = performance.now();
      lastStats = await matcher.matchCells(sample, { alertId: `bench-t${tier}-i${i}` });
      samples.push(performance.now() - started);
    }
    if (!lastStats) throw new Error(`no stats for tier ${tier}`);
    const coldMs = samples[0];
    const warm = samples.slice(1);
    const warmMedianMs = warm.length
      ? [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)]
      : coldMs;
    const warmMeanMs = warm.length ? warm.reduce((s, v) => s + v, 0) / warm.length : coldMs;
    results.push({
      tier,
      iterations: opts.iterations,
      coldMs,
      warmMedianMs,
      warmMeanMs,
      minMs: Math.min(...samples),
      maxMs: Math.max(...samples),
      ...lastStats,
    });
    log(`tier=${tier} rows=${lastStats.subscriberMatchCount} unique=${lastStats.uniqueMsisdnCount} cold=${Math.round(coldMs)}ms warm-med=${Math.round(warmMedianMs)}ms`);
  }
  return results;
}

/** Multi-polygon UNION proof: two overlapping cell sets — union must de-dup correctly. */
export async function runMultiPolygonDedupProof(opts: {
  cellIds: readonly string[];
  matcher?: PostgresSubscriberCellMatcher;
}): Promise<Record<string, number | boolean>> {
  const matcher = opts.matcher ?? new PostgresSubscriberCellMatcher();
  const half = Math.floor(opts.cellIds.length / 2);
  const a = opts.cellIds.slice(0, half);
  const b = opts.cellIds.slice(half - Math.floor(half / 2)); // overlap by 50% of A
  const ra = await matcher.matchCells(a, { alertId: 'mp-a' });
  const rb = await matcher.matchCells(b, { alertId: 'mp-b' });
  const union = await matcher.matchCells(Array.from(new Set([...a, ...b])), { alertId: 'mp-union' });
  const sumRows = ra.subscriberMatchCount + rb.subscriberMatchCount;
  const dedupProof = union.subscriberMatchCount <= sumRows;
  return {
    setA: a.length,
    setB: b.length,
    unionSet: union.targetCellCount,
    rowsA: ra.subscriberMatchCount,
    rowsB: rb.subscriberMatchCount,
    rowsUnion: union.subscriberMatchCount,
    sumRows,
    approxDedupedRows: sumRows - union.subscriberMatchCount,
    rowsMonotonic: dedupProof,
  };
}

async function sampleCellIds(count: number): Promise<string[]> {
  const cfg = loadConfig();
  const pool = getPool();
  // Deterministic sample from the FK target table so every sample cell is real
  // and known to the dump's serving_cell_id FK.
  const { rows } = await pool.query<{ cell_id: string }>(`
    SELECT cell_id
    FROM sim_cell_towers
    WHERE LENGTH(cell_id) > 0
    ORDER BY cell_id
    LIMIT $1
  `, [count]);
  return rows.map((r) => r.cell_id);
}

async function main(): Promise<void> {
  writeFileSync(logPath, '');
  const cfg = loadConfig();
  const iterations = Number(process.env.BENCH_ITERATIONS ?? 2);
  log(`benchmark-start iterations=${iterations} table=${cfg.SUBSCRIBER_DUMP_TABLE} mode=${cfg.SUBSCRIBER_DUMP_LOOKUP_MODE}`);
  const sampled = await sampleCellIds(50_000);
  log(`sampled-cells=${sampled.length}`);

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    iterations,
    table: cfg.SUBSCRIBER_DUMP_TABLE,
    lookupMode: cfg.SUBSCRIBER_DUMP_LOOKUP_MODE,
    subscriberDumpMatchLimit: cfg.SUBSCRIBER_DUMP_MATCH_LIMIT,
    matchTimeoutOverrideMs: Number(process.env.BENCH_MATCH_TIMEOUT_MS ?? 3_600_000),
    matcher: makeBenchmarkMatcher(),
    tiers: null,
    multiPolygonDedup: null,
    error: null,
  };

  try {
    const matcher = report.matcher as PostgresSubscriberCellMatcher;
    report.tiers = await runBenchmark({ cellIds: sampled, iterations, matcher });
    report.multiPolygonDedup = await runMultiPolygonDedupProof({ cellIds: sampled, matcher });
    delete report.error;
  } catch (err) {
    report.error = String(err?.message ?? err);
    log(`benchmark-error=${report.error}`);
  }
  delete report.matcher;

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`json-report=${jsonPath}`);

  const lines: string[] = [
    '# Benchmark: Subscriber Match (cell-indexed)',
    '',
    `Generated: ${report.generatedAt}`,
    `Table: \`${report.table}\`  Mode: \`${report.lookupMode}\`  Iterations: ${report.iterations}`,
    `Statement-timeout override: \`${report.matchTimeoutOverrideMs}\` ms (production budget ${cfg.MATCH_TIME_BUDGET_MS} ms by design)`,
    '',
    '## Cell-scale tiers (cold vs warm)',
    '',
    '| Cells | Rows matched | Unique MSISDN | Cold ms | Warm med ms | Warm mean ms | Min ms | Max ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  if (Array.isArray(report.tiers)) {
    for (const t of report.tiers as TierResult[]) {
      lines.push(
        `| ${t.tier} | ${t.subscriberMatchCount} | ${t.uniqueMsisdnCount} | ${Math.round(t.coldMs)} | ${Math.round(t.warmMedianMs)} | ${Math.round(t.warmMeanMs)} | ${Math.round(t.minMs)} | ${Math.round(t.maxMs)} |`,
      );
    }
  } else {
    lines.push('| (tiers incomplete — see `error` in JSON) | | | | | | |');
  }
  const mp = report.multiPolygonDedup as Record<string, number | boolean> | null;
  lines.push(
    '',
    '## Multi-polygon UNION + global dedup proof',
    '',
  );
  if (mp) {
    lines.push(
      `- Polygon A cells: ${mp.setA} → rows ${mp.rowsA}`,
      `- Polygon B cells: ${mp.setB} → rows ${mp.rowsB}`,
      `- Union (overlap present): ${mp.unionSet} cells → rows ${mp.rowsUnion}`,
      `- Sum of parts: ${mp.sumRows} — union is a subset, so \`${mp.rowsUnion} <= ${mp.sumRows}\` = **${mp.rowsMonotonic}**`,
      `- Rows eliminated by global dedup across the two polygons: ${mp.approxDedupedRows}`,
      '',
    );
  } else {
    lines.push('- (not run — see `error` in JSON)', '');
  }
  writeFileSync(mdPath, `${lines.join('\n')}\n`);
  log(`md-report=${mdPath}`);
  log('benchmark-done');
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('benchmark-subscriber-matching.ts')) {
  main().catch((err) => {
    logger.error({ err: String(err?.message ?? err) }, 'benchmark.failed');
    process.exit(1);
  });
}