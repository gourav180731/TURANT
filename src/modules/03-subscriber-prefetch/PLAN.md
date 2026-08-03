# Module 03 — Subscriber Data Prefetch Layer

**Status: DESIGNED — awaiting C-DOT subscriber database connection.**

## Purpose (requirement #3)
Cache tower-to-subscriber mapping in Redis so the hot path never queries the
subscriber DB per alert.

## Design
- `prefetch-sync.ts` — periodic job (configurable `SUBSCRIBER_PREFETCH_SYNC_INTERVAL_MS`)
  that reads `SUBSCRIBER_TABLE` from the real C-DOT subscriber DB and writes
  Redis sets keyed by tower id:
  `{prefix}subscribers:tower:{towerId}` -> SET of MSISDNs.
- `live-lookup.ts` — alternative near-real-time path that queries the subscriber
  DB directly per batch, used when `SUBSCRIBER_LOOKUP_MODE=live`.

## Tradeoff (documented in code)
- **Prefetched (default)**: latency is a Redis SMEMBERS read (µs); cost is staleness
  between syncs. Right for a public early-warning broadcast where subscriber
  movement between syncs is immaterial.
- **Live**: always-current mapping; cost is DB round-trips per alert (throughput
  bound), and it scales poorly for 50k towers. Right only when freshness beats
  throughput.

## Real inputs required from C-DOT
- `REDIS_URL`
- Subscriber DB connection (`DATABASE_URL` or a dedicated one)
- Actual table/column names → `SUBSCRIBER_TABLE`, `SUBSCRIBER_COL_MSISDN`,
  `SUBSCRIBER_COL_TOWER_ID`

## Latency instrumentation (cross-cutting)
- Prefetch itself marks no t-stage; its job is to keep the cache warm so the
  `t1 → t2` delta stays small. Log sync duration + rows cached per cycle as
  `prefetch.sync.completed` for capacity diagnostics.
- Ensure cache keys are ready before an alert arrives so module 04's lookups
  never wait on a cold cache.
