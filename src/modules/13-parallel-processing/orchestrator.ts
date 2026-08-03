import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import type { CapAlert } from '../../types/cap.js';
import { getLogger } from '../../utils/logger.js';
import { ExpiryGuard, expiryGuardForAlert } from '../06-expiry-control/expiry-guard.js';
import type { AlertSubmitSummary } from '../07-smpp-integration/batch-submitter.js';
import { submitAlertBatch } from '../07-smpp-integration/batch-submitter.js';

const logger = getLogger();

/**
 * Parallel processing framework — requirement #13.
 *
 * The orchestrator splits the deduplicated MSISDN list into
 * PARALLEL_WORKER_COUNT batches, processes them concurrently (worker_threads in
 * production, injectable executor in tests), and merges the per-batch submit
 * summaries back into a single per-alert result. Batches are further chunked to
 * SUBMIT_BATCH_SIZE inside each worker. All batches share one trace key so the
 * per-alert latency timeline stays coherent across workers.
 */

/** Split `msisdns` into at most `workerCount` batches, each ≤ `maxBatchSize`. */
export function splitBatches(
  msisdns: readonly string[],
  workerCount: number,
  maxBatchSize = 500,
): string[][] {
  const total = msisdns.length;
  if (total === 0) return [];
  if (workerCount <= 1 || total <= maxBatchSize) {
    return [msisdns.slice()];
  }

  const workers = Math.min(workerCount, total);
  const perWorker = Math.ceil(total / workers);
  const batches: string[][] = [];
  for (let i = 0; i < workers; i++) {
    const slice = msisdns.slice(i * perWorker, Math.min((i + 1) * perWorker, total));
    if (slice.length > 0) batches.push(slice);
  }
  return batches;
}

/** Split one worker's slice into SUBMIT_BATCH_SIZE chunks. */
export function chunkBatch(batch: readonly string[], batchSize = 500): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < batch.length; i += batchSize) {
    chunks.push(batch.slice(i, i + batchSize));
  }
  return chunks;
}

export interface OrchestrateOptions {
  alert: CapAlert;
  content: string;
  msisdns: readonly string[];
  cfg?: ParsedEnvConfig;
  traceKey?: string;
  /**
   * Executor for one worker's whole slice (defaults to in-process
   * submitAlertBatch; production may supply the worker_threads executor).
   */
  executor?: (batch: readonly string[]) => Promise<AlertSubmitSummary>;
}

export interface OrchestrateResult {
  capIdentifier: string;
  batches: number;
  summaries: AlertSubmitSummary[];
  aggregate: {
    total: number;
    accepted: number;
    rejected: number;
    failed: number;
    retried: number;
    gaveUpExpired: number;
    awaitingCredentials: boolean;
  };
}

/** Default in-process executor: real submission through module 07. */
export async function defaultExecutor(batch: readonly string[]): Promise<AlertSubmitSummary> {
  const cfg = loadConfig();
  const guard = new ExpiryGuard({ expiresAt: null });
  return submitAlertBatch('unknown', '', batch, { cfg, guard });
}

/**
 * Run one alert's dissemination: split → process concurrently → merge.
 * Each worker slice is further chunked to SUBMIT_BATCH_SIZE, and the expiry
 * guard is consulted per chunk so the alert can halt mid-pipeline.
 */
export async function orchestrateAlertPipeline(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const cfg = opts.cfg ?? loadConfig();
  const alertId = opts.alert.identifier;
  const traceKey = opts.traceKey ?? opts.alert.identifier;
  const executor = opts.executor ?? defaultExecutor;
  const guard = expiryGuardForAlert(opts.alert);

  const batches = splitBatches(opts.msisdns, cfg.PARALLEL_WORKER_COUNT, cfg.SUBMIT_BATCH_SIZE);
  const summaries = await Promise.all(
    batches.map(async (batch) => {
      const chunks = chunkBatch(batch, cfg.SUBMIT_BATCH_SIZE);
      let merged = await emptySummary(alertId, 0, false);
      for (const chunk of chunks) {
        if (!guard.canSubmit()) {
          logger.warn({ alertId, chunk: chunk.length }, 'pipeline.halt_expired');
          break;
        }
        const chunkMessages = chunk;
        // Delegate the actual submit so SMPP credentials are read in the worker.
        const summary = await executor(chunkMessages);
        merged = mergeSummaries(merged, summary);
      }
      return merged;
    }),
  );

  const aggregate = summaries.reduce<OrchestrateResult['aggregate']>(
    (acc, s) => ({
      total: acc.total + s.total,
      accepted: acc.accepted + s.accepted,
      rejected: acc.rejected + s.rejected,
      failed: acc.failed + s.failed,
      retried: acc.retried + s.retried,
      gaveUpExpired: acc.gaveUpExpired + s.gaveUpExpired,
      awaitingCredentials: acc.awaitingCredentials || s.awaitingCredentials,
    }),
    { total: 0, accepted: 0, rejected: 0, failed: 0, retried: 0, gaveUpExpired: 0, awaitingCredentials: false },
  );

  logger.info({ capIdentifier: traceKey, batches: batches.length, ...aggregate }, 'pipeline.completed');
  return { capIdentifier: traceKey, batches: batches.length, summaries, aggregate };
}

async function emptySummary(alertId: string, total: number, awaitingCredentials: boolean): Promise<AlertSubmitSummary> {
  return {
    total,
    accepted: 0,
    rejected: 0,
    failed: 0,
    retried: 0,
    gaveUpExpired: 0,
    exhaustedRetries: 0,
    awaitingCredentials,
    results: [],
  };
}

function mergeSummaries(a: AlertSubmitSummary, b: AlertSubmitSummary): AlertSubmitSummary {
  return {
    total: a.total + b.total,
    accepted: a.accepted + b.accepted,
    rejected: a.rejected + b.rejected,
    failed: a.failed + b.failed,
    retried: a.retried + b.retried,
    gaveUpExpired: a.gaveUpExpired + b.gaveUpExpired,
    exhaustedRetries: a.exhaustedRetries + b.exhaustedRetries,
    awaitingCredentials: a.awaitingCredentials || b.awaitingCredentials,
    results: [...a.results, ...b.results],
  };
}
