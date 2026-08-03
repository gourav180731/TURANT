import type { CapCoordinate, CapGeometry } from '../types/cap.js';
import type { GeoZone } from '../types/tower.js';

/**
 * CAP geometry helpers.
 *
 * CAP <polygon> coordinates are space-separated "lat,lng" vertex pairs in
 * decimal degrees (WGS84). GeoJSON/PostGIS order is (lon,lat). All conversion
 * here is pure and unit-tested so the SQL adapters never misinterpret axes.
 */

/** Parse a single CAP coordinate token "lat,lng". */
export function parseCapCoordinate(token: string): CapCoordinate {
  const [latRaw, lngRaw] = token.trim().split(',');
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid CAP coordinate token: "${token}"`);
  }
  return { lat, lng };
}

/** Convert CAP polygon vertices (lat,lng) to GeoJSON ring coordinates (lng,lat). */
export function capRingToGeoJson(ring: CapCoordinate[]): number[][] {
  return ring.map(({ lat, lng }) => [lng, lat]);
}

/** Convert a CAP geometry into GeoJSON (polygons) or a centre+radius pair. */
export function capGeometryToGeoJson(geometry: CapGeometry):
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'Circle'; center: [number, number]; radiusMeters: number } {
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(capRingToGeoJson) };
  }
  return { type: 'Circle', center: [geometry.center.lng, geometry.center.lat], radiusMeters: geometry.radiusMeters };
}

/** True when the geometry forms a valid (closed) CAP polygon. */
export function isClosedRing(ring: CapCoordinate[]): boolean {
  if (ring.length < 4) return false;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first.lat === last.lat && first.lng === last.lng;
}

/**
 * Convert a CAP alert's geometries (`alert.info.areas[].geometries`) into the
 * `GeoZone` shape consumed by `TowerResolver`/`TowerSource` (module 02). Reuses
 * the CAP lat,lng → GeoJSON lng,lat ring conversion so the axis order is
 * defined in exactly one place.
 */
export function capZoneToGeoZone(geometries: readonly CapGeometry[]): GeoZone {
  return {
    geometries: geometries.map((g) => {
      if (g.type === 'Polygon') {
        return { type: 'Polygon', coordinates: g.coordinates.map(capRingToGeoJson) };
      }
      return { type: 'Circle', center: g.center, radiusMeters: g.radiusMeters };
    }),
  };
}
