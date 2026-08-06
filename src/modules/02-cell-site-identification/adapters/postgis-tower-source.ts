import { loadConfig } from '../../../config/env.js';
import { getPool } from '../../../persistence/pg-pool.js';
import type { CellTower, GeoZone } from '../../../types/tower.js';
import { getLogger } from '../../../utils/logger.js';
import type { FindTowersOptions, TowerSource } from '../tower-source.js';
import { buildTowerZoneQuery } from './postgis-sql.js';

const logger = getLogger();

interface TowerRow {
  id: string;
  cell_id: string;
  latitude: number;
  longitude: number;
  coverage_radius_m: number | null;
  coverage_geom: string | null;
}

/**
 * PostGIS tower source — requirement #2.
 *
 * Identifies towers whose coverage falls inside the alert zone using real
 * geospatial queries against the C-DOT database:
 *
 *   radius  coverage : ST_Intersects(point, zone)  — indexed point-in-polygon
 *                      OR ST_DWithin(geography)   — coverage circle overlaps zone
 *   polygon coverage : ST_Intersects(coverage_geom, zone) — indexed on GIST
 *
 * The zone geometry is built from the CAP polygons/circles and unioned in one
 * query. `statement_timeout` is set on the dedicated client so the DB itself
 * enforces the time budget ("seconds, not minutes").
 */
export class PostgisTowerSource implements TowerSource {
  readonly name = 'postgis';

  async findTowersInZone(zone: GeoZone, options: FindTowersOptions = {}): Promise<CellTower[]> {
    const cfg = loadConfig();
    const limit = options.limit ?? cfg.TOWER_MATCH_LIMIT;

    const pool = getPool();
    const client = await pool.connect();
    try {
      // DB-side enforcement of the cell-site time budget (requirement #2).
      // BEGIN + SET LOCAL so the timeout genuinely bounds the lookup below
      // (SET LOCAL is a no-op outside an explicit transaction block).
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${cfg.TOWER_MATCH_TIME_BUDGET_MS}`);
      const { text, values } = buildTowerZoneQuery(cfg, zone, limit);
      const started = performance.now();
      const result = await client.query<TowerRow>(text, values);
      await client.query('COMMIT');
      const elapsedMs = performance.now() - started;
      logger.info({ rowCount: result.rowCount, elapsedMs }, 'cell.match.postgis.query');
      return result.rows.map((r) => this.toTower(r));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private toTower(r: TowerRow): CellTower {
    return {
      id: r.id,
      cellId: r.cell_id,
      latitude: r.latitude,
      longitude: r.longitude,
      coverageRadiusM: r.coverage_radius_m ?? undefined,
      coverageGeoJson: r.coverage_geom ? JSON.parse(r.coverage_geom) : undefined,
    };
  }
}
