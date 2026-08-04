/**
 * Location area entity — one LAC within the simulated network.
 *
 * A location area groups cells for paging; subscribers carry the LAC of the
 * cell they are attached to. Seeded once from the generated tower set so every
 * subscriber LAC and every tower LAC is consistent with a real area entry.
 */
export interface LocationArea {
  /** Location area code, e.g. 0451 / 1296. */
  lac: string;
  mcc: string;
  mnc: string;
  state: string;
  district: string;
  city: string;
  zone?: string;
  /** Approximate area centroid (WGS84). */
  latitude: number;
  longitude: number;
  description?: string;
}
