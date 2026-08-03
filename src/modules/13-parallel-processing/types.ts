import type { AlertSubmitSummary } from '../07-smpp-integration/batch-submitter.js';

/**
 * Job/result contract between the orchestrator (module 13) and its
 * worker_threads. `expiresAtIso` carries the real CAP expiry (from
 * `capTiming(alert).expiresAt`) so the worker reconstructs the same real
 * expiry guard — never a hardcoded "never expires" one.
 */
export interface WorkerJob {
  alertId: string;
  capIdentifier: string;
  content: string;
  /** Post-dedup MSISDNs for this worker's whole slice. */
  batch: string[];
  /** CAP `expires` as ISO-8601 (or null when the alert declares none). */
  expiresAtIso: string | null;
  traceKey?: string;
}

export interface WorkerResult {
  ok: boolean;
  alertId: string;
  capIdentifier: string;
  summary?: AlertSubmitSummary;
  error?: string;
}
