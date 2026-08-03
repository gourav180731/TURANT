import { z } from 'zod';
import type { CapAlert } from '../../types/cap.js';

/**
 * Runtime validation schema for the parsed CAP alert model.
 *
 * TypeScript interfaces give compile-time safety; this schema gives a
 * defensive runtime check at the ingestion boundary so malformed documents
 * never enter the downstream pipeline with corrupted fields.
 */

const capCoordinate = z.object({
  lat: z.number(),
  lng: z.number(),
});

const capPolygonGeometry = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(capCoordinate)),
});

const capCircleGeometry = z.object({
  type: z.literal('Circle'),
  center: capCoordinate,
  radiusMeters: z.number().nonnegative(),
});

const capGeometry = z.discriminatedUnion('type', [capPolygonGeometry, capCircleGeometry]);

const capGeocode = z.object({
  valueName: z.string(),
  value: z.string(),
});

const capArea = z.object({
  areaDesc: z.string(),
  polygons: z.array(z.array(capCoordinate)),
  circles: z.array(z.object({ center: capCoordinate, radiusMeters: z.number().nonnegative() })),
  geometries: z.array(capGeometry),
  geocodes: z.array(capGeocode),
});

const capInfo = z.object({
  language: z.string(),
  category: z.array(z.string()),
  event: z.string(),
  responseType: z.array(z.string()).optional(),
  urgency: z.enum(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']),
  severity: z.enum(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']),
  certainty: z.enum(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']),
  audience: z.string().optional(),
  eventCode: z.array(capGeocode),
  effective: z.string().optional(),
  onset: z.string().optional(),
  expires: z.string().optional(),
  senderName: z.string().optional(),
  headline: z.string().optional(),
  description: z.string().optional(),
  instruction: z.string().optional(),
  contact: z.string().optional(),
  areas: z.array(capArea),
});

export const capAlertSchema = z.object({
  identifier: z.string().min(1),
  sender: z.string().min(1),
  sent: z.string().min(1),
  status: z.enum(['Actual', 'Exercise', 'System', 'Test', 'Draft']),
  msgType: z.enum(['Alert', 'Update', 'Cancel', 'Ack', 'Error']),
  source: z.string().optional(),
  scope: z.enum(['Public', 'Restricted', 'Private']),
  restriction: z.string().optional(),
  addresses: z.string().optional(),
  code: z.array(z.string()),
  note: z.string().optional(),
  references: z.string().optional(),
  incidents: z.string().optional(),
  infos: z.array(capInfo),
  info: capInfo,
  rawXml: z.string(),
});

export type ValidatedCapAlert = z.infer<typeof capAlertSchema>;
export type { CapAlert };
