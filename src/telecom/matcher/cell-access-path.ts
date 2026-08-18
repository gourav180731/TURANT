import type pg from 'pg';
import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

/** Unbounded DB-derived counts for a cell set (count path, never LIMIT-capped). */
export interface CellAccessStats {
  matchedRows: number;
  uniqueSubscribers: number;
  coveredCells: number;
  uncoveredCells: number;
  mappingIncomplete: boolean;
}

/** One streaming batch of numeric subscriber ids (recipient path, Phase 8). */
export interface SubscriberIdBatch {
  ids: number[];
  /** first-batch timing hooks for the benchmark */
  elapsedMs: number;
}

export interface CellAccessPath {
  readonly name: string;
  /** Which implementation backs this path (drives the tier table). */
  readonly version: 'A' | 'B' | 'C' | 'D';
  countCells(cellIds: readonly string[]): Promise<CellAccessStats>;
  streamIds(cellIds: readonly string[], batchSize: number): AsyncIterable<SubscriberIdBatch>;
}

/**
 * Shared uncapped count path: `cell_subscriber_stats` SUM + unresolved cells
 * via LEFT JOIN against the stats table. The stats are derived from the dump
 * (migration 010 / build-cell-subscriber-access.ts) — never hard-coded.
 * unique_subscriber_count == subscriber_count because the dump has a global
 * UNIQUE msisdn index and each subscriber row maps to exactly one serving cell.
 */
async function statsCount(
  pool: pg.Pool,
  cfg: ParsedEnvConfig,
  cellIds: readonly string[],
): Promise<CellAccessStats> {
  const statsTable = cfg.CELL_SUBSCRIBER_STATS_TABLE;
  const { rows } = await pool.query<{
    matched_rows: string;
    unique_rows: string;
    covered: string;
    uncovered: string;
  }>(
    `WITH target AS (SELECT cell_id FROM unnest($1::text[]) AS t(cell_id)),
     resolved AS (
       SELECT s.cell_id, s.subscriber_count, s.unique_subscriber_count
       FROM ${statsTable} s
       JOIN target t USING (cell_id)
     )
     SELECT COALESCE((SELECT SUM(subscriber_count) FROM resolved), 0)::text AS matched_rows,
            COALESCE((SELECT SUM(unique_subscriber_count) FROM resolved), 0)::text AS unique_rows,
            (SELECT COUNT(*) FROM resolved)::text AS covered,
            (SELECT COUNT(*) FROM target t
              WHERE NOT EXISTS (SELECT 1 FROM resolved r WHERE r.cell_id = t.cell_id))::text AS uncovered`,
    [Array.from(new Set(cellIds))],
  );
  const r = rows[0];
  const covered = Number(r?.covered ?? 0);
  const uncovered = Number(r?.uncovered ?? 0);
  const matched = Number(r?.matched_rows ?? 0);
  return {
    matchedRows: matched,
    uniqueSubscribers: Number(r?.unique_rows ?? matched),
    coveredCells: covered,
    uncoveredCells: uncovered,
    mappingIncomplete: uncovered > 0,
  };
}

/**
 * VERSION C/E (production default candidate): `subscriber_cell_index`
 * (serving_cell_id, subscriber_id) int4 PK, CLUSTERed per cell. Identification
 * = compact numeric postings off the 78 GB heap; counts = stats table.
 */
export class MappingAccessPath implements CellAccessPath {
  readonly name = 'mapping:subscriber_cell_index';
  readonly version = 'C' as const;
  constructor(
    private readonly cfg: ParsedEnvConfig = loadConfig(),
    private readonly pool: pg.Pool = getPool(),
  ) {}

  countCells(cellIds: readonly string[]): Promise<CellAccessStats> {
    return statsCount(this.pool, this.cfg, cellIds);
  }

