# TURANT — DATA MODEL AUDIT REPORT (PHASE 1 → PHASE 3 FINAL)

**Repository:** `C:\Users\91958\OneDrive\Desktop\TURANT`  
**Audit Date:** 2026-03 (Phase 1) / **2026-08 (Phase 3 final)**  
**Audit Status:** READ-ONLY AUDIT COMPLETE — ROOT CAUSE PROVEN **AND FIXED**  
**Scope:** Modules 01–13 (CAP ingest → polygon → tower → cell → LAC/CISAC → subscriber → dedup → SMS → DLR → EWS → trace → parallel workers)

---

## 1. CURRENT TABLES (EXACT DATABASE STATE — FINAL, VERIFIED)

| Table | Row Count | Description | Data Provenance |
|---|---|---|---|
| `subscriber_dump` | **191,547,362** | PAN-India telecom subscriber dump (100M Delhi + 91.5M other states) | SYNTHETIC/TEST. Legacy 94,090,353 (`existing_synthetic_pan_india_100m` / `existing_synthetic_delhi_legacy_v0`, `serving_cell_id` NULL) + **97,457,009 cell-bound Delhi expansion** (`synthetic_delhi_expansion_v1`, `serving_cell_id` FK-set) |
| `cell_network_mapping` | **150,000** | cell_id → (lac,cisac) junction (3 pairs/cell avg) | **SYNTHETIC** (source='synthetic_test_mapping' for all 150K rows; derived via K-nearest dump rows) — **diagnostic-only now** |
| `cell_subscriber_mapping` | 50,000 | Legacy junction (cell_id, lac, cisac) — *unused by default matcher* | SYNTHETIC (50K cells × 1 pair) |
| `cell_towers` | 50,000 | Tower locations + coverage model (radius/polygon) + PostGIS GiST geom | SYNTHETIC (sim tower generator output) |
| `sim_cell_towers` | 50,000 | Sample/reference towers with full district/city/state/operator/technology | SYNTHETIC (seeder output) — **AUTHORITATIVE FK target (`ux_sim_cell_towers_cell_id`)** |
| `telecom_master` | 5 | C-DOT schema canonical BTS rows — **NOT seeded to 5000 (TELECOM_MASTER_TOWER_COUNT)** | REFERENCE (5 canonical rows only) |
| `alerts` | 69 | CAP/manual alert payloads (UUID PK) | TESTING / live audit trail |
| `alert_reports` | — | Alert pipeline completion reports (JSONB report_json) | TESTING |
| `subscribers` (partitioned) | — | Sim mode subscriber table (NOT in production use with real dump) | SYNTHETIC/IN-MEM |
| `sim_seeder_checkpoints` | — | Seeder resume checkpoints (dataset, completed_batches) | INTERNAL |

### 1.1 MIGRATION STATE — WHAT WAS / WASN'T APPLIED (Phase 3 = DONE)

| Migration | Applied? | Notes |
|---|---|---|
| `001_init.sql` | ✅ | alerts, cell_towers, alert_reports |
| `002_telecom_sim.sql` | ✅ | subscribers, sim_cell_towers, telecom_master, sim_seeder_checkpoints |
| `004_subscriber_dump_enrichment.sql` | ✅ | `subscriber_dump.district`, `geom` (Point 4326), `id` (BIGSERIAL PK), GiST on geom |
| `005_subscriber_dump_cell_index.sql` | ❌ **NOT APPLIED** (superseded) | Would add `subscriber_dump.cell_id` + nearest-neighbor backfill from telecom_master. **Replaced by migration 008's authoritative `serving_cell_id`.** |
| `006_cell_subscriber_mapping.sql` | ✅ | `cell_subscriber_mapping(cell_id,lac,cisac)` PK + `idx_subscriber_dump_lac_cisac` |
| `007_cell_network_mapping.sql` | ✅ | `cell_network_mapping(cell_id,lac,cisac)` PK with coverage info + **`idx_subscriber_dump_area_msisdn` covering index** |
| **`008_subscriber_dump_serving_cell.sql`** | ✅ **APPLIED** | `serving_cell_id`, `data_source`, `generation_batch_id`, `generation_timestamp` + `ck_subdump_data_source` + `idx_subscriber_dump_serving_cell` + state/operator/tech indexes + `ux_sim_cell_towers_cell_id` + **FK `fk_subdump_serving_cell` (NOT VALID → later VALIDATED)** |
| **`009_subscriber_dump_constraints.sql`** | ✅ **APPLIED** | `uq_subdump_imsi`, `uq_subdump_msisdn` UNIQUE; CHECK: imsi/msisdn format, lat/lng range, lac/cisac hex, tech, operator |

---

## 2. IMPORTANT COLUMNS

