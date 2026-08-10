import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/env.js';
import {
  buildStageCellIdsSql,
  buildLoadTargetCellsSql,
  buildMatchStatsSql,
  buildStreamRecipientsSql,
} from '../src/telecom/matcher/cell-subscriber-bridge-sql.js';
import { CellSubscriberBridgeMatcher } from '../src/telecom/matcher/cell-subscriber-bridge-matcher.js';

afterEach(() => {
  delete process.env.CELL_SUBSCRIBER_MAPPING_TABLE;
  delete process.env.CELL_NETWORK_MAPPING_TABLE;
  delete process.env.SUBSCRIBER_DUMP_TABLE;
  resetConfig();
});

describe('cell→(lac,cisac) bridge — SQL builders (pure, no DB)', () => {
  it('stages a per-session temp table for the target cell ids', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildStageCellIdsSql(loadConfig());
    expect(text).toContain('CREATE TEMP TABLE IF NOT EXISTS turant_target_cells');
    expect(text).toContain('UNIQUE (cell_id)');
    expect(text).toContain('ON COMMIT DROP');
  });

  it('bulk-loads the target cells deduplicated on the way in', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text, values } = buildLoadTargetCellsSql(loadConfig(), ['10000', '10001', '10000']);
    expect(text).toContain('INSERT INTO turant_target_cells');
    expect(text).toContain('ON CONFLICT (cell_id) DO NOTHING');
    expect(values).toEqual(['10000', '10001']);
  });

  it('renders the resolve+match stats over the mapping + dump composite key', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildMatchStatsSql(loadConfig());
    expect(text).toContain('FROM turant_target_cells');
    expect(text).toContain('JOIN cell_network_mapping m');
    expect(text).toContain('ON m.cell_id = t.cell_id');
    expect(text).toContain('JOIN subscriber_dump s');
    expect(text).toContain('ON s.lac = r.lac');
    expect(text).toContain('AND s.cisac = r.cisac');
    expect(text).toContain('COUNT(DISTINCT s.msisdn)');
    expect(text).toContain('AS unresolved_cells');
  });

  it('renders the stream statement as a deduplicated recipient cursor', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildStreamRecipientsSql(loadConfig());
    expect(text).toContain('SELECT DISTINCT s.msisdn AS msisdn');
    expect(text).toContain('JOIN cell_network_mapping m');
    expect(text).toContain('JOIN subscriber_dump s');
    expect(text).toContain('ON s.lac = m.lac');
    expect(text).toContain('AND s.cisac = m.cisac');
    expect(text).toContain('WHERE s.msisdn IS NOT NULL');
  });

  it('returns a no-op statement when there are no cell ids to stage', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text, values } = buildLoadTargetCellsSql(loadConfig(), []);
    expect(text).toContain('WHERE false');
    expect(values).toEqual([]);
  });

  it('uses the canonical cell_network_mapping table by default', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildMatchStatsSql(loadConfig());
    expect(text).toContain('JOIN cell_network_mapping m');
    expect(text).not.toContain('JOIN cell_subscriber_mapping m');
  });

  it('honours a deployment-pinned custom mapping table name', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.CELL_NETWORK_MAPPING_TABLE = 'prod_cell_master';
    resetConfig();
    const { text } = buildMatchStatsSql(loadConfig());
    expect(text).toContain('JOIN prod_cell_master m');
  });

  it('resolves the cell → (lac,cisac) composite key (duplicate elimination at DB level)', () => {
    // The pipeline passes polygon-resolved cell ids that may repeat across
    // towers; the staging INSERT deduplicates ON CONFLICT and the stream
    // SELECT DISTINCT removes duplicate MSISDNs from overlapping areas.
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    resetConfig();
    const { text } = buildStreamRecipientsSql(loadConfig());
    expect(text).toContain('SELECT DISTINCT s.msisdn AS msisdn');
    expect(text).toContain('JOIN cell_network_mapping m');
    expect(text).toContain('ON m.cell_id = t.cell_id');
    expect(text).toContain('ON s.lac = m.lac');
    expect(text).toContain('AND s.cisac = m.cisac');
    expect(text).toContain('WHERE s.msisdn IS NOT NULL');
  });
});

