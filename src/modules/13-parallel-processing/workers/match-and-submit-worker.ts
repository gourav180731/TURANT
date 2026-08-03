import { parentPort, workerData } from 'node:worker_threads';
import { submitAlertBatchChunked } from '../../07-smpp-integration/batch-submitter.js';
import { ExpiryGuard } from '../../06-expiry-control/expiry-guard.js';
import type { WorkerJob, WorkerResult } from '../types.js';

/**
 * worker_threads entry for requirement #13.
 *
 * Receives one batch slice (post-dedup MSISDNs) and submits it through the
 * real module 07 client, chunked to SUBMIT_BATCH_SIZE and gated by the real
 * CAP expiry threaded in as `expiresAtIso` (requirement #6 end-to-end).
 *
 * Because the worker loads its own config from the environment, real C-DOT
 * SMPP credentials arriving later need no code change — the worker reads them
 * at call time. Results are posted back to the orchestrator via postMessage.
 */

async function runJob(job: WorkerJob): Promise<WorkerResult> {
  try {
    const guard = new ExpiryGuard({ expiresAt: job.expiresAtIso ? new Date(job.expiresAtIso) : null });
    const summary = await submitAlertBatchChunked(job.alertId, job.content, job.batch, {
      guard,
      traceKey: job.traceKey ?? job.capIdentifier,
    });
    return { ok: true, alertId: job.alertId, capIdentifier: job.capIdentifier, summary };
  } catch (err) {
    return {
      ok: false,
      alertId: job.alertId,
      capIdentifier: job.capIdentifier,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

if (parentPort) {
  const port = parentPort;
  // Pooled use: each job arrives as a message.
  port.on('message', (job: WorkerJob) => {
    void runJob(job).then((result) => port.postMessage(result));
  });
  // Standalone use: a single job carried in workerData at spawn.
  if (workerData) {
    void runJob(workerData as WorkerJob).then((result) => port.postMessage(result));
  }
}
