-- =====================================================================
-- TURANT 008: subscriber_dump.serving_cell_id + data_provenance cols
-- =====================================================================
-- PHASE 1 COMPLIANCE: Before applying → BACKUP subscriber_dump first
--   (docs/ROLLBACK_PROCEDURE.md step 1)
--
-- PREREQUISITES:
--   - subscriber_dump already exists with id PK (migration 004 applied ✅)
--   - cell_network_mapping / sim_cell_towers already exist with PKs
-- =====================================================================

-- 1. ADD serving_cell_id (nullable — metadata-only in PG 11+ with no DEFAULT)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='subscriber_dump' AND column_name='serving_cell_id'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD COLUMN serving_cell_id TEXT;        -- nullable initially
  END IF;
END $$;

-- 2. ADD data provenance columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='subscriber_dump' AND column_name='data_source'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD COLUMN data_source TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='subscriber_dump' AND column_name='generation_batch_id'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD COLUMN generation_batch_id UUID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='subscriber_dump' AND column_name='generation_timestamp'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD COLUMN generation_timestamp TIMESTAMPTZ;
  END IF;
END $$;

-- 3. data_source CHECK constraint (enforce taxonomy)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_data_source'
  ) THEN
    ALTER TABLE subscriber_dump ADD CONSTRAINT ck_subdump_data_source
      CHECK (data_source IS NULL OR data_source IN (
        'existing_synthetic_pan_india_100m',
        'existing_synthetic_delhi_legacy_v0',
        'synthetic_delhi_expansion_v1',
        'imported_reference',
        'real_reference_data'
      ));
  END IF;
END $$;

COMMENT ON COLUMN subscriber_dump.serving_cell_id IS
  'Authoritative serving cell FK. NULL = legacy pan-India subscriber NOT mapped (excluded from cell-indexed matcher).';
COMMENT ON COLUMN subscriber_dump.data_source IS
  'Provenance taxonomy. See docs/SUBSCRIBER_GENERATION.md section 10.';

-- =====================================================================
-- 4. INITIAL data_source tagging for EXISTING rows (SAFE BATCH UPDATES)
--    Existing 100M: ~2.7M Delhi legacy, rest pan-India
--    Uses existing state column — NOT ideal but 1-time backfill tag
--    We mark ALL existing rows by state ILIKE; serving_cell_id stays NULL
--    (cell-indexed matcher will correctly exclude them via WHERE NOT NULL)
-- =====================================================================

-- 4a. Tag non-Delhi (97.3M rows). Run in 10K OFFSET/LIMIT batches externally
--     via validate-telecom-data script to avoid 1 long TX.
--     Migration 008 only backfills tags for <1M rows safely if applicable:
-- DO NOT RUN FULL-COUNTRY UPDATE HERE. Handle in script.

-- 5. INDEX ON serving_cell_id (CONCURRENTLY — avoids write-lock table)
--    CONCURRENTLY may only be run outside a transaction block.
--    Run this via `CREATE INDEX CONCURRENTLY` as standalone command.
--    The DDL here is idempotent-safe:
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_serving_cell
  ON subscriber_dump(serving_cell_id);

-- Optional covering variant (for metrics GROUP BY without heap):
-- CREATE INDEX IF NOT EXISTS idx_subscriber_dump_serving_cell_covering
--   ON subscriber_dump(serving_cell_id)
--   INCLUDE (imsi, msisdn, operator, technology, state, district, city);

-- 6. Indexes for fast state-based reporting (validate command needs them)
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_state
  ON subscriber_dump(state);

CREATE INDEX IF NOT EXISTS idx_subscriber_dump_operator
  ON subscriber_dump(operator);

CREATE INDEX IF NOT EXISTS idx_subscriber_dump_technology
  ON subscriber_dump(technology);

-- Composite for operator/tech breakdowns
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_state_operator
  ON subscriber_dump(state, operator);

-- =====================================================================
-- 6b. UNIQUE cell_id on the authoritative tower table (FK prereq)
--     cell_network_mapping.cell_id is NOT unique (3 area rows per cell), so
--     the serving_cell_id FK MUST reference the authoritative 1:1 cell table.
--     sim_cell_towers.cell_id is unique per row (50K cells). A UNIQUE index
--     is the only valid FK target.
-- =====================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_sim_cell_towers_cell_id
  ON sim_cell_towers(cell_id);

-- =====================================================================
-- 7. FK CONSTRAINT — NOT VALID INITIALLY → VALIDATE LATER (PHASE 3)
--    First backfill 100M Delhi expansion rows, then run VALIDATE CONSTRAINT
--    VALIDATE does NOT acquire ACCESS EXCLUSIVE lock — just scans.
--    Target: sim_cell_towers(cell_id) — the authoritative 1:1 cell table.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='fk_subdump_serving_cell'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT fk_subdump_serving_cell
      FOREIGN KEY (serving_cell_id) REFERENCES sim_cell_towers(cell_id)
      ON DELETE SET NULL
      NOT VALID;   -- Do NOT scan now — 100M rows would take minutes
                   -- Run `ALTER TABLE subscriber_dump VALIDATE CONSTRAINT fk_subdump_serving_cell;`
                   -- AFTER the 100M expansion batch inserts are done.
  END IF;
END $$;
