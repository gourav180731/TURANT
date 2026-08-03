/**
 * Module 11 — DLR Receipt Processing (requirement #11).
 */
export { DlrListener, parseDeliverSmReceipt, parseDoneDate, smppMessageStateName, isDeliveryReceipt } from './dlr-listener.js';
export type { RegisteredSubmission, AlertReceiptStats } from './dlr-listener.js';
export { buildDeliveryReport } from './dlr-reporter.js';
export type { DeliveryReport, DeliveryReporterOptions } from './dlr-reporter.js';
