/**
 * Cell tower / BTS generator — creates a realistic, internally-consistent
 * synthetic radio network for the configured region.
 *
 * - Sites cluster around district hotspots: a hotspot is picked weighted by its
 *   locality density and each site jitters around it with a clamped Gaussian
 *   (~3 km σ), so urban cores are denser than the periphery.
 * - RAT split matches the configured TECH_*_PCT distribution (20/20/40/20).
 * - Radio planning params (ARFCN/UARFCN/EARFCN, PCI, band, maxUsers,
 *   coverage radius, azimuth) are derived from the tower's RAT so every field
 *   is plausible for that technology.
 * - Every record carries the C-DOT master-dataset fields (bts_id, service
 *   provider/tsp, service_area, site_type, switch_make/model, state_id,
 *   rnc_id, msc_ip) with realistic combinations.
 * - Cell ids, site ids and BTS ids are all unique; operators are distributed
 *   by realistic market share (MTNL/BSNL smaller, Jio/Airtel/VI dominant).
 */

import type { TelecomCellTower } from '../entities/cell-tower.js';
import type { TelecomTechnology } from '../entities/telecom-subscriber.js';
import {
  BACKHAUL_TYPES,
  CONTROLLERS,
  DELHI_NCR_AREAS,
  OPERATORS,
  SERVICE_AREA_BY_STATE,
  SITE_TYPES,
  STATE_ID_BY_STATE,
  SWITCH_MAKES,
  SWITCH_MODELS,
  VENDORS,
  type OperatorProfile,
  type RegionArea,
} from './geography.js';
import { gaussian, makeRangeInt, pickWeighted, shuffle } from './prng.js';

export interface TowerGenContext {
  count: number;
  techPct: Record<TelecomTechnology, number>;
  seed: number;
}

/** Radio-planning parameters per RAT. */
export interface TechProfile {
  band: string;
  arfcnRange?: [number, number];
  uarfcnRange?: [number, number];
  earfcnRange?: [number, number];
  pciRange: [number, number];
  maxUsersRange: [number, number];
  radiusRangeM: [number, number];
  heightRangeM: [number, number];
}

export const TECH_PROFILES: Record<TelecomTechnology, TechProfile> = {
  GSM: { band: '900', arfcnRange: [1, 124], pciRange: [1, 63], maxUsersRange: [300, 800], radiusRangeM: [1500, 4000], heightRangeM: [25, 60] },
  UMTS: { band: '2100', uarfcnRange: [10562, 10838], pciRange: [0, 511], maxUsersRange: [600, 1200], radiusRangeM: [800, 2500], heightRangeM: [25, 55] },
  LTE: { band: '3', earfcnRange: [1800, 2000], pciRange: [0, 503], maxUsersRange: [800, 2000], radiusRangeM: [400, 1500], heightRangeM: [20, 45] },
  NR5G: { band: 'n78', earfcnRange: [636000, 660000], pciRange: [0, 1007], maxUsersRange: [1500, 3000], radiusRangeM: [250, 1000], heightRangeM: [15, 40] },
};

/** Site-type probability (urban Delhi is macro/rooftop heavy). */
const SITE_TYPE_WEIGHTS: Readonly<Record<string, number>> = {
  MACRO: 40,
  ROOFTOP: 25,
  TOWER: 15,
  MICRO: 12,
  INDOOR: 8,
};

/** Vendor → switch-make name (C-DOT `switch_make` is proper case). */
const SWITCH_MAKE_BY_VENDOR: Readonly<Record<string, string>> = {
  HUAWEI: 'Huawei',
  NOKIA: 'Nokia',
  ERICSSON: 'Ericsson',
  SAMSUNG: 'Samsung',
  ZTE: 'ZTE',
};

/** Clamp a Gaussian spatial offset so sites stay inside the NCR box. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Pick a hotspot area weighted by locality density. */
function pickHotspot(rand: () => number): RegionArea {
  return pickWeighted(
    rand,
    DELHI_NCR_AREAS.map((a) => ({ ...a, weight: a.weight ?? 1 })),
  );
}

/** Build the ordered list of RAT values honoring the configured percentages. */
export function planTechnologies(ctx: TowerGenContext, rand: () => number): TelecomTechnology[] {
  const total = ctx.count;
  const plan: TelecomTechnology[] = [];
  for (const tech of ['GSM', 'UMTS', 'LTE', 'NR5G'] as const) {
    const n = Math.round((total * ctx.techPct[tech]) / 100);
    for (let i = 0; i < n; i++) plan.push(tech);
  }
  // Rounding can leave the last few unassigned — fill deterministically and
  // then shuffle so the order looks random.
  let filler: TelecomTechnology = 'LTE';
  while (plan.length < total) plan.push(filler);
  if (plan.length > total) plan.length = total;
  return shuffle(rand, plan);
}

