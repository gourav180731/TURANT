import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

/**
 * Recreate the 8 secondary indexes dropped before the bulk reload.
 * Indexes match migration 008 (btrees) + legacy migrations (lac_cisac,
 * area_msisdn, geom). All built CONCURRENTLY so reads are never blocked.
 */
const INDEXES: { name: string; ddl: string }[] = [
  { name: 'idx_subscriber_dump_serving_cell', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_serving_cell ON subscriber_dump (serving_cell_id)' },
  { name: 'idx_subscriber_dump_state', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_state ON subscriber_dump (state)' },
  { name: 'idx_subscriber_dump_operator', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_operator ON subscriber_dump (operator)' },
  { name: 'idx_subscriber_dump_technology', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_technology ON subscriber_dump (technology)' },
  { name: 'idx_subscriber_dump_state_operator', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_state_operator ON subscriber_dump (state, operator)' },
  { name: 'idx_subscriber_dump_lac_cisac', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_lac_cisac ON subscriber_dump (lac, cisac)' },
  { name: 'idx_subscriber_dump_area_msisdn', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_area_msisdn ON subscriber_dump (lac, cisac, msisdn)' },
  { name: 'idx_subscriber_dump_geom', ddl: 'CREATE INDEX CONCURRENTLY idx_subscriber_dump_geom ON subscriber_dump USING gist (geom)' },
];

async function main() {
  loadConfig();
  const pool = getPool();
  for (const idx of INDEXES) {
    const t = performance.now();
    try {
      await pool.query(idx.ddl);
      console.log(`created ${idx.name} in ${Math.round((performance.now() - t) / 1000)}s`);
    } catch (e: any) {
      console.error(`FAILED ${idx.name}:`, e.message);
    }
  }
  const r = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='subscriber_dump' ORDER BY indexname`);
  console.log('final indexes:', r.rows.map((x) => x.indexname).join(', '));
  await closePool();
}
main().catch((e) => { console.error('SCRIPT FAILED:', e); process.exit(1); });