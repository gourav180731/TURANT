-- =====================================================================
-- TURANT 000: RECONSTRUCTED base schema (office-laptop rebuild)
-- =====================================================================
-- CLASSIFICATION: RECONSTRUCTED SCHEMA — NOT the original 001-007.
-- The Git repository contains only migrations/008-014. Base migrations
-- 001-007 were never committed, so the CREATE TABLE statements below were
-- reverse-engineered from repository evidence:
--   * docs/guides/SUBSCRIBER_GENERATION.md section 11 (subscriber_dump cols)
--   * docs/guides/INTEGRATION_REQUIREMENTS.md (subscriber_dump/cell_towers)
--   * src/test/.../EwsPipelineIntegrationTest.java (minimal DDL for both)
--   * SubscriberCellStatsService.java (turant_agg.cell_subscriber_agg cols:
--       serving_cell_id, sub_count, distinct_count)
--   * PostGisTowerSource.java (needs site_id, cell_id, latitude, longitude,
--       coverage_radius_m; radius coverage model by default)
--   * User-supplied pgAdmin screenshots of the old MTNL Delhi cell-site
--       table (service_provider, cell_id, latitude, longitude, service_area,
--       state, district, city_town, pincode, bts_id, site_type, switch_make,
--       switch_model, state_id, geom, rnc_id, tsp_name, rnc_ip)
--
-- PostGIS-dependent objects (geom columns, GIST indexes) live in
-- 000b_postgis_geo_reconstructed.sql, applied AFTER the PostGIS binaries
-- are installed (CREATE EXTENSION postgis). This file is PostGIS-FREE so
-- the scalar schema can be built immediately.
--
-- Apply order: 000 -> 008 -> 009 -> 010 -> 011 -> 012 -> 013 -> 014
--              -> 000b (postgis) -> 015 compat view
-- Idempotent: safe to re-run (IF NOT EXISTS / DO blocks).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sim_cell_towers — authoritative tower table (1 row per site).
--    Superset of app-required cols + old MTNL Delhi descriptive cols.
--    Cell-level identity is preserved: many cells may share one lat/lng.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sim_cell_towers (
  site_id           TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  coverage_radius_m DOUBLE PRECISION,

  -- Old Delhi cell-site descriptive columns (from pgAdmin screenshots)
  service_provider  TEXT,
  service_area      TEXT,
  state             TEXT,
  district          TEXT,
  city_town         TEXT,
  pincode           TEXT,
  bts_id            TEXT,
  site_type         TEXT,
  switch_make       TEXT,
  switch_model      TEXT,
  state_id          INTEGER,
  rnc_id            TEXT,
  tsp_name          TEXT,
  rnc_ip            TEXT,

  -- Generation-spec columns (SUBSCRIBER_GENERATION.md section 3.1:
  -- cell_operator + cell_technology are authoritative per tower site)
  technology        TEXT
);
-- NOTE: UNIQUE(cell_id) is added by migration 008 (ux_sim_cell_towers_cell_id),
-- which is the FK target for subscriber_dump.serving_cell_id. Not declared
-- here so 008 remains the single owner of that constraint.

CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_state
  ON public.sim_cell_towers(state);
CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_tsp
  ON public.sim_cell_towers(tsp_name);

COMMENT ON TABLE public.sim_cell_towers IS
  'RECONSTRUCTED base (000). Authoritative 1:1 cell table. Scalar part; geometry in 000b.';

-- ---------------------------------------------------------------------
-- 2. subscriber_dump — authoritative raw subscriber table (pre-008 shape).
--    serving_cell_id / data_source / generation_batch_id /
--    generation_timestamp are added by migration 008. CHECK constraints
--    are added by migration 009. UNIQUE(imsi/msisdn) added by 009.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriber_dump (
  id          BIGSERIAL PRIMARY KEY,
  imsi        VARCHAR(18),
  msisdn      VARCHAR(15) NOT NULL,
  lac         VARCHAR(10),
  cisac       VARCHAR(10),
  technology  VARCHAR(10),
  lact_date   VARCHAR(10),
  last_time   VARCHAR(10),
  city        VARCHAR(50),
  state       VARCHAR(50),
  latitude    TEXT,
  longitude   TEXT,
  operator    VARCHAR(50),
  district    VARCHAR(50)
);

COMMENT ON TABLE public.subscriber_dump IS
  'RECONSTRUCTED base (000). Authoritative raw subscriber source. Scalar part; geometry in 000b; serving_cell_id/provenance in 008; checks in 009.';

-- ---------------------------------------------------------------------
-- 3. turant_agg.cell_subscriber_agg — precomputed per-cell aggregate.
--    PRIMARY O(cells) path for countAndDistinctByCellIds().
--    Columns per SubscriberCellStatsService javadoc: (serving_cell_id,
--    sub_count, distinct_count). Built FROM subscriber_dump (never invented).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS turant_agg;

CREATE TABLE IF NOT EXISTS turant_agg.cell_subscriber_agg (
  serving_cell_id TEXT PRIMARY KEY,
  sub_count       BIGINT NOT NULL CHECK (sub_count >= 0),
  distinct_count  BIGINT NOT NULL CHECK (distinct_count >= 0)
);

COMMENT ON TABLE turant_agg.cell_subscriber_agg IS
  'RECONSTRUCTED base (000). Derived aggregate, rebuilt from subscriber_dump via GROUP BY serving_cell_id.';
