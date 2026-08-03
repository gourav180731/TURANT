import express, { Router, type Request, type Response } from 'express';
import { loadConfig } from '../../config/env.js';
import { CapParseError } from './cap-parser.js';
import { CapIngestionService } from './service.js';

/**
 * CAP ingestion HTTP endpoint (push mode) — requirement #1.
 *
 *   POST /api/v1/alerts/cap
 *   Content-Type: application/xml (or text/xml)
 *   Body: raw CAP XML (ITU-T X.1303 / CAP 1.2)
 *
 *   Responses:
 *     202 Accepted  -> { alertId, capIdentifier, expiresAt, duplicate }
 *     400           -> malformed XML / non-conforming CAP
 *     413           -> body exceeds CAP_MAX_XML_BYTES
 */

export function createCapIngestionRoutes(service: CapIngestionService): Router {
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
      res.status(202).json({
        alertId: result.alertId,
        capIdentifier: result.capIdentifier,
        expiresAt: result.expiresAt,
        duplicate: result.duplicate,
        status: 'accepted',
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
