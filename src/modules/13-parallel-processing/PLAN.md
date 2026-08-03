# Module 13 — Parallel Processing Framework

**Status: DESIGNED — orchestrator + worker scaffold next build step.**

## Purpose (requirement #13)
Multiple cell-tower batches (or multiple alerts) processed concurrently so a
large alert does not stall the pipeline.

## Design
- `orchestrator.ts` — per-alert pipeline driver: ingest → resolve towers (02) →
  match subscribers (04) → dedup (05) → chunk → submit (07). Splits the
  deduplicated MSISDN list into `PARALLEL_WORKER_COUNT` batches.
- `workers/match-and-submit-worker.ts` — `worker_threads` entry: each worker
  owns a slice of batches, checks the expiry guard (06), and submits through the
  SMPP session (07). Results merge back into the report (11/12).
- Fallback if SMPP is single-session bound: workers serialize onto one session;
  the fan-out is what parallelizes DB/Redis reads.

## Real inputs
- None new; depends on modules 02–12 completing.

## Latency instrumentation (cross-cutting)
- Workers share the per-alert trace through the **Redis-backed** store
  (`src/tracing/trace-store.ts`), so a batch processed by worker #3 still marks
  the same capIdentifier key as worker #1's t1. Never key by process-local IDs.
- Worker scheduling metrics (queue depth, drain time per worker) logged as
  `pipeline.worker.*` so t2→t3 attribution survives parallelization.