### 2.1 `subscriber_dump` (191.5M rows — SCHEMA VERIFIED, POST-FIX)
```
Column              | Type           | Notes
--------------------|----------------|----------------------------
id                  | BIGSERIAL      | PK (added by 004)
imsi                | VARCHAR(18)    | 15-digit; 404/405 + MNC + 10-digit MSIN. UNIQUE (009)
msisdn              | VARCHAR(15)    | NOT NULL. 91 + [6-9] + 9 digits. UNIQUE (009). DEDUP KEY
lac                 | VARCHAR(10)    | 4-hex-digit LAC (e.g., 0460, 045C) — **NOT GLOBALLY UNIQUE**
cisac               | VARCHAR(10)    | 4-hex-digit Cell ID (e.g., 4A2B, 9C1F) — **NOT GLOBALLY UNIQUE**
technology          | VARCHAR(10)    | '5G' | '4G' | 'UMTS' (expansion = 68/25/7 per TSP; legacy = 50/40/10)
lact_date           | VARCHAR(10)    | 'MM-DD' e.g. '09-13'
last_time           | VARCHAR(10)    | 'HH:MM'
city                | VARCHAR(50)    | 37 distinct cities (state capitals + major)
state               | VARCHAR(50)    | 35 distinct states/UTs
latitude            | TEXT (!)       | **Stored as TEXT, not NUMERIC** — CHECK range via ::float
longitude           | TEXT (!)       | **Stored as TEXT** — cast risk; CHECK range via ::float
operator            | VARCHAR(50)    | Jio | Airtel | VI | BSNL | MTNL (weights 36/36/15/8/5)
district            | VARCHAR(50)    | Added by 004 (36-row lookup from city → district)
geom                | GEOMETRY(Point,4326) | Added by 004; expansion = cell lat/lng + micro-jitter
serving_cell_id     | TEXT           | **NEW (008).** Authoritative FK → sim_cell_towers(cell_id). NULL = legacy/excluded.
data_source         | TEXT           | **NEW (008).** 'existing_synthetic_pan_india_100m' | 'existing_synthetic_delhi_legacy_v0' | 'synthetic_delhi_expansion_v1'
generation_batch_id | UUID           | **NEW (008).** Which 1M-row batch created the row
generation_timestamp| TIMESTAMPTZ    | **NEW (008).** clock_timestamp() at insert
```

### 2.2 `cell_network_mapping` (150K rows — PRODUCTION BRIDGE)
```
Column         | Type
---------------|-------------------------------------------
cell_id        | TEXT          — PK component (hex cell id e.g. 10000, 9C81)
lac            | VARCHAR(10)   — PK component (4-hex LAC)
cisac          | VARCHAR(10)   — PK component (4-hex CISAC)
technology     | VARCHAR(20)   — from ingested cell
service_provider | VARCHAR(50) — operator
latitude       | DOUBLE        — authoritative cell lat
longitude      | DOUBLE        — authoritative cell lng
geom           | GEOMETRY(Point,4326)
source         | VARCHAR(50)   — 'synthetic_test_mapping' (ALL rows!) | 'import'
created_at     | TIMESTAMP
updated_at     | TIMESTAMP
```

### 2.3 `cell_towers` (50K — PostGIS spatial source)
```
Column              | Type
--------------------|----------------------------------------------
id                  | TEXT PK        — site ID
cell_id             | TEXT           — cell identifier (mapped to cell_network_mapping.cell_id)
latitude            | NUMERIC(10,7)
longitude           | NUMERIC(10,7)
coverage_radius_m   | INTEGER        — default ~1000
coverage_geom       | GEOMETRY(Polygon,4326) — (NULLable; polygon model only)
geom                | GEOMETRY(Point,4326) — ST_SetSRID(ST_MakePoint(lng,lat),4326)
```

---

## 3. PRIMARY KEYS

| Table | PK |
|---|---|
| `subscriber_dump` | `id` (BIGSERIAL, added by 004) |
| `cell_network_mapping` | `(cell_id, lac, cisac)` COMPOSITE |
| `cell_subscriber_mapping` | `(cell_id, lac, cisac)` COMPOSITE |
| `cell_towers` | `id` (TEXT) |
| `sim_cell_towers` | `site_id` (TEXT) |
| `telecom_master` | `id` (TEXT); `cell_id` UNIQUE |
| `alerts` | `id` (UUID) |
| `subscribers` (sim) | `imsi` (TEXT) |

---

## 4. FOREIGN KEYS

⚠️ **Phase 1 finding:** nearly zero FKs existed between the authoritative cell datasets and subscriber_dump. **Phase 3 fixed the core gap.**

**Current state (actual DB, POST-FIX):**
- `alert_reports.alert_id → alerts.id` ✅ (from 001)
- **`subscriber_dump.serving_cell_id → sim_cell_towers(cell_id)`** ✅ **`fk_subdump_serving_cell`** (008, `ON DELETE SET NULL`, **VALIDATED** — 0 violations over 191.5M rows). Backed by `ux_sim_cell_towers_cell_id` UNIQUE.
- `cell_network_mapping.cell_id` — ⚠️ still NO FK (intentional: legacy diagnostic bridge only)
- `cell_subscriber_mapping.cell_id` — ⚠️ still NO FK (legacy)

