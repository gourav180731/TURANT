import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/env.js';
import { buildTowerZoneQuery } from '../src/modules/02-cell-site-identification/adapters/postgis-sql.js';
import {
  DELHI_NCR_AREAS,
  OPERATORS,
  SERVICE_AREA_BY_STATE,
  SITE_TYPES,
  STATE_ID_BY_STATE,
  SWITCH_MAKES,
  SWITCH_MODELS,
} from '../src/telecom/generators/geography.js';
import { mulberry32 } from '../src/telecom/generators/prng.js';
import { generateSubscribers } from '../src/telecom/generators/subscriber-generator.js';
import { generateTowers } from '../src/telecom/generators/tower-generator.js';
import { InMemorySubscriberRepository } from '../src/telecom/repositories/in-memory-subscriber-repository.js';
import {
  buildMasterInsertSql,
  MASTER_COLUMNS,
  toMasterRow,
} from '../src/telecom/seeders/master-sql.js';
import { buildSimCellTowersDdl, buildTelecomMasterDdl } from '../src/telecom/seeders/ddl.js';
import { getTowerStore } from '../src/telecom/tower-store.js';
import type { GeoZone } from '../src/types/tower.js';

const techPct = { GSM: 20, UMTS: 20, LTE: 40, NR5G: 20 };

/** The ~5,000-tower Delhi NCR master dataset (TELECOM_MASTER_TOWER_COUNT). */
function masterDataset(count = 5000): ReturnType<typeof generateTowers> {
  return generateTowers({ count, techPct, seed: 20260902 }, mulberry32(20260902));
}

/** C-DOT BTS reference fields (from the sample rows) — every one must exist. */
const REFERENCE_FIELDS = [
  'id',
  'service_provider',
  'cell_id',
  'latitude',
  'longitude',
  'service_area',
  'state',
  'district',
  'city_town',
  'pincode',
  'bts_id',
  'site_type',
  'switch_make',
  'switch_model',
  'state_id',
  'geom',
  'rnc_id',
  'tsp_name',
  'msc_ip',
] as const;

