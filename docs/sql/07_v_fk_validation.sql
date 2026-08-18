-- =====================================================================
-- docs/sql/07_v_fk_validation.sql
-- Evidence: serving_cell_id foreign key is VALIDATED with ZERO orphans.
--   ALTER TABLE subscriber_dump VALIDATE CONSTRAINT fk_subdump_serving_cell;
--   -> NOT VALID => VALID (measured 2026-08-13)
-- Referential-integrity state persisted in pg_constraint.convalidated.
-- =====================================================================
SELECT conname, contype,
       convalidated   AS fk_validated,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'fk_subdump_serving_cell';

-- Runtime orphan proof (index-backed LEFT JOIN over the mapped rows):
SELECT COUNT(*) AS orphan_rows
FROM subscriber_dump d
LEFT JOIN sim_cell_towers t ON t.cell_id = d.serving_cell_id
WHERE d.serving_cell_id IS NOT NULL
  AND t.cell_id IS NULL;