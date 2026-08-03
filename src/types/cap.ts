/**
 * CAP (Common Alerting Protocol) model — aligned with ITU-T X.1303 /
 * CAP 1.2 (OASIS Emergency Data Exchange Language CAP v1.2, urn:oasis:names:tc:emergency:cap:1.2).
 */

export type CapSeverity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
export type CapUrgency = 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
export type CapCertainty = 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';
export type CapStatus = 'Actual' | 'Exercise' | 'System' | 'Test' | 'Draft';
export type CapMsgType = 'Alert' | 'Update' | 'Cancel' | 'Ack' | 'Error';
export type CapScope = 'Public' | 'Restricted' | 'Private';

/** A "lat,lng" vertex pair (decimal degrees, WGS84). */
export interface CapCoordinate {
  lat: number;
  lng: number;
}

/** CAP-origin geometry in CAP coordinate convention (lat,lng). */
export type CapGeometry =
  | { type: 'Polygon'; coordinates: CapCoordinate[][] }
  | { type: 'Circle'; center: CapCoordinate; radiusMeters: number };

/** A key/value pair from CAP <geocode>. */
export interface CapGeocode {
  valueName: string;
  value: string;
}

/** One CAP <area> element. */
export interface CapArea {
  areaDesc: string;
  /** Every <polygon> in the area. */
  polygons: CapCoordinate[][];
  /** Every <circle> in the area. */
  circles: { center: CapCoordinate; radiusMeters: number }[];
  /** GeoJSON geometries derived from polygons + circles (for spatial query). */
  geometries: CapGeometry[];
  /** <geocode> key/value pairs (e.g. district codes used by EWS). */
  geocodes: CapGeocode[];
}

/** One CAP <info> element. */
export interface CapInfo {
  language: string;
  category: string[];
  event: string;
  responseType?: string[];
  urgency: CapUrgency;
  severity: CapSeverity;
  certainty: CapCertainty;
  audience?: string;
  eventCode: CapGeocode[];
  effective?: string;
  onset?: string;
  expires?: string;
  senderName?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  contact?: string;
  areas: CapArea[];
}

/** Fully parsed CAP alert ready for downstream modules. */
export interface CapAlert {
  identifier: string;
  sender: string;
  sent: string;
  status: CapStatus;
  msgType: CapMsgType;
  source?: string;
  scope: CapScope;
  restriction?: string;
  addresses?: string;
  code: string[];
  note?: string;
  references?: string;
  incidents?: string;
  /** Candidate info blocks in document order. */
  infos: CapInfo[];
  /** The selected info block (first matching CAP_PREFERRED_LANGUAGE). */
  info: CapInfo;
  /** Raw XML text that produced this alert (retained for the audit trail). */
  rawXml: string;
}

/** Time-derived values computed at parse time. */
export interface CapTiming {
  expiresAt: Date | null;
  effectiveAt: Date | null;
  onsetAt: Date | null;
}
