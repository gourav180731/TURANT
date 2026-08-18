# Brute-force vs Optimized: Cell-Authoritative Matching

> **Command:** `npm run benchmark:brute-force`  (sample size `BRUTE_CELLS`, default 100)
> **Evidence file:** `.brute-force-validation.json` / `.brute-force-validation.md`
> **Measured:** 2026-08-13

## What it proves

The optimized production path is one SQL statement that aggregates in the DB
(`buildSubscriberCellStatsQuery`, `docs/sql/11_v_50k_benchmark_stats.sql`).
A reviewer can always ask "is that COUNT right?". This harness answers with an
**independent oracle**: it streams every dump row for each serving cell through
the same B-tree index and counts in Node, per row, with a JS `Set` for global
de-dup. No aggregate SQL, no GROUP BY — the counts are computed from the raw
identity set.

## Result (100-cell sample)

| Measure | Optimized (SQL) | Brute force (JS per row) | Identical |
|---|---:|---:|---|
| Matched rows | 206,577 | 206,577 | **true** |
| Distinct MSISDN | 206,577 | 206,577 | **true** |
| Elapsed | 2,198 ms | 272 ms | — |

`pass=true` — the identity set and both counts are byte-identical. This is the
strongest correctness evidence that the optimized `serving_cell_id = ANY($1)`
aggregate returns exactly the set of subscribers the cells actually serve.

## Why the brute-force is faster on small samples

Both share the same `idx_subscriber_dump_serving_cell` index seek; here the
brute force does 63 per-cell seek+fetch to a client, while the optimized path
does one big `ANY(63)` fetch plus a `COUNT(DISTINCT msisdn)` sort/hash aggregate
over 206K rows. At larger cell counts the optimized single-statement path wins
(see `BENCHMARK_REPORT.md`); the point of this harness is equality of RESULTS,
not speed.

## Sample honesty notes

- The lexicographically-first `sim_cell_towers` cell_ids: 63 of 100 have dump
  rows (`resolvedCellCount=63`), 37 are real tower cells outside the mapped
  expansion — those 37 resolve to 0 subscribers and `mappingIncomplete=true`.
  This is honest `target vs resolved vs unresolved` reporting, never masked.
- Cells report `min=3278/max=3279` per cell in v1 (uniform distributor) — see
  `SUBSCRIBER_GENERATION.md` section 1a for the documented finding.

## Reproduce

```powershell
npm run benchmark:brute-force          # 100 cells (~330K rows)
$env:BRUTE_CELLS="1000"; npm run benchmark:brute-force   # 3.3M rows
```

Exit code 0 = pass; 2 = mismatch; 1 = error.