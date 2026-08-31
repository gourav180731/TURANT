# TURANT — MATCHING ALGORITHM SPECIFICATION (FINAL — IMPLEMENTED & VERIFIED)

> **Design Goal:** Fix the 91.75% cross-state leakage while preserving the existing pipeline. The authoritative relationship is `subscriber → serving_cell_id → cell/tower → polygon`.
>
> **Rule compliance:** No `WHERE state='Delhi'` hacks. No leakage permitted. Zero tolerance for Tamil Nadu subscribers appearing from a Delhi polygon.
>
> **STATUS (Phase 3, COMPLETE):** Implementation in `src/telecom/matcher/subscriber-cell-matcher.ts` (default `cell-indexed` path). Measured on live DB: **leakage = 0, collisions = 0, duplicate MSISDNs = 0** (1,000 Delhi cells → 3,279,000 matched, all Delhi). EXPLAIN = Parallel Index Scan on `idx_subscriber_dump_serving_cell`. See `DATA_INTEGRITY_REPORT.md` §7.1.

---

## 0. NO-FABRICATION RULE (final-pass hardening)

Reported subscriber counts must **always** be the database's true answer at the
cell level — never a capped, scaled, or rounded number:

- `PostgresSubscriberCellMatcher.matchSubscribers` first runs an **UNBOUNDED
  stats CTE** (`COUNT(*)`, `COUNT(DISTINCT msisdn)`) and returns those on
  `SubscriberMatch.rawMatchedRows` / `.uniqueSubscribers`.
- The pipeline (`runDisseminationLeg`) reports `matchedCount =
  rawMatchedRows`, `expectedRecipients = uniqueSubscribers`,
  `duplicatesRemoved = raw − unique`. The in-memory de-dup still drives the SMPP
  submission list but never gates the reported figures.
- `SUBSCRIBER_DUMP_MATCH_LIMIT` (default 50M) bounds **only** the temporary
  materialised recipient list for the SMPP boundary; a truncated list is
  logged (`materialisedTruncated`) but never lowers reported counts.
- There is **no** `Math.min(actual, N)`, no `expectedRecipients = towers × k`,
  and no constant recipient floor anywhere in the matching/reporting path.
- Benchmark `matchCells` uses the same unbounded aggregate (no LIMIT at all).

Regression coverage: `tests/subscriber-cell-matcher.test.ts`
(«NO-FABRICATION RULE» case) asserts the stats CTE has no LIMIT and that the
reported result carries the DB counts (42/40) while the materialised list is
truncated to 2.

---

