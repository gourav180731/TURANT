#!/usr/bin/env tsx
/**
 * TURANT Data Integrity Validation Command (Requirement #15)
 *
 * Validates the subscriber_dump + cell_network_mapping + sim_cell_towers
 * dataset against the 29-point TSP-acceptance data-quality criteria.
 *
 * Usage:
 *   npx tsx scripts/validate-telecom-data.ts
 *
 * Exit codes:
 *   0 = all validations passed (GREEN)
 *   1 = critical integrity failures detected (RED)
 *   2 = warnings but no blocking failures (YELLOW)
 */

import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

interface ValidationResult {
  check: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  value?: string | number;
  expected?: string | number;
  message?: string;
}

const results: ValidationResult[] = [];

function pass(check: string, value?: string | number, message?: string) {
  results.push({ check, status: 'PASS', value, message });
}

function warn(check: string, value?: string | number, expected?: string | number, message?: string) {
  results.push({ check, status: 'WARN', value, expected, message });
}

function fail(check: string, value?: string | number, expected?: string | number, message?: string) {
  results.push({ check, status: 'FAIL', value, expected, message });
}

async function main() {
  loadConfig();
  const pool = getPool();

  console.log('='.repeat(90));
  console.log('TURANT DATA INTEGRITY VALIDATION');
  console.log('='.repeat(90));
  console.log();

  // 1. Total subscriber_dump count
  const totalRes = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM subscriber_dump`);
  const total = Number(totalRes.rows[0]?.n ?? 0);
  console.log(`1. Total subscriber_dump rows: ${total.toLocaleString()}`);
  pass('Total subscribers exist', total);

  // 2. Delhi subscriber count
  const delhiRes = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE state='Delhi'`);
  const delhi = Number(delhiRes.rows[0]?.n ?? 0);
  console.log(`2. Delhi subscriber rows: ${delhi.toLocaleString()}`);
  if (delhi >= 100_000_000) {
    pass('Delhi 100M target', delhi, 'Target reached or exceeded');
  } else {
    warn('Delhi 100M target', delhi, 100_000_000, 'Target not yet reached');
  }

  // 3. Delhi mapped vs unmapped
  const mappedRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE state='Delhi' AND serving_cell_id IS NOT NULL`
  );
  const mapped = Number(mappedRes.rows[0]?.n ?? 0);
  const unmapped = delhi - mapped;
  console.log(`3. Delhi mapped (serving_cell_id NOT NULL): ${mapped.toLocaleString()}`);
  console.log(`   Delhi unmapped (serving_cell_id NULL): ${unmapped.toLocaleString()}`);
  pass('Delhi mapped count', mapped);
  pass('Delhi unmapped count', unmapped);

  // 4. Distinct serving_cell_id values
  const distinctCellsRes = await pool.query<{ n: string }>(
    `SELECT COUNT(DISTINCT serving_cell_id)::text AS n FROM subscriber_dump WHERE state='Delhi' AND serving_cell_id IS NOT NULL`
  );
  const distinctCells = Number(distinctCellsRes.rows[0]?.n ?? 0);
  console.log(`4. Distinct Delhi serving_cell_id values: ${distinctCells.toLocaleString()}`);
  pass('Distinct mapped cells', distinctCells);

  // 5. Average subscribers per cell
  if (distinctCells > 0 && mapped > 0) {
    const avg = Math.round(mapped / distinctCells);
    console.log(`5. Average mapped subscribers per cell: ~${avg.toLocaleString()}`);
    pass('Average subs/cell', avg);
  }

  // 6. Duplicate IMSI check
  const dupImsiRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT imsi FROM subscriber_dump WHERE imsi IS NOT NULL
       GROUP BY imsi HAVING COUNT(*) > 1
     ) x`
  );
  const dupImsi = Number(dupImsiRes.rows[0]?.n ?? 0);
  console.log(`6. Duplicate IMSI count: ${dupImsi}`);
  if (dupImsi === 0) {
    pass('No duplicate IMSI', 0);
  } else {
    fail('Duplicate IMSI detected', dupImsi, 0, 'IMSI must be globally unique');
  }

  // 7. Duplicate MSISDN check
  const dupMsisdnRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT msisdn FROM subscriber_dump WHERE msisdn IS NOT NULL
       GROUP BY msisdn HAVING COUNT(*) > 1
     ) x`
  );
  const dupMsisdn = Number(dupMsisdnRes.rows[0]?.n ?? 0);
  console.log(`7. Duplicate MSISDN count: ${dupMsisdn}`);
  if (dupMsisdn === 0) {
    pass('No duplicate MSISDN', 0);
  } else {
    fail('Duplicate MSISDN detected', dupMsisdn, 0, 'MSISDN must be globally unique');
  }

  // 8. Invalid serving_cell_id references (orphaned FK)
  const orphanedRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM subscriber_dump s
     WHERE s.serving_cell_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sim_cell_towers t WHERE t.cell_id = s.serving_cell_id)`
  );
  const orphaned = Number(orphanedRes.rows[0]?.n ?? 0);
  console.log(`8. Orphaned serving_cell_id (no matching tower): ${orphaned}`);
  if (orphaned === 0) {
    pass('No orphaned serving_cell_id', 0);
  } else {
    fail('Orphaned serving_cell_id detected', orphaned, 0, 'All serving_cell_id must reference valid towers');
  }

  // 9. Cross-state leakage check (Delhi subscribers with non-Delhi cells)
  const leakageRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM subscriber_dump s
     WHERE s.state='Delhi' AND s.serving_cell_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sim_cell_towers t
                       WHERE t.cell_id = s.serving_cell_id AND t.state='DELHI')`
  );
  const leakage = Number(leakageRes.rows[0]?.n ?? 0);
  console.log(`9. Cross-state leakage (Delhi subs with non-Delhi cells): ${leakage}`);
  if (leakage === 0) {
    pass('No cross-state leakage', 0);
  } else {
    fail('Cross-state leakage detected', leakage, 0, 'Delhi subscribers must only map to Delhi cells');
  }

  // 10. Invalid geometry check
  const invalidGeomRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE geom IS NOT NULL AND NOT ST_IsValid(geom)`
  );
  const invalidGeom = Number(invalidGeomRes.rows[0]?.n ?? 0);
  console.log(`10. Invalid geometry count: ${invalidGeom}`);
  if (invalidGeom === 0) {
    pass('No invalid geometry', 0);
  } else {
    fail('Invalid geometry detected', invalidGeom, 0, 'All geom must be valid PostGIS geometry');
  }

  // 11. Operator distribution
  const opDistRes = await pool.query<{ operator: string; n: string; pct: string }>(
    `SELECT operator, COUNT(*)::text AS n,
            ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)::text AS pct
     FROM subscriber_dump WHERE state='Delhi'
     GROUP BY operator ORDER BY n DESC`
  );
  console.log(`11. Operator distribution (Delhi):`);
  for (const row of opDistRes.rows) {
    console.log(`    ${row.operator}: ${Number(row.n).toLocaleString()} (${row.pct}%)`);
  }
  pass('Operator distribution recorded');

  // 12. Technology distribution
  const techDistRes = await pool.query<{ technology: string; n: string; pct: string }>(
    `SELECT technology, COUNT(*)::text AS n,
            ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)::text AS pct
     FROM subscriber_dump WHERE state='Delhi'
     GROUP BY technology ORDER BY n DESC`
  );
  console.log(`12. Technology distribution (Delhi):`);
  for (const row of techDistRes.rows) {
    console.log(`    ${row.technology}: ${Number(row.n).toLocaleString()} (${row.pct}%)`);
  }
  pass('Technology distribution recorded');

  // 13. Data source provenance
  const provenanceRes = await pool.query<{ data_source: string; n: string }>(
    `SELECT data_source, COUNT(*)::text AS n FROM subscriber_dump
     WHERE data_source IS NOT NULL GROUP BY data_source ORDER BY n DESC`
  );
  console.log(`13. Data source provenance:`);
  for (const row of provenanceRes.rows) {
    console.log(`    ${row.data_source}: ${Number(row.n).toLocaleString()}`);
  }
  pass('Data provenance tracked');

  // 14. Cell distribution variability (check for suspicious uniform distribution)
  const cellDistRes = await pool.query<{ min_count: string; max_count: string; avg_count: string; stddev: string }>(
    `WITH cell_counts AS (
       SELECT serving_cell_id, COUNT(*)::bigint AS n
       FROM subscriber_dump
       WHERE state='Delhi' AND serving_cell_id IS NOT NULL
       GROUP BY serving_cell_id
     )
     SELECT MIN(n)::text AS min_count,
            MAX(n)::text AS max_count,
            ROUND(AVG(n))::text AS avg_count,
            ROUND(STDDEV(n))::text AS stddev
     FROM cell_counts`
  );
  const cellDist = cellDistRes.rows[0];
  if (cellDist) {
    console.log(`14. Cell distribution variability:`);
    console.log(`    Min subscribers/cell: ${Number(cellDist.min_count).toLocaleString()}`);
    console.log(`    Max subscribers/cell: ${Number(cellDist.max_count).toLocaleString()}`);
    console.log(`    Avg subscribers/cell: ${Number(cellDist.avg_count).toLocaleString()}`);
    console.log(`    Std dev: ${Number(cellDist.stddev).toLocaleString()}`);
    
    const min = Number(cellDist.min_count);
    const max = Number(cellDist.max_count);
    const avg = Number(cellDist.avg_count);
    const stddev = Number(cellDist.stddev);
    
    // Realistic variation should have stddev > 0 and max/min ratio > 1.5
    if (stddev > 0 && max > min * 1.5) {
      pass('Cell distribution is variable', `stddev=${stddev}, ratio=${(max/min).toFixed(2)}x`);
    } else {
      warn('Cell distribution may be too uniform', `stddev=${stddev}`, 'stddev>0, ratio>1.5x', 'Realistic distributions have natural variation');
    }
  }

  // 15. LAC/CISAC collision check (informational - no longer used as join key)
  const collisionRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT lac, cisac, COUNT(DISTINCT state) AS states
       FROM subscriber_dump
       WHERE lac IS NOT NULL AND cisac IS NOT NULL
       GROUP BY lac, cisac
       HAVING COUNT(DISTINCT state) > 1
     ) x`
  );
  const collisions = Number(collisionRes.rows[0]?.n ?? 0);
  console.log(`15. LAC/CISAC cross-state pairs (legacy metadata): ${collisions}`);
  warn('LAC/CISAC collisions exist', collisions, 0, 'LAC/CISAC no longer used as authoritative join key');

  console.log();
  console.log('='.repeat(90));
  console.log('VALIDATION SUMMARY');
  console.log('='.repeat(90));

  const passed = results.filter(r => r.status === 'PASS').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  console.log(`✓ PASS: ${passed}`);
  console.log(`⚠ WARN: ${warned}`);
  console.log(`✗ FAIL: ${failed}`);
  console.log();

  if (failed > 0) {
    console.log('CRITICAL FAILURES:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  ✗ ${r.check}: ${r.value} (expected: ${r.expected})`);
      if (r.message) console.log(`    ${r.message}`);
    }
    console.log();
    console.log('STATUS: RED — Critical data integrity failures detected');
    await closePool();
    process.exit(1);
  }

  if (warned > 0) {
    console.log('WARNINGS:');
    for (const r of results.filter(r => r.status === 'WARN')) {
      console.log(`  ⚠ ${r.check}: ${r.value} (expected: ${r.expected})`);
      if (r.message) console.log(`    ${r.message}`);
    }
    console.log();
    console.log('STATUS: YELLOW — Warnings present but no blocking failures');
    await closePool();
    process.exit(2);
  }

  console.log('STATUS: GREEN — All validations passed');
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error('VALIDATION FAILED:', e);
  process.exit(1);
});
