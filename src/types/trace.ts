/**
 * Per-alert latency trace model.
 *
 * TURANT's single most important measurement is end-to-end latency: the time
 * from CAP issuance to actual phone delivery. Every module records its stage
 * timestamp into a shared per-alert record keyed by the CAP alert identifier,
 * so the full timeline can be reconstructed and the bottleneck stage is visible
 * without manual arithmetic.
 *
 * Stage contract (cross-cutting, applies to every module as it is built):
 *
 *   t0 — CAP XML received/ingested                        (module 01)
 *   t1 — Cell site identification complete                (module 02)
 *   t2 — Subscriber matching complete, post-dedup         (modules 03, 04, 05)
 *   t3 — SMPP submission complete for the batch           (modules 06, 09, 10)
 *   t4 — First delivery receipt (DLR) received            (module 11)
 *   t5 — All expected DLRs received, or alert expiry      (modules 06, 08)
 */

export type TraceStage = 't0' | 't1' | 't2' | 't3' | 't4' | 't5';

export const TRACE_STAGES: readonly TraceStage[] = ['t0', 't1', 't2', 't3', 't4', 't5'];

export interface TracePoint {
  stage: TraceStage;
  /** Short label describing what happened, e.g. "cap.ingest", "cell.match". */
  label: string;
  /** Wall-clock epoch milliseconds (Date.now()) — source of truth for reporting. */
  epochMs: number;
}

export interface StageDelta {
  from: TraceStage;
  to: TraceStage;
  label: string;
  deltaMs: number;
}

/** Percentile-based delivery times measured from t0. */
export interface DeliveryPercentiles {
  /** t0 → first successful delivery. */
  firstDeliveryMs: number;
  /** t0 → 50% of intended recipients delivered. */
  p50Ms: number;
  /** t0 → 90% of intended recipients delivered. */
  p90Ms: number;
  /** t0 → 100% of intended recipients delivered. */
  p100Ms: number;
}

export interface AlertTraceRecord {
  /** CAP alert identifier (sender:identifier) — the trace key. */
  capIdentifier: string;
  /** Stage timestamps as they were recorded. */
  points: Partial<Record<TraceStage, TracePoint>>;
  /** Number of intended recipients after dedup (set by module 05). */
  expectedRecipients: number;
  /** Number of delivery receipts observed so far. */
  deliveredCount: number;
  /** Delivery-time distribution relative to t0, when DLRs have arrived. */
  percentiles?: DeliveryPercentiles;
  updatedAtMs: number;
}

/** Ordered pairs used to derive the inter-stage deltas. */
const DELTA_PAIRS: Array<{ from: TraceStage; to: TraceStage; label: string }> = [
  { from: 't0', to: 't1', label: 'cell-site identification (module 02)' },
  { from: 't1', to: 't2', label: 'subscriber match + dedup (modules 04-05)' },
  { from: 't2', to: 't3', label: 'SMPP submission (modules 06-10)' },
  { from: 't3', to: 't4', label: 'to first DLR (module 11)' },
  { from: 't4', to: 't5', label: 'remaining DLRs / expiry (modules 06,08)' },
  { from: 't0', to: 't5', label: 'end-to-end pipeline' },
];

/** Compute inter-stage deltas from recorded points (missing stages are skipped). */
export function computeStageDeltas(record: Pick<AlertTraceRecord, 'points'>): StageDelta[] {
  const deltas: StageDelta[] = [];
  for (const pair of DELTA_PAIRS) {
    const from = record.points[pair.from];
    const to = record.points[pair.to];
    if (from && to) {
      deltas.push({ from: pair.from, to: pair.to, label: pair.label, deltaMs: to.epochMs - from.epochMs });
    }
  }
  return deltas;
}

/**
 * Compute percentile delivery times relative to t0 from per-message DLR
 * durations. Nearest-rank method; returns undefined when no receipts exist.
 */
export function computeDeliveryPercentiles(durationsMs: number[]): DeliveryPercentiles | undefined {
  if (durationsMs.length === 0) return undefined;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const at = (quantile: number): number => {
    const idx = Math.max(0, Math.ceil((quantile / 100) * sorted.length) - 1);
    return sorted[idx]!;
  };
  return {
    firstDeliveryMs: sorted[0]!,
    p50Ms: at(50),
    p90Ms: at(90),
    p100Ms: sorted[sorted.length - 1]!,
  };
}
