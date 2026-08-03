import { XMLParser } from 'fast-xml-parser';
import type {
  CapAlert,
  CapArea,
  CapCertainty,
  CapCoordinate,
  CapGeocode,
  CapInfo,
  CapMsgType,
  CapScope,
  CapSeverity,
  CapStatus,
  CapTiming,
  CapUrgency,
} from '../../types/cap.js';
import { parseCapCoordinate } from '../../utils/geometry.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

/**
 * CAP elements that may legally repeat. `isArray` guarantees these are always
 * arrays in the parsed tree, which keeps downstream normalization uniform.
 */
const REPEATABLE_TAGS = new Set([
  'info',
  'category',
  'eventCode',
  'parameter',
  'resource',
  'area',
  'polygon',
  'circle',
  'geocode',
  'code',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // handle both <alert> and <cap:alert> documents
  parseTagValue: false, // keep all values as strings; we coerce explicitly
  trimValues: true,
  isArray: (name: string) => REPEATABLE_TAGS.has(name),
  processEntities: true, // decode entities with the built-in expansion limits
});

/** Raised for any malformed / non-conforming CAP input. */
export class CapParseError extends Error {
  constructor(message: string, readonly context?: string) {
    super(context ? `${message} (context: ${context})` : message);
    this.name = 'CapParseError';
  }
}

const SEVERITIES: CapSeverity[] = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const URGENCIES: CapUrgency[] = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];
const CERTAINTIES: CapCertainty[] = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'];
const STATUSES: CapStatus[] = ['Actual', 'Exercise', 'System', 'Test', 'Draft'];
const MSG_TYPES: CapMsgType[] = ['Alert', 'Update', 'Cancel', 'Ack', 'Error'];
const SCOPES: CapScope[] = ['Public', 'Restricted', 'Private'];

export interface ParseCapOptions {
  /** Preferred info language, e.g. "en-IN". First matching info wins. */
  preferredLanguage?: string;
}

type JsonNode = Record<string, unknown>;

