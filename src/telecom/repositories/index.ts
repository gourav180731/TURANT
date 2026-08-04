/**
 * Telecom subscriber repositories.
 *
 *   - subscriber-repository.ts          : contract + errors
 *   - sql-builders.ts                   : pure SQL + COPY/INSERT wire formats
 *   - in-memory-subscriber-repository.ts: zero-dependency store (dev/tests)
 *   - postgres-subscriber-repository.ts : config-driven Postgres reads (prod path)
 */

export {
  SubscriberRepositoryNotConfiguredError,
  SubscriberRepositoryError,
  type SubscriberRepository,
  type SubscriberRow,
  type FindByCellIdsOptions,
} from './subscriber-repository.js';
export { InMemorySubscriberRepository } from './in-memory-subscriber-repository.js';
export { PostgresSubscriberRepository } from './postgres-subscriber-repository.js';
export {
  SUBSCRIBER_COLUMNS,
  serializeSubscriberCsv,
  buildCopyFromSubscribersSql,
  buildUpsertSubscribersSql,
  buildFindByCellIdsSql,
  buildFindByMsisdnsSql,
} from './sql-builders.js';
