import { traceStore } from '../../tracing/trace-store.js';
import type { StageDelta } from '../../types/trace.js';
import { getLogger } from '../../utils/logger.js';
import type { DlrListener, AlertReceiptStats } from './dlr-listener.js';

const logger = getLogger();

/**
 * Per-alert delivery reporting (module 11).
 *
 * Aggregates DLR counts and merges them with the shared latency trace so the
 * report answers "how many of the intended recipients actually received the
 * alert, and how fast (t0 → DLR percentiles)?".
 */

export interface DeliveryReport {
  capIdentifier: string;
  expectedRecipients: number;
  delivered: number;
  deliveredTo: string[];
  firstReceivedEpochMs: number | null;
  lastReceivedEpochMs: number | null;
  /** t0 → first/p50/p90/p100 delivery percentiles (ms). */
  deliveryPercentilesMs: {
    firstDeliveryMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    p100Ms: number | null;
  } | null;
  /** Inter-stage deltas from the shared trace (t0→t1…t4→t5). */
  stageDeltasMs: StageDelta[] | null;
}

export interface DeliveryReporterOptions {
  listener: DlrListener;
}

/** Build a real per-alert delivery report. */
export async function buildDeliveryReport(
  capIdentifier: string,
  options: DeliveryReporterOptions,
): Promise<DeliveryReport> {
  const stats = options.listener.receiptsForAlert(capIdentifier);
  const trace = await traceStore.snapshot(capIdentifier);

  const deliveredTo = stats?.received.map((r) => r.smscMessageId) ?? [];

  let percentiles: DeliveryReport['deliveryPercentilesMs'] = null;
  if (trace?.percentiles) {
    percentiles = {
      firstDeliveryMs: trace.percentiles.firstDeliveryMs ?? null,
      p50Ms: trace.percentiles.p50Ms ?? null,
      p90Ms: trace.percentiles.p90Ms ?? null,
      p100Ms: trace.percentiles.p100Ms ?? null,
    };
  }

  let stageDeltas: DeliveryReport['stageDeltasMs'] = null;
  if (trace) {
    const { computeStageDeltas } = await import('../../types/trace.js');
    stageDeltas = computeStageDeltas(trace);
  }

  const report: DeliveryReport = {
    capIdentifier,
    expectedRecipients: trace?.expectedRecipients ?? stats?.expectedCount ?? 0,
    delivered: stats?.receivedCount ?? 0,
    deliveredTo,
    firstReceivedEpochMs: stats?.firstReceivedEpochMs ?? null,
    lastReceivedEpochMs: stats?.lastReceivedEpochMs ?? null,
    deliveryPercentilesMs: percentiles,
    stageDeltasMs: stageDeltas,
  };

  logger.info({ capIdentifier, delivered: report.delivered, expected: report.expectedRecipients }, 'dlr.report');
  return report;
}
