# TURANT — TSP Presentation Package

> C-DOT intern project. Cell-authoritative early-warning targeting over a real
> C-DOT-style 100M-row subscriber dump. All numbers below are measured from the
> live database on PostgreSQL 18.4 + PostGIS (Windows, Node v24.11.1), captured
> 2026-08-13. Nothing is fabricated.

---

## 1. Problem
After a CAP alert is drawn on the map, the state must be told **exactly which
phone numbers to SMS** for that zone — from the operator's real 100M-subscriber
dump — quickly, correctly, and without leaking across alert boundaries.

## 2. Solution shape
**Cell-authoritative, two-stage matching** composed of four modules
(M02 polygon→cells, M03/04 cell→subscribers, M05 dedup, M06/13 submission):

```
CAP alert zone ──► cells (sim_cell_towers) ──► ONE index seek on
                 subscriber_dump.serving_cell_id  ──► real recipients
```

## 3. Why cells, not polygons
Every dump row carries a FK-bound `serving_cell_id` (migration 008/009). A cell
lookup is a B-tree seek (`= ANY($1)`), never a geometry scan over 197M rows —
reproducible, explainable, and operator-consistent.

## 4. Dataset under test (real, verifiable)
| Metric | Value |
|---|---:|
| Dump total | **191,547,362** rows |
| Delhi total | **exactly 100,000,000** |
| Delhi expansion (mapped to cells) | **97,457,009** |
| Distinct serving cells | **29,727** |
| Legacy rows (non-Delhi) | 94,090,353 |

## 5. Operators (real reference MCC/MNC)
Jio (405-8xx) · Airtel (404-02/03/10…) · VI (404-01/20…) · BSNL (404-58/64) ·
MTNL (404-68 Delhi / 404-69 Mumbai). IMSI `^(404|405)\d{12}$`, MSISDN `91[6-9]\d{9}`.

## 6. Technologies
5G 68% / 4G 25% / UMTS 7% — exactly the TSP spec, enforced per cell.

## 7. Integrity (all green)
FK VALIDATED 0 orphans · 0 dup IMSI/0 dup MSISDN · 0 bad formats ·
0 non-POINT/0 non-Delhi expansion rows · **0 cross-state leakage**.

## 8. Correctness proof (two independent ways)
- **DB:** FK + validated `serving_cell_id`, 0 leakage, `docs/sql/01–11`.
- **Brute-force oracle:** streaming every dump row per cell and counting in Node
  gives the **identical** identity set and counts (206,577/206,577 == optimized).
  `BRUTE_FORCE_VALIDATION.md`.

## 9. Benchmark (measured)
`100→206,577 rows in ~1.1 s warm` · `1k→1,957,563 in ~9.6 s warm` ·
`5k→9.76M rows` · 10k/25k/50k tiers running, live in
`.benchmark-subscriber-matching.json`. 10k-cell EXPLAIN: Parallel Bitmap/Index
scan on `idx_subscriber_dump_serving_cell`, 4,906 ms. Harness measures raw
latency via a 1-h statement-timeout override; production keeps the 5-min
`MATCH_TIME_BUDGET_MS` safeguard so oversized zones halt visibly.

## 10. Performance envelope
Latency is linear in *resolved* rows (≈3,278 rows/cell in v1); every reported
figure is the true database answer. Unbounded aggregate path = no hidden cap.

## 11. Multi-polygon de-dup
Overlapping polygons are unioned; the union result proves
`rowsUnion ≤ rowsA + rowsB` (global de-dup verified, not assumed).

## 12. NO-FABRICATION rule
Reported `matchedCount`/`expectedRecipients` come from unbounded
`COUNT(*)`/`COUNT(DISTINCT msisdn)`; `SUBSCRIBER_DUMP_MATCH_LIMIT` bounds only
the scratch recipient list. No `Math.min(actual, N)`, no "expected = towers × k".

## 13. Known, documented artifacts (transparency)
v1 expansion is uniformly distributed (3,278/3,279 per cell, stddev 0.49) — a
documented side effect of the v1 even-modulo distributor; the generator now
ships a weighted log-normal distributor (min 199/p50 1,103/max 27,306, 5,658
distinct counts). Kept for the benchmark: correctness is distribution-agnostic.

## 14. Reproducibility
`npm run validate:telecom-data` · `npm run benchmark:subscriber-matching` ·
`npm run benchmark:brute-force` · 193 tests pass · typecheck clean.
All evidence SQL in `docs/sql/01–11`.

## 15. Rollback safety
Backup `subscriber_dump` before reprocessing; index rebuild
CONCURRENTLY-writable; gen idempotent/resumable — `ROLLBACK_PROCEDURE.md`.

## 16. Demo script
1. Start server → draw a CAP polygon over Delhi. 2. Observe
`towerCount`, `matchedCount`, `expectedRecipients`, `duplicatesRemoved`
surfaced live from the DB (no hard-coded numbers). 3. Show the benchmark JSON
and this package's SQL evidence on ask.