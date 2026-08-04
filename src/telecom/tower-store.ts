import type { CellTower, GeoZone } from '../types/tower.js';
import type { TelecomCellTower } from './entities/cell-tower.js';
import { haversineMeters, pointWithinRadiusOfRing } from './utils/geo.js';

/**
 * In-memory tower store for the telecom simulation.
 *
 * Module 02's resolver reads this when TOWER_SOURCE_MODE=memory (the default
 * when USE_DUMMY_SUBSCRIBER_DB=true and SUBSCRIBER_DB_MODE=memory). Matching
 * implements the same semantics as the PostGIS radius model — a tower is in the
 * zone when its coverage circle overlaps the zone geometry — so an alert
 * resolves the same set of towers it would against the seeded Postgres table.
 */
export class InMemoryTowerStore {
  private towers: TelecomCellTower[] = [];

  /** Replace the whole store (memory mode only; idempotent reseeds). */
  replace(towers: readonly TelecomCellTower[]): void {
    this.towers = towers.slice();
  }

  get size(): number {
    return this.towers.length;
  }

  all(): readonly TelecomCellTower[] {
    return this.towers;
  }

  findTowersInZone(zone: GeoZone, limit = 100_000): CellTower[] {
    const out: CellTower[] = [];
    for (const tower of this.towers) {
      if (out.length >= limit) break;
      if (zoneMatches(tower, zone)) {
        out.push({
          id: tower.siteId,
          cellId: tower.cellId,
          latitude: tower.latitude,
          longitude: tower.longitude,
          coverageRadiusM: tower.coverageRadiusM,
        });
      }
    }
    return out;
  }
}

function zoneMatches(tower: TelecomCellTower, zone: GeoZone): boolean {
  const radius = tower.coverageRadiusM;
  for (const g of zone.geometries) {
    if (g.type === 'Circle') {
      const dist = haversineMeters(tower.latitude, tower.longitude, g.center!.lat, g.center!.lng);
      // Coverage circle overlaps the alert circle.
      if (dist - radius <= g.radiusMeters!) return true;
    } else if (g.type === 'Polygon' && g.coordinates) {
      // Holes would need a two-level test; CAP zones use simple rings in
      // practice, so the outer ring drives the overlap check.
      const outer = g.coordinates[0];
      if (outer && pointWithinRadiusOfRing(tower.longitude, tower.latitude, radius, outer as [number, number][])) {
        return true;
      }
    }
  }
  return false;
}

let store: InMemoryTowerStore | null = null;

/** Process-wide tower store singleton (memory mode). */
export function getTowerStore(): InMemoryTowerStore {
  if (!store) store = new InMemoryTowerStore();
  return store;
}
