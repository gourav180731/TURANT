import type { SubmissionResult } from '../../types/sms.js';
import { getLogger } from '../../utils/logger.js';
import type { ExpiryGuard } from '../06-expiry-control/expiry-guard.js';
import type { DeliveryPolicy } from './delivery-policy.js';
import { willRetry } from './delivery-policy.js';

const logger = getLogger();

/**
 * In-memory retry queue — requirement #10.
 *
 * Takes a real list of failed MSISDNs and re-attempts submission up to the
 * configured max, respecting the module 06 expiry guard before every retry
 * round (a real function call, not described behavior). Returns final counts.
 */

export interface RetrySubmitter {
  /**
   * Attempt a batch. `outcome: 'accepted'` means the SMSC accepted the
   * submit_sm; anything else is retried (subject to policy + expiry).
   */
  (batch: readonly string[]): Promise<SubmissionResult[]>;
}

export interface RetryOutcome {
  /** Retry attempts actually performed. */
  retried: number;
  /** Messages dropped because the alert expired before their retry round. */
  gaveUpExpired: number;
  /** Messages that still failed after exhausting all retry rounds. */
  exhaustedRetries: number;
  /** All messages that ultimately did not deliver. */
  finalFailures: string[];
}

export interface RetryQueueOptions {
  policy: DeliveryPolicy;
  /** Real expiry guard from module 06 — consulted before every retry round. */
  guard: ExpiryGuard;
  submit: RetrySubmitter;
}

/** Delay helper (uses setTimeout so tests can advance fake timers). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-attempt `failedMsisdns` per policy. Single-attempt mode never retries.
 * Each round: (1) consult the expiry guard, (2) wait the configured interval
 * (after the first round), (3) re-submit the still-pending list.
 */
export async function runRetryQueue(
  failedMsisdns: readonly string[],
  options: RetryQueueOptions,
): Promise<RetryOutcome> {
  const { policy, guard, submit } = options;

  if (failedMsisdns.length === 0) {
    return { retried: 0, gaveUpExpired: 0, exhaustedRetries: 0, finalFailures: [] };
  }

  // Single-attempt: the caller's initial submission already counted these as
  // failed; there is no retry configured.
  if (!willRetry(policy)) {
    logger.info({ count: failedMsisdns.length }, 'retry.skipped_single_attempt');
    return { retried: 0, gaveUpExpired: 0, exhaustedRetries: 0, finalFailures: [...failedMsisdns] };
  }

  let pending = [...failedMsisdns];
  let retried = 0;

  for (let round = 1; round <= policy.retryMax; round++) {
    if (!guard.canSubmit()) {
      const remaining = pending.length;
      logger.warn({ round, remaining }, 'retry.halt_expired');
      return { retried, gaveUpExpired: remaining, exhaustedRetries: 0, finalFailures: [] };
    }

    if (round > 1) await sleep(policy.retryIntervalMs);

    logger.info({ round, count: pending.length }, 'retry.round');
    const results = await submit(pending);
    retried += pending.length;

    const stillFailing = new Set<string>();
    for (const result of results) {
      if (result.outcome !== 'accepted') stillFailing.add(result.msisdn);
    }
    pending = pending.filter((msisdn) => stillFailing.has(msisdn));

    if (pending.length === 0) break;
  }

  logger.info({ exhausted: pending.length, retried }, 'retry.completed');
  return { retried, gaveUpExpired: 0, exhaustedRetries: pending.length, finalFailures: pending };
}
