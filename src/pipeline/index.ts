/**
 * Automatic end-to-end pipeline wiring.
 *
 * - alert-pipeline.ts  : runAlertPipeline — chains 01 → 02 → 03/04 → 05 → 13
 * - pipeline-status.ts : per-alert progress/halt store (endpoint in routes.ts)
 * - subscriber-matcher.ts : registration point for modules 03/04 (empty today)
 * - routes.ts          : GET /api/v1/alerts/:capIdentifier/pipeline-status
 */
export { runAlertPipeline, runDisseminationLeg } from './alert-pipeline.js';
export type { RunPipelineInput, DisseminationInput } from './alert-pipeline.js';
export { PipelineStatusStore, pipelineStatusStore } from './pipeline-status.js';
export type { PipelineStatusRecord, PipelineStage, PipelineStatusKind } from './pipeline-status.js';
export { registerSubscriberMatcher, getSubscriberMatcher, resetSubscriberMatcher } from './subscriber-matcher.js';
export type { SubscriberMatcher, SubscriberMatch } from './subscriber-matcher.js';
export { createPipelineStatusRoutes } from './routes.js';
