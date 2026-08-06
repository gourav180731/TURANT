import type { ParsedEnvConfig } from '../../config/env.js';
import type { GeoZone } from '../../types/tower.js';

/**
 * Pure SQL builder for the real C-DOT subscriber dump lookup (requirement #4).
 *
 * Unlike the sim's `findByCellIds` (which joins a synthetic `subscribers`
 * table on `cell_id`), this matches subscribers directly against the dump's
 * geometry column with point-in-polygon. The zone geometry is built exactly
 * like `buildTowerZoneQuery` (polygons via ST_GeomFromGeoJSON, circles via
 * ST_Buffer) so the same drawn polygon that resolved towers also selects the
 * subscribers — no cell_id / lac / cisac bridge needed.
 *
 * The `geom` column (POINT, 4326) added by migration 004 is backed by the
 * GiST index `idx_subscriber_dump_geom`, so the ST_Intersects predicate is
 * index-accelerated.
 */
export function buildSubscriberDumpZoneQuery(
  cfg: ParsedEnvConfig,
  zone: GeoZone,
  limit: number,
): { text: string; values: unknown[] } {
  const srid = zone.srid ?? cfg.TOWER_GEOM_SRID;
  const tbl = cfg.SUBSCRIBER_DUMP_TABLE;
  const colMsisdn = cfg.SUBSCRIBER_DUMP_MSISDN_COL;
  const colGeom = cfg.SUBSCRIBER_DUMP_GEOM_COL;

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

  const text = `
    WITH zone_geom AS (
      SELECT ST_Union(g.geom) AS geom
      FROM (VALUES ${zoneGeoms.map((g) => `(${g})`).join(', ')}) AS g(geom)
    )
    SELECT DISTINCT ${colMsisdn} AS msisdn
    FROM ${tbl} s, zone_geom z
    WHERE z.geom IS NOT NULL
      AND s.${colGeom} IS NOT NULL
      AND ST_Intersects(s.${colGeom}, z.geom)
    LIMIT ${limit};
  `;

  return { text, values };
}
