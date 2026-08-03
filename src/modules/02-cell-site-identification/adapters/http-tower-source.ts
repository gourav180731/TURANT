import { loadConfig } from '../../../config/env.js';
import type { CellTower, GeoZone } from '../../../types/tower.js';
import { getLogger } from '../../../utils/logger.js';
import type { FindTowersOptions, TowerSource } from '../tower-source.js';

const logger = getLogger();

interface HttpTowerRow {
  id: string;
  cell_id?: string;
  cellId?: string;
  latitude?: number;
  latitudeDeg?: number;
  longitude?: number;
  longitudeDeg?: number;
  coverage_radius_m?: number | null;
}

/**
 * HTTP tower source — requirement #2 (alternative path).
 *
 * Queries a C-DOT API gateway instead of the database directly.
 *
 * Contract (to be confirmed with C-DOT):
 *   GET {TOWER_HTTP_BASE_URL}/towers-in-area
 *     ?geojson=[{"type":"Polygon","coordinates":[...]}, ...]
 *     &srid=4326
 *   Authorization: Bearer {TOWER_HTTP_TOKEN}
 *   Response: { "towers": [{ "id", "cell_id", "latitude", "longitude" }] }
 *
 * This adapter is fully built against that contract but stays dormant until
 * C-DOT provides TOWER_HTTP_BASE_URL + TOWER_HTTP_TOKEN (marker: AWAITING
 * CREDENTIALS). Until then it fails loudly rather than pretending.
 */
export class HttpTowerSource implements TowerSource {
  readonly name = 'http';

  async findTowersInZone(zone: GeoZone, options: FindTowersOptions = {}): Promise<CellTower[]> {
    const cfg = loadConfig();
    if (!cfg.TOWER_HTTP_BASE_URL) {
      throw new Error('HttpTowerSource is configured but TOWER_HTTP_BASE_URL is not set (awaiting C-DOT tower API endpoint).');
    }

    const geojson = zone.geometries.map((g) =>
      g.type === 'Polygon'
        ? { type: 'Polygon', coordinates: g.coordinates }
        : { type: 'Point', coordinates: [g.center!.lng, g.center!.lat], radiusMeters: g.radiusMeters },
    );

    const url = new URL('/towers-in-area', cfg.TOWER_HTTP_BASE_URL);
    url.searchParams.set('geojson', JSON.stringify(geojson));
    url.searchParams.set('srid', String(zone.srid ?? cfg.TOWER_GEOM_SRID));
    if (options.limit) url.searchParams.set('limit', String(options.limit));

    const timeout = cfg.TOWER_HTTP_TIMEOUT_MS;
    const signal = options.signal ?? AbortSignal.timeout(timeout);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.TOWER_HTTP_TOKEN) headers.Authorization = `Bearer ${cfg.TOWER_HTTP_TOKEN}`;

    const started = performance.now();
    const res = await fetch(url, { headers, signal });
    const elapsedMs = performance.now() - started;
    if (!res.ok) {
      throw new Error(`Tower API responded ${res.status} for zone request`);
    }
    const body = (await res.json()) as { towers?: HttpTowerRow[] };
    logger.info({ towers: body.towers?.length ?? 0, elapsedMs }, 'cell.match.http.query');
    return (body.towers ?? []).map((t) => ({
      id: t.id,
      cellId: t.cell_id ?? t.cellId ?? t.id,
      latitude: t.latitude ?? t.latitudeDeg ?? 0,
      longitude: t.longitude ?? t.longitudeDeg ?? 0,
      coverageRadiusM: t.coverage_radius_m ?? undefined,
    }));
  }
}
