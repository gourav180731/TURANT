/**
 * Delhi NCR geography — the default region the simulated network is generated
 * around (the C-DOT samples are Delhi/MTNL). Extending to the rest of India is
 * a data change (add entries), not a code change.
 *
 * Each entry is a real Delhi-NCR area centroid with its PIN and a relative
 * `weight` (how many sites that locality hosts — urban cores are denser). The
 * tower generator picks a hotspot weighted by `weight` and jitters each site
 * around it with a clamped Gaussian, so cells cluster around district centres
 * instead of being spread uniformly.
 */

import type { TelecomTechnology } from '../entities/telecom-subscriber.js';

export interface RegionArea {
  state: string;
  district: string;
  city: string;
  zone: string;
  pinCode: string;
  latitude: number;
  longitude: number;
  /** Relative site density (urban cores host more BTS). */
  weight?: number;
  /** Gaussian spatial σ in degrees around this hotspot (default 0.028). */
  sigmaDeg?: number;
  /** Clamp for the Gaussian offset in degrees (default 0.06). */
  clampDeg?: number;
  /**
   * Identity of the city cluster this hotspot belongs to (e.g. 'mumbai',
   * 'delhi-ncr'). Used to group towers for per-city bounds assertions and to
   * tag generated towers so the frontend/UX can reason about regions.
   */
  clusterKey?: string;
}

export const DELHI_NCR_AREAS: readonly RegionArea[] = [
  { state: 'DELHI', district: 'NEW DELHI', city: 'NEW DELHI', zone: 'DELHI-CENTRAL', pinCode: '110001', latitude: 28.6139, longitude: 77.209, weight: 10 },
  { state: 'DELHI', district: 'CENTRAL DELHI', city: 'DELHI', zone: 'DELHI-CENTRAL', pinCode: '110006', latitude: 28.64, longitude: 77.215, weight: 8 },
  { state: 'DELHI', district: 'NORTH DELHI', city: 'DELHI', zone: 'DELHI-NORTH', pinCode: '110007', latitude: 28.689, longitude: 77.205, weight: 7 },
  { state: 'DELHI', district: 'SOUTH DELHI', city: 'DELHI', zone: 'DELHI-SOUTH', pinCode: '110017', latitude: 28.57, longitude: 77.18, weight: 9 },
  { state: 'DELHI', district: 'EAST DELHI', city: 'DELHI', zone: 'DELHI-EAST', pinCode: '110092', latitude: 28.62, longitude: 77.29, weight: 7 },
  { state: 'DELHI', district: 'WEST DELHI', city: 'DELHI', zone: 'DELHI-WEST', pinCode: '110063', latitude: 28.67, longitude: 77.11, weight: 7 },
  { state: 'DELHI', district: 'DWARKA', city: 'DELHI', zone: 'DELHI-SOUTHWEST', pinCode: '110077', latitude: 28.59, longitude: 77.03, weight: 6 },
  { state: 'DELHI', district: 'ROHINI', city: 'DELHI', zone: 'DELHI-NORTHWEST', pinCode: '110085', latitude: 28.72, longitude: 77.07, weight: 6 },
  { state: 'DELHI', district: 'SHAHDARA', city: 'DELHI', zone: 'DELHI-EAST', pinCode: '110032', latitude: 28.67, longitude: 77.28, weight: 5 },
  { state: 'HARYANA', district: 'GURUGRAM', city: 'GURUGRAM', zone: 'GURUGRAM', pinCode: '122001', latitude: 28.4595, longitude: 77.0266, weight: 10 },
  { state: 'HARYANA', district: 'FARIDABAD', city: 'FARIDABAD', zone: 'FARIDABAD', pinCode: '121001', latitude: 28.4089, longitude: 77.3178, weight: 7 },
  { state: 'UTTAR PRADESH', district: 'NOIDA', city: 'NOIDA', zone: 'NOIDA', pinCode: '201301', latitude: 28.5355, longitude: 77.391, weight: 10 },
  { state: 'UTTAR PRADESH', district: 'GHAZIABAD', city: 'GHAZIABAD', zone: 'GHAZIABAD', pinCode: '201001', latitude: 28.6692, longitude: 77.4538, weight: 7 },
  { state: 'UTTAR PRADESH', district: 'GREATER NOIDA', city: 'GREATER NOIDA', zone: 'NOIDA', pinCode: '201310', latitude: 28.4744, longitude: 77.504, weight: 6 },
  { state: 'UTTAR PRADESH', district: 'GHAZIABAD', city: 'VAISHALI', zone: 'GHAZIABAD', pinCode: '201010', latitude: 28.6496, longitude: 77.3387, weight: 4 },
];

