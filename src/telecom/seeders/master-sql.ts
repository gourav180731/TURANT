import type { TelecomCellTower } from '../entities/cell-tower.js';

/**
 * Pure builders for the Telecom Master Dataset (C-DOT BTS reference schema).
 *
 * Kept free of DB I/O so the row-building and SQL-text generation can be unit
 * tested without a database, and reused by the Postgres seeder and by
 * verification harnesses (including a PostGIS-free mirror for environments
 * without the extension).
 */

/** C-DOT BTS column names, in insert order. */
export const MASTER_COLUMNS = [
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
  'technology',
  'coverage_radius_m',
  'created_at',
] as const;

/** One master-dataset row, already mapped to the C-DOT reference columns. */
export interface TelecomMasterRow {
  id: string;
  serviceProvider: string;
  cellId: string;
  latitude: number;
  longitude: number;
  serviceArea: string;
  state: string;
  district: string;
  cityTown: string;
  pincode: string;
  btsId: string;
  siteType: string;
  switchMake: string;
  switchModel: string;
  stateId: string;
  /** OGC WKT `POINT(lng lat)` — SRID 4326, PostGIS-valid. */
  geomWkt: string;
  rncId: string;
  tspName: string;
  mscIp: string;
  technology: string;
  coverageRadiusM: number;
  createdAt: string;
}

/** Map a tower entity to the C-DOT BTS reference schema row. */
export function toMasterRow(tower: TelecomCellTower): TelecomMasterRow {
  return {
    id: tower.siteId,
    serviceProvider: tower.serviceProvider ?? tower.operatorShortName ?? '',
    cellId: tower.cellId,
    latitude: tower.latitude,
    longitude: tower.longitude,
    serviceArea: tower.serviceArea ?? tower.state,
    state: tower.state,
    district: tower.district,
    cityTown: tower.city,
    pincode: tower.pinCode,
    btsId: tower.btsId ?? `${tower.siteId}-BTS`,
    siteType: tower.siteType ?? 'MACRO',
    switchMake: tower.switchMake ?? tower.vendor,
    switchModel: tower.switchModel ?? tower.controller ?? '',
    stateId: tower.stateId ?? '',
    geomWkt: `POINT(${tower.longitude.toFixed(6)} ${tower.latitude.toFixed(6)})`,
    rncId: tower.rncId ?? '',
    tspName: tower.tspName ?? tower.operator,
    mscIp: tower.mscIp ?? tower.rncIp ?? '',
    technology: tower.technology,
    coverageRadiusM: tower.coverageRadiusM,
    createdAt: tower.createdAt.toISOString(),
  };
}

export interface MasterInsertOptions {
  /**
   * How the `geom` column is written:
   *   st_geomfromtext (default) → ST_GeomFromText($n, 4326)  [real PostGIS]
   *   raw                        → $n as-is                  [verification/mirror]
   */
  geometry?: 'st_geomfromtext' | 'raw';
}

/** Parameterized multi-row INSERT into `telecom_master`. */
export function buildMasterInsertSql(
  rows: readonly TelecomCellTower[],
  opts: MasterInsertOptions = {},
): { text: string; values: unknown[] } {
  const { geometry = 'st_geomfromtext' } = opts;
  const values: unknown[] = [];
  const groups: string[] = [];
  let p = 1;

  for (const tower of rows) {
    const row = toMasterRow(tower);
    const placeholders: string[] = [];
    const push = (v: unknown): void => {
      values.push(v);
      placeholders.push(`$${p++}`);
    };
    push(row.id);
    push(row.serviceProvider);
    push(row.cellId);
    push(row.latitude);
    push(row.longitude);
    push(row.serviceArea);
    push(row.state);
    push(row.district);
    push(row.cityTown);
    push(row.pincode);
    push(row.btsId);
    push(row.siteType);
    push(row.switchMake);
    push(row.switchModel);
    push(row.stateId);
    const geomParam = `$${p++}`;
    values.push(row.geomWkt);
    placeholders.push(geometry === 'st_geomfromtext' ? `ST_GeomFromText(${geomParam}, 4326)` : geomParam);
    push(row.rncId);
    push(row.tspName);
    push(row.mscIp);
    push(row.technology);
    push(row.coverageRadiusM);
    push(row.createdAt);
    groups.push(`(${placeholders.join(', ')})`);
  }

  const text = `
    INSERT INTO telecom_master (${MASTER_COLUMNS.join(', ')})
    VALUES ${groups.join(', ')};`;

  return { text, values };
}
