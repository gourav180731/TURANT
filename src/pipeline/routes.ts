import { Router, type Request, type Response } from 'express';
import type { PipelineStatusStore } from './pipeline-status.js';

/**
 * Pipeline status endpoint.
 *
 *   GET /api/v1/alerts/:capIdentifier/pipeline-status
 *
 * Returns how far a real alert travelled through the automatic pipeline:
 * status (running | halted | completed), the farthest stage, the halt reason
 * when one exists, the tower count found by module 02, and a reference to the
 * existing latency-trace endpoint (which already carries the full t0..t5
 * timeline + delivery percentiles — not duplicated here).
 */
export function createPipelineStatusRoutes(store: PipelineStatusStore): Router {
  const router = Router();

  router.get('/alerts/:capIdentifier/pipeline-status', async (req: Request, res: Response) => {
    const raw = req.params.capIdentifier;
    const capIdentifier = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
    if (!capIdentifier) {
      res.status(400).json({ error: 'capIdentifier is required' });
      return;
    }
    const rec = await store.get(capIdentifier);
    if (!rec) {
      res.status(404).json({ error: 'no pipeline status for this CAP alert identifier' });
      return;
    }
    res.json({
      ...rec,
      traceRef: `/api/v1/traces/${encodeURIComponent(capIdentifier)}`,
    });
  });

  return router;
}

/**
 * Matched-tower endpoint.
 *
 *   GET /api/v1/alerts/:capIdentifier/towers
 *
 * Returns the *real* towers module 02 identified for an alert (id, cell id,
 * lat/lng, coverage radius) — captured when the pipeline ran. The frontend
 * renders these as markers inside the drawn polygon. 404 when no alert (or no
 * tower resolution) exists yet.
 */
export function createTowersRoute(store: PipelineStatusStore): Router {
  const router = Router();

  router.get('/alerts/:capIdentifier/towers', (req: Request, res: Response) => {
    const raw = req.params.capIdentifier;
    const capIdentifier = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
    if (!capIdentifier) {
      res.status(400).json({ error: 'capIdentifier is required' });
      return;
    }
    const rec = store.get(capIdentifier);
    if (!rec) {
      res.status(404).json({ error: 'no pipeline status for this CAP alert identifier' });
      return;
    }
    const towers = store.getTowers(capIdentifier);
    if (towers === undefined) {
      res.status(404).json({ error: 'tower resolution has not run for this alert yet' });
      return;
    }
    res.json({ capIdentifier, count: towers.length, towers });
  });

  return router;
}
