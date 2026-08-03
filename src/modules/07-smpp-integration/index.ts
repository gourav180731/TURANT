/**
 * Module 07 — SMSC/SMPP Integration (requirement #7).
 *
 * Real SMPP 3.4 client (npm `smpp`) with bind lifecycle, validity period
 * (module 08), priority flag (module 09), bounded-concurrency batching and
 * reconnect. Connection requires real credentials; until SMPP_HOST /
 * SMPP_SYSTEM_ID are set, submit paths report `awaitingCredentials`.
 */
export { SmppClient, buildSubmitSmPdu, encodeMessageContent, smppErrorText } from './smpp-client.js';
export { getSmppSession, resetSmppSessionForTests } from './smpp-session.js';
export { submitAlertBatch, buildSmsMessages } from './batch-submitter.js';
export type { AlertSubmitSummary, SubmitAlertOptions } from './batch-submitter.js';
