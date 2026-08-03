import express, { type Request, type Response } from 'express';
import { loadConfig } from './config/env.js';
import { createLatencyRoutes } from './http/latency-routes.js';
import { createCapIngestionRoutes, CapIngestionService, CapDirectoryPoller } from './modules/01-cap-ingestion/index.js';
import { createTowerDebugRoutes } from './modules/02-cell-site-identification/debug-routes.js';
import { TowerResolver } from './modules/02-cell-site-identification/index.js';
import { DlrListener } from './modules/11-dlr/dlr-listener.js';
import { createDlrRoutes } from './modules/11-dlr/report-routes.js';
import { getSmppSession } from './modules/07-smpp-integration/smpp-session.js';
import { hasPool, pingPool } from './persistence/pg-pool.js';
import { hasRedis, pingRedis } from './persistence/redis-client.js';
import { traceStore } from './tracing/trace-store.js';
import { flushLogger, getLogger } from './utils/logger.js';

const cfg = loadConfig();
const logger = getLogger();

const app = express();
app.disable('x-powered-by');

app.get('/healthz', async (_req: Request, res: Response) => {
  const db = cfg.DATABASE_URL ? await pingPool() : { ok: true, detail: 'not_configured' };
  const redis = cfg.REDIS_URL ? await pingRedis() : { ok: true, detail: 'not_configured' };
  const smpp = cfg.SMPP_HOST ? { ok: true, detail: 'configured' } : { ok: true, detail: 'awaiting_credentials' };

  const healthy = db.ok && redis.ok && smpp.ok;
  res.status(healthy ? 200 : 503).json({
    app: cfg.APP_NAME,
    status: healthy ? 'healthy' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    db: db.ok ? 'ok' : db.detail,
    redis: redis.ok ? 'ok' : redis.detail,
    smpp: smpp.detail,
  });
});

const ingestionService = new CapIngestionService();
app.use('/api/v1', createCapIngestionRoutes(ingestionService));

// Cross-cutting latency dashboard (per-alert t0..t5 + delivery percentiles).
app.use('/api/v1', createLatencyRoutes(traceStore));

// DLR reporting (per-alert delivery report from real receipts).
const dlrListener = new DlrListener();
app.use('/api/v1', createDlrRoutes(dlrListener));

// Wire the DLR listener onto the shared SMPP session when credentials exist.
if (cfg.SMPP_HOST && cfg.SMPP_SYSTEM_ID) {
  getSmppSession(cfg)
    .connect()
    .then(() => dlrListener.attachTo(getSmppSession(cfg)))
    .catch((err) => logger.warn({ err }, 'smpp.connect_deferred'));
}

if (cfg.ENABLE_DEBUG_ENDPOINTS) {
  app.use('/api/v1/debug', createTowerDebugRoutes(new TowerResolver()));
  logger.warn('DEBUG endpoints enabled — intended for C-DOT staging only');
}

const poller = new CapDirectoryPoller(ingestionService);
poller.start();

const server = app.listen(cfg.PORT, () => {
  logger.info({ port: cfg.PORT, mode: cfg.TOWER_SOURCE_MODE }, 'turant.started');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'turant.shutting_down');
  poller.stop();
  server.close();
  await flushLogger();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app };
