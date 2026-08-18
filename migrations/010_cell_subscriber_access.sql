-- =====================================================================
-- TURANT 010: cell → subscriber NUMERIC access path + precomputed stats
-- =====================================================================
-- PERFORMANCE-ONLY migration (Phase 4/5). Read-only of existing data:
--   + subscriber_cell_index  — compact int4 postings (serving_cell_id, subscriber_id)
--   + cell_subscriber_stats  — per-cell COUNT(*) derived from the dump (never hard-coded)
--   + cell_postings          — per-cell int4[] for intarray union evaluation (VERSION D)
--
-- These do NOT change the authoritative relationship:
--   subscriber --serving_cell_id--> cell --cell_id--> tower --> geography
-- They are derived FROM subscriber_dump.serving_cell_id exactly; they cannot
-- invent subscribers or geography.
--
-- Populated by `scripts/build-cell-subscriber-access.ts` (idempotent, resumable).
-- =====================================================================

-- 1. Numeric-ID cell → subscriber mapping (PK = the cell→id postings).
CREATE TABLE IF NOT EXISTS public.subscriber_cell_index (
  serving_cell_id text NOT NULL,
  subscriber_id   int4 NOT NULL,
  CONSTRAINT subscriber_cell_index_pkey PRIMARY KEY (serving_cell_id, subscriber_id)
);

-- NOTE: no FK to sim_cell_towers here on purpose. sim_cell_towers is keyed by
-- site_id and has no UNIQUE CONSTRAINT on cell_id (only a plain index), so an
-- FK would require altering the authoritative tower table. These tables are
-- DERIVED, rebuildable caches populated FROM subscriber_dump.serving_cell_id,
-- whose own FK (fk_subdump_serving_cell) already guarantees cell validity.

ANALYZE public.subscriber_cell_index;

-- 2. Precomputed per-cell subscriber counts (COUNT(*) from real data only).
CREATE TABLE IF NOT EXISTS public.cell_subscriber_stats (
  cell_id                  text PRIMARY KEY,
  subscriber_count         int8 NOT NULL CHECK (subscriber_count >= 0),
  unique_subscriber_count  int8 NOT NULL CHECK (unique_subscriber_count >= 0),
  last_updated             timestamptz NOT NULL DEFAULT now()
);

ANALYZE public.cell_subscriber_stats;

-- 3. intarray postings (VERSION D experiment; requires `CREATE EXTENSION intarray`).
CREATE EXTENSION IF NOT EXISTS intarray;
CREATE TABLE IF NOT EXISTS public.cell_postings (
  cell_id        text PRIMARY KEY,
  subscriber_ids int4[] NOT NULL
);

ANALYZE public.cell_postings;

-- =====================================================================
-- REBUILD (run via scripts/build-cell-subscriber-access.ts, NOT here):
--   subscriber_cell_index   <- SELECT serving_cell_id, id FROM subscriber_dump
--                              WHERE serving_cell_id IS NOT NULL
--   cell_subscriber_stats   <- GROUP BY serving_cell_id
--   CLUSTER subscriber_cell_index USING subscriber_cell_index_pkey; ANALYZE;
-- =====================================================================