import type { ParsedEnvConfig } from '../../../config/env.js';
import type { GeoZone } from '../../../types/tower.js';

/**
 * Pure SQL builder for the PostGIS tower query (requirement #2).
 *
 * Kept separate from the adapter so the generated SQL can be unit-tested
 * without a live database. See the adapter for the coverage-matching rules.
 */
export function buildTowerZoneQuery(cfg: ParsedEnvConfig, zone: GeoZone, limit: number): { text: string; values: unknown[] } {
  const srid = zone.srid ?? cfg.TOWER_GEOM_SRID;
  const tbl = cfg.TOWER_TABLE;
  const colId = cfg.TOWER_COL_ID;
  const colCell = cfg.TOWER_COL_CELL_ID;
  const colLat = cfg.TOWER_COL_LAT;
  const colLng = cfg.TOWER_COL_LNG;
  const colRadius = cfg.TOWER_COL_COVERAGE_RADIUS_M;
  const colGeom = cfg.TOWER_COL_COVERAGE_GEOM;
  const radiusModel = cfg.TOWER_COVERAGE_MODEL === 'radius';

  const pointExpr = `ST_SetSRID(ST_MakePoint(${colLng}, ${colLat}), ${srid})`;
  const zoneGeoms: string[] = [];
  const values: unknown[] = [];

  for (const g of zone.geometries) {
    if (g.type === 'Polygon') {
      values.push(JSON.stringify({ type: 'Polygon', coordinates: g.coordinates }));
      zoneGeoms.push(`ST_SetSRID(ST_GeomFromGeoJSON($${values.length}), ${srid})`);
    } else {
      values.push(g.center!.lng, g.center!.lat, g.radiusMeters!);
      const lng = `$${values.length - 2}`;
      const lat = `$${values.length - 1}`;
      const radius = `$${values.length}`;
      zoneGeoms.push(`ST_Buffer(ST_SetSRID(ST_MakePoint(${lng}, ${lat}), ${srid})::geography, ${radius})::geometry`);
    }
  }

  if (zoneGeoms.length === 0) {
    throw new Error('GeoZone has no geometries');
  }

  const coverageMatch = radiusModel
    ? `(ST_DWithin((${pointExpr})::geography, zone_geom::geography, ${colRadius}))`
    : `(ST_Intersects(${colGeom}, zone_geom))`;

  const selectCoverage = radiusModel
    ? `${colRadius} AS coverage_radius_m, NULL AS coverage_geom`
    : `NULL AS coverage_radius_m, ST_AsGeoJSON(${colGeom}) AS coverage_geom`;

  const text = `
    WITH zone_geom AS (
      SELECT ST_Union(g.geom) AS geom
      FROM (VALUES ${zoneGeoms.map((g) => `(${g})`).join(', ')}) AS g(geom)
    )
    SELECT ${colId} AS id, ${colCell} AS cell_id, ${colLat} AS latitude, ${colLng} AS longitude,
           ${selectCoverage}
    FROM ${tbl} t, zone_geom z
    WHERE z.geom IS NOT NULL
      AND (ST_Intersects(${pointExpr}, z.geom)
           OR ${coverageMatch})
    LIMIT ${limit};
  `;

  return { text, values };
}
