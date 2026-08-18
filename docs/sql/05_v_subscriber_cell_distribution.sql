-- =====================================================================
-- docs/sql/05_v_subscriber_cell_distribution.sql
-- Evidence: per-cell subscriber count distribution over the generated Delhi
-- expansion.
--
-- MEASURED 2026-08-13: min=3278 max=3279 avg=3278.40 stddev=0.49 over
-- 29,727 cells. This UNIFORM distribution is a known, documented artifact of
-- the v1 deterministic even-modulo distributor used to generate the shipped
-- 100,000,000-row expansion. The current generator ships a WEIGHTED
-- log-normal distributor (buildCellWeights, scripts/generate-dump-expansion.ts)
-- which produces realistically variable counts (simulated min=199 p50=1103
-- max=27306, 5,658 distinct values). It is documented in
-- docs/SUBSCRIBER_GENERATION.md; the v1 data is kept as-is because matching
-- correctness, traceability, and per-cell lookups are distribution-agnostic.
-- =====================================================================
SELECT
  COUNT(*)                                   AS cells,
  MIN(c)                                    AS min_per_cell,
  MAX(c)                                    AS max_per_cell,
  ROUND(AVG(c), 2)                          AS avg_per_cell,
  ROUND(STDDEV(c), 2)                       AS stddev_per_cell,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c) AS p50,
  PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY c) AS p90
FROM (
  SELECT serving_cell_id, COUNT(*) AS c
  FROM subscriber_dump
  WHERE data_source = 'synthetic_delhi_expansion_v1'
    AND serving_cell_id IS NOT NULL
  GROUP BY serving_cell_id
) per_cell;