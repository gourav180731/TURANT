import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/env.js';
import { buildSubscriberCellQuery } from '../src/telecom/matcher/subscriber-cell-sql.js';
import { PostgresSubscriberCellMatcher } from '../src/telecom/matcher/subscriber-cell-matcher.js';
import type { CellTower } from '../src/types/tower.js';

afterEach(() => {
  delete process.env.SUBSCRIBER_DUMP_TABLE;
  delete process.env.SUBSCRIBER_DUMP_MSISDN_COL;
  delete process.env.SUBSCRIBER_DUMP_CELL_COL;
  delete process.env.SUBSCRIBER_DUMP_LOOKUP_MODE;
  delete process.env.SUBSCRIBER_DUMP_MATCH_LIMIT;
  delete process.env.MATCH_TIME_BUDGET_MS;
  resetConfig();
});

describe('two-stage cell-indexed dump — SQL builder (pure, no DB)', () => {
  it('builds an index-accelerated lookup by cell_id = ANY with a single bind param', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.SUBSCRIBER_DUMP_MSISDN_COL = 'msisdn';
    process.env.SUBSCRIBER_DUMP_CELL_COL = 'cell_id';
    resetConfig();

    const { text, values } = buildSubscriberCellQuery(loadConfig(), ['cell-a', 'cell-b', 'cell-a'], 500);

    expect(text).toContain('FROM subscriber_dump');
    expect(text).toContain('cell_id = ANY($1::text[])');
    expect(text).toContain('SELECT DISTINCT msisdn AS msisdn');
    expect(text).toContain('LIMIT 500');
    // De-duplicated cell ids in a single text[] bind value; no per-cell params.
    expect(values).toHaveLength(1);
    expect(values[0]).toEqual(['cell-a', 'cell-b']);
  });

  it('honors a custom cell column name', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.SUBSCRIBER_DUMP_CELL_COL = 'lac_ci';
    resetConfig();
    const { text } = buildSubscriberCellQuery(loadConfig(), ['1234'], 1);
    expect(text).toContain('lac_ci = ANY($1::text[])');
  });

  it('defaults the cell column to the FK-bound serving_cell_id', () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    delete process.env.SUBSCRIBER_DUMP_CELL_COL;
    resetConfig();
    const { text } = buildSubscriberCellQuery(loadConfig(), ['10000'], 1);
    expect(text).toContain('serving_cell_id = ANY($1::text[])');
    expect(loadConfig().SUBSCRIBER_DUMP_LOOKUP_MODE).toBe('cell-indexed');
  });
});

describe('two-stage cell-indexed dump — matcher wiring (fake pool)', () => {
  const cfg = () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.SUBSCRIBER_DUMP_MSISDN_COL = 'msisdn';
    process.env.SUBSCRIBER_DUMP_CELL_COL = 'cell_id';
    process.env.SUBSCRIBER_DUMP_MATCH_LIMIT = '1000';
    process.env.MATCH_TIME_BUDGET_MS = '60000';
    resetConfig();
    return loadConfig();
  };

  const tower = (id: string, cellId: string): CellTower => ({ id, cellId, latitude: 28.6, longitude: 77.2 });

  function buildPool(
    rows: { msisdn: string }[],
    statsOverrides?: Partial<{ matched_rows: string; unique_msisdns: string; target_cells: string; resolved_cells: string; unmatched_cells: string }>,
  ) {
    const calls: string[] = [];
    const defaultMatched = String(rows.length);
    const defaultUnique = String(rows.length);
    const statsRow = {
      target_cells: statsOverrides?.target_cells ?? '1',
      resolved_cells: statsOverrides?.resolved_cells ?? '1',
      unmatched_cells: statsOverrides?.unmatched_cells ?? '0',
      matched_rows: statsOverrides?.matched_rows ?? defaultMatched,
      unique_msisdns: statsOverrides?.unique_msisdns ?? defaultUnique,
    };
    const client = {
      query: vi.fn(async (sql: string | { text: string }) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        calls.push(text);
        // Dispatch probe: EXISTS check for cell_subscriber_stats → return 0
        // so that resolveStatsQuery picks the legacy dump path (same data shape).
        if (/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+.*cell_subscriber_stats/i.test(text)) {
          return { rows: [{ n: '0' }] };
        }
        // NO-FABRICATION path: the unbounded stats CTE returns one row via the
        // `counts` CTE, shape = {target_cells, resolved_cells, unmatched_cells,
        // matched_rows, unique_msisdns}.
        if (text.includes('SELECT * FROM counts')) {
          return { rows: [statsRow] };
        }
        return { rows };
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

  it('returns [] without touching the DB when no tower carries a cell_id', async () => {
    const pool = buildPool([]);
    const matcher = new PostgresSubscriberCellMatcher(cfg(), pool as unknown as import('pg').Pool);
    const result = await matcher.matchSubscribers([tower('t1', '')], { alertId: 'a', capIdentifier: 'c' });
    expect(result).toEqual([]);
    expect(pool.releases()).toBe(0);
  });

  it('turns resolved towers into an indexed lookup and returns their MSISDNs', async () => {
    const pool = buildPool([{ msisdn: '919999000001' }, { msisdn: '919999000002' }]);
    const matcher = new PostgresSubscriberCellMatcher(cfg(), pool as unknown as import('pg').Pool);

    const result = await matcher.matchSubscribers(
      [tower('t1', 'cell-a'), tower('t2', 'cell-b')],
      { alertId: 'a', capIdentifier: 'c' },
    );

    expect(result).toEqual([
      {
        towerId: 'cells',
        msisdns: ['919999000001', '919999000002'],
        rawMatchedRows: 2,
        uniqueSubscribers: 2,
      },
    ]);
    // One transaction-bound query: BEGIN, timeout SET, the indexed lookup, COMMIT.
    expect(pool.calls.some((c) => c.includes('BEGIN'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('SET LOCAL statement_timeout = 60000'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('cell_id = ANY($1::text[])'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('COMMIT'))).toBe(true);
    expect(pool.releases()).toBe(1);
  });

  it('NO-FABRICATION RULE — reports the UNBOUNDED stats counts even when materialisation is LIMIT-capped', async () => {
    // The DB says 42 matched rows / 40 distinct MSISDNs across the three cells,
    // but SUBSCRIBER_DUMP_MATCH_LIMIT=1000 materialises only the 2 rows in the
    // fake result set. The reported matchSubscribers() result MUST reflect the
    // database (42/40), never the truncated materialised list length (2).
    const pool = buildPool(
      [
        { msisdn: '919999000001' },
        { msisdn: '919999000002' },
      ],
      {
        target_cells: '3',
        resolved_cells: '3',
        unmatched_cells: '0',
        matched_rows: '42',
        unique_msisdns: '40',
      },
    );
    const matcher = new PostgresSubscriberCellMatcher(cfg(), pool as unknown as import('pg').Pool);
    const result = await matcher.matchSubscribers(
      [tower('t1', 'cell-a'), tower('t2', 'cell-b'), tower('t3', 'cell-c')],
      { alertId: 'a', capIdentifier: 'c' },
    );

    expect(result).toEqual([
      {
        towerId: 'cells',
        msisdns: ['919999000001', '919999000002'],
        rawMatchedRows: 42,
        uniqueSubscribers: 40,
      },
    ]);
    // The unbounded stats CTE must be present and carry NO LIMIT clause.
    const statsText = pool.calls.find((c) => c.includes('SELECT * FROM counts'));
    expect(statsText).toBeDefined();
    expect(statsText).not.toContain('LIMIT');
    // The materialisation query carries the configured cap (SUBSCRIBER_DUMP_MATCH_LIMIT=1000).
    expect(pool.calls.some((c) => c.includes('LIMIT 1000'))).toBe(true);
  });

  it('releases the client even when the query throws (ROLLBACK path)', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('cell_id')) throw new Error('timeout exceeded');
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client, client };
    void pool;
    const matcher = new PostgresSubscriberCellMatcher(
      cfg(),
      pool as unknown as import('pg').Pool,
    );

    await expect(
      matcher.matchSubscribers([tower('t1', 'cell-a')], { alertId: 'a', capIdentifier: 'c' }),
    ).rejects.toThrow('timeout exceeded');

    expect(pool.client.release.mock.calls.length).toBe(1);
  });
});

describe('cell-indexed dump — benchmark matchCells contract (fake pool)', () => {
  const cfg = () => {
    process.env.SUBSCRIBER_DUMP_TABLE = 'subscriber_dump';
    process.env.SUBSCRIBER_DUMP_MSISDN_COL = 'msisdn';
    process.env.SUBSCRIBER_DUMP_CELL_COL = 'serving_cell_id';
    process.env.MATCH_TIME_BUDGET_MS = '60000';
    resetConfig();
    return loadConfig();
  };

  const statsRow = (overrides: Record<string, unknown> = {}) => ({
    target_cells: '3',
    resolved_cells: '3',
    unmatched_cells: '0',
    matched_rows: '42',
    unique_msisdns: '40',
    ...overrides,
  });

  function buildPool(rows: Record<string, unknown>[]) {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: unknown) => {
        const text = typeof sql === 'string' ? sql : String((sql as { text: string }).text);
        calls.push(text);
        if (text.includes('SELECT * FROM counts')) return { rows };
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

  it('returns the zero shape without touching the DB for an empty cell set', async () => {
    const pool = buildPool([]);
    const matcher = new PostgresSubscriberCellMatcher(cfg(), pool as unknown as import('pg').Pool);
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

  it('reports the true benchmark shape for an index-seek lookup', async () => {
    const pool = buildPool([statsRow()]);
    const matcher = new PostgresSubscriberCellMatcher(cfg(), pool as unknown as import('pg').Pool);
    const result = await matcher.matchCells(
      ['10000', '10001', '10002', '10000'],
      { alertId: 'a' },
    );
    expect(pool.calls.some((c) => c.includes('serving_cell_id = ANY($1::text[])'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('SET LOCAL statement_timeout = 60000'))).toBe(true);
    expect(result).toMatchObject({
      targetCellCount: 3,
      resolvedCellCount: 3,
      unresolvedCellCount: 0,
      subscriberMatchCount: 42,
      uniqueMsisdnCount: 40,
      mappingIncomplete: false,
    });
    expect(pool.releases()).toBe(1);
  });

  it('flags mappingIncomplete when a target cell has no subscribers', async () => {
    const pool = buildPool([statsRow({ resolved_cells: '2', unmatched_cells: '1' })]);
    const matcher = new PostgresSubscriberCellMatcher(cfg(), pool as unknown as import('pg').Pool);
    const result = await matcher.matchCells(['10000', '10001', '10002'], { alertId: 'a' });
    expect(result.mappingIncomplete).toBe(true);
    expect(result.unresolvedCellCount).toBe(1);
  });
});