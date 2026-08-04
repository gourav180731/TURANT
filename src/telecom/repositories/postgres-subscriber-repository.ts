import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import type { TelecomSubscriber } from '../entities/telecom-subscriber.js';
import { buildFindByCellIdsSql, buildFindByMsisdnsSql } from './sql-builders.js';
import {
  type FindByCellIdsOptions,
  SubscriberRepositoryError,
  type SubscriberRepository,
  type SubscriberRow,
} from './subscriber-repository.js';

/**
 * Postgres subscriber repository — the sim's 1K → 300M path.
 *
 * Reads are parameterized and chunked by `SUBSCRIBER_LOOKUP_CHUNK_SIZE`.
 * Table + column names come from the SUBSCRIBER_COL_* env vars, so pointing
 * this at the real C-DOT subscriber schema is a .env change only.
 *
 * Writes (seeding) are handled by the seeder, which owns the sim's schema.
 */
export class PostgresSubscriberRepository implements SubscriberRepository {
  readonly name = 'telecom-sim:postgres';

  constructor(private readonly cfg: ParsedEnvConfig = loadConfig()) {}

  private columns() {
    const c = this.cfg;
    return {
      id: 'id',
      imsi: c.SUBSCRIBER_COL_IMSI,
      msisdn: c.SUBSCRIBER_COL_MSISDN,
      cellId: c.SUBSCRIBER_COL_CELL_ID,
      towerId: c.SUBSCRIBER_COL_TOWER_ID,
      technology: c.SUBSCRIBER_COL_TECHNOLOGY,
      status: c.SUBSCRIBER_COL_STATUS,
      lastSeen: c.SUBSCRIBER_COL_LAST_SEEN,
    };
  }

  async count(): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${this.cfg.SUBSCRIBER_TABLE}`);
    return Number(result.rows[0]?.n ?? 0);
  }

  async upsertSubscribers(rows: readonly TelecomSubscriber[]): Promise<number> {
    throw new SubscriberRepositoryError('PostgresSubscriberRepository is read-only; use the seeder to load sim data');
  }

  async findByCellIds(cellIds: readonly string[], options: FindByCellIdsOptions = {}): Promise<SubscriberRow[]> {
    const pool = getPool();
    const chunkSize = this.cfg.SUBSCRIBER_LOOKUP_CHUNK_SIZE;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const cols = this.columns();
    const out: SubscriberRow[] = [];

    for (let i = 0; i < cellIds.length; i += chunkSize) {
      const chunk = cellIds.slice(i, i + chunkSize);
      const remaining = limit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : limit - out.length;
      if (remaining <= 0) break;
      const sql = buildFindByCellIdsSql(this.cfg.SUBSCRIBER_TABLE, cols, chunk, toSqlLimit(remaining, chunkSize));
      const result = await pool.query<{
        id: string;
        imsi: string;
        msisdn: string;
        cell_id: string;
        tower_id: string | null;
        technology: string | null;
        status: string | null;
        last_seen: string | Date | null;
      }>(sql.text, sql.values);
      for (const r of result.rows) {
        out.push({
          imsi: r.imsi,
          msisdn: r.msisdn,
          cellId: r.cell_id,
          towerId: r.tower_id ?? undefined,
          technology: r.technology ?? undefined,
          status: r.status ?? undefined,
          lastSeen: typeof r.last_seen === 'string' ? new Date(r.last_seen) : r.last_seen ?? undefined,
        });
      }
    }
    return out;
  }

  async findByMsisdns(msisdns: readonly string[], options: FindByCellIdsOptions = {}): Promise<TelecomSubscriber[]> {
    const pool = getPool();
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const out: TelecomSubscriber[] = [];
    for (let i = 0; i < msisdns.length; i += this.cfg.SUBSCRIBER_LOOKUP_CHUNK_SIZE) {
      const chunk = msisdns.slice(i, i + this.cfg.SUBSCRIBER_LOOKUP_CHUNK_SIZE);
      const remaining = limit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : limit - out.length;
      if (remaining <= 0) break;
      const sql = buildFindByMsisdnsSql(this.cfg.SUBSCRIBER_TABLE, { msisdn: this.cfg.SUBSCRIBER_COL_MSISDN }, chunk, toSqlLimit(remaining, chunk.length));
      const result = await pool.query<TelecomSubscriber>(sql.text, sql.values);
      out.push(...result.rows);
    }
    return out;
  }
}

/** Resolve a JS limit to a SQL LIMIT (never above the chunk size). */
function toSqlLimit(jsLimit: number, chunkSize: number): number {
  return Number.isFinite(jsLimit) ? Math.min(jsLimit, chunkSize) : chunkSize;
}
