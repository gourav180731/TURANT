import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config/env.js';
import {
  buildManualCapXml,
  validatePolygonRing,
  MANUAL_SENDER,
} from '../src/modules/01-cap-ingestion/manual-alert.js';
import { CapIngestionService } from '../src/modules/01-cap-ingestion/service.js';
import { TelecomSimulator } from '../src/telecom/services/simulator.js';

// Run the whole file in the honest "no tower DB" state regardless of any local
// .env on the machine running it (see the identical note in
// pipeline-integration.test.ts). Here we also turn the telecom sim on in
// memory so the pipeline can genuinely progress past tower-resolution and
// complete against the simulated network — no PostGIS, no real subscribers.
process.env.DATABASE_URL = '';
process.env.USE_DUMMY_SUBSCRIBER_DB = 'true';
process.env.SUBSCRIBER_DB_MODE = 'memory';
process.env.TOWER_SOURCE_MODE = 'memory';
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

/** A simple convex ring around the Delhi NCR core (matches the sim hotspot). */
const DELHI_RING: [number, number][] = [
  [28.55, 77.15],
  [28.55, 77.27],
  [28.63, 77.3],
  [28.68, 77.27],
  [28.68, 77.15],
  [28.63, 77.12],
];

describe('manual-alert — polygon validation (unit)', () => {
  it('accepts a simple convex ring and returns the closed ring', () => {
    const res = validatePolygonRing(DELHI_RING);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.closed).toHaveLength(DELHI_RING.length + 1);
    expect(res.closed[res.closed.length - 1]).toEqual(DELHI_RING[0]);
  });

  it('rejects fewer than 3 distinct points', () => {
    const res = validatePolygonRing([
      [28.6, 77.2],
      [28.7, 77.3],
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/at least 3/);
  });

  it('accepts an already-closed ring (duplicate first vertex)', () => {
    const res = validatePolygonRing([...DELHI_RING, DELHI_RING[0]!]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.closed).toHaveLength(DELHI_RING.length + 1);
  });

  it('rejects a self-intersecting bow-tie ring', () => {
    const bowTie: [number, number][] = [
      [28.6, 77.1],
      [28.7, 77.2],
      [28.7, 77.1],
      [28.6, 77.2],
    ];
    const res = validatePolygonRing(bowTie);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/self-intersecting/);
  });

  it('rejects out-of-range coordinates', () => {
    const res = validatePolygonRing([
      [28.6, 77.2],
      [91, 77.3],
      [28.7, 77.4],
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/out of range/);
  });

  it('rejects an implausibly large ring', () => {
    // Spans 358° of longitude at lat 45° → a chord far beyond half the planet.
    const res = validatePolygonRing([
      [-45, 0],
      [45, 179],
      [45, -179],
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/implausibly large/);
  });
});

describe('manual-alert — CAP 1.2 synthesis (unit)', () => {
  it('round-trips through the real CAP parser into a valid CapAlert', () => {
    const res = validatePolygonRing(DELHI_RING);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const payload = {
      polygon: DELHI_RING,
      message: 'Severe thunderstorm approaching Delhi',
      severity: 'Severe' as const,
      expiresInMinutes: 90,
      hazardType: 'Thunderstorm',
    };
    const cap = buildManualCapXml(payload, res.closed);

    // The synthesized document is a real CAP 1.2 alert the parser accepts.
    const service = new CapIngestionService();
    const alert = service.parse(cap.xml);

    expect(alert.sender).toBe(MANUAL_SENDER);
    expect(alert.identifier).toBe(cap.identifier);
    expect(alert.info.severity).toBe('Severe');
    expect(alert.info.event).toBe('Thunderstorm');
    expect(alert.info.headline).toBe('Severe thunderstorm approaching Delhi');

    // Expires is sent + expiresInMinutes, never hardcoded. `<sent>` lives at the
    // alert root; `<expires>` inside the info block.
    const expiresMs = new Date(alert.info.expires!).getTime();
    expect(expiresMs - new Date(alert.sent).getTime()).toBe(90 * 60_000);

    // The drawn polygon survives as a closed ring of cap coordinates.
    const ring = alert.info.areas[0]!.polygons[0]!;
    expect(ring).toHaveLength(DELHI_RING.length + 1);
    expect(ring[0]).toEqual({ lat: DELHI_RING[0][0], lng: DELHI_RING[0][1] });
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  it('escapes message/hazard text that could break XML', () => {
    const res = validatePolygonRing(DELHI_RING);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cap = buildManualCapXml(
      {
        polygon: DELHI_RING,
        message: 'Heavy rain <100mm> & hail "possible"',
        severity: 'Moderate' as const,
        expiresInMinutes: 30,
        hazardType: 'Rain & Hail <7>',
      },
      res.closed,
    );
    expect(cap.xml).not.toContain('<100mm>');
    expect(cap.xml).toContain('&lt;100mm&gt;');
    expect(cap.xml).not.toContain('& "possible"');
    expect(cap.xml).toContain('&quot;possible&quot;');

    const alert = new CapIngestionService().parse(cap.xml);
    expect(alert.info.event).toBe('Rain & Hail <7>');
    expect(alert.info.headline).toBe('Heavy rain <100mm> & hail "possible"');
  });
});

describe('manual-alert — supporting endpoints (sim/clusters, towers)', () => {
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

  const base = (): string => {
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  it('GET /api/v1/sim/clusters returns the configured region clusters', async () => {
    // This test file runs with the default SIM_REGION=delhi-ncr.
    const res = await fetch(`${base()}/api/v1/sim/clusters`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      region: string;
      count: number;
      clusters: { id: string; latitude: number; longitude: number; radiusKm: number }[];
    };
    expect(body.region).toBe('delhi-ncr');
    expect(body.count).toBe(1);
    expect(body.clusters[0]).toMatchObject({ id: 'delhi-ncr' });
    expect(body.clusters[0]!.radiusKm).toBeGreaterThan(0);
  });

  it('GET towers for an unknown alert returns 404', async () => {
    const res = await fetch(`${base()}/api/v1/alerts/nope%3Amissing/towers`);
    expect(res.status).toBe(404);
  });

  it('GET pipeline-status for an unknown alert returns 404', async () => {
    const res = await fetch(`${base()}/api/v1/alerts/nope%3Amissing/pipeline-status`);
    expect(res.status).toBe(404);
  });
});

describe('manual-alert — POST /api/v1/alerts/manual (end-to-end over HTTP)', () => {
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

  const base = (): string => {
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  it('accepts a valid polygon and the pipeline completes with real towers', async () => {
    const post = await fetch(`${base()}/api/v1/alerts/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygon: DELHI_RING,
        message: 'Manual flood alert for south Delhi',
        severity: 'Severe',
        expiresInMinutes: 60,
        hazardType: 'Flood',
      }),
    });
    expect(post.status).toBe(202);
    const body = (await post.json()) as {
      alertId: string;
      capIdentifier: string;
      expiresAt: string;
      duplicate: boolean;
      source: string;
      sender: string;
      pipeline: { status: string; stage: string; statusUrl: string };
    };

    expect(body.alertId).toBeTruthy();
    expect(body.capIdentifier.startsWith(`${MANUAL_SENDER}:`)).toBe(true);
    expect(body.source).toBe('manual');
    expect(body.sender).toBe(MANUAL_SENDER);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.duplicate).toBe(false);
    expect(body.pipeline.status).toBe('running');
    expect(body.pipeline.stage).toBe('ingested');

    // Poll until the pipeline completes against the simulated network.
    type Status = {
      status: string;
      stage?: string;
      towerCount?: number;
      matchedCount?: number;
      duplicatesRemoved?: number;
      expectedRecipients?: number;
      submittedCount?: number;
      haltedAt?: string;
      reason?: string;
    };
    let status: Status | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base()}${body.pipeline.statusUrl}`);
      status = (await res.json()) as Status;
      if (status.status === 'completed') break;
      if (status.status === 'halted') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(status?.status).toBe('completed');
    expect(status?.stage).toBe('done');
    expect(status!.towerCount!).toBeGreaterThan(0);
    expect(status!.matchedCount!).toBeGreaterThan(0);
    expect(status!.duplicatesRemoved!).toBeGreaterThanOrEqual(0);
    expect(status!.expectedRecipients!).toBeGreaterThan(0);
    // No SMSC credentials → awaitingCredentials=true, and submittedCount is
    // honestly 0 (nothing pushed to any SMSC), never the intended count.
    expect(status!.awaitingCredentials).toBe(true);
    expect(status!.submittedCount!).toBe(0);
  });

  it('exposes the real matched towers for the alert', async () => {
    const post = await fetch(`${base()}/api/v1/alerts/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygon: DELHI_RING,
        message: 'Second manual alert — verify towers endpoint',
        severity: 'Moderate',
        expiresInMinutes: 30,
      }),
    });
    expect(post.status).toBe(202);
    const body = (await post.json()) as { capIdentifier: string };

    // The towers endpoint only answers after tower resolution has run.
    let towers: { count: number; towers: { id: string; cellId: string; latitude: number; longitude: number }[] } | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base()}/api/v1/alerts/${encodeURIComponent(body.capIdentifier)}/towers`);
      if (res.status === 200) {
        towers = (await res.json()) as typeof towers;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(towers).toBeDefined();
    expect(towers!.count).toBeGreaterThan(0);
    expect(towers!.towers.length).toBe(towers!.count);
    // Every tower marker is a real matched tower with plausible coordinates.
    for (const t of towers!.towers) {
      expect(t.id).toBeTruthy();
      expect(t.cellId).toBeTruthy();
      expect(t.latitude).toBeGreaterThan(20);
      expect(t.latitude).toBeLessThan(32);
      expect(t.longitude).toBeGreaterThan(70);
      expect(t.longitude).toBeLessThan(90);
    }
  });

  it('rejects a 2-point polygon with 400', async () => {
    const post = await fetch(`${base()}/api/v1/alerts/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygon: [
          [28.6, 77.2],
          [28.7, 77.3],
        ],
        message: 'Too few points',
        severity: 'Severe',
        expiresInMinutes: 30,
      }),
    });
    expect(post.status).toBe(400);
    const body = (await post.json()) as { error: string; issues?: string[] };
    expect(body.error).toBe('invalid manual alert payload');
    expect(body.issues?.some((i) => /at least 3/.test(i))).toBe(true);
  });

  it('rejects a self-intersecting polygon with 400', async () => {
    const post = await fetch(`${base()}/api/v1/alerts/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygon: [
          [28.6, 77.1],
          [28.7, 77.2],
          [28.7, 77.1],
          [28.6, 77.2],
        ],
        message: 'Bow-tie is invalid',
        severity: 'Severe',
        expiresInMinutes: 30,
      }),
    });
    expect(post.status).toBe(400);
    const body = (await post.json()) as { error: string };
    expect(body.error).toMatch(/self-intersecting/);
  });

  it('rejects a missing message with 400', async () => {
    const post = await fetch(`${base()}/api/v1/alerts/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygon: DELHI_RING,
        severity: 'Severe',
        expiresInMinutes: 30,
      }),
    });
    expect(post.status).toBe(400);
    const body = (await post.json()) as { error: string; issues?: string[] };
    expect(body.error).toBe('invalid manual alert payload');
    expect(body.issues?.some((i) => /message/.test(i))).toBe(true);
  });

  it('rejects an invalid severity enum with 400', async () => {
    const post = await fetch(`${base()}/api/v1/alerts/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygon: DELHI_RING,
        message: 'Bad severity',
        severity: 'Armageddon',
        expiresInMinutes: 30,
      }),
    });
    expect(post.status).toBe(400);
  });
});
