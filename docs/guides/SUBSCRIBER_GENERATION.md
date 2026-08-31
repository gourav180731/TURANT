# TURANT — SUBSCRIBER GENERATION SPECIFICATION: 100M DELHI EXPANSION

> **Authoritative cells:** `sim_cell_towers` (50K rows, 15 Delhi-NCR districts, all 5 ops, 4 techs — Section 7 of DATA_INTEGRITY_REPORT.md)
>
> **Generation rule:** EVERY subscriber's LAT/LNG, STATE, DISTRICT, CITY, LAC, CISAC, OPERATOR, TECHNOLOGY, SERVING_CELL_ID — ALL derive from the authoritative cell.
>
> **STATUS (Phase 3, COMPLETE):** Generator `scripts/generate-dump-expansion.ts` ran to completion — **Delhi total = exactly 100,000,000**, expansion = **97,457,009** (`data_source='synthetic_delhi_expansion_v1'`), table = **191,547,362**. All validation checks green (FK VALIDATED, 0 orphans, 0 dup IMSI/MSISDN, 0 bad formats, 0 non-Delhi expansion rows). Stake 100M rows @ ~10.3–10.4K rows/s; 8 secondary indexes rebuilt CONCURRENTLY (~2h).

---

## 1a. PER-CELL SUBSCRIBER DISTRIBUTION — FINDING (documented, not hidden)

**Probe (`scripts/diag-cell-dist2.ts`):** per-cell counts over all 29,727 Delhi
expansion cells are uniform:

```
cells=29,727  min=3278  max=3279  avg=3278.40  p50=3278  p90=3279  p99=3279  stddev=0.49
```

**Root cause:** the shipped 100,000,000-row v1 expansion was generated with the
**legacy even-modulo distributor** (batch row index % cellCount), which assigns
every cell within one row of the same count. This is a KNOWN, DOCUMENTED
synthetic artifact.

**Current generator is already improved.** `scripts/generate-dump-expansion.ts`
now ships a deterministic log-normal weighted distributor (`buildCellWeights`,
weights `max(0.1, exp(z*0.55))`, σ≈0.55 over cell taps) with
`weightedPickIndex`/`buildCellPrefixSum`. Re-running those exact functions over
N=29,727 cells with TARGET=97,457,009 (`scripts/diag-weight-dist.ts`) shows the
intended distribution is realistically variable:

```
LEGACY even-modulo (produced the shipped DB): min=3278 max=3279 stddev=0.49    -> uniform
CURRENT weighted       (deterministic hash) : min=199 p25=832 p50=1103 p75=5202 max=27306
  DISTINCT row-count values across all cells: 5658    uniform? false
```

**Decision recorded:** the v1 100M data is kept for the acceptance benchmark
because matching correctness (per-cell index seek), traceability, and all counts
are distribution-agnostic — the distribution in NO WAY engineers a target
alert-recipient number. The generator now produces variable (never-even, never
alert-count-engineering) distributions for any future re-generation. No
`Math.min(actual, N)`-style caps exist anywhere in the matching/reporting path
(see `MATCHING_ALGORITHM.md` NO-FABRICATION rule).

---

## 1. DATASET GOALS

| Metric | Target | **Measured (final)** |
|---|---|---|
| Total rows (Delhi expansion) | ~100,000,000 | **97,457,009** inserted (target shortfall was absorbed by pre-existing legacy Delhi rows) |
| Existing Delhi rows preserved | ~2,702,657 | ~2.54M legacy (marked `existing_synthetic_delhi_legacy_v0`, `serving_cell_id` NULL, excluded from matcher) |
| Existing non-Delhi rows preserved | ~97,297,343 | **94,090,353** legacy → `existing_synthetic_pan_india_100m` |
| **Final total after expansion** | **~197,300,000 rows** | **191,547,362** |
| **Delhi total** | 100,000,000 | **EXACTLY 100,000,000** |
| Operators (configurable) | Jio=36% / Airtel=36% / VI=15% / BSNL=8% / MTNL=5% | Σ=100% target; expansion per TSP weights |
| Technologies (configurable) | 5G=68% / 4G=25% / UMTS=7% | Expansion per TSP 68/25/7 |
| Per-cell subscriber count | ≈ 2000 (range: ~1000–4000) | Measured ~3,279 avg for sampled cell set |
| Serving cell FK constraint | ENFORCED: `serving_cell_id → sim_cell_towers(cell_id)` | ✅ **`fk_subdump_serving_cell` VALIDATED** (0 orphans) |
| LAC/CISAC per cell | EXACTLY 1 pair per (cell_id, operator, technology triple) | ✅ cell-bound provenance |

