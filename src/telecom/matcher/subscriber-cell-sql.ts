import type { ParsedEnvConfig } from '../../config/env.js';

/**
 * Pure SQL builder for the two-stage, cell-indexed subscriber lookup against
 * the real C-DOT subscriber dump (requirement #4).
 *
 * This is the fast/correct path at 197M rows. Module 02 already resolved the
 * alert zone down to a set of tower `cell_id`s (polygon → cells). Instead of a
 * point-in-polygon scan over the whole dump (`subscriber-dump-sql.ts`), here we
 * turn those cell ids straight into an index seek:
 *
 *     SELECT DISTINCT msisdn
 *     FROM subscriber_dump
 *     WHERE serving_cell_id = ANY($1::text[])
 *     LIMIT ...
 *
 * `serving_cell_id` is the B-tree indexed column added by migration 008 and
 * FK-bound to `sim_cell_towers.cell_id` (`fk_subdump_serving_cell`); the Delhi
 * expansion population carries a real value for every row.
 * `col = ANY($1::text[])` keeps the whole resolved cell set in ONE indexed
 * access path with a single bind parameter, so it stays fast and, crucially,
 * it never scans the 197M-row table geometry.
 */
export function buildSubscriberCellQuery(
  cfg: ParsedEnvConfig,
  cellIds: readonly string[],
  limit: number,
): { text: string; values: unknown[] } {
  const tbl = cfg.SUBSCRIBER_DUMP_TABLE;
  const colMsisdn = cfg.SUBSCRIBER_DUMP_MSISDN_COL;
  const colCell = cfg.SUBSCRIBER_DUMP_CELL_COL;
  const uniqueCellIds = Array.from(new Set(cellIds));

  const text = `
    SELECT DISTINCT ${colMsisdn} AS msisdn
    FROM ${tbl}
    WHERE ${colCell} = ANY($1::text[])
      AND ${colCell} IS NOT NULL
      AND ${colMsisdn} IS NOT NULL
    LIMIT ${limit};
  `;

  return { text, values: [uniqueCellIds] };
}