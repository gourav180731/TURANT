/**
 * Module 10 — Configurable Delivery Strategy (requirement #10).
 */
export { resolveDeliveryPolicy, willRetry } from './delivery-policy.js';
export type { DeliveryPolicy, DeliveryStrategy } from './delivery-policy.js';
export { runRetryQueue } from './retry-queue.js';
export type { RetryOutcome, RetryQueueOptions, RetrySubmitter } from './retry-queue.js';
