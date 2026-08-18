# TURANT — ROLLBACK PROCEDURE (PHASE 2/3 SAFETY)

> **Non-negotiable Rule #25:** Never blindly drop/replace existing subscriber data. Every destructive operation has an explicit, tested rollback path.
>
> **Phase 3 state (as of this doc):** Migrations **008 + 009 applied**; Delhi expansion **generated (table = 191,547,362; expansion = 97,457,009; Delhi = 100,000,000)**; FK `fk_subdump_serving_cell` VALIDATED; default matcher is **`cell-indexed`** (`serving_cell_id`). All rollback paths below reflect this applied state.

---

## 1. PRE-MIGRATION BACKUP (Step 0 — BEFORE running 008/009)

Run **one** of the following depending on your environment (PostgreSQL native or Docker).

### Option A: pg_dump native backup
```bash
BACKUP_TS=$(date +%Y%m%d_%H%M%S)
DATABASE_URL=$(node -e "console.log(require('dotenv').config().parsed.DATABASE_URL ?? process.env.DATABASE_URL ?? '')")
# Extract schema from URL:
PGPASSWORD=... pg_dump \
  -h <host> -p <port> -U <user> \
  -d turant \
  -F c \
  --compress=zstd:3 \
  -j 4 \
  -f backups/turant_pre_migration_008_009_${BACKUP_TS}.dump \
  -n public \
  -t subscriber_dump \
  -t cell_network_mapping \
  -t cell_subscriber_mapping \
  -t cell_towers \
  -t sim_cell_towers \
  -t telecom_master \
  -t alerts \
  -t alert_reports \
  -t subscribers \
  -t sim_seeder_checkpoints
```

### Option B: In-place table copies (cheaper than pg_dump for quick rollback of schema columns)
```sql
-- Schema-only clone of subscriber_dump (data copy for critical tables only if space < 2x)
CREATE TABLE IF NOT EXISTS subscriber_dump_schema_snapshot_202603
  AS SELECT * FROM subscriber_dump LIMIT 0;

-- Copy critical rows count / stats (not full data)
CREATE TABLE IF NOT EXISTS subdump_pre_migration_stats_202603 AS
SELECT
  COUNT(*) AS rows,
  COUNT(DISTINCT imsi) AS imsis,
  COUNT(DISTINCT msisdn) AS msisdns,
  COUNT(DISTINCT state) AS states,
  COUNT(DISTINCT (lac,cisac)) AS lac_cisac_pairs,
  NOW() AS snapshotted_at
FROM subscriber_dump;

-- Cell / mapping tables are small (150K rows max) → FULL COPY:
CREATE TABLE IF NOT EXISTS cell_network_mapping_snapshot_202603
  AS TABLE cell_network_mapping;

CREATE TABLE IF NOT EXISTS cell_subscriber_mapping_snapshot_202603
  AS TABLE cell_subscriber_mapping;

CREATE TABLE IF NOT EXISTS sim_seeder_checkpoints_snapshot_202603
  AS TABLE sim_seeder_checkpoints;
```

### Verify backup integrity BEFORE continuing:
```bash
pg_restore --list backups/turant_pre_migration_008_009_*.dump | head -40
```

---

## 2. APPLY MIGRATIONS (SAFE ORDER)

```sql
-- Apply 008 (metadata steps; CONCURRENTLY index must be outside TX):
\i migrations/008_subscriber_dump_serving_cell.sql

-- After 008 completes, standalone run (NOT inside \i transaction block):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriber_dump_serving_cell
  ON subscriber_dump(serving_cell_id);

-- Verify 008 applied:
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name='subscriber_dump'
  AND column_name IN ('serving_cell_id','data_source',
                      'generation_batch_id','generation_timestamp');
-- Expected: 4 rows, all nullable.

-- Apply 009 (integrity constraints). NOTE: ux_subscriber_dump_imsi /
-- ux_subscriber_dump_msisdn UNIQUE indexes in 009 are NOT CONCURRENT.
-- If running on a live system, extract the CREATE UNIQUE INDEX statements
-- from 009 and run them CONCURRENTLY first, then apply rest of 009.
\i migrations/009_subscriber_dump_constraints.sql
```

---

## 3. ROLLBACK PATH — If 008/009 Must Be Undone

```sql
-- =====================================================================
-- Rollback 009 constraints first
-- =====================================================================
ALTER TABLE subscriber_dump
  DROP CONSTRAINT IF EXISTS uq_subdump_imsi           CASCADE,
  DROP CONSTRAINT IF EXISTS uq_subdump_msisdn         CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_imsi_fmt       CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_msisdn_fmt     CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_lat_range      CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_lng_range      CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_lac_fmt        CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_cisac_fmt      CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_tech           CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_op             CASCADE;

DROP INDEX IF EXISTS ux_subscriber_dump_imsi;
DROP INDEX IF EXISTS ux_subscriber_dump_msisdn;

-- =====================================================================
-- Rollback 008 FK, columns, indexes
-- =====================================================================
ALTER TABLE subscriber_dump
  DROP CONSTRAINT IF EXISTS fk_subdump_serving_cell   CASCADE,
  DROP CONSTRAINT IF EXISTS ck_subdump_data_source    CASCADE,
  DROP COLUMN IF EXISTS serving_cell_id       CASCADE,
  DROP COLUMN IF EXISTS data_source           CASCADE,
  DROP COLUMN IF EXISTS generation_batch_id   CASCADE,
  DROP COLUMN IF EXISTS generation_timestamp  CASCADE;

DROP INDEX IF EXISTS idx_subscriber_dump_serving_cell;
DROP INDEX IF EXISTS idx_subscriber_dump_serving_cell_covering;
DROP INDEX IF EXISTS idx_subscriber_dump_state;
DROP INDEX IF EXISTS idx_subscriber_dump_operator;
DROP INDEX IF EXISTS idx_subscriber_dump_technology;
DROP INDEX IF EXISTS idx_subscriber_dump_state_operator;

-- Verify rollback: subscriber_dump should now have 15 cols only
-- (imsi,msisdn,lac,cisac,technology,lact_date,last_time,city,state,
--  latitude,longitude,operator,district,id,geom)
SELECT COUNT(*) FROM information_schema.columns WHERE table_name='subscriber_dump';
-- Expected: 15
```

