-- =====================================================================
-- docs/sql/10_v_selected_cell_subscriber_trace.sql
-- Evidence: cell-authoritative end-to-end trace — pick one real serving cell
-- and show its tower identity plus the subscribers the pipeline reports.
-- Identity set is the dump's row-level answer (no polygon geometry involved).
-- =====================================================================
-- 1) Pick a serving cell with a known footprint:
--    SELECT serving_cell_id FROM subscriber_dump
--    WHERE data_source = 'synthetic_delhi_expansion_v1'
--    GROUP BY serving_cell_id ORDER BY COUNT(*) DESC LIMIT 1;
--    (every cell carries 3278-3279 in v1 — see 05_v_...)

-- 2) Tower identity (authoritative 1:1 cell table):
SELECT cell_id, latitude, longitude
FROM sim_cell_towers
WHERE cell_id = 'PLACEHOLDER_CELL_ID';

-- 3) Subscriber identity set for that cell (the production index seek):
SELECT COUNT(*)                                AS matched_rows,
       COUNT(DISTINCT msisdn)                  AS unique_msisdns
FROM subscriber_dump
WHERE serving_cell_id = 'PLACEHOLDER_CELL_ID'
  AND serving_cell_id IS NOT NULL
  AND msisdn IS NOT NULL;