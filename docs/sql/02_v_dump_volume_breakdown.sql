-- =====================================================================
-- docs/sql/02_v_dump_volume_breakdown.sql
-- Evidence: real dump volume under test (Phase-3 verified counts).
--   subscriber_dump total      = 191,547,362
--   Delhi total                = 100,000,000  (state='Delhi')
--   Delhi expansion            =  97,457,009  (data_source='synthetic_delhi_expansion_v1')
--   Delhi expansion mapped     =  97,457,009  (serving_cell_id NOT NULL)
--   legacy non-expansion rows  =  94,090,353  (data_source IS NULL)
-- =====================================================================
SELECT
  (SELECT COUNT(*) FROM subscriber_dump)                                                      AS total_rows,
  (SELECT COUNT(*) FROM subscriber_dump WHERE state = 'Delhi')                                AS delhi_total,
  COUNT(*) FILTER (WHERE data_source = 'synthetic_delhi_expansion_v1')                        AS delhi_expansion,
  COUNT(*) FILTER (WHERE data_source = 'synthetic_delhi_expansion_v1'
                             AND serving_cell_id IS NOT NULL)                                 AS delhi_expansion_mapped,
  COUNT(*) FILTER (WHERE serving_cell_id IS NULL)                                             AS rows_without_serving_cell
FROM subscriber_dump;