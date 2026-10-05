SET work_mem = '1GB';
\timing on
WITH target AS (
  SELECT cell_id FROM sim_cell_towers ORDER BY cell_id LIMIT 50000
),
resolved_cells AS (
  SELECT DISTINCT serving_cell_id AS cell_id
  FROM subscriber_dump
  WHERE serving_cell_id IN (SELECT cell_id FROM target)
    AND serving_cell_id IS NOT NULL
),
agg AS (
  SELECT COUNT(*)               AS matched_rows,
         COUNT(DISTINCT msisdn) AS unique_msisdns
  FROM subscriber_dump
  WHERE serving_cell_id IN (SELECT cell_id FROM target)
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
