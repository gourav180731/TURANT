-- =====================================================================
-- SEED 001: Delhi-NCR cell-site data — REGENERATED EQUIVALENT (v1)
-- =====================================================================
-- CLASSIFICATION: REGENERATED EQUIVALENT DATA — NOT original rows.
-- The original ~43GB database (incl. the MTNL Delhi cell-site rows visible
-- in the user's pgAdmin screenshots) lives only on the personal laptop and
-- was never committed to Git. This seed recreates an equivalent Delhi-NCR
-- footprint with the SAME shape and semantics:
--   * 50,000 cells, MCC-MNC-LAC-CID cell_id format (e.g. 404-68-117-65511)
--   * MTNL Delhi columns: service_provider, service_area, state, district,
--     city_town, pincode, bts_id, site_type, switch_make, switch_model,
--     state_id, rnc_id, tsp_name, rnc_ip (+ app cols site_id/coverage)
--   * Co-located cells: 4 cells share ONE exact lat/lng (cell-level
--     identity preserved — one coordinate != one cell, per screenshots)
--   * 15 Delhi-NCR districts, 5 operators (real MCC/MNC pools), Delhi+NCR
-- Deterministic: pure-SQL hash of row number (re-runnable, same output).
-- Idempotent: ON CONFLICT (site_id) DO NOTHING.
-- geom backfill: run seed/002_postgis_backfill.sql after 000b (PostGIS).
-- =====================================================================

-- hash helper: deterministic int in [0, mod) from (seed, n)
CREATE OR REPLACE FUNCTION turant_seed_hash(seed text, n bigint, mod bigint)
RETURNS bigint LANGUAGE sql IMMUTABLE AS
$$ SELECT abs((('x' || substr(md5(seed || n::text), 1, 15))::bit(60)::bigint) % mod) $$;

INSERT INTO public.sim_cell_towers (
  site_id, cell_id, latitude, longitude, coverage_radius_m,
  service_provider, service_area, state, district, city_town, pincode,
  bts_id, site_type, switch_make, switch_model, state_id,
  rnc_id, tsp_name, rnc_ip, technology
)
SELECT
  'SITE-' || lpad(g::text, 6, '0')                                   AS site_id,
  mcc || '-' || mnc || '-' || lac || '-' || cid                      AS cell_id,
  round((base_lat + 0.0)::numeric, 6)::float8                        AS latitude,
  round((base_lng + 0.0)::numeric, 6)::float8                        AS longitude,
  radius                                                             AS coverage_radius_m,
  provider                                                           AS service_provider,
  area                                                               AS service_area,
  st                                                                 AS state,
  dist                                                               AS district,
  city                                                               AS city_town,
  pin                                                                AS pincode,
  (10000 + g)::text                                                  AS bts_id,
  tech                                                               AS site_type,
  make                                                               AS switch_make,
  model                                                              AS switch_model,
  1296                                                               AS state_id,
  'RNC-' || tsp                                                      AS rnc_id,
  tsp                                                                AS tsp_name,
  '10.' || (turant_seed_hash('rnc', g, 250) + 1) || '.'
        || turant_seed_hash('rnc2', g, 250) || '.'
        || (turant_seed_hash('rnc3', g, 250) + 1)                     AS rnc_ip,
  tech                                                               AS technology
FROM (
  SELECT g,
    ((g - 1) / 4) + 1                                                AS cluster_id,
    ((g - 1) % 4)                                                    AS sector,
    -- operator mix Jio36/Airtel36/VI15/BSNL8/MTNL5 (deterministic)
    CASE WHEN h_op < 36 THEN 'Jio'
         WHEN h_op < 72 THEN 'Airtel'
         WHEN h_op < 87 THEN 'VI'
         WHEN h_op < 95 THEN 'BSNL'
         ELSE 'MTNL' END                                             AS op
  FROM generate_series(1, 50000) AS g
  CROSS JOIN LATERAL (SELECT turant_seed_hash('op', g, 100) AS h_op) h
) s
CROSS JOIN LATERAL (
  SELECT
    -- shared base coordinate per 4-cell cluster (co-location)
    28.40 + (turant_seed_hash('lat', cluster_id, 4800)::double precision / 10000.0) AS base_lat,
    76.84 + (turant_seed_hash('lng', cluster_id, 5100)::double precision / 10000.0) AS base_lng
) c
CROSS JOIN LATERAL (
  SELECT
    CASE op WHEN 'Jio' THEN 405 WHEN 'Airtel' THEN 404 WHEN 'VI' THEN 404
            WHEN 'BSNL' THEN 404 ELSE 404 END                        AS mcc,
    CASE op WHEN 'Jio' THEN '86' WHEN 'Airtel' THEN '10' WHEN 'VI' THEN '20'
            WHEN 'BSNL' THEN '58' ELSE '68' END                      AS mnc,
    (100 + turant_seed_hash('lac', cluster_id, 90))::text            AS lac,
    (10000 + g)::text                                               AS cid,
    CASE op WHEN 'MTNL' THEN 'Mahanagar Telephone Nigam Ltd. (MTNL),DELHI'
            WHEN 'Jio' THEN 'Reliance Jio Infocomm Ltd.,DELHI'
            WHEN 'Airtel' THEN 'Bharti Airtel Ltd.,DELHI'
            WHEN 'VI' THEN 'Vodafone Idea Ltd.,DELHI'
            ELSE 'Bharat Sanchar Nigam Ltd.,DELHI' END               AS provider,
    CASE op WHEN 'Jio' THEN 'JIO' WHEN 'Airtel' THEN 'AIRTEL'
            WHEN 'VI' THEN 'VI' WHEN 'BSNL' THEN 'BSNL'
            ELSE 'MTNL' END                                         AS tsp,
    -- technology mix 5G68/4G25/UMTS7 mapped to site_type labels
    CASE WHEN turant_seed_hash('tech', g, 100) < 68 THEN 'NR5G'
         WHEN turant_seed_hash('tech', g, 100) < 93 THEN 'LTE'
         ELSE 'GSM' END                                             AS tech,
    CASE WHEN turant_seed_hash('tech', g, 100) < 68 THEN 350.0
         WHEN turant_seed_hash('tech', g, 100) < 93 THEN 800.0
         ELSE 1500.0 END                                            AS radius,
    CASE op WHEN 'MTNL' THEN 'HUAWEI' WHEN 'Jio' THEN 'SAMSUNG'
            WHEN 'Airtel' THEN 'ERICSSON' WHEN 'VI' THEN 'NOKIA'
            ELSE 'ZTE' END                                          AS make,
    CASE op WHEN 'MTNL' THEN 'MSOFT3000' WHEN 'Jio' THEN 'vRAN'
            WHEN 'Airtel' THEN '6601' WHEN 'VI' THEN 'FLEXI'
            ELSE 'ZXWN' END                                         AS model
) m
CROSS JOIN LATERAL (
  -- 15-district NCR geography pinned to base coordinate
  SELECT
    CASE d WHEN 0 THEN 'Delhi' WHEN 1 THEN 'Delhi' WHEN 2 THEN 'Delhi'
           WHEN 3 THEN 'Delhi' WHEN 4 THEN 'Delhi' WHEN 5 THEN 'Delhi'
           WHEN 6 THEN 'Delhi' WHEN 7 THEN 'Delhi' WHEN 8 THEN 'Delhi'
           WHEN 9 THEN 'Delhi' WHEN 10 THEN 'Delhi' WHEN 11 THEN 'Haryana'
           WHEN 12 THEN 'Haryana' WHEN 13 THEN 'Uttar Pradesh'
           ELSE 'Uttar Pradesh' END                                 AS st,
    CASE d WHEN 0 THEN 'NEW DELHI' WHEN 1 THEN 'CENTRAL DELHI'
           WHEN 2 THEN 'SOUTH DELHI' WHEN 3 THEN 'NORTH DELHI'
           WHEN 4 THEN 'EAST DELHI' WHEN 5 THEN 'WEST DELHI'
           WHEN 6 THEN 'NORTH EAST DELHI' WHEN 7 THEN 'NORTH WEST DELHI'
           WHEN 8 THEN 'SOUTH EAST DELHI' WHEN 9 THEN 'SOUTH WEST DELHI'
           WHEN 10 THEN 'SHAHDARA' WHEN 11 THEN 'GURUGRAM'
           WHEN 12 THEN 'FARIDABAD' WHEN 13 THEN 'GAUTAM BUDH NAGAR'
           ELSE 'GHAZIABAD' END                                     AS dist,
    CASE d WHEN 0 THEN 'DELHI-CENTRAL' WHEN 1 THEN 'DELHI-CENTRAL'
           WHEN 2 THEN 'DELHI-SOUTH' WHEN 3 THEN 'DELHI-NORTH'
           WHEN 4 THEN 'DELHI-EAST' WHEN 5 THEN 'DELHI-WEST'
           WHEN 6 THEN 'DELHI-NORTH EAST' WHEN 7 THEN 'DELHI-NORTH WEST'
           WHEN 8 THEN 'DELHI-SOUTH EAST' WHEN 9 THEN 'DELHI-SOUTH WEST'
           WHEN 10 THEN 'DELHI-SHAHDARA' WHEN 11 THEN 'GURUGRAM'
           WHEN 12 THEN 'FARIDABAD' WHEN 13 THEN 'NOIDA'
           ELSE 'GHAZIABAD' END                                     AS city,
    CASE d WHEN 11 THEN '122001' WHEN 12 THEN '121001'
           WHEN 13 THEN '201301' WHEN 14 THEN '201001'
           ELSE ('110' || lpad((1 + turant_seed_hash('pin', cluster_id, 96))::text, 3, '0')) END AS pin,
    CASE d WHEN 11 THEN 'HARYANA' WHEN 12 THEN 'HARYANA'
           WHEN 13 THEN 'UTTAR PRADESH' WHEN 14 THEN 'UTTAR PRADESH'
           ELSE 'DELHI' END                                         AS area
  FROM (SELECT turant_seed_hash('dist', cluster_id, 15)::int AS d) dd
) geo
ON CONFLICT (site_id) DO NOTHING;

DROP FUNCTION turant_seed_hash(text, bigint, bigint);

-- ---- validation (mirrors task section 10) ----
SELECT COUNT(*) AS total_cells FROM public.sim_cell_towers;
SELECT COUNT(DISTINCT cell_id) AS distinct_cell_ids FROM public.sim_cell_towers;
SELECT COUNT(DISTINCT bts_id) AS distinct_bts FROM public.sim_cell_towers;
SELECT COUNT(*) AS delhi_state_rows FROM public.sim_cell_towers WHERE state = 'Delhi';
SELECT tsp_name, COUNT(*) FROM public.sim_cell_towers GROUP BY 1 ORDER BY 2 DESC;
SELECT COUNT(*) AS null_latlng FROM public.sim_cell_towers WHERE latitude IS NULL OR longitude IS NULL;
SELECT COUNT(*) AS dup_cell_ids FROM (SELECT cell_id FROM public.sim_cell_towers GROUP BY 1 HAVING COUNT(*) > 1) d;
SELECT latitude, longitude, COUNT(*) AS cells_at_coord, string_agg(cell_id, ', ' ORDER BY cell_id) AS sample_cells
  FROM public.sim_cell_towers GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 3;
