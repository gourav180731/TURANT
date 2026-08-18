import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

loadConfig();

async function run() {
  const pool = getPool();
  const client = await pool.connect();

  console.log('\n=== SUBSCRIBER_DUMP COLUMNS ===');
  const cols = await client.query(`
    SELECT column_name, data_type, character_maximum_length, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY ordinal_position
  `);
  for (const row of cols.rows.filter((r: any) =>
    ['subscriber_dump', 'cell_network_mapping', 'cell_subscriber_mapping', 'cell_towers', 'sim_cell_towers', 'telecom_master', 'subscribers'].includes(r.table_name)
  )) {
    console.log(`  ${row.table_name.padEnd(25)} | ${row.column_name.padEnd(22)} | ${row.data_type.padEnd(18)} | ${row.is_nullable} ${row.character_maximum_length ?? ''}`);
  }

  console.log('\n=== TABLE ROW COUNTS (approx) ===');
  const counts = await client.query(`
    SELECT relname, reltuples::BIGINT AS approx_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND n.nspname = 'public'
      AND relname IN ('subscriber_dump', 'cell_network_mapping', 'cell_subscriber_mapping', 'cell_towers', 'sim_cell_towers', 'telecom_master', 'subscribers', 'alerts', 'alert_reports')
    ORDER BY relname
  `);
  for (const row of counts.rows) {
    console.log(`  ${row.relname.padEnd(28)} | ${String(row.approx_rows).padStart(12)} rows`);
  }

  console.log('\n=== INDEXES on subscriber_dump ===');
  const idx = await client.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'subscriber_dump'
    ORDER BY indexname
  `);
  for (const row of idx.rows) {
    console.log(`  ${row.indexname.padEnd(42)} | ${row.indexdef.slice(0, 150)}`);
  }

  console.log('\n=== INDEXES on cell_network_mapping ===');
  const idx2 = await client.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'cell_network_mapping'
    ORDER BY indexname
  `);
  for (const row of idx2.rows) {
    console.log(`  ${row.indexname.padEnd(42)} | ${row.indexdef.slice(0, 150)}`);
  }

  console.log('\n=== sample 5 rows of subscriber_dump (LIMIT 5) ===');
  const sample1 = await client.query('SELECT * FROM subscriber_dump LIMIT 5');
  if (sample1.rows.length > 0) {
    const cols = Object.keys(sample1.rows[0]);
    console.log('  columns:', cols.join(', '));
    for (const row of sample1.rows) {
      console.log('  row:', JSON.stringify(row).slice(0, 500));
    }
  }

  console.log('\n=== sample 5 rows of cell_network_mapping LIMIT 5) ===');
  const sample2 = await client.query('SELECT * FROM cell_network_mapping LIMIT 5');
  for (const row of sample2.rows) {
    console.log('  row:', JSON.stringify(row).slice(0, 500));
  }

  client.release();
  await closePool();
}

run().catch(console.error);
