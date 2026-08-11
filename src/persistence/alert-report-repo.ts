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

/** Insert a report into `alert_reports` (schema in 001_init.sql). */
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
    `INSERT INTO alert_reports (
       alert_id, cap_identifier, processing_started_at, processing_ended_at,
       targeted_subscribers, sms_submitted, sms_accepted, delivered, failed,
       expired, successful_push, tower_count, completed, report_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     ON CONFLICT (alert_id) DO UPDATE SET
       cap_identifier = EXCLUDED.cap_identifier,
       processing_started_at = EXCLUDED.processing_started_at,
       processing_ended_at = EXCLUDED.processing_ended_at,
       targeted_subscribers = EXCLUDED.targeted_subscribers,
       sms_submitted = EXCLUDED.sms_submitted,
       sms_accepted = EXCLUDED.sms_accepted,
       delivered = EXCLUDED.delivered,
       failed = EXCLUDED.failed,
       expired = EXCLUDED.expired,
       successful_push = EXCLUDED.successful_push,
       tower_count = EXCLUDED.tower_count,
       completed = EXCLUDED.completed,
       report_json = EXCLUDED.report_json`,
    [
      report.alertId,
      report.capIdentifier,
      report.processingStartedAt,
      report.processingEndedAt,
      report.targetedSubscriberCount,
      report.smsSubmittedCount,
      report.smsAcceptedCount,
      report.deliveredCount,
      report.failedCount,
      report.expiredMessageCount,
      report.successfulPushCount,
      report.towerCount,
      report.completed,
      JSON.stringify(report),
    ],
  );
  logger.info({ capIdentifier: report.capIdentifier }, 'alert_report.persisted');
}