describe('telecom master dataset — generation', () => {
  it('generates ~5,000 towers with every C-DOT reference field populated', () => {
    const towers = masterDataset();
    expect(towers).toHaveLength(5000);
    for (const t of towers) {
      expect(t.btsId, 'bts_id').toBeTruthy();
      expect(t.serviceProvider, 'service_provider').toBeTruthy();
      expect(t.serviceArea, 'service_area').toBeTruthy();
      expect(t.siteType, 'site_type').toBeTruthy();
      expect(t.switchMake, 'switch_make').toBeTruthy();
      expect(t.switchModel, 'switch_model').toBeTruthy();
      expect(t.stateId, 'state_id').toBeTruthy();
      expect(t.rncId, 'rnc_id').toBeTruthy();
      expect(t.tspName, 'tsp_name').toBeTruthy();
      expect(t.mscIp, 'msc_ip').toBeTruthy();
      expect(t.city, 'city_town').toBeTruthy();
      expect(t.pinCode, 'pincode').toBeTruthy();
    }
  });

  it('keeps cell_id, site_id (id) and bts_id globally unique', () => {
    const towers = masterDataset();
    const cellIds = new Set(towers.map((t) => t.cellId));
    const siteIds = new Set(towers.map((t) => t.siteId));
    const btsIds = new Set(towers.map((t) => t.btsId));
    expect(cellIds.size).toBe(5000);
    expect(siteIds.size).toBe(5000);
    expect(btsIds.size).toBe(5000);
  });

  it('uses realistic, internally-consistent operator / switch / site values', () => {
    const towers = masterDataset();
    const shortNames = OPERATORS.map((o) => o.shortName);
    const fullNames = new Set(OPERATORS.map((o) => o.fullName));
    const stateIds = new Set(Object.values(STATE_ID_BY_STATE));
    const serviceAreas = new Set(Object.values(SERVICE_AREA_BY_STATE));
    for (const t of towers) {
      expect(shortNames).toContain(t.serviceProvider);
      expect(fullNames.has(t.tspName)).toBe(true);
      expect(SWITCH_MAKES).toContain(t.switchMake);
      expect(SWITCH_MODELS[t.technology]).toContain(t.switchModel);
      expect(SITE_TYPES).toContain(t.siteType);
      expect(stateIds.has(t.stateId)).toBe(true);
      expect(serviceAreas.has(t.serviceArea)).toBe(true);
      expect(t.rncId).toMatch(/^RNC-/);
      // msc_ip lives on the operator's MNC subnet (10.<mnc>.<x>.<y>).
      const mnc = OPERATORS.find((o) => o.shortName === t.serviceProvider)!.mnc;
      expect(t.mscIp).toMatch(new RegExp(`^10\\.${mnc}\\.\\d{1,3}\\.\\d{1,3}$`));
    }
  });

  it('distributes operators by realistic market share (Jio/Airtel/VI > MTNL/BSNL)', () => {
    const towers = masterDataset();
    const byOp = new Map<string, number>();
    for (const t of towers) byOp.set(t.serviceProvider!, (byOp.get(t.serviceProvider!) ?? 0) + 1);
    const count = (name: string): number => byOp.get(name) ?? 0;
    const majors = count('JIO') + count('AIRTEL') + count('VI');
    const minors = count('MTNL') + count('BSNL');
    expect(majors).toBeGreaterThan(minors);
    expect(majors / towers.length).toBeGreaterThan(0.6);
    // Every operator from the reference list is present.
    for (const op of ['MTNL', 'BSNL', 'AIRTEL', 'JIO', 'VI']) expect(count(op)).toBeGreaterThan(0);
  });

  it('honors the configured RAT distribution (20/20/40/20)', () => {
    const towers = masterDataset();
    const byTech = new Map<string, number>();
    for (const t of towers) byTech.set(t.technology, (byTech.get(t.technology) ?? 0) + 1);
    expect(byTech.get('GSM')! / 5000).toBeCloseTo(0.2, 1);
    expect(byTech.get('UMTS')! / 5000).toBeCloseTo(0.2, 1);
    expect(byTech.get('LTE')! / 5000).toBeCloseTo(0.4, 1);
    expect(byTech.get('NR5G')! / 5000).toBeCloseTo(0.2, 1);
  });
});

describe('telecom master dataset — geographic consistency', () => {
  it('keeps every tower inside Delhi NCR bounds with valid coordinates', () => {
    const towers = masterDataset();
    const lats = DELHI_NCR_AREAS.map((a) => a.latitude);
    const lngs = DELHI_NCR_AREAS.map((a) => a.longitude);
    for (const t of towers) {
      expect(t.latitude).toBeGreaterThan(Math.min(...lats) - 0.1);
      expect(t.latitude).toBeLessThan(Math.max(...lats) + 0.1);
      expect(t.longitude).toBeGreaterThan(Math.min(...lngs) - 0.1);
      expect(t.longitude).toBeLessThan(Math.max(...lngs) + 0.1);
      expect(t.geometry.type).toBe('Point');
      // GeoJSON is [lng, lat] and matches the lat/lng columns.
      expect(t.geometry.coordinates).toEqual([t.longitude, t.latitude]);
    }
  });

  it('places every site within its own district/city centroid (coordinates correspond)', () => {
    const towers = masterDataset();
    const areaByKey = new Map(DELHI_NCR_AREAS.map((a) => [`${a.district}|${a.city}`, a]));
    for (const t of towers) {
      const area = areaByKey.get(`${t.district}|${t.city}`);
      expect(area, `${t.district}/${t.city} must be a known NCR locality`).toBeDefined();
      // Gaussian jitter is clamped at ±0.06°, so a site stays within its locality.
      expect(Math.abs(t.latitude - area!.latitude)).toBeLessThanOrEqual(0.061);
      expect(Math.abs(t.longitude - area!.longitude)).toBeLessThanOrEqual(0.061);
    }
  });

  it('clusters around district hotspots instead of spreading uniformly', () => {
    const towers = masterDataset();
    const areaByKey = new Map(DELHI_NCR_AREAS.map((a) => [`${a.district}|${a.city}`, a]));
    let manhattan = 0;
    for (const t of towers) {
      const area = areaByKey.get(`${t.district}|${t.city}`)!;
      manhattan += Math.abs(t.latitude - area.latitude) + Math.abs(t.longitude - area.longitude);
    }
    const mean = manhattan / towers.length;
    // Uniform ±0.06° jitter would give mean ~0.12; a Gaussian σ=0.028° cluster
    // gives ~0.045 — sites bunch around district centres, not evenly spread.
    expect(mean).toBeLessThan(0.05);
    expect(mean).toBeLessThan(0.08);
  });
});

