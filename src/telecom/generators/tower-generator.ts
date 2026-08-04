/**
 * Cell tower generator — creates a realistic, internally-consistent synthetic
 * radio network for the configured region.
 *
 * - Towers are spread across the region areas with per-area jitter (~±6 km).
 * - RAT split matches the configured TECH_*_PCT distribution (20/20/40/20).
 * - Radio planning params (ARFCN/UARFCN/EARFCN, PCI, band, maxUsers,
 *   coverage radius, azimuth) are derived from the tower's RAT so every field
 *   is plausible for that technology.
 * - Cell ids are unique and start near the canonical sample (9C81-style hex).
 */

import type { TelecomCellTower } from '../entities/cell-tower.js';
import type { TelecomTechnology } from '../entities/telecom-subscriber.js';
import {
  BACKHAUL_TYPES,
  CONTROLLERS,
  DELHI_NCR_AREAS,
  OPERATORS,
  VENDORS,
  type OperatorProfile,
} from './geography.js';
import { makeRangeInt, pickWeighted, shuffle } from './prng.js';

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
  const areas = DELHI_NCR_AREAS;
  const now = new Date();
  const operators = OPERATORS;

  const azimuth = makeRangeInt(rand, 0, 359);
  const beamWidth = makeRangeInt(rand, 60, 120);
  const power = makeRangeInt(rand, 0, 99);
  const vendorPick = () => VENDORS[Math.floor(rand() * VENDORS.length)]!;
  const controllerPick = () => CONTROLLERS[Math.floor(rand() * CONTROLLERS.length)]!;
  const backhaulPick = () => BACKHAUL_TYPES[Math.floor(rand() * BACKHAUL_TYPES.length)]!;

  const towers: TelecomCellTower[] = new Array(ctx.count);
  const CELL_BASE = 0x9c81; // start hex cell ids near the canonical sample

  for (let i = 0; i < ctx.count; i++) {
    const technology = techs[i]!;
    const area = areas[Math.floor(rand() * areas.length)]!;
    const op = pickWeighted<OperatorProfile & { weight: number }>(rand, [
      ...operators.map((o) => ({ ...o, weight: o.shortName === 'MTNL' ? 6 : 1 })),
    ]);
    const profile = TECH_PROFILES[technology];
    const lat = area.latitude + (rand() - 0.5) * 0.12;
    const lng = area.longitude + (rand() - 0.5) * 0.12;
    const cellId = (CELL_BASE + i).toString(16).toUpperCase();
    const nodeId = 117 + Math.floor(rand() * 1000);
    const maxUsers = makeRangeInt(rand, profile.maxUsersRange[0], profile.maxUsersRange[1])();
    const coverageRadiusM = makeRangeInt(rand, profile.radiusRangeM[0], profile.radiusRangeM[1])();
    const siteId = String(12977 + i);

    const tower: TelecomCellTower = {
      id: siteId,
      siteId,
      cellId,
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
      vendor: vendorPick(),
      controller: technology === 'GSM' ? 'MSOFT3000' : controllerPick(),
      rnc: technology === 'UMTS' ? 'RNC-HW' : undefined,
      bsc: technology === 'GSM' ? 'BSC-CDBMA' : undefined,
      rncId: technology === 'UMTS' || technology === 'LTE' ? 'default_rnc_id' : undefined,
      rncIp: `10.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
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
      geometry: { type: 'Point', coordinates: [lng, lat] },
      createdAt: now,
    };
    towers[i] = tower;
  }
  return towers;
}
