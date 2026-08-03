/**
 * Cell tower / site model as consumed by TURANT's geo-targeting pipeline.
 *
 * The physical source schema lives in the C-DOT tower database; TURANT maps it
 * into this normalized shape via configurable column names (TOWER_COL_*).
 */

/** How a tower's radio coverage footprint is represented in the source DB. */
export type TowerCoverageModel = 'radius' | 'polygon';

export interface CellTower {
  /** Primary key of the source table row. */
  id: string;
  /** Operator cell identifier (cell ID / site ID) used for subscriber join. */
  cellId: string;
  /** Tower location, WGS84. */
  latitude: number;
  longitude: number;
  /** Nominal coverage radius in metres (radius coverage model). */
  coverageRadiusM?: number;
  /** Raw coverage geometry (polygon model) as GeoJSON, if provided by source. */
  coverageGeoJson?: unknown;
}

/** Input zone handed to a TowerSource: one or more GeoJSON geometries. */
export interface GeoZone {
  geometries: { type: 'Polygon' | 'Circle'; coordinates?: number[][][]; center?: { lat: number; lng: number }; radiusMeters?: number }[];
  srid?: number;
}