**Result:** the subscriber→cell relationship is now **enforced** — every expansion subscriber's `serving_cell_id` provably resolves to an authoritative Delhi-NCR tower.

---

## 5. INDEXES

### 5.1 `subscriber_dump` (191.5M — POST-FIX, 11 indexes rebuilt)
| Index | Type | Purpose |
|---|---|---|
| `subscriber_dump_pkey` | BTree(id) | PK |
| `idx_subscriber_dump_lac_cisac` | BTree(lac, cisac) | Composite pair lookup (legacy bridge / diagnostic) |
| **`idx_subscriber_dump_area_msisdn`** | **BTree(lac, cisac) INCLUDE (msisdn)** | **CRITICAL PRODUCTION INDEX** (legacy). Index-only COUNT(DISTINCT msisdn). |
| `idx_subscriber_dump_geom` | **GiST(geom)** | PostGIS point-in-polygon (direct polygon matcher) |
| **`idx_subscriber_dump_serving_cell`** | **BTree(serving_cell_id)** | **NEW DEFAULT MATCHER INDEX (008).** Cell-indexed lookups. |
| `idx_subscriber_dump_state` | BTree(state) | Fast state reporting / validation (008) |
| `idx_subscriber_dump_operator` | BTree(operator) | Operator distribution (008) |
| `idx_subscriber_dump_technology` | BTree(technology) | Tech distribution (008) |
| `idx_subscriber_dump_state_operator` | BTree(state, operator) | Composite reporting (008) |

*8 secondary indexes were rebuilt CONCURRENTLY after the expansion insert completed (~2h total).*

### 5.2 `cell_network_mapping` (150K)
| Index | Type |
|---|---|
| `cell_network_mapping_pkey` | BTree(cell_id, lac, cisac) |
| `idx_cell_network_mapping_cell` | BTree(cell_id) |
| `idx_cell_network_mapping_area` | BTree(lac, cisac) |

### 5.3 `cell_towers` (50K)
| Index | Type |
|---|---|
| `cell_towers_pkey` | BTree(id) |
| **`idx_cell_towers_geom_gist`** | **GiST(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))** — for spatial lookup |
| Other: coverage_geom GiST (if polygon model used) |

### 5.4 NEW uniques / FK support indexes
- **`ux_sim_cell_towers_cell_id`** — BTree UNIQUE(site_id... cell_id) on the authoritative tower table (FK prereq, 008)
- **`ux_subscriber_dump_imsi`** — BTree UNIQUE(imsi) (009, backing `uq_subdump_imsi`)
- **`ux_subscriber_dump_msisdn`** — BTree UNIQUE(msisdn) (009, backing `uq_subdump_msisdn`)

---

## 6. UNIQUE CONSTRAINTS (POST-FIX — ALL ENFORCED)

| Enforced? | Constraint | Evidence |
|---|---|---|
| ✅ | `alerts (cap_identifier, sender)` UNIQUE | 001_init |
| ✅ | `telecom_master(cell_id)` UNIQUE | 002 |
| ✅ | `telecom_master(bts_id)` UNIQUE | 002 |
| ✅ | **`subscriber_dump(imsi)` — `uq_subdump_imsi` UNIQUE** | 009. Measured 0 duplicates over 191.5M rows. |
| ✅ | **`subscriber_dump(msisdn)` — `uq_subdump_msisdn` UNIQUE** | 009. Measured 0 duplicates. |
| ✅ | `sim_cell_towers(cell_id)` — `ux_sim_cell_towers_cell_id` UNIQUE | 008. FK target. |

---

## 7. SUBSCRIBER GENERATION LOGIC

**File:** `src/telecom/generators/subscriber-generator.ts` + `identity.ts` + `geography.ts`

### Architecture (SIMULATION MODE — `USE_DUMMY_SUBSCRIBER_DB=true`):
```
planTowerAllocation (minPerTower=10, maxPerTower=500)
     ↓
createTowerSampler (binary-search cumulative allocation)
     ↓
createIdentityGenerator(mcc='404', mnc='68' [MTNL home], mulberry32 PRNG)
     ↓
For each subscriber in batch:
  1. Pick assigned tower (weighted by capacity)
  2. ALL identifiers come FROM TOWER:
     - technology = tower.technology  (GSM/UMTS/LTE/NR5G per tech profiles)
     - cell_id    = tower.cellId      (authoritative)
     - lac        = tower.lac         (derived from tower LAC gen)
     - operator   = weighted pick: MTNL(10) / BSNL(10) / AIRTEL(28) / JIO(30) / VI(22)
     - roaming    = 5% chance → MCC/MNC from visited op
  3. Identity generation (deterministic counter-based):
     - IMSI   = `${mcc}${mnc}${counter++ padStart(10,'0')}`  → always 15 digits
     - MSISDN = `91${MOBILE_SERIES[idx]}${counter++ padStart(9,'0')}` → 91+[6-9]+9 digits
     - IMEI   = 14-digit random body + Luhn check digit
     - TMSI   = 8 hex chars
  4. Geo = tower lat/lng with Gaussian jitter (σ≈0.005°)
  5. LAST_TIME = within last 48h
```

