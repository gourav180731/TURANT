import type pg from 'pg';
import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import type { CellTower, GeoZone } from '../../types/tower.js';
import { getLogger } from '../../utils/logger.js';
import type { SubscriberMatch, SubscriberMatcher } from '../../pipeline/subscriber-matcher.js';
import { buildSubscriberCellQuery } from './subscriber-cell-sql.js';

const logger = getLogger();

/**
 * PostgresSubscriberCellMatcher — two-stage, cell-indexed matching for the real
 * C-DOT subscriber dump (modules 03/04, requirement #4).
 *
 * The two stages:
 *   1. Module 02 already runs polygon → cells and hands over the resolved
 *      towers (each carrying a `cellId`).
 *   2. This matcher turns those cell ids into ONE indexed lookup against the
 *      dump's B-tree indexed `cell_id` column (`col = ANY($1::text[])`) — a
 *      point-to-index seek that never scans the 100M-row dump geometry.
 *
 * `pool` is injectable for tests (mirrors the real `getPool()` connection). A
 * transaction-bound `SET LOCAL statement_timeout` keeps the lookup bounded the
 * same way the polygon matcher does: an oversized zone must halt visibly, not
 * hang the pipeline.
 */
export class PostgresSubscriberCellMatcher implements SubscriberMatcher {
  readonly name = 'c-dot:subscriber-dump:cell-indexed';

  constructor(
    private readonly cfg: ParsedEnvConfig = loadConfig(),
    private readonly pool: pg.Pool = getPool(),
  ) {}

  async matchSubscribers(
    towers: readonly CellTower[],
    ctx: { alertId: string; capIdentifier: string; zone?: GeoZone },
  ): Promise<SubscriberMatch[]> {
    const cellIds = Array.from(new Set(towers.map((t) => t.cellId).filter((c) => c)));

    if (cellIds.length === 0) {
      logger.warn({ ...ctx, towers: towers.length }, 'subscriber.cell.no_cells');
      return [];
    }

    const client = await this.pool.connect();
    try {
      // `SET LOCAL statement_timeout` only bounds the following statement inside
      // an explicit transaction (same discipline as the polygon matcher).
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${this.cfg.MATCH_TIME_BUDGET_MS}`);
      const { text, values } = buildSubscriberCellQuery(
        this.cfg,
        cellIds,
        this.cfg.SUBSCRIBER_DUMP_MATCH_LIMIT,
      );
      const started = performance.now();
      const result = await client.query<{ msisdn: string }>(text, values);
      await client.query('COMMIT');
      const elapsedMs = performance.now() - started;
      const msisdns = result.rows.map((r) => r.msisdn);
      logger.info(
        {
          cells: cellIds.length,
          matched: msisdns.length,
          elapsedMs,
          table: this.cfg.SUBSCRIBER_DUMP_TABLE,
        },
        'subscriber.cell.query',
      );
      return [{ towerId: 'cells', msisdns }];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}