/** Parse a raw CAP XML document (ITU-T X.1303 / CAP 1.2) into a CapAlert. */
export function parseCapXml(xml: string, options: ParseCapOptions = {}): CapAlert {
  const trimmed = xml.trim();
  if (!trimmed) throw new CapParseError('Empty CAP XML document');

  let doc: unknown;
  try {
    doc = xmlParser.parse(trimmed);
  } catch (err) {
    throw new CapParseError(`XML syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const alertNode = extractAlertNode(doc);
  const alert = normalizeAlert(alertNode, trimmed, options.preferredLanguage);
  return alert;
}

/** Pull the <alert> node, tolerating namespace prefixes and wrapper roots. */
function extractAlertNode(doc: unknown): JsonNode {
  if (typeof doc !== 'object' || doc === null) throw new CapParseError('Document root is not an object');
  const root = doc as JsonNode;
  for (const key of ['alert', 'Alert', 'cap', 'CAP']) {
    if (root[key] && typeof root[key] === 'object') return root[key] as JsonNode;
  }
  throw new CapParseError('No <alert> root element found in CAP document');
}

function normalizeAlert(node: JsonNode, rawXml: string, preferredLanguage?: string): CapAlert {
  const identifier = requiredString(node, 'identifier');
  const sender = requiredString(node, 'sender');
  const sent = requiredString(node, 'sent');
  const status = requiredEnum(node, 'status', STATUSES);
  const msgType = requiredEnum(node, 'msgType', MSG_TYPES);
  const scope = enumString(node, 'scope', SCOPES, 'Public');
  const code = stringArray(node, 'code');

  const infos = (asArray(node, 'info') as JsonNode[]).map(normalizeInfo);
  if (infos.length === 0) throw new CapParseError('CAP <info> element is required', identifier);

  const info = selectInfo(infos, preferredLanguage);

  const alert: CapAlert = {
    identifier,
    sender,
    sent,
    status,
    msgType,
    source: optionalString(node, 'source'),
    scope,
    restriction: optionalString(node, 'restriction'),
    addresses: optionalString(node, 'addresses'),
    code,
    note: optionalString(node, 'note'),
    references: optionalString(node, 'references'),
    incidents: optionalString(node, 'incidents'),
    infos,
    info,
    rawXml,
  };

  return alert;
}

function normalizeInfo(node: JsonNode): CapInfo {
  const language = optionalString(node, 'language') ?? 'en-US';
  const category = stringArray(node, 'category');
  const event = requiredString(node, 'event');
  const urgency = enumString(node, 'urgency', URGENCIES, 'Unknown');
  const severity = enumString(node, 'severity', SEVERITIES, 'Unknown');
  const certainty = enumString(node, 'certainty', CERTAINTIES, 'Unknown');

  const info: CapInfo = {
    language,
    category: category.length > 0 ? category : ['Unknown'],
    event,
    responseType: stringArrayOrUndefined(node, 'responseType'),
    urgency,
    severity,
    certainty,
    audience: optionalString(node, 'audience'),
    eventCode: geocodeList(node, 'eventCode'),
    effective: optionalString(node, 'effective'),
    onset: optionalString(node, 'onset'),
    expires: optionalString(node, 'expires'),
    senderName: optionalString(node, 'senderName'),
    headline: optionalString(node, 'headline'),
    description: optionalString(node, 'description'),
    instruction: optionalString(node, 'instruction'),
    contact: optionalString(node, 'contact'),
    areas: (asArray(node, 'area') as JsonNode[]).map(normalizeArea),
  };

  return info;
}

function normalizeArea(node: JsonNode): CapArea {
  const areaDesc = optionalString(node, 'areaDesc') ?? '';

  const polygons = (asArray(node, 'polygon') as unknown as string[]).map((text) =>
    text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(parseCapCoordinate),
  );

  const circles = (asArray(node, 'circle') as unknown as string[]).map((text) => {
    const [centerToken, radiusToken] = text.trim().split(/\s+/);
    if (!centerToken || !radiusToken) throw new CapParseError(`Malformed CAP <circle>: "${text}"`);
    const center = parseCapCoordinate(centerToken);
    const radiusKm = Number(radiusToken);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
      throw new CapParseError(`Malformed CAP <circle> radius: "${radiusToken}"`);
    }
    return { center, radiusMeters: radiusKm * 1000 };
  });

  return {
    areaDesc,
    polygons,
    circles,
    geometries: [
      ...polygons.map((ring) => ({ type: 'Polygon' as const, coordinates: [ring] })),
      ...circles.map(({ center, radiusMeters }) => ({ type: 'Circle' as const, center, radiusMeters })),
    ],
    geocodes: geocodeList(node, 'geocode'),
  };
}

/** Pick the info block matching the preferred language prefix; fall back to first. */
export function selectInfo(infos: CapInfo[], preferredLanguage?: string): CapInfo {
  if (!preferredLanguage) return infos[0]!;
  const lang = preferredLanguage.toLowerCase();
  const primary = lang.split('-')[0]!;
  const match =
    infos.find((i) => i.language.toLowerCase() === lang) ??
    infos.find((i) => i.language.toLowerCase().startsWith(`${primary}-`));
  if (!match) {
    logger.warn({ preferredLanguage, available: infos.map((i) => i.language) }, 'CAP preferred language not present; using first info block');
    return infos[0]!;
  }
  return match;
}

/** Parse CAP date-time strings (RFC 822/ISO) to Date; null on malformed. */
export function parseCapTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Compute timing fields used by expiry control (module 06) and validity (module 08). */
export function capTiming(alert: CapAlert): CapTiming {
  const info = alert.info;
  return {
    expiresAt: parseCapTimestamp(info.expires),
    effectiveAt: parseCapTimestamp(info.effective),
    onsetAt: parseCapTimestamp(info.onset),
  };
}

// ---- small node access helpers -------------------------------------------------

function asArray(node: JsonNode, key: string): unknown[] {
  const v = node[key];
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function requiredString(node: JsonNode, key: string): string {
  const v = node[key];
  if (typeof v === 'string' && v.length > 0) return v;
  throw new CapParseError(`CAP field <${key}> is required`);
}

function optionalString(node: JsonNode, key: string): string | undefined {
  const v = node[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stringArray(node: JsonNode, key: string): string[] {
  return asArray(node, key)
    .map((v) => (typeof v === 'string' ? v : ''))
    .filter((v) => v.length > 0);
}

function stringArrayOrUndefined(node: JsonNode, key: string): string[] | undefined {
  const arr = stringArray(node, key);
  return arr.length > 0 ? arr : undefined;
}

function enumString<T extends string>(
  node: JsonNode,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = optionalString(node, key);
  if (!v) {
    logger.warn({ field: key }, `CAP field <${key}> missing; using fallback "${fallback}"`);
    return fallback;
  }
  if ((allowed as readonly string[]).includes(v)) return v as T;
  logger.warn({ field: key, value: v }, `CAP field <${key}> has non-standard value; using fallback`);
  return fallback;
}

function requiredEnum<T extends string>(node: JsonNode, key: string, allowed: readonly T[]): T {
  const v = optionalString(node, key);
  if (!v) throw new CapParseError(`CAP field <${key}> is required`);
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new CapParseError(`CAP field <${key}> has invalid value "${v}"`);
}

function geocodeList(node: JsonNode, key: string): CapGeocode[] {
  return (asArray(node, key) as JsonNode[])
    .map((entry) => ({
      valueName: optionalString(entry, 'valueName') ?? '',
      value: optionalString(entry, 'value') ?? '',
    }))
    .filter((g) => g.valueName.length > 0 || g.value.length > 0);
}
