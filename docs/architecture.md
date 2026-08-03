# TURANT Architecture

## System context

```
┌──────────┐  CAP XML (push/poll)   ┌──────────────────────────┐
│   EWS    │ ─────────────────────► │  TURANT (this project)    │
│ (source) │                        │  Node.js + Express        │
└──────────┘ ◄──── completion report │                          │
       └───────────────────────────────────────────────────────┘
                                        │            │          │
                                     PostGIS     Redis       SMSC/SMPP
                                   (towers DB) (subscriber   (SMS)
                                                prefetch)
```

## End-to-end flow (modules 1–13)

1. **Ingest (01)** — CAP XML parsed & validated (`identifier`, `sender`, `sent`,
   `status`, `msgType`, `scope`, `info`/`area` with polygons & circles, `expires`).
2. **Towers (02)** — zone geometries unioned and matched against the PostGIS
   tower table (indexed `ST_Intersects`/`ST_DWithin`), within a DB-enforced
   `statement_timeout` budget.
3. **Prefetch (03)** — tower→subscriber map synced into Redis on a schedule.
4. **Match (04)** — indexed Redis lookups fan out over tower IDs, budget-bounded.
5. **Dedup (05)** — in-memory `Set` over E.164 MSISDNs.
6. **Expiry (06)** — batch gate against the alert `expires` timestamp.
7. **SMPP (07)** — real SMPP 3.4 client (bind + `submit_sm`), auto-reconnect.
8. **Validity (08)** — SMPP `validity_period` = CAP expiry.
9. **Priority (09)** — `priority_flag = 3` for all early-warning SMS.
10. **Delivery strategy (10)** — single-attempt or retry, configurable.
11. **DLR (11)** — `deliver_sm` receipts → per-alert delivered/failed counts.
12. **EWS callback (12)** — completion report (see consistency rule below).
13. **Parallel (13)** — `worker_threads` fan-out for batches/alerts.

## Invariant: submitted == successful push

`successfulPushCount === smsSubmittedCount`. "Submitted" = SMSC accepted the
`submit_sm` (command_status 0). Delivered/failed come from DLRs and are reported
alongside but never change this pair. Enforced by the report builder in 12.

## Latency tracing (cross-cutting)

End-to-end latency is the product metric. A single per-alert trace record keyed
by the CAP alert identifier (`src/tracing/trace-store.ts`, in-memory +
Redis-backed for worker sharing) collects:

```
t0 ingest → t1 cell match → t2 subscriber match+dedup → t3 SMPP submit
         → t4 first DLR → t5 all expected DLRs / expiry (whichever first)
```

Deltas between stages are precomputed on read (`computeStageDeltas`), and
delivery percentiles (t0 → first/50/90/100% of recipients) are derived from
per-DLR durations (`computeDeliveryPercentiles`). The EWS callback (12) carries
`latencyMs` in its payload. The load harness (`scripts/load-test/latency-e2e.k6.js`)
targets t0→90% delivered as the pass/fail metric.

## Consistency & correctness notes

- All coordinates enter as CAP `lat,lng` and are converted to GeoJSON `lng,lat`
  only at the PostGIS boundary (`src/utils/geometry.ts`).
- Circle radii are CAP km → metres (`* 1000`) before `ST_Buffer(geography)`.
- Every module is either implemented or carries a `PLAN.md` stating the real
  input it awaits; nothing in the pipeline fabricates data.
- Config is validated at boot by zod; malformed env fails fast.

## Capacity planning inputs (req 14)

See `scripts/load-test/README.md` for the observed-throughput template and the
throughput model used to size Redis/PG and SMSC bandwidth.
