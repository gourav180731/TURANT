-- =====================================================================
-- docs/sql/04_v_distinct_serving_cells.sql
-- Evidence: Delhi footprint spans 29,727 distinct serving cells, every one
-- FK-backed by sim_cell_towers.cell_id (migration 008/009).
-- =====================================================================
SELECT COUNT(DISTINCT serving_cell_id) AS distinct_delhi_cells
FROM subscriber_dump
WHERE data_source = 'synthetic_delhi_expansion_v1'
  AND serving_cell_id IS NOT NULL;