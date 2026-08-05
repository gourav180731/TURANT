import express, { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { loadConfig } from '../../config/env.js';
import type { CapIngestionService, IngestResult } from './service.js';
import { buildManualCapXml, manualAlertSchema, MANUAL_SENDER, validatePolygonRing } from './manual-alert.js';

/**
 * Manual alert ingestion endpoint + auto pipeline trigger.
 *
 *   POST /api/v1/alerts/manual
 *   Content-Type: application/json
 *   Body: { polygon: [[lat,lng],...], message, severity, expiresInMinutes, hazardType? }
 *
 * Validates the JSON with zod, rejects invalid/self-intersecting polygons with
 * a clear 400, synthesizes a real CAP 1.2 document through
 * `manual-alert.buildManualCapXml`, splices it through the *same*
 * `CapIngestionService.ingest()` the CAP-XML route uses, then fires the same
 * `onIngested` hook so the existing `alert-pipeline.ts` orchestrator runs
 * exactly as it does for the XML path — no duplicated pipeline logic.
 */
export interface ManualAlertRouteOptions {
  onIngested?: (result: IngestResult) => void;
}

export function createManualAlertRoutes(service: CapIngestionService, options: ManualAlertRouteOptions = {}): Router {
  const router = Router();
  const cfg = loadConfig();

  const jsonBody = express.json({ limit: cfg.CAP_MAX_XML_BYTES });

  router.post('/alerts/manual', jsonBody, async (req: Request, res: Response) => {
    let payload;
    try {
      payload = manualAlertSchema.parse(req.body ?? {});
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'invalid manual alert payload',
          issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return;
      }
      res.status(400).json({ error: 'request body must be a JSON object' });
      return;
    }

    const polygon = validatePolygonRing(payload.polygon);
    if (!polygon.ok) {
      res.status(400).json({ error: polygon.error });
      return;
    }

    const cap = buildManualCapXml(payload, polygon.closed);
    try {
      const result = await service.ingest(cap.xml);
      // Same asynchronous pipeline trigger as the CAP-XML route.
      if (options.onIngested) {
        options.onIngested(result);
      }
      res.status(202).json({
        alertId: result.alertId,
        capIdentifier: result.capIdentifier,
        expiresAt: result.expiresAt,
        duplicate: result.duplicate,
        status: 'accepted',
        source: 'manual',
        sender: MANUAL_SENDER,
        pipeline: {
          status: 'running',
          stage: 'ingested',
          statusUrl: `/api/v1/alerts/${encodeURIComponent(result.capIdentifier)}/pipeline-status`,
        },
      });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'invalid CAP document synthesized from payload' });
    }
  });

  return router;
}