describe('telecom master dataset — referential integrity (modules 03/04)', () => {
  it('every generated subscriber references one of the master Cell IDs', () => {
    const towers = masterDataset();
    const masterCells = new Set(towers.map((t) => t.cellId));
    const rand = mulberry32(2026);
    const subs = generateSubscribers({
      count: 2000,
      towers,
      activePct: 85,
      minPerTower: 10,
      maxPerTower: 500,
      rand,
      offset: 0,
    });
    expect(subs).toHaveLength(2000);
    for (const s of subs) {
      expect(masterCells.has(s.cellId), `subscriber ${s.imsi} cell ${s.cellId}`).toBe(true);
      const tower = towers.find((t) => t.cellId === s.cellId)!;
      expect(s.technology).toBe(tower.technology);
    }
    // The subscriber generator reaches a broad slice of the master dataset.
    expect(new Set(subs.map((s) => s.cellId)).size).toBeGreaterThan(100);
  });

  it('module 03 can look up subscribers by the master Cell IDs', async () => {
    const towers = masterDataset();
    const rand = mulberry32(7);
    const subs = generateSubscribers({
      count: 500,
      towers,
      activePct: 85,
      minPerTower: 10,
      maxPerTower: 500,
      rand,
      offset: 0,
    });
    const repo = new InMemorySubscriberRepository();
    await repo.upsertSubscribers(subs);

    const anyCell = subs[0]!.cellId;
    const rows = await repo.findByCellIds([anyCell]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.cellId === anyCell)).toBe(true);
    expect(towers.some((t) => t.cellId === anyCell)).toBe(true);
  });
});

describe('telecom master dataset — module 02 queryability', () => {
  it('resolves towers in an alert zone from the in-memory store (memory mode)', () => {
    const towers = masterDataset();
    getTowerStore().replace(towers);
    const zone: GeoZone = {
      geometries: [{ type: 'Circle', center: { lat: 28.6139, lng: 77.209 }, radiusMeters: 20000 }],
    };
    const found = getTowerStore().findTowersInZone(zone, 5000);
    expect(found.length).toBeGreaterThan(0);
    const masterCells = new Set(towers.map((t) => t.cellId));
    for (const t of found) {
      expect(masterCells.has(t.cellId)).toBe(true);
      expect(t.coverageRadiusM).toBeGreaterThan(0);
    }
  });

  it('builds a module-02 PostGIS query against the telecom_master reference table', () => {
    process.env.TOWER_TABLE = 'telecom_master';
    process.env.TOWER_COL_ID = 'id';
    process.env.TOWER_COL_CELL_ID = 'cell_id';
    process.env.TOWER_COL_LAT = 'latitude';
    process.env.TOWER_COL_LNG = 'longitude';
    process.env.TOWER_COL_COVERAGE_RADIUS_M = 'coverage_radius_m';
    resetConfig();
    try {
      const cfg = loadConfig();
      const zone: GeoZone = {
        geometries: [{ type: 'Circle', center: { lat: 28.6139, lng: 77.209 }, radiusMeters: 20000 }],
      };
      const { text, values } = buildTowerZoneQuery(cfg, zone, 5000);
      expect(text).toContain('FROM telecom_master t');
      expect(text).toContain('id AS id');
      expect(text).toContain('cell_id AS cell_id');
      expect(text).toContain('latitude AS latitude');
      expect(text).toContain('longitude AS longitude');
      expect(text).toContain('coverage_radius_m');
      expect(text).toContain('LIMIT 5000');
      expect(values).toHaveLength(3); // lng, lat, radius
    } finally {
      delete process.env.TOWER_TABLE;
      delete process.env.TOWER_COL_ID;
      delete process.env.TOWER_COL_CELL_ID;
      delete process.env.TOWER_COL_LAT;
      delete process.env.TOWER_COL_LNG;
      delete process.env.TOWER_COL_COVERAGE_RADIUS_M;
      resetConfig();
    }
  });
});

