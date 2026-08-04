import { describe, expect, it } from 'vitest';
import { DELHI_NCR_AREAS } from '../src/telecom/generators/geography.js';
import {
  createIdentityGenerator,
  isValidImei,
  isValidImsi,
  isValidMsisdn,
} from '../src/telecom/generators/identity.js';
import { makeRangeInt, mulberry32, pickWeighted, shuffle } from '../src/telecom/generators/prng.js';
import {
  generateSubscribers,
  planTowerAllocation,
  subscriberBatchSeed,
} from '../src/telecom/generators/subscriber-generator.js';
import { generateTowers } from '../src/telecom/generators/tower-generator.js';

const techPct = { GSM: 20, UMTS: 20, LTE: 40, NR5G: 20 };

function towers(count = 200): ReturnType<typeof generateTowers> {
  return generateTowers({ count, techPct, seed: 20260902 }, mulberry32(20260902));
}

describe('telecom — PRNG determinism', () => {
  it('reproduces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(Array.from({ length: 20 }, () => a())).toEqual(Array.from({ length: 20 }, () => b()));
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });

  it('makeRangeInt stays within bounds', () => {
    const rand = mulberry32(7);
    const next = makeRangeInt(rand, 3, 7);
    for (let i = 0; i < 500; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it('pickWeighted prefers heavier items', () => {
    const rand = mulberry32(9);
    const picks = Array.from({ length: 1000 }, () =>
      pickWeighted(rand, [
        { weight: 9, tag: 'heavy' },
        { weight: 1, tag: 'light' },
      ]).tag,
    );
    expect(picks.filter((p) => p === 'heavy').length).toBeGreaterThan(850);
  });

  it('shuffle keeps all elements', () => {
    const rand = mulberry32(11);
    const shuffled = shuffle(rand, [1, 2, 3, 4, 5]);
    expect(shuffled.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('telecom — identity generators', () => {
  it('produces structurally-valid IMSI / MSISDN / IMEI', () => {
    const gen = createIdentityGenerator('404', '68', mulberry32(123), 0);
    for (let i = 0; i < 500; i++) {
      const imsi = gen.nextImsi();
      const msisdn = gen.nextMsisdn();
      const imei = gen.nextImei();
      expect(isValidImsi(imsi)).toBe(true);
      expect(isValidMsisdn(msisdn)).toBe(true);
      expect(isValidImei(imei)).toBe(true);
      expect(imsi).toMatch(/^40468\d{10}$/);
    }
  });

  it('is unique over a large range without shared state', () => {
    const gen = createIdentityGenerator('404', '68', mulberry32(321), 0);
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      const imsi = gen.nextImsi();
      expect(seen.has(imsi)).toBe(false);
      seen.add(imsi);
    }
  });

  it('parallel workers with disjoint offsets never collide', () => {
    const genA = createIdentityGenerator('404', '68', mulberry32(1), 0);
    const genB = createIdentityGenerator('404', '68', mulberry32(2), 1000);
    const a = Array.from({ length: 1000 }, () => genA.nextImsi());
    const b = Array.from({ length: 1000 }, () => genB.nextImsi());
    const all = new Set([...a, ...b]);
    expect(all.size).toBe(2000);
  });
});

describe('telecom — tower generation', () => {
  it('generates the requested count with unique cell ids', () => {
    const result = towers(500);
    expect(result).toHaveLength(500);
    expect(new Set(result.map((t) => t.cellId)).size).toBe(500);
    expect(new Set(result.map((t) => t.siteId)).size).toBe(500);
  });

  it('honors the configured RAT distribution', () => {
    const result = towers(2000);
    const byTech = new Map<string, number>();
    for (const t of result) byTech.set(t.technology, (byTech.get(t.technology) ?? 0) + 1);
    expect(byTech.get('GSM')! / 2000).toBeCloseTo(0.2, 1);
    expect(byTech.get('UMTS')! / 2000).toBeCloseTo(0.2, 1);
    expect(byTech.get('LTE')! / 2000).toBeCloseTo(0.4, 1);
    expect(byTech.get('NR5G')! / 2000).toBeCloseTo(0.2, 1);
  });

  it('keeps every tower inside the region with valid coverage', () => {
    const result = towers(1000);
    const lats = DELHI_NCR_AREAS.map((a) => a.latitude);
    const lngs = DELHI_NCR_AREAS.map((a) => a.longitude);
    for (const t of result) {
      expect(t.latitude).toBeGreaterThan(Math.min(...lats) - 0.1);
      expect(t.latitude).toBeLessThan(Math.max(...lats) + 0.1);
      expect(t.longitude).toBeGreaterThan(Math.min(...lngs) - 0.1);
      expect(t.longitude).toBeLessThan(Math.max(...lngs) + 0.1);
      expect(t.coverageRadiusM).toBeGreaterThan(0);
      expect(t.maxUsers).toBeGreaterThan(0);
      expect(t.powerStatus).toBe('ON');
    }
  });

  it('is deterministic for the same seed (tower identity + geometry)', () => {
    const a = generateTowers({ count: 100, techPct, seed: 99 }, mulberry32(99));
    const b = generateTowers({ count: 100, techPct, seed: 99 }, mulberry32(99));
    const key = (t: (typeof a)[number]) => `${t.cellId}|${t.latitude}|${t.longitude}|${t.technology}`;
    expect(a.map(key)).toEqual(b.map(key));
  });
});

describe('telecom — subscriber generation', () => {
  const towerSet = towers(100);

  it('allocates subscribers per tower within [min, max] summing to the total', () => {
    const alloc = planTowerAllocation(towerSet, 10_000, 10, 500);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(10_000);
    for (const n of alloc) {
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(500);
    }
  });

  it('produces valid, internally-consistent subscribers', () => {
    const rand = mulberry32(2026);
    const rows = generateSubscribers({
      count: 2000,
      towers: towerSet,
      activePct: 85,
      minPerTower: 10,
      maxPerTower: 500,
      rand,
      offset: 0,
    });
    expect(rows).toHaveLength(2000);
    const byCell = new Map<string, number>();
    const now = Date.now();
    const hours48 = 48 * 3600 * 1000;
    let active = 0;

    for (const row of rows) {
      // Identity validity + uniqueness.
      expect(isValidImsi(row.imsi)).toBe(true);
      expect(isValidMsisdn(row.msisdn)).toBe(true);
      expect(isValidImei(row.imei)).toBe(true);
      // last_seen within 48h of generation.
      expect(now - row.lastSeen.getTime()).toBeGreaterThanOrEqual(0);
      expect(now - row.lastSeen.getTime()).toBeLessThanOrEqual(hours48);
      // Subscriber RAT always matches its attached tower's RAT.
      const tower = towerSet.find((t) => t.cellId === row.cellId);
      expect(tower).toBeDefined();
      expect(row.technology).toBe(tower!.technology);
      expect(row.lac).toBe(tower!.lac);
      if (row.status === 'ACTIVE') active += 1;
      byCell.set(row.cellId, (byCell.get(row.cellId) ?? 0) + 1);
    }

    expect(active / rows.length).toBeGreaterThan(0.7);
    expect(active / rows.length).toBeLessThan(0.95);
    expect(new Set(rows.map((r) => r.imsi)).size).toBe(2000);
    expect(byCell.size).toBeGreaterThan(20);
  });

  it('derives a per-batch seed so batches are deterministic and reproducible', () => {
    const randA = mulberry32(subscriberBatchSeed(20260902, 3));
    const randB = mulberry32(subscriberBatchSeed(20260902, 3));
    const a = generateSubscribers({ count: 50, towers: towerSet, activePct: 85, minPerTower: 10, maxPerTower: 500, rand: randA, offset: 300 });
    const b = generateSubscribers({ count: 50, towers: towerSet, activePct: 85, minPerTower: 10, maxPerTower: 500, rand: randB, offset: 300 });
    expect(a.map((r) => r.imsi)).toEqual(b.map((r) => r.imsi));
    expect(a.map((r) => r.msisdn)).toEqual(b.map((r) => r.msisdn));
  });
});
