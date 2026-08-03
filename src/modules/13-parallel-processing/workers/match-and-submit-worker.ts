import { parentPort, workerData } from 'node:worker_threads';
import { submitAlertBatch } from '../../07-smpp-integration/batch-submitter.js';
import { ExpiryGuard } from '../../06-expiry-control/expiry-guard.js';

/**
 * worker_threads entry for requirement #13.
 *
 * Receives one batch slice (post-dedup MSISDNs) and submits it through the
 * real module 07 client. Because the worker loads its own config from the
 * environment, real C-DOT SMPP credentials arriving later need no code change —
 * the worker reads them at call time. Results are posted back to the
 * orchestrator.
 */

export interface WorkerJob {
  alertId: string;
  capIdentifier: string;
  content: string;
  batch: string[];
  traceKey?: string;
}

export interface WorkerResult {
  ok: boolean;
  alertId: string;
  capIdentifier: string;
  summary?: unknown;
  error?: string;
}

async function runJob(job: WorkerJob): Promise<WorkerResult> {
  try {
    const guard = new ExpiryGuard({ expiresAt: null });
    const summary = await submitAlertBatch(job.alertId, job.content, job.batch, {
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

if (parentPort && workerData) {
  const port = parentPort;
  void runJob(workerData as WorkerJob).then((result) => {
    port.postMessage(result);
  });
}
