/**
 * Sim city-cluster hints.
 *
 *   GET /api/v1/sim/clusters
 *
 * Returns the configured region's city clusters (centroid + radius km) so the
 * polygonal-alert frontend can draw the faint city hints on the map. For the
 * 'india' SIM_REGION this is the full 18-cluster list; for 'delhi-ncr' it is
 * just the Delhi NCR cluster. Derived entirely from the shared
 * india-city-clusters.ts data file.
 */

import { Router, type Request, type Response } from 'express';
import {
  INDIA_CITY_CLUSTERS,
  type CityCluster,
} from './generators/india-city-clusters.js';

export function createSimClustersRoute(region: string): Router {
  const router = Router();

  router.get('/sim/clusters', (_req: Request, res: Response) => {
    const clusters: CityCluster[] =
      region === 'india'
        ? Array.from(INDIA_CITY_CLUSTERS)
        : Array.from(INDIA_CITY_CLUSTERS).filter((c) => c.id === 'delhi-ncr');

    res.json({
      region,
      count: clusters.length,
      clusters: clusters.map((c) => ({
        id: c.id,
        name: c.name,
        region: c.region,
        latitude: c.latitude,
        longitude: c.longitude,
        radiusKm: c.radiusKm,
        weight: c.weight,
      })),
    });
  });

  return router;
}