import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { traceStore } from '../../tracing/trace-store.js';
import type { SmsMessage, SubmissionResult } from '../../types/sms.js';
import { getLogger } from '../../utils/logger.js';
import { ExpiryGuard } from '../06-expiry-control/expiry-guard.js';
import type { SmppPriorityFlag } from '../09-priority/priority.js';
import { earlyWarningPriorityFlag } from '../09-priority/priority.js';
import type { DeliveryPolicy } from '../10-delivery-strategy/delivery-policy.js';
import { runRetryQueue } from '../10-delivery-strategy/retry-queue.js';
import { getSmppSession } from './smpp-session.js';
import { SmppClient } from './smpp-client.js';

const logger = getLogger();

/**
 * Batch submission orchestration (module 07).
 *
 * Builds real submit_sm payloads for a batch of recipients using module 08
 * (validity_period) + module 09 (priority_flag) fields, submits through the
 * shared SMPP client, then applies module 10's retry policy to whatever was
 * not accepted.
 */

export interface SubmitAlertOptions {
  cfg?: ParsedEnvConfig;
  policy?: DeliveryPolicy;
  guard?: ExpiryGuard;
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
  const guard = opts.guard ?? new ExpiryGuard({ expiresAt: null });

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
  const session = opts.cfg ? new SmppClient(cfg) : getSmppSession(cfg);
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
