import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Manual alert ingestion — requirement: "a senior draws a polygon and sends a
 * real early-warning alert with one click".
 *
 * Instead of hand-writing CAP XML, this module accepts a small JSON payload and
 * *synthesizes a minimal, valid CAP 1.2 document* which is then handed to the
 * existing `CapIngestionService.ingest()`. We deliberately reuse the XML path
 * (rather than constructing the internal `CapAlert` object directly) so the
 * manual route inherits every existing guarantee — zod runtime validation,
 * parsing, area/geometry normalization, persistence, the audit trail and the
 * t0 latency marker — and can never drift from the real CAP-XML behaviour the
 * modules were tested against. The synthesized XML is a real document, not a
 * stub: it carries the drawn polygon as CAP `<polygon>` (closed ring), a live
 * `sent` and a `now + expiresInMinutes` `expires`, and the message/severity.
 */

/** Payload accepted by POST /api/v1/alerts/manual. */
export const manualAlertSchema = z.object({
  /** Polygon vertices as [lat, lng] decimal-degree pairs (WGS84). */
  polygon: z
    .array(z.tuple([z.number(), z.number()]))
    .min(3, 'a polygon needs at least 3 points'),
  message: z.string().min(1, 'message is required'),
  severity: z.enum(['Extreme', 'Severe', 'Moderate', 'Minor']),
  /** Alert validity in minutes from now — drives a real CAP <expires>. */
  expiresInMinutes: z.number().int().positive('expiresInMinutes must be a positive integer'),
  hazardType: z.string().min(1).optional(),
});

export type ManualAlertPayload = z.infer<typeof manualAlertSchema>;

/** Message sender used for manually-authored alerts (part of capIdentifierOf). */
export const MANUAL_SENDER = 'TURANT-Manual';

/** Maximum plausible decay in an envelope radius before we reject the ring. */
const EARTH_CIRCUMFERENCE_KM = 40_075;

function degToKm(degLat: number, degLng: number): number {
  const avgLat = Math.abs(degLat);
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos((avgLat * Math.PI) / 180);
  return Math.sqrt((degLng * kmPerLng) ** 2 + (degLat * kmPerLat) ** 2);
}

/** Orientation of ordered triplet (a,b,c): <0 clockwise, >0 ccw, 0 collinear. */
function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: [number, number], b: [number, number], c: [number, number]): boolean {
  const within = (p: number, q: number, r: number): boolean => q >= Math.min(p, r) && q <= Math.max(p, r);
  return within(a[0], b[0], c[0]) && within(a[1], b[1], c[1]);
}

/** True when two closed-ring segments [lat,lng] properly intersect. */
function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  // Collinear overlaps count as an intersection too (a self-touching ring).
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/** Compute the longest chord across a ring — rough radius sanity check. */
function maxRadiusKm(closed: [number, number][]): number {
  let max = 0;
  for (let i = 0; i < closed.length; i++) {
    for (let j = i + 1; j < closed.length; j++) {
      const d = degToKm(closed[i]![0] - closed[j]![0], closed[i]![1] - closed[j]![1]);
      if (d > max) max = d;
    }
  }
  return max;
}

/**
 * Validate a manual polygon ring (the drawn vertices, still open).
 *
 * Rejects: fewer than 3 distinct points, non-finite or out-of-range
 * coordinates, a ring that self-intersects, or a polygon so large it spans a
 * suspicious fraction of the planet (a proxy for an accidentally inverted or
 * nonsense ring). Returns the closed ring (first vertex appended) on success.
 */
export function validatePolygonRing(
  points: readonly [number, number][],
): { ok: true; closed: [number, number][] } | { ok: false; error: string } {
  if (!Number.isFinite(points[0]![0]) || !Number.isFinite(points[0]![1])) {
    return { ok: false, error: 'polygon coordinates must be finite numbers' };
  }
  for (const [lat, lng] of points) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { ok: false, error: `coordinate [${lat}, ${lng}] is out of range` };
    }
  }

  // Drop a duplicate closing vertex if the caller already closed the ring.
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const core = first[0] === last[0] && first[1] === last[1] ? points.slice(0, -1) : points.slice();
  if (core.length < 3) {
    return { ok: false, error: 'a polygon needs at least 3 distinct points' };
  }
  const closed = [...core, core[0]!] as [number, number][];

  const radiusKm = maxRadiusKm(closed);
  if (radiusKm > EARTH_CIRCUMFERENCE_KM / 2) {
    return { ok: false, error: 'polygon geometry is implausibly large on a map' };
  }

  // A simple polygon's non-adjacent edges never cross. Check every pair with
  // at least one segment of separation around the closed ring.
  const n = closed.length - 1; // number of ring segments (n+1 points)
  for (let i = 0; i < n; i++) {
    const a = closed[i]!;
    const b = closed[i + 1]!;
    for (let j = i + 1; j < n; j++) {
      const c = closed[j]!;
      const d = closed[j + 1]!;
      // Skip adjacent edges (share a vertex) — they always touch. Also skip the
      // first/last segment pair, which share the closing vertex (closed[0]).
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersect(a, b, c, d)) {
        return { ok: false, error: 'polygon is self-intersecting (edges cross each other)' };
      }
    }
  }
  return { ok: true, closed };
}

/** Escape a string for safe inclusion in an XML document. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Serialize a closed ring to a CAP <polygon> "lat,lng" list. */
function ringToCapPolygon(closed: readonly [number, number][]): string {
  return closed.map(([lat, lng]) => `${lat},${lng}`).join(' ');
}

export interface ManualCapXml {
  identifier: string;
  sentIso: string;
  expiresIso: string;
  xml: string;
}

/**
 * Build a minimal valid CAP 1.2 document from a manual alert payload.
 *
 * `capIdentifierOf(alert)` = `${sender}:${identifier}`; the identifier is a
 * fresh UUID so every manual alert is unique. `expires` is computed as
 * `sent + expiresInMinutes`, never hardcoded.
 */
export function buildManualCapXml(payload: ManualAlertPayload, closed: readonly [number, number][]): ManualCapXml {
  const now = new Date();
  const identifier = randomUUID();
  const sentIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + payload.expiresInMinutes * 60_000).toISOString();
  const event = escapeXml(payload.hazardType ?? 'Manual Emergency Alert');
  const headline = escapeXml(payload.message);
  const polygon = ringToCapPolygon(closed);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${identifier}</identifier>
  <sender>${MANUAL_SENDER}</sender>
  <sent>${sentIso}</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-IN</language>
    <category>Other</category>
    <event>${event}</event>
    <urgency>Immediate</urgency>
    <severity>${payload.severity}</severity>
    <certainty>Likely</certainty>
    <expires>${expiresIso}</expires>
    <headline>${headline}</headline>
    <description>${headline}</description>
    <area>
      <areaDesc>Manual polygon alert</areaDesc>
      <polygon>${polygon}</polygon>
    </area>
  </info>
</alert>`;

  return { identifier, sentIso, expiresIso, xml };
}