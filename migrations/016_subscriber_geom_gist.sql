-- =====================================================================
-- TURANT 016: subscriber_dump geom GiST (production-safe build)
-- =====================================================================
-- CLASSIFICATION: RECONSTRUCTED optimization migration (office rebuild).
-- Context: migrations/000b declared idx_subscriber_dump_geom, but the live
-- database has NO GiST index on subscriber_dump.geom (verified via
-- pg_indexes/pg_class 2026-10-01) — every subscriber spatial predicate
-- degrades to Parallel Seq Scan over 100M rows (EXPLAIN cost ~438M).
-- This migration builds the index CONCURRENTLY: zero read/write blocking,
-- safe while the backend stays up. Plain CREATE INDEX is intentionally
-- NOT used (would take ACCESS EXCLUSIVE and stall the pipeline).
-- Run standalone: psql -f migrations/016_subscriber_geom_gist.sql
-- (must NOT run inside an explicit transaction block).
-- =====================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriber_dump_geom
  ON public.subscriber_dump USING GIST (geom);
