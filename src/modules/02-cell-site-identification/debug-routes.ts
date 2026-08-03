import { Router, type Request, type Response } from 'express';
import type { GeoZone } from '../../types/tower.js';
import { getLogger } from '../../utils/logger.js';
import type { TowerResolver } from './resolver.js';

const logger = getLogger();

/**
 * Debug endpoint (ENABLE_DEBUG_ENDPOINTS=true only) to exercise the cell-site
 * resolver against the real tower DB once connected. Never exposed in prod.
 *
 *   POST /api/v1/debug/towers/resolve
 *   { "geometries": [{ "type": "Polygon", "coordinates": [[[lng,lat],...]] }] }
 */
export function createTowerDebugRoutes(resolver: TowerResolver): Router {
  const router = Router();

  router.post('/towers/resolve', async (req: Request, res: Response) => {
    const body = req.body as Partial<GeoZone>;
    if (!Array.isArray(body.geometries) || body.geometries.length === 0) {
      res.status(400).json({ error: 'body.geometries must be a non-empty array' });
      return;
    }
    try {
      const alertId = `debug-${Date.now()}`;
      const towers = await resolver.resolveTowers(alertId, body as GeoZone);
      res.json({ count: towers.length, towers });
    } catch (err) {
      logger.error({ err }, 'debug.towers.resolve_failed');
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
