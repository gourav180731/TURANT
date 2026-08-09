import type { ParsedEnvConfig } from '../../config/env.js';

/**
 * Pure SQL builders for the Phase 4/5 relational subscriber lookup.
 *
 * Production contract (50k cells / 100M subscribers / <=60s):
 *
 *   target cell_ids (from the polygon -> towers step)
 *        |
 *        v
 *   target_staging       (one temp table per alert, loaded ONCE)
 *        |
 *        v
 *   cell_subscriber_mapping (cell_id -> lac, cisac)  -> resolved set
 *        |
 *        v
 *   (lac, cisac) JOIN subscriber_dump    (composite index seek, never seq scan)
 *        |
 *        v
 *   DISTINCT msisdn                       (DB-level dedup, Phase 9)
 *        |
 *        v
 *   batched recipient stream (RS-8)
 *
 * This deliberately does NOT do `cell_id = ANY($1)` against the 100M dump —
 * the dump has no cell_id, and a 50k-element ANY array makes the planner fall
 * back to a sequential scan of the whole table as the array grows. Instead:
 *   1. the target cells are staged into a per-session TEMP table;
 *   2. the stamping: join that temp table to the mapping table (indexed on
 *      cell_id) to obtain the real (lac, cisac) areas;
 *   3. the dump lookup joins on the (lac, cisac) composite index;
 *   4. dedup is a single DISTINCT at the SQL level (never a JS Set over 100M).
 *
 * All statements run on ONE dedicated client in ONE transaction. A :
 * statement_timeout (MATCH_TIME_BUDGET_MS) bounds the join; an
 * idle_in_transaction_session_timeout cancels a faxed/cancelled alert.
 */

/** Render the "stage a set of cell ids" statement (temp table per session). */
export function buildStageCellIdsSql(cfg: ParsedEnvConfig): { text: string; values: unknown[] } {
  return {
    text: `
      CREATE TEMP TABLE IF NOT EXISTS turant_target_cells (
        cell_id VARCHAR(20) NOT NULL,
        UNIQUE (cell_id)
      ) ON COMMIT DROP;
    `,
    values: [],
  };
}

/** Bulk-load the deduped target cell ids into the staging table. */
export function buildLoadTargetCellsSql(
  cfg: ParsedEnvConfig,
  cellIds: readonly string[],
): { text: string; values: unknown[] } {
  const unique = Array.from(new Set(cellIds));
  if (unique.length === 0) {
    return { text: `SELECT 1 WHERE false`, values: [] };
  }
  const values: unknown[] = [];
  const placeholders = unique.map((c) => values.push(c)).map((_, i) => `($${i + 1})`);
  return {
    text: `
      INSERT INTO turant_target_cells (cell_id)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (cell_id) DO NOTHING;
    `,
    values,
  };
}

export interface BridgeResultShape {
  target_cells: number;
  resolved_cells: number;
  unresolved_cells: number;
  resolved_areas: number;
  matched_rows: number;
  unique_msisdns: number;
}

/**
 * The single "resolve + match + dedup" statement.
 *
 * Stages -> mapping -> dump. Returns, in one query, the aggregate statistics so
 * the service never materialises 100M rows into Node memory:
 *   matched_rows     = raw dump rows that matched a resolved (lac, cisac)
 *   at unique_msisdns = deduplicated recipient count (Phase 9)
 * Separately, the caller streams rows via a cursor for the actual batch
 * hand-off (batches are drained RECIPIENT_BATCH_SIZE at a time).
 */
export function buildMatchStatsSql(cfg: ParsedEnvConfig): { text: string } {
  return {
    text: `
      WITH target AS (
        SELECT cell_id FROM turant_target_cells
      ),
      -- resolved: which target cells actually have a (lac, cisac) mapping.
      resolved_cells AS (
        SELECT t.cell_id
        FROM target t
        JOIN ${cfg.CELL_SUBSCRIBER_MAPPING_TABLE} m
          ON m.${cfg.CELL_MAPPING_COL_CELL} = t.cell_id
        GROUP BY t.cell_id
      ),
      resolved_areas AS (
        SELECT DISTINCT m.${cfg.CELL_MAPPING_COL_LAC} AS lac,
                        m.${cfg.CELL_MAPPING_COL_CISAC} AS cisac
        FROM target t
        JOIN ${cfg.CELL_SUBSCRIBER_MAPPING_TABLE} m
          ON m.${cfg.CELL_MAPPING_COL_CELL} = t.cell_id
      ),
      agg AS (
        SELECT COUNT(*) AS matched_rows,
               COUNT(DISTINCT s.${cfg.SUBSCRIBER_DUMP_MSISDN_COL}) AS unique_msisdns
        FROM resolved_areas r
        JOIN ${cfg.SUBSCRIBER_DUMP_TABLE} s
          ON s.${cfg.SUBSCRIBER_DUMP_LAC_COL} = r.lac
         AND s.${cfg.SUBSCRIBER_DUMP_CISAC_COL} = r.cisac
      ),
      counts AS (
        SELECT (SELECT COUNT(*) FROM target)              AS target_cell_count,
               (SELECT COUNT(*) FROM resolved_cells)       AS resolved_cells,
               (SELECT COUNT(*) FROM target t
                 WHERE NOT EXISTS (SELECT 1 FROM ${cfg.CELL_SUBSCRIBER_MAPPING_TABLE} m
                                    WHERE m.${cfg.CELL_MAPPING_COL_CELL} = t.cell_id))
                                                        AS unresolved_cells,
               (SELECT COUNT(*) FROM resolved_areas)      AS resolved_areas,
               (SELECT matched_rows  FROM agg)            AS matched_rows,
               (SELECT unique_msisdns FROM agg)          AS unique_msisdns
      )
      SELECT * FROM counts;
    `,
  };
}

/**
 * The cursor statement that streams the actual recipient MSISDNs (deduped at
 * the DB level) so they can be handed to the SMPP boundary in batches without
 * ever holding the full list in RAM. `cursorBatch` rows per FETCH.
 */
export function buildStreamRecipientsSql(cfg: ParsedEnvConfig): { text: string } {
  return {
    text: `
      SELECT DISTINCT s.${cfg.SUBSCRIBER_DUMP_MSISDN_COL} AS msisdn
      FROM turant_target_cells t
      JOIN ${cfg.CELL_SUBSCRIBER_MAPPING_TABLE} m
        ON m.${cfg.CELL_MAPPING_COL_CELL} = t.cell_id
      JOIN ${cfg.SUBSCRIBER_DUMP_TABLE} s
        ON s.${cfg.SUBSCRIBER_DUMP_LAC_COL} = m.${cfg.CELL_MAPPING_COL_LAC}
       AND s.${cfg.SUBSCRIBER_DUMP_CISAC_COL} = m.${cfg.CELL_MAPPING_COL_CISAC}
      WHERE s.${cfg.SUBSCRIBER_DUMP_MSISDN_COL} IS NOT NULL
    `,
  };
}