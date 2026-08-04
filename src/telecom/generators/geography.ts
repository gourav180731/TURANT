/**
 * Delhi NCR geography — the default region the simulated network is generated
 * around (the C-DOT samples are Delhi/MTNL). Extending to the rest of India is
 * a data change (add entries), not a code change.
 *
 * Each entry is a real Delhi-NCR area centroid with its PIN. Jitter is applied
 * per tower so cells are spread within the locality.
 */

export interface RegionArea {
  state: string;
  district: string;
  city: string;
  zone: string;
  pinCode: string;
  latitude: number;
  longitude: number;
}

export const DELHI_NCR_AREAS: readonly RegionArea[] = [
  { state: 'DELHI', district: 'NEW DELHI', city: 'NEW DELHI', zone: 'DELHI-CENTRAL', pinCode: '110001', latitude: 28.6139, longitude: 77.209 },
  { state: 'DELHI', district: 'CENTRAL DELHI', city: 'DELHI', zone: 'DELHI-CENTRAL', pinCode: '110006', latitude: 28.64, longitude: 77.215 },
  { state: 'DELHI', district: 'NORTH DELHI', city: 'DELHI', zone: 'DELHI-NORTH', pinCode: '110007', latitude: 28.689, longitude: 77.205 },
  { state: 'DELHI', district: 'SOUTH DELHI', city: 'DELHI', zone: 'DELHI-SOUTH', pinCode: '110017', latitude: 28.57, longitude: 77.18 },
  { state: 'DELHI', district: 'EAST DELHI', city: 'DELHI', zone: 'DELHI-EAST', pinCode: '110092', latitude: 28.62, longitude: 77.29 },
  { state: 'DELHI', district: 'WEST DELHI', city: 'DELHI', zone: 'DELHI-WEST', pinCode: '110063', latitude: 28.67, longitude: 77.11 },
  { state: 'DELHI', district: 'DWARKA', city: 'DELHI', zone: 'DELHI-SOUTHWEST', pinCode: '110077', latitude: 28.59, longitude: 77.03 },
  { state: 'DELHI', district: 'ROHINI', city: 'DELHI', zone: 'DELHI-NORTHWEST', pinCode: '110085', latitude: 28.72, longitude: 77.07 },
  { state: 'DELHI', district: 'SHAHDARA', city: 'DELHI', zone: 'DELHI-EAST', pinCode: '110032', latitude: 28.67, longitude: 77.28 },
  { state: 'HARYANA', district: 'GURUGRAM', city: 'GURUGRAM', zone: 'GURUGRAM', pinCode: '122001', latitude: 28.4595, longitude: 77.0266 },
  { state: 'HARYANA', district: 'FARIDABAD', city: 'FARIDABAD', zone: 'FARIDABAD', pinCode: '121001', latitude: 28.4089, longitude: 77.3178 },
  { state: 'UTTAR PRADESH', district: 'NOIDA', city: 'NOIDA', zone: 'NOIDA', pinCode: '201301', latitude: 28.5355, longitude: 77.391 },
  { state: 'UTTAR PRADESH', district: 'GHAZIABAD', city: 'GHAZIABAD', zone: 'GHAZIABAD', pinCode: '201001', latitude: 28.6692, longitude: 77.4538 },
  { state: 'UTTAR PRADESH', district: 'GREATER NOIDA', city: 'GREATER NOIDA', zone: 'NOIDA', pinCode: '201310', latitude: 28.4744, longitude: 77.504 },
  { state: 'UTTAR PRADESH', district: 'GHAZIABAD', city: 'VAISHALI', zone: 'GHAZIABAD', pinCode: '201010', latitude: 28.6496, longitude: 77.3387 },
];

/** Operator pool with internally-consistent MCC/MNC/PLMN prefix. */
export interface OperatorProfile {
  shortName: string;
  fullName: string;
  mcc: string;
  mnc: string;
}

export const OPERATORS: readonly OperatorProfile[] = [
  { shortName: 'MTNL', fullName: 'Mahanagar Telephone Nigam Ltd. (MTNL)', mcc: '404', mnc: '68' },
  { shortName: 'BSNL', fullName: 'Bharat Sanchar Nigam Ltd.', mcc: '404', mnc: '45' },
  { shortName: 'AIRTEL', fullName: 'Bharti Airtel Ltd.', mcc: '404', mnc: '86' },
  { shortName: 'JIO', fullName: 'Reliance Jio Infocomm Ltd.', mcc: '405', mnc: '30' },
  { shortName: 'VI', fullName: 'Vodafone Idea Ltd.', mcc: '404', mnc: '13' },
];

export const VENDORS = ['HUAWEI', 'NOKIA', 'ERICSSON', 'ZTE', 'SAMSUNG'] as const;

export const CONTROLLERS = ['MSOFT3000', 'MSOFTX3000', 'BSC-CDBMA', 'RNC-HW', 'CSC-RN'] as const;

export const BACKHAUL_TYPES = ['FIBER', 'MICROWAVE', 'SATELLITE'] as const;
