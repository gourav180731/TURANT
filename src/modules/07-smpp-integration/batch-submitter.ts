import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { traceStore } from '../../tracing/trace-store.js';
import type { SmsMessage, SubmissionResult } from '../../types/sms.js';
import { getLogger } from '../../utils/logger.js';
import { ExpiryGuard } from '../06-expiry-control/expiry-guard.js';
import type { SmppPriorityFlag } from '../09-priority/priority.js';
import { earlyWarningPriorityFlag } from '../09-priority/priority.js';
import type { DeliveryPolicy } from '../10-delivery-strategy/delivery-policy.js';
import { runRetryQueue } from '../10-delivery-strategy/retry-queue.js';
import { createSmppClient, getSmppSession } from './smpp-session.js';

const logger = getLogger();

/**
 * Batch submission orchestration (module 07).
 *
 * Builds real submit_sm payloads for a batch of recipients using module 08
 * (validity_period) + module 09 (priority_flag) fields, submits through the
 * shared SMPP client, then applies module 10's retry policy to whatever was
 * not accepted.
 *
 * The real CAP expiry is threaded in as `expiresAt` (or via a pre-built
 * `guard`); every retry round consults it (requirement #6 end-to-end), so
 * retries halt the moment the alert expires — never retry an expired alert.
 */

export interface SubmitAlertOptions {
  cfg?: ParsedEnvConfig;
  policy?: DeliveryPolicy;
  guard?: ExpiryGuard;
  /**
   * Real CAP `expires` timestamp (from `capTiming(alert).expiresAt`). Used to
   * build the guard when `guard` is not supplied. `null` = no expiry declared.
   */
  expiresAt?: Date | null;
  traceKey?: string;
}

/** Pure: build the SmsMessage[] for a batch (unit tested without an SMSC). */
export function buildSmsMessages(
  alertId: string,
  content: string,
  msisdns: readonly string[],
  cfg: ParsedEnvConfig,
  validityPeriod?: Date,
  priorityFlag: SmppPriorityFlag = earlyWarningPriorityFlag(),
  registeredDelivery = cfg.SMS_REGISTERED_DELIVERY,
): SmsMessage[] {
  return msisdns.map((msisdn, index) => ({
    messageId: `${alertId}-${index}`,
    alertId,
    msisdn,
    content,
    dataCoding: cfg.SMS_DATA_CODING,
    validityPeriod,
    priorityFlag,
    registeredDelivery,
  }));
}

export interface AlertSubmitSummary {
  total: number;
  accepted: number;
  rejected: number;
  failed: number;
  retried: number;
  gaveUpExpired: number;
  exhaustedRetries: number;
  awaitingCredentials: boolean;
  results: SubmissionResult[];
}

/** Resolve the guard for a submission: explicit guard wins, else from expiresAt. */
export function resolveGuard(opts: Pick<SubmitAlertOptions, 'guard' | 'expiresAt'>): ExpiryGuard {
  if (opts.guard) return opts.guard;
  return new ExpiryGuard({ expiresAt: opts.expiresAt ?? null });
}

/**
 * Submit a whole alert to a batch of recipients. Returns a real summary; when
 * SMPP credentials are absent it returns a clearly-labelled awaiting-credentials
 * result rather than fabricating delivery.
 */
