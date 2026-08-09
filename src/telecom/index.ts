/**
 * Telecom simulation layer — a synthetic but structurally-valid subscriber /
 * tower network that stands in for the C-DOT subscriber database (modules
 * 03/04) until the real one is connected.
 *
 * Layering:
 *   entities/    — TelecomSubscriber, TelecomCellTower, location areas
 *   generators/  — deterministic PRNG, identities, towers, subscribers
 *   repositories/— SubscriberRepository contract + memory/Postgres adapters
 *   matcher/     — TelecomSimSubscriberMatcher (pipeline modules 03/04 wiring)
 *   seeders/     — Postgres DDL + deterministic idempotent seeder
 *   services/    — TelecomSimulator bootstrapping
 *   tower-store.ts — in-memory tower store (module 02 memory tower source)
 */

export { TelecomSimulator, createSubscriberRepository } from './services/simulator.js';
export type { SimBootResult } from './services/simulator.js';
export { TelecomSimSubscriberMatcher } from './matcher/telecom-subscriber-matcher.js';
export { PostgresSubscriberDumpMatcher } from './matcher/subscriber-dump-matcher.js';
export { PostgresSubscriberCellMatcher } from './matcher/subscriber-cell-matcher.js';
export { buildSubscriberDumpZoneQuery } from './matcher/subscriber-dump-sql.js';
export { buildSubscriberCellQuery } from './matcher/subscriber-cell-sql.js';
export { getTowerStore, InMemoryTowerStore } from './tower-store.js';
export { createTelecomSimDebugRoutes } from './debug-routes.js';
export * from './entities/telecom-subscriber.js';
export * from './entities/cell-tower.js';
export * from './entities/location-area.js';
export * from './generators/prng.js';
export * from './generators/identity.js';
export * from './generators/geography.js';
export * from './generators/device-catalog.js';
export * from './generators/tower-generator.js';
export * from './generators/subscriber-generator.js';
export * from './repositories/index.js';
export * from './seeders/index.js';