  async *streamIds(cellIds: readonly string[], batchSize: number): AsyncIterable<SubscriberIdBatch> {
    const idxTable = this.cfg.SUBSCRIBER_CELL_INDEX_TABLE;
    const client = await this.pool.connect();
    try {
      const started = Date.now();
      const cur = `cur_sci_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await client.query(
        `DECLARE ${cur} CURSOR FOR SELECT subscriber_id FROM ${idxTable} WHERE serving_cell_id = ANY($1::text[])`,
        [Array.from(new Set(cellIds))],
      );
      for (;;) {
        const { rows } = await client.query<{ subscriber_id: number }>(
          `FETCH ${batchSize} FROM ${cur}`,
        );
        if (rows.length === 0) break;
        yield { ids: rows.map((r) => r.subscriber_id), elapsedMs: Date.now() - started };
      }
      await client.query(`CLOSE ${cur}`);
    } finally {
      client.release();
    }
  }
}

/**
 * VERSION D: intarray posting lists `cell_postings(cell_id, subscriber_ids int4[])`.
 * Identification = UNNEST of selected postings (no heap, same numeric ids).
 * Requires `intarray` extension for the `|`/`uniq` union operators when used.
 */
export class PostingsAccessPath implements CellAccessPath {
  readonly name = 'postings:cell_postings(intarray)';
  readonly version = 'D' as const;
  constructor(
    private readonly cfg: ParsedEnvConfig = loadConfig(),
    private readonly pool: pg.Pool = getPool(),
  ) {}

  countCells(cellIds: readonly string[]): Promise<CellAccessStats> {
    return statsCount(this.pool, this.cfg, cellIds);
  }

  async *streamIds(cellIds: readonly string[], batchSize: number): AsyncIterable<SubscriberIdBatch> {
    const postTable = this.cfg.CELL_POSTINGS_TABLE;
    const client = await this.pool.connect();
    try {
      const started = Date.now();
      const cur = `cur_post_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await client.query(
        `DECLARE ${cur} CURSOR FOR
           SELECT p.subscriber_id
           FROM ${postTable} c, LATERAL unnest(c.subscriber_ids) AS p(subscriber_id)
           WHERE c.cell_id = ANY($1::text[])
           ORDER BY p.subscriber_id`,
        [Array.from(new Set(cellIds))],
      );
      for (;;) {
        const { rows } = await client.query<{ subscriber_id: number }>(
          `FETCH ${batchSize} FROM ${cur}`,
        );
        if (rows.length === 0) break;
        yield { ids: rows.map((r) => r.subscriber_id), elapsedMs: Date.now() - started };
      }
      await client.query(`CLOSE ${cur}`);
    } finally {
      client.release();
    }
  }
}

/**
 * VERSION B: covering B-tree on the dump `(serving_cell_id) INCLUDE (id)` —
 * identification is an index-only scan (no heap fetch). Requires the migration
 * 010b index `idx_subscriber_dump_serving_cell_cover` to exist.
 */
export class IndexCoverAccessPath implements CellAccessPath {
  readonly name = 'index:dump(serving_cell_id) INCLUDE (id)';
  readonly version = 'B' as const;
  constructor(
    private readonly cfg: ParsedEnvConfig = loadConfig(),
    private readonly pool: pg.Pool = getPool(),
  ) {}

  countCells(cellIds: readonly string[]): Promise<CellAccessStats> {
    return statsCount(this.pool, this.cfg, cellIds);
  }

  async *streamIds(cellIds: readonly string[], batchSize: number): AsyncIterable<SubscriberIdBatch> {
    const dump = this.cfg.SUBSCRIBER_DUMP_TABLE;
    const colCell = this.cfg.SUBSCRIBER_DUMP_CELL_COL;
    const idCol = this.cfg.SUBSCRIBER_DUMP_ID_COL;
    const client = await this.pool.connect();
    try {
      const started = Date.now();
      const cur = `cur_cov_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await client.query(
        `DECLARE ${cur} CURSOR FOR
           SELECT ${idCol} AS subscriber_id FROM ${dump}
           WHERE ${colCell} = ANY($1::text[]) AND ${colCell} IS NOT NULL`,
        [Array.from(new Set(cellIds))],
      );
      for (;;) {
        const { rows } = await client.query<{ subscriber_id: number }>(
          `FETCH ${batchSize} FROM ${cur}`,
        );
        if (rows.length === 0) break;
        yield { ids: rows.map((r) => r.subscriber_id), elapsedMs: Date.now() - started };
      }
      await client.query(`CLOSE ${cur}`);
    } finally {
      client.release();
    }
  }
}

/** Factory tied to config mode. The measured winner becomes the default. */
export function createCellAccessPath(
  mode: string,
  cfg: ParsedEnvConfig = loadConfig(),
  pool: pg.Pool = getPool(),
): CellAccessPath {
  switch (mode) {
    case 'postings':
      return new PostingsAccessPath(cfg, pool);
    case 'index':
      return new IndexCoverAccessPath(cfg, pool);
    case 'direct':
      // VERSION A (current) handled separately by PostgresSubscriberCellMatcher.
      throw new Error('Access mode "direct" maps to PostgresSubscriberCellMatcher, not this factory.');
    case 'mapping':
    default:
      return new MappingAccessPath(cfg, pool);
  }
}

export { statsCount as statsCountBaseline, logger };