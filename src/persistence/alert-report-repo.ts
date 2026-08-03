import { loadConfig, type ParsedEnvConfig } from '../config/env.js';
import type { AlertReport } from '../types/report.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

/**
 * `alert_reports` persistence — the DB fallback for module 12.
 *
 * When the EWS callback cannot be delivered over HTTP, the report is written to
 * the `alert_reports` table (schema: src/persistence/migrations/001_init.sql).
 * Like every persistence path, this fails loudly when DATABASE_URL is missing —
 * it never pretends to have stored a report it could not.
 */

export interface PersistAlertReportDeps {
  cfg?: ParsedEnvConfig;
  query?: (sql: string, params?: unknown[]) => Promise<unknown>;
}

async function defaultQuery(sql: string, params: unknown[]): Promise<unknown> {
  const { getPool } = await import('../persistence/pg-pool.js');
  return getPool().query(sql, params);
}

/** Insert a report into `alert_reports` (JSONB `payload` for the latency fields). */
export async function persistAlertReport(
  report: AlertReport,
  deps: PersistAlertReportDeps = {},
): Promise<void> {
  const cfg = deps.cfg ?? loadConfig();
  if (!cfg.DATABASE_URL) {
    throw new Error('DATABASE_URL not configured — cannot persist alert report. Awaiting C-DOT DB credentials.');
  }

  const query = deps.query ?? defaultQuery;
  await query(
    `INSERT INTO alert_reports (cap_identifier, alert_id, payload, created_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (cap_identifier) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
    [report.capIdentifier, report.alertId, JSON.stringify(report)],
  );
  logger.info({ capIdentifier: report.capIdentifier }, 'alert_report.persisted');
}
