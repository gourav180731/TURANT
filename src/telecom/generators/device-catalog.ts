/**
 * Synthetic device catalogue — handset vendor/model pools per RAT.
 *
 * Values are common handset vendors and plausible model lines (no real EMEI
 * series or subscriber info is inferred). Used to populate a subscriber's
 * device_vendor / device_model / APN in a way that is internally consistent
 * with its RAT (a GSM phone does not get a 5G model).
 */

export interface DeviceEntry {
  vendor: string;
  model: string;
}

const DEVICES: Record<'GSM' | 'UMTS' | 'LTE' | 'NR5G', DeviceEntry[]> = {
  GSM: [
    { vendor: 'NOKIA', model: '1100' },
    { vendor: 'NOKIA', model: '105' },
    { vendor: 'SAMSUNG', model: 'Guru 1200' },
    { vendor: 'LAVA', model: 'A1' },
    { vendor: 'KARBONN', model: 'K9' },
  ],
  UMTS: [
    { vendor: 'SAMSUNG', model: 'Galaxy Star' },
    { vendor: 'NOKIA', model: 'C2-01' },
    { vendor: 'SONY', model: 'Ericsson K800i' },
    { vendor: 'LG', model: 'KM900' },
    { vendor: 'MICROMAX', model: 'Bharat 5' },
  ],
  LTE: [
    { vendor: 'SAMSUNG', model: 'Galaxy A14' },
    { vendor: 'XIAOMI', model: 'Redmi Note 12' },
    { vendor: 'REALME', model: 'Narzo 60' },
    { vendor: 'OPPO', model: 'A18' },
    { vendor: 'VIVO', model: 'T2x' },
    { vendor: 'MOTOROLA', model: 'G54' },
    { vendor: 'POCO', model: 'M6 Pro' },
  ],
  NR5G: [
    { vendor: 'SAMSUNG', model: 'Galaxy S24' },
    { vendor: 'XIAOMI', model: 'Redmi Note 13 Pro' },
    { vendor: 'APPLE', model: 'iPhone 15' },
    { vendor: 'ONEPLUS', model: '12R' },
    { vendor: 'GOOGLE', model: 'Pixel 8' },
    { vendor: 'VIVO', model: 'V30' },
  ],
};

/** APN pool; ipv4/ipv6 session profiles are derived per subscriber. */
export const APN_POOL = ['ims', 'internet', 'wifi.call', 'enterprise', 'mms'] as const;

export function devicesForTechnology(technology: keyof typeof DEVICES): readonly DeviceEntry[] {
  return DEVICES[technology];
}
