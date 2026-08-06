import type { CellTower, GeoZone } from '../types/tower.js';

/**
 * Subscriber-matching contract for modules 03/04 — requirement #3/#4.
 *
 * Modules 03/04 are PLAN.md-only: they genuinely depend on C-DOT's subscriber
 * database, which is not connected yet. The pipeline detects this by asking
 * this registry — a module is "available" only when it has actually registered
 * a real matcher. Nothing is registered today, so the pipeline always halts at
 * the subscriber-matching stage with an explicit, visible status rather than
 * inventing a subscriber list.
 *
 * When C-DOT provides the DB and modules 03/04 ship, they call
 * `registerSubscriberMatcher(...)` with a real implementation and the pipeline
 * continues past this stage with no further changes.
 */

export interface SubscriberMatch {
  /** Tower ID whose footprint produced these recipients. */
  towerId: string;
  /** Real MSISDNs inside that tower's coverage. */
  msisdns: string[];
}

export interface SubscriberMatchContext {
  alertId: string;
  capIdentifier: string;
  /**
   * The alert zone (the drawn polygon / circles). Tower-based matchers ignore
   * it; the real C-DOT dump matcher uses it for direct point-in-polygon
   * matching against the subscriber geometry column.
   */
  zone?: GeoZone;
}

export interface SubscriberMatcher {
  readonly name: string;
  matchSubscribers(
    towers: readonly CellTower[],
    ctx: SubscriberMatchContext,
  ): Promise<SubscriberMatch[]>;
}

let registered: SubscriberMatcher | null = null;

/** Modules 03/04 call this when a real implementation ships. */
export function registerSubscriberMatcher(matcher: SubscriberMatcher): void {
  registered = matcher;
}

/** The currently-registered real matcher, or null while modules 03/04 are not built. */
export function getSubscriberMatcher(): SubscriberMatcher | null {
  return registered;
}

/** Unregister the matcher (test isolation; never called by the running app). */
export function resetSubscriberMatcher(): void {
  registered = null;
}
