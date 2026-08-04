/**
 * Telecom simulation seeders (Postgres path).
 *
 *   - ddl.ts           : pure DDL builders (partition-aware subscribers schema)
 *   - postgres-seeder.ts: deterministic, idempotent, resumable seeder
 *   - master-sql.ts    : pure builders for the C-DOT BTS reference schema
 *   - master-seeder.ts : Telecom Master Dataset seeder (telecom_master table)
 */

export { PostgresSimSeeder } from './postgres-seeder.js';
export { TelecomMasterSeeder } from './master-seeder.js';
export { buildMasterInsertSql, toMasterRow, MASTER_COLUMNS } from './master-sql.js';
export type { TelecomMasterRow, MasterInsertOptions } from './master-sql.js';
export {
  buildSubscribersDdl,
  buildSimCellTowersDdl,
  buildTelecomMasterDdl,
  buildCheckpointsDdl,
  subscriberColumnsDdl,
  subscriberIndexesDdl,
} from './ddl.js';