## 1. FINAL PIPELINE FLOW (9 STEPS — matches Spec Item 11)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ INPUT:  Alert Polygon (GeoJSON FeatureCollection) + expiry              │
│ CONFIG: TOWER_COVERAGE_MODEL = radius | polygon                         │
│         SUBSCRIBER_DUMP_LOOKUP_MODE = cell-indexed (FIXED DEFAULT)      │
│                              bridge (diagnostic only, NOT default)      │
│                              polygon (direct point-in-polygon for legacy)│
└──────────┬───────────────────────────────────────────────────────────────┘
           │
           ▼
   ╔═══════════════════════════════╗  STEP 1: PostGIS spatial
   ║  1. POSTGIS TOWER SELECTION  ║  Query on cell_towers
   ╠═══════════════════════════════╣
   ║ ST_SetSRID(ST_GeomFromGeoJSON│  Uses GiST idx_cell_towers_geom_gist
   ║   ($1), 4326)                │  RADIUS:  ST_DWithin(cell_pt::geog,
   ║ JOIN cell_towers             │            polygon::geog,
   ║   ON ST_DWithin /            │            coverage_radius_m)
   ║      ST_Intersects           │  POLYGON: ST_Intersects(coverage_geom,
   ╚═══════════╤═══════════════════╝            z.geom)
               │  tower_id, cell_id, lat, lng
               │  (t0 stored in trace)
               ▼
   ╔═══════════════════════════════╗  STEP 2: AUTHORITATIVE CELL IDS
   ║  2. OBTAIN CELL IDs          ║  Deduplicate on cell_id.
   ╠═══════════════════════════════╣  Each cell_id is the globally-unique
   ║  toCellIds = Set(towers      ║  identifier that the subscriber's
   ║               .map(t=>       ║  serving_cell_id FK references.
   ║                  t.cell_id)) ║
   ╚═══════════╤═══════════════════╝
               │  UNIQUE TEXT[] cell_ids (e.g., [10000, 10001, …])
               │  (t1 stored in trace — cell-resolution stage)
               ▼
   ╔═══════════════════════════════╗  STEP 3: RESOLVE SUBSCRIBERS BY
   ║  3. SUBSCRIBER MATCHING      ║  serving_cell_id = ANY(cell_ids)
   ╠═══════════════════════════════╣
   ║  serving_cell_id =           ║  ← THIS IS THE KEY FIX.
   ║  ANY($1::text[])             ║  NO (LAC,CISAC) JOIN.
   ╚═══════════╤═══════════════════╝  NO state filter hack.
               │
               │  SQL:
               │  WITH matched_cells AS (
               │    SELECT UNNEST($1::text[]) AS cell_id
               │  )
               │  SELECT s.id, s.imsi, s.msisdn,
               │         s.serving_cell_id AS resolved_via_cell_id,
               │         s.lac, s.cisac, s.operator, s.technology,
               │         s.state, s.district, s.city,
               │         s.latitude, s.longitude, s.geom
               │  FROM subscriber_dump s
               │  JOIN matched_cells mc
               │    ON mc.cell_id = s.serving_cell_id
               │  WHERE s.serving_cell_id IS NOT NULL;   ← only mapped subs
               │
               │  Uses NEW INDEX: idx_subscriber_dump_serving_cell
               │       (BTree on serving_cell_id) → pure INDEX SCAN
               │
               │  (t2 stored in trace — subscriber-matching stage)
               ▼
   ╔═══════════════════════════════╗  STEP 4: EXPIRY + BUSINESS RULES
   ║  4. APPLY EXPIRY             ║  elapsed > CAP.expires_at → HALT
   ╠═══════════════════════════════╣  + SIM last_seen freshness rules.
   ║  IF NOW() > alert.expires_at ║  (alert-level check; per-subscriber
   ║    HALT(status='expired')    ║   check via last_time if needed.)
   ╚═══════════╤═══════════════════╝
               │  alive_subscribers (eligible set)
               ▼
   ╔═══════════════════════════════╗  STEP 5: DEDUP — IMSI = UNIQUE IDENTITY
   ║  5. DEDUP (IMSI)             ║  Telecom-standard SIM-level unique
   ╠═══════════════════════════════╣  identity (not MSISDN — which can be
   ║  dedupKey = IMSI             ║  ported).
   ║  seen = new Set<string>();   ║
   ║  for (s in rows):            ║    COUNT invariants:
   ║    if (!seen.has(s.imsi)) {  ║    • raw_matches     | raw rows
   ║      unique.push(s);         ║    • duplicates_removed
   ║      seen.add(s.imsi);       ║    • unique_eligible = raw - dupes
   ║    }                         ║    • expected_recipients === unique
   ║  (FALLBACK: also verify      ║
               │   MSISDN dedup for consistency)
               │  (t3 stored in trace — dedup stage)
               ▼
   ╔═══════════════════════════════╗  STEP 6: RETURN METRICS
   ║  6. METRICS OBJECT           ║  Return COUNT(*) NOT hard-coded
   ╠═══════════════════════════════╣
   ║  matchedCount: raw_matches   ║  All integers are QUERIED from DB
   ║  duplicatesRemoved: dupes    ║  or COUNTED in memory (never
   ║  expectedRecipients: unique  ║  manufactured).
   ║  towersSelected: N           ║
   ║  cellsSelected: M            ║
   ║  operators: {                 ║
   ║    Jio:  N, Airtel: N, …}    ║  ← GROUP BY operator on matched set
   ║  technologies: {              ║
   ║    5G: N, 4G: N, UMTS: N}    ║  ← GROUP BY technology on matched set
               ▼
   ╔═══════════════════════════════╗  STEP 7: SUBMISSION (SMPP)
   ║  7. SUBMIT MESSAGES          ║  submittedCount = NUMBER OF ACKs
   ╠═══════════════════════════════╣  from SMSC (≠ expectedRecipients).
   ║  submittedCount ≠ delivered  ║  If awaitingCredentials → = 0, HALT
   ╚═══════════╤═══════════════════╝  with halt_reason='awaiting SMPP creds'
               │  (t4 stored in trace — SMPP submit stage)
               ▼
   ╔═══════════════════════════════╗  STEP 8: DLR (DELIVERY RECEIPTS)
   ║  8. DLR ASYNC                ║  deliveredCount = NUMBER OF DLRs with
   ╠═══════════════════════════════╣  stat=DELIVERED. NEVER fabricated.
   ║  deliveredCount = 0 until    ║  If ZERO DLRs → stays at 0 (this is
   ║    DLR event from SMSC       ║  the HONEST behaviour — implemented
   ║    arrives.                  ║  correctly ALREADY.)
   ╚═══════════╤═══════════════════╝
               │  (t5 stored in trace — DLR stage)
               ▼
   ╔═══════════════════════════════╗  STEP 9: PIPELINE REPORT (DB + EWS)
   ║  9. COMPLETION REPORT        ║  alert_reports.report_json contains
   ╠═══════════════════════════════╣  ALL 8 stages' metrics + deltas.
   ║  completed | halted | expired║
   ║  | failed (status)           ║
   ╚═══════════════════════════════╝
```

---

## 2. TWO MATCHER IMPLEMENTATIONS (AND WHICH IS DEFAULT)

### 2.1 `PostgresSubscriberCellMatcher` (NEW DEFAULT — ★ CORRECT ★ — IMPLEMENTED)

**Config trigger:** `SUBSCRIBER_DUMP_LOOKUP_MODE = 'cell-indexed'` (default in `src/config/schema.ts`; `SUBSCRIBER_DUMP_CELL_COL = 'serving_cell_id'` default). File: `src/telecom/matcher/subscriber-cell-matcher.ts`.

**Execution plan (same TX discipline as current bridge matcher):**

```sql
BEGIN;
  SET LOCAL statement_timeout = '60000ms';
  SET LOCAL idle_in_transaction_session_timeout = '65000ms';

  -- STAGE a: cell_ids → matched subscribers
  -- Stage via TEMP table for fast hash-semijoin (same pattern as turant_target_cells)
  CREATE TEMP TABLE turant_matched_cells (
    cell_id TEXT PRIMARY KEY
  ) ON COMMIT DROP;

  INSERT INTO turant_matched_cells(cell_id)
  SELECT DISTINCT UNNEST($1::text[]) ON CONFLICT DO NOTHING;

  -- STAGE b: stats (AGGREGATE WITH GROUP BY operator/tech for reporting)
  WITH agg AS (
    SELECT
      COUNT(*)::bigint                              AS raw_matches,
      COUNT(DISTINCT s.imsi)::bigint                AS unique_imsi,
      COUNT(DISTINCT s.msisdn)::bigint              AS unique_msisdn,
      jsonb_object_agg(coalesce(s.operator,'?'), op_n)  AS operators,
      jsonb_object_agg(coalesce(s.technology,'?'), tech_n) AS technologies
    FROM subscriber_dump s
    JOIN turant_matched_cells mc ON mc.cell_id = s.serving_cell_id,
    LATERAL (
      SELECT s.operator AS op_k, COUNT(*) AS op_n GROUP BY s.operator
    ) op_agg,
    LATERAL (
      SELECT s.technology AS tech_k, COUNT(*) AS tech_n GROUP BY s.technology
    ) tech_agg
  )
  SELECT
    (SELECT COUNT(*) FROM turant_matched_cells)              AS target_cells,
    (SELECT COUNT(DISTINCT sc.site_id)
       FROM turant_matched_cells mc
       JOIN sim_cell_towers sc ON sc.site_id = mc.cell_id)  AS cells_in_tower_table,
    COALESCE((SELECT raw_matches  FROM agg),0)               AS matched_rows,
    COALESCE((SELECT unique_imsi  FROM agg),0)               AS unique_imsi,
    COALESCE((SELECT unique_msisdn FROM agg),0)              AS unique_msisdn,
    COALESCE((SELECT operators    FROM agg),'{}'::jsonb)     AS operators_json,
    COALESCE((SELECT technologies FROM agg),'{}'::jsonb)     AS technologies_json;

  -- STAGE c: declare cursor + FETCH batches (for SMPP dissemination)
  DECLARE turant_recipients_cursor NO SCROLL CURSOR FOR
    SELECT DISTINCT ON (s.imsi) s.msisdn
    FROM subscriber_dump s
    JOIN turant_matched_cells mc ON mc.cell_id = s.serving_cell_id
    ORDER BY s.imsi;

  FETCH 10000 FROM turant_recipients_cursor;
COMMIT;
```

**Performance guarantees (via indexes):**
- `PRIMARY KEY` on `turant_matched_cells` → deduped
- **`idx_subscriber_dump_serving_cell (serving_cell_id)`** — BTree on 197M rows. For 50K cells, this is a **Bitmap Heap Scan** with 50K exact lookups — comparable speed to the existing (lac,cisac) covering index (but **LEAKAGE PROOF**!). Measured 1k-cell run: Parallel Index Scan, Execution Time 4,906 ms.
- Optional covering index `(serving_cell_id) INCLUDE (imsi, msisdn, operator, technology, state, district, city)` → enables INDEX-ONLY scan for metrics aggregation in **Step 6 metrics / operator/tech breakdowns**.

**TRACEABILITY MATHEMATICAL PROOF (no leakage possible when FK valid):**
```
selected_cells ⊆ sim_cell_towers (all Delhi-NCR, 15 districts)
subscriber_dump.serving_cell_id → FK → sim_cell_towers(cell_id)
By FK definition: every subscriber has serving_cell_id ∈ sim_cell_towers(cell_id) OR NULL
               AND NULL rows excluded by WHERE s.serving_cell_id IS NOT NULL
Therefore: every returned subscriber has serving_cell_id ∈ selected_cells
            ⊆ sim_cell_towers (Delhi-NCR)
Therefore: 0% cross-state leakage. QED.
```
**Verified empirically:** `fk_subdump_serving_cell` VALIDATED (0 violations), leakage query over 1,000 Delhi cells returned **0** non-Delhi rows.

### 2.2 `CellSubscriberBridgeMatcher` (LEGACY / DIAGNOSTIC ONLY)

Retained for backwards-compat. **MUST NOT BE DEFAULT.**
- Trigger: `SUBSCRIBER_DUMP_LOOKUP_MODE = 'bridge'` (manual config only).
- For use when measuring baseline performance of the leaky implementation against new cell-indexed. **Measured leakiness:** 1,000 Delhi cells → **1,602 distinct (lac,cisac) areas** resolved (vs 1,000 serving cells) — cross-state pairs (§6.1, 20.35%) pull in non-Delhi rows.
- Required output: when running bridge matcher, MUST surface a warning (`leakage_warning: "LAC/CISAC bridge matcher is for diagnostic use only; 20.35% cross-state pair collisions observed in 0.5% sample"`) in pipeline status.

### 2.3 `PostgresSubscriberDumpMatcher` (direct point-in-polygon)

Unchanged. Retained for scenarios where subscriber geom is independently trustworthy (not the case for current 100M legacy dump — but good sim mode option).

---

## 3. TRACEABILITY: CAN ANSWER "WHICH TOWER/CELL CAUSED THIS SUBSCRIBER TO BE SELECTED?"

```sql
-- Given alert_id → all subscribers + originating tower/cell:
SELECT
  ar.alert_id, ar.cap_identifier,
  pt.tower_id  AS selected_tower,     -- from cell_towers selected in step 1
  pt.cell_id   AS selected_cell,      -- from cell_towers.cell_id (matches s.serving_cell_id)
  sc.district, sc.city, sc.state      AS cell_state,
  sc.service_provider                AS cell_operator,
  sc.technology                      AS cell_technology,
  s.imsi, s.msisdn,
  s.state                           AS sub_state,
  s.operator                        AS sub_operator,
  s.technology                      AS sub_technology,
  sc.lat, sc.lng,
  s.latitude, s.longitude
FROM alert_reports ar
CROSS JOIN LATERAL jsonb_array_elements_text(ar.report_json->'towerIds') AS j(tid)
JOIN cell_towers pt ON pt.id = tid
JOIN sim_cell_towers sc ON sc.cell_id = pt.cell_id OR sc.site_id = pt.id
JOIN subscriber_dump s ON s.serving_cell_id = sc.site_id
WHERE ar.cap_identifier = '...TARGET CAP ID...';

-- Result: 1 row per subscriber → every row has the exact
--         alert, tower, cell, site, subscriber that caused selection.
```

---

## 4. DEDUP CORRECTNESS (MATHEMATICAL)

### Identity:
```
dedup_identity = imsi          (primary, required)
fallback       = (imsi, msisdn)  (composite — portability sanity check)
```

### Invariants:
```
matchedCount         = COUNT(*) FROM raw JOIN
duplicatesRemoved    = matchedCount  - expectedRecipients
expectedRecipients   = COUNT(DISTINCT imsi)
```
**Never:** `expectedRecipients = matchedCount` unless proven (zero duplicates).

### Application-level:
- **First-occurrence-preserving Set\<imsi\>** (same structure as current MSISDN Set but on correct field)
- **No side effects:** dedup does not modify subscribers — returns immutable `unique: readonly SubscriberRow[]`.

---

## 5. EXPIRY — HALT STATES & STOP CONDITIONS

| Stage | Expiry check | Valid status on trigger |
|---|---|---|
| Before tower match | `NOW() > alert.expires_at` | **expired** (never runs spatial query) |
| After tower match, before subscriber match | Same | **halted** (towers resolved, subs never matched) |
| After subscriber match, after dedup, before submit | Same | **halted** (expectedRecipients computed, submittedCount=0) |
| Submission in progress, SMPP time budget exceeded | `NOW() - t_sub_start > SM_SUBMIT_BUDGET_MS` | **halted** (submittedCount < expectedRecipients — honest partial) |
| DLR listener 1 hour after CAP expires | DLR poller terminates | **completed** / **halted** — submitted, some delivered, final counts honest |

Pipeline status NEVER shows `running` past `NOW() > alert.expires_at + SM_SUBMIT_BUDGET_MS + DLR_WINDOW_MS`.

---

## 6. SUBMISSION vs DLR (SEPARATED FOREVER)

| Metric | Source |
|---|---|
| `expectedRecipients` | dedup output unique_imsi_count (MEMORY COUNT) |
| `submittedCount` | SMPP `submit_sm_resp` count from SMSC ACKs (NETWORK COUNT) |
| `deliveredCount` | DLR `DELIVERED` events from SMSC (NETWORK EVENT COUNT) |
| `failedCount` | DLR `UNDELIVERABLE/EXPIRED/DELETED/UNKNOWN` events |
| `expiredCount` | DLR `EXPIRED` events + biz-logic expiry at submit stage |

**No circumstance under which `expectedRecipients === submittedCount === deliveredCount` is assumed or enforced.** Equality is ONLY allowed if actual measurements prove it with evidence.

---

## 7. POSTGRES INDEX STRATEGY FOR STEPS 1-6 (BEFORE/AFTER)

### 7.1 Tower Selection Step (PostGIS):
- **BEFORE (EXISTING):** `idx_cell_towers_geom_gist` GiST on `(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))` ✅  
  → Already present from migration 001.
- **AFTER (OPTIMIZE):** `VACUUM ANALYZE cell_towers` — ensure up-to-date statistics for query planner.

### 7.2 Subscriber Matching Step (THE KEY INDEX) — DONE
- **BEFORE:** Nothing existed for serving_cell_id (column MISSING). Matching relied on (lac,cisac) bridge.
- **AFTER (Migration 008 — APPLIED):**
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriber_dump_serving_cell
  ON subscriber_dump(serving_cell_id);

  -- Optional covering variant for pure index-only scans when we GROUP BY op/tech:
  -- CREATE INDEX CONCURRENTLY idx_sub_serving_cell_covering
  -- ON subscriber_dump(serving_cell_id)
  -- INCLUDE (imsi, msisdn, operator, technology, state, district, city);
  ```
  Verified: index present, used by planner (Parallel Index Scan on `idx_subscriber_dump_serving_cell`).

