import pino from 'pino';
import { loadConfig } from '../config/env.js';

type Logger = pino.Logger;

let root: Logger | null = null;

/**
 * Structured JSON logger used across TURANT.
 *
 * Every stage (ingest, cell-site match, dedup, submission, DLR, EWS callback)
 * logs through here with `alertId` bound in a child logger so the full audit
 * trail of a single alert can be reconstructed end to end.
 */
export function getLogger(): Logger {
  if (root) return root;

  const cfg = loadConfig();
  const options: pino.LoggerOptions = {
    name: cfg.APP_NAME,
    level: cfg.LOG_LEVEL,
    base: { app: cfg.APP_NAME, env: cfg.NODE_ENV },
  };

  if (cfg.LOG_PRETTY) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    };
  }

  root = cfg.AUDIT_LOG_FILE
    ? pino(options, pino.destination({ dest: cfg.AUDIT_LOG_FILE, append: true, mkdir: true }))
    : pino(options);
  return root;
}

/** Root logger with an alert-id context bound for traceability. */
export function getAlertLogger(alertId: string): Logger {
  return getLogger().child({ alertId });
}

/** Flush buffered audit lines (useful on shutdown). */
export function flushLogger(): Promise<void> {
  if (!root) return Promise.resolve();
  return new Promise((resolve, reject) => {
    root!.flush((err) => (err ? reject(err) : resolve()));
  });
}
