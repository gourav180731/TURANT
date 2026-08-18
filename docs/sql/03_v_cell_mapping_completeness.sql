-- =====================================================================
-- docs/sql/03_v_cell_mapping_completeness.sql
-- Evidence: every expansion row resolves to an authoritative tower cell.
-- Measured: Delhi total=100,000,000; mapped=97,457,009; unmapped=2,542,991
-- (legacy Delhi rows, serving_cell_id NULL, excluded from the cell matcher);
-- distinct Delhi serving cells = 29,727.
-- =====================================================================
SELECT
  COUNT(*) FILTER (WHERE state = 'Delhi')                              AS delhi_total,
  COUNT(*) FILTER (WHERE state = 'Delhi' AND serving_cell_id IS NOT NULL) AS mapped_delhi,
  COUNT(*) FILTER (WHERE state = 'Delhi' AND serving_cell_id IS NULL)     AS unmapped_delhi,
  COUNT(DISTINCT serving_cell_id)                                        AS distinct_serving_cells
FROM subscriber_dump;