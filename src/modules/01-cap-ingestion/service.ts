import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import { traceStore } from '../../tracing/trace-store.js';
import type { CapAlert } from '../../types/cap.js';
import { getAlertLogger } from '../../utils/logger.js';
import { capAlertSchema } from './cap-schema.js';
import { capTiming, parseCapXml } from './cap-parser.js';

/**
 * CAP ingestion service — requirement #1.
 *
 * Receives raw CAP XML (from the push endpoint or the poller), parses it into
 * a validated CapAlert, persists it for the audit trail, and hands it to the
 * processing pipeline. Every stage is logged against a stable `alertId`.
 */

export interface IngestResult {
  alertId: string;
  capIdentifier: string;
  alert: CapAlert;
  expiresAt: string | null;
  duplicate: boolean;
}

/** Stable identifier for an alert across the whole audit trail. */
export function capIdentifierOf(alert: CapAlert): string {
  return `${alert.sender}:${alert.identifier}`;
}

export class CapIngestionService {
  /** Parse + validate a CAP XML document (pure, no side effects). */
  parse(xml: string): CapAlert {
    const cfg = loadConfig();
    const alert = parseCapXml(xml, { preferredLanguage: cfg.CAP_PREFERRED_LANGUAGE });
    return capAlertSchema.parse(alert) as CapAlert;
  }

  /**
   * Full ingest path: parse, validate, persist, audit.
   * Persistence is attempted only when DATABASE_URL is configured; until C-DOT
   * provides it, TURANT runs in audit-only mode (logged explicitly).
   */
  async ingest(xml: string): Promise<IngestResult> {
    // t0 — CAP XML received/ingested. Captured before parsing so the latency
    // clock starts the moment the document reaches TURANT.
    const t0 = Date.now();
    const cfg = loadConfig();
    const alert = this.parse(xml);

    const capIdentifier = capIdentifierOf(alert);
    await traceStore.mark(capIdentifier, 't0', 'cap.ingest', t0);
    const timing = capTiming(alert);
    const alertId = randomUUID();
    const log = getAlertLogger(alertId);
    log.info(
      {
        capIdentifier,
        event: alert.info.event,
        headline: alert.info.headline,
        severity: alert.info.severity,
        urgency: alert.info.urgency,
        areaCount: alert.info.areas.length,
        expiresAt: timing.expiresAt?.toISOString() ?? null,
      },
      'cap.ingest.parsed',
    );

    let duplicate = false;
    if (cfg.DATABASE_URL) {
      const result = await this.persist(alertId, capIdentifier, alert, timing.expiresAt);
      duplicate = result === 'duplicate';
    } else {
      log.warn('DATABASE_URL not configured; running in audit-only mode');
    }

    return { alertId, capIdentifier, alert, expiresAt: timing.expiresAt?.toISOString() ?? null, duplicate };
  }

  private async persist(
    alertId: string,
    capIdentifier: string,
    alert: CapAlert,
    expiresAt: Date | null,
  ): Promise<'inserted' | 'duplicate'> {
    const log = getAlertLogger(alertId);
    try {
      const pool = getPool();
      const inserted = await pool.query<{ inserted: boolean }>(
        `INSERT INTO alerts
           (id, cap_identifier, sender, sent_at, status, msg_type, scope,
            expires_at, effective_at, severity, urgency, headline, description,
            instruction, raw_xml, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (cap_identifier, sender) DO UPDATE SET received_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          alertId,
          capIdentifier,
          alert.sender,
          alert.sent,
          alert.status,
          alert.msgType,
          alert.scope,
          expiresAt,
          alert.info.effective ? new Date(alert.info.effective) : null,
          alert.info.severity,
          alert.info.urgency,
          alert.info.headline ?? null,
          alert.info.description ?? null,
          alert.info.instruction ?? null,
          alert.rawXml,
          JSON.stringify(alert),
        ],
      );
      const isDuplicate = !inserted.rows[0]?.inserted;
      log.info({ duplicate: isDuplicate }, 'cap.ingest.persisted');
      return isDuplicate ? 'duplicate' : 'inserted';
    } catch (err) {
      log.error({ err }, 'cap.ingest.persist_failed');
      throw err;
    }
  }
}