### 7.3 Integrity Constraints (Migration 009 — APPLIED):
- ✅ `uq_subdump_imsi` — UNIQUE (imsi)
- ✅ `uq_subdump_msisdn` — UNIQUE (msisdn)
- ✅ FK `fk_subdump_serving_cell → sim_cell_towers(cell_id)` `ON DELETE SET NULL` (**VALIDATED**)
- ✅ CHECK `imsi ~ '^(404|405)[0-9]{12}$'`
- ✅ CHECK `msisdn ~ '^91[6-9][0-9]{9}$'`
- ✅ CHECK `latitude::float BETWEEN 6 AND 37`
- ✅ CHECK `longitude::float BETWEEN 67 AND 98`
- ✅ CHECK `lac ~ '^[0-9A-Fa-f]{4}$'` / `cisac ~ '^[0-9A-Fa-f]{4}$'`
- ✅ CHECK `technology IN ('5G','4G','UMTS','GSM','LTE','NR5G')`
- ✅ CHECK `operator IN ('Jio','Airtel','VI','BSNL','MTNL')`

---

## 8. PERFORMANCE MODEL

### Scaling behavior (cell-indexed matcher):
```
Tower selection latency:      t_tower ∝ log(50K) * cells_selected    (PostGIS GiST)
Subscriber matching latency:  t_match ∝ 50K_index_lookups * N_rows_per_cell_lookup
Dedup latency:                t_dedup ∝ raw_rows (linear HashMap Set)
Submit/DLR:                   independent (async SMPP)

Per-cell subscriber count ≈ 2000 (for 100M Delhi / 50K cells)  [measured ~3,279 for sampled cell set]
→ 50K cells → ~100M raw_matches → dedup → 100M expected (1 imsi:1 row → 0 dupes)
→ Expected 50K stage: t_tower in <3s, t_match in 30-60s, t_dedup in <3s
→ TOTAL pipeline target: < 60s (inside MATCH_TIME_BUDGET_MS default of 60,000)

Measured: 1,000-cell slice = 4,906 ms (Parallel Index Scan on idx_subscriber_dump_serving_cell).
```

---

## 9. OPERATOR + TECHNOLOGY VALIDATION

For any polygon, operator/tech percentages come from **aggregating the actual matched rows** using GROUP BY in the stats query of Step 6 — NOT from a-priori assumptions. Example:

```
Delhi alert with 50K selected cells →
  operators = {
    Jio:     COUNT(*) WHERE operator = 'Jio'         → ~36M (36%)
    Airtel:  COUNT(*) WHERE operator = 'Airtel'      → ~36M (36%)
    VI:      COUNT(*) WHERE operator = 'VI'          → ~15M (15%)
    BSNL:    COUNT(*) WHERE operator = 'BSNL'        →  ~8M (8%)
    MTNL:    COUNT(*) WHERE operator = 'MTNL'        →  ~5M (5%)
  }
  technologies = {
    5G:   COUNT(*) WHERE technology='5G'  → ~68M (68%)
    4G:   COUNT(*) WHERE technology='4G'  → ~25M (25%)
    UMTS: COUNT(*) WHERE technology='UMTS'→  ~7M (7%)
  }
```

These are computed — not faked. If a polygon only overlaps South Delhi (high Jio / VI density due to NCR clustering), the returned percentages reflect actual South Delhi cells, NOT hard-coded 36/36/15/8/5.
