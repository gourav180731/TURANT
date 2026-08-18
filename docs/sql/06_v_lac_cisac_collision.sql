-- =====================================================================
-- docs/sql/06_v_lac_cisac_collision.sql
-- Evidence: cells sharing a (lac, cisac) pair = SHARED-RADIUS broadcast, NOT
-- cross-state leakage. In the cell-authoritative mapping (migration 008), each
-- dump row carries ONE serving_cell_id resolved through sim_cell_towers, so a
-- matched subscriber is the DB's cell-level answer. Cells under one
-- lac/cisac simply share the same network area; a targeted alert to either
-- cell legitimately covers the shared footprint.
-- =====================================================================
WITH collisions AS (
  SELECT lac, cisac, COUNT(DISTINCT cell_id) AS cell_count
  FROM cell_network_mapping
  GROUP BY lac, cisac
  HAVING COUNT(DISTINCT cell_id) > 1
)
SELECT
  COUNT(*)                                    AS colliding_lac_cisac_pairs,
  COALESCE(SUM(cell_count), 0)                AS cells_in_colliding_pairs,
  (SELECT COUNT(*) FROM cell_network_mapping) AS total_mapping_rows;