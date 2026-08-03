import { traceStore } from '../../tracing/trace-store.js';
import type { DlrReceipt } from '../../types/sms.js';
import type { DeliverSmPdu } from 'smpp';
import { getLogger } from '../../utils/logger.js';
import type { SmppClient } from '../07-smpp-integration/smpp-client.js';

const logger = getLogger();

/**
 * Delivery receipt (DLR) listener — requirement #11.
 *
 * Watches the real SMSC session for `deliver_sm` PDUs (registered_delivery was
 * set on submit_sm so the SMSC pushes receipts). Each receipt is parsed into a
 * DlrReceipt, matched back to the originating alert, recorded against the
 * shared latency trace (t4 = first DLR, t5 = all expected DLRs), and exposed
 * to the reporter for the per-alert report.
 */

export interface RegisteredSubmission {
  /** TURANT message id (reference). */
  messageId: string;
  /** SMSC-assigned message id returned by submit_sm. */
  smscMessageId: string;
  alertId: string;
  msisdn: string;
}

/** Earliest DLR of an alert. */
export interface AlertReceiptStats {
  alertId: string;
  receivedCount: number;
  expectedCount: number;
  firstReceivedEpochMs: number | null;
  lastReceivedEpochMs: number | null;
  received: DlrReceipt[];
}

const SMPP_DELIVERY_RECEIPT_ESM = 0x04;

export class DlrListener {
  private readonly submissions = new Map<string, RegisteredSubmission>();
  private readonly alerts = new Map<string, AlertReceiptStats>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Record a submission so an arriving receipt can be correlated. */
  registerSubmission(smscMessageId: string, sub: Omit<RegisteredSubmission, 'smscMessageId'>): void {
    if (!smscMessageId) return;
    this.submissions.set(smscMessageId, { smscMessageId, ...sub });
    this.submissions.set(sub.messageId, { smscMessageId, ...sub });
  }

  /** Correlate and record a receipt; returns the parsed receipt or null. */
  async handlePdu(pdu: DeliverSmPdu): Promise<DlrReceipt | null> {
    const receipt = parseDeliverSmReceipt(pdu);
    if (!receipt) {
      logger.debug({ pdu }, 'dlr.non_receipt_ignored');
      return null;
    }

    const sub =
      this.submissions.get(receipt.smscMessageId) ?? this.submissions.get(String(pdu.message_id ?? ''));
    const deliveredAt = receipt.deliveredAt ?? this.now();

    if (sub) {
      await traceStore.recordDelivery(sub.alertId, deliveredAt.getTime());
      await this.noteReceipt(sub.alertId, receipt, deliveredAt.getTime());
      logger.info({ alertId: sub.alertId, msisdn: sub.msisdn, state: receipt.messageState }, 'dlr.received');
    } else {
      logger.warn({ smscMessageId: receipt.smscMessageId }, 'dlr.unmatched_receipt');
    }
    return receipt;
  }

  /** Wire the listener onto a real SMPP client (module 07). */
  attachTo(client: SmppClient): void {
    client.onDeliveryReceipt((pdu) => void this.handlePdu(pdu));
  }

  /** Per-alert DLR aggregation for the reporter. */
  receiptsForAlert(alertId: string): AlertReceiptStats | undefined {
    return this.alerts.get(alertId);
  }

  private async noteReceipt(alertId: string, receipt: DlrReceipt, deliveredEpochMs: number): Promise<void> {
    let stats = this.alerts.get(alertId);
    if (!stats) {
      stats = { alertId, receivedCount: 0, expectedCount: 0, firstReceivedEpochMs: null, lastReceivedEpochMs: null, received: [] };
      this.alerts.set(alertId, stats);
    }
    stats.received.push(receipt);
    stats.receivedCount += 1;
    stats.lastReceivedEpochMs = deliveredEpochMs;
    if (stats.firstReceivedEpochMs === null) {
      stats.firstReceivedEpochMs = deliveredEpochMs;
      await traceStore.mark(alertId, 't4', 'dlr.first', deliveredEpochMs);
    }

    const snapshot = await traceStore.snapshot(alertId);
    const expected = snapshot?.expectedRecipients ?? stats.expectedCount;
    stats.expectedCount = expected;
    if (expected > 0 && stats.receivedCount >= expected) {
      await traceStore.mark(alertId, 't5', 'dlr.all_expected', deliveredEpochMs);
      logger.info({ alertId, receivedCount: stats.receivedCount, expected }, 'dlr.all_expected');
    }
  }
}

/**
 * Parse a deliver_sm PDU into a receipt. A receipt carries a message_state and
 * (for SMPP 3.4) a receipt text like
 * `id:.. sub:001 dlvrd:001 submit date:.. done date:.. stat:DELIVRD err:000`.
 * Non-receipt PDUs (no state, no stat:) return null.
 */
export function parseDeliverSmReceipt(pdu: DeliverSmPdu): DlrReceipt | null {
  const state = pdu.message_state;
  const text = extractReceiptText(pdu);
  if (state === undefined && !text) return null;

  const smscMessageId =
    (typeof pdu.message_id === 'string' && pdu.message_id) || parseField(text, 'id') || '';
  if (!smscMessageId) return null;

  const stat = parseField(text, 'stat') ?? smppMessageStateName(state);
  if (!stat) return null;

  return {
    smscMessageId,
    messageState: stat,
    errorCode: parseField(text, 'err') ?? undefined,
    deliveredAt: parseDoneDate(text) ?? undefined,
  };
}

function extractReceiptText(pdu: DeliverSmPdu): string | undefined {
  const sm = pdu.short_message;
  if (typeof sm === 'string') return sm;
  if (sm instanceof Buffer) return sm.toString('utf8');
  if (sm && typeof sm === 'object') {
    const inner = (sm as { message?: string | Buffer }).message;
    if (typeof inner === 'string') return inner;
    if (inner instanceof Buffer) return inner.toString('utf8');
  }
  return undefined;
}

function parseField(text: string | undefined, key: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(new RegExp(`(?:^| )${key}:(\\S+)`));
  return match?.[1];
}

const MESSAGE_STATES: Record<number, string> = {
  1: 'DELIVRD',
  2: 'EXPIRED',
  3: 'DELETED',
  4: 'UNDELIV',
  5: 'ACCEPTD',
  6: 'UNKNOWN',
  7: 'REJECTD',
};

export function smppMessageStateName(messageState: number | undefined): string | undefined {
  if (messageState === undefined) return undefined;
  return MESSAGE_STATES[messageState];
}

/** Parse `done date:` (SMPP YYMMDDhhmm) into a Date. */
export function parseDoneDate(text: string | undefined): Date | null {
  const raw = parseField(text, 'done date');
  if (!raw || !/^\d{10}$/.test(raw)) return null;
  const year = 2000 + Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4)) - 1;
  const day = Number(raw.slice(4, 6));
  const hour = Number(raw.slice(6, 8));
  const minute = Number(raw.slice(8, 10));
  const date = new Date(year, month, day, hour, minute);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when the PDU is marked as a delivery receipt via esm_class. */
export function isDeliveryReceipt(pdu: DeliverSmPdu): boolean {
  return (Number(pdu.esm_class) & SMPP_DELIVERY_RECEIPT_ESM) === SMPP_DELIVERY_RECEIPT_ESM || pdu.message_state !== undefined;
}
