import { traceStore } from '../../tracing/trace-store.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

/**
 * Duplicate elimination — requirement #5.
 *
 * Order-preserving in-memory dedup over a list of MSISDNs using a Set, with a
 * removed-duplicate count for the audit trail. Accepts a plain string[] so it
 * can be wired to module 04 (subscriber matching) later, or called directly
 * with any real MSISDN list today.
 *
 * When a `traceKey` (CAP alert identifier) is supplied, it records the
 * expected recipient count and marks stage t2 on the shared latency trace,
 * exactly as module 04/05's plan describes.
 */

export interface DedupResult {
  /** Deduplicated MSISDNs, first-occurrence order preserved. */
  deduplicated: string[];
  /** Input size. */
  originalCount: number;
  /** `originalCount - deduplicated.length`. */
  removedCount: number;
  /** Wall-clock time spent deduplicating (ms). */
  elapsedMs: number;
}

/** Normalize an MSISDN for duplicate detection (strip +, spaces, dashes). */
export function normalizeMsisdn(msisdn: string): string {
  return msisdn.replace(/^\+/, '').replace(/[\s-]/g, '');
}

/**
 * Deduplicate MSISDNs in memory. O(n) single pass; order-preserving; the
 * original spelling of each first occurrence is kept.
 */
export async function deduplicate(msisdns: readonly string[], traceKey?: string): Promise<DedupResult> {
  const started = performance.now();
  const seen = new Set<string>();
  const deduplicated: string[] = [];
  let removed = 0;

  for (const msisdn of msisdns) {
    const key = normalizeMsisdn(msisdn);
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    deduplicated.push(msisdn);
  }

  const elapsedMs = performance.now() - started;
  logger.info({ originalCount: msisdns.length, deduplicated: deduplicated.length, removed, elapsedMs }, 'dedup.completed');

  if (traceKey) {
    // t2 — subscriber matching complete, post-dedup (shared latency trace).
    await traceStore.setExpectedRecipients(traceKey, deduplicated.length);
    await traceStore.mark(traceKey, 't2', 'subscriber.match+dedup', Date.now());
  }

  return { deduplicated, originalCount: msisdns.length, removedCount: removed, elapsedMs };
}
