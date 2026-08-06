import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/config/env.js';
import { parseCapXml } from '../src/modules/01-cap-ingestion/cap-parser.js';
import { capIdentifierOf, CapIngestionService } from '../src/modules/01-cap-ingestion/service.js';
import { TowerResolver } from '../src/modules/02-cell-site-identification/resolver.js';
import type { TowerSource } from '../src/modules/02-cell-site-identification/tower-source.js';
import { runAlertPipeline } from '../src/pipeline/alert-pipeline.js';
import { traceStore } from '../src/tracing/trace-store.js';
import type { CellTower } from '../src/types/tower.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cap.xml');
const fixtureXml = readFileSync(fixturePath, 'utf8');

// Real IMD Patna CAP alert (identifier 1756825900862016, 2025-09-02). Kept
// byte-for-byte as received from IMD so the pipeline is proven against real,
// large multi-polygon input with IMD's non-standard enum values.
const imdFixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imd-patna-2025-09-02.xml');
const imdFixtureXml = readFileSync(imdFixturePath, 'utf8');

// Run the whole file in the honest "no tower DB" state regardless of any local
// .env on the machine running it. Otherwise a real .env (DATABASE_URL set +
// SUBSCRIBER_DB_MODE=postgres) would make the direct `ingest()` calls open a
// real Postgres pool — persisting into the alerts table and leaking a live
// pool into the HTTP tests below. SUBSCRIBER_DB_MODE must not be 'postgres'
// here: the fail-fast config rejects that mode without a DATABASE_URL.
process.env.DATABASE_URL = '';
process.env.USE_DUMMY_SUBSCRIBER_DB = 'false';
process.env.SUBSCRIBER_DB_MODE = 'memory';
delete process.env.SUBSCRIBER_DUMP_TABLE;
resetConfig();

const fakeTowerSource: TowerSource = {
  name: 'fake',
  async findTowersInZone(): Promise<CellTower[]> {
    return [{ id: 't1', cellId: 'C1', latitude: 28, longitude: 84.5, coverageRadiusM: 1000 }];
  },
};

/** Simulates the real module 02 failure when DATABASE_URL is not configured. */
const missingDbTowerSource: TowerSource = {
  name: 'postgis',
  async findTowersInZone(): Promise<CellTower[]> {
    throw new Error('DATABASE_URL is not configured. Add the real C-DOT PostGIS connection string to .env.');
  },
};

describe('pipeline integration — direct (ingestion service + pipeline)', () => {
  it('marks t0+t1 and halts at subscriber matching (awaiting real subscriber data)', async () => {
    const service = new CapIngestionService();
    const ingested = await service.ingest(fixtureXml);

    const result = await runAlertPipeline({
      alert: ingested.alert,
      capIdentifier: ingested.capIdentifier,
      alertId: ingested.alertId,
      resolver: new TowerResolver(),
      source: fakeTowerSource,
    });

    // t0 (module 01) and t1 (module 02) both land on the shared latency trace.
    const trace = await traceStore.snapshot(ingested.capIdentifier);
    expect(trace?.points.t0).toBeDefined();
    expect(trace?.points.t1).toBeDefined();
    expect(trace?.points.t1?.label).toBe('cell.match');

    // The real chain reached module 02, then halted loudly — modules 03/04
    // have no real data source, so nothing is fabricated.
    expect(result.status).toBe('halted');
    expect(result.haltedAt).toBe('subscriber-matching');
    expect(result.reason).toMatch(/awaiting subscriber data — modules 03\/04 not yet connected/);
    expect(result.towerCount).toBe(1);
  });

  it('halts at tower resolution when the tower source fails (DATABASE_URL missing), without crashing', async () => {
    const service = new CapIngestionService();
    const ingested = await service.ingest(fixtureXml);

    // Simulates the real PostGIS path when DATABASE_URL is not configured.
    const result = await runAlertPipeline({
      alert: ingested.alert,
      capIdentifier: ingested.capIdentifier,
      alertId: ingested.alertId,
      resolver: new TowerResolver(),
      source: missingDbTowerSource,
    });

    // The pipeline catches the source error, reports it loudly, and does not
    // continue to later stages — and it never throws out of the ingest request.
    expect(result.status).toBe('halted');
    expect(result.haltedAt).toBe('tower-resolution');
    expect(result.reason).toMatch(/DATABASE_URL is not configured/);
  });

  it('handles the real IMD Patna CAP alert end-to-end (10 polygons, non-standard enums, Hindi headline)', async () => {
    const service = new CapIngestionService();
    const ingested = await service.ingest(imdFixtureXml);

    // Real identity from the actual file — never a synthetic value.
    expect(ingested.capIdentifier).toBe('IMD Patna:1756825900862016');
    expect(ingested.alert.sender).toBe('IMD Patna');

    // All 10 real polygons survive ingestion as matchable geometries.
    expect(ingested.alert.info.areas).toHaveLength(1);
    const area = ingested.alert.info.areas[0]!;
    expect(area.polygons).toHaveLength(10);
    expect(area.geometries).toHaveLength(10);
    expect(area.polygons.some((p) => p.length > 1000)).toBe(true);

    // IMD emits non-CAP-standard values (ALERT / Very Likely); the parser
    // reports them loudly and never fabricates a value in their place.
    expect(ingested.alert.info.severity).toBe('Unknown');
    expect(ingested.alert.info.certainty).toBe('Unknown');
    expect(ingested.alert.info.urgency).toBe('Expected');

    // The real Hindi headline/instruction must survive intact (UTF-8).
    expect(ingested.alert.info.headline).toContain('बक्सर');
    expect(ingested.alert.info.instruction).toBe('Please follow SDMA guidelines.');

    const result = await runAlertPipeline({
      alert: ingested.alert,
      capIdentifier: ingested.capIdentifier,
      alertId: ingested.alertId,
      resolver: new TowerResolver(),
      source: fakeTowerSource,
    });

    expect(result.status).toBe('halted');
    expect(result.haltedAt).toBe('subscriber-matching');
    expect(result.towerCount).toBe(1);
    expect(result.reason).toMatch(/awaiting subscriber data — modules 03\/04 not yet connected/);
  });
});

