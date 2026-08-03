/**
 * Module 13 — Parallel Processing Framework (requirement #13).
 *
 * Default execution mode is real OS worker_threads (`PARALLEL_EXECUTION_MODE=
 * threads`); set it to `inline` to run the identical pipeline in-process.
 */
export { orchestrateAlertPipeline, splitBatches, chunkBatch, inlineExecutor } from './orchestrator.js';
export type { OrchestrateOptions, OrchestrateResult, BatchExecutor } from './orchestrator.js';
export { WorkerPoolExecutor, runInWorkerPool } from './worker-pool-executor.js';
export type { WorkerPoolStats } from './worker-pool-executor.js';
export type { WorkerJob, WorkerResult } from './types.js';
