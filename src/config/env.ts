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
    SMPP_INTERFACE_VERSION_NUM: parseInt(parsed.data.SMPP_INTERFACE_VERSION, 16),
    SUBSCRIBER_MATCHING_AVAILABLE:
      parsed.data.SUBSCRIBER_PREFETCH_ENABLED && parsed.data.DATABASE_URL !== undefined,
  };
  return cached;
}

/** Reset the cached config (used by tests). */
export function resetConfig(): void {
  cached = null;
}
