#!/usr/bin/env tsx
/**
 * Fast EXPLAIN (ANALYZE, BUFFERS) — OPTIMIZED PATH ONLY
 * (no 558s VERSION A legacy scan)
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';
import { buildNarrowAccessStatsQuery } from '../src/telecom/matcher/subscriber-cell-matcher.js';

const OUT = resolve(process.cwd(), '.explain-analyze-50k-optimized.md');

async function explain(conn: any, label: string, sqlText: string, values: unknown[]): Promise<string> {
  const s = performance.now();
  const plan = await conn.query(`EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${sqlText}`, values);
  const ms = performance.now() - s;
  const planText = plan.rows.map((r: any) => Object.values(r)[0]).join('\n');
  return `\n\n## ${label}\n\nwall-clock (node): ${ms.toFixed(0)} ms\n\n\`\`\`sql\n${sqlText.trim()}\n\`\`\`\n\n### Plan\n\n\`\`\`\n${planText}\n\`\`\`\n`;
}

async function main(): Promise<void> {
  loadConfig();
  const cfg = loadConfig();
  const pool = getPool();
  const client = await pool.connect();
  try {
    const cellsSql = `SELECT cell_id FROM sim_cell_towers WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT 50000`;
    const cellsRes = await client.query<{ cell_id: string }>(cellsSql);
    const cellIds = cellsRes.rows.map(r => r.cell_id);

    let report = `# EXPLAIN (ANALYZE, BUFFERS) — OPTIMIZED 50,000 cell subscriber match\n`;
    report += `\nGenerated: ${new Date().toISOString()}\n`;
    report += `\nCells: **${cellIds.length.toLocaleString()}** (sim_cell_towers ORDER BY cell_id LIMIT 50000)\n`;
    report += `\nOptimization: NO dedup scan. proven invariant 0 subscribers in >1 cell → unique=SUM(stats)\n`;

    // VERSION C (now WITHOUT dedup CTE)
    const opt = buildNarrowAccessStatsQuery(cfg, cellIds);
    report += await explain(client, 'VERSION C FINAL — cell_subscriber_stats SUM, NO dedup CTE (proven invariant: unique≡SUM)', opt.text, opt.values);

    // VERSION D postings dedup (for comparison, even though we don't need it now)
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
      report += await explain(client, 'VERSION D — intarray postings (dedup via UNNEST+DISTINCT, baseline for comparison)', postingsSql, [cellIds]);
    } catch (e: any) {
      report += `\nVERSION D skipped: ${String(e?.message ?? e)}\n`;
    }

    writeFileSync(OUT, report + '\n');
    console.log(`wrote ${OUT}`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
