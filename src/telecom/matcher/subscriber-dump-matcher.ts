import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import type { SubscriberMatch, SubscriberMatcher } from '../../pipeline/subscriber-matcher.js';
import type { CellTower, GeoZone } from '../../types/tower.js';
import { getLogger } from '../../utils/logger.js';
import { buildSubscriberDumpZoneQuery } from './subscriber-dump-sql.js';

const logger = getLogger();

/**
 * Real C-DOT subscriber-dump matcher (modules 03/04, requirement #4).
 *
 * Matches subscribers by **point-in-polygon** against the dump's geometry
 * column (`geom`, POINT 4326, GiST-indexed) using the same alert zone that
 * resolved the towers — the accurate direct path. It replaces the sim's
 * `TelecomSimSubscriberMatcher` when `SUBSCRIBER_DUMP_TABLE` is configured.
 *
 * The zone is unioned into one geometry (polygon/circle from the CAP alert)
 * and every subscriber point intersecting it is returned, deduplicated at the
 * SQL level. A DB-side statement_timeout keeps the lookup bounded.
 */
export class PostgresSubscriberDumpMatcher implements SubscriberMatcher {
  readonly name = 'c-dot:subscriber-dump';

  constructor(private readonly cfg: ParsedEnvConfig = loadConfig()) {}

  async matchSubscribers(
    _towers: readonly CellTower[],
    ctx: { alertId: string; capIdentifier: string; zone?: GeoZone },
  ): Promise<SubscriberMatch[]> {
    const zone = ctx.zone;
    if (!zone || zone.geometries.length === 0) {
      logger.warn({ ...ctx }, 'subscriber.dump.no_zone');
      return [];
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      // `SET LOCAL statement_timeout` only takes effect inside an explicit
      // transaction block. Without BEGIN it would apply to the SET statement
      // alone and never bound the actual lookup below — letting an oversized
      // polygon scan the whole dump for minutes. Wrapping in a transaction
      // makes the DB genuinely enforce the time budget.
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${this.cfg.MATCH_TIME_BUDGET_MS}`);
      const { text, values } = buildSubscriberDumpZoneQuery(this.cfg, zone, this.cfg.SUBSCRIBER_DUMP_MATCH_LIMIT);
      const started = performance.now();
      const result = await client.query<{ msisdn: string }>(text, values);
      await client.query('COMMIT');
      const elapsedMs = performance.now() - started;
      const msisdns = result.rows.map((r) => r.msisdn);
      logger.info({ matched: msisdns.length, elapsedMs, table: this.cfg.SUBSCRIBER_DUMP_TABLE }, 'subscriber.dump.query');
      return [{ towerId: 'zone', msisdns }];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
