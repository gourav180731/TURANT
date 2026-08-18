-- =====================================================================
-- docs/sql/11_v_50k_benchmark_stats.sql
-- Evidence: the EXACT single-statement query the benchmark runs for the
-- 50,000-cell acceptance tier (buildSubscriberCellStatsQuery). It resolves
-- how many of the requested cells actually have dump rows and aggregates the
-- raw + distinct subscriber counts UNBOUNDED — no LIMIT, no cap.
--
-- Measured 2026-08-13 (10,000-cell EXPLAIN harness): Parallel Bitmap Heap /
-- Index Scan on idx_subscriber_dump_serving_cell, 4,906 ms, 3,279,000 rows.
-- =====================================================================
WITH target AS (
  SELECT cell_id FROM unnest($1::text[]) AS t(cell_id)
),
resolved_cells AS (
  SELECT DISTINCT serving_cell_id AS cell_id
  FROM subscriber_dump
  WHERE serving_cell_id = ANY($1::text[])
    AND serving_cell_id IS NOT NULL
),
agg AS (
  SELECT COUNT(*)                AS matched_rows,
         COUNT(DISTINCT msisdn)  AS unique_msisdns
  FROM subscriber_dump
  WHERE serving_cell_id = ANY($1::text[])
    AND serving_cell_id IS NOT NULL
    AND msisdn IS NOT NULL
),
counts AS (
  SELECT (SELECT COUNT(*) FROM target)                       AS target_cells,
         (SELECT COUNT(*) FROM resolved_cells)               AS resolved_cells,
         (SELECT COUNT(*) FROM target t
           WHERE NOT EXISTS (SELECT 1 FROM resolved_cells r
                             WHERE r.cell_id = t.cell_id))   AS unmatched_cells,
         (SELECT matched_rows FROM agg)                      AS matched_rows,
         (SELECT unique_msisdns FROM agg)                    AS unique_msisdns
)
SELECT * FROM counts;
-- VALUES bind: e.g. ARRAY(SELECT cell_id FROM sim_cell_towers ORDER BY cell_id LIMIT 50000)