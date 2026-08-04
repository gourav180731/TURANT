import type { TelecomTechnology } from './telecom-subscriber.js';

/**
 * Telecom cell tower entity — the simulation's tower model.
 *
 * Mirrors the canonical C-DOT tower sample (Site ID, operator, PLMN, lat/lng,
 * state/circle/city/zone/pin, Cell ID, technology, vendor, controller,
 * LAC/RNC, geometry) plus the extra radio-planning attributes a production
 * cell database carries (PCI, EARFCN/UARFCN/ARFCN, ECGI/CGI, azimuth, height,
 * capacity, load, backhaul). All synthetic, structurally consistent.
 */

export interface TelecomCellTower {
  /** Database primary key = site id (e.g. 12977). */
  id: string;
  /** Site id (a site may host multiple cells/sectors). */
  siteId: string;
  /** Cell identifier (hex like 9C81 or numeric like 65511), unique. */
  cellId: string;
  /** BTS identifier — unique per base station (C-DOT `bts_id`). */
  btsId?: string;
  /** Telecom service provider short name, e.g. MTNL (C-DOT `service_provider`). */
  serviceProvider?: string;
  /** Telecom circle / service area label, e.g. DELHI (C-DOT `service_area`). */
  serviceArea?: string;
  /** Site type: MACRO/ROOFTOP/TOWER/MICRO/INDOOR (C-DOT `site_type`). */
  siteType?: string;
  /** Switch vendor (C-DOT `switch_make`). */
  switchMake?: string;
  /** Switch / MSC model (C-DOT `switch_model`). */
  switchModel?: string;
  /** Numeric state code, Census 2011 (C-DOT `state_id`). */
  stateId?: string;
  /** Full operator name (C-DOT `tsp_name`). */
  tspName?: string;
  /** MSC (mobile switching centre) IP address (C-DOT `msc_ip`). */
  mscIp?: string;
  /** E-UTRAN cell global identifier (LTE/NR). */
  ecgi?: string;
  /** Cell global identity (GSM/UMTS). */
  cgi?: string;
  enbId?: string;
  gnbId?: string;
  sectorId?: string;
  /** Physical cell id. */
  pci?: number;
  /** E-UTRA absolute radio frequency channel number (LTE). */
  earfcn?: number;
  /** UTRA absolute radio frequency channel number (UMTS). */
  uarfcn?: number;
  /** Absolute radio frequency channel number (GSM). */
  arfcn?: number;
  tac?: string;
  /** Location area code (LAC/RNC), e.g. 1296. */
  lac?: string;
  mcc: string;
  mnc: string;
  /** PLMN in C-DOT form, e.g. 404-68-117-65511. */
  plmn?: string;
  operator: string;
  operatorShortName?: string;
  vendor: string;
  controller?: string;
  rnc?: string;
  bsc?: string;
  rncId?: string;
  rncIp?: string;
  latitude: number;
  longitude: number;
  antennaHeightM?: number;
  azimuthDeg?: number;
  beamWidthDeg?: number;
  frequencyBand?: string;
  technology: TelecomTechnology;
  /** Nominal max simultaneous users (radio capacity). */
  maxUsers: number;
  /** Current synthetic load %. */
  currentLoadPct: number;
  /** Coverage footprint (matches module 02's radius coverage model). */
  coverageRadiusM: number;
  powerStatus: 'ON' | 'OFF';
  backhaulType: 'FIBER' | 'MICROWAVE' | 'SATELLITE';
  ipAddress?: string;
  state: string;
  district: string;
  city: string;
  zone?: string;
  pinCode: string;
  /** GeoJSON Point [lng, lat] (PostGIS geometry, SRID 4326). */
  geometry: { type: 'Point'; coordinates: [number, number] };
  createdAt: Date;
}

/** The normalized shape module 02 consumes (subset of the tower entity). */
export interface TowerLookup {
  id: string;
  cellId: string;
  latitude: number;
  longitude: number;
  coverageRadiusM: number;
}
