# Module 04 — Geo-Targeted Subscriber Matching at Scale

**Status: DESIGNED — depends on module 03 (Redis/DB) data being available.**

## Purpose (requirement #4)
Given tens of thousands of tower IDs (module 02 output), return every subscriber
MSISDN attached to those towers within a strict time budget
(`MATCH_TIME_BUDGET_MS`, default 60 s for ~50k towers against ~10 crore base).

## Design
- `lookup-index.ts` — a Redis pipeline of `SMEMBERS` / `SUNION` calls keyed by
  tower id, chunked (configurable) to bound single command latency.
- `matcher.ts` — fan-out over tower-id chunks, merge MSISDNs, enforce the time
  budget with the same race/abort pattern used in module 02.
- No linear scans anywhere: every access is a hash/indexed lookup (Redis set key
  per tower; DB primary-key lookups in live mode).

## Real inputs required from C-DOT
- `REDIS_URL` + a populated prefetch cache (module 03)
- or subscriber DB connection (live mode)

## Latency instrumentation (cross-cutting)
- No t-stage mark from module 04 itself: `t2` is marked by module 05 after
  dedup, per the shared stage contract (`src/types/trace.ts`).
- Record lookups + duration as `match.lookup.completed` (elapsed vs
  `MATCH_TIME_BUDGET_MS`) so a slow tower fan-out is visible inside the
  `t1 → t2` delta before dedup runs.
