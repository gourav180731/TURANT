-- =====================================================================
-- docs/sql/08_v_duplicate_detection.sql
-- Evidence: no duplicate IMSI / MSISDN on the mapped expansion rows — every
-- row is unique on both subscriber identity keys. Measured: 0 / 0.
-- Unique indexes ux_subscriber_dump_imsi / ux_subscriber_dump_msisdn enforce it.
-- =====================================================================
SELECT
  COUNT(*)  AS mapped_rows,
  COUNT(*) - COUNT(DISTINCT imsi)                   AS duplicate_imsi,
  COUNT(*) - COUNT(DISTINCT msisdn)                 AS duplicate_msisdn
FROM subscriber_dump
WHERE serving_cell_id IS NOT NULL;