---

## 4. ROLLBACK 100M DELHI EXPANSION DATA (Preserve Other States!)

**IMPORTANT (Rule #5):** We MUST be able to delete ONLY the 100M new Delhi expansion rows WITHOUT touching the 94.1M existing non-Delhi legacy subscribers OR the ~2.5M existing Delhi legacy rows.

**Data provenance strategy makes this TRIVIAL:**
```sql
-- ROLLBACK DELHI 100M EXPANSION ONLY (target: 97,457,009 rows deleted; 94,090,353 remain)
BEGIN;
  SET LOCAL statement_timeout = '3600s';       -- 1 hour budget for bulk delete
  SET LOCAL work_mem = '2GB';
  -- Use data_source tag (added in 008) to identify expansion set:
  DELETE FROM subscriber_dump
   WHERE data_source = 'synthetic_delhi_expansion_v1';

  -- Optionally: reset checkpoint for this dataset so generation can restart
  DELETE FROM sim_seeder_checkpoints
   WHERE dataset = 'delhi_100M_exp_v1';
COMMIT;

-- VACUUM afterwards to reclaim space (required for 100M bulk delete)
VACUUM ANALYZE subscriber_dump;
```

### SAFETY CHECK before delete (dry-run count):
```sql
SELECT COUNT(*) FROM subscriber_dump WHERE data_source = 'synthetic_delhi_expansion_v1';
-- Expected: 97,457,009 (exactly what we generated — not 191.5M, not 2.5M)
```

If `data_source='synthetic_delhi_expansion_v1'` would accidentally catch more rows than intended (can't happen per constraints but just in case):
```sql
-- Second filter: serving_cell_id IN (sim_cell_towers Delhi-NCR sites)
-- to confine delete to the cell-mapped expansion set ONLY:
DELETE FROM subscriber_dump
 WHERE data_source = 'synthetic_delhi_expansion_v1'
   AND serving_cell_id IN (
     SELECT site_id FROM sim_cell_towers
      WHERE state IN ('DELHI','HARYANA','UTTAR PRADESH')
        AND city IN ('NEW DELHI','DELHI','GURUGRAM','FARIDABAD',
                     'NOIDA','GHAZIABAD','GREATER NOIDA','VAISHALI')
   );
```

---

## 5. ROLLBACK INDIVIDUAL GENERATION BATCHES

If a single batch (1M rows among 100 batches) is corrupted, we can delete exactly that batch via `generation_batch_id`:
```sql
DELETE FROM subscriber_dump WHERE generation_batch_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
VACUUM ANALYZE subscriber_dump;
```
Then re-run the generator; checkpoint counter will allow it to resume from correct batch index.

---

## 6. ROLLBACK ORDER FOR FULL PHASE 3

If we must completely undo PHASE 3 (everything applied during implementation):

1. `DELETE` expansion rows (Section 4) — removes 97,457,009, leaving 94,090,353
2. `VACUUM ANALYZE subscriber_dump`
3. Undo constraints and schema additions (Section 3)
4. Revert application config to the legacy default: set `SUBSCRIBER_DUMP_LOOKUP_MODE=bridge` and `SUBSCRIBER_DUMP_CELL_COL=cell_id` (or unset the overrides in `.env`/`src/config/schema.ts`)
5. Restart the backend to load the original `CellSubscriberBridgeMatcher`
6. Run `npm run validate:telecom-data` to confirm baseline integrity matches pre-migration stats (compare with `subdump_pre_migration_stats_202603`)

---

## 7. SMOKE TEST FOR ROLLBACK VALIDATION

After rollback, run the following and compare output to baseline:

```sql
SELECT
  COUNT(*)                                        AS total_rows,
  COUNT(DISTINCT state)                           AS states,
  COUNT(*) FILTER (WHERE state ILIKE '%Delhi%')   AS delhi_rows,
  COUNT(DISTINCT imsi)                            AS imsis,
  COUNT(DISTINCT msisdn)                          AS msisdns
FROM subscriber_dump;
```

Expected to return the same values as:
```sql
SELECT * FROM subdump_pre_migration_stats_202603;
```

(Approximate ±0.5% if there were on-going writes during backup; for this test DB it should be 100% exact. **Post-rollback expected: total_rows = 94,090,353; delhi_rows ≈ 2.5M.**)

---

## 8. AUTOMATED SAFETY GUARD IN GENERATION SCRIPT

The 100M generator script will REFUSE to run if:
- Backup snapshot tables (Section 1.B) do NOT exist → forces user to run backup first.
- 008/009 not applied → exits with `MIGRATION_NOT_APPLIED` error.
- Any existing `data_source='synthetic_delhi_expansion_v1'` rows are present AND checkpoint says completed → prompts user to run rollback Section 4 first or force via `--resume` flag.
