/**
 * Module 01 — CAP XML Ingestion (requirement #1).
 *
 * - cap-parser.ts : fast-xml-parser based parser for ITU-T X.1303 / CAP 1.2
 * - cap-schema.ts : zod runtime validation of the parsed model
 * - service.ts    : ingest pipeline (parse -> validate -> persist -> audit)
 * - routes.ts     : push endpoint  POST /api/v1/alerts/cap
 * - poller.ts     : optional directory poller for file-based delivery
 */

export { CapIngestionService, capIdentifierOf } from './service.js';
export type { IngestResult } from './service.js';
export { parseCapXml, capTiming, parseCapTimestamp, CapParseError } from './cap-parser.js';
export type { ParseCapOptions } from './cap-parser.js';
export { capAlertSchema } from './cap-schema.js';
export { createCapIngestionRoutes } from './routes.js';
export type { CapIngestionRouteOptions } from './routes.js';
export { CapDirectoryPoller } from './poller.js';
export type { CapDirectoryPollerOptions } from './poller.js';
