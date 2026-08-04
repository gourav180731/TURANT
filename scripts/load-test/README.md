# Capacity / Load Testing (Requirement #14)

This folder holds load-testing assets and the record template for capacity
planning. **No sample data is embedded** — every run consumes a real CAP XML
document you provide.

## The metric that matters: t0 → 90% delivered

TURANT is judged on end-to-end latency: CAP issuance → phone delivery. Use
`latency-e2e.k6.js` as the primary load test. It posts a real CAP alert, then
polls the per-alert latency endpoint until delivery percentiles appear, and
records:

| k6 metric | Meaning |
|-----------|---------|
| `t0_to_first_delivery_ms` | t0 → first successful delivery |
| `t0_to_p50_delivered_ms`  | t0 → 50% of intended recipients delivered |
| `t0_to_p90_delivered_ms`  | t0 → 90% of intended recipients delivered |
| `t0_to_p100_delivered_ms` | t0 → 100% of intended recipients delivered |
| `pipeline_t0_to_t3_submit_ms` | pipeline proxy (t0→submission) used until DLRs arrive |

Percentiles are computed **server-side** relative to the alert's own t0
(`GET /api/v1/traces/:capIdentifier`), so the client never depends on clock sync.

```bash
# Delivery percentiles (requires SMSC + DLRs, modules 07/11)
k6 run --env BASE_URL=http://localhost:8080 --env CAP_XML_FILE=./cap.xml \
       --env THRESHOLD_P90_MS=30000 latency-e2e.k6.js

# Without SMSC creds yet: same command — script records t0->t3 pipeline proxy
# and logs a warning that delivery data is pending.
```

## Raw ingest throughput (secondary)

`cap-ingest.k6.js` measures pure ingest throughput under the target load:

```bash
k6 run --env BASE_URL=http://localhost:8080 --env CAP_XML_FILE=./cap.xml cap-ingest.k6.js
```

## Subscriber-matching throughput (telecom simulation)

`subscriber-lookup.k6.js` drives the whole chain against the simulated
subscriber database — ingest → tower resolution → subscriber matching → dedup →
submission — and asserts towers resolved, recipients matched, and the run
completed. Boot the app with the sim on first:

```bash
USE_DUMMY_SUBSCRIBER_DB=true SUBSCRIBER_DB_MODE=memory \
DUMMY_TOWER_COUNT=2000 DUMMY_SUBSCRIBER_COUNT=100000 \
npx tsx src/index.ts

k6 run --env BASE_URL=http://localhost:8080 \
       --env CAP_XML_FILE=./cap-delhi-ncr.xml subscriber-lookup.k6.js
```

Record `expectedRecipients/s` (matched subscribers per second) and the end-to-end
ingest→status p95 under each stage.

## What to record (per stage / scenario)

| Stage | VUs | Observed t0→p90 (ms) | Observed t0→first (ms) | msgs/s | Error % | Notes |
|-------|-----|----------------------|------------------------|--------|---------|-------|
| 1 alert at a time | 1 | | | | | |
| Peak target | 50 | | | | | |

## Throughput model to discuss with your mentor
```
peak_alert_rate        = <alerts/hour>           # EWS issue rate
towers_per_alert       = <from module 02 on real data>
subscribers_per_tower  = <from module 03 on real data>
sms_submission_rate    = <submit_sm/s>           # bounded by SMSC capacity
required_smpp_rate     = dedup_subscribers / validity_window_seconds
target_t0_to_p90       = <the SLA number your mentor cares about>
```

Bring the latency rows plus these numbers to the capacity-planning
conversation; they drive Redis/PG sizing, SMSC bandwidth and the demo script.
