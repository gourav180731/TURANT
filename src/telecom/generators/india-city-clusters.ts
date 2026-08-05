/**
 * Pan-India city clusters for the synthetic telecom network.
 *
 * The simulator clusters towers/subscribers around Indian cities. This single,
 * config-driven data file is the only place the list lives — add or resize a
 * city here and the generator, the master seeder, and the frontend's faint
 * city-hint circles all follow, because they derive from this same array.
 *
 * Each entry carries a real city centroid, a geographic `radiusKm` (bigger
 * metros = wider spread) and a relative `weight` (population-relative site
 * density — bigger cities get proportionally more towers/subscribers). The
 * generator turns radiusKm into a clamped Gaussian spatial σ per city.
 */

import { DELHI_NCR_AREAS, type RegionArea } from './geography.js';

export interface CityCluster {
  /** Stable machine key (also the tower `clusterKey`) used for grouping. */
  id: string;
  /** Human-friendly display name (used for the frontend hint and zone label). */
  name: string;
  /** North / West / South / East / Central — coarse grouping only. */
  region: string;
  /** Primary state for C-DOT `state_id` / `service_area` mapping. */
  state: string;
  latitude: number;
  longitude: number;
  /** Urban spread in km — larger metros are wider. */
  radiusKm: number;
  /** Population-relative site density (bigger = more towers/subscribers). */
  weight: number;
  pinCode: string;
}

const kmPerDegLat = 111.32;
/** Convert a km radius to an angular (lat-direction) radius in degrees. */
function radiusDeg(km: number): number {
  return km / kmPerDegLat;
}

/**
 * The 18 seeded city clusters. Delhi NCR uses its district-rich sub-areas (the
 * same DELHI_NCR_AREAS list); every other city is a single weighted centroid.
 */
export const INDIA_CITY_CLUSTERS: readonly CityCluster[] = [
  // ---- North ----
  { id: 'delhi-ncr', name: 'Delhi NCR', region: 'North', state: 'DELHI', latitude: 28.6139, longitude: 77.209, radiusKm: 60, weight: 107, pinCode: '110001' },
  { id: 'jaipur', name: 'Jaipur', region: 'North', state: 'RAJASTHAN', latitude: 26.9124, longitude: 75.7873, radiusKm: 45, weight: 55, pinCode: '302001' },
  { id: 'lucknow', name: 'Lucknow', region: 'North', state: 'UTTAR PRADESH', latitude: 26.8467, longitude: 80.9462, radiusKm: 45, weight: 55, pinCode: '226001' },
  // ---- West ----
  { id: 'mumbai', name: 'Mumbai', region: 'West', state: 'MAHARASHTRA', latitude: 19.076, longitude: 72.8777, radiusKm: 60, weight: 95, pinCode: '400001' },
  { id: 'pune', name: 'Pune', region: 'West', state: 'MAHARASHTRA', latitude: 18.5204, longitude: 73.8567, radiusKm: 50, weight: 60, pinCode: '411001' },
  { id: 'ahmedabad', name: 'Ahmedabad', region: 'West', state: 'GUJARAT', latitude: 23.0225, longitude: 72.5714, radiusKm: 45, weight: 55, pinCode: '380001' },
  { id: 'surat', name: 'Surat', region: 'West', state: 'GUJARAT', latitude: 21.1702, longitude: 72.8311, radiusKm: 35, weight: 38, pinCode: '395003' },
  // ---- South ----
  { id: 'bangalore', name: 'Bangalore', region: 'South', state: 'KARNATAKA', latitude: 12.9716, longitude: 77.5946, radiusKm: 55, weight: 90, pinCode: '560001' },
  { id: 'chennai', name: 'Chennai', region: 'South', state: 'TAMIL NADU', latitude: 13.0827, longitude: 80.2707, radiusKm: 50, weight: 80, pinCode: '600001' },
  { id: 'hyderabad', name: 'Hyderabad', region: 'South', state: 'TELANGANA', latitude: 17.385, longitude: 78.4867, radiusKm: 50, weight: 75, pinCode: '500001' },
  { id: 'kochi', name: 'Kochi', region: 'South', state: 'KERALA', latitude: 9.9312, longitude: 76.2673, radiusKm: 30, weight: 20, pinCode: '682001' },
  // ---- East ----
  { id: 'kolkata', name: 'Kolkata', region: 'East', state: 'WEST BENGAL', latitude: 22.5726, longitude: 88.3639, radiusKm: 55, weight: 85, pinCode: '700001' },
  { id: 'patna', name: 'Patna', region: 'East', state: 'BIHAR', latitude: 25.5941, longitude: 85.1376, radiusKm: 40, weight: 48, pinCode: '800001' },
  { id: 'bhubaneswar', name: 'Bhubaneswar', region: 'East', state: 'ODISHA', latitude: 20.2961, longitude: 85.8245, radiusKm: 30, weight: 15, pinCode: '751001' },
  { id: 'guwahati', name: 'Guwahati', region: 'East', state: 'ASSAM', latitude: 26.1445, longitude: 91.7362, radiusKm: 30, weight: 15, pinCode: '781001' },
  // ---- Central ----
  { id: 'bhopal', name: 'Bhopal', region: 'Central', state: 'MADHYA PRADESH', latitude: 23.2599, longitude: 77.4126, radiusKm: 40, weight: 42, pinCode: '462001' },
  { id: 'indore', name: 'Indore', region: 'Central', state: 'MADHYA PRADESH', latitude: 22.7196, longitude: 75.8577, radiusKm: 35, weight: 30, pinCode: '452001' },
  { id: 'nagpur', name: 'Nagpur', region: 'Central', state: 'MAHARASHTRA', latitude: 21.1458, longitude: 79.0882, radiusKm: 40, weight: 42, pinCode: '440001' },
];

