import type { TelecomCellTower } from '../entities/cell-tower.js';
import type { TelecomSubscriber, TelecomTechnology } from '../entities/telecom-subscriber.js';
import { APN_POOL, devicesForTechnology } from './device-catalog.js';
import { createIdentityGenerator } from './identity.js';

/** Home operator of every simulated subscriber (matches the canonical C-DOT IMSI 404-68). */
export const HOME_OPERATOR = { shortName: 'MTNL', mcc: '404', mnc: '68' };

export interface SubscriberGenOptions {
  count: number;
  towers: readonly TelecomCellTower[];
  activePct: number;
  minPerTower: number;
  maxPerTower: number;
  rand: () => number;
  /** Identity counter offset — lets parallel seed workers take disjoint ranges. */
  offset?: number;
}

export interface TowerSampler {
  /** Pick a tower index for the next subscriber (weighted by allocated count). */
  nextIndex(): number;
  /** Per-tower target counts (sum == requested subscriber count). */
  allocation: readonly number[];
}

/**
 * Plan how many subscribers each tower should carry, honoring
 * MIN_USERS_PER_TOWER / MAX_USERS_PER_TOWER and weighting the remainder by
 * each tower's radio capacity (maxUsers). Returns counts summing exactly to
 * `count` when `count` is within [M*min, M*max].
 */
export function planTowerAllocation(
  towers: readonly TelecomCellTower[],
  count: number,
  minPerTower: number,
  maxPerTower: number,
): number[] {
  const M = towers.length;
  if (M === 0) return [];
  const alloc = new Array<number>(M).fill(0);
  let remaining = count;

  if (count <= M) {
    for (let i = 0; i < count; i++) alloc[i] = 1;
    return alloc;
  }

  // Fill each tower to its minimum first when the dataset is large enough.
  if (count >= M * minPerTower) {
    for (let i = 0; i < M; i++) {
      alloc[i] = minPerTower;
      remaining -= minPerTower;
    }
  } else {
    const base = Math.floor(count / M);
    let rem = count % M;
    for (let i = 0; i < M; i++) alloc[i] = base + (rem-- > 0 ? 1 : 0);
    remaining = 0;
  }

  // Distribute the remainder proportionally to tower capacity, clamped.
  if (remaining > 0) {
    const weights = towers.map((t) => t.maxUsers);
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const frac = weights.map((w) => (remaining * w) / totalWeight);
    let floor = frac.map((f) => Math.floor(f));
    let leftover = remaining - floor.reduce((a, b) => a + b, 0);
    for (let i = 0; i < leftover; i++) floor[i % M]! += 1;
    for (let i = 0; i < M; i++) {
      alloc[i]! += Math.min(maxPerTower - alloc[i]!, Math.max(0, floor[i]!));
    }
    // Exact-total correction within [min, max].
    let sum = alloc.reduce((a, b) => a + b, 0);
    let diff = count - sum;
    let guard = 0;
    while (diff !== 0 && guard < M * M) {
      const i = guard % M;
      if (diff > 0 && alloc[i]! < maxPerTower) {
        alloc[i]! += 1;
        diff -= 1;
      } else if (diff < 0 && alloc[i]! > minPerTower) {
        alloc[i]! -= 1;
        diff += 1;
      }
      guard += 1;
    }
  }
  return alloc;
}

