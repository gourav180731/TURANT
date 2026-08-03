import type { CapAlert } from '../../types/cap.js';
import { getLogger } from '../../utils/logger.js';
import { capTiming } from '../01-cap-ingestion/cap-parser.js';

const logger = getLogger();

/**
 * Expiry-aware submission control — requirement #6.
 *
 * Before submitting each batch to the SMSC, check the CAP alert's real
 * `expires` timestamp; the moment it is reached, halt all further submission.
 *
 * The guard is seeded with the real CAP timing output of module 01
 * (`capTiming(alert).expiresAt`) — never a placeholder date. A configurable
 * lead margin protects against clock skew between TURANT and the SMSC, and
 * `EXPIRY_HALT_SUBMISSION` gates the hard halt.
 */

export interface ExpiryGuardOptions {
  /** Real CAP expires timestamp (null = no expiry declared). */
  expiresAt: Date | null;
  /** Injectable clock for deterministic tests (defaults to `new Date()`). */
  now?: () => Date;
  /** Safety margin (ms) applied before the declared expiry. Default 0. */
  leadMarginMs?: number;
  /** `EXPIRY_HALT_SUBMISSION` — when false, submission is not halted. */
  haltEnabled?: boolean;
}

export interface ExpiryStatus {
  canSubmit: boolean;
  reason: 'ok' | 'expired' | 'no-expiry' | 'halt-disabled';
  remainingMs: number | null;
  expiresAt: Date | null;
}

/**
 * Real expiry logic. `canSubmit()` is safe to call inside a submission loop
 * before every batch — it is cheap and recomputes from the current instant.
 */
export class ExpiryGuard {
  private readonly expiresAt: Date | null;
  private readonly now: () => Date;
  private readonly leadMarginMs: number;
  private readonly haltEnabled: boolean;

  constructor(options: ExpiryGuardOptions) {
    this.expiresAt = options.expiresAt;
    this.now = options.now ?? (() => new Date());
    this.leadMarginMs = options.leadMarginMs ?? 0;
    this.haltEnabled = options.haltEnabled ?? true;
  }

  /** True when submission should proceed for the current instant. */
  canSubmit(): boolean {
    return this.status().canSubmit;
  }

  /** Detailed status for logging / counting expired messages. */
  status(): ExpiryStatus {
    if (!this.haltEnabled) {
      return { canSubmit: true, reason: 'halt-disabled', remainingMs: null, expiresAt: this.expiresAt };
    }
    if (!this.expiresAt) {
      return { canSubmit: true, reason: 'no-expiry', remainingMs: null, expiresAt: null };
    }
    const nowMs = this.now().getTime();
    const expiresMs = this.expiresAt.getTime();
    const remainingMs = expiresMs - nowMs - this.leadMarginMs;
    if (remainingMs <= 0) {
      return { canSubmit: false, reason: 'expired', remainingMs, expiresAt: this.expiresAt };
    }
    return { canSubmit: true, reason: 'ok', remainingMs, expiresAt: this.expiresAt };
  }

  /** Milliseconds until the (margin-adjusted) expiry; null when no expiry/halt. */
  remainingMs(): number | null {
    return this.status().remainingMs;
  }

  /**
   * Mark t5 on the shared trace when submission halts at expiry (one of the
   * two legitimate t5 conditions — the other is all expected DLRs in).
   */
  async markExpiryTrace(traceKey: string): Promise<void> {
    const { traceStore } = await import('../../tracing/trace-store.js');
    logger.warn({ traceKey }, 'submit.halt_expired');
    await traceStore.mark(traceKey, 't5', 'alert.expiry', Date.now());
  }
}

/** Build a guard from a real parsed CAP alert (module 01 output). */
export function expiryGuardForAlert(alert: CapAlert, overrides: Omit<ExpiryGuardOptions, 'expiresAt'> = {}): ExpiryGuard {
  return new ExpiryGuard({ expiresAt: capTiming(alert).expiresAt, ...overrides });
}

/** One-shot check for the current instant, with default halt behavior. */
export function isExpiredNow(expiresAt: Date | null, leadMarginMs = 0): boolean {
  return !new ExpiryGuard({ expiresAt, leadMarginMs }).canSubmit();
}
