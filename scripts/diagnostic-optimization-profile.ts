#!/usr/bin/env tsx
/**
 * TURANT Final Optimization Profiler
 * Compares:
 *   VERSION A (current) : COUNT + COUNT(DISTINCT msisdn) ON subscriber_dump (191M rows, heap scan)
 *   VERSION C (stats)   : SUM(subscriber_count) FROM cell_subscriber_stats (30K rows, instant)
 *   VERSION C2 (mapping): COUNT(DISTINCT subscriber_id) ON subscriber_cell_index (97M, int4, CLUSTERed)
 *   VERSION D (postings): UNION of intarray posting lists from cell_postings
 */
import { getPool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

const cfg = loadConfig();
const pool = getPool();

async function section(title: string) {
  console.log('\n' + '='.repeat(90));
  console.log('  ' + title);
  console.log('='.repeat(90));
}

async function runExplain(
  client: any,
  label: string,
  sql: string,
  params: any[] = [],
): Promise<{ plan: any; execMs: number; planMs: number; rowCount: number }> {
  console.log(`\n--- EXPLAIN ANALYZE: ${label} ---`);
  const t0 = performance.now();
  const res = await client.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    values: params,
  });
  const t1 = performance.now();
  const plan = res.rows[0]['QUERY PLAN'][0];
  const execMs = Number(plan['Execution Time'] ?? 0);
  const planMs = Number(plan['Planning Time'] ?? 0);
  const rowCount = plan['Plan']?.['Actual Rows'] ?? 0;
  console.log(`  EXPLAIN wall-clock: ${(t1 - t0).toFixed(0)} ms`);
  console.log(`  Execution Time:    ${execMs.toFixed(1)} ms`);
  console.log(`  Planning Time:     ${planMs.toFixed(1)} ms`);
  console.log(`  Actual Rows:       ${rowCount}`);
  
  // Show top-level plan nodes
  function summarize(node: any, depth = 0): string {
    const pad = '  '.repeat(depth);
    const lines: string[] = [];
    const nodeType = node['Node Type'] ?? '?';
    const rows = node['Actual Rows'] ?? '?';
    const loops = node['Actual Loops'] ?? '?';
    const time = node['Actual Total Time'] ?? '?';
    lines.push(`${pad}${nodeType} rows=${rows} loops=${loops} time=${typeof time === 'number' ? time.toFixed(1) : time}ms`);
    for (const child of node['Plans'] ?? []) {
      lines.push(summarize(child, depth + 1));
    }
    return lines.join('\n');
  }
  console.log('  Plan summary:');
  console.log(summarize(plan.Plan, 2));
  return { plan, execMs, planMs, rowCount };
}

async function measureQuery(
  client: any,
  label: string,
  sql: string,
  params: any[] = [],
  iterations = 3,
): Promise<{ bestMs: number; meanMs: number; medianMs: number; values: number[]; result: any }> {
  const samples: number[] = [];
  let lastResult: any = null;
  // warmup
  await client.query({ text: sql, values: params }).catch(() => {});
  for (let i = 0; i < iterations; i++) {
    const s = performance.now();
    lastResult = await client.query({ text: sql, values: params });
    samples.push(performance.now() - s);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const best = sorted[0];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`\n--- MEASURED: ${label} ---`);
  console.log(`  runs=${iterations} best=${best.toFixed(0)}ms median=${median.toFixed(0)}ms mean=${mean.toFixed(0)}ms`);
  console.log(`  all: ${samples.map(s => s.toFixed(0)).join(', ')} ms`);
  if (lastResult?.rows?.length) {
    console.log(`  result cols: ${Object.keys(lastResult.rows[0]).join(', ')}`);
    console.log(`  result row:  ${JSON.stringify(lastResult.rows[0])}`);
  }
  return { bestMs: best, meanMs: mean, medianMs: median, values: samples, result: lastResult };
}

async function main() {
  const client = await pool.connect();
  try {
    // ============================================================
    // 1. DB STATE VERIFICATION
    // ============================================================
    await section('DB STATE — VERIFY ACCESS STRUCTURES EXIST & ARE POPULATED');

    const tbl = cfg.SUBSCRIBER_DUMP_TABLE;
    const idxTbl = cfg.SUBSCRIBER_CELL_INDEX_TABLE;
    const statsTbl = cfg.CELL_SUBSCRIBER_STATS_TABLE;
    const postTbl = cfg.CELL_POSTINGS_TABLE;
    const colCell = cfg.SUBSCRIBER_DUMP_CELL_COL;
    const colMsisdn = cfg.SUBSCRIBER_DUMP_MSISDN_COL;
    const colId = cfg.SUBSCRIBER_DUMP_ID_COL;

    const checks = [
      ['subscriber_dump total rows', `SELECT COUNT(*)::text AS n FROM ${tbl}`],
      ['Delhi rows (state)', `SELECT COUNT(*)::text AS n FROM ${tbl} WHERE state = 'Delhi'`],
      ['Delhi mapped (serving_cell_id NOT NULL)', `SELECT COUNT(*)::text AS n FROM ${tbl} WHERE state = 'Delhi' AND ${colCell} IS NOT NULL`],
      [`${idxTbl} rows`, `SELECT COUNT(*)::text AS n FROM ${idxTbl}`],
      [`${statsTbl} rows`, `SELECT COUNT(*)::text AS n FROM ${statsTbl}`],
      [`${postTbl} rows`, `SELECT COUNT(*)::text AS n FROM ${postTbl}`],
      ['Distinct serving_cell_id in dump (Delhi)', `SELECT COUNT(*)::text AS n FROM (SELECT DISTINCT ${colCell} FROM ${tbl} WHERE state = 'Delhi' AND ${colCell} IS NOT NULL) x`],
    ] as const;

    for (const [label, sql] of checks) {
      const s = performance.now();
      const r = await client.query(sql);
      const e = performance.now() - s;
      console.log(`  ${label.padEnd(50)} : ${r.rows[0]?.n?.padStart(12) ?? 'NULL'}  (${e.toFixed(0)}ms)`);
    }

    // Sum stats vs dump count
    const sumVsDump = await client.query(`
      SELECT
        (SELECT SUM(subscriber_count)::text FROM ${statsTbl}) AS stats_sum_rows,
        (SELECT COUNT(*)::text FROM ${tbl} WHERE ${colCell} IN (SELECT cell_id FROM ${statsTbl})) AS dump_rows_for_stats_cells,
        (SELECT COUNT(DISTINCT subscriber_id)::text FROM ${idxTbl}) AS idx_unique_ids,
        (SELECT COUNT(DISTINCT ${colMsisdn})::text FROM ${tbl} WHERE state = 'Delhi' AND ${colCell} IS NOT NULL) AS dump_delhi_unique_msisdn
    `);
    console.log(`\n  INTEGRITY CHECKS:`);
    console.log(`    cell_subscriber_stats SUM(subscriber_count) = ${sumVsDump.rows[0].stats_sum_rows}`);
    console.log(`    subscriber_dump COUNT(*) for same cells      = ${sumVsDump.rows[0].dump_rows_for_stats_cells}`);
    console.log(`    subscriber_cell_index COUNT(DISTINCT sub_id) = ${sumVsDump.rows[0].idx_unique_ids}`);
    console.log(`    subscriber_dump Delhi DISTINCT msisdn        = ${sumVsDump.rows[0].dump_delhi_unique_msisdn}`);

    // ============================================================
    // 2. GET 50K DELHI CELL IDs
    // ============================================================
    await section('CELL SAMPLING — 50K DISTINCT DELHI CELLS');

    const cellSampleSql = `
      SELECT DISTINCT ${colCell} AS cell_id
      FROM ${tbl}
      WHERE state = 'Delhi' AND ${colCell} IS NOT NULL
      ORDER BY ${colCell}
      LIMIT 50000
    `;
    const sCells = performance.now();
    const cellRes = await client.query<{ cell_id: string }>(cellSampleSql);
    const allCellIds = cellRes.rows.map(r => r.cell_id);
    console.log(`  Sampled ${allCellIds.length} Delhi cells in ${(performance.now() - sCells).toFixed(0)}ms`);

    const tiers = [100, 1000, 5000, 10000, 25000, 50000];

    // ============================================================
    // 3. EXPLAIN ANALYZE — 50K CELLS
    // ============================================================
    const tier50k = allCellIds.slice(0, 50000);

    await section('EXPLAIN ANALYZE — 50K CELLS (core comparison)');

    // VERSION A: current (COUNT + COUNT(DISTINCT msisdn) ON dump)
    const sqlA = `
      WITH agg AS (
        SELECT COUNT(*)::bigint AS matched_rows,
               COUNT(DISTINCT ${colMsisdn})::bigint AS unique_msisdns
        FROM ${tbl}
        WHERE ${colCell} = ANY($1::text[])
          AND ${colCell} IS NOT NULL
          AND ${colMsisdn} IS NOT NULL
      )
      SELECT matched_rows, unique_msisdns FROM agg
    `;
    await runExplain(client, 'VERSION A: COUNT + COUNT(DISTINCT msisdn) on subscriber_dump (CURRENT)', sqlA, [tier50k]);

    // VERSION C stats: SUM from cell_subscriber_stats
    const sqlC_stats = `
      WITH target AS (SELECT cell_id FROM unnest($1::text[]) AS t(cell_id)),
      resolved AS (
        SELECT s.cell_id, s.subscriber_count, s.unique_subscriber_count
        FROM ${statsTbl} s
        JOIN target t USING (cell_id)
      )
      SELECT COALESCE(SUM(subscriber_count), 0)::bigint AS matched_rows,
             COALESCE(SUM(unique_subscriber_count), 0)::bigint AS unique_msisdns,
             (SELECT COUNT(*) FROM target)::bigint AS target_cells,
             (SELECT COUNT(*) FROM resolved)::bigint AS resolved_cells,
             (SELECT COUNT(*) FROM target t
               WHERE NOT EXISTS (SELECT 1 FROM resolved r WHERE r.cell_id = t.cell_id))::bigint AS unmatched_cells
    `;
    await runExplain(client, 'VERSION C-stats: SUM from cell_subscriber_stats (30K rows)', sqlC_stats, [tier50k]);

    // VERSION C2: COUNT(DISTINCT subscriber_id) on subscriber_cell_index (int4, 97M rows)
    const sqlC2 = `
      SELECT COUNT(*)::bigint AS matched_rows,
             COUNT(DISTINCT subscriber_id)::bigint AS unique_msisdns
      FROM ${idxTbl}
      WHERE serving_cell_id = ANY($1::text[])
    `;
    await runExplain(client, 'VERSION C2: COUNT(DISTINCT int4 subscriber_id) on subscriber_cell_index', sqlC2, [tier50k]);

    // VERSION C2b: DISTINCT only on subscriber_cell_index (no COUNT(*))
    const sqlC2b = `SELECT COUNT(DISTINCT subscriber_id)::bigint AS unique_msisdns FROM ${idxTbl} WHERE serving_cell_id = ANY($1::text[])`;
    await runExplain(client, 'VERSION C2b: ONLY COUNT(DISTINCT subscriber_id) on subscriber_cell_index', sqlC2b, [tier50k]);

    // VERSION D: postings via UNNEST
    const sqlD = `
      SELECT COUNT(*)::bigint AS matched_rows,
             COUNT(DISTINCT p.subscriber_id)::bigint AS unique_msisdns
      FROM ${postTbl} c, LATERAL unnest(c.subscriber_ids) AS p(subscriber_id)
      WHERE c.cell_id = ANY($1::text[])
    `;
    await runExplain(client, 'VERSION D: UNNEST posting lists + COUNT(DISTINCT subscriber_id)', sqlD, [tier50k]);

    // ============================================================
    // 4. MEASURED BENCHMARK — all tiers
    // ============================================================
    await section('MEASURED BENCHMARK — ALL TIERS (3 iterations each, warm)');

    const results: Record<number, Record<string, number>> = {};

    for (const nCells of tiers) {
      const cells = allCellIds.slice(0, nCells);
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`TIER: ${nCells.toLocaleString()} cells`);
      console.log(`${'─'.repeat(80)}`);
      results[nCells] = {};

      const mA = await measureQuery(client, `A: dump COUNT+DISTINCT(msisdn)`, sqlA, [cells], 2);
      results[nCells]['A_dump_ms'] = Math.round(mA.bestMs);
      results[nCells]['A_matched'] = Number(mA.result?.rows?.[0]?.matched_rows ?? 0);
      results[nCells]['A_unique'] = Number(mA.result?.rows?.[0]?.unique_msisdns ?? 0);

      const mC = await measureQuery(client, `C: stats SUM`, sqlC_stats, [cells], 3);
      results[nCells]['C_stats_ms'] = Math.round(mC.bestMs);
      results[nCells]['C_matched'] = Number(mC.result?.rows?.[0]?.matched_rows ?? 0);
      results[nCells]['C_unique'] = Number(mC.result?.rows?.[0]?.unique_msisdns ?? 0);

      const mC2 = await measureQuery(client, `C2: idx COUNT(DISTINCT int4)`, sqlC2, [cells], 2);
      results[nCells]['C2_idx_ms'] = Math.round(mC2.bestMs);
      results[nCells]['C2_matched'] = Number(mC2.result?.rows?.[0]?.matched_rows ?? 0);
      results[nCells]['C2_unique'] = Number(mC2.result?.rows?.[0]?.unique_msisdns ?? 0);

      const mD = await measureQuery(client, `D: postings UNNEST DISTINCT`, sqlD, [cells], 2);
      results[nCells]['D_post_ms'] = Math.round(mD.bestMs);
      results[nCells]['D_matched'] = Number(mD.result?.rows?.[0]?.matched_rows ?? 0);
      results[nCells]['D_unique'] = Number(mD.result?.rows?.[0]?.unique_msisdns ?? 0);

      // Verify counts match (correctness)
      const cA = results[nCells]['A_unique'];
      const cC = results[nCells]['C_unique'];
      const cC2 = results[nCells]['C2_unique'];
      const cD = results[nCells]['D_unique'];
      const allMatch = cA === cC && cA === cC2 && cA === cD;
      console.log(`  *** CORRECTNESS: A==C==C2==D ? unique=${cA}/${cC}/${cC2}/${cD} MATCH=${allMatch} ***`);
    }

    // ============================================================
    // 5. SUMMARY TABLE
    // ============================================================
    await section('FINAL SUMMARY — OPTIMIZATION COMPARISON');

    const header = `| Cells | A-dump(ms) | C-stats(ms) | C2-idx(ms) | D-post(ms) | Unique subs | A==C==C2==D |`;
    const sep    = `|---:|---:|---:|---:|---:|---:|---|`;
    console.log(header);
    console.log(sep);
    for (const n of tiers) {
      const r = results[n];
      const same = (r['A_unique'] === r['C_unique'] && r['A_unique'] === r['C2_unique'] && r['A_unique'] === r['D_unique']) ? 'YES' : 'NO';
      console.log(`| ${n.toLocaleString()} | ${r['A_dump_ms']} | ${r['C_stats_ms']} | ${r['C2_idx_ms']} | ${r['D_post_ms']} | ${r['A_unique'].toLocaleString()} | ${same} |`);
    }
    console.log(`\n  VERSION A = CURRENT 541,000 ms at 50K cells (from benchmark report)`);
    console.log(`  VERSION C = stats table (counts only)`);
    console.log(`  VERSION C2 = subscriber_cell_index (int4 dedup)`);
    console.log(`  VERSION D = intarray postings`);
    console.log(`\n  TARGET: <60,000 ms for 50K cells`);

  } finally {
    client.release();
    await pool.end();
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
