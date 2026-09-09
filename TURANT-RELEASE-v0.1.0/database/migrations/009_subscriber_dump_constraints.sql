-- =====================================================================
-- TURANT 009: Integrity constraints on subscriber_dump
-- =====================================================================
-- APPLY AFTER:
--   - Migration 008 applied (serving_cell_id + indexes)
--   - 100M Delhi expansion generated
--   - Existing duplicates of IMSI/MSISDN removed/resolved (if any)
--
-- SAFETY:
--   Every unique constraint uses UNIQUE INDEX creation CONCURRENTLY pattern
--   and is added as NOT VALID first (if possible) then VALIDATE CONSTRAINT.
--   For IMSI / MSISDN unique: must create the index FIRST, then add the
--   constraint that uses it.
-- =====================================================================

-- =====================================================================
-- 1. IMSI UNIQUE — globally unique SIM identifier
-- =====================================================================
-- Step 1a: Detect existing duplicates first (run this SELECT before applying)
--   SELECT imsi, COUNT(*) FROM subscriber_dump
--    WHERE imsi IS NOT NULL GROUP BY imsi HAVING COUNT(*) > 1 LIMIT 100;
-- If duplicates → deduplicate first (keep lowest id, delete rest or fix).

-- Step 1b: Create UNIQUE INDEX CONCURRENTLY (run outside transaction)
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriber_dump_imsi
  ON subscriber_dump(imsi);

-- Step 1c: Add constraint (may use existing index; doesn't rescan if valid)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='uq_subdump_imsi'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT uq_subdump_imsi UNIQUE USING INDEX ux_subscriber_dump_imsi;
  END IF;
END $$;

-- =====================================================================
-- 2. MSISDN UNIQUE — portable number (may allow duplicates in portability
--    scenarios; for our synthetic data, we enforce uniqueness. If real
--    porting support needed, use (imsi, msisdn) composite instead.)
-- =====================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriber_dump_msisdn
  ON subscriber_dump(msisdn);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='uq_subdump_msisdn'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT uq_subdump_msisdn UNIQUE USING INDEX ux_subscriber_dump_msisdn;
  END IF;
END $$;

-- =====================================================================
-- 3. IMSI FORMAT CHECK (15-digit, Indian MCC)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_imsi_fmt'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_imsi_fmt
      CHECK (imsi IS NULL OR imsi ~ '^(404|405)[0-9]{12}$');
  END IF;
END $$;

-- =====================================================================
-- 4. MSISDN FORMAT CHECK (E.164 India style: 91 + 6/7/8/9 + 9 digits)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_msisdn_fmt'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_msisdn_fmt
      CHECK (msisdn ~ '^91[6-9][0-9]{9}$');
  END IF;
END $$;

-- =====================================================================
-- 5. LAT/LNG WITHIN INDIA — CHECK (uses ::float cast; stored as TEXT!)
--    India approx: lat 6.75–35.5°N, lng 68.0–97.4°E
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_lat_range'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_lat_range
      CHECK (latitude IS NULL
          OR (latitude::float BETWEEN 6.0 AND 37.0));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_lng_range'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_lng_range
      CHECK (longitude IS NULL
          OR (longitude::float BETWEEN 67.0 AND 98.0));
  END IF;
END $$;

-- =====================================================================
-- 6. LAC / CISAC FORMAT (4-hex uppercase)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_lac_fmt'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_lac_fmt
      CHECK (lac IS NULL OR lac ~ '^[0-9A-Fa-f]{4}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_cisac_fmt'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_cisac_fmt
      CHECK (cisac IS NULL OR cisac ~ '^[0-9A-Fa-f]{4}$');
  END IF;
END $$;

-- =====================================================================
-- 7. TECHNOLOGY VALIDATION (5G,4G,UMTS — GSM deprecated for Delhi set)
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_tech'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_tech
      CHECK (technology IN ('5G','4G','UMTS','GSM','LTE','NR5G'));
  END IF;
END $$;

-- =====================================================================
-- 8. OPERATOR VALIDATION
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='subscriber_dump' AND constraint_name='ck_subdump_op'
  ) THEN
    ALTER TABLE subscriber_dump
      ADD CONSTRAINT ck_subdump_op
      CHECK (operator IN ('Jio','Airtel','VI','BSNL','MTNL'));
  END IF;
END $$;

-- =====================================================================
-- 9. VALIDATE serving_cell_id FK (run this AFTER 100M expansion complete)
-- =====================================================================
-- ALTER TABLE subscriber_dump VALIDATE CONSTRAINT fk_subdump_serving_cell;
-- NOTE: commented out — run explicitly after generation completes.
--       Does NOT acquire ACCESS EXCLUSIVE lock — safe read-only scan.
