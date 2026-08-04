import { config as loadDotenv } from 'dotenv';
import { envSchema, type ParsedEnvConfig } from './schema.js';

loadDotenv();

export type { ParsedEnvConfig };

let cached: ParsedEnvConfig | null = null;

/**
 * Load, validate and cache the environment configuration.
 *
 * Fails fast with a readable message when a malformed value is present — a
 * government early-warning system must not silently run on a bad config.
 */
export function loadConfig(): ParsedEnvConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = {
    ...parsed.data,
    // When the simulation runs in memory there is no tower database, so module
    // 02 must resolve towers from the in-memory tower store. This derivation
    // makes TOWER_SOURCE_MODE=memory the effective mode automatically.
    TOWER_SOURCE_MODE:
      parsed.data.USE_DUMMY_SUBSCRIBER_DB && parsed.data.SUBSCRIBER_DB_MODE === 'memory'
        ? 'memory'
        : parsed.data.TOWER_SOURCE_MODE,
    SMPP_INTERFACE_VERSION_NUM: parseInt(parsed.data.SMPP_INTERFACE_VERSION, 16),
    // Subscriber data is available when the telecom simulation is on, OR when
    // the real prefetch layer has a database + is enabled. The pipeline ALSO
    // requires a real SubscriberMatcher to be registered (see
    // src/pipeline/subscriber-matcher.ts) before it continues past 03/04.
    SUBSCRIBER_MATCHING_AVAILABLE:
      parsed.data.USE_DUMMY_SUBSCRIBER_DB ||
      (parsed.data.SUBSCRIBER_PREFETCH_ENABLED && parsed.data.DATABASE_URL !== undefined),
  };
  return cached;
}

/** Reset the cached config (used by tests). */
export function resetConfig(): void {
  cached = null;
}