/** Build a cumulative-weight sampler from an allocation (binary-search O(log M)). */
export function createTowerSampler(allocation: readonly number[], rand: () => number): TowerSampler {
  const prefix = new Array<number>(allocation.length);
  let acc = 0;
  for (let i = 0; i < allocation.length; i++) {
    acc += allocation[i]!;
    prefix[i] = acc;
  }
  const total = acc;
  return {
    allocation,
    nextIndex() {
      if (total <= 0) return 0;
      const r = rand() * total;
      let lo = 0;
      let hi = prefix.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (prefix[mid]! <= r) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}

function privateIpv4(rand: () => number): string {
  return `100.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`;
}

function ipv6(rand: () => number): string {
  const groups = Array.from({ length: 8 }, () =>
    Math.floor(rand() * 0x10000).toString(16).padStart(4, '0'),
  );
  return groups.join(':');
}

/** Signal metrics appropriate for each RAT. */
export interface SignalProfile {
  signalRssi?: number;
  rsrp?: number;
  rsrq?: number;
  sinr?: number;
}

/**
 * Per-batch PRNG seed: a deterministic function of (SIM_SEED, batch index), so
 * memory and Postgres modes generate byte-identical datasets for the same seed
 * and re-running a failed batch reproduces the exact same rows.
 */
export function subscriberBatchSeed(seed: number, batchIndex: number): number {
  return ((seed * 2654435761) ^ (batchIndex * 40503)) >>> 0;
}

export function signalProfileFor(technology: TelecomTechnology, rand: () => number): SignalProfile {
  switch (technology) {
    case 'GSM':
      return { signalRssi: -Math.round(50 + rand() * 70) };
    case 'UMTS':
      return { signalRssi: -Math.round(60 + rand() * 50) };
    case 'LTE':
      return { rsrp: -Math.round(70 + rand() * 60), rsrq: -Math.round(3 + rand() * 17), sinr: Math.round(rand() * 30) };
    case 'NR5G':
      return { rsrp: -Math.round(60 + rand() * 60), rsrq: -Math.round(3 + rand() * 16), sinr: Math.round(rand() * 30) };
  }
}

/**
 * Generate `opts.count` subscribers. Streaming-friendly: each call produces one
 * array of rows; the seeder discards it after inserting. Subscriber RAT always
 * matches its attached tower's RAT, so the simulated network is coherent.
 */
export function generateSubscribers(opts: SubscriberGenOptions): TelecomSubscriber[] {
  const { count, towers, activePct, minPerTower, maxPerTower, rand } = opts;
  const allocation = planTowerAllocation(towers, count, minPerTower, maxPerTower);
  const sampler = createTowerSampler(allocation, rand);
  const identities = createIdentityGenerator(HOME_OPERATOR.mcc, HOME_OPERATOR.mnc, rand, opts.offset ?? 0);

  const now = Date.now();
  const hours48 = 48 * 3600 * 1000;
  const apnPick = () => APN_POOL[Math.floor(rand() * APN_POOL.length)]!;
  const roamPct = () => rand() < 0.05;

  const rows = new Array<TelecomSubscriber>(count);
  for (let i = 0; i < count; i++) {
    const tower = towers[sampler.nextIndex()]!;
    const active = rand() * 100 < activePct;
    const lastSeen = new Date(now - Math.floor(rand() * hours48));
    const attachTime = new Date(lastSeen.getTime() - Math.floor(rand() * (72 * 3600 * 1000)));
    const roaming = roamPct();
    const devices = devicesForTechnology(tower.technology);
    const device = devices[Math.floor(rand() * devices.length)]!;
    const signal = signalProfileFor(tower.technology, rand);
    const home = HOME_OPERATOR;
    const visited = roaming && tower.operatorShortName !== home.shortName ? tower : null;
    const imsi = identities.nextImsi();
    const msisdn = identities.nextMsisdn();
    const volte = tower.technology === 'LTE' || tower.technology === 'NR5G' ? rand() < 0.85 : false;
    const vonr = tower.technology === 'NR5G' ? rand() < 0.6 : false;

    rows[i] = {
      id: imsi,
      imsi,
      msisdn,
      imei: identities.nextImei(),
      tmsi: identities.nextTmsi(),
      cellId: tower.cellId,
      towerId: tower.siteId,
      lac: tower.lac ?? '',
      tac: tower.tac,
      rncId: tower.rncId,
      enbId: tower.enbId,
      gnbId: tower.gnbId,
      sectorId: tower.sectorId,
      technology: tower.technology,
      status: active ? 'ACTIVE' : 'INACTIVE',
      attachTime,
      lastSeen,
      ...signal,
      roamingStatus: roaming && visited ? 'ROAMING' : 'HOME',
      emergencyCapable: rand() < 0.7,
      volteEnabled: volte,
      vonrEnabled: vonr,
      deviceVendor: device.vendor,
      deviceModel: device.model,
      simOperator: tower.operatorShortName,
      homePlmn: `${home.mcc}-${home.mnc}`,
      visitedPlmn: visited ? `${visited.mcc}-${visited.mnc}` : undefined,
      apn: apnPick(),
      ipv4: privateIpv4(rand),
      ipv6: ipv6(rand),
      registrationState: active ? (rand() < 0.9 ? 'REGISTERED' : 'ATTACHED') : 'DETACHED',
      pagingState: active ? (rand() < 0.6 ? 'IDLE' : 'CONNECTED') : undefined,
      mcc: home.mcc,
      mnc: home.mnc,
      operator: tower.operator,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }
  return rows;
}
