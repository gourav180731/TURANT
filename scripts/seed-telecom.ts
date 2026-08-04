/**
 * Standalone telecom-simulation seeder (Postgres path).
 *
 * Usage:
 *   USE_DUMMY_SUBSCRIBER_DB=true SUBSCRIBER_DB_MODE=postgres \
 *   DUMMY_SUBSCRIBER_COUNT=100000 DUMMY_TOWER_COUNT=1000 \
 *   DATABASE_URL=postgres://... SEED_USE_COPY=true \
 *   npx tsx scripts/seed-telecom.ts
 *
 * Deterministic, idempotent and resumable: re-running seeds only what is
 * missing; SIM_SEED_RESET=true drops and recreates the sim tables first.
 */

import { loadConfig } from '../src/config/env.js';
import { getLogger, flushLogger } from '../src/utils/logger.js';
import { PostgresSimSeeder } from '../src/telecom/seeders/index.js';
import { TelecomSimulator } from '../src/telecom/services/simulator.js';

const log = getLogger();

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.USE_DUMMY_SUBSCRIBER_DB) {
    throw new Error('seed-telecom requires USE_DUMMY_SUBSCRIBER_DB=true');
  }
  if (cfg.SUBSCRIBER_DB_MODE !== 'postgres') {
    throw new Error('seed-telecom requires SUBSCRIBER_DB_MODE=postgres');
  }
  if (!cfg.DATABASE_URL) {
    throw new Error('seed-telecom requires DATABASE_URL');
  }

  const sim = new TelecomSimulator(cfg);
  const towers = sim.generateTowers();
  log.info(
    {
      towers: towers.length,
      subscribers: cfg.DUMMY_SUBSCRIBER_COUNT,
      seed: cfg.SIM_SEED,
      partitions: cfg.SUBSCRIBER_PARTITIONS,
      copy: cfg.SEED_USE_COPY,
      workers: cfg.SEED_WORKERS,
      batchSize: cfg.SEED_BATCH_SIZE,
    },
    'seed.start',
  );

  const seeder = new PostgresSimSeeder(cfg);
  const started = performance.now();
  await seeder.ensureSchema();
  await seeder.seedTowers(towers);
  const result = await seeder.seedSubscribers({ towers, targetCount: cfg.DUMMY_SUBSCRIBER_COUNT });
  const elapsedMs = performance.now() - started;

  log.info(
    {
      ...result,
      ratePerSec: result.generated > 0 ? Math.round(result.generated / (elapsedMs / 1000)) : 0,
      elapsedMs: Math.round(elapsedMs),
    },
    'seed.completed',
  );
}

main()
  .then(() => flushLogger())
  .catch((err) => {
    log.error({ err }, 'seed.failed');
    void flushLogger().finally(() => process.exitCode = 1);
  });
