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

async function runSQL(client: any, label: string, sql: string) {
  const start = performance.now();
  try {
    await client.query(sql);
    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`  ✅ ${label}  [${elapsed} ms]`);
    return true;
  } catch (e: any) {
    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`  ⚠️  ${label}  [${elapsed} ms]  ${e.message?.slice(0, 160)}`);
    return false;
  }
}

async function runWithoutTx(pool: any, label: string, sql: string) {
  const start = performance.now();
  try {
    await pool.query(sql);
    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`  ✅ ${label}  [${elapsed} ms]`);
    return true;
  } catch (e: any) {
    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`  ⚠️  ${label}  [${elapsed} ms]  ${e.message?.slice(0, 200)}`);
    return false;
  }
}

async function splitStatements(sql: string): string[] {
  // Very simple: split on DO blocks separately, then semicolons otherwise.
  const out: string[] = [];
  const re = /DO\s*\$\$[\s\S]*?\$\$\s*;|COMMENT\s+ON\s+[\s\S]*?;|CREATE\s+INDEX\s+[\s\S]*?;|ALTER\s+TABLE\s+[\s\S]*?;/gi;
  const matches = sql.matchAll(re);
  for (const m of matches) {
    const stmt = m[0].trim();
    if (stmt.length > 0) out.push(stmt);
  }
  return out;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();

  // =====================================================================
  // BACKUP SNAPSHOT STEP (Rollback procedure Section 1.B)
  // =====================================================================
  await section('PRE-MIGRATION: STATS SNAPSHOT + IN-PLACE SNAPSHOT TABLES');

  await runSQL(client, 'Create stats snapshot table (fast — row count + pg_class estimate)', `
    CREATE TABLE IF NOT EXISTS subdump_pre_migration_stats_202603 AS
    SELECT
      (SELECT COUNT(*) FROM subscriber_dump)                       AS rows,
      (SELECT reltuples::bigint FROM pg_class WHERE relname='subscriber_dump') AS estimated_rows,
      (SELECT COUNT(*) FROM pg_indexes WHERE tablename='subscriber_dump') AS index_count,
      NOW()                                                         AS snapshotted_at
  `);

  await runSQL(client, 'Snapshot cell_network_mapping (150K rows — full copy)', `
    CREATE TABLE IF NOT EXISTS cell_network_mapping_snapshot_202603
      AS TABLE cell_network_mapping WITH DATA
  `);
  await runSQL(client, 'Snapshot cell_subscriber_mapping (50K rows)', `
    CREATE TABLE IF NOT EXISTS cell_subscriber_mapping_snapshot_202603
      AS TABLE cell_subscriber_mapping WITH DATA
  `);
  await runSQL(client, 'Snapshot sim_seeder_checkpoints', `
    CREATE TABLE IF NOT EXISTS sim_seeder_checkpoints_snapshot_202603
      AS TABLE sim_seeder_checkpoints WITH DATA
  `);

  const snap = await client.query('SELECT * FROM subdump_pre_migration_stats_202603 LIMIT 1');
  if (snap.rows.length > 0) {
    console.log('\n  SNAPSHOT STATS (baseline):');
    for (const [k, v] of Object.entries(snap.rows[0])) {
      if (k === 'snapshotted_at') continue;
      console.log(`    ${k.padEnd(20)} = ${String(v).padStart(12)}`);
    }
    console.log(`    snapshotted_at       = ${String(snap.rows[0].snapshotted_at)}`);
  }

  // =====================================================================
  // APPLY MIGRATION 008 (run all non-CREATE-INDEX statements in one TX)
  // Migration 008 has: column adds, DO blocks, COMMENT, CREATE INDEX non-concurrent
  // =====================================================================
  await section('APPLYING MIGRATION 008: schema + constraints + indexes');

  const mig008Path = path.join(MIGRATION_DIR, '008_subscriber_dump_serving_cell.sql');
  const mig008 = fs.readFileSync(mig008Path, 'utf8');

  await client.query('BEGIN');
  const start = performance.now();
  try {
    await client.query(mig008);
    console.log(`  ✅ Migration 008 applied  [${(performance.now() - start).toFixed(1)} ms]`);
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.log(`  ❌ Migration 008 failed: ${e.message?.slice(0, 300)}`);
    client.release();
    await closePool();
    process.exit(1);
  }
  await client.query('COMMIT');

  // CONCURRENTLY create the serving_cell_id index (not in TX)
  await section('APPLYING MIGRATION 008 (ADDENDUM): CONCURRENT serving_cell_id index');
  await runWithoutTx(pool,
    'CREATE INDEX CONCURRENTLY idx_subscriber_dump_serving_cell (serving_cell_id)',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriber_dump_serving_cell
     ON subscriber_dump(serving_cell_id)`
  );

  // Additional indexes from migration 008 (fast — just BTree on existing cols)
  await runWithoutTx(pool, 'idx_subscriber_dump_state (state)',
    `CREATE INDEX IF NOT EXISTS idx_subscriber_dump_state ON subscriber_dump(state)`);
  await runWithoutTx(pool, 'idx_subscriber_dump_operator (operator)',
    `CREATE INDEX IF NOT EXISTS idx_subscriber_dump_operator ON subscriber_dump(operator)`);
  await runWithoutTx(pool, 'idx_subscriber_dump_technology (technology)',
    `CREATE INDEX IF NOT EXISTS idx_subscriber_dump_technology ON subscriber_dump(technology)`);
  await runWithoutTx(pool, 'idx_subscriber_dump_state_operator (state,operator)',
    `CREATE INDEX IF NOT EXISTS idx_subscriber_dump_state_operator ON subscriber_dump(state, operator)`);

  // =====================================================================
  // VERIFY 008 APPLIED
  // =====================================================================
  await section('VERIFY MIGRATION 008 APPLIED');
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name='subscriber_dump'
      AND column_name IN ('serving_cell_id','data_source','generation_batch_id','generation_timestamp')
    ORDER BY column_name
  `);
  console.log('\n  Columns added:');
  for (const c of cols.rows) {
    console.log(`    ${c.column_name.padEnd(28)} ${c.data_type.padEnd(18)} nullable=${c.is_nullable}`);
  }

  const idxs = await client.query(`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename='subscriber_dump' AND indexname LIKE 'idx_subscriber_dump_%'
     ORDER BY indexname
  `);
  console.log('\n  Subscriber_dump indexes (new):');
  for (const i of idxs.rows) {
    console.log(`    ${i.indexname.padEnd(52)}  ${i.indexdef.slice(0, 110)}`);
  }

  client.release();
  await closePool();

  console.log('\n' + '='.repeat(110));
  console.log('  MIGRATION 008 COMPLETE. Next:');
  console.log('    • Run migration 009 (integrity constraints) — optional step if ');
  console.log('      imsi/msisdn UNIQUE needed before 100M generation.');
  console.log('    • Generate 100M Delhi expansion subscribers.');
  console.log('    • VALIDATE serving_cell_id FK.');
  console.log('='.repeat(110));
}

main().catch((e) => { console.error('Migration runner FAILED:', e); process.exit(1); });