/** Generate `ctx.count` towers with unique ids/geometry within the region. */
export function generateTowers(ctx: TowerGenContext, rand: () => number): TelecomCellTower[] {
  const techs = planTechnologies(ctx, rand);
  const now = new Date();

  const azimuth = makeRangeInt(rand, 0, 359);
  const beamWidth = makeRangeInt(rand, 60, 120);
  const power = makeRangeInt(rand, 0, 99);
  const vendorPick = () => VENDORS[Math.floor(rand() * VENDORS.length)]!;
  const controllerPick = () => CONTROLLERS[Math.floor(rand() * CONTROLLERS.length)]!;
  const backhaulPick = () => BACKHAUL_TYPES[Math.floor(rand() * BACKHAUL_TYPES.length)]!;
  const switchMakePick = () => SWITCH_MAKES[Math.floor(rand() * SWITCH_MAKES.length)]!;
  const rncSerial = makeRangeInt(rand, 1000, 9999);
  const mscOctet = () => 1 + Math.floor(rand() * 254);

  const towers: TelecomCellTower[] = new Array(ctx.count);
  const CELL_BASE = 0x9c81; // start hex cell ids near the canonical sample

  for (let i = 0; i < ctx.count; i++) {
    const technology = techs[i]!;
    const area = pickHotspot(rand);
    const op = pickWeighted<OperatorProfile & { weight: number }>(rand, [
      ...OPERATORS.map((o) => ({ ...o, weight: o.weight ?? 1 })),
    ]);
    const profile = TECH_PROFILES[technology];

    // Cluster: bell-shaped offset (~3 km σ) around the district hotspot.
    const dLat = clamp(gaussian(rand) * 0.028, -0.06, 0.06);
    const dLng = clamp(gaussian(rand) * 0.028, -0.06, 0.06);
    const lat = area.latitude + dLat;
    const lng = area.longitude + dLng;

    const cellId = (CELL_BASE + i).toString(16).toUpperCase();
    const nodeId = 117 + Math.floor(rand() * 1000);
    const maxUsers = makeRangeInt(rand, profile.maxUsersRange[0], profile.maxUsersRange[1])();
    const coverageRadiusM = makeRangeInt(rand, profile.radiusRangeM[0], profile.radiusRangeM[1])();
    const siteId = String(12977 + i);
    const btsId = `${op.shortName}-${String(100000 + i).padStart(6, '0')}`;
    const vendor = vendorPick();
    const latitude = Number(lat.toFixed(6));
    const longitude = Number(lng.toFixed(6));

    const tower: TelecomCellTower = {
      id: siteId,
      siteId,
      cellId,
      btsId,
      serviceProvider: op.shortName,
      serviceArea: SERVICE_AREA_BY_STATE[area.state] ?? area.state,
      siteType: pickWeighted(
        rand,
        SITE_TYPES.map((s) => ({ tag: s, weight: SITE_TYPE_WEIGHTS[s] ?? 5 })),
      ).tag as (typeof SITE_TYPES)[number],
      switchMake: rand() < 0.6 ? (SWITCH_MAKE_BY_VENDOR[vendor] ?? 'Huawei') : switchMakePick(),
      switchModel: SWITCH_MODELS[technology][Math.floor(rand() * SWITCH_MODELS[technology].length)]!,
      stateId: STATE_ID_BY_STATE[area.state] ?? '7',
      tspName: op.fullName,
      mscIp: `10.${op.mnc}.${mscOctet()}.${mscOctet()}`,
      ecgi: technology === 'LTE' || technology === 'NR5G' ? `${op.mcc}${op.mnc}${nodeId}${cellId}` : undefined,
      cgi: technology === 'GSM' || technology === 'UMTS' ? `${op.mcc}${op.mnc}${cellId}` : undefined,
      enbId: technology === 'LTE' ? String(nodeId) : undefined,
      gnbId: technology === 'NR5G' ? String(nodeId) : undefined,
      sectorId: `S${1 + Math.floor(rand() * 3)}`,
      pci: makeRangeInt(rand, profile.pciRange[0], profile.pciRange[1])(),
      arfcn: profile.arfcnRange ? makeRangeInt(rand, profile.arfcnRange[0], profile.arfcnRange[1])() : undefined,
      uarfcn: profile.uarfcnRange ? makeRangeInt(rand, profile.uarfcnRange[0], profile.uarfcnRange[1])() : undefined,
      earfcn: profile.earfcnRange ? makeRangeInt(rand, profile.earfcnRange[0], profile.earfcnRange[1])() : undefined,
      tac: technology === 'LTE' || technology === 'NR5G' ? String(1000 + Math.floor(rand() * 9000)) : undefined,
      lac: String(Math.floor(rand() * 7000) + 1).padStart(4, '0'),
      mcc: op.mcc,
      mnc: op.mnc,
      plmn: `${op.mcc}-${op.mnc}-${nodeId}-${cellId}`,
      operator: op.fullName,
      operatorShortName: op.shortName,
      vendor,
      controller: technology === 'GSM' ? 'MSOFT3000' : controllerPick(),
      rnc: technology === 'UMTS' ? 'RNC-HW' : undefined,
      bsc: technology === 'GSM' ? 'BSC-CDBMA' : undefined,
      rncId: `RNC-${op.shortName}-${rncSerial()}`,
      rncIp: `10.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
      latitude,
      longitude,
      antennaHeightM: makeRangeInt(rand, profile.heightRangeM[0], profile.heightRangeM[1])(),
      azimuthDeg: azimuth(),
      beamWidthDeg: beamWidth(),
      frequencyBand: profile.band,
      technology,
      maxUsers,
      currentLoadPct: power(),
      coverageRadiusM,
      powerStatus: 'ON',
      backhaulType: backhaulPick(),
      ipAddress: `10.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
      state: area.state,
      district: area.district,
      city: area.city,
      zone: area.zone,
      pinCode: area.pinCode,
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      createdAt: now,
    };
    towers[i] = tower;
  }
  return towers;
}
