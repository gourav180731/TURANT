#!/usr/bin/env tsx
/**
 * EXPLAIN (ANALYZE, BUFFERS) for ALL candidate queries on the SAME 50K-cell set.
 * Captures plan-shape evidence for the 8-item report.
 *
 * Requires: optimization tables populated first (npm run build:cell-access).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import {
  buildLegacyDumpStatsQuery,
  buildNarrowAccessStatsQuery,
} from '../src/telecom/matcher/subscriber-cell-matcher.js';

const OUT = resolve(process.cwd(), '.explain-analyze-50k.md');

function h2(s: string): string { return `\n\n## ${s}\n\n`; }
function code(sql: string): string { return '\n```sql\n' + sql.trim() + '\n```\n'; }
function explainResult(plan: string): string { return '\n```\n' + plan + '\n```\n'; }

async function explain(conn: any, label: string, sqlText: string, values: unknown[]): Promise<string> {
  const s = performance.now();
  const plan = await conn.query(`EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${sqlText}`, values);
  const ms = performance.now() - s;
  const planText = plan.rows.map((r: any) => Object.values(r)[0]).join('\n');
  return `${h2(label)}wall-clock (node): ${ms.toFixed(0)} ms\n${code(sqlText)}\n${h2(label)} — Plan\n${explainResult(planText)}`;
}

async function main(): Promise<void> {
  loadConfig();
  const pool = getPool();
  const client = await pool.connect();
  try {
    const cfg = loadConfig();
    // Pick the SAME deterministic 50K cells used by the benchmark harness:
    // sim_cell_towers ORDER BY cell_id LIMIT 50000.
    const cellsSql = `SELECT cell_id FROM sim_cell_towers WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT 50000`;
    const cellsRes = await client.query<{ cell_id: string }>(cellsSql);
    const cellIds = cellsRes.rows.map(r => r.cell_id);

    let report = `# EXPLAIN (ANALYZE, BUFFERS) — 50,000 cell subscriber match\n`;
    report += `\nGenerated: ${new Date().toISOString()}\n`;
    report += `\nCells: **${cellIds.length.toLocaleString()}** (sim_cell_towers ORDER BY cell_id LIMIT 50000)\n`;

    // Check optimization tables before running any query:
    const optReadyRes = await client.query<{ ready: string }>(
      `SELECT (CASE WHEN EXISTS (SELECT 1 FROM ${cfg.CELL_SUBSCRIBER_STATS_TABLE} LIMIT 1) THEN 1 ELSE 0 END)::text AS ready`
    );
    report += `\ncell_subscriber_stats populated: **${optReadyRes.rows[0].ready === '1'}**\n`;

    const legacy = buildLegacyDumpStatsQuery(cfg, cellIds);
    const opt = buildNarrowAccessStatsQuery(cfg, cellIds);

    report += await explain(client, 'VERSION A — LEGACY DUMP SCAN (before optimization, the 558s path)', legacy.text, legacy.values);
    report += await explain(client, 'VERSION C — NARROW ACCESS (stats + subscriber_cell_index CLUSTERED PK, the <60s target)', opt.text, opt.values);

    // ---- VERSION B: Covering index path (if exists) ----
    const coveringIndexSql = `
      WITH target        AS (SELECT cell_id FROM unnest($1::text[]) AS t(cell_id))
      ,    resolved_stats AS (SELECT COALESCE(SUM(s.subscriber_count),0) matched_rows
                                   , COUNT(s.cell_id) resolved_cells
                              FROM cell_subscriber_stats s JOIN target t USING(cell_id))
      ,    dedup          AS (SELECT COUNT(DISTINCT d.id::int4) unique_msisdns
                              FROM subscriber_dump d
                              WHERE d.serving_cell_id = ANY($1::text[]))
      SELECT (SELECT COUNT(*) FROM target)                      AS target_cells
           , (SELECT resolved_cells FROM resolved_stats)        AS resolved_cells
           , (SELECT COUNT(*) FROM target) - (SELECT resolved_cells FROM resolved_stats) AS unmatched_cells
           , (SELECT matched_rows   FROM resolved_stats)        AS matched_rows
           , (SELECT unique_msisdns FROM dedup)                 AS unique_msisdns;
    `;
    try {
      report += await explain(client, 'VERSION B — cell_subscriber_stats + dump covering index id (serving_cell_id) INCLUDE(id)', coveringIndexSql, [cellIds]);
    } catch (e: any) {
      report += h2('VERSION B');
      report += `⚠ Could not run: ${String(e?.message ?? e)}\n  * Probably \`idx_subscriber_dump_serving_cell_cover_id\` index not yet created.\n`;
    }

    // ---- VERSION D: intarray postings path ----
    const postingsSql = `
      WITH target        AS (SELECT cell_id FROM unnest($1::text[]) AS t(cell_id))
      ,    resolved_stats AS (SELECT COALESCE(SUM(s.subscriber_count),0) matched_rows
                                   , COUNT(s.cell_id) resolved_cells
                              FROM cell_subscriber_stats s JOIN target t USING(cell_id))
      ,    flat          AS (SELECT DISTINCT unnest(p.subscriber_ids) AS sub_id
                             FROM cell_postings p JOIN target t USING(cell_id))
      ,    dedup          AS (SELECT COUNT(*)::text AS unique_msisdns FROM flat)
      SELECT (SELECT COUNT(*) FROM target)                      AS target_cells
           , (SELECT resolved_cells FROM resolved_stats)        AS resolved_cells
           , (SELECT COUNT(*) FROM target) - (SELECT resolved_cells FROM resolved_stats) AS unmatched_cells
           , (SELECT matched_rows   FROM resolved_stats)        AS matched_rows
           , (SELECT unique_msisdns FROM dedup)                 AS unique_msisdns;
    `;
    try {
      report += await explain(client, 'VERSION D — intarray postings (cell_postings.subscriber_ids int4[])', postingsSql, [cellIds]);
    } catch (e: any) {
      report += h2('VERSION D');
      report += `⚠ Could not run: ${String(e?.message ?? e)}\n`;
    }

    // ---- Raw dedup-only variants (SELECT COUNT(DISTINCT ...) — no stats CTE wrapper, for raw cost comparison) ----
    report += h2('DEDUP-ONLY COST: COUNT(DISTINCT x) across the 50K cells — raw');

    const dedupA = `SELECT COUNT(DISTINCT msisdn) FROM subscriber_dump WHERE serving_cell_id = ANY($1::text[])`;
    report += await explain(client, 'VERSION A DEDUP: COUNT(DISTINCT msisdn text) ON subscriber_dump heap', dedupA, [cellIds]);

    const dedupC = `SELECT COUNT(DISTINCT subscriber_id) FROM subscriber_cell_index WHERE serving_cell_id = ANY($1::text[])`;
    try {
      report += await explain(client, 'VERSION C DEDUP: COUNT(DISTINCT subscriber_id int4) ON subscriber_cell_index CLUSTERed', dedupC, [cellIds]);
    } catch (e: any) {
      report += `VERSION C DEDUP skipped: ${e.message}\n`;
    }

    const dedupB = `SELECT COUNT(DISTINCT id::int4) FROM subscriber_dump WHERE serving_cell_id = ANY($1::text[])`;
    report += await explain(client, 'VERSION B DEDUP: COUNT(DISTINCT id int4) ON subscriber_dump (heap or covering index if present)', dedupB, [cellIds]);

    writeFileSync(OUT, report + '\n');
    console.log(`wrote ${OUT}`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
