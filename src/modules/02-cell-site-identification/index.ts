/**
 * Module 02 — Cell Site Identification (requirement #2).
 *
 * - tower-source.ts        : TowerSource contract (adapter pattern)
 * - adapters/postgis*.ts   : direct PostGIS query (primary)
 * - adapters/http*.ts      : C-DOT API gateway path (awaiting endpoint)
 * - resolver.ts            : adapter selection + time-budget enforcement + audit
 */

export { TowerResolver } from './resolver.js';
export type { TowerSource, FindTowersOptions } from './tower-source.js';
export { PostgisTowerSource } from './adapters/postgis-tower-source.js';
export { HttpTowerSource } from './adapters/http-tower-source.js';
export { MemoryTowerSource } from './adapters/memory-tower-source.js';
export { zoneToGeoJson } from './tower-source.js';
