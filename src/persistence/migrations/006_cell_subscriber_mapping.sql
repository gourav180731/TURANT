-- =====================================================================
-- 006_cell_subscriber_mapping.sql
--
-- Phase 2/3/4/5 bridge: turn the full-relational cell -> LAC/CISAC bridge
-- that TURANT needs to query the real 100M-row subscriber_dump by its TRUE
-- subscriber-location key (LAC + CISAC), NOT by a fabricated cell_id column.
--
-- The production contract is:
--
--   target_cells (cell_ids)
--        |
--        v
--   cell_subscriber_mapping   (cell_id -> a real geo-location pair)
--        |
--        v
--   (lac, cisac)              (the subscriber_dump lookup key)
--        |
--        v
--   subscriber_dump JOIN  ->  DISTINCT msisdn
--
-- This replaces the previous two-stage "cell_id = ANY(...)" path, which
-- relied on a `cell_id` column that the real dump does NOT have (it was only
-- ever a nearest-`telecom_master` synthetic label). A telecom operator tuning
-- the real cell/LAC/CI master dataset simply imports it into this table via
-- the isolated ingestion path (see `scripts/ingest-cell-mapping.ts`) and the
-- integration is complete — no column on subscriber_dump needs to exist.
--
-- The `subscriber_dump (lac, cisac)` composite index is the real requirement
-- that makes the 50k-cell JOIN hit an index seek instead of a 100M-row scan.
-- It is created without CONCURRENTLY because this migration is additive nad
-- idempotent; run it when the database can take a one-time offline index build
-- (the near-null-proof index on (lac,cisac) is small because those columns have
-- very few distinct combos relative to the row count).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The mapping table: which target cell serves which (lac, cisac) area.
--    One target cell / tower can serve many (lac, cisac) location areas, so
--    the natural key is (cell_id, lac, cisac).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell_subscriber_mapping (
    cell_id              VARCHAR(20)  NOT NULL,
    lac                  VARCHAR(10)  NOT NULL,
    cisac                VARCHAR(10)  NOT NULL,
    -- Optional authoritative enrichment (from the real C-DOT master).
    service_provider     TEXT,
    technology           TEXT,
    -- When/how this row entered the table, so ingest is auditable.
    source               VARCHAR(40)  NOT NULL DEFAULT 'mapping-file',
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Every cell-area allocation is unique; upsert on this key is idempotent.
    CONSTRAINT cell_subscriber_mapping_pkey PRIMARY KEY (cell_id, lac, cisac)
);

-- Lookup path: cell_id -> the (lac, cisac) this cell serves (left side of
-- the join from target_cells). B-tree on (cell_id).
CREATE INDEX IF NOT EXISTS idx_cell_sub_mapping_cell
    ON cell_subscriber_mapping (cell_id);

-- Lookup path: (lac, cisac) -> subscriber_dump rows (right side used when we
-- reverse-resolve). Indexed for reverse resolution / completion statistics.
CREATE INDEX IF NOT EXISTS idx_cell_sub_mapping_area
    ON cell_subscriber_mapping (lac, cisac);

-- ---------------------------------------------------------------------
-- 2. The composite lookup index on the REAL 100M-row subscriber_dump.
--    la+cisac is the genuine subscriber-location key, so a JOIN on
--    (lac, cisac) uses this index seek (never a full scan), regardless of
--    how many cells are in target_cells.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_lac_cisac
    ON subscriber_dump (lac, cisac);

-- ---------------------------------------------------------------------
-- Verification (run manually when the DB is quiet):
--   EXPLAIN (ANALYZE, BUFFERS)
--   WITH target AS (SELECT unnest($1::text[]) AS cell_id)
--   SELECT DISTINCT msisdn
--   FROM target
--   JOIN cell_subscriber_mapping m ON m.cell_id = target.cell_id
--   JOIN subscriber_dump s ON s.lac = m.lac AND s.cisac = m.cisac;
--   -- expect: a Bitmap/Index Scan on idx_subscriber_dump_lac_cisac, not Seq Scan.
-- =====================================================================