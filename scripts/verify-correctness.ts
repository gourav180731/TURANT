#!/usr/bin/env tsx
/**
 * FINAL CORRECTNESS VERIFICATION
 *
 * Validates that the optimized access path produces EXACTLY the same subscriber
 * identity set as the brute-force oracle (direct subscriber_dump scan).
 *
 * Checks:
 *   (a) Count equality: matched_rows, unique_msisdns match
 *   (b) Identity set equality: (optimized − oracle = ∅) ∧ (oracle − optimized = ∅)
 *
 * Uses numeric subscriber_ids (dump PK) as the authoritative identity because
 *   id int4 UNIQUE  ↔  msisdn text UNIQUE  (1:1 enforced by migration 009)
 *
 * Usage:
 *   npx tsx scripts/verify-correctness.ts              # 100-cell smoke
 *   VERIFY_CELLS=5000 npx tsx scripts/verify-correctness.ts   # 5000-cell heavier
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import {
  buildLegacyDumpStatsQuery,
  buildNarrowAccessStatsQuery,
  resolveStatsQuery,
} from '../src/telecom/matcher/subscriber-cell-matcher.js';
import { getLogger } from '../src/utils/logger.js';

const logger = getLogger();
const logPath = resolve(process.cwd(), '.verify-correctness.log');
const jsonPath = resolve(process.cwd(), '.verify-correctness.json');
const mdPath = resolve(process.cwd(), '.verify-correctness.md');

function log(line: string): void {
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  console.log(line);
}

function fmtSetDiff(label: string, diffRows: number, total: number): string {
  const pct = total === 0 ? 0 : (diffRows / total) * 100;
  return `${label}: ${diffRows.toLocaleString()} rows (${pct.toFixed(4)}% of ${total.toLocaleString()})`;
}

async function main(): Promise<void> {
  writeFileSync(logPath, '');
  const cfg = loadConfig();
  const pool = getPool();
  const N_CELLS = Number(process.env.VERIFY_CELLS ?? 100);
  const client = await pool.connect();

  try {
    log(`verify-start cells=${N_CELLS} table=${cfg.SUBSCRIBER_DUMP_TABLE} mode=${cfg.SUBSCRIBER_CELL_ACCESS_MODE}`);

    // ---- 1. Check that optimization tables are actually populated ----
    const probe = await client.query<{ n: string }>(
      `SELECT (CASE WHEN EXISTS (SELECT 1 FROM ${cfg.CELL_SUBSCRIBER_STATS_TABLE} LIMIT 1) THEN 1 ELSE 0 END)::text AS n`
    );
    const haveOptTables = Number(probe.rows[0]?.n ?? 0) === 1;
    log(`optimization-tables-populated = ${haveOptTables}`);
    if (!haveOptTables) {
      log('SKIPPED: subscriber_cell_index/cell_subscriber_stats not built yet. Run `npm run build:cell-access` first.');
      return;
    }

    // ---- 2. Sample N real Delhi cells (deterministic ORDER BY cell_id) ----
    const cellsSql = `
      SELECT DISTINCT d.${cfg.SUBSCRIBER_DUMP_CELL_COL} AS cell_id
      FROM ${cfg.SUBSCRIBER_DUMP_TABLE} d
      WHERE d.state = 'Delhi'
        AND d.${cfg.SUBSCRIBER_DUMP_CELL_COL} IS NOT NULL
      ORDER BY d.${cfg.SUBSCRIBER_DUMP_CELL_COL}
      LIMIT $1
    `;
    const s0 = performance.now();
    const cellRes = await client.query<{ cell_id: string }>(cellsSql, [N_CELLS]);
    const cells = cellRes.rows.map(r => r.cell_id);
    log(`sampled ${cells.length} Delhi cells in ${(performance.now() - s0).toFixed(0)}ms`);

    // ---- 3. Stats counts: legacy vs optimized ----
    log('--- Stats count comparison ---');
    const legacy = buildLegacyDumpStatsQuery(cfg, cells);
    const opt = buildNarrowAccessStatsQuery(cfg, cells);
    const sL = performance.now();
    const rL = await client.query(legacy.text, legacy.values);
    const msLegacy = performance.now() - sL;
    const sO = performance.now();
    const rO = await client.query(opt.text, opt.values);
    const msOpt = performance.now() - sO;

    const legacyMatched = Number(rL.rows[0].matched_rows);
    const legacyUnique = Number(rL.rows[0].unique_msisdns);
    const optMatched = Number(rO.rows[0].matched_rows);
    const optUnique = Number(rO.rows[0].unique_msisdns);

    const countsMatch = (legacyMatched === optMatched) && (legacyUnique === optUnique);
    log(`legacy    rows=${legacyMatched.toLocaleString().padStart(12)} unique=${legacyUnique.toLocaleString().padStart(12)}  t=${msLegacy.toFixed(0)}ms`);
    log(`optimized rows=${optMatched.toLocaleString().padStart(12)} unique=${optUnique.toLocaleString().padStart(12)}  t=${msOpt.toFixed(0)}ms`);
    log(`COUNTS MATCH: ${countsMatch}`);

    // ---- 4. Identity set equality: subscriber_id sets MUST BE IDENTICAL ----
    log('--- Identity set equality (subscriber_ids) ---');
    const sSet = performance.now();

    // Oracle: pull all distinct subscriber_ids directly from dump via PK
    const oracleSql = `
      SELECT DISTINCT d.${cfg.SUBSCRIBER_DUMP_ID_COL}::int4 AS sub_id
      FROM ${cfg.SUBSCRIBER_DUMP_TABLE} d
      WHERE d.${cfg.SUBSCRIBER_DUMP_CELL_COL} = ANY($1::text[])
        AND d.${cfg.SUBSCRIBER_DUMP_CELL_COL} IS NOT NULL
      ORDER BY sub_id
    `;
    const rOracle = await client.query<{ sub_id: number }>(oracleSql, [cells]);
    const oracleIds = rOracle.rows.map(r => r.sub_id);
    const msOracle = performance.now() - sSet;

    // Optimized: pull all distinct subscriber_ids from the narrow mapping
    const sOptSet = performance.now();
    const optIdSql = `
      SELECT DISTINCT i.subscriber_id AS sub_id
      FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE} i
      WHERE i.serving_cell_id = ANY($1::text[])
      ORDER BY sub_id
    `;
    const rOptIds = await client.query<{ sub_id: number }>(optIdSql, [cells]);
    const optIds = rOptIds.rows.map(r => r.sub_id);
    const msOptSet = performance.now() - sOptSet;

    log(`oracle set size:  ${oracleIds.length.toLocaleString().padStart(12)}  t=${msOracle.toFixed(0)}ms`);
    log(`optimized set size: ${optIds.length.toLocaleString().padStart(12)}  t=${msOptSet.toFixed(0)}ms`);

    // Size check first (fast)
    const sizesMatch = oracleIds.length === optIds.length;
    log(`SIZE MATCH: ${sizesMatch}`);

    // Full element-wise equality (both are already ORDER BY sub_id → linear compare)
    let firstDiffIdx = -1;
    if (sizesMatch) {
      for (let i = 0; i < oracleIds.length; i++) {
        if (oracleIds[i] !== optIds[i]) { firstDiffIdx = i; break; }
      }
    }
    const elementWiseIdentical = sizesMatch && firstDiffIdx === -1;

    // ---- 5. Database-side set difference (the canonical proof) ----
    log('--- DB-side set difference (canonical proof) ---');
    const sDiff = performance.now();
    const diffSql = `
      WITH oracle AS (
        SELECT DISTINCT d.${cfg.SUBSCRIBER_DUMP_ID_COL}::int4 AS sub_id
        FROM ${cfg.SUBSCRIBER_DUMP_TABLE} d
        WHERE d.${cfg.SUBSCRIBER_DUMP_CELL_COL} = ANY($1::text[])
          AND d.${cfg.SUBSCRIBER_DUMP_CELL_COL} IS NOT NULL
      ),
      optimized AS (
        SELECT DISTINCT i.subscriber_id AS sub_id
        FROM ${cfg.SUBSCRIBER_CELL_INDEX_TABLE} i
        WHERE i.serving_cell_id = ANY($1::text[])
      )
      SELECT
        (SELECT COUNT(*) FROM (SELECT sub_id FROM optimized EXCEPT SELECT sub_id FROM oracle) x)::text AS opt_minus_oracle,
        (SELECT COUNT(*) FROM (SELECT sub_id FROM oracle EXCEPT SELECT sub_id FROM optimized) x)::text AS oracle_minus_opt
    `;
    const rDiff = await client.query<{ opt_minus_oracle: string; oracle_minus_opt: string }>(diffSql, [cells]);
    const optMinusOracle = Number(rDiff.rows[0].opt_minus_oracle);
    const oracleMinusOpt = Number(rDiff.rows[0].oracle_minus_opt);
    const emptyIntersection = (optMinusOracle === 0) && (oracleMinusOpt === 0);
    const msDiff = performance.now() - sDiff;

    log(fmtSetDiff('opt − oracle   ', optMinusOracle, oracleIds.length));
    log(fmtSetDiff('oracle − opt   ', oracleMinusOpt, oracleIds.length));
    log(`DB SET EQUALITY: ${emptyIntersection}  (t=${msDiff.toFixed(0)}ms)`);

    // ---- 6. Report ----
    const totalPass = countsMatch && sizesMatch && elementWiseIdentical && emptyIntersection;

    const report = {
      generatedAt: new Date().toISOString(),
      cells,
      cellsCount: cells.length,
      counts: {
        legacyMatched, legacyUnique, optMatched, optUnique,
        countsMatch,
        speedup: msLegacy / Math.max(msOpt, 1),
      },
      sets: {
        oracleSize: oracleIds.length,
        optimizedSize: optIds.length,
        sizesMatch,
        elementWiseIdentical,
        firstDiffIdx,
        optMinusOracle,
        oracleMinusOpt,
        emptyIntersection,
      },
      timingsMs: {
        legacyStats: Math.round(msLegacy),
        optimizedStats: Math.round(msOpt),
        oracleSet: Math.round(msOracle),
        optimizedSet: Math.round(msOptSet),
        diffProof: Math.round(msDiff),
      },
      pass: totalPass,
    };
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

    const md = [
      '# Correctness: Optimized vs Brute-force Oracle',
      '',
      `Generated: ${report.generatedAt}`,
      `Sample: **${cells.length}** Delhi cells over \`${cfg.SUBSCRIBER_DUMP_TABLE}\``,
      '',
      '## Stats count match',
      '',
      '| Measure | Legacy (dump) | Optimized (stats+index) | Match |',
      '|---|---:|---:|---|',
      `| Matched rows | ${legacyMatched.toLocaleString()} | ${optMatched.toLocaleString()} | ${legacyMatched === optMatched} |`,
      `| Unique subscribers | ${legacyUnique.toLocaleString()} | ${optUnique.toLocaleString()} | ${legacyUnique === optUnique} |`,
      `| Time | ${Math.round(msLegacy)} ms | ${Math.round(msOpt)} ms | — |`,
      '',
      `Speedup on stats: **${(msLegacy / Math.max(msOpt, 1)).toFixed(2)}×**`,
      '',
      '## Identity set equality (authoritative subscriber_id)',
      '',
      `| Oracle size | Optimized size | Size match | Element-wise | opt − oracle | oracle − opt | Both ∅ |`,
      '|---:|---:|---|---|---:|---:|---|',
      `| ${oracleIds.length.toLocaleString()} | ${optIds.length.toLocaleString()} | ${sizesMatch} | ${elementWiseIdentical ? 'YES' : `NO @ idx ${firstDiffIdx}`} | ${optMinusOracle.toLocaleString()} | ${oracleMinusOpt.toLocaleString()} | ${emptyIntersection} |`,
      '',
      '## Canonical DB-side set-difference proof',
      '',
      `- (optimized − oracle) rows: ${optMinusOracle.toLocaleString()}`,
      `- (oracle − optimized) rows: ${oracleMinusOpt.toLocaleString()}`,
      '',
      `**Final Result: ${totalPass ? '✅ PASS — identical identity set & counts. No fabrication. No LIMIT.' : '❌ FAIL — see diff above.'}**`,
      '',
    ].join('\n');
    writeFileSync(mdPath, md + '\n');

    log(`json=${jsonPath}`);
    log(`md=${mdPath}`);
    log(`PASS: ${totalPass}`);
    if (!totalPass) process.exit(2);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  log(`FAILED: ${String(err?.message ?? err)}`);
  process.exit(1);
});
