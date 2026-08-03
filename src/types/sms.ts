/**
 * SMS submission model shared by the SMPP client (module 07), validity
 * enforcement (module 08), priority flagging (module 09) and delivery
 * strategy (module 10).
 */

export type SmsDataCoding = '7bit' | 'ucs2';

/** Per-recipient message ready for submit_sm. */
export interface SmsMessage {
  /** TURANT message id (also used as SMPP message reference / audit key). */
  messageId: string;
  /** CAP alert this message belongs to. */
  alertId: string;
  /** Destination MSISDN (E.164). */
  msisdn: string;
  /** Text payload. */
  content: string;
  /** SMS data coding. */
  dataCoding: SmsDataCoding;
  /**
   * SMPP validity_period, absolute time (RFC 2822 / SMPP absolute format).
   * Derived from the CAP expires timestamp (module 08).
   */
  validityPeriod?: Date;
  /** SMPP priority_flag (module 09) — 0 = normal … 3 = highest. */
  priorityFlag: 0 | 1 | 2 | 3;
  /** registered_delivery bits (module 11 DLR). */
  registeredDelivery: number;
}

export type DeliveryOutcome = 'submitted' | 'accepted' | 'rejected' | 'failed' | 'expired';

export interface SubmissionResult {
  messageId: string;
  msisdn: string;
  outcome: DeliveryOutcome;
  /** SMSC-assigned message id, when the SMSC returned one. */
  smscMessageId?: string;
  /** SMPP command_status on rejection / error text. */
  errorCode?: number;
  errorText?: string;
  /** Delivery receipt data once a DLR arrives (module 11). */
  dlr?: DlrReceipt;
}

/** Normalized delivery receipt parsed from a deliver_sm PDU (module 11). */
export interface DlrReceipt {
  smscMessageId: string;
  /** "DELIVRD" | "REJECTD" | "EXPIRED" | ... per SMPP message_state. */
  messageState: string;
  errorCode?: string;
  deliveredAt?: Date;
}