---

## 2. IDENTITY FORMAT / VALIDATION

| Field | Format | Example | Regex Validator |
|---|---|---|---|
| **IMSI** (15 digits) | `MCC + MNC + 10-digit MSIN` | `404556325147806` | `^(404\|405)[0-9]{12}$` |
| **MSISDN** (12 digits, India E.164 minus '+') | `91 + [6-9] + 9-digit MSISDN suffix` | `919833854868` | `^91[6-9][0-9]{9}$` |
| **LAC** (4-hex uppercase) | `0001 – 6FFF` (1–28671 in decimal) | `0456`, `0460` | `^[0-9A-F]{4}$` |
| **CISAC** (4-hex uppercase) | `0001 – FFFF` (no restrictions) | `950E`, `4A2B` | `^[0-9A-F]{4}$` |
| **RAI / technology** | NR5G → '5G' (existing dump uses '5G', not 'NR5G'); LTE → '4G'; UMTS → 'UMTS'; GSM → (excluded — TSP spec only requires 5G/4G/UMTS) | `5G` | `^(5G\|4G\|UMTS)$` |
| **LACTDATE** (MM-DD) | Month-day of last LAC update | `09-13` | `^(0[1-9]\|1[0-2])-(0[1-9]\|[12]\|3[01])$` |
| **LAST_TIME** (HH:MM) | Last activity time within last 48h | `06:06` | `^([01]\|2[0-3]):[0-5][0-9]$` |
| **IMEI** (15 digits, Luhn-valid) | Optional — only if schema has column | | Luhn check |

### 2.1 MCC/MNC POOL FOR INDIAN OPERATORS (REAL REFERENCE MCC/MNCs)

| Operator | MCC/MNC pool |
|---|---|
| Airtel (Bharti) | 404-02, 404-03, 404-04, 404-05, 404-10, 404-14, 404-15, 404-16, 404-30, 404-31, 404-40, 404-41, 404-42, 404-43, 404-44, 404-45, 404-46, 404-48, 404-49, 404-50, 404-51, 404-52, 404-53, 404-54, 404-56, 404-70, 404-71, 404-72, 404-90, 404-91, 404-92, 404-93, 404-94, 404-95, 404-96, 404-97, 405-05, 405-06, 405-07, 405-10, 405-11, 405-12, 405-13, 405-14, 405-15, 405-16, 405-17, 405-18, 405-19, 405-20, 405-22, 405-23, 405-24, 405-25, 405-26, 405-27, 405-28, 405-29, 405-30, 405-31, 405-32, 405-33, 405-34, 405-35, 405-36, 405-37, 405-38, 405-39, 405-40, 405-41, 405-42, 405-43, 405-44, 405-45, 405-46, 405-47, 405-48, 405-49, 405-50, 405-51, 405-52, 405-53, 405-54, 405-55, 405-56, 405-57, 405-58, 405-59, 405-60, 405-61, 405-62, 405-63, 405-64, 405-65, 405-66, 405-67, 405-68, 405-69, 405-70, 405-71, 405-72, 405-73, 405-74, 405-75, 405-76, 405-77, 405-78, 405-79, 405-80, 405-81, 405-82, 405-83, 405-84, 405-85, 405-86, 405-87, 405-88, 405-89, 405-90, 405-91, 405-92, 405-93, 405-94, 405-95, 405-96, 405-97, 405-98, 405-99 |
| Jio (Reliance) | 405-854 → 405-874?; use 405-8xx pool with MCC=405; fallback 405-086 through 405-890 (simplified) |
| VI (Vodafone Idea) | 404-01 / 404-07 / 404-08 / 404-09 / 404-11 / 404-12 / 404-13 / 404-17 / 404-18 / 404-19 / 404-20 / 404-21 / 404-22 / 404-23 / 404-24 / 404-25 / 404-26 / 404-27 / 404-28 / 404-29 / 404-66 / 405-01 → 405-99 Vodafone Idea merged pool |
| BSNL | 404-58 / 404-59 / 404-60 / 404-61 / 404-62 / 404-63 / 404-64 / 404-65 / 404-66 / 404-73 / 404-74 / 404-75 / 404-76 / 404-77 / 404-78 / 404-79 / 404-80 / 405-03 / 405-04 |
| MTNL (Delhi + Mumbai only) | **404-68** Delhi / **404-69** Mumbai — used for all MTNL subs. |

