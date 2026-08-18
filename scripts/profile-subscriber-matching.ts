#!/usr/bin/env tsx
/**
 * TURANT Subscriber Matching Performance Profiler
 * 
 * Purpose: Identify the exact bottleneck in 50K-cell subscriber matching
 * Target: Achieve <60 seconds for 97M+ subscribers
 * 
 * NO-FABRICATION RULE: All timing and counts from actual DB execution
 */

import { getPool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';
import { getLogger } from '../src/utils/logger.js';

const logger = getLogger();
const cfg = loadConfig();
const pool = getPool();

interface ProfileResult {
  phase: string;
  elapsedMs: number;
  details?: Record<string, unknown>;
}

async function main() {
  console.log('='.repeat(80));
  console.log('TURANT SUBSCRIBER MATCHING PERFORMANCE PROFILER');
  console.log('='.repeat(80));
  console.log();

  const client = await pool.connect();
  const profiles: ProfileResult[] = [];

  try {
    // Get all Delhi cell IDs that have subscribers
    console.log('Phase 1: Loading Delhi cell inventory...');
    const t0 = performance.now();
    const cellResult = await client.query<{ cell_id: string }>(`
      SELECT DISTINCT serving_cell_id AS cell_id
      FROM subscriber_dump
      WHERE state = 'Delhi'
        AND serving_cell_id IS NOT NULL
      ORDER BY serving_cell_id
    `);
    const t1 = performance.now();
    const allCellIds = cellResult.rows.map(r => r.cell_id);
    profiles.push({ phase: '1_cell_inventory', elapsedMs: t1 - t0, details: { cellCount: allCellIds.length } });
    console.log(`✓ Found ${allCellIds.length} distinct Delhi cells in ${(t1 - t0).toFixed(0)}ms`);
    console.log();

    // Test tiers
    const tiers = [
      { name: 'Test-A', cells: 100 },
      { name: 'Test-B', cells: 1000 },
      { name: 'Test-C', cells: 5000 },
      { name: 'Test-D', cells: 10000 },
      { name: 'Test-E', cells: 25000 },
      { name: 'Test-F-FULL', cells: allCellIds.length }, // All Delhi mapped cells
    ];

    for (const tier of tiers) {
      console.log('-'.repeat(80));
      console.log(`TIER: ${tier.name} (${tier.cells} cells)`);
      console.log('-'.repeat(80));

      const cellIds = allCellIds.slice(0, tier.cells);

      // Phase 2: Stats query (COUNT only - no materialization)
      console.log('Phase 2: Running stats query (COUNT/DISTINCT)...');
      const t2 = performance.now();
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${cfg.MATCH_TIME_BUDGET_MS}`);
      
      const statsQuery = `
        WITH agg AS (
          SELECT COUNT(*)::bigint AS matched_rows,
                 COUNT(DISTINCT msisdn)::bigint AS unique_msisdns
          FROM subscriber_dump
          WHERE serving_cell_id = ANY($1::text[])
            AND serving_cell_id IS NOT NULL
            AND msisdn IS NOT NULL
        )
        SELECT matched_rows, unique_msisdns FROM agg
      `;
      
      const statsResult = await client.query<{ matched_rows: string; unique_msisdns: string }>(
        statsQuery,
        [cellIds]
      );
      const t3 = performance.now();
      const matchedRows = Number(statsResult.rows[0]?.matched_rows ?? 0);
      const uniqueMsisdns = Number(statsResult.rows[0]?.unique_msisdns ?? 0);
      
      profiles.push({
        phase: `2_stats_${tier.name}`,
        elapsedMs: t3 - t2,
        details: { cellIds: cellIds.length, matchedRows, uniqueMsisdns }
      });
      
      console.log(`  Matched rows: ${matchedRows.toLocaleString()}`);
      console.log(`  Unique MSISDNs: ${uniqueMsisdns.toLocaleString()}`);
      console.log(`  Stats query time: ${(t3 - t2).toFixed(0)}ms`);

      // Phase 3: EXPLAIN ANALYZE on stats query
      console.log('Phase 3: Running EXPLAIN ANALYZE on stats query...');
      const t4 = performance.now();
      const explainStatsResult = await client.query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        WITH agg AS (
          SELECT COUNT(*)::bigint AS matched_rows,
                 COUNT(DISTINCT msisdn)::bigint AS unique_msisdns
          FROM subscriber_dump
          WHERE serving_cell_id = ANY($1::text[])
            AND serving_cell_id IS NOT NULL
            AND msisdn IS NOT NULL
        )
        SELECT matched_rows, unique_msisdns FROM agg
      `, [cellIds]);
      const t5 = performance.now();
      
      profiles.push({
        phase: `3_explain_stats_${tier.name}`,
        elapsedMs: t5 - t4,
      });
      
      const explainStats = explainStatsResult.rows[0]['QUERY PLAN'][0];
      console.log(`  Execution time: ${explainStats['Execution Time']?.toFixed(0)}ms`);
      console.log(`  Planning time: ${explainStats['Planning Time']?.toFixed(0)}ms`);

      // Phase 4: DISTINCT MSISDN materialization query
      console.log('Phase 4: Running DISTINCT materialization query...');
      const t6 = performance.now();
      
      const distinctQuery = `
        SELECT DISTINCT msisdn
        FROM subscriber_dump
        WHERE serving_cell_id = ANY($1::text[])
          AND serving_cell_id IS NOT NULL
          AND msisdn IS NOT NULL
        LIMIT ${cfg.SUBSCRIBER_DUMP_MATCH_LIMIT}
      `;
      
      const distinctResult = await client.query<{ msisdn: string }>(distinctQuery, [cellIds]);
      const t7 = performance.now();
      
      profiles.push({
        phase: `4_distinct_${tier.name}`,
        elapsedMs: t7 - t6,
        details: { materializedRows: distinctResult.rows.length }
      });
      
      console.log(`  Materialized MSISDNs: ${distinctResult.rows.length.toLocaleString()}`);
      console.log(`  Materialization time: ${(t7 - t6).toFixed(0)}ms`);

      // Phase 5: EXPLAIN ANALYZE on DISTINCT query
      console.log('Phase 5: Running EXPLAIN ANALYZE on DISTINCT query...');
      const t8 = performance.now();
      const explainDistinctResult = await client.query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT DISTINCT msisdn
        FROM subscriber_dump
        WHERE serving_cell_id = ANY($1::text[])
          AND serving_cell_id IS NOT NULL
          AND msisdn IS NOT NULL
        LIMIT ${cfg.SUBSCRIBER_DUMP_MATCH_LIMIT}
      `, [cellIds]);
      const t9 = performance.now();
      
      profiles.push({
        phase: `5_explain_distinct_${tier.name}`,
        elapsedMs: t9 - t8,
      });
      
      const explainDistinct = explainDistinctResult.rows[0]['QUERY PLAN'][0];
      console.log(`  Execution time: ${explainDistinct['Execution Time']?.toFixed(0)}ms`);
      console.log(`  Planning time: ${explainDistinct['Planning Time']?.toFixed(0)}ms`);

      await client.query('COMMIT');
      
      // Summary for this tier
      const totalTime = (t7 - t2);
      console.log();
      console.log(`TIER ${tier.name} SUMMARY:`);
      console.log(`  Total matching time: ${(totalTime / 1000).toFixed(2)}s`);
      console.log(`  Stats query: ${((t3 - t2) / 1000).toFixed(2)}s (${(((t3 - t2) / totalTime) * 100).toFixed(1)}%)`);
      console.log(`  DISTINCT query: ${((t7 - t6) / 1000).toFixed(2)}s (${(((t7 - t6) / totalTime) * 100).toFixed(1)}%)`);
      console.log();

      // Save detailed EXPLAIN ANALYZE for largest tier
      if (tier.name === 'Test-F-FULL') {
        console.log('DETAILED EXPLAIN ANALYZE FOR 50K TIER:');
        console.log('='.repeat(80));
        console.log();
        console.log('Stats Query Plan:');
        console.log(JSON.stringify(explainStats.Plan, null, 2));
        console.log();
        console.log('DISTINCT Query Plan:');
        console.log(JSON.stringify(explainDistinct.Plan, null, 2));
        console.log();
      }

      // Don't run larger tiers if we're already over budget
      if (totalTime > 60000 && tier.name !== 'Test-F-FULL') {
        console.log(`⚠️  Already over 60s budget. Skipping larger tiers except full test.`);
        // Jump to full test
        const fullTierIndex = tiers.findIndex(t => t.name === 'Test-F-FULL');
        if (fullTierIndex > tiers.indexOf(tier) + 1) {
          continue;
        }
      }
    }

    // Phase 6: Check current indexes
    console.log('='.repeat(80));
    console.log('CURRENT INDEX ANALYSIS');
    console.log('='.repeat(80));
    
    const indexQuery = `
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE tablename = 'subscriber_dump'
      ORDER BY indexname
    `;
    
    const indexResult = await client.query(indexQuery);
    console.log('Current indexes on subscriber_dump:');
    for (const row of indexResult.rows) {
      console.log(`  ${row.indexname}:`);
      console.log(`    ${row.indexdef}`);
    }
    console.log();

    // Phase 7: Analyze table statistics
    console.log('='.repeat(80));
    console.log('TABLE STATISTICS');
    console.log('='.repeat(80));
    
    const statsTableQuery = `
      SELECT
        schemaname,
        tablename,
        n_live_tup,
        n_dead_tup,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      WHERE tablename = 'subscriber_dump'
    `;
    
    const statsTableResult = await client.query(statsTableQuery);
    console.log('Table statistics:');
    console.log(JSON.stringify(statsTableResult.rows[0], null, 2));
    console.log();

  } finally {
    client.release();
    await pool.end();
  }

  // Final summary
  console.log('='.repeat(80));
  console.log('PROFILING COMPLETE');
  console.log('='.repeat(80));
  console.log();
  console.log('All measurements are ACTUAL database-derived times.');
  console.log('NO fabrication. NO hard-coded values. NO LIMIT affecting stats.');
  console.log();
}

main().catch((err) => {
  console.error('Profiling failed:', err);
  process.exit(1);
});