describe('cell→(lac,cisac) bridge matcher — benchmark contract (fake pool)', () => {
  const cfg = () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.CELL_NETWORK_MAPPING_TABLE = 'cell_network_mapping';
    process.env.MATCH_TIME_BUDGET_MS = '60000';
    resetConfig();
    return loadConfig();
  };

  const toSql = (sql: unknown): string => (typeof sql === 'string' ? sql : String((sql as { text: string }).text));

  function buildPool(statsRows: Record<string, unknown>[]) {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: unknown) => {
        const text = toSql(sql);
        calls.push(text);
        if (text.includes('SELECT * FROM counts')) return { rows: statsRows };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client,
      client,
      calls,
      releases: () => client.release.mock.calls.length,
    };
    return pool;
  }

  it('returns [] without touching the DB for an empty cell set', async () => {
    const pool = buildPool([]);
    const matcher = new CellSubscriberBridgeMatcher(cfg(), pool as unknown as import('pg').Pool);
    const result = await matcher.matchCells([], { alertId: 'a' });
    expect(result).toEqual({
      targetCellCount: 0,
      resolvedCellCount: 0,
      unresolvedCellCount: 0,
      subscriberMatchCount: 0,
      uniqueMsisdnCount: 0,
      elapsedMs: 0,
      mappingIncomplete: false,
    });
    expect(pool.releases()).toBe(0);
  });

  it('stages deduplicated cells and reports the true benchmark shape (50k acceptance)', async () => {
    const pool = buildPool([
      {
        target_cells: '50000',
        resolved_cells: '50000',
        unresolved_cells: '0',
        resolved_areas: '34835',
        matched_rows: '3159936',
        unique_msisdns: '3154485',
      },
    ]);
    const matcher = new CellSubscriberBridgeMatcher(cfg(), pool as unknown as import('pg').Pool);
    const dup = Array.from({ length: 50_000 }, (_, i) => `cell-${i}`);
    dup.push('cell-0'); // duplicate must be eliminated by staging

    const result = await matcher.matchCells(dup, { alertId: 'a' });

    expect(pool.calls.some((c) => c.includes('CREATE TEMP TABLE IF NOT EXISTS turant_target_cells'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('ON CONFLICT (cell_id) DO NOTHING'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('JOIN cell_network_mapping m'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('SET LOCAL statement_timeout = 60000'))).toBe(true);
    expect(result).toMatchObject({
      targetCellCount: 50_000,
      resolvedCellCount: 50_000,
      unresolvedCellCount: 0,
      subscriberMatchCount: 3_159_936,
      uniqueMsisdnCount: 3_154_485,
      mappingIncomplete: false,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(60_000);
  });

  it('flags mappingIncomplete when resolvedCells < targetCells (partial coverage is honest)', async () => {
    const pool = buildPool([
      {
        target_cells: '100',
        resolved_cells: '73',
        unresolved_cells: '27',
        matched_rows: '17131',
        unique_msisdns: '17131',
      },
    ]);
    const matcher = new CellSubscriberBridgeMatcher(cfg(), pool as unknown as import('pg').Pool);
    const result = await matcher.matchCells(
      Array.from({ length: 100 }, (_, i) => `${10000 + i}`),
      { alertId: 'a' },
    );
    expect(result.mappingIncomplete).toBe(true);
    expect(result.unresolvedCellCount).toBe(27);
  });

  it('releases the client even when the stats query throws (ROLLBACK path)', async () => {
    const client = {
      query: vi.fn(async (sql: unknown) => {
        if (toSql(sql).includes('SELECT * FROM counts')) throw new Error('timeout exceeded');
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client, client, calls: [] };
    void pool;
    const matcher = new CellSubscriberBridgeMatcher(cfg(), pool as unknown as import('pg').Pool);
    await expect(matcher.matchCells(['cell-a'], { alertId: 'a' })).rejects.toThrow('timeout exceeded');
    expect(pool.client.release.mock.calls.length).toBe(1);
  });
});