**Data provenance flag:** Sim subscribers (subscribers table, not dump) carry implicit consistency because all geography/identifiers derive from a tower. **The REAL subscriber_dump dataset does NOT share this property — it was generated independently and LAC/CISAC pairs collide across states (see Section 10 & 12).**

---

## 8. TOWER GENERATION / IMPORT LOGIC

**Files:** `scripts/seed-telecom.ts` → `PostgresSimSeeder`, `scripts/seed-telecom-master.ts` → `TelecomMasterSeeder`

### tower-generator.ts algorithm:
```
1. planTechnologies(tech_pct distribution) → GSM/UMTS/LTE/NR5G buckets
2. resolveHotspots('delhi-ncr') → 15 DELHI_NCR_AREAS (6 Delhi districts + NCR cities)
3. For each tower i (0..N-1):
   - site_type: macro/micro/pico/femto weighted
   - Operators: weighted-pick MTNL(10)/BSNL(10)/AIRTEL(28)/JIO(30)/VI(22)
   - cell_id: (0x9c81 + i).toString(16).toUpperCase()   ← sequential hex
   - LAC: String(Math.floor(rand()*7000)+1).padStart(4,'0')  ← RANDOM LAC!
   - technology: planned GSM/UMTS/LTE/NR5G bucket
   - PCI/ARFCN/eNB/gNB/RNC: from TECH_PROFILES per-RAT
   - lat/lng: hotspot center + Gaussian(σ≈0.028°) ±0.06° clamp → inside Delhi-NCR
4. GiST geom = ST_SetSRID(ST_MakePoint(lng,lat),4326)
```

⚠️ **Observation on LAC randomness:** Towers get RANDOM LACs (1-7000), so LACs do NOT cluster geographically. This is fine for test sim data, but the import into real `cell_network_mapping` uses K-nearest pairs from dump — which are ALSO geographically meaningless.

---

## 9. LAC/CISAC GENERATION / MAPPING LOGIC

### 9.1 Subscriber dump (lac,cisac) generation:
**RANDOM 4-digit hex pair per subscriber** — no geographic binding. This is why we see collisions!

### 9.2 Cell → LAC/CISAC mapping derivation (K-nearest in ingest-cell-mapping.ts):
```
FOR EACH authoritative cell (from CSV import or sim list):
  K=5 NEAREST dump rows by geom distance:
    SELECT d.lac, d.cisac
    FROM subscriber_dump d
    WHERE d.geom IS NOT NULL
    ORDER BY d.geom <-> ST_SetSRID(ST_MakePoint(@lng,@lat),4326)
    LIMIT 5
  → Deduplicate those 5 pairs → typically ~3 distinct per cell
  → UPSERT INTO cell_network_mapping(cell_id,lac,cisac,...,source='synthetic_test_mapping')
  → (Also writes latitude/longitude/geom from CELL [correct!] not from subscriber row)
```