/** Operator pool with internally-consistent MCC/MNC/PLMN prefix. */
export interface OperatorProfile {
  shortName: string;
  fullName: string;
  mcc: string;
  mnc: string;
  /** Relative market share (how many of a region's sites belong to the operator). */
  weight?: number;
}

export const OPERATORS: readonly OperatorProfile[] = [
  { shortName: 'MTNL', fullName: 'Mahanagar Telephone Nigam Ltd. (MTNL)', mcc: '404', mnc: '68', weight: 10 },
  { shortName: 'BSNL', fullName: 'Bharat Sanchar Nigam Ltd.', mcc: '404', mnc: '45', weight: 10 },
  { shortName: 'AIRTEL', fullName: 'Bharti Airtel Ltd.', mcc: '404', mnc: '86', weight: 28 },
  { shortName: 'JIO', fullName: 'Reliance Jio Infocomm Ltd.', mcc: '405', mnc: '30', weight: 30 },
  { shortName: 'VI', fullName: 'Vodafone Idea Ltd.', mcc: '404', mnc: '13', weight: 22 },
];

export const VENDORS = ['HUAWEI', 'NOKIA', 'ERICSSON', 'ZTE', 'SAMSUNG'] as const;

export const CONTROLLERS = ['MSOFT3000', 'MSOFTX3000', 'BSC-CDBMA', 'RNC-HW', 'CSC-RN'] as const;

export const BACKHAUL_TYPES = ['FIBER', 'MICROWAVE', 'SATELLITE'] as const;

/** BTS site types, weighted toward urban macro/rooftop sites. */
export const SITE_TYPES = ['MACRO', 'ROOFTOP', 'TOWER', 'MICRO', 'INDOOR'] as const;

/** Switch vendors (C-DOT `switch_make`), proper case to match the sample rows. */
export const SWITCH_MAKES = ['Huawei', 'Nokia', 'Ericsson', 'Samsung', 'ZTE'] as const;

/** Plausible MSC/switch models per RAT (C-DOT `switch_model`). */
export const SWITCH_MODELS: Record<TelecomTechnology, readonly string[]> = {
  GSM: ['MSOFT3000', 'BSC-CDBMA', 'MSC Server'],
  UMTS: ['MSS', 'RNC-HW', 'MSOFT3000'],
  LTE: ['MSC Server', 'MGW', 'MSOFTX3000'],
  NR5G: ['SoftX3000', 'MSC Server', 'MGW'],
};

/** Indian state code (Census 2011) used as C-DOT `state_id`. */
export const STATE_ID_BY_STATE: Readonly<Record<string, string>> = {
  DELHI: '7',
  HARYANA: '6',
  'UTTAR PRADESH': '9',
  RAJASTHAN: '8',
  MAHARASHTRA: '27',
  GUJARAT: '24',
  KARNATAKA: '29',
  'TAMIL NADU': '33',
  TELANGANA: '36',
  KERALA: '32',
  'WEST BENGAL': '19',
  BIHAR: '10',
  ODISHA: '21',
  ASSAM: '18',
  'MADHYA PRADESH': '23',
};

/** Telecom circle / service area label per state (C-DOT `service_area`). */
export const SERVICE_AREA_BY_STATE: Readonly<Record<string, string>> = {
  DELHI: 'DELHI',
  HARYANA: 'HARYANA',
  'UTTAR PRADESH': 'UP-WEST',
  RAJASTHAN: 'RAJASTHAN',
  MAHARASHTRA: 'MAHARASHTRA & GOA',
  GUJARAT: 'GUJARAT',
  KARNATAKA: 'KARNATAKA',
  'TAMIL NADU': 'TAMILNADU & CHENNAI',
  TELANGANA: 'AP & TELANGANA',
  KERALA: 'KERALA',
  'WEST BENGAL': 'WEST BENGAL & ANDAMAN',
  BIHAR: 'BIHAR & JHARKHAND',
  ODISHA: 'ORISSA',
  ASSAM: 'NORTH-EAST & ASSAM',
  'MADHYA PRADESH': 'MADHYA PRADESH',
};
