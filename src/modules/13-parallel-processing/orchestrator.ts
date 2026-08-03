import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { capTiming } from '../01-cap-ingestion/cap-parser.js';
import type { CapAlert } from '../../types/cap.js';
import { getLogger } from '../../utils/logger.js';
import { ExpiryGuard } from '../06-expiry-control/expiry-guard.js';
import type { AlertSubmitSummary } from '../07-smpp-integration/batch-submitter.js';
import { chunkBatch, submitAlertBatchChunked } from '../07-smpp-integration/batch-submitter.js';
import { WorkerPoolExecutor } from './worker-pool-executor.js';
import type { WorkerJob } from './types.js';

const logger = getLogger();

export { chunkBatch };

/**
 * Parallel processing framework — requirement #13.
 *
 * The orchestrator splits the deduplicated MSISDN list into batches (at most
 * PARALLEL_WORKER_COUNT) and dispatches each to an executor. The default
 * executor is a real worker_threads pool (`PARALLEL_EXECUTION_MODE=threads`):
 * every batch submits inside its own OS thread. `PARALLEL_EXECUTION_MODE=inline`
 * (or an explicit `executor`) runs the identical pipeline in-process.
 *
 * The real CAP expiry is threaded into every job as `expiresAtIso` (from
 * `capTiming(alert)`), so both the worker threads and the inline path build the
 * same real expiry guard — requirement #6 holds end-to-end, including retries.
 */

/** Executor contract: one job (a whole worker slice) → one merged summary. */
export type BatchExecutor = (job: WorkerJob) => Promise<AlertSubmitSummary>;

export interface OrchestrateOptions {
  alert: CapAlert;
  content: string;
  msisdns: readonly string[];
  cfg?: ParsedEnvConfig;
  traceKey?: string;
  /** Override the executor (tests / advanced wiring). Defaults by mode. */
  executor?: BatchExecutor;
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
    exhaustedRetries: number;
    awaitingCredentials: boolean;
  };
}

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

/**
 * In-process executor: real submission through module 07, chunked and gated by
 * the real CAP expiry carried in the job (`expiresAtIso`).
 */
export async function inlineExecutor(
  job: WorkerJob,
  cfg: ParsedEnvConfig = loadConfig(),
): Promise<AlertSubmitSummary> {
  const guard = new ExpiryGuard({ expiresAt: job.expiresAtIso ? new Date(job.expiresAtIso) : null });
  return submitAlertBatchChunked(job.alertId, job.content, job.batch, {
    cfg,
    guard,
    traceKey: job.traceKey ?? job.capIdentifier,
  });
}

/**
 * Run one alert's dissemination: split → dispatch batches to a real
 * worker_threads pool (default) or the inline executor → merge.
 */
export async function orchestrateAlertPipeline(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const cfg = opts.cfg ?? loadConfig();
  const alertId = opts.alert.identifier;
  const traceKey = opts.traceKey ?? opts.alert.identifier;

  const timing = capTiming(opts.alert);
  const expiresAtIso = timing.expiresAt ? timing.expiresAt.toISOString() : null;

  const batches = splitBatches(opts.msisdns, cfg.PARALLEL_WORKER_COUNT, cfg.SUBMIT_BATCH_SIZE);
  const jobs: WorkerJob[] = batches.map((batch) => ({
    alertId,
    capIdentifier: traceKey,
    content: opts.content,
    batch,
    expiresAtIso,
    traceKey,
  }));

  let summaries: AlertSubmitSummary[];
  if (opts.executor) {
    summaries = await Promise.all(jobs.map((job) => opts.executor!(job)));
  } else if (cfg.PARALLEL_EXECUTION_MODE === 'threads') {
    summaries = await runBatchesInThreads(jobs, cfg);
  } else {
    summaries = await Promise.all(jobs.map((job) => inlineExecutor(job, cfg)));
  }

  const aggregate = summaries.reduce<OrchestrateResult['aggregate']>(
    (acc, s) => ({
      total: acc.total + s.total,
      accepted: acc.accepted + s.accepted,
      rejected: acc.rejected + s.rejected,
      failed: acc.failed + s.failed,
      retried: acc.retried + s.retried,
      gaveUpExpired: acc.gaveUpExpired + s.gaveUpExpired,
      exhaustedRetries: acc.exhaustedRetries + s.exhaustedRetries,
      awaitingCredentials: acc.awaitingCredentials || s.awaitingCredentials,
    }),
    { total: 0, accepted: 0, rejected: 0, failed: 0, retried: 0, gaveUpExpired: 0, exhaustedRetries: 0, awaitingCredentials: false },
  );

  logger.info(
    { capIdentifier: traceKey, mode: cfg.PARALLEL_EXECUTION_MODE, batches: batches.length, ...aggregate },
    'pipeline.completed',
  );
  return { capIdentifier: traceKey, batches: batches.length, summaries, aggregate };
}

/**
 * Dispatch every job to one shared worker_threads pool and shut it down
 * afterwards (no thread leak). A worker that fails a job becomes a
 * failed-summary so the rest of the alert is not aborted and the report is
 * honest about the failure.
 */
async function runBatchesInThreads(jobs: readonly WorkerJob[], cfg: ParsedEnvConfig): Promise<AlertSubmitSummary[]> {
  const pool = new WorkerPoolExecutor(cfg);
  try {
    const results = await Promise.all(jobs.map((job) => pool.execute(job)));
    return results.map((result, index) => {
      const job = jobs[index]!;
      if (result.ok && result.summary) return result.summary;
      return {
        total: job.batch.length,
        accepted: 0,
        rejected: 0,
        failed: job.batch.length,
        retried: 0,
        gaveUpExpired: 0,
        exhaustedRetries: 0,
        awaitingCredentials: false,
        results: job.batch.map((msisdn) => ({
          messageId: `${job.alertId}-${msisdn}`,
          msisdn,
          outcome: 'failed' as const,
          errorText: result.error ?? 'worker failed',
        })),
      };
    });
  } finally {
    await pool.terminate();
  }
}