describe('pipeline integration — real HTTP entrypoint', () => {
  let server: import('node:http').Server | undefined;

  beforeAll(async () => {
    // Force the honest "tower DB not connected" state so the test is
    // deterministic regardless of any local .env on the machine running it
    // (re-affirms the file-scope env above).
    process.env.DATABASE_URL = '';
    process.env.TOWER_SOURCE_MODE = 'postgis';
    process.env.USE_DUMMY_SUBSCRIBER_DB = 'false';
    process.env.SUBSCRIBER_DB_MODE = 'memory';
    resetConfig();
  });

  it("marks the run halted (not stuck running) when the registered subscriber matcher throws", async () => {
    // A throwing subscriber matcher models a real failure — e.g. the
    // subscriber_dump query exceeding its time budget. The pipeline must
    // surface a visible halted status (with the real reason) instead of leaving
    // the run stuck at "running/subscriber-matching" forever.
    process.env.DATABASE_URL = '';
    process.env.TOWER_SOURCE_MODE = 'postgis';
    process.env.USE_DUMMY_SUBSCRIBER_DB = 'true';
    process.env.SUBSCRIBER_DB_MODE = 'memory';
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();

    const { registerSubscriberMatcher, resetSubscriberMatcher } = await import('../src/pipeline/subscriber-matcher.js');
    const throwing: Parameters<typeof registerSubscriberMatcher>[0] = {
      name: 'test-throwing',
      async matchSubscribers(): Promise<never> {
        throw new Error('subscriber dump query timed out (statement_timeout)');
      },
    };
    registerSubscriberMatcher(throwing);

    try {
      const service = new CapIngestionService();
      const ingested = await service.ingest(fixtureXml);
      const result = await runAlertPipeline({
        alert: ingested.alert,
        capIdentifier: ingested.capIdentifier,
        alertId: ingested.alertId,
        resolver: new TowerResolver(),
        source: fakeTowerSource,
      });
      expect(result.status).toBe('halted');
      expect(result.haltedAt).toBe('subscriber-matching');
      expect(result.reason).toMatch(/statement_timeout/);
    } finally {
      resetSubscriberMatcher();
      delete process.env.SUBSCRIBER_DUMP_TABLE;
      process.env.USE_DUMMY_SUBSCRIBER_DB = 'false';
      resetConfig();
    }
  });

  afterAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.TOWER_SOURCE_MODE;
    delete process.env.USE_DUMMY_SUBSCRIBER_DB;
    delete process.env.SUBSCRIBER_DB_MODE;
    resetConfig();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('POSTs a real CAP alert and reports the pipeline halt through the status endpoint', async () => {
    // Import the real app AFTER the env is forced, so the pipeline's config
    // (loaded lazily at run time) reflects the intended test state.
    const { app } = await import('../src/index.js');

    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const post = await fetch(`${base}/api/v1/alerts/cap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: fixtureXml,
    });
    expect(post.status).toBe(202);
    const body = (await post.json()) as {
      capIdentifier: string;
      pipeline: { status: string; stage: string; statusUrl: string };
    };
    expect(body.capIdentifier).toBe(capIdentifierOf(parseCapXml(fixtureXml)));
    expect(body.pipeline.status).toBe('running');
    expect(body.pipeline.stage).toBe('ingested');
    expect(body.pipeline.statusUrl).toContain('/pipeline-status');

    // Poll the pipeline-status endpoint until the asynchronous pipeline settles.
    type Status = { status: string; haltedAt?: string; reason?: string; traceRef?: string };
    let status: Status | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}${body.pipeline.statusUrl}`);
      status = (await res.json()) as Status;
      if (status.status === 'halted') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Without DATABASE_URL the real module 02 halts the pipeline loudly and the
    // endpoint surfaces the real reason — visible to a caller, not just logs.
    expect(status?.status).toBe('halted');
    expect(status?.haltedAt).toBe('tower-resolution');
    expect(status?.reason).toMatch(/DATABASE_URL is not configured/);
    expect(status?.traceRef).toContain('/traces/');
  });
});