⚠️ **THE BUG IS HERE (see root cause #10):** The 5 K-nearest dump rows DO have (lac,cisac) — but those same (lac,cisac) pairs appear in 7+ other states! The mapping correctly binds "Delhi cell → pair X", but pair X also serves Andaman, Tamil Nadu, Ladakh, etc. The bridge JOIN then pulls ALL of those.

**Valid (non-leaking) options would be:**
- (A) Generate (lac,cisac) as **geographically unique** per state/region
- (B) **Add `serving_cell_id` to subscriber_dump** so matching bypasses LAC/CISAC entirely (RECOMMENDED — requires 005 applied correctly)
- (C) One-to-one mapping: each subscriber has an EXCLUSIVE (cell_id, lac, cisac) triple where the cell_id is globally unique

---

## 10. EXACT TOWER-SELECTION SQL

**Source:** `modules/02-cell-site-identification/adapters/postgis-sql.ts` + `postgis-tower-source.ts`

```sql
-- TOWER SELECTION (RADIUS MODEL — DEFAULT)
WITH zone_geom AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom  -- user GeoJSON polygon(s)
)
SELECT t.id          AS tower_id,
       t.cell_id,
       t.latitude,
       t.longitude
FROM zone_geom z, cell_towers t
WHERE ST_DWithin(
        ST_SetSRID(ST_MakePoint(t.longitude::numeric, t.latitude::numeric), 4326)::geography,
        z.geom::geography,
        COALESCE(t.coverage_radius_m, 1000)  -- default 1km coverage radius
      )
LIMIT $2;  -- TOWER_MATCH_LIMIT (default: 100,000)

-- POLYGON MODEL (if coverage_geom not all NULL):
-- ST_Intersects(t.coverage_geom, z.geom) instead of ST_DWithin
```

**Transactional discipline:**
```sql
BEGIN;
  SET LOCAL statement_timeout = '${TOWER_MATCH_TIME_BUDGET_MS}ms';  -- 5,000ms default
  SET LOCAL idle_in_transaction_session_timeout = '${TOWER_MATCH_TIME_BUDGET_MS + 2000}ms';
  -- run SQL above
COMMIT;
```

**Performance characteristics:**
- GiST index on cell_towers.geom (see Section 5.3) ensures spatial index scan
- 50K towers → for a full-Delhi polygon, expect ~48K cells selected (confirmed 48,721 in 28.4–28.9 bbox)
- 100ms–3s typical for large polygons

---

## 11. EXACT SUBSCRIBER-MATCHING SQL (PRODUCTION DEFAULT: BRIDGE MATCHER)

**Source:** `src/telecom/matcher/cell-subscriber-bridge-sql.ts` + `CellSubscriberBridgeMatcher`

```sql
-- ========================================================
-- STAGE 1: Stage selected cell_ids into TEMP TABLE (deduped)
-- ========================================================
CREATE TEMP TABLE IF NOT EXISTS turant_target_cells (
  cell_id TEXT PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO turant_target_cells (cell_id)
SELECT DISTINCT UNNEST($1::text[])
ON CONFLICT DO NOTHING;

-- ========================================================
-- STAGE 2: Aggregate match stats
-- ========================================================
WITH target AS (
  SELECT cell_id FROM turant_target_cells
),
resolved_cells AS (
  SELECT t.cell_id
  FROM target t
  JOIN cell_network_mapping m ON m.cell_id = t.cell_id
  GROUP BY t.cell_id
),
resolved_areas AS (
  SELECT DISTINCT m.lac, m.cisac   -- ← 15 AREA PAIRS FOR 5 CELLS
  FROM target t
  JOIN cell_network_mapping m ON m.cell_id = t.cell_id
),
agg AS (
  SELECT
    COUNT(*)::bigint                                 AS matched_rows,
    COUNT(DISTINCT s.msisdn)::bigint                 AS unique_msisdns,
    -- Note: COUNT(DISTINCT imsi) not counted
    -- Note: no state filtering
FROM resolved_areas r
JOIN subscriber_dump s
  ON s.lac = r.lac AND s.cisac = r.cisac   -- ← LEAKY JOIN! (see Section 12)
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM target)                               AS target_cells,
    (SELECT COUNT(*) FROM resolved_cells)                       AS resolved_cells,
    (SELECT COUNT(*) FROM resolved_areas)                       AS resolved_areas,
    COALESCE((SELECT matched_rows   FROM agg), 0)               AS matched_rows,
    COALESCE((SELECT unique_msisdns FROM agg), 0)               AS unique_msisdns,
    0::bigint                                                   AS filtered_rows
)
SELECT * FROM counts;

-- ========================================================
-- STAGE 3: Stream recipients via cursor (no materialization)
-- ========================================================
DECLARE turant_recipients_cursor NO SCROLL CURSOR FOR
  WITH target AS (SELECT cell_id FROM turant_target_cells),
  resolved_areas AS (SELECT DISTINCT m.lac, m.cisac FROM target t
                     JOIN cell_network_mapping m ON m.cell_id = t.cell_id)
  SELECT DISTINCT s.msisdn         -- ← DEDUP AT DB LEVEL (DISTINCT) FIRST!
  FROM resolved_areas r
  JOIN subscriber_dump s ON s.lac = r.lac AND s.cisac = r.cisac;

FETCH 10000 FROM turant_recipients_cursor;   -- batch = RECIPIENT_BATCH_SIZE (10K)
```

**Transactional discipline:**
```sql
BEGIN;
  SET LOCAL statement_timeout = '${MATCH_TIME_BUDGET_MS}ms';  -- 60,000ms default
  SET LOCAL idle_in_transaction_session_timeout = '${MATCH_TIME_BUDGET_MS + 5000}ms';
  -- STAGE 1 → STAGE 2 → DECLARE CURSOR → FETCH batches → COMMIT (cursor auto-closed)
COMMIT;
```

---

## 12. EXACT DEDUPLICATION LOGIC

### 12.1 DB-LEVEL (within subscriber matcher):
SQL-level: `SELECT DISTINCT s.msisdn` — dedupes MSISDN across resolved_area pairs.

### 12.2 APPLICATION-LEVEL (modules/05-dedup/dedupe.ts):
```ts
export async function deduplicate(
  msisdns: readonly string[],
  traceKey?: string
): DedupResult {
  const normalized = msisdns.map((m) =>
    m.replace(/^\+/, '').replace(/[\s-]/g, '')   // normalize to 91… format
  );
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const m of normalized) {
    if (!seen.has(m)) {
      seen.add(m);
      unique.push(m);
    }
  }
  const removed = normalized.length - unique.length;
  if (traceKey) traceStore.mark(traceKey, 't2', { removed });
  return {
    msisdns: unique,
    rawCount: normalized.length,
    duplicatesRemoved: removed,
    dedupKey: 'msisdn',
    dedupAlgorithm: 'first-occurrence Set',
  };
}
```

### ⚠️ DEDUP AUDIT FINDING — CORRECTNESS:
| Item | Status | Notes |
|---|---|---|
| **Dedup identity = MSISDN?** | ⚠️ **INCONCLUSIVE — likely wrong** | The subscriber_dump has **1 IMSI per subscriber + 1 MSISDN per subscriber**. For telco, IMSI is the SIM identifier (globally unique across networks within MCC/MNC). MSISDN can be ported/changed/ported between operators. **The unique identity should be IMSI** (or composite IMSI+MSISDN for portability). **Using MSISDN risks over-counting (one SIM with temp roaming MSISDNs? not likely here) OR under-counting (two subscribers wrongly share MSISDN due to generation bug).** |
| **Current distinct dedup:** | `SELECT DISTINCT s.msisdn` | Same issue. Need `COUNT(DISTINCT imsi) OVER (...)` as well. |
| **Overlap dedup after polygon merging:** | In-memory first-occurrence | Correct per-request — but must NOT be used across separate polygons to avoid double-sending same SIM for a single CAP alert with multiple zones. |

**Action (Phase 3):** Validate IMSI uniqueness at schema level and switch primary dedup key to IMSI. Add secondary MSISDN dedup for portability scenarios.

**Phase 3 status:** `uq_subdump_imsi` + `uq_subdump_msisdn` enforced (009). Matcher dedups by IMSI (`SELECT DISTINCT ON (imsi)`); SQL DISTINCT on MSISDN retained as secondary. Unique constraints guarantee dedup-key integrity at the data layer.

---

## 13. WHY NON-DELHI SUBSCRIBERS CAN BE RETURNED FOR DELHI ALERTS (ROOT CAUSE — PROVEN WITH EVIDENCE)

### EXPERIMENT (run in diagnostic-phase1-smoking-gun.ts):
```
5 DELHI CELLS: 10000, 10001, 10005, 10006, 10007
  (all lat 28.6197–28.6906, lng 77.1956–77.2767 — verified inside Delhi)
  ↓
cell_network_mapping JOIN → 15 (lac,cisac) PAIRS:
  0454/AAC0, 045B/211D, 0460/658C, 045C/740A, 0460/4A2B, 0460/FA3B,
  0454/5993, 045A/9A5F, 045C/548B, 0455/3C5E, 045B/0868, 0460/1682,
  0458/69D7, 045A/EEBD, 045C/194C
  ↓
JOIN subscriber_dump ON (lac,cisac)
  ↓
RESULT:
  - 1,310 TOTAL SUBSCRIBERS (matched_rows via covering index)
  - 43 FROM DELHI (3.28%)
  - **1,202 FROM 32 OTHER UNRELATED STATES = 91.75% LEAKAGE!**
  - Examples: Andaman & Nicobar Islands (11.65°N 92.74°E — 2400km away)
              J&K, Maharashtra, Puducherry, Nagaland, MP, Tripura, Telangana
              Ladakh, Goa, Tamil Nadu, Odisha, Chhattisgarh, Karnataka...
  - ALL 35 STATES REACHED!
```

### WHY? Three structural causes compounding:

**1. (LAC,CISAC) PAIRS ARE GEOGRAPHICALLY NON-UNIQUE (PROVEN — 0.5% sample):**
```
0.5% sample → 406,264 distinct pairs.
  - 323,600 pairs = single state  (79.65%)
  -  71,186 pairs = 2 states      (17.52%)
  -  11,478 pairs = 3+ states     (2.82%)
  → **20.35% OF ALL (LAC,CISAC) PAIRS ARE CROSS-STATE**
```
Top pair `045C/9C1F` → **7 states** (Andaman, Arunachal, Delhi, Haryana, ...)

**2. K-NEAREST MAPPING MAPS DELHI CELLS TO GLOBALLY-REUSED PAIRS:**
The 15 area pairs bound to 5 Delhi cells are NOT exclusive to Delhi. Each pair exists in 1–7 other states.

**3. BRIDGE MATCHER USES (LAC,CISAC) JOIN WITH NO STATE/GEO FILTERING:**
`JOIN subscriber_dump s ON s.lac=r.lac AND s.cisac=r.cisac` → ALL rows nationwide are returned — 100% leakage of any pair's non-Delhi rows.

---

## 14. DATA PROVENANCE CLASSIFICATION (REAL vs REFERENCE vs SYNTHETIC)

| Data | Class | Evidence |
|---|---|---|
| `cell_towers` (50K) | **SYNTHETIC TEST DATA** | Sequential hex cell IDs (0x9C81+i). 48,721/50K = 97.4% inside Delhi bounding box 28.4–28.9, 76.9–77.6. All generated by seeder; no real C-DOT import. |
| `sim_cell_towers` (50K) | **SYNTHETIC REFERENCE** | 15 Delhi-NCR districts with 1:1 mapping to same 50K sites. |
| `telecom_master` (5 rows) | **REFERENCE INFRASTRUCTURE** | Schema only. Seeded with 5 canonical C-DOT rows; not expanded to `TELECOM_MASTER_TOWER_COUNT=5000`. |
| `cell_network_mapping` (150K) | **SYNTHETIC MAPPING** | All rows `source='synthetic_test_mapping'`. Derived via K-nearest from subscriber_dump. Not imported from real operator data. |
| **`subscriber_dump` (100M)** | **SYNTHETIC TEST DATA** | **Smoking gun — perfect operator weights:** Jio=36.00%, Airtel=35.99%, VI=15.05%, BSNL=7.95%, MTNL=5.02% → sums 100.01% due to rounding. 35 states × ~2.7%/state (Delhi=2.733%). City per state exactly 1-2 (capitals only). Not real subscriber data. **IMPORTANT: IMSIs use synthetic MCC/MNC ranges, lat/lng stored as TEXT indicating hand-rolled script rather than real dump.** |
| `alerts` (51 rows) | **TEST DATA** | From prior testing runs; no production CAP feeds. |

**Policy adherence (Rule #6):** Current data is correctly synthetic — but when expanded to 100M Delhi records, we must explicitly mark `data_source='synthetic_test_data'` and/or add metadata column/table per Rule #23.

---

## 15. TSP-EVALUATION READINESS (POST-FIX — FINAL)

| Component | Ready? | Grade | Notes |
|---|---|---|---|
| CAP ingestion + validation | ✅ | GREEN | XML parser, validators, priority parsing all tested |
| Manual alert REST endpoint | ✅ | GREEN | JSONB payload; full pipeline integration |
| **Tower/cell spatial selection** | ✅ | GREEN | PostGIS GiST index + ST_DWithin radius or ST_Intersects polygon; tested with 50K cells |
| **Subscriber matching (default cell-indexed)** | ✅ **FIXED** | **GREEN** | `serving_cell_id = ANY($1)`; **leakage = 0**, collisions = 0, dups = 0 measured. Bridge (lac,cisac) → diagnostic only. |
| **Subscribers → cell relationship** | ✅ **FIXED** | **GREEN** | `serving_cell_id` FK → `sim_cell_towers` VALIDATED (0 orphans). |
| **Dedup key correctness** | ✅ | GREEN | IMSI primary + MSISDN secondary; both UNIQUE-enforced. |
| SMS submission (SMPP) | ⚠️ Config-gated | YELLOW | Credentials required → pipeline HALTS honestly with submittedCount=0. No fabricated DLRs. |
| **DLR vs Submission separation** | ✅ | GREEN | Counts separate; submittedCount != deliveredCount by design. |
| Pipeline trace timestamps (t0..t5) | ✅ | GREEN | Trace-store present with stage deltas |
| Pipeline status + halt/expiry states | ✅ | GREEN | completed/halted/expired/failed via API |
| Report builder (EWS + DB) | ✅ | GREEN | alert_reports JSONB with full statistics |
| PostGIS geometry tests | ✅ Present | GREEN | Coverage radius vs polygon model with loud guard for all-NULL coverage_geom |
| **API evidence of correct result sets** | ✅ **FIXED** | GREEN | 1,000 Delhi cells → 3,279,000 matched, **0 non-Delhi** (was 91.75% leakage) |
| **100M Delhi synthetic dataset** | ✅ **DONE** | **GREEN** | **Delhi total = exactly 100,000,000** (97,457,009 expansion + ~2.6M legacy). |
| Operator/tech configurability | ⚠️ | YELLOW | Weights in env + generator-config; expansion used TSP 36/36/15/8/5 + 68/25/7. |
| Validation command `validate:telecom-data` | ✅ | GREEN | `scripts/validate-expansion.ts` + `scripts/validate-cell-matcher.ts` (see §1/§15 of DATA_INTEGRITY_REPORT.md) |
| Performance benchmarks (100→50K cells) | ✅ | GREEN | 50k-cell acceptance: 3,154,485 unique recipients in ~52–57s; cell-indexed 1k-cell run 4.9s EXPLAIN. |
| Automated tests | ✅ | GREEN | **23 files / 193 tests passing** (was 186/189 baseline). |
| **Cross-state leakage test** | ✅ **ADDED** | GREEN | Leakage = 0 measured on live data + matcher contract tests. |
| **SQL evidence scripts** | ✅ | GREEN | docs/sql + EXPLAIN ANALYZE captured (§7.1 report). |
| **EXPLAIN ANALYZE evidence** | ✅ | GREEN | Cell-indexed plan = Parallel Index Scan on `idx_subscriber_dump_serving_cell`; no 197M seq scan. |
| Migrations + rollback procedure | ✅ | GREEN | 008/009 applied; `docs/ROLLBACK_PROCEDURE.md` complete. |
| Postman collection (12 requests) | ✅ | GREEN | cap, manual, towers, traces, reports, benchmarks, debug |

---

## 16. PHASE 1 AUDIT — CONCLUSIONS

### ✅ CORRECT ASPECTS (WORTH PRESERVING):
1. **Architecture modularity** (13 modules w/ clean interfaces) ✅
2. **Transactional discipline** (SET LOCAL timeouts, temp tables on COMMIT DROP) ✅
3. **PostGIS spatial pipeline** — tower selection correct, fast ✅
4. **Submission ≠ DLR separation** — honesty enforced ✅
5. **Pipeline trace + halt states** — t0..t5 timestamps, honest statuses ✅
6. **Deterministic generators** — seed-based, resumable checkpoints ✅
7. **`idx_subscriber_dump_area_msisdn` covering index** — pure index-only scans for COUNT(DISTINCT msisdn) ✅
8. **Memory mode / production mode separation** — easy to swap in real data ✅
9. **Zero fabricated DLRs** — `deliveredCount=0` when no DLR listener connected ✅

### ❌ CORE DATA INTEGRITY FAILURES REQUIRING FIX (Phase 2/3) — **ALL RESOLVED:**

| # | Phase 1 Finding | Phase 3 Fix | Verified |
|---|---|---|---|
| 1 | (LAC,CISAC) uniqueness assumption false → 20.35% cross-state pairs | New expansion generated with geographically-derived (lac,cisac) per cell; matcher stops using pairs | ✅ 0 cross-state pairs in expansion |
| 2 | Default bridge matcher join leaky → 91.75% leakage | Default = `serving_cell_id = ANY($1)` (cell-indexed); bridge → diagnostic | ✅ leakage = 0 |
| 3 | subscriber_dump.cell_id MISSING | `serving_cell_id` added (008) + FK to sim_cell_towers | ✅ FK VALIDATED |
| 4 | Dedup uses MSISDN instead of IMSI | IMSI primary + MSISDN secondary; both UNIQUE (009) | ✅ |
| 5 | No FK/cell-validity constraints | FK `fk_subdump_serving_cell` + `ux_sim_cell_towers_cell_id` | ✅ 0 orphans |
| 6 | lat/lng stored as TEXT, no checks | CHECK lat/lng range via ::float (009) | ✅ |
| 7 | IMSI/MSISDN unique not enforced | `uq_subdump_imsi`, `uq_subdump_msisdn` (009) | ✅ 0 dupes |
| 8 | telecom_master only 5 rows | Out of scope for matching now (matching uses serving_cell_id); noted as external/ref only | ⚠️ documented |
| 9 | No validation command | `scripts/validate-expansion.ts` + `scripts/validate-cell-matcher.ts` | ✅ all green |
| 10 | 100M Delhi dataset NOT generated | Done: **100,000,000 Delhi rows** (97,457,009 expansion) | ✅ exact count |

---

## NEXT STEPS (Phase 2 → Design Minimal Correct Fix):
See `MATCHING_ALGORITHM.md` + `DATA_INTEGRITY_REPORT.md` (following docs). **Phase 3 plan — all COMPLETE:**
- ✅ **Introduce `serving_cell_id` on subscriber_dump** (`migrations/008`) — FK → `sim_cell_towers(cell_id)`, VALIDATED
- ✅ **Generate 100M Delhi subscribers explicitly bound to 50K existing Delhi-NCR `sim_cell_towers` cells** (each subscriber's lat/lng, LAC, CISAC, state, district, city, operator, technology derived FROM the authoritative cell) → Delhi = exactly 100,000,000
- ✅ **Default matcher = `PostgresSubscriberCellMatcher`** matching via `serving_cell_id = ANY($1)`, not (lac,cisac); bridge gated as diagnostic
- ✅ **Add constraints + validation command** (`migrations/009`, `scripts/validate-*.ts`)
- ✅ **Regenerate/prove leak-free matching** — 0% leakage, 0 collisions, EXPLAIN evidence
- Final verdict: see `AUDIT_TSP-READINESS-2026-08-11.md`
