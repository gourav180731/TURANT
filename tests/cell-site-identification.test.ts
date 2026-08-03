import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/env.js';
import { buildTowerZoneQuery } from '../src/modules/02-cell-site-identification/adapters/postgis-sql.js';
import { TowerResolver } from '../src/modules/02-cell-site-identification/resolver.js';
import type { TowerSource } from '../src/modules/02-cell-site-identification/tower-source.js';
import { traceStore } from '../src/tracing/trace-store.js';
import type { CellTower, GeoZone } from '../src/types/tower.js';
import {
  capRingToGeoJson,
  isClosedRing,
  parseCapCoordinate,
} from '../src/utils/geometry.js';

const zoneWithPolygon: GeoZone = {
  geometries: [
    { type: 'Polygon', coordinates: [[[84.5, 28], [84.5, 28.5], [85, 28.5], [85, 28], [84.5, 28]]] },
  ],
};

const zoneWithCircle: GeoZone = {
  geometries: [{ type: 'Circle', center: { lat: 27, lng: 84.5 }, radiusMeters: 25000 }],
};

describe('geometry helpers', () => {
  it('parses CAP "lat,lng" coordinates', () => {
    expect(parseCapCoordinate('28.5,84.5')).toEqual({ lat: 28.5, lng: 84.5 });
    expect(() => parseCapCoordinate('abc')).toThrow(/Invalid CAP coordinate/);
  });

  it('converts CAP rings (lat,lng) to GeoJSON rings (lng,lat)', () => {
    const ring = [
      { lat: 28, lng: 84.5 },
      { lat: 28.5, lng: 84.5 },
      { lat: 28.5, lng: 85 },
      { lat: 28, lng: 84.5 },
    ];
    expect(capRingToGeoJson(ring)[0]).toEqual([84.5, 28]);
  });

  it('detects closed rings', () => {
    expect(isClosedRing([
      { lat: 28, lng: 84.5 },
      { lat: 28.5, lng: 85 },
      { lat: 28, lng: 84.5 },
    ])).toBe(false);
    expect(isClosedRing([
      { lat: 28, lng: 84.5 },
      { lat: 28.5, lng: 84.5 },
      { lat: 28.5, lng: 85 },
      { lat: 28, lng: 84.5 },
    ])).toBe(true);
  });
});

describe('PostGIS SQL builder (requirement #2)', () => {
  it('builds an indexed, budget-friendly polygon query', () => {
    const cfg = loadConfig();
    const { text, values } = buildTowerZoneQuery(cfg, zoneWithPolygon, 1000);
    expect(text).toContain('ST_Intersects');
    expect(text).toContain('ST_GeomFromGeoJSON');
    expect(text).toContain('ST_Union');
    expect(text).toContain('LIMIT 1000');
    expect(text).toContain(cfg.TOWER_TABLE);
    expect(values).toHaveLength(1);
    expect(typeof values[0]).toBe('string');
  });

  it('builds a circle query with metre-accurate ST_Buffer on geography', () => {
    const cfg = loadConfig();
    const { text, values } = buildTowerZoneQuery(cfg, zoneWithCircle, 1000);
    expect(text).toContain('ST_Buffer');
    expect(text).toContain('::geography');
    expect(text).toContain('ST_MakePoint($1, $2)');
    expect(values).toEqual([84.5, 27, 25000]);
  });

  it('uses coverage_radius_m matching for the radius model and ST_AsGeoJSON for polygon model', () => {
    const cfg = loadConfig();
    const radius = buildTowerZoneQuery(cfg, zoneWithPolygon, 10);
    expect(radius.text).toContain('ST_DWithin');

    process.env.TOWER_COVERAGE_MODEL = 'polygon';
    resetConfig();
    const polygon = buildTowerZoneQuery(loadConfig(), zoneWithPolygon, 10);
    expect(polygon.text).toContain('ST_AsGeoJSON(coverage_geom)');
    expect(polygon.text).not.toContain('ST_DWithin');
    delete process.env.TOWER_COVERAGE_MODEL;
    resetConfig();
  });

  it('throws when a zone has no geometries', () => {
    const cfg = loadConfig();
    expect(() => buildTowerZoneQuery(cfg, { geometries: [] }, 10)).toThrow(/no geometries/i);
  });
});

describe('TowerResolver (requirement #2)', () => {
  it('rejects unknown tower source modes', () => {
    const resolver = new TowerResolver();
    expect(() => resolver.getSource('oracle')).toThrow(/Unknown TOWER_SOURCE_MODE/);
  });

  it('returns towers from a source within the time budget', async () => {
    const fake: TowerSource = {
      name: 'fake',
      async findTowersInZone(): Promise<CellTower[]> {
        return [{ id: 't1', cellId: 'C1', latitude: 28, longitude: 84.5 }];
      },
    };
    const resolver = new TowerResolver();
    const traceKey = `cell-resolve-${Date.now()}`;
    const towers = await resolver.resolveWithSource(fake, 'alert-1', zoneWithPolygon, { traceKey });
    expect(towers).toHaveLength(1);
    expect(towers[0]!.cellId).toBe('C1');

    // t1 must be marked on the shared latency trace.
    const rec = await traceStore.snapshot(traceKey);
    expect(rec?.points.t1).toBeDefined();
    expect(rec?.points.t1?.label).toBe('cell.match');
  });

  it('fails fast when a source exceeds the configured time budget', async () => {
    process.env.TOWER_MATCH_TIME_BUDGET_MS = '40';
    resetConfig();
    const slow: TowerSource = {
      name: 'slow',
      async findTowersInZone(): Promise<CellTower[]> {
        await new Promise((r) => setTimeout(r, 400));
        return [];
      },
    };
    const resolver = new TowerResolver();
    await expect(resolver.resolveWithSource(slow, 'alert-2', zoneWithPolygon)).rejects.toThrow(/time budget/);
    delete process.env.TOWER_MATCH_TIME_BUDGET_MS;
    resetConfig();
  });
});
