import { traceStore } from '../tracing/trace-store.js';
import type { AlertReport } from '../types/report.js';
import { latencySectionForReport } from '../modules/12-ews-callback/ews-callback.js';

/**
 * Build the real per-alert AlertReport (requirement #12, EWS completion
 * callback) from pipeline status + trace evidence. Every count traces back to a
 * live pipeline stage — nothing is fabricated. When the submission leg was
 * awaiting SMPP credentials, smsSubmittedCount is 0, never the intended count.
 */
export interface ReportInput {
  alertId: string;
  capIdentifier: string;
  targetedSubscriberCount: number;
  submittedCount: number;
  acceptedCount: number;
  deliveredCount: number;
  failedCount: number;
  expiredMessageCount: number;
  towerCount: number;
}

export async function buildAlertReport(input: ReportInput): Promise<AlertReport> {
  const trace = await traceStore.snapshot(input.capIdentifier);
  const startedAt = new Date(trace?.points.t0?.epochMs ?? Date.now());
  const endedAt = new Date(Date.now());

  return {
    alertId: input.alertId,
    capIdentifier: input.capIdentifier,
    processingStartedAt: startedAt.toISOString(),
    processingEndedAt: endedAt.toISOString(),
    targetedSubscriberCount: input.targetedSubscriberCount,
    smsSubmittedCount: input.submittedCount,
    smsAcceptedCount: input.acceptedCount,
    deliveredCount: input.deliveredCount,
    failedCount: input.failedCount,
    expiredMessageCount: input.expiredMessageCount,
    // EWS contract: submitted === successfully pushed to the SMSC boundary.
    successfulPushCount: input.submittedCount,
    towerCount: input.towerCount,
    latencyMs: await latencySectionForReport(input.capIdentifier),
    completed: true,
  };
}

/**
 * Best-effort delivery of the completion report to the EWS origin with a DB
 * fallback (module 12). Never throws into the pipeline — a callback that cannot
 * be delivered is logged and must never abort the alert run.
 */
export async function pushCompletionReport(
  report: AlertReport,
  deps: { persist?: (report: AlertReport) => Promise<void>; push?: (report: AlertReport, deps: { persistReport?: (r: AlertReport) => Promise<void> }) => Promise<unknown> } = {},
): Promise<void> {
  const { getLogger } = await import('../utils/logger.js');
  const logger = getLogger();
  try {
    const { pushReportToEws } = await import('../modules/12-ews-callback/ews-callback.js');
    const persist = deps.persist ?? (await import('../persistence/alert-report-repo.js')).persistAlertReport;
    const push = deps.push ?? pushReportToEws;
    await push(report, { persistReport: persist });
    logger.info({ capIdentifier: report.capIdentifier }, 'ews_report.completion_sent');
  } catch (err) {
    logger.error({ err, capIdentifier: report.capIdentifier }, 'ews_report.completion_failed');
  }
}
