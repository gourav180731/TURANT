import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';

/**
 * Configurable delivery strategy — requirement #10.
 *
 * Resolves DELIVERY_STRATEGY / DELIVERY_RETRY_MAX / DELIVERY_RETRY_INTERVAL_MS
 * from the already-existing env config into a real retry plan consumed by
 * module 10's retry queue and module 07's submit path.
 */

export type DeliveryStrategy = 'single-attempt' | 'retry';

export interface DeliveryPolicy {
  strategy: DeliveryStrategy;
  /** Max retry rounds after the initial attempt (ignored in single-attempt). */
  retryMax: number;
  /** Delay between retry rounds (ms). */
  retryIntervalMs: number;
}

/** Resolve the delivery policy from environment config. */
export function resolveDeliveryPolicy(cfg: ParsedEnvConfig = loadConfig()): DeliveryPolicy {
  return {
    strategy: cfg.DELIVERY_STRATEGY,
    retryMax: cfg.DELIVERY_STRATEGY === 'retry' ? cfg.DELIVERY_RETRY_MAX : 0,
    retryIntervalMs: cfg.DELIVERY_RETRY_INTERVAL_MS,
  };
}

/** True when the strategy will re-attempt failed messages at all. */
export function willRetry(policy: DeliveryPolicy): boolean {
  return policy.strategy === 'retry' && policy.retryMax > 0;
}