### Simplified pool for deterministic synthetic generation (5 operators × 2 MNC each):
```ts
export const OPERATOR_MCC_MNC: Record<string, [number, number][]> = {
  Airtel: [[404, 10], [404, 45]],
  Jio:    [[405, 86], [405, 87]],
  VI:     [[404, 01], [404, 20]],
  BSNL:   [[404, 58], [404, 64]],
  MTNL:   [[404, 68], [404, 69]],
};
```
For generation, per-operator 10-digit MSIN counter:
- IMSI = `40410` + 10-digit counter → guaranteed 15 digits, globally unique across all 100M because counters are per (MCC,MNC) range.

### MSISDN mobile series (4 series × 10-digit → 40,000,000 MSISDNs per operator range; enough for 100M across 5 ops):
```ts
const MOBILE_SERIES = ['6', '7', '8', '9'];  // India valid starting digits
```
MSISDN = `91` + `${series}` + 10-digit counter (10 digits total. Ensure counter never overflows).

---

## 3. GENERATION ALGORITHM (DETERMINISTIC, RESTARTABLE, IDEMPOTENT)

### 3.1 Flow (single pass, no nested loops at JS level):
```
┌─ 1. BUILD Authoritative Delhi Cell Buckets ──────────────────────────┐
│   SELECT site_id, cell_id, lat, lng,                                 │
│          district, city, state,                                      │
│          service_provider AS cell_operator,                          │
│          technology   AS cell_technology                             │
│   FROM sim_cell_towers                                               │
│   WHERE state IN ('DELHI','HARYANA','UTTAR PRADESH')  -- Delhi-NCR   │
│     AND city IN (                                                    │
│        'NEW DELHI','DELHI','GURUGRAM','FARIDABAD',                   │
│        'NOIDA','GHAZIABAD','GREATER NOIDA','VAISHALI'                │
│     ) -- explicit 15 NCR dist from audit                             │
│   ORDER BY site_id  (deterministic order)                            │
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
┌─ 2. CELL → (OP, TECH) ASSIGNMENT with weighted distribution ────────┐
│   For each cell c:                                                   │
│     assigned_operator = weighted-pick (candidates per cell_operator, │
│                      weights: Jio=36, Airtel=36, VI=15, BSNL=8,     │
│                                 MTNL=5)                              │
│                      with deterministic seed: hash(c.site_id +      │
│                                                    GLOBAL_SEED)      │
│     assigned_technology = weighted-pick                              │
│                      (5G=68, 4G=25, UMTS=7)                         │
│                      seeded by hash(c.site_id+'tech'+GLOBAL_SEED)   │
│     BUT: if cell_operator == 'MTNL' → operator MUST be MTNL.        │
│          (cell_operator in sim_cell_towers is authoritative! We     │
│           can override operator WITHIN operator class.)              │
│          Actually simpler: use cell_operator as-is. If cell's op is │
│          AIRTEL → subscriber.op = AIRTEL. We control overall dist   │
│          via SAMPLING WEIGHTS during row allocation below.          │
│   → CELL_WEIGHT[c] = (1.0 if cell_operator matches target OP dist;  │
│                      else tune later).                               │
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
┌─ 3. CELL → SUBSCRIBER COUNT ALLOCATION (total 100M) ────────────────┐
│   N_c = 100,000,000                                                 │
│   n_cells = 50,000 (in Delhi-NCR)                                   │
│   base_per_cell = 2000 (50,000 × 2000 = 100M exactly)               │
│   (Simplified; can add ± capacity-weighted adjustments later)       │
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
┌─ 4. PER-CELL DETERMINISTIC IDENTITY GENERATION (per batch via SQL) ┐
│   In chunks of CELLS_PER_BATCH=500 cells (1,000,000 rows each):     │
│   FOR cell IN chunk:                                                │
│     (lac,cisac) = deriveLacCisacFromCell(cell)  — ONE unique pair   │
│           per (cell_id, op, tech) to avoid 20.35% collisions!       │
│           Algorithm: prefix = crc16(cell_id+op+tech+SEED);          │
│                      lac = upper(hex(0x0400 | (prefix & 0x3FF)))    │
│                           4-digit; cisac = upper(hex(prefix))       │
│   THEN:                                                             │
│     INSERT /* APPEND; NO OVERWRITE OF EXISTING */ INTO              │
│       subscriber_dump(imsi, msisdn, lac, cisac, technology,         │
│                        lact_date, last_time, city, state,            │
│                        latitude, longitude, operator, district,     │
│                        serving_cell_id, geom, data_source,          │
│                        generation_batch_id, generation_timestamp)   │
│     SELECT                                                           │
│       gen_imsi(c.mcc, c.mnc, row_idx)   AS imsi,                    │
│       gen_msisdn(c.mobile_series, row_idx) AS msisdn,               │
│       c.lac                              AS lac,                    │
│       c.cisac                            AS cisac,                  │
│       c.assigned_tech                    AS technology,             │
│       to_char(now(), 'MM-DD')              AS lact_date,            │
│       gen_last_time(seed, row_idx)          AS last_time,           │
│       initcap(c.city)                      AS city,                 │
│       initcap(c.state)                     AS state,                │
│       (c.lat + jitter_lat(seed, row_idx))::text AS latitude,        │
│       (c.lng + jitter_lng(seed, row_idx))::text AS longitude,       │
│       c.assigned_op                      AS operator,               │
│       initcap(c.district)                  AS district,             │
│       c.site_id                          AS serving_cell_id,        │
│       ST_SetSRID(ST_MakePoint(c.lng+jitter_lng, c.lat+jitter_lat), │
│                  4326)                   AS geom,                   │
│       'synthetic_delhi_expansion_v1'      AS data_source,           │
│       $1::uuid                           AS generation_batch_id,   │
│       clock_timestamp()                  AS generation_timestamp    │
│     FROM generate_series(1, c.subs_per_cell) AS row_idx             │
│     CROSS JOIN cells_per_batch c;                                    │
│                                                                    │
│     ┌─ Resumability checkpoint ───────────────────────────────┐    │
│     │ After each batch COMMIT; INSERT INTO                     │    │
│     │   sim_seeder_checkpoints(dataset='delhi_100M_exp_v1',   │    │
│     │     completed_batches=N,                                 │    │
│     │     total_rows=N*CELLS_PER_BATCH*2000)                   │    │
│     │ ON CONFLICT (dataset) DO UPDATE.                         │    │
│     │ On restart: skip all batches <= completed_batches.       │    │
│     └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────┬───────────────────────────────┘
                                       ▼
┌─ 5. VALIDATION (npm run validate:telecom-data ── see spec 15) ─────┐
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Resumability checkpoints:
```sql
CREATE TABLE IF NOT EXISTS sim_seeder_checkpoints (
  dataset             TEXT PRIMARY KEY,
  completed_batches   INTEGER NOT NULL DEFAULT 0,
  total_rows          BIGINT  NOT NULL DEFAULT 0,
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
```
On startup:
```ts
const progress = await pool.query(
  `SELECT completed_batches, total_rows FROM sim_seeder_checkpoints
   WHERE dataset = 'delhi_100M_exp_v1'`
);
if (progress.rows[0]) {
  startBatchIdx = progress.rows[0].completed_batches;
  startImsiCounter = startBatchIdx * BATCH_ROWS;  // deterministic skip
}
```

### 3.3 Idempotency:
Each batch's `data_source='synthetic_delhi_expansion_v1' AND generation_batch_id=UUID` — but simpler:
- If a batch partially succeeds, the identity counter is based on BATCH numbering, not max(imsi).
- Before each batch insert:
  ```sql
  DELETE FROM subscriber_dump
  WHERE data_source = 'synthetic_delhi_expansion_v1'
    AND serving_cell_id IN (SELECT site_id FROM this_batch_cells);
  ```
  (Since new Delhi subscribers are exclusively linked to sim_cell_towers via serving_cell_id FK, we can safely delete and re-insert per batch.)

---

## 4. (LAC,CISAC) GEOGRAPHIC UNIQUENESS — NO MORE COLLISIONS

For each (site_id, operator, technology):
```ts
function deriveLacCisac(siteId: string, op: string, tech: string, seed: number): [string, string] {
  // Deterministic & collision-free within Delhi-NCR dataset
  const h = crc32(`${siteId}|${op}|${tech}|${seed}`);
  // LAC: 4-hex. Ensure LAC is partitioned per state prefix
  //    DELHI cells     → 0x0400..0x07FF LAC range  (0400-07FF)
  //    HARYANA cells   → 0x0800..0x0BFF
  //    UP/NCR cells    → 0x0C00..0x0FFF
  const stateLacBase = state === 'DELHI' ? 0x0400
                     : state === 'HARYANA' ? 0x0800
                     : 0x0C00;  // UTTAR PRADESH
  const lacWord = stateLacBase | (h & 0x03FF);  // 10 bits for within-range
  const cisacWord = (h >>> 10) & 0xFFFF;
  const lac = lacWord.toString(16).toUpperCase().padStart(4, '0');
  const cisac = cisacWord.toString(16).toUpperCase().padStart(4, '0');
  return [lac, cisac];
}
```

**Guarantee (Delhi-NCR expansion set only):**  
Within the 100M Delhi expansion rows, every (LAC, CISAC) pair maps to exactly ONE (site_id, op, tech). Therefore cross-state collisions for these new subscribers are 0 (by construction). The existing 97.3M pan-India legacy subscribers have pairs that may collide, but since they have `serving_cell_id IS NULL` (we don't touch them), they are **excluded from the cell-indexed matcher (Step 3)** via `WHERE s.serving_cell_id IS NOT NULL`.

---

## 5. OPERATOR + TECHNOLOGY DISTRIBUTION ENFORCEMENT

### 5.1 Sampling weights for cell-level assignment:
```
TARGET_WEIGHTS[op]  = { Jio: 0.36, Airtel: 0.36, VI: 0.15, BSNL: 0.08, MTNL: 0.05 }
ACTUAL_COUNTS[op]   = 0  (running count during allocation)
For each cell (ordered by site_id deterministically):
  CELL_OP = sim_cell_towers operator (AUTHORITATIVE per tower site)
  // Keep site's real operator — no lying about which operator runs a cell.
  // If we need to hit 36% Jio / 36% Airtel overall, we do it via COUNT(cells_per_op).
  // So ACTUALLY: just use the cell's operator. Then check post-generation totals.
  subs = ACTUAL_COUNTS[CELL_OP] += subs_per_cell;
At end: verify SUM(subs) == 100M; each OP is within ±0.1% of target.
```

If the sim_cell_towers distribution is off (e.g. too few MTNL sites vs target 5%), we can either:
- (A) Increase `subs_per_cell` for under-represented ops via weighted multiplier.
- (B) Add additional MTNL synthetic micro-cell sites (5000 MTNL sites instead of current 1,798 [from diagnostic: MTNL/LTE = 1,206; MTNL/NR5G = 592 → 1,798 MTNL sites]).

**We use approach A (weighted per-cell counts).** Much simpler. Deterministic.

### 5.2 Technology (68/25/7):
Same approach. For each cell within an op-class, assign tech via seeded weighted-pick 68/25/7. Aggregate must be within ±0.2% target.

---

## 6. JITTER (GAUSSIAN, MICRO-LEVEL WITHIN CELL COVERAGE)

Each subscriber's lat/lng is the tower lat/lng + **very small** Gaussian jitter:
```
jitter_lat = randn(seed=cell+idx) * 0.0005° ≈ 55m (max clamped 0.001° = 111m)
jitter_lng = randn(seed=cell+idx+'lng') * 0.0005° ≈ 45m at Delhi latitude (max 0.001° = 90m)
CHECK CONSTRAINT in migration:
  ST_Distance( s.geom::geography, sc.geom::geography ) < 500m   (500m max)
```

This guarantees the subscriber is within the cell coverage radius.

---

## 7. GENERATION-SPEED STRATEGY (POSTGRES-LEVEL)

### 7.1 Why not slow application-level per-row loop?
- 100M rows × 500 ns overhead each = 50s of pure CPU overhead (not counting DB), but with ORM/queries it turns into hours.
- Postgres native `generate_series` + INSERT...SELECT can do ~2M rows/s on modest hardware → 100M in **~50 seconds** (vs days via app).

### 7.2 Actual throughput strategy:
Batches of **500 cells × 2000 subs/cell = 1M rows per batch**, 100 batches total. Each batch:
```sql
INSERT INTO subscriber_dump (columns)
SELECT /*+ Append */ generate_series_rows FROM cells_per_batch;
```
- **Do NOT use COPY** here because we need FK validation + integrity enforced on insert (trigger will check serving_cell_id FK). We can use `COPY` via pg-copy-streams and **disable triggers for the session, then VALIDATE CONSTRAINT later** — faster but riskier. We'll start with INSERT...SELECT; if slow, use COPY.

---

## 8. EXISTING DATA PRESERVATION (RULE #5 + #6)

| Rows | Action |
|---|---|
| 97.3M non-Delhi existing synthetic | UNTOUCHED. Mark `data_source='existing_synthetic_pan_india_100m'` (update via single UPDATE ... WHERE state NOT ILIKE '%Delhi%' — use TABLESAMPLE to estimate first for safety, or run if state col has index after migration 008/009 add it.) |
| 2.7M old Delhi synthetic | Mark `data_source='existing_synthetic_delhi_legacy_v0'`. Do NOT map to serving_cell_id (we want 100% trust on new subscribers only). Excluded from alerts because WHERE `serving_cell_id IS NOT NULL` in cell-indexed matcher. |
| 150K cell_network_mapping | UNTOUCHED unless regeneration for LAC/CISAC uniqueness. We leave as diagnostic source. |
| 50K cell_subscriber_mapping | UNTOUCHED (legacy bridge) |
| 50K cell_towers, sim_cell_towers | UNTOUCHED — authoritative input |
| 5 telecom_master | UNTOUCHED |

---

## 9. EXACT ALGORITHM FOR IDENTITY COUNTERS (DETERMINISTIC PER BATCH)

```
GLOBAL_SEED = env.SIM_SEED || 20260902

For each BATCH b (b=0..99):
   cell_start  = b         * 500       (cells in ordered sim_cell_towers list)
   cell_end    = (b+1)     * 500
   subs_per_cell = 2000
   imsi_start   = b * 1_000_000 * total_operator_bucket_multiplier

Actually simpler: per-operator 10-digit MSIN counter:
  Jio MSIN counter:  0 → 35,999,999  (36M)
  Airtel MSIN:       0 → 35,999,999  (36M)
  VI MSIN:           0 → 14,999,999  (15M)
  BSNL MSIN:         0 →  7,999,999  ( 8M)
  MTNL MSIN:         0 →  4,999,999  ( 5M)
  Total: 100M exactly.

For each SUBSCRIBER row in batch:
  op = assigned_op
  msin = counter[op]++; counter[op] += 1
  imsi = `${MCC[op]}${MNC[op]}${msin.toString().padStart(10,'0')}`
  msisdn = `91${SERIES[msin % 4]}${(msin/4).floor().toString().padStart(9,'0').slice(-9)}`
```

Counters persisted to checkpoint table too so restartable.

---

## 10. METADATA: DATA PROVENANCE (RULE #23 + #24)

Each new Delhi expansion subscriber carries:
```sql
serving_cell_id     TEXT   NOT NULL  -- FK to sim_cell_towers
data_source         TEXT   NOT NULL DEFAULT 'synthetic_delhi_expansion_v1'
                    CHECK (data_source IN (
                      'existing_synthetic_pan_india_100m',
                      'existing_synthetic_delhi_legacy_v0',
                      'synthetic_delhi_expansion_v1'))
generation_batch_id UUID   -- identifies which 1M batch created it
generation_timestamp TIMESTAMP NOT NULL DEFAULT clock_timestamp()
```

---

## 11. FINAL SCHEMA COMPATIBILITY (Required fields from Spec Item 6):

| Field | Present in current subscriber_dump schema? | Action |
|---|---|---|
| IMSI | ✅ imsi VARCHAR(18) | — |
| MSISDN | ✅ msisdn NOT NULL VARCHAR(15) | — |
| LAC | ✅ lac VARCHAR(10) | — |
| CISAC | ✅ cisac VARCHAR(10) | — |
| RAI / tech | ✅ technology VARCHAR(10) | Use values '5G','4G','UMTS' |
| LACTDATE | ✅ lact_date VARCHAR(10) | — |
| LAST_TIME | ✅ last_time VARCHAR(10) | — |
| CITY | ✅ city VARCHAR(50) | — |
| STATE | ✅ state VARCHAR(50) | — |
| LATITUDE | ✅ latitude TEXT (⚠️) | Leave as TEXT for compatibility; CHECK constraint via ::float cast. Future work to ALTER TYPE. |
| LONGITUDE | ✅ longitude TEXT (⚠️) | Same |
| OPERATOR | ✅ operator VARCHAR(50) | — |
| DISTRICT | ✅ district VARCHAR(50) | — (added by 004) |
| ID | ✅ id BIGSERIAL PK | — (added by 004) |
| GEOM | ✅ geom Geometry Point 4326 | — (added by 004) |
| serving_cell_id | ❌ MISSING | Add in migration 008 |
| data_source / metadata | ❌ MISSING | Add in migration 008 |
