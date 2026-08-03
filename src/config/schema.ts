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

const TOWER_SOURCE_MODES = ['postgis', 'http'] as const;
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
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface ParsedEnvConfig extends Omit<EnvConfig, 'SMPP_INTERFACE_VERSION'> {
  /** SMPP interface version parsed from hex string (e.g. 0x34 -> 52) */
  SMPP_INTERFACE_VERSION_NUM: number;
}
