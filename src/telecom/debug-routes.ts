import { Router, type Request, type Response } from 'express';
import { getLogger } from '../utils/logger.js';
import type { SubscriberRepository } from './repositories/index.js';
import { getTowerStore } from './tower-store.js';

const log = getLogger();

/**
 * Debug endpoints for the telecom simulation (ENABLE_DEBUG_ENDPOINTS=true only).
 *
 *   GET  /api/v1/debug/sim                → sim status (mode/seed/counts)
 *   GET  /api/v1/debug/sim/towers?limit=  → sample towers from the store
 *   GET  /api/v1/debug/sim/subscribers?cellId=X&limit= → subscribers on a cell
 */
export function createTelecomSimDebugRoutes(repo: SubscriberRepository): Router {
  const router = Router();

  router.get('/sim', (_req: Request, res: Response) => {
    const store = getTowerStore();
    res.json({
      repo: repo.name,
      towers: store.size,
      subscribers: 'see /sim/subscribers/count',
    });
  });

  router.get('/sim/towers', (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 100);
    const towers = getTowerStore()
      .all()
      .slice(0, limit)
      .map((t) => ({
        siteId: t.siteId,
        cellId: t.cellId,
        operator: t.operatorShortName,
        technology: t.technology,
        latitude: t.latitude,
        longitude: t.longitude,
        coverageRadiusM: t.coverageRadiusM,
      }));
    res.json({ count: towers.length, towers });
  });

  router.get('/sim/subscribers', async (req: Request, res: Response) => {
    const cellId = String(req.query.cellId ?? '');
    const limit = Number(req.query.limit ?? 100);
    if (!cellId) {
      res.status(400).json({ error: 'query param cellId is required' });
      return;
    }
    try {
      const rows = await repo.findByCellIds([cellId], { limit });
      res.json({ cellId, count: rows.length, subscribers: rows.slice(0, limit) });
    } catch (err) {
      log.error({ err, cellId }, 'debug.sim.subscribers_failed');
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