export async function submitAlertBatch(
  alertId: string,
  content: string,
  msisdns: readonly string[],
  opts: SubmitAlertOptions = {},
): Promise<AlertSubmitSummary> {
  const cfg = opts.cfg ?? loadConfig();
  const policy = opts.policy ?? { strategy: cfg.DELIVERY_STRATEGY, retryMax: cfg.DELIVERY_RETRY_MAX, retryIntervalMs: cfg.DELIVERY_RETRY_INTERVAL_MS };
  const guard = resolveGuard(opts);

  const empty = (awaitingCredentials: boolean): AlertSubmitSummary => ({
    total: msisdns.length,
    accepted: 0,
    rejected: 0,
    failed: 0,
    retried: 0,
    gaveUpExpired: 0,
    exhaustedRetries: 0,
    awaitingCredentials,
    results: [],
  });

  // A caller-supplied cfg builds its own client (tests isolate their env); the
  // default path shares the process-wide session so DLR correlation stays on
  // one connection.
  const session = opts.cfg ? createSmppClient(cfg) : getSmppSession(cfg);
  if (!session.isConfigured()) {
    logger.warn({ alertId, count: msisdns.length }, 'submit.awaiting_credentials');
    return empty(true);
  }

  if (!guard.canSubmit()) {
    logger.warn({ alertId }, 'submit.halt_expired');
    return empty(false);
  }

  const messages = buildSmsMessages(
    alertId,
    content,
    msisdns,
    cfg,
    guard.status().expiresAt ?? undefined,
  );
  const results = await session.submitBatch(messages, opts.traceKey);

  const failed = results.filter((r) => r.outcome !== 'accepted').map((r) => r.msisdn);
  const submitRetry = async (retryMsisdns: readonly string[]): Promise<SubmissionResult[]> => {
    const retryMessages = messages.filter((m) => retryMsisdns.includes(m.msisdn));
    return session.submitBatch(retryMessages);
  };
  const retry = await runRetryQueue(failed, { policy, guard, submit: submitRetry });
  const finalResults = [...results, ...retry.finalFailures.map((msisdn) => ({
    messageId: `${alertId}-${msisdn}`,
    msisdn,
    outcome: 'failed' as const,
    errorText: 'exhausted retries',
  }))];

  const summary: AlertSubmitSummary = {
    total: msisdns.length,
    accepted: results.filter((r) => r.outcome === 'accepted').length,
    rejected: results.filter((r) => r.outcome === 'rejected').length,
    failed: retry.finalFailures.length,
    retried: retry.retried,
    gaveUpExpired: retry.gaveUpExpired,
    exhaustedRetries: retry.exhaustedRetries,
    awaitingCredentials: false,
    results: finalResults,
  };
  logger.info({ alertId, ...summary }, 'submit.completed');
  return summary;
}

/** Split a worker's slice into SUBMIT_BATCH_SIZE chunks. */
export function chunkBatch(batch: readonly string[], batchSize = 500): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < batch.length; i += batchSize) {
    chunks.push(batch.slice(i, i + batchSize));
  }
  return chunks;
}

/**
 * Chunked submission for a whole batch (module 13 workers and the inline
 * executor both use this). Consults the real expiry guard before every chunk
 * and merges per-chunk summaries. `total` counts only chunks actually
 * submitted; chunks skipped by expiry are excluded and reflected nowhere in
 * the accepted/rejected figures (the pipeline halts loudly instead).
 */
export async function submitAlertBatchChunked(
  alertId: string,
  content: string,
  msisdns: readonly string[],
  opts: SubmitAlertOptions = {},
): Promise<AlertSubmitSummary> {
  const cfg = opts.cfg ?? loadConfig();
  const guard = resolveGuard(opts);
  let merged: AlertSubmitSummary = emptySubmitSummary();

  for (const chunk of chunkBatch(msisdns, cfg.SUBMIT_BATCH_SIZE)) {
    if (!guard.canSubmit()) {
      logger.warn({ alertId, chunk: chunk.length }, 'submit.chunk_halt_expired');
      break;
    }
    const summary = await submitAlertBatch(alertId, content, chunk, { ...opts, cfg, guard });
    merged = mergeSubmitSummaries(merged, summary);
  }
  return merged;
}

function emptySubmitSummary(): AlertSubmitSummary {
  return {
    total: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    retried: 0,
    gaveUpExpired: 0,
    exhaustedRetries: 0,
    awaitingCredentials: false,
    results: [],
  };
}

function mergeSubmitSummaries(a: AlertSubmitSummary, b: AlertSubmitSummary): AlertSubmitSummary {
  return {
    total: a.total + b.total,
    accepted: a.accepted + b.accepted,
    rejected: a.rejected + b.rejected,
    failed: a.failed + b.failed,
    retried: a.retried + b.retried,
    gaveUpExpired: a.gaveUpExpired + b.gaveUpExpired,
    exhaustedRetries: a.exhaustedRetries + b.exhaustedRetries,
    awaitingCredentials: a.awaitingCredentials || b.awaitingCredentials,
    results: [...a.results, ...b.results],
  };
}
