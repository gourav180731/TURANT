import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config/env.js';
import { getSubscriberMatcher, resetSubscriberMatcher } from '../src/pipeline/subscriber-matcher.js';
import { TelecomSimSubscriberMatcher } from '../src/telecom/matcher/telecom-subscriber-matcher.js';
import { InMemorySubscriberRepository } from '../src/telecom/repositories/in-memory-subscriber-repository.js';
import { TelecomSimulator, createSubscriberRepository } from '../src/telecom/services/simulator.js';
import { getTowerStore } from '../src/telecom/tower-store.js';
import type { TelecomSubscriber } from '../src/telecom/entities/telecom-subscriber.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cap-delhi-ncr.xml');
const fixtureXml = readFileSync(fixturePath, 'utf8');

beforeAll(() => {
  process.env.USE_DUMMY_SUBSCRIBER_DB = 'true';
  process.env.SUBSCRIBER_DB_MODE = 'memory';
  process.env.DUMMY_TOWER_COUNT = '200';
  process.env.DUMMY_SUBSCRIBER_COUNT = '5000';
  process.env.SEED_BATCH_SIZE = '1000';
  process.env.ACTIVE_SUBSCRIBER_PCT = '85';
  process.env.MIN_USERS_PER_TOWER = '10';
  process.env.MAX_USERS_PER_TOWER = '500';
  process.env.SIM_SEED = '20260902';
  process.env.PARALLEL_EXECUTION_MODE = 'inline';
  process.env.ENABLE_DEBUG_ENDPOINTS = 'true';
  resetConfig();
});

afterAll(() => {
  delete process.env.USE_DUMMY_SUBSCRIBER_DB;
  delete process.env.SUBSCRIBER_DB_MODE;
  delete process.env.DUMMY_TOWER_COUNT;
  delete process.env.DUMMY_SUBSCRIBER_COUNT;
  delete process.env.SEED_BATCH_SIZE;
  delete process.env.ACTIVE_SUBSCRIBER_PCT;
  delete process.env.MIN_USERS_PER_TOWER;
  delete process.env.MAX_USERS_PER_TOWER;
  delete process.env.SIM_SEED;
  delete process.env.PARALLEL_EXECUTION_MODE;
  delete process.env.ENABLE_DEBUG_ENDPOINTS;
  resetSubscriberMatcher();
  resetConfig();
});

describe('telecom — simulator boot (memory mode)', () => {
  it('generates towers + subscribers and registers the matcher', async () => {
    const sim = new TelecomSimulator();
    const result = await sim.boot();

    expect(result.mode).toBe('memory');
    expect(result.towers).toBe(200);
    expect(result.subscribers).toBe(5000);

    // Module 02 can resolve towers from the in-memory store.
    expect(getTowerStore().size).toBe(200);

    // Modules 03/04 are now connected — the pipeline can continue.
    const matcher = getSubscriberMatcher();
    expect(matcher).toBeInstanceOf(TelecomSimSubscriberMatcher);
    expect(matcher!.name).toBe('telecom-sim');

    // The subscriber repository is fully seeded.
    const repo = createSubscriberRepository();
    expect(await repo.count()).toBe(5000);
  });

  it('matches subscribers by tower (modules 03/04 contract)', async () => {
    const sim = new TelecomSimulator();
    await sim.boot();
    const matcher = getSubscriberMatcher()!;

    const towers = getTowerStore()
      .all()
      .slice(0, 20)
      .map((t) => ({ id: t.siteId, cellId: t.cellId, latitude: t.latitude, longitude: t.longitude, coverageRadiusM: t.coverageRadiusM }));

    const matches = await matcher.matchSubscribers(towers, { alertId: 'a1', capIdentifier: 'c1' });
    expect(matches).toHaveLength(20);
    expect(matches.every((m) => Array.isArray(m.msisdns))).toBe(true);
    const matched = matches.reduce((n, m) => n + m.msisdns.length, 0);
    expect(matched).toBeGreaterThan(0);

    // Every MSISDN returned must be a valid Indian number.
    for (const m of matches) {
      for (const msisdn of m.msisdns) {
        expect(msisdn).toMatch(/^91[6-9]\d{9}$/);
      }
    }
  });
});

describe('telecom — matcher unit behaviour', () => {
  it('returns one match per tower, even when a cell has no subscribers', async () => {
    const repo = new InMemorySubscriberRepository();
    const a: TelecomSubscriber = {
      id: '1', imsi: '404685509376597', msisdn: '919868419126', imei: '359098967046943',
      cellId: '9C81', towerId: '12977', lac: '0451', technology: 'LTE', status: 'ACTIVE',
      attachTime: new Date(), lastSeen: new Date(), roamingStatus: 'HOME', emergencyCapable: true,
      volteEnabled: true, vonrEnabled: false, deviceVendor: 'SAMSUNG', deviceModel: 'Galaxy A14',
      simOperator: 'MTNL', homePlmn: '404-68', apn: 'internet', ipv4: '100.64.0.1',
      registrationState: 'REGISTERED', createdAt: new Date(), updatedAt: new Date(),
    };
    await repo.upsertSubscribers([a]);

    const matcher = new TelecomSimSubscriberMatcher(repo);
    const matches = await matcher.matchSubscribers(
      [
        { id: '12977', cellId: '9C81', latitude: 28.6, longitude: 77.2, coverageRadiusM: 1000 },
        { id: '99999', cellId: 'NOPE', latitude: 28.6, longitude: 77.2, coverageRadiusM: 1000 },
      ],
      { alertId: 'a2', capIdentifier: 'c2' },
    );

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ towerId: '12977', msisdns: ['919868419126'] });
    expect(matches[1]).toEqual({ towerId: '99999', msisdns: [] });
  });
});

describe('telecom — end-to-end pipeline over HTTP (memory mode, no database)', () => {
  let server: import('node:http').Server | undefined;

  beforeAll(async () => {
    resetConfig();
    const { app } = await import('../src/index.js');
    server = app.listen(0);
    await once(server, 'listening');
    // Boot the simulation exactly as startServer() does in production.
    await new TelecomSimulator().boot();
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('runs 01 → 02 → 03/04 → 05 → 13 and completes with matched recipients', async () => {
    const { port } = server!.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const post = await fetch(`${base}/api/v1/alerts/cap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: fixtureXml,
    });
    expect(post.status).toBe(202);
    const body = (await post.json()) as {
      capIdentifier: string;
      pipeline: { statusUrl: string };
    };

    type Status = {
      status: string;
      stage?: string;
      towerCount?: number;
      expectedRecipients?: number;
      submittedCount?: number;
      haltedAt?: string;
      reason?: string;
    };
    let status: Status | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}${body.pipeline.statusUrl}`);
      status = (await res.json()) as Status;
      if (status.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // The full chain ran against the simulated network — no fabrication, no DB.
    expect(status?.status).toBe('completed');
    expect(status?.stage).toBe('done');
    expect(status!.towerCount!).toBeGreaterThan(0);
    expect(status!.expectedRecipients!).toBeGreaterThan(0);
    // No SMSC configured → every matched recipient is *attempted* through the
    // real submission leg (which reports awaiting credentials rather than
    // inventing deliveries), so the attempted count equals the deduped total.
    expect(status!.submittedCount!).toBe(status!.expectedRecipients!);
  });
});