/** A resolved per-city clustering hotpsot (an area plus its spatial σ/clamp). */
export interface ClusterHotspot {
  area: RegionArea;
  sigmaDeg: number;
  clampDeg: number;
}

const DEFAULT_SIGMA_DEG = 0.028;
const DEFAULT_CLAMP_DEG = 0.06;

/** The Delhi NCR district sub-areas, kept as their own hotspots. */
function delhiDrclinHotspots(): ClusterHotspot[] {
  return DELHI_NCR_AREAS.map((a) => ({
    area: { ...a, clusterKey: 'delhi-ncr' },
    sigmaDeg: a.sigmaDeg ?? DEFAULT_SIGMA_DEG,
    clampDeg: a.clampDeg ?? DEFAULT_CLAMP_DEG,
  }));
}

/** A single weighted centroid hotspot for a non-Delhi city. */
function cityHotspot(c: CityCluster): ClusterHotspot {
  const rDeg = radiusDeg(c.radiusKm);
  return {
    area: {
      state: c.state,
      district: c.name.toUpperCase(),
      city: c.name.toUpperCase(),
      zone: c.name.toUpperCase(),
      pinCode: c.pinCode,
      latitude: c.latitude,
      longitude: c.longitude,
      weight: c.weight,
      clusterKey: c.id,
    },
    // σ ≈ 28% of the city's angular radius so most sites bunch near the centre
    // while the clamp at the full radius keeps every tower inside the city.
    sigmaDeg: rDeg * 0.28,
    clampDeg: rDeg,
  };
}

/** All hotspots for the pan-India region (Delhi + the other 17 cities). */
export const INDIA_HOTSPOTS: readonly ClusterHotspot[] = [
  ...delhiDrclinHotspots(),
  ...INDIA_CITY_CLUSTERS.filter((c) => c.id !== 'delhi-ncr').map(cityHotspot),
];

/** The Delhi-NCR hotspots (the historical default region). */
export const DELHI_NCR_HOTSPOTS: readonly ClusterHotspot[] = delhiDrclinHotspots();

/**
 * Resolve a region key to the ordered list of clustering hotspots. This is the
 * single place the tower generator asks "where do towers live?".
 *
 *   'delhi-ncr' -> the Delhi NCR districts (default, for behaviour/tests that
 *                  predate pan-India or that want the C-DOT Delhi sample).
 *   'india'     -> all 18 city clusters.
 */
export function resolveHotspots(region: string): ClusterHotspot[] {
  switch (region) {
    case 'delhi-ncr':
      return Array.from(DELHI_NCR_HOTSPOTS);
    case 'india':
      return Array.from(INDIA_HOTSPOTS);
    default:
      throw new Error(`Unknown SIM_REGION "${region}" (expected "delhi-ncr" or "india")`);
  }
}