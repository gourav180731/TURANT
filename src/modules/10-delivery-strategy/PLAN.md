# Module 10 — Configurable Delivery Strategy

**Status: DESIGNED — buildable now.**

## Purpose (requirement #10)
Configurable `single-attempt` vs `retry`-based delivery with configurable retry
count and interval.

## Design
- `delivery-policy.ts` — resolves `DELIVERY_STRATEGY`, `DELIVERY_RETRY_MAX`,
  `DELIVERY_RETRY_INTERVAL_MS` into an execution plan for a batch.
- `retry-queue.ts` — in-memory deferred queue re-submitting failed MSISDNs up to
  `DELIVERY_RETRY_MAX` times with exponential backoff, subject to the expiry
  guard (module 06) — expired messages are counted, not retried.

## Real inputs
- None new.

## Latency instrumentation (cross-cutting)
- Retries delay `t3`; every retry round re-checks the expiry guard (module 06)
  first, and expired retries are counted not retried. Log `retry.round` with
  remaining queue size so `t2 → t3` stays attributable.
