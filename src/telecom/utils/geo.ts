/**
 * Small geospatial primitives for the in-memory tower store.
 *
 * These mirror the semantics of the PostGIS radius coverage model so the sim
 * behaves like the real database:
 *
 *   - a tower is "in the zone" when its point is inside the zone polygon, OR
 *   - its coverage circle (point, coverageRadiusM) overlaps the zone geometry
 *     (point-in-polygon OR distance from the point to any zone edge ≤ radius).
 *
 * Accuracy is local/regional (equirectangular + haversine), which is all the
 * sim needs; the real path always runs through PostGIS.
 */

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance between two WGS84 points, in metres. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Point-in-polygon (ray casting) on a ring of [lng, lat] vertices. */
export function pointInRing(lng: number, lat: number, ring: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Equirectangular distance from a point to a segment (a→b), in metres. */
export function pointSegmentDistanceM(lng: number, lat: number, a: [number, number], b: [number, number]): number {
  // Local planar projection (metres) around the query point.
  const x0 = lng;
  const y0 = lat;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const toX = (lng2: number) => (lng2 - x0) * EARTH_RADIUS_M * cosLat;
  const toY = (lat2: number) => (lat2 - y0) * EARTH_RADIUS_M;

  const ax = toX(a[0]);
  const ay = toY(a[1]);
  const bx = toX(b[0]);
  const by = toY(b[1]);
  const dx = bx - ax;
  const dy = by - ay;

  const t = dx * dx + dy * dy === 0 ? 0 : Math.max(0, Math.min(1, ((0 - ax) * dx + (0 - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

/** True when a coverage point (point + radius) intersects a polygon ring or its edge. */
export function pointWithinRadiusOfRing(lng: number, lat: number, radiusM: number, ring: readonly [number, number][]): boolean {
  if (pointInRing(lng, lat, ring)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (pointSegmentDistanceM(lng, lat, ring[i]!, ring[j]!) <= radiusM) return true;
  }
  return false;
}
