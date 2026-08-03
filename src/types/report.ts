/**
 * Per-alert processing report, produced by the pipeline and delivered to the
 * originating EWS via module 12's callback.
 *
 * "SMS submitted count" must equal "successful push count" — see the
 * EWS callback contract in module 12.
 */

export interface AlertReport {
  alertId: string;
  capIdentifier: string;

  processingStartedAt: string;
  processingEndedAt: string;

  /** Subscribers matched after dedup. */
  targetedSubscriberCount: number;

  /** SMS messages accepted for submission to the SMSC. */
  smsSubmittedCount: number;

  /** SMS messages the SMSC accepted (submit_sm success). */
  smsAcceptedCount: number;

  /** Messages confirmed delivered via DLR. */
  deliveredCount: number;

  /** Messages rejected or failed. */
  failedCount: number;

  /** Messages dropped because the alert expired before submission. */
  expiredMessageCount: number;

  /** Always `smsSubmittedCount === successfulPushCount`. */
  successfulPushCount: number;

  /** Per-tower breakdown for audit. */
  towerCount: number;

  /**
   * Latency (measured from t0 = CAP ingestion) reported to the EWS so it can
   * judge delivery speed, not just volume. Absent until the first DLR arrives.
   */
  latencyMs?: {
    /** t0 → first successful delivery. */
    t0ToFirstDeliveryMs?: number;
    /** t0 → 50% of intended recipients delivered. */
    t0ToP50Ms?: number;
    /** t0 → 90% of intended recipients delivered. */
    t0ToP90Ms?: number;
    /** t0 → 100% of intended recipients delivered. */
    t0ToP100Ms?: number;
  };

  completed: boolean;
}
