# TURANT — Subscriber Matching Optimization Report

Generated: 2026-08-13T12:56:00Z  
Baseline target: **50,000 selected cells → 97,457,009 unique Delhi subscribers → <60 seconds**  
Baseline measured (before optimization): **541,067 ms warm median (≈558s)**  [(source)](file:///C:/Users/91958/OneDrive/Desktop/TURANT/.benchmark-subscriber-matching.md)

---

## 1. Current query (before optimization — the 558-second path)

The production matcher `PostgresSubscriberCellMatcher.matchCells()` used a CTE that performed **two sequential scans of the 191,547,362-row / 37 GB `subscriber_dump` heap** for every invocation:

```sql
WITH selected_cells AS (
    SELECT DISTINCT serving_cell_id::text AS cell_id
    FROM subscriber_dump
    WHERE serving_cell_id = ANY($1::text[])
),
resolved_cells AS (
    SELECT DISTINCT d.serving_cell_id::text AS cell_id
    FROM subscriber_dump d
    JOIN selected_cells sc ON sc.cell_id = d.serving_cell_id::text
),
agg AS (
    SELECT COUNT(*)                                        AS matched_rows,
           COUNT(DISTINCT msisdn)                          AS unique_msisdns   -- ← 97M × 13-char TEXT hash aggregate
    FROM subscriber_dump d
    WHERE d.serving_cell_id = ANY($1::text[])
),
counts AS (
    SELECT (SELECT COUNT(*) FROM selected_cells)                               AS target_cells,
           (SELECT COUNT(*) FROM resolved_cells)                               AS resolved_cells,
           (SELECT COUNT(*) FROM selected_cells) - (SELECT COUNT(*) FROM resolved_cells) AS unmatched_cells,
           agg.matched_rows, agg.unique_msisdns
    FROM agg
)
SELECT * FROM counts;
```

→ **Two full-width 97M-row scans + text MSISDN hash-aggregate** on the 37 GB heap. The MSISDN hash-aggregate (COUNT(DISTINCT text)) is 3–5× slower than int4.

## 2. EXPLAIN (ANALYZE, BUFFERS) — 50K cells

*LIVE EXPLAIN will be appended to `.explain-analyze-50k.md` once the optimization tables finish populating. Expected shape:*

| Version | Planned approach | Key evidence we look for |
|---|---|---|
| A (legacy) | Seq Scan on subscriber_dump → HashAggregate (text msisdn) | `Buffers: shared hit=… read=4.8M` ≈ 37 GB I/O; `HashAggregate` groups=97M on text |
| B (covering index) | Index Only Scan using idx_sci_cover on subscriber_dump → HashAggregate (int4 id)  | Heap Fetches: 0; HashAggregate groups=97M on int4 (narrower state) |
| **C (narrow access)** | **Hash Join on cell_subscriber_stats (29K) + Index Scan / Bitmap Heap Scan on subscriber_cell_index (CLUSTERed PK) → HashAggregate (int4 subscriber_id)**  | **Buffers: ~1.9M reads only (≈15 GB); HashAggregate groups=97M int4; actual time << 60s**  |
| D (postings) | Hash Join on cell_postings → UNNEST intarray → Unique | 97M int4 values unnest; memory/CPU profile |

*See scripts/explain-analyze-50k.ts*

## 3. Bottleneck — exact root cause of 558 s

Two orthogonal issues combined to cause the 541s baseline:

### (a) Optimization tables were never populated (0 rows)
Migration 010 DDL (`subscriber_cell_index`, `cell_subscriber_stats`, `cell_postings`) was applied to the schema, confirmed by `pg_class` showing all three relations existed. However `scripts/build-cell-subscriber-access.ts` (the one-time population step) **had never been executed**. `pg_class.reltuples` for all three tables was **-1 / 0 rows**, confirmed by `scripts/quick-check-dbstate.ts`:
```
subscriber_cell_index                0 rows,       0 pages,    0 bytes (empty!)
cell_subscriber_stats                0 rows,       0 pages,    0 bytes (empty!)
cell_postings                         0 rows,       0 pages,    0 bytes (empty!)
```

### (b) Production matcher always scanned the wide heap
The benchmark harness invokes `PostgresSubscriberCellMatcher.matchCells()`. This method **never consulted** the migration 010 access structures. It contained only the original CTE from (1), which hits the 191M-row dump heap unconditionally. The `cell-access-path.ts` helper classes (`MappingAccessPath`, etc.) existed but were not wired into `matchCells()`.

### (c) Quantified cost
For 50K cells → 97,457,009 Delhi rows:
- `COUNT(*)` + `COUNT(DISTINCT msisdn text)` → scans ≈ 2× 37 GB of heap = **74 GB I/O**.
- MSISDN text hash-aggregate → groups=97M; 13-char strings; HashAgg state ~1.2 GB.
- Result: 541,067 ms (warm median from baseline).

## 4. Current timing breakdown

Baseline 50K tier (warm, from `.benchmark-subscriber-matching.md`):

| Phase | Measurement (ms) | Driver |
|---|---:|---|
| Tower selection (sim_cell_towers sample) | ~10 ms | Deterministic ORDER BY cell_id LIMIT 50000 |
| **PostgreSQL stats query** | **≈ 540,000 ms**  | `buildSubscriberCellStatsQuery` — 2× heap scan + text hash agg |
| DISTINCT dedup | included in PG time | `COUNT(DISTINCT msisdn text)` inside PG |
| PG → Node transfer | ~10 ms | 1 row result |
| MSISDN materialization | N/A | `matchCells()` returns counts only |
| Application side | ~100 ms | Structured logging, timer wrap |
| **Total matching**  | **541,067 ms (median)**  | |

Tiers:
```
  100 cells →       1,630 ms
 1000 cells →       9,579 ms
 5000 cells →     169,167 ms
10000 cells →     195,688 ms
25000 cells →     388,000 ms
50000 cells →     541,067 ms   ← linear with selected Delhi population, not with cell count
```

Growth confirms the O(N_matched_rows) heap-scan bottleneck (scales with Delhi size, not selected cells).

## 5. Candidate architecture (runtime dispatch)

Implemented as a **transparent three-tier dispatch** in `PostgresSubscriberCellMatcher.matchCells()` / `matchSubscribers()`:

```
                ┌─ probe EXISTS (SELECT 1 FROM cell_subscriber_stats LIMIT 1)
                │
         ready? ├─ NO  →  buildLegacyDumpStatsQuery     (the 37 GB heap path,
                │                                      same output shape; used
                │                                      when 010 tables empty)
                │
                └─ YES →  buildNarrowAccessStatsQuery  (the <60 s target path)

  Narrow path:
    cell_subscriber_stats (29K rows, per-cell SUM cache)
         JOIN target via cell_id
         ↓  SUM(subscriber_count) → matched_rows
         ↓  COUNT(cell_id)       → resolved_cells
    +
    subscriber_cell_index (97M rows, CLUSTERed PK (serving_cell_id, subscriber_id))
         WHERE serving_cell_id = ANY(50K)
         ↓  COUNT(DISTINCT subscriber_id int4) → unique_msisdns
    =
    ONE 5-column row: {target_cells, resolved_cells, unmatched_cells,
                       matched_rows, unique_msisdns}
```

- **No fabrication.** Counts always come from DB tables.
- **No LIMIT in stats path** (the materialization cap `SUBSCRIBER_DUMP_MATCH_LIMIT` applies only when MSISDN strings are later streamed by `buildSubscriberCellQuery`).
- **Authoritative relationship preserved:** selected cell → serving_cell_id → subscriber (via FK → subscriber_dump.id; the narrow table is a projection of that relationship with `(serving_cell_id, id::int4)` populated by INSERT SELECT from dump).

## 6. Expected complexity (after optimization)

| Operation | Source | Complexity | Cold data estimate |
|---|---|---|---|
| matched_rows  | `cell_subscriber_stats` JOIN target | O(50K hash join + 29K scan, int8 SUM) | **< 50 ms**  |
| unique_msisdns | `COUNT(DISTINCT subscriber_id int4)` on `subscriber_cell_index` WHERE 50K cells | Index/Bitmap scan on CLUSTERed PK: O(97M narrow rows sequential I/O) + int4 HashAggregate | **15–35 s**  (SSD: 1.5 GB @ 80–100 MB/s + hash) |
| target/resolved/unmatched | CTE scalar subqueries on 29K table | O(1) | < 5 ms  |
| **Total PG query** |  |  | **15–35 s ≪ 60 s ✓**  |

Intarray `cell_postings` (VERSION D) is available as a fallback if hardware limits make VERSION C exceed 60s. It unions int4 arrays in memory (97M int4 values) and avoids the index seek/scan on the 97M row PK, possibly shaving another 5–10s.

## 7. Exact schema/index changes required

**Migration 010 DDL already exists.** The schema changes needed are *population + physical optimization*, not DDL:

1. **`scripts/build-cell-subscriber-access.ts`** (in progress — pg_backend_pid 28372)
   - `TRUNCATE subscriber_cell_index, cell_subscriber_stats, cell_postings`  ✅ done
   - `INSERT INTO subscriber_cell_index (serving_cell_id, subscriber_id) SELECT serving_cell_id, id::int4 FROM subscriber_dump WHERE serving_cell_id IS NOT NULL;`   ← **active (1h16m)**
   - `INSERT INTO cell_subscriber_stats (cell_id, subscriber_count, unique_subscriber_count) SELECT serving_cell_id, COUNT(*), COUNT(*) FROM subscriber_dump … GROUP BY serving_cell_id;`
   - `INSERT INTO cell_postings (cell_id, subscriber_ids) SELECT serving_cell_id, array_agg(id::int4 ORDER BY id) … GROUP BY serving_cell_id;`
   - `CLUSTER subscriber_cell_index USING subscriber_cell_index_pkey;`   ← critical for physical locality
   - `ANALYZE subscriber_cell_index, cell_subscriber_stats, cell_postings;`

2. **No new indexes on `subscriber_dump` required** (VERSION C path self-sufficient).

3. **Optional VERSION B fallback covering index** (only if C exceeds 60s on current disk):
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriber_dump_serving_cell_cover_id
     ON subscriber_dump(serving_cell_id) INCLUDE (id);
   ```

4. **Matcher code** `src/telecom/matcher/subscriber-cell-matcher.ts`:
   - Added `buildLegacyDumpStatsQuery(cfg, cellIds)` (original CTE preserved).
   - Added `buildNarrowAccessStatsQuery(cfg, cellIds)` (VERSION C CTE above).
   - Added `resolveStatsQuery(conn, cfg, cellIds)` dispatcher — 1-row EXISTS probe, picks the correct SQL without fabricating zeros.
   - Both `matchCells()` and `matchSubscribers()` now call `resolveStatsQuery` and log the `optimized` flag.

## 8. Expected benchmark methodology

Tiered benchmark script: `scripts/benchmark-subscriber-matching.ts` (harness already exists).

### a) Sampling (deterministic for reproducibility):
```sql
SELECT cell_id FROM sim_cell_towers
WHERE LENGTH(cell_id) > 0 ORDER BY cell_id LIMIT $1
```
Tiers: 100, 1K, 5K, 10K, 25K, **50K** cells.

### b) Iterations:
- 1 cold iteration (discard, warm buffers).
- **3 measured warm iterations** per tier → report `median`, `min`, `max`.
- `BENCH_ITERATIONS=3 npm run benchmark:subscriber-matching`

### c) Recorded fields:
| Field | Source |
|---|---|
| `cellCount` |  |
| `rawMatchedRows`  | `matched_rows` from PostgreSQL stats CTE |
| `uniqueSubscribers` | `unique_msisdns` from PostgreSQL dedup |
| `duplicatesRemoved`  | `rawMatchedRows − uniqueSubscribers` |
| `postgresMs`  | Timer around `conn.query(statsSQL)` only |
| `dedupMs`  | N/A (dedup happens inside PG via COUNT(DISTINCT int4)) |
| `materializationMs`  | Timed when `matchSubscribers` streams MSISDNs (not needed for matchCells stats benchmark) |
| `totalMatchingMs`  | Wall-time around whole `matchCells()` call |
| `optimized: boolean`  | Flag from `resolveStatsQuery` confirming which path ran |

### d) Correctness gate (before benchmarking):
Run `scripts/verify-correctness.ts`:
- Stats counts identical: legacy vs optimized → raw AND unique both bitwise equal.
- Identity set equality: `(optimized − oracle) = ∅` AND `(oracle − optimized) = ∅`, using `subscriber_id int4` (dump PK) via EXCEPT. Written to `.verify-correctness.md/json`.
- Fail on any mismatch → exit code 2.

---

## Remaining steps (active todo)

| # | Step | Status |
|---|---|---|
| 7b | Populate 010 tables (pg pid 28372 INSERT → stats → postings → CLUSTER) | 🔄 in progress (1h16m in step 1) |
| 3b | `.explain-analyze-50k.md` with real EXPLAIN (ANALYZE, BUFFERS) | ⬜ after populate |
| 8 | Correctness: `.verify-correctness.md` PASS 1000-cell + subscriber_id set equality | ⬜ after populate |
| 9 | 6-tier benchmark (100 / 1K / 5K / 10K / 25K / 50K), 3 warm runs each → `.benchmark-subscriber-matching.md` | ⬜ after populate |
| 10 | Final 50K measured time → attach this report as evidence (EXPLAIN + correctness + benchmark) | ⬜ after all |
