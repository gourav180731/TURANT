-- =====================================================================
-- SEED 002: subscriber load plan — REGENERATED EQUIVALENT (v1)
-- =====================================================================
-- CLASSIFICATION: REGENERATED EQUIVALENT DATA plan — NOT original rows.
-- Builds a deterministic per-cell row budget over the 36,744 Delhi-state
-- cells summing to EXACTLY 100,000,000 rows (Delhi total = 100M, mirroring
-- docs/sql/01_v_delhi_total_count.sql). Distribution is variable
-- (log-normal-ish weights, largest-remainder apportionment) — NOT the old
-- uniform even-modulo artifact (see SUBSCRIBER_GENERATION.md section 1a).
-- Global sequence (start_seq) guarantees UNIQUE imsi/msisdn across all ops.
-- Idempotent: drops + rebuilds seed_cell_plan (plan only, no dump writes).
-- Fast: ~37K rows, runs in seconds.
-- =====================================================================

DROP TABLE IF EXISTS seed_cell_plan;
DROP TABLE IF EXISTS seed_checkpoints;

CREATE TABLE seed_cell_plan (
  batch_id    INTEGER NOT NULL,
  cell_id     TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  op          TEXT NOT NULL,          -- Jio/Airtel/VI/BSNL/MTNL (009 case)
  mcc         TEXT NOT NULL,
  mnc         TEXT NOT NULL,
  lac         TEXT NOT NULL,          -- 4-hex per (cell,op,tech class)
  cisac       TEXT NOT NULL,          -- 4-hex per (cell,op,tech class)
  city        TEXT NOT NULL,
  district    TEXT NOT NULL,
  base_lat    DOUBLE PRECISION NOT NULL,
  base_lng    DOUBLE PRECISION NOT NULL,
  n_rows      INTEGER NOT NULL CHECK (n_rows >= 0),
  start_seq   BIGINT NOT NULL         -- global 1-based seq of first row
);

CREATE TABLE seed_checkpoints (
  batch_id   INTEGER PRIMARY KEY,
  batch_uuid UUID NOT NULL,
  rows_added BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at    TIMESTAMPTZ
);

-- ---- per-cell budget: weight -> floor share -> largest remainder ----
WITH cells AS (
  SELECT t.cell_id, t.site_id, t.latitude AS la, t.longitude AS ln,
         t.district, t.city_town,
         CASE t.tsp_name WHEN 'JIO' THEN 'Jio' WHEN 'AIRTEL' THEN 'Airtel'
           WHEN 'VI' THEN 'VI' WHEN 'BSNL' THEN 'BSNL' ELSE 'MTNL' END AS op,
         CASE t.tsp_name WHEN 'JIO' THEN '405' ELSE '404' END AS mcc,
         CASE t.tsp_name WHEN 'JIO' THEN '86' WHEN 'AIRTEL' THEN '10'
           WHEN 'VI' THEN '20' WHEN 'BSNL' THEN '58' ELSE '68' END AS mnc,
         -- Box-Muller-ish weight from two deterministic hashes
         (('x' || substr(md5('w1' || t.cell_id), 1, 12))::bit(48)::bigint % 1000000)::double precision / 1000000.0 AS u1,
         (('x' || substr(md5('w2' || t.cell_id), 1, 12))::bit(48)::bigint % 1000000)::double precision / 1000000.0 AS u2
  FROM public.sim_cell_towers t
  WHERE t.state = 'Delhi'
),
weighted AS (
  SELECT cell_id, site_id, la, ln, district, city_town, op, mcc, mnc,
         greatest(0.1, exp(sqrt(-2.0 * ln(greatest(u1, 1e-9)))
                            * cos(2.0 * pi() * u2) * 0.55)) AS w
  FROM cells
),
shares AS (
  SELECT *, w / sum(w) OVER () AS frac,
         floor(100000000 * (w / sum(w) OVER ()))::bigint AS base_n,
         (100000000 * (w / sum(w) OVER ())) - floor(100000000 * (w / sum(w) OVER ())) AS rem
  FROM weighted
),
ranked AS (
  -- largest remainder: top (100M - sum(base_n)) cells get +1
  SELECT *, row_number() OVER (ORDER BY rem DESC) AS rn,
         100000000 - sum(base_n) OVER () AS shortfall
  FROM shares
),
final AS (
  SELECT cell_id, site_id, la, ln, district, city_town, op, mcc, mnc,
         (base_n + CASE WHEN rn <= shortfall THEN 1 ELSE 0 END)::int AS n_rows
  FROM ranked
),
ordered_cells AS (
  SELECT *, row_number() OVER (ORDER BY cell_id) AS rn2,
         sum(n_rows) OVER (ORDER BY cell_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_sum
  FROM final
)
INSERT INTO seed_cell_plan
  (batch_id, cell_id, site_id, op, mcc, mnc, lac, cisac, city, district,
   base_lat, base_lng, n_rows, start_seq)
SELECT ((rn2 - 1) / 500) AS batch_id,
  cell_id, site_id, op, mcc, mnc,
  upper(to_hex((1024 + (abs(('x' || substr(md5('lac' || cell_id || op), 1, 8))::bit(32)::int) % 1024))::int)) AS lac,
  upper(lpad(to_hex((abs(('x' || substr(md5('cis' || cell_id || op), 1, 8))::bit(32)::int))::int), 4, '0')) AS cisac,
  initcap(city_town), initcap(district), la, ln, n_rows,
  coalesce(prev_sum, 0) + 1 AS start_seq
FROM ordered_cells;

-- ---- plan validation ----
SELECT COUNT(*) AS plan_cells,
       SUM(n_rows)::bigint AS planned_rows,
       MIN(n_rows) AS min_per_cell, MAX(n_rows) AS max_per_cell,
       round(AVG(n_rows), 2) AS avg_per_cell,
       COUNT(DISTINCT batch_id) AS batches
FROM seed_cell_plan;
SELECT COUNT(*) AS distinct_start_ok FROM
  (SELECT start_seq FROM seed_cell_plan GROUP BY 1 HAVING COUNT(*) = 1) s;
