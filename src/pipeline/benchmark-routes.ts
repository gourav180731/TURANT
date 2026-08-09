import express, { Router, type Request, type Response } from 'express';
import { loadConfig } from '../config/env.js';
import { CellSubscriberBridgeMatcher } from '../telecom/matcher/cell-subscriber-bridge-matcher.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

/**
 * 50,000-cell benchmark endpoint (Phase 7/5/13 acceptance harness).
 *
 *   POST /api/v1/benchmark/subscribers/lookup
 *   Body: { "cellIds": ["10000","10001", ...] }   (up to 50,000)
 *
 * Validates + dedupes the input, then runs the identical relational bridge the
 * production pipeline uses: stage temp table → cell→(lac,cisac) mapping →
 * (lac,cisaco) indexed join into the 100M subscriber_dump → DISTINCT msisdn.
 * Returns real statistics, never materialising the recipient list in Node.
 *
 * This is the acceptance harness for Test A (100) / B (1k) / C (10k) / D (50k).
 */
export function createSubscriberBenchmarkRoutes(
  matcher: CellSubscriberBridgeMatcher = new CellSubscriberBridgeMatcher(loadConfig()),
): Router {
  const router = Router();
  const jsonBody = express.json({ limit: '2mb' });
  const MAX_CELLS = 50_000;

  router.post('/benchmark/subscriber-match', jsonBody, async (req: Request, res: Response) => {
    const raw: unknown = req.body?.cellIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      res.status(400).json({ error: 'cellIds must be a non-empty array of cell identifiers' });
      return;
    }
    const cellIds = raw
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .slice(0, MAX_CELLS);
    if (cellIds.length === 0) {
      res.status(400).json({ error: 'cellIds must contain at least one non-empty string' });
      return;
    }

    const started = performance.now();
    try {
      const result = await matcher.matchCells(cellIds, {
        alertId: `benchmark-${Date.now()}`,
      });
      logger.info({ ...result, resultElapsedMs: Math.round(performance.now() - started) }, 'benchmark.subscriber.lookup');
      res.status(200).json({
        targetCellCount: result.targetCellCount,
        resolvedCellCount: result.resolvedCellCount,
        unresolvedCellCount: result.unresolvedCellCount,
        subscriberMatchCount: result.subscriberMatchCount,
        uniqueMsisdnCount: result.uniqueMsisdnCount,
        elapsedMs: result.elapsedMs,
        mappingIncomplete: result.mappingIncomplete,
        status: 'completed',
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'subscriber lookup failed',
        status: 'failed',
      });
    }
  });

  return router;
}