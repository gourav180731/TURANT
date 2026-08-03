import type { CellTower, GeoZone } from '../../types/tower.js';

/**
 * TowerSource contract — requirement #2.
 *
 * Any module needing "all cell towers whose coverage falls inside this alert
 * zone" talks to this interface. Two adapters ship with TURANT:
 *
 *   - PostgisTowerSource : direct SQL against the C-DOT PostGIS database
 *   - HttpTowerSource    : C-DOT API gateway (awaiting the endpoint contract)
 *
 * Selection is purely config-driven (TOWER_SOURCE_MODE) — no code changes when
 * the real tower database arrives.
 */
export interface FindTowersOptions {
  /** Max rows returned (safety cap; real zones will usually exceed this and it is configurable). */
  limit?: number;
  /** Cancel the query (translated to a DB-side statement_timeout / fetch abort). */
  signal?: AbortSignal;
  /** CAP alert identifier for the shared latency trace (t1 is marked on it). */
  traceKey?: string;
}

export interface TowerSource {
  /** Stable name for logs/audit, e.g. "postgis" | "http". */
  readonly name: string;
  findTowersInZone(zone: GeoZone, options?: FindTowersOptions): Promise<CellTower[]>;
}

/** Convert a CAP-derived zone into the union of its GeoJSON geometries. */
export function zoneToGeoJson(zone: GeoZone): unknown[] {
  return zone.geometries.map((g) => {
    if (g.type === 'Polygon') {
      return { type: 'Polygon', coordinates: g.coordinates };
    }
    return {
      type: 'Circle',
      center: [g.center!.lng, g.center!.lat],
      radiusMeters: g.radiusMeters,
    };
  });
}
