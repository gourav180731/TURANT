import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getLogger } from '../../utils/logger.js';
import type { WorkerJob, WorkerResult } from './types.js';

const logger = getLogger();

/**
 * Real worker_threads pool — requirement #13.
 *
 * Spawns up to `PARALLEL_WORKER_COUNT` real OS worker threads and reuses them
 * across jobs (a worker handles one job at a time and stays alive). This is
 * true OS-level parallelism, not concurrent promises: the SMSC submission for
 * each batch runs inside its own thread.
 *
 * Entry-point resolution: in a compiled build (`dist/`) the compiled
 * `match-and-submit-worker.js` is used (no loader). In dev/test the source
 * `.ts` is loaded via `--import tsx` because Node's built-in type stripping
 * does not rewrite the project's `.js`-extension imports to `.ts`.
 *
 * Error handling: a worker that errors or exits early fails only the job it
 * was handling; the pool resolves that job with `ok:false` and continues.
 * `terminate()` stops all workers and rejects queued jobs so the process can
 * exit cleanly (no dangling thread handles).
 */

export interface WorkerPoolStats {
  /** Total Worker instances ever spawned by this pool. */
  spawnedTotal: number;
  /** Peak number of simultaneously alive workers. */
  maxConcurrent: number;
  /** Workers currently alive. */
  active: number;
}

interface QueuedJob {
  job: WorkerJob;
  resolve: (result: WorkerResult) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  current: QueuedJob | null;
}

function resolveWorkerEntry(): { path: string; execArgv: string[] } {
  const candidates: Array<{ url: URL; execArgv: string[] }> = [
    // Compiled build (dist/): plain JS, no loader needed.
    { url: new URL('./workers/match-and-submit-worker.js', import.meta.url), execArgv: [] },
    // Dev/test (tsx): source .ts with tsx loader.
    { url: new URL('./workers/match-and-submit-worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] },
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(fileURLToPath(candidate.url))) {
        return { path: fileURLToPath(candidate.url), execArgv: candidate.execArgv };
      }
    } catch {
      // fall through to the next candidate
    }
  }
  throw new Error('Could not resolve module 13 worker entry point (source or build).');
}

export class WorkerPoolExecutor {
  readonly stats: WorkerPoolStats = { spawnedTotal: 0, maxConcurrent: 0, active: 0 };

  private readonly workers: PooledWorker[] = [];
  private readonly queue: QueuedJob[] = [];
  private readonly cfg: ParsedEnvConfig;
  private readonly entry: { path: string; execArgv: string[] };
  private terminated = false;

  constructor(cfg: ParsedEnvConfig = loadConfig()) {
    this.cfg = cfg;
    this.entry = resolveWorkerEntry();
  }

  /** Execute one job on the pool; resolves when its worker replies. */
  execute(job: WorkerJob): Promise<WorkerResult> {
    if (this.terminated) {
      return Promise.resolve({ ok: false, alertId: job.alertId, capIdentifier: job.capIdentifier, error: 'pool terminated' });
    }
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.pump();
    });
  }

  /** Stop all workers and fail any queued jobs (idempotent). */
  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    for (const q of this.queue.splice(0)) {
      q.resolve({ ok: false, alertId: q.job.alertId, capIdentifier: q.job.capIdentifier, error: 'pool terminated' });
    }
    const alive = [...this.workers];
    this.workers.length = 0;
    await Promise.all(alive.map((w) => new Promise<void>((resolve) => {
      try {
        w.worker.terminate().then(() => resolve());
      } catch {
        resolve();
      }
    })));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((w) => !w.busy);
      if (idle) {
        const next = this.queue.shift()!;
        this.dispatch(idle, next);
      } else if (this.workers.length < this.cfg.PARALLEL_WORKER_COUNT) {
        this.spawn();
      } else {
        break; // all workers busy — wait for a slot
      }
    }
  }

  private spawn(): void {
    // workerData: null — pooled jobs arrive via postMessage only. (Passing an
    // empty object would be truthy and make the worker ALSO run its
    // standalone workerData branch against `{}`, producing a bogus result.)
    const worker = new Worker(this.entry.path, { execArgv: this.entry.execArgv, workerData: null });
    const slot: PooledWorker = { worker, busy: false, current: null };
    this.workers.push(slot);
    this.stats.spawnedTotal += 1;
    this.stats.active += 1;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.stats.active);

    worker.on('message', (result: WorkerResult) => {
      const current = slot.current;
      slot.busy = false;
      slot.current = null;
      if (current) current.resolve(result);
      this.pump();
    });

    worker.on('error', (err: Error) => {
      logger.error({ err: err.message }, 'worker.pool_error');
      this.failSlot(slot, `worker error: ${err.message}`);
    });

    worker.on('exit', (code) => {
      if (slot.busy) {
        this.failSlot(slot, `worker exited unexpectedly (code ${code})`);
      } else {
        this.removeWorker(slot);
      }
    });
  }

  private dispatch(slot: PooledWorker, queued: QueuedJob): void {
    slot.busy = true;
    slot.current = queued;
    slot.worker.postMessage(queued.job);
  }

  /** A worker died mid-job: fail its job, remove it, and let pump() respawn. */
  private failSlot(slot: PooledWorker, reason: string): void {
    const current = slot.current;
    slot.busy = false;
    slot.current = null;
    this.removeWorker(slot);
    if (current) {
      current.resolve({
        ok: false,
        alertId: current.job.alertId,
        capIdentifier: current.job.capIdentifier,
        error: reason,
      });
    }
    this.pump();
  }

  private removeWorker(slot: PooledWorker): void {
    const idx = this.workers.indexOf(slot);
    if (idx >= 0) this.workers.splice(idx, 1);
    this.stats.active -= 1;
  }
}

/** Execute a job on a one-shot pool and shut the pool down afterwards. */
export async function runInWorkerPool(job: WorkerJob, cfg: ParsedEnvConfig = loadConfig()): Promise<WorkerResult> {
  const pool = new WorkerPoolExecutor(cfg);
  try {
    return await pool.execute(job);
  } finally {
    await pool.terminate();
  }
}
