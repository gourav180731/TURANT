import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { registerSubscriberMatcher } from '../../pipeline/subscriber-matcher.js';
import { getLogger } from '../../utils/logger.js';
import type { TelecomCellTower } from '../entities/cell-tower.js';
import type { TelecomTechnology } from '../entities/telecom-subscriber.js';
import { generateSubscribers, subscriberBatchSeed } from '../generators/subscriber-generator.js';
import { generateTowers } from '../generators/tower-generator.js';
import { mulberry32 } from '../generators/prng.js';
import { PostgresSubscriberDumpMatcher } from '../matcher/subscriber-dump-matcher.js';
import { TelecomSimSubscriberMatcher } from '../matcher/telecom-subscriber-matcher.js';
import {
  InMemorySubscriberRepository,
  PostgresSubscriberRepository,
  SubscriberRepositoryNotConfiguredError,
  type SubscriberRepository,
} from '../repositories/index.js';
import { PostgresSimSeeder } from '../seeders/index.js';
import { getTowerStore } from '../tower-store.js';

const log = getLogger();

/**
 * Shared in-memory repository. The simulator seeds this instance and the
 * factory returns the same one to every caller, so the pipeline, matcher and
 * debug routes all observe the seeded dataset. Postgres mode returns a fresh
 * wrapper (reads go to the DB).
 */
let memoryRepo: InMemorySubscriberRepository | null = null;

/**
 * Subscriber-repository factory. This is the single point that enforces the
 * drop-in contract:
 *
 *   USE_DUMMY_SUBSCRIBER_DB=true  → the simulation is the subscriber DB.
 *   USE_DUMMY_SUBSCRIBER_DB=false → throws "Real C-DOT Subscriber Repository
 *   Not Configured" (callers catch it; the app keeps running, the pipeline
 *   halts loudly at subscriber-matching as it always did).
 */
export function createSubscriberRepository(cfg: ParsedEnvConfig = loadConfig()): SubscriberRepository {
  if (!cfg.USE_DUMMY_SUBSCRIBER_DB) {
    throw new SubscriberRepositoryNotConfiguredError();
  }
  if (cfg.SUBSCRIBER_DB_MODE === 'memory') {
    if (!memoryRepo) memoryRepo = new InMemorySubscriberRepository();
    return memoryRepo;
  }
  return new PostgresSubscriberRepository(cfg);
}

/** Test/dev helper — forget the shared in-memory instance. */
export function resetMemorySubscriberRepository(): void {
  memoryRepo = null;
}

export interface SimBootResult {
  repoName: string;
  towers: number;
  subscribers: number;
  seed: number;
  mode: string;
}

/**
 * TelecomSimulator — boots the synthetic network.
 *
 *   memory  : generates towers + subscribers in-process, registers them with
 *             the in-memory tower store and subscriber repository.
 *   postgres: creates the sim schema (partition-aware), seeds towers and
 *             subscribers, and points the repository at Postgres.
 *
 * Both modes derive from the same deterministic batch generator, so a dataset
 * seeded into Postgres is byte-identical to the in-memory one for the same
 * SIM_SEED. On success it registers the TelecomSimSubscriberMatcher, which is
 * what lets the pipeline continue past modules 03/04.
 */
export class TelecomSimulator {
  constructor(private readonly cfg: ParsedEnvConfig = loadConfig()) {}

  generateTowers(): TelecomCellTower[] {
    const cfg = this.cfg;
    const techPct: Record<TelecomTechnology, number> = {
      GSM: cfg.TECH_GSM_PCT,
      UMTS: cfg.TECH_UMTS_PCT,
      LTE: cfg.TECH_LTE_PCT,
      NR5G: cfg.TECH_NR5G_PCT,
    };
    return generateTowers(
      { count: cfg.DUMMY_TOWER_COUNT, techPct, seed: cfg.SIM_SEED, region: cfg.SIM_REGION },
      mulberry32(cfg.SIM_SEED),
    );
  }

  /**
   * Generate exactly `count` towers (independent of DUMMY_TOWER_COUNT) — used
   * by the dedicated telecom-master seeder, which sizes the BTS dataset via
   * TELECOM_MASTER_TOWER_COUNT while keeping the same deterministic RNG/seed.
   */
  generateTowersForCount(count: number): TelecomCellTower[] {
    const techPct: Record<TelecomTechnology, number> = {
      GSM: this.cfg.TECH_GSM_PCT,
      UMTS: this.cfg.TECH_UMTS_PCT,
      LTE: this.cfg.TECH_LTE_PCT,
      NR5G: this.cfg.TECH_NR5G_PCT,
    };
    return generateTowers(
      { count, techPct, seed: this.cfg.SIM_SEED, region: this.cfg.SIM_REGION },
      mulberry32(this.cfg.SIM_SEED),
    );
  }

  async boot(): Promise<SimBootResult> {
    const cfg = this.cfg;
    if (!cfg.USE_DUMMY_SUBSCRIBER_DB) {
      throw new SubscriberRepositoryNotConfiguredError();
    }

    const towers = this.generateTowers();
    const repo = createSubscriberRepository(cfg);

    if (cfg.SUBSCRIBER_DB_MODE === 'memory') {
      getTowerStore().replace(towers);
      await this.seedMemorySubscribers(repo, towers, cfg.DUMMY_SUBSCRIBER_COUNT);
      log.info({ towers: towers.length, subscribers: cfg.DUMMY_SUBSCRIBER_COUNT }, 'telecom-sim.memory.ready');
    } else {
      const seeder = new PostgresSimSeeder(cfg);
      await seeder.ensureSchema();
      await seeder.seedTowers(towers);
      const seeded = await seeder.seedSubscribers({ towers, targetCount: cfg.DUMMY_SUBSCRIBER_COUNT });
      log.info({ towers: towers.length, ...seeded }, 'telecom-sim.postgres.ready');
    }

    // Real-data path: when the C-DOT dump is wired AND the subscriber store is
    // Postgres, match subscribers by point-in-polygon against the dump's geom
    // column. Memory mode has no database, so it always uses the sim matcher.
    const useDumpMatcher = cfg.SUBSCRIBER_DB_MODE === 'postgres' && cfg.SUBSCRIBER_DUMP_TABLE !== '';
    registerSubscriberMatcher(
      useDumpMatcher ? new PostgresSubscriberDumpMatcher(cfg) : new TelecomSimSubscriberMatcher(repo, cfg),
    );

    return {
      repoName: repo.name,
      towers: towers.length,
      subscribers: cfg.DUMMY_SUBSCRIBER_COUNT,
      seed: cfg.SIM_SEED,
      mode: cfg.SUBSCRIBER_DB_MODE,
    };
  }

  /** Deterministic in-process seeding — identical rows to the Postgres path. */
  private async seedMemorySubscribers(
    repo: SubscriberRepository,
    towers: readonly TelecomCellTower[],
    targetCount: number,
  ): Promise<void> {
    const cfg = this.cfg;
    const batchSize = cfg.SEED_BATCH_SIZE;
    const totalBatches = Math.ceil(targetCount / batchSize);
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * batchSize;
      const len = Math.min(batchSize, targetCount - start);
      const rand = mulberry32(subscriberBatchSeed(cfg.SIM_SEED, batchIndex));
      const rows = generateSubscribers({
        count: len,
        towers,
        activePct: cfg.ACTIVE_SUBSCRIBER_PCT,
        minPerTower: cfg.MIN_USERS_PER_TOWER,
        maxPerTower: cfg.MAX_USERS_PER_TOWER,
        rand,
        offset: start,
      });
      await repo.upsertSubscribers(rows);
    }
  }
}
