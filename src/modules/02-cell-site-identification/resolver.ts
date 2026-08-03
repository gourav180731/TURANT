import { loadConfig } from '../../config/env.js';
import { traceStore } from '../../tracing/trace-store.js';
import type { CellTower, GeoZone } from '../../types/tower.js';
import { getAlertLogger } from '../../utils/logger.js';
import { HttpTowerSource } from './adapters/http-tower-source.js';
import { PostgisTowerSource } from './adapters/postgis-tower-source.js';
import type { FindTowersOptions, TowerSource } from './tower-source.js';

const SOURCES: Record<string, () => TowerSource> = {
  postgis: () => new PostgisTowerSource(),
  http: () => new HttpTowerSource(),
};

/**
 * Cell site identification resolver — requirement #2.
 *
 * Selects the TowerSource by config (TOWER_SOURCE_MODE), enforces the time
 * budget, and records the result in the alert's audit trail. The budget is
 * enforced twice: DB-side (statement_timeout in the PostGIS adapter) and
 * client-side here (Promise.race), so a slow match can never block an alert.
 */
export class TowerResolver {
  async resolveTowers(alertId: string, zone: GeoZone, options: FindTowersOptions = {}): Promise<CellTower[]> {
    const cfg = loadConfig();
    return this.resolveWithSource(this.getSource(cfg.TOWER_SOURCE_MODE), alertId, zone, options);
  }

  /** Same flow with an explicit source — used by tests to inject a stub. */
  async resolveWithSource(source: TowerSource, alertId: string, zone: GeoZone, options: FindTowersOptions = {}): Promise<CellTower[]> {
    const cfg = loadConfig();
    const log = getAlertLogger(alertId);

    const budgetMs = cfg.TOWER_MATCH_TIME_BUDGET_MS;

    log.info(
      { source: source.name, geometryCount: zone.geometries.length, budgetMs },
      'cell.match.start',
    );

    const started = performance.now();
    const controller = new AbortController();
    const budgetTimer = setTimeout(() => controller.abort(), budgetMs);

    let towers: CellTower[];
    try {
      towers = await Promise.race([
        source.findTowersInZone(zone, { ...options, signal: controller.signal }),
        new Promise<CellTower[]>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`Cell-site match exceeded time budget of ${budgetMs}ms`)),
          );
        }),
      ]);
    } finally {
      clearTimeout(budgetTimer);
    }

    const elapsedMs = performance.now() - started;
    if (elapsedMs > budgetMs) {
      log.warn({ elapsedMs, budgetMs }, 'cell.match.budget_exceeded');
    }
    log.info({ towers: towers.length, elapsedMs }, 'cell.match.completed');

    // t1 — cell site identification complete (shared latency trace).
    await traceStore.mark(options.traceKey ?? alertId, 't1', 'cell.match', Date.now());
    return towers;
  }

  getSource(mode: string): TowerSource {
    const factory = SOURCES[mode];
    if (!factory) throw new Error(`Unknown TOWER_SOURCE_MODE "${mode}" (expected postgis|http)`);
    return factory();
  }
}
