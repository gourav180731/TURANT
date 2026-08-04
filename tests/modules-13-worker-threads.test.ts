import { describe, expect, it } from 'vitest';
import { parseCapXml } from '../src/modules/01-cap-ingestion/cap-parser.js';
import { orchestrateAlertPipeline } from '../src/modules/13-parallel-processing/orchestrator.js';
import { WorkerPoolExecutor } from '../src/modules/13-parallel-processing/worker-pool-executor.js';
import { loadConfig } from '../src/config/env.js';
import type { WorkerJob } from '../src/modules/13-parallel-processing/types.js';

/**
 * Real worker_threads tests (requirement #13). These spawn actual OS threads —
 * no mocks — through the compiled-or-source worker entry. Each test terminates
 * its workers before returning so vitest exits cleanly (no dangling handles).
 *
 * Environment note: under vitest (and tsx dev), `import.meta.url` points at the
 * source tree, so the pool resolves the worker entry to the `.ts` file and runs
 * it with `--import tsx`. Node's built-in type stripping cannot be used because
 * the project imports use `.js` extensions (NodeNext ESM), which Node does not
 * remap to `.ts`. In a compiled `dist/` build the pool picks up the compiled
 * `.js` worker with no loader. This was verified empirically; the pool throws
 * a clear error if neither entry exists.
 */

const workerCfg = () => ({
  ...loadConfig(),
  PARALLEL_EXECUTION_MODE: 'threads' as const,
  PARALLEL_WORKER_COUNT: 2,
  SUBMIT_BATCH_SIZE: 500,
});

describe('module 13 — real worker_threads pool', () => {
  it('spawns ≤ PARALLEL_WORKER_COUNT threads, merges results, terminates cleanly', async () => {
    const cfg = workerCfg();
    const pool = new WorkerPoolExecutor(cfg);

    const jobs: WorkerJob[] = Array.from({ length: 3 }, (_, i) => ({
      alertId: `ALERT-${i}`,
      capIdentifier: `ALERT-${i}`,
      content: 'Severe cyclone warning',
      batch: Array.from({ length: 5 }, (_, j) => `919${i}${j}`),
      expiresAtIso: null,
    }));

    const results = await Promise.all(jobs.map((job) => pool.execute(job)));

    // (a) each worker produced a correctly-merged summary for its whole slice
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.ok).toBe(true);
      // No SMPP credentials inside the worker env → honest awaiting-credentials
      // summary with total = the worker's full batch (not fabricated delivery).
      expect(r.summary?.total).toBe(5);
      expect(r.summary?.awaitingCredentials).toBe(true);
    }

    // (b) workers are reused: never more than PARALLEL_WORKER_COUNT threads
    expect(pool.stats.spawnedTotal).toBeGreaterThan(0);
    expect(pool.stats.spawnedTotal).toBeLessThanOrEqual(2);
    expect(pool.stats.maxConcurrent).toBeLessThanOrEqual(2);

    // (c) terminate stops every worker — no dangling handles
    await pool.terminate();
    expect(pool.stats.active).toBe(0);
  });

  it('orchestrates through the real worker pool by default in threads mode', async () => {
    const cfg = workerCfg();
    const msisdns = Array.from({ length: 7 }, (_, i) => `919000${i}`);
    const sentIso = new Date(Date.now() - 60_000).toISOString();
    const expiresIso = new Date(Date.now() + 3_600_000).toISOString();
    const alert = parseCapXml(`<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
      <identifier>CDOT-THREADS-${Date.now()}</identifier><sender>ews@cdot.in</sender>
      <sent>${sentIso}</sent><status>Actual</status><msgType>Alert</msgType>
      <scope>Public</scope><code>x</code>
      <info><language>en-IN</language><category>Met</category><event>Storm</event>
      <urgency>Immediate</urgency><severity>Severe</severity><certainty>Likely</certainty>
      <expires>${expiresIso}</expires><area><areaDesc>test</areaDesc></area></info>
    </alert>`);

    // No executor supplied → the default threads path must spawn real workers.
    const result = await orchestrateAlertPipeline({ alert, content: 'storm', msisdns, cfg });

    expect(result.aggregate.total).toBe(7);
    expect(result.aggregate.awaitingCredentials).toBe(true); // workers saw no creds
    expect(result.batches).toBeGreaterThan(0);
  });
});
