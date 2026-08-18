import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

loadConfig();

const MIGRATION_DIR = path.resolve(import.meta.dirname!, '..', 'migrations');

async function section(title: string) {
  console.log('\n' + '='.repeat(110));
  console.log('  ' + title);
  console.log('='.repeat(110));
}

async function run(client: any, label: string, sql: string) {
  const start = performance.now();
  try {
    await client.query(sql);
    console.log(`  ✅ ${label}  [${((performance.now() - start) / 1000).toFixed(1)} s]`);
    return true;
  } catch (e: any) {
    console.log(`  ⚠️  ${label}  [${((performance.now() - start) / 1000).toFixed(1)} s]  ${e.message?.slice(0, 200)}`);
    return false;
  }
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  await client.query("SET work_mem='512MB'; SET maintenance_work_mem='1GB'; SET max_parallel_workers_per_gather=4;");

  await section('PRE-CHECK: drop leftover dedup artifacts');
  await run(client, 'DROP TABLE tmp_dup_msisdn', 'DROP TABLE IF EXISTS tmp_dup_msisdn');
  await run(client, 'DROP INDEX idx_dedup_imsi', 'DROP INDEX IF EXISTS idx_dedup_imsi');
  await run(client, 'DROP INDEX idx_dedup_msisdn', 'DROP INDEX IF EXISTS idx_dedup_msisdn');

  const idx = await client.query("SELECT indexname FROM pg_indexes WHERE tablename='subscriber_dump' AND indexname LIKE 'idx_dedup_%'");
  console.log('  leftover dedup indexes:', idx.rows.length ? idx.rows.map((r: any) => r.indexname).join(', ') : 'none');

  await section('APPLYING MIGRATION 009');
  const mig009 = fs.readFileSync(path.join(MIGRATION_DIR, '009_subscriber_dump_constraints.sql'), 'utf8');

  // Step 1: UNIQUE INDEX CONCURRENTLY — run OUTSIDE transaction (whole file can't run in one TX
  // because CREATE UNIQUE INDEX CONCURRENTLY is used). Run the unique-index creation separately,
  // then the rest (CHECK constraints) in one TX.
  await section('009-1: UNIQUE INDEX CONCURRENTLY on imsi (94M rows — slow)');
  const t1 = performance.now();
  await run(pool, 'CREATE UNIQUE INDEX CONCURRENTLY ux_subscriber_dump_imsi',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriber_dump_imsi ON subscriber_dump(imsi)');
  console.log(`  [${((performance.now() - t1) / 1000).toFixed(1)} s total]`);

  await section('009-2: UNIQUE INDEX CONCURRENTLY on msisdn (94M rows — slow)');
  const t2 = performance.now();
  await run(pool, 'CREATE UNIQUE INDEX CONCURRENTLY ux_subscriber_dump_msisdn',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriber_dump_msisdn ON subscriber_dump(msisdn)');
  console.log(`  [${((performance.now() - t2) / 1000).toFixed(1)} s total]`);

  await section('009-3: constraints + CHECKs (one TX)');
  const start = performance.now();
  await client.query('BEGIN');
  try {
    // Add UNIQUE constraints using the existing indexes
    await client.query(`ALTER TABLE subscriber_dump ADD CONSTRAINT uq_subdump_imsi UNIQUE USING INDEX ux_subscriber_dump_imsi`);
    console.log('  ✅ uq_subdump_imsi (via index)');
    await client.query(`ALTER TABLE subscriber_dump ADD CONSTRAINT uq_subdump_msisdn UNIQUE USING INDEX ux_subscriber_dump_msisdn`);
    console.log('  ✅ uq_subdump_msisdn (via index)');

    // CHECK constraints (DO-block guarded in migration file — run directly)
    const checks = [
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_imsi_fmt CHECK (imsi IS NULL OR imsi ~ '^(404|405)[0-9]{12}$')`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_msisdn_fmt CHECK (msisdn ~ '^91[6-9][0-9]{9}$')`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_lat_range CHECK (latitude IS NULL OR (latitude::float BETWEEN 6.0 AND 37.0))`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_lng_range CHECK (longitude IS NULL OR (longitude::float BETWEEN 67.0 AND 98.0))`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_lac_fmt CHECK (lac IS NULL OR lac ~ '^[0-9A-Fa-f]{4}$')`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_cisac_fmt CHECK (cisac IS NULL OR cisac ~ '^[0-9A-Fa-f]{4}$')`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_tech CHECK (technology IN ('5G','4G','UMTS','GSM','LTE','NR5G'))`,
      `ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_op CHECK (operator IN ('Jio','Airtel','VI','BSNL','MTNL'))`,
    ];
    for (const c of checks) {
      try {
        await client.query(c);
        console.log(`  ✅ ${c.split('ADD CONSTRAINT ')[1].split(' ')[0]}`);
      } catch (e: any) {
        console.log(`  ⚠️  ${e.message?.slice(0, 160)}`);
      }
    }
    await client.query('COMMIT');
    console.log(`  ✅ Constraints TX committed  [${((performance.now() - start) / 1000).toFixed(1)} s]`);
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.log(`  ❌ Constraints TX failed: ${e.message?.slice(0, 300)}`);
    client.release();
    await closePool();
    process.exit(1);
  }

  await section('VERIFY 009 APPLIED');
  const cons = await client.query(`
    SELECT conname, convalidated FROM pg_constraint
    WHERE conrelid='subscriber_dump'::regclass ORDER BY conname
  `);
  console.log('  Constraints:');
  for (const c of cons.rows) console.log(`    ${String(c.conname).padEnd(34)} validated=${c.convalidated}`);

  client.release();
  await closePool();

  console.log('\n' + '='.repeat(110));
  console.log('  MIGRATION 009 COMPLETE.');
  console.log('  Next: generate ~97M Delhi expansion subscribers (cell-bound),');
  console.log('        then VALIDATE CONSTRAINT fk_subdump_serving_cell.');
  console.log('='.repeat(110));
}

main().catch((e) => { console.error('Migration runner FAILED:', e); process.exit(1); });
