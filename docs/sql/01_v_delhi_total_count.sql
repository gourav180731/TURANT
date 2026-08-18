-- =====================================================================
-- docs/sql/01_v_delhi_total_count.sql
-- Evidence: the Delhi footprint is EXACTLY 100,000,000 rows
-- (state='Delhi', expansion + legacy-Delhi top-up).
-- Measured 2026-08-13: 100,000,000  (expansion 97,457,009 + legacy 2,542,991)
-- =====================================================================
SELECT COUNT(*) AS delhi_total_rows
FROM subscriber_dump
WHERE state = 'Delhi';