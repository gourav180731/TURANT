import { Router, type Request, type Response } from 'express';
import { getLogger } from '../../utils/logger.js';
import type { DlrListener } from './dlr-listener.js';
import { buildDeliveryReport } from './dlr-reporter.js';

const logger = getLogger();

/**
 * DLR reporting endpoints (module 11).
 *
 *   GET /api/v1/alerts/:capIdentifier/report   — delivery report (counts + latency)
 *
 * Complements the latency dashboard: counts come from real DLR receipts, not
 * from submit outcomes.
 */
export function createDlrRoutes(listener: DlrListener): Router {
  const router = Router();

  router.get('/alerts/:capIdentifier/report', async (req: Request, res: Response) => {
    const raw = req.params.capIdentifier;
    const capIdentifier = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
    if (!capIdentifier) {
      res.status(400).json({ error: 'capIdentifier is required' });
      return;
    }
    try {
      const report = await buildDeliveryReport(capIdentifier, { listener });
      res.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ capIdentifier, err: message }, 'dlr.report_failed');
      res.status(500).json({ error: message });
    }
  });

  return router;
}
