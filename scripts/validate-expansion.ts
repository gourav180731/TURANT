import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

/**
 * Post-expansion validation (run AFTER the generator completes and AFTER
 * indexes are rebuilt):
 *   1. Validate the NOT VALID FK fk_subdump_serving_cell.
 *   2. Count checks (Delhi = 100M, expansion rows, formats, FK orphans).
 *   3. Collision: no legacy row shares IMSI/MSISDN with expansion.
 */
async function main() {
  loadConfig();
  const pool = getPool();
  const t0 = performance.now();
  try {
    await pool.query('ALTER TABLE subscriber_dump VALIDATE CONSTRAINT fk_subdump_serving_cell');
    console.log(`VALIDATE fk_subdump_serving_cell OK (${Math.round((performance.now() - t0) / 1000)}s)`);
  } catch (e: any) {
    console.error('FK VALIDATION FAILED:', e.message);
    process.exit(1);
  }

  const checks: [string, string][] = [
    ['delhi total', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE state='Delhi'`],
    ['expansion rows', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE data_source='synthetic_delhi_expansion_v1'`],
    ['legacy rows', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE data_source IS DISTINCT FROM 'synthetic_delhi_expansion_v1'`],
    ['table total', `SELECT COUNT(*)::text AS n FROM subscriber_dump`],
    ['null serving_cell', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE serving_cell_id IS NULL`],
    ['orphan serving_cell', `SELECT COUNT(*)::text AS n FROM subscriber_dump d WHERE serving_cell_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sim_cell_towers s WHERE s.cell_id = d.serving_cell_id)`],
    ['bad imsi fmt', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE imsi !~ '^(404|405)[0-9]{12}$'`],
    ['bad msisdn fmt', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE msisdn !~ '^91[6-9][0-9]{9}$'`],
    ['dup imsi', `SELECT COUNT(*)::text AS n FROM (SELECT imsi FROM subscriber_dump GROUP BY imsi HAVING COUNT(*) > 1) x`],
    ['dup msisdn', `SELECT COUNT(*)::text AS n FROM (SELECT msisdn FROM subscriber_dump GROUP BY msisdn HAVING COUNT(*) > 1) x`],
    ['null geom (expansion)', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE data_source='synthetic_delhi_expansion_v1' AND geom IS NULL`],
    ['geom not point (expansion)', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE data_source='synthetic_delhi_expansion_v1' AND GeometryType(geom) <> 'POINT'`],
    ['non-delhi state (expansion)', `SELECT COUNT(*)::text AS n FROM subscriber_dump WHERE data_source='synthetic_delhi_expansion_v1' AND state <> 'Delhi'`],
    ['non-delhi cell (expansion)', `SELECT COUNT(*)::text AS n FROM subscriber_dump d WHERE d.data_source='synthetic_delhi_expansion_v1' AND NOT EXISTS (SELECT 1 FROM sim_cell_towers s WHERE s.cell_id=d.serving_cell_id AND s.state='DELHI')`],
  ];
  for (const [label, sql] of checks) {
    const t = performance.now();
    try {
      const r = await pool.query(sql);
      console.log(`${label.padEnd(34)} = ${r.rows[0]?.n}  (${Math.round((performance.now() - t) / 1000)}s)`);
    } catch (e: any) {
      console.error(`${label} FAILED:`, e.message);
    }
  }
  await closePool();
}
main().catch((e) => { console.error('SCRIPT FAILED:', e); process.exit(1); });