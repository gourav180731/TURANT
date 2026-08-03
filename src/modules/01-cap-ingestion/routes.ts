import express, { Router, type Request, type Response } from 'express';
import { loadConfig } from '../../config/env.js';
import { CapParseError } from './cap-parser.js';
import { CapIngestionService, type IngestResult } from './service.js';

/**
 * CAP ingestion HTTP endpoint (push mode) — requirement #1.
 *
 *   POST /api/v1/alerts/cap
 *   Content-Type: application/xml (or text/xml)
 *   Body: raw CAP XML (ITU-T X.1303 / CAP 1.2)
 *
 *   Responses:
 *     202 Accepted  -> { alertId, capIdentifier, expiresAt, duplicate, pipeline }
 *     400           -> malformed XML / non-conforming CAP
 *     413           -> body exceeds CAP_MAX_XML_BYTES
 *
 * After a successful ingest the optional `onIngested` hook fires (fire-and-
 * forget) so the automatic end-to-end pipeline can run asynchronously without
 * delaying the 202. The response carries a pipeline reference; the detailed
 * halt/progress status is available at the pipeline-status endpoint.
 */
export interface CapIngestionRouteOptions {
  onIngested?: (result: IngestResult) => void;
}

export function createCapIngestionRoutes(service: CapIngestionService, options: CapIngestionRouteOptions = {}): Router {
  const router = Router();
  const cfg = loadConfig();

  const rawBody = express.text({
    type: () => true,
    limit: cfg.CAP_MAX_XML_BYTES,
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as unknown as { rawXmlLength?: number }).rawXmlLength = buf.length;
    },
  });

  router.post('/alerts/cap', rawBody, async (req: Request, res: Response) => {
    const xml = typeof req.body === 'string' ? req.body : '';
    if (!xml.trim()) {
      res.status(400).json({ error: 'empty CAP XML body' });
      return;
    }
    try {
      const result = await service.ingest(xml);
      if (options.onIngested) {
        options.onIngested(result);
      }
      res.status(202).json({
        alertId: result.alertId,
        capIdentifier: result.capIdentifier,
        expiresAt: result.expiresAt,
        duplicate: result.duplicate,
        status: 'accepted',
        pipeline: {
          status: 'running',
          stage: 'ingested',
          statusUrl: `/api/v1/alerts/${encodeURIComponent(result.capIdentifier)}/pipeline-status`,
        },
      });
    } catch (err) {
      if (err instanceof CapParseError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(422).json({ error: err instanceof Error ? err.message : 'invalid CAP document' });
    }
  });

  return router;
}
