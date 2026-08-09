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

  function buildPool(rows: { msisdn: string }[]) {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
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

    expect(result).toEqual([{ towerId: 'cells', msisdns: ['919999000001', '919999000002'] }]);
    // One transaction-bound query: BEGIN, timeout SET, the indexed lookup, COMMIT.
    expect(pool.calls.some((c) => c.includes('BEGIN'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('SET LOCAL statement_timeout = 60000'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('cell_id = ANY($1::text[])'))).toBe(true);
    expect(pool.calls.some((c) => c.includes('COMMIT'))).toBe(true);
    expect(pool.releases()).toBe(1);
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