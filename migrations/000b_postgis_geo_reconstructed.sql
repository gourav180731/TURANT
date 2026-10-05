-- =====================================================================
-- TURANT 000b: RECONSTRUCTED PostGIS geometry (office-laptop rebuild)
-- =====================================================================
-- CLASSIFICATION: RECONSTRUCTED — NOT original DDL.
-- Apply ONLY AFTER the PostGIS binaries are installed on the server and
--   CREATE EXTENSION postgis;
-- succeeds. (Office laptop 2026-09-28: PostgreSQL 18 has NO PostGIS yet;
-- this file is staged until the user installs the EDB PostGIS bundle.)
--
-- Expected geometry contract (from code + screenshots):
--   sim_cell_towers.geom  GEOMETRY(Point, 4326)   -- cell-site coordinates
--   subscriber_dump.geom  GEOMETRY(Point, 4326)   -- subscriber position
--   SRID 4326 (WGS84), app default tower.geom-srid=4326.
-- Idempotent: safe to re-run.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---- sim_cell_towers point geometry (mirrors old `geom` column) ----
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sim_cell_towers'
       AND column_name='geom'
  ) THEN
    ALTER TABLE public.sim_cell_towers
      ADD COLUMN geom GEOMETRY(Point, 4326);
  END IF;
END $$;

-- Optional polygon coverage model (TOWER_COVERAGE_MODEL=polygon only;
-- default is radius, so this column stays NULL unless polygon RF data
-- is imported later).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sim_cell_towers'
       AND column_name='coverage_geom'
  ) THEN
    ALTER TABLE public.sim_cell_towers
      ADD COLUMN coverage_geom GEOMETRY(Polygon, 4326);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_geom
  ON public.sim_cell_towers USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_coverage_geom
  ON public.sim_cell_towers USING GIST(coverage_geom);

-- ---- subscriber_dump point geometry ----
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subscriber_dump'
       AND column_name='geom'
  ) THEN
    ALTER TABLE public.subscriber_dump
      ADD COLUMN geom GEOMETRY(Point, 4326);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_subscriber_dump_geom
  ON public.subscriber_dump USING GIST(geom);
