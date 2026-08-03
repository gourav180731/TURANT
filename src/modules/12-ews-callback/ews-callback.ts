import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import type { AlertReport } from '../../types/report.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

/**
 * EWS origin callback — requirement #12.
 *
 * After the pipeline finishes an alert, POST the real AlertReport back to the
 * originating EWS (EARTHQUAKE_WARNING_SYSTEM / EWS_CALLBACK_URL). Counts are
 * produced by real pipeline stages, and `latencyMs` is drawn from the shared
 * latency trace so the EWS sees speed, not just volume.
 *
 * When no URL is configured this reports loudly and falls back to the
 * `alert_reports` table (schema in 001_init.sql) so the report is never lost
 * silently.
 */

export interface EwsCallbackResult {
  ok: boolean;
  delivered: 'http' | 'db-fallback' | 'not-configured';
  statusCode?: number;
  error?: string;
}

export interface EwsCallbackDeps {
  cfg?: ParsedEnvConfig;
  fetch?: typeof fetch;
  persistReport?: (report: AlertReport) => Promise<void>;
}

/** POST the report to the configured EWS URL with token + timeout. */
export async function pushReportToEws(
  report: AlertReport,
  deps: EwsCallbackDeps = {},
): Promise<EwsCallbackResult> {
  const cfg = deps.cfg ?? loadConfig();
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  if (!cfg.EWS_CALLBACK_URL) {
    logger.warn({ alertId: report.alertId }, 'ews_callback.not_configured');
    if (deps.persistReport) {
      await deps.persistReport(report);
      return { ok: true, delivered: 'db-fallback' };
    }
    return { ok: false, delivered: 'not-configured' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.EWS_CALLBACK_TIMEOUT_MS);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.EWS_CALLBACK_TOKEN) headers.Authorization = `Bearer ${cfg.EWS_CALLBACK_TOKEN}`;

    const response = await fetchImpl(cfg.EWS_CALLBACK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(report),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const ok = response.ok;
    if (!ok) {
      logger.error({ alertId: report.alertId, status: response.status }, 'ews_callback.rejected');
      return { ok: false, delivered: 'http', statusCode: response.status };
    }
    logger.info({ alertId: report.alertId, status: response.status }, 'ews_callback.delivered');
    return { ok: true, delivered: 'http', statusCode: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ alertId: report.alertId, err: message }, 'ews_callback.http_failed');
    if (deps.persistReport) {
      await deps.persistReport(report);
      return { ok: true, delivered: 'db-fallback', error: message };
    }
    return { ok: false, delivered: 'http', error: message };
  }
}

/** Derive the latencyMs section of a report from the shared trace store. */
export async function latencySectionForReport(capIdentifier: string): Promise<AlertReport['latencyMs']> {
  const { traceStore } = await import('../../tracing/trace-store.js');
  const trace = await traceStore.snapshot(capIdentifier);
  if (!trace || !trace.points.t0) return undefined;
  const p = trace.percentiles;
  return {
    t0ToFirstDeliveryMs: p?.firstDeliveryMs ?? undefined,
    t0ToP50Ms: p?.p50Ms ?? undefined,
    t0ToP90Ms: p?.p90Ms ?? undefined,
    t0ToP100Ms: p?.p100Ms ?? undefined,
  };
}
