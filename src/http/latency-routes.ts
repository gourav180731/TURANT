import { Router, type Request, type Response } from 'express';
import type { AlertTraceStore } from '../tracing/trace-store.js';
import type { AlertTraceRecord } from '../types/trace.js';
import { computeStageDeltas } from '../types/trace.js';

/**
 * Latency reporting endpoints (extends requirement #12).
 *
 *   GET /api/v1/traces                      — recent per-alert traces (dashboard)
 *   GET /api/v1/traces/:capIdentifier       — full timeline + deltas + delivery percentiles
 *
 * The bottleneck stage is visible directly: `deltas` are precomputed per alert,
 * and `percentiles` report t0 → first/50/90/100% of intended recipients, which
 * is how real early-warning systems are evaluated.
 */
export function createLatencyRoutes(store: AlertTraceStore): Router {
  const router = Router();

  const enrich = (rec: AlertTraceRecord) => ({ ...rec, deltas: computeStageDeltas(rec) });

  router.get('/traces', async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const records = await store.list(limit);
    res.json({ count: records.length, traces: records.map(enrich) });
  });

  router.get('/traces/:capIdentifier', async (req: Request, res: Response) => {
    const raw = req.params.capIdentifier;
    const capIdentifier = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
    if (!capIdentifier) {
      res.status(400).json({ error: 'capIdentifier is required' });
      return;
    }
    const rec = await store.snapshot(capIdentifier);
    if (!rec) {
      res.status(404).json({ error: 'no trace record for this CAP alert identifier' });
      return;
    }
    res.json(enrich(rec));
  });

  return router;
}
