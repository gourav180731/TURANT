/**
 * Deterministic PRNGs used by the telecom simulation.
 *
 * A single seed (SIM_SEED) drives every random choice so a dataset is fully
 * reproducible — which is what makes seeding resumable and tests deterministic
 * without storing any seed state. All generators use mulberry32 (fast, good
 * distribution for statistical sampling). Nothing here uses Math.random().
 */

/** mulberry32 — tiny, fast, 32-bit seeded PRNG. Returns a float in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer PRNG in [min, max] inclusive. */
export function makeRangeInt(rand: () => number, min: number, max: number): () => number {
  const span = max - min + 1;
  return () => min + Math.floor(rand() * span);
}

/** Pick one element from an array (weighted by `weight` when provided). */
export function pickWeighted<T extends { weight: number }>(rand: () => number, items: readonly T[]): T {
  let total = 0;
  for (const item of items) total += item.weight;
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle<T>(rand: () => number, input: readonly T[]): T[] {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