describe('telecom master dataset — SQL/DDL builders', () => {
  it('MASTER_COLUMNS covers every C-DOT reference field', () => {
    for (const f of REFERENCE_FIELDS) {
      expect(MASTER_COLUMNS, `column ${f}`).toContain(f);
    }
  });

  it('maps a tower to the C-DOT reference row with a valid WKT geometry', () => {
    const t = masterDataset(1)[0]!;
    const row = toMasterRow(t);
    expect(row.id).toBe(t.siteId);
    expect(row.serviceProvider).toBe(t.serviceProvider);
    expect(row.cellId).toBe(t.cellId);
    expect(row.cityTown).toBe(t.city);
    expect(row.geomWkt).toBe(`POINT(${t.longitude.toFixed(6)} ${t.latitude.toFixed(6)})`);
    expect(row.geomWkt).toMatch(/^POINT\(-?\d+\.\d{6} -?\d+\.\d{6}\)$/);
  });

  it('builds a parameterized telecom_master INSERT with PostGIS geometry', () => {
    const towers = masterDataset(2);
    const { text, values } = buildMasterInsertSql(towers);
    expect(text).toContain('INSERT INTO telecom_master (id, service_provider, cell_id');
    expect(text).toContain('geom');
    expect(text).toContain('ST_GeomFromText($16, 4326)');
    expect(text).not.toContain('ST_GeomFromText($15'); // sanity: geom is the 16th param
    // 2 rows × 22 columns (geometry param is the WKT string).
    expect(values).toHaveLength(2 * 22);
    expect(values[15]).toMatch(/^POINT\(/);
  });

  it('supports a raw-WKT geometry write (PostGIS-free verification)', () => {
    const towers = masterDataset(1);
    const { text } = buildMasterInsertSql(towers, { geometry: 'raw' });
    expect(text).not.toContain('ST_GeomFromText');
    expect(text).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)');
  });

  it('the DDL carries the reference columns, constraints and spatial indexes', () => {
    const ddl = buildTelecomMasterDdl();
    for (const f of REFERENCE_FIELDS) expect(ddl, `ddl column ${f}`).toContain(f);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS telecom_master');
    expect(ddl).toContain('cell_id           TEXT NOT NULL UNIQUE');
    expect(ddl).toContain('bts_id            TEXT UNIQUE');
    expect(ddl).toContain('geom              GEOMETRY(Point, 4326)');
    expect(ddl).toContain('USING GIST (geom)');
    expect(ddl).toContain('USING GIST (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))');
  });

  it('sim_cell_towers DDL carries the master fields too', () => {
    const ddl = buildSimCellTowersDdl();
    for (const f of ['bts_id', 'service_provider', 'service_area', 'site_type', 'switch_make', 'switch_model', 'state_id', 'tsp_name', 'msc_ip']) {
      expect(ddl).toContain(f);
    }
  });
});

