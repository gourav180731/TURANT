/**
 * Apply migration 010 (cell → subscriber numeric access path + precomputed
 * stats). Creates the three derived tables + FK + intarray extension. Does NOT
 * populate them — run `npm run build:cell-access` for that.
 */
import { closePool, getPool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

loadConfig();

const MIGRATION_DIR = path.resolve(import.meta.dirname!, '..', 'migrations');
const MIGRATION_FILE = path.join(MIGRATION_DIR, '010_cell_subscriber_access.sql');

async function main(): Promise<void> {
  if (!fs.existsSync(MIGRATION_FILE)) throw new Error(`missing ${MIGRATION_FILE}`);
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const pool = getPool();
  const client = await pool.connect();
  await client.query("SET work_mem='256MB'; SET maintenance_work_mem='1GB';");
  const started = Date.now();
  await client.query(sql);
  console.log(`migration-010 applied [${((Date.now() - started) / 1000).toFixed(1)} s]`);
  await client.release();
  await closePool();
}

main().catch((err) => {
  console.error('migration-010 FAILED:', err?.message ?? err);
  process.exit(1);
});