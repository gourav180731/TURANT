-- =====================================================================
-- 005_subscriber_dump_cell_index.sql
--
-- Enables the two-stage, cell-indexed path (POLYGON → CELLS → INDEXED
-- SUBSCRIBER LOOKUP) against the real 100M-row subscriber dump.
--
-- The dump has no cell identity of its own, so this additive migration:
--   1. adds a nullable `cell_id` column;
--   2. backfills it from the nearest `telecom_master` cell (the C-DOT BTS
--      reference schema, migration 002) via a GiST-accelerated nearest-
--      neighbour join — only rows whose cell_id is still NULL are touched;
--   3. adds a B-tree index on `cell_id` so the matcher's
--      `cell_id = ANY($1::text[])` predicate is a plain index seek and never a
--      scan over the 100M rows.
--
-- This is Idempotent and additive: nothing existing is dropped or rewritten,
-- every UPDATE only fills NULLs, and re-running is a no-op.
--
-- NOTE ON SCOPE: for a real 100M-row dump this backfill is a one-time, bulk,
-- batch operation (nearest-neighbour over every row), not a low-latency one.
-- It is the bridge that turns the "point-in-polygon over 100M" path into the
-- fast cell-indexed path. For a genuinely production backfill, where the dump
-- carries its own serving cell, point `SUBSCRIBER_DUMP_CELL_COL` at that
-- column instead and skip the backfill below.
-- =====================================================================

-- Step 1: add the column (nothing dropped, never rewrites existing values)
ALTER TABLE subscriber_dump ADD COLUMN IF NOT EXISTS cell_id TEXT;

-- Step 2: backfill only NULL cell_id from the nearest telecom_master cell.
--   LATERAL + `ORDER BY <->` uses the GiST index on telecom_master.geom to find
--   the single nearest BTS per dump row quickly (an index-ordered scan, not a
--   full cross-join).
UPDATE subscriber_dump d
SET cell_id = t.cell_id
FROM LATERAL (
    SELECT tm.cell_id
    FROM telecom_master tm
    WHERE tm.geom IS NOT NULL
    ORDER BY tm.geom <-> d.geom
    LIMIT 1
) t
WHERE d.cell_id IS NULL
  AND d.geom IS NOT NULL;

-- Step 3: B-tree index enabling the indexed (two-stage) subscriber lookup.
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_cell_id ON subscriber_dump (cell_id);

-- =====================================================================
-- Verification
-- =====================================================================
-- SELECT COUNT(*) FROM subscriber_dump WHERE cell_id IS NULL;      -- expect 0 after backfill
-- SELECT cell_id, COUNT(*) FROM subscriber_dump GROUP BY cell_id ORDER BY 2 DESC LIMIT 10;
-- EXPLAIN (ANALYZE, BUFFERS)
--   SELECT DISTINCT msisdn FROM subscriber_dump
--   WHERE cell_id = ANY('{"C-DOT-1001","C-DOT-1002"}'::text[]) LIMIT 100;
--   -- expect: Index/CTE-ish scan using idx_subscriber_dump_cell_id (no seq scan)