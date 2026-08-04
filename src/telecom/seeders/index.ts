/**
 * Telecom simulation seeders (Postgres path).
 *
 *   - ddl.ts           : pure DDL builders (partition-aware subscribers schema)
 *   - postgres-seeder.ts: deterministic, idempotent, resumable seeder
 */

export { PostgresSimSeeder } from './postgres-seeder.js';
export {
  buildSubscribersDdl,
  buildSimCellTowersDdl,
  buildCheckpointsDdl,
  subscriberColumnsDdl,
  subscriberIndexesDdl,
} from './ddl.js';
