import { z } from 'zod';

/**
 * Zod schema for every TURANT environment variable.
 *
 * Every real input consumed by the system is declared here and loaded from the
 * environment (see `env.ts`). Nothing is hardcoded; empty/false values mean a
 * module is built but idle until C-DOT provides the real input.
 */

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const intFromEnv = (defaultValue: number) =>
  z.coerce.number().int().nonnegative().default(defaultValue);

const intFromEnvNonZero = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const strFromEnv = (defaultValue: string) => z.string().default(defaultValue);

const maybeStr = z.string().optional().transform((v) => (v === '' ? undefined : v));

const TOWER_SOURCE_MODES = ['postgis', 'http', 'memory'] as const;
const COVERAGE_MODELS = ['radius', 'polygon'] as const;
const BIND_MODES = ['transceiver', 'transmitter'] as const;
const DELIVERY_STRATEGIES = ['single-attempt', 'retry'] as const;
const DATA_CODINGS = ['7bit', 'ucs2'] as const;
const LOOKUP_MODES = ['live', 'prefetched'] as const;
const PARALLEL_MODES = ['threads', 'inline'] as const;

export const envSchema = z.object({
  // ---- Application ----
  NODE_ENV: strFromEnv('development'),
  PORT: intFromEnvNonZero(8080),
  APP_NAME: strFromEnv('turant'),
  ENABLE_DEBUG_ENDPOINTS: boolFromEnv,

  // ---- Logging / audit ----
  LOG_LEVEL: strFromEnv('info'),
  LOG_PRETTY: boolFromEnv,
  AUDIT_LOG_FILE: maybeStr,

  // ---- PostgreSQL / PostGIS ----
  DATABASE_URL: maybeStr,
  PG_POOL_MAX: intFromEnvNonZero(20),
  PG_POOL_IDLE_TIMEOUT_MS: intFromEnvNonZero(30_000),
  PG_POOL_CONNECTION_TIMEOUT_MS: intFromEnvNonZero(10_000),

  // ---- Redis ----
  REDIS_URL: maybeStr,
  REDIS_KEY_PREFIX: strFromEnv('turant:'),

  // ---- Tower source ----
  TOWER_SOURCE_MODE: z.enum(TOWER_SOURCE_MODES).default('postgis'),
  TOWER_TABLE: strFromEnv('cell_towers'),
  TOWER_COL_ID: strFromEnv('id'),
  TOWER_COL_CELL_ID: strFromEnv('cell_id'),
  TOWER_COL_LAT: strFromEnv('latitude'),
  TOWER_COL_LNG: strFromEnv('longitude'),
  TOWER_COVERAGE_MODEL: z.enum(COVERAGE_MODELS).default('radius'),
  TOWER_COL_COVERAGE_RADIUS_M: strFromEnv('coverage_radius_m'),
  TOWER_COL_COVERAGE_GEOM: strFromEnv('coverage_geom'),
  TOWER_GEOM_SRID: intFromEnvNonZero(4326),
  TOWER_HTTP_BASE_URL: maybeStr,
  TOWER_HTTP_TOKEN: maybeStr,
  TOWER_HTTP_TIMEOUT_MS: intFromEnvNonZero(10_000),
  TOWER_MATCH_TIME_BUDGET_MS: intFromEnvNonZero(5000),
  /** Safety cap on towers returned per zone (not a tuning knob for the real load). */
  TOWER_MATCH_LIMIT: intFromEnvNonZero(100_000),

  // ---- CAP ingestion ----
  CAP_POLL_ENABLED: boolFromEnv,
  CAP_POLL_DIR: maybeStr,
  CAP_POLL_INTERVAL_MS: intFromEnvNonZero(5000),
  CAP_POLL_ARCHIVE_DIR: maybeStr,
  CAP_PREFERRED_LANGUAGE: strFromEnv('en-IN'),
  CAP_MAX_XML_BYTES: intFromEnvNonZero(1_048_576),

  // ---- Subscriber prefetch ----
  SUBSCRIBER_PREFETCH_ENABLED: boolFromEnv,
  SUBSCRIBER_PREFETCH_SYNC_INTERVAL_MS: intFromEnvNonZero(900_000),
  SUBSCRIBER_TABLE: strFromEnv('subscribers'),
  SUBSCRIBER_COL_MSISDN: strFromEnv('msisdn'),
  SUBSCRIBER_COL_TOWER_ID: strFromEnv('tower_id'),
  SUBSCRIBER_LOOKUP_MODE: z.enum(LOOKUP_MODES).default('prefetched'),

  // ---- Real C-DOT subscriber dump (requirement #4, real-data path) ---------
  // When set to a real table name (e.g. subscriber_dump), module 03/04 matches
  // subscribers against that table instead of joining the sim's `subscribers`
  // table by cell_id. Empty = disabled.
  SUBSCRIBER_DUMP_TABLE: strFromEnv(''),
  SUBSCRIBER_DUMP_MSISDN_COL: strFromEnv('msisdn'),
  SUBSCRIBER_DUMP_GEOM_COL: strFromEnv('geom'),
  /**
   * Cell column on the dump bound to `sim_cell_towers.cell_id` via the FK
   * `fk_subdump_serving_cell` (migration 008). The 97.5M Delhi expansion rows
   * carry a real value here, so the `cell-indexed` path is an index seek on
   * `serving_cell_id = ANY($1)` — never a scan over the whole dump.
   */
  SUBSCRIBER_DUMP_CELL_COL: strFromEnv('serving_cell_id'),
  /**
   * How the real dump is matched at scale:
   *   cell-indexed (default): `serving_cell_id = ANY($1)` index seek on the
   *                            FK-bound cell column (migrations 005/008).
   *   polygon                : point-in-polygon against the GiST `geom` column.
   *   bridge (legacy)        : cell → (lac,cisac) → subscriber_dump JOIN via
   *                            cell_network_mapping (Phase 4/5 architecture;
   *                            kept for deployments without serving_cell_id).
   */
  SUBSCRIBER_DUMP_LOOKUP_MODE: z.enum(['bridge', 'cell-indexed', 'polygon']).default('cell-indexed'),
  /**
   * Safety cap on matched subscribers per lookup for the polygon / cell-indexed
   * path that materialises the full MSISDN list in Node RAM.
   *
   * IMPORTANT — NO-FABRICATION RULE:
   *   For the benchmark and production pipeline (benchmark-routes, subscriber-cell-matcher
   *   statsQuery) the LIMIT is intentionally NOT applied to the COUNT(*) / COUNT(DISTINCT)
   *   aggregates: they always return the real DB-derived total regardless of this cap.
   *   This cap only gates the MSISDN list materialisation path (used when the pipeline
   *   needs to hand a recipient list to the SMPP boundary).
   *
   *   For a 100M Delhi dataset across 50K cells the true unique subscriber count can be
   *   20M+ — setting this to 100_000 would fabricate the recipient list. Set it high
   *   enough that the materialisation path is never silently truncated in production.
   *   The benchmark stats query (matchCells) uses COUNT() directly and is never capped.
   *
   * PERFORMANCE NOTE: This limit should be removed or set extremely high. The benchmark/
   * stats path already bypasses it (uses COUNT()). For production SMPP hand-off, use
   * cursor-based streaming (CellSubscriberBridgeMatcher.streamRecipients) instead of
   * materialized lists, making this limit obsolete.
   *
   * Default: 100,000,000 (100M) — matches max dataset size; effectively no limit.
   *   Override via SUBSCRIBER_DUMP_MATCH_LIMIT env var.
   */
  SUBSCRIBER_DUMP_MATCH_LIMIT: intFromEnvNonZero(100_000_000),

  // ---- Cell → subscriber access path (Phase-4/5 optimization, migration 010) --
  // Precomputed, DB-derived access structures keep recipient *identification*
  // off the 78 GB heap: identification reads NUMERIC subscriber ids only, then
  // MSISDNs are materialised per batch through the dump's `id` PK. Every number
  // below is counted from existing authoritative data — nothing is fabricated,
  // nothing is generated from geography independently.
  /**
   * Which access path the cell-indexed matcher uses for identification:
   *   mapping (default): `subscriber_cell_index` (serving_cell_id, subscriber_id)
   *                      PK table, CLUSTERed per cell — compact int4 postings.
   *   index             : covering B-tree on the dump (serving_cell_id) INCLUDE (id)
   *                      (VERSION B — no new table, larger index).
   *   postings          : `cell_postings(cell_id, ids int[])` + intarray union
   *                      (VERSION D — evaluated, requires intarray ext).
   * The measured winner (benchmark:subscriber-matching tier table) becomes the
   * production default. Counts always come from `cell_subscriber_stats`.
   */
  SUBSCRIBER_CELL_ACCESS_MODE: z.enum(['mapping', 'index', 'postings', 'direct']).default('mapping'),
  /** `subscriber_cell_index` — (serving_cell_id, subscriber_id) PK, one row per mapped subscriber. */
  SUBSCRIBER_CELL_INDEX_TABLE: strFromEnv('subscriber_cell_index'),
  /** `cell_subscriber_stats` — per-cell COUNT(*) derived from the dump. */
  CELL_SUBSCRIBER_STATS_TABLE: strFromEnv('cell_subscriber_stats'),
  /** `cell_postings` — per-cell int4[] of subscriber ids (intarray VERSION D). */
  CELL_POSTINGS_TABLE: strFromEnv('cell_postings'),
  /** Dump PK ordinal used as the numeric subscriber id (guaranteed < 2^31). */
  SUBSCRIBER_DUMP_ID_COL: strFromEnv('id'),
  /** Streaming batch for recipient draining from the cursor (Phase 8). */
  CELL_STREAM_BATCH_SIZE: intFromEnvNonZero(50_000),

  // ---- Cell -> LAC/CISAC bridge (Phase 2/4/5) ------------------------------
  // The production lookup does NOT scan the 100M dump by a fabricated cell_id.
  // Instead it resolves target cell_ids -> (lac, cisac) through this mapping
  // table, then JOINs subscriber_dump on the (lac, cisac) composite index.
  // This is the real subscriber-location key the dump actually carries.
  /**
   * Canonical Cell -> (lac, cisac) network-mapping layer (Phase 5/6).
   * Populated by `scripts/ingest-cell-mapping.ts` with source='synthetic_test_mapping'
   * (deterministic real-dump-sampled areas) until a real C-DOT master is imported.
   * See src/persistence/migrations/007_cell_network_mapping.sql.
   */
  CELL_NETWORK_MAPPING_TABLE: strFromEnv('cell_network_mapping'),
  /** Backward-compat alias for deployments that pinned the old table name. */
  CELL_SUBSCRIBER_MAPPING_TABLE: strFromEnv('cell_subscriber_mapping'),
  /** Column names on the mapping table (point at the real C-DOT master later). */
  CELL_MAPPING_COL_CELL: strFromEnv('cell_id'),
  CELL_MAPPING_COL_LAC: strFromEnv('lac'),
  CELL_MAPPING_COL_CISAC: strFromEnv('cisac'),
  /** Column named on subscriber_dump for the composite lookup key. */
  SUBSCRIBER_DUMP_LAC_COL: strFromEnv('lac'),
  SUBSCRIBER_DUMP_CISAC_COL: strFromEnv('cisac'),
  /**
   * Recipients drained per stream batch from the matched subscriber set and
   * handed to the SMPP/SMSC boundary (module 08). Tuned by benchmark; the
   * production requirement is to never hold the whole recipient list in RAM.
   */
  RECIPIENT_BATCH_SIZE: intFromEnvNonZero(10_000),
  /**
   * Hard cap on concurrent alert subscriber-match operations (Phase 16).
   * Each alert runs its own independent relational join; this bounds how many
   * can legitimately hold a DB client / temp staging table at once.
   */
  MAX_ALERT_WORKERS: intFromEnvNonZero(4),

  // ---- Matching ----
  MATCH_TIME_BUDGET_MS: intFromEnvNonZero(60_000),

  // ---- SMPP / SMSC ----
  SMPP_HOST: maybeStr,
  SMPP_PORT: intFromEnvNonZero(2775),
  SMPP_SYSTEM_ID: maybeStr,
  SMPP_PASSWORD: maybeStr,
  SMPP_SYSTEM_TYPE: maybeStr,
  SMPP_BIND_MODE: z.enum(BIND_MODES).default('transceiver'),
  SMPP_INTERFACE_VERSION: strFromEnv('0x34'),
  SMPP_SRC_ADDR_TON: intFromEnv(0),
  SMPP_SRC_ADDR_NPI: intFromEnv(0),
  SMPP_SRC_ADDR: maybeStr,
  SMPP_DEST_ADDR_TON: intFromEnv(1),
  SMPP_DEST_ADDR_NPI: intFromEnv(1),
  SMS_DATA_CODING: z.enum(DATA_CODINGS).default('7bit'),
  SMS_REGISTERED_DELIVERY: intFromEnv(0x03),
  SMPP_RECONNECT_DELAY_MS: intFromEnvNonZero(5000),
  SMPP_SUBMIT_TIMEOUT_MS: intFromEnvNonZero(10_000),
  SMPP_ENQUIRE_LINK_PERIOD_MS: intFromEnvNonZero(30_000),
  SMPP_SUBMIT_CONCURRENCY: intFromEnvNonZero(25),

  // ---- Delivery strategy ----
  DELIVERY_STRATEGY: z.enum(DELIVERY_STRATEGIES).default('single-attempt'),
  DELIVERY_RETRY_MAX: intFromEnvNonZero(3),
  DELIVERY_RETRY_INTERVAL_MS: intFromEnvNonZero(2000),

  // ---- Expiry control ----
  EXPIRY_HALT_SUBMISSION: boolFromEnv,

  // ---- EWS callback ----
  EWS_CALLBACK_URL: maybeStr,
  EWS_CALLBACK_TOKEN: maybeStr,
  EWS_CALLBACK_TIMEOUT_MS: intFromEnvNonZero(5000),

  // ---- Parallel processing ----
  PARALLEL_WORKER_COUNT: intFromEnvNonZero(4),
  SUBMIT_BATCH_SIZE: intFromEnvNonZero(500),
  /**
   * `threads` (default) = real OS worker_threads (module 13). `inline` = run
   * the same pipeline in-process (local dev/debugging, no extra threads).
   */
  PARALLEL_EXECUTION_MODE: z.enum(PARALLEL_MODES).default('threads'),

  // ---- Latency tracing ----
  /** Hours a per-alert trace record is retained (in memory + Redis). */
  TRACE_TTL_HOURS: intFromEnvNonZero(24),

  // ---- Telecom simulation layer (modules 03/04 drop-in) ---------------------
  // When true, TURANT uses the built-in telecom simulation (a synthetic but
  // structurally-valid subscriber/tower network) so the whole pipeline —
  // including subscriber matching — runs exactly as it will against the real
  // C-DOT subscriber database. When false, the repository factory throws
  // "Real C-DOT Subscriber Repository Not Configured" and the pipeline halts
  // loudly at subscriber-matching, exactly as before this module existed.
  USE_DUMMY_SUBSCRIBER_DB: boolFromEnv,
  /**
   * Where the simulation lives:
   *   memory   : in-process store (tests / local dev, no DB needed)
   *   postgres : real PostgreSQL tables (the 1K → 300M path)
   */
  SUBSCRIBER_DB_MODE: z.enum(['memory', 'postgres']).default('memory'),
  /** Geographic region the synthetic network is generated for. */
  SIM_REGION: strFromEnv('delhi-ncr'),
  /** Seed for the deterministic PRNG (reproducible datasets, resume-safe). */
  SIM_SEED: intFromEnvNonZero(20260902),

  // ---- Simulation scale (the ONLY thing that changes from 1K → 300M) --------
  DUMMY_SUBSCRIBER_COUNT: intFromEnvNonZero(1000),
  DUMMY_TOWER_COUNT: intFromEnvNonZero(100),
  MIN_USERS_PER_TOWER: intFromEnvNonZero(10),
  MAX_USERS_PER_TOWER: intFromEnvNonZero(500),
  /** Approx % of subscribers ACTIVE (rest INACTIVE). 0..100. */
  ACTIVE_SUBSCRIBER_PCT: z.coerce.number().int().min(0).max(100).default(85),
  SEED_BATCH_SIZE: intFromEnvNonZero(1000),
  /** Parallel seeding worker slices (Postgres mode). 1 = sequential. */
  SEED_WORKERS: intFromEnvNonZero(1),
  /** Postgres seeder path: true = COPY via staging table; false = batched INSERT. */
  SEED_USE_COPY: boolFromEnv,
  /**
   * Hash partition modulus for the subscribers table (0 = no partitioning).
   * Use 0 for dev; 32–256 for the 10M–300M production path.
   */
  SUBSCRIBER_PARTITIONS: intFromEnv(0),
  /**
   * When true, the Postgres seeder drops and recreates the sim tables before
   * seeding (a full reproducible reseed). When false (default) it resumes from
   * the last checkpoint and inserts only what is missing — safe to re-run.
   */
  SIM_SEED_RESET: boolFromEnv,
  /** Subscribers fetched per cell_id chunk in repository lookups. */
  SUBSCRIBER_LOOKUP_CHUNK_SIZE: intFromEnvNonZero(1000),

  // ---- Telecom Master Dataset (BTS reference schema) ------------------------
  /**
   * How many cell towers the dedicated telecom-master seeder generates
   * (`npm run seed:telecom-master`). Defaults to a realistic ~5,000-cell
   * Delhi NCR dataset; raise it for bigger networks.
   */
  TELECOM_MASTER_TOWER_COUNT: intFromEnvNonZero(5000),

  // ---- RAT (radio access technology) distribution, % must sum to 100 -------
  TECH_GSM_PCT: intFromEnv(20),
  TECH_UMTS_PCT: intFromEnv(20),
  TECH_LTE_PCT: intFromEnv(40),
  TECH_NR5G_PCT: intFromEnv(20),

  // ---- C-DOT subscriber schema mapping (same config-driven pattern as the
  //      PostGIS tower adapter — point these at the real tables later) -------
  SUBSCRIBER_COL_IMSI: strFromEnv('imsi'),
  SUBSCRIBER_COL_CELL_ID: strFromEnv('cell_id'),
  SUBSCRIBER_COL_TECHNOLOGY: strFromEnv('technology'),
  SUBSCRIBER_COL_STATUS: strFromEnv('status'),
  SUBSCRIBER_COL_LAST_SEEN: strFromEnv('last_seen'),
}).superRefine((val, ctx) => {
  const techSum = val.TECH_GSM_PCT + val.TECH_UMTS_PCT + val.TECH_LTE_PCT + val.TECH_NR5G_PCT;
  if (techSum !== 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TECH_GSM_PCT'],
      message: `RAT distribution must sum to 100 (got ${techSum})`,
    });
  }
  if (val.MIN_USERS_PER_TOWER > val.MAX_USERS_PER_TOWER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MIN_USERS_PER_TOWER'],
      message: 'MIN_USERS_PER_TOWER must be <= MAX_USERS_PER_TOWER',
    });
  }
  if (val.SUBSCRIBER_DB_MODE === 'postgres' && !val.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUBSCRIBER_DB_MODE'],
      message: 'SUBSCRIBER_DB_MODE=postgres requires DATABASE_URL',
    });
  }
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface ParsedEnvConfig extends Omit<EnvConfig, 'SMPP_INTERFACE_VERSION'> {
  /** SMPP interface version parsed from hex string (e.g. 0x34 -> 52) */
  SMPP_INTERFACE_VERSION_NUM: number;
  /**
   * Derived flag: subscriber matching (modules 03/04) can only be exercised
   * when the prefetch layer is enabled AND a subscriber DB is configured. The
   * pipeline additionally requires a real SubscriberMatcher to be registered,
   * so today this is always effectively "not available" until C-DOT connects
   * the subscriber database.
   */
  SUBSCRIBER_MATCHING_AVAILABLE: boolean;
}
