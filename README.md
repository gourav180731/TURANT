# TURANT — Targeted Urgent Rapid Alert Notification Tool

Location-based SMS dissemination for CAP (Common Alerting Protocol) early-warning
alerts. When a disaster alert (CAP XML) is issued for a geographic zone, TURANT
identifies the cell towers in that zone, finds the subscribers attached to those
towers, deduplicates them, and pushes SMS through a telecom SMSC (SMPP) — fast,
with full audit feedback, and strictly within the alert's validity window.

Built as an intern project at C-DOT. **This is a real, production-oriented
system**: every module consumes real C-DOT data through configuration — nothing
is stubbed. Modules whose data source has not arrived yet are built against the
real protocol/interface and are explicitly marked **AWAITING** below.

---

## Stack

| Layer      | Choice                                          |
|------------|-------------------------------------------------|
| Language   | Node.js + TypeScript (strict, NodeNext ESM)     |
| HTTP       | Express                                         |
| Database   | PostgreSQL + PostGIS (spatial queries)          |
| Cache      | Redis (ioredis) — subscriber prefetch           |
| SMS        | `smpp` (SMPP 3.4) — real protocol, not mocked   |
| Logging    | pino (JSON, per-alert audit trail)              |
| Validation | zod (env config + CAP runtime schema)           |
| XML        | fast-xml-parser                                 |
| Tests      | vitest                                          |
| Load tests | k6                                             |

## Quickstart

```bash
npm install
cp .env.example .env      # fill with REAL C-DOT values
npm run dev               # starts the ingest server
npm test                  # unit tests (no external services needed)
npm run typecheck
```

---

## Folder structure ↔ the 14 requirements

| # | Requirement                                     | Module / folder                                                        |
|---|-------------------------------------------------|-----------------------------------------------------------------------|
| 1 | CAP XML ingestion                               | `src/modules/01-cap-ingestion/`                                       |
| 2 | Cell site identification                       | `src/modules/02-cell-site-identification/`                            |
| 3 | Subscriber data prefetch layer                 | `src/modules/03-subscriber-prefetch/`                                 |
| 4 | Geo-targeted subscriber matching at scale      | `src/modules/04-subscriber-matching/`                                 |
| 5 | Duplicate elimination                          | `src/modules/05-dedup/`                                               |
| 6 | Expiry-aware submission control                | `src/modules/06-expiry-control/`                                      |
| 7 | Real SMSC integration via SMPP                 | `src/modules/07-smpp-integration/`                                    |
| 8 | SMSC-side validity enforcement                 | `src/modules/08-smpp-validity/`                                       |
| 9 | Priority flagging                              | `src/modules/09-priority/`                                            |
| 10| Configurable delivery strategy                 | `src/modules/10-delivery-strategy/`                                   |
| 11| Delivery receipts (DLR) and feedback           | `src/modules/11-dlr/`                                                 |
| 12| Processing completion feedback to source EWS   | `src/modules/12-ews-callback/`                                        |
| 13| Parallel processing framework                  | `src/modules/13-parallel-processing/`                                 |
| 14| Capacity / load documentation                 | `scripts/load-test/` + `docs/architecture.md`                         |

**Build status:** modules 01–02, 05–13 are implemented, tested and **wired into
the live pipeline**. Modules 03–04 (subscriber matching) wait on the real C-DOT
subscriber database — and are covered by a built-in **telecom simulation**
(`src/telecom/`, see below): a synthetic but structurally-valid subscriber/tower
network that stands in for the C-DOT DB. With `USE_DUMMY_SUBSCRIBER_DB=true` the
whole pipeline (01 → 02 → 03/04 → 05 → 13) runs end-to-end with **no code
changes**; with it false, the pipeline halts loudly at subscriber-matching
exactly as before. Every implemented module is built against the real
protocol/interface; the ones whose real data source has not arrived yet report
loudly and are marked **AWAITING** in the table below.

Supporting code:
- `src/config/` — all connections/credentials via env (zod-validated)
- `src/types/` — CAP, tower, subscriber, SMS, report models (+ `smpp.d.ts`)
- `src/persistence/` — PG/PostGIS pool, Redis client, SQL migrations
- `src/utils/` — audit logger, geometry conversion
- `src/index.ts` — HTTP server, health, wiring

---

## What real inputs are required from C-DOT (status per module)

| Module | Real input from C-DOT                                  | Status                     |
|--------|--------------------------------------------------------|----------------------------|
| 01 CAP | CAP XML feed (push URL or drop dir), language codes    | Built; tested; **wired into live pipeline** |
| 02 Towers | PostGIS DB (`DATABASE_URL`) + tower table schema    | Built; tested; wired; **AWAITING DB creds** |
| 03 Subscribers | Subscriber DB + Redis (`REDIS_URL`)               | Built; tested; sim drop-in (`USE_DUMMY_SUBSCRIBER_DB`); **AWAITING DB for the real path** |
| 04 Matching | Module 03 cache populated                             | Built; tested; wired through the sim matcher; depends on 03 |
| 05 Dedup | none                                                  | Built; tested; wired into live pipeline |
| 06 Expiry | none (uses CAP `expires`)                             | Built; tested — expiry halts retries mid-backoff; wired |
| 07 SMPP | `SMPP_HOST/PORT/SYSTEM_ID/PASSWORD/SYSTEM_TYPE`       | Built; tested; wired; **AWAITING CREDENTIALS** |
| 08 Validity | none (uses CAP `expires` + module 07)                 | Built; tested; wired |
| 09 Priority | none                                                 | Built; tested; wired |
| 10 Delivery | none                                                 | Built; tested; wired |
| 11 DLR | SMSC that forwards `deliver_sm` (part of 07)          | Built; tested; wired; **AWAITING CREDENTIALS** |
| 12 EWS callback | `EWS_CALLBACK_URL` + `EWS_CALLBACK_TOKEN`           | Built; tested; wired; **AWAITING URL** |
| 13 Parallel | none                                                 | Built; tested — real `worker_threads` default; wired |
| 14 Load | real CAP XML for k6                                   | Script ready               |

Every pending value lives in `.env` (see `.env.example`). When a credential
arrives you only edit `.env` — **zero code changes**.

---

## API (implemented today)

- `GET /healthz` — app, DB, Redis, SMPP status (SMPP reports `awaiting_credentials`).
- `POST /api/v1/alerts/cap` — push a CAP XML document. Returns `202` with
  `alertId`, `capIdentifier`, `expiresAt`, and a `pipeline` reference to the
  status endpoint. After ingest the automatic pipeline runs asynchronously
  (ingest → tower resolution → subscriber matching → …). `400` on malformed
  CAP, `413` when over `CAP_MAX_XML_BYTES`.
- `GET /api/v1/alerts/:capIdentifier/pipeline-status` — how far the automatic
  pipeline got: `running | halted | completed`, the farthest stage, the halt
  reason when one exists (e.g. `awaiting subscriber data — modules 03/04 not
  yet connected`, or the missing `DATABASE_URL` error), tower count from module
  02, and a `traceRef` to the latency timeline below.
- `GET /api/v1/traces` — latency dashboard: recent per-alert traces with
  precomputed stage deltas.
- `GET /api/v1/traces/:capIdentifier` — full latency timeline for one alert:
  t0..t5 timestamps, inter-stage deltas, and delivery percentiles
  (t0 → first / 50% / 90% / 100% of recipients).
- `GET /api/v1/alerts/:capIdentifier/report` — per-alert delivery report:
  DLR counts + latency, built from real receipts by module 11.
- `POST /api/v1/debug/towers/resolve` — only with `ENABLE_DEBUG_ENDPOINTS=true`;
  exercises module 02 against the real tower DB once connected.
- `GET /api/v1/debug/sim` · `GET /api/v1/debug/sim/towers` ·
  `GET /api/v1/debug/sim/subscribers?cellId=...` — only with the sim on + debug
  endpoints enabled; introspect the simulated network.

## Latency tracing (t0–t5) — the product metric

TURANT is measured on end-to-end latency: CAP issuance → phone delivery. Every
module records its stage timestamp into one shared per-alert record keyed by the
CAP alert identifier (`src/tracing/trace-store.ts`, memory + Redis mirror):

| Stage | When | Module |
|-------|------|--------|
| t0 | CAP XML received/ingested | 01 |
| t1 | Cell site identification complete | 02 |
| t2 | Subscriber matching complete, post-dedup | 03–05 |
| t3 | SMPP submission complete for the batch | 06–10 |
| t4 | First DLR received | 11 |
| t5 | All expected DLRs or alert expiry, whichever first | 06, 08, 11 |

Deltas (t1−t0, t2−t1, …) are precomputed so the bottleneck stage is visible
immediately; delivery percentiles (t0 → 50/90/100%) come from per-DLR durations
recorded by module 11. Modules 01–02, 05–07, 11 instrument the trace today;
module 13 (parallel workers) shares the same Redis-backed key per alert so the
timeline stays coherent across workers.

## Parallel execution (module 13)

Default `PARALLEL_EXECUTION_MODE=threads` splits the deduplicated MSISDN list
into batches (≤ `PARALLEL_WORKER_COUNT`) and submits each inside its own real
OS thread (`node:worker_threads`), with a fixed pool that reuses workers across
jobs and shuts them down after the alert (no thread leak). Set
`PARALLEL_EXECUTION_MODE=inline` to run the identical pipeline in-process. Both
paths carry the real CAP `expires` into the worker as `expiresAtIso`, so
expiry-gated submission and retry halting behave identically end to end.

## Audit trail

Every stage logs structured JSON keyed by `alertId`
(`cap.ingest.parsed`, `cell.match.start/completed`, `dedup.completed`,
`retry.round`, `dlr.received`, `ews_callback.delivered`, …). Set
`AUDIT_LOG_FILE` to append JSON-lines for the traceability record. Modules 03–04
will log their own events when the subscriber DB arrives.

## Telecom simulation — modules 03/04 drop-in (no C-DOT DB needed)

Modules 03/04 genuinely need C-DOT's subscriber database. Until it is
connected, TURANT ships a built-in simulation (`src/telecom/`) that is a
**drop-in replacement**: the same `SubscriberRepository` interface the real
C-DOT adapter will implement, and the same `SubscriberMatcher` contract modules
03/04 already wait on. It is not fake data bolted onto the pipeline — the
pipeline still runs its real tower resolution, matching, dedup and submission
code; only the *source* of subscribers is simulated.

```bash
# .env — full end-to-end pipeline without any database
USE_DUMMY_SUBSCRIBER_DB=true
SUBSCRIBER_DB_MODE=memory          # or postgres (see below)
DUMMY_TOWER_COUNT=2000             # cells in the region
DUMMY_SUBSCRIBER_COUNT=100000      # subscribers attached to those cells
MIN_USERS_PER_TOWER=10
MAX_USERS_PER_TOWER=500
SIM_SEED=20260902                  # deterministic, reproducible datasets
ACTIVE_SUBSCRIBER_PCT=85           # ~85% ACTIVE, rest INACTIVE
SEED_BATCH_SIZE=1000               # deterministic streaming batch
```

Properties:

- **Structurally valid & internally consistent.** IMSI `404/405 + MNC + MSIN`
  (15 digits, the canonical C-DOT shape), MSISDN `91` + 10 digits starting 6–9,
  Luhn-valid IMEI, LAC/TAC, cell ids, PLMN (`404-68-…`), tower vendor/controller/
  backhaul, radio planning params (ARFCN/UARFCN/EARFCN, PCI, band, azimuth,
  height, capacity). A subscriber's RAT always matches its tower's RAT;
  `last_seen` is always within the previous 48h; towers sit inside the region
  (Delhi NCR) with per-area jitter.
- **Deterministic.** One `SIM_SEED` drives a seeded PRNG (no `Math.random` in
  datasets). Every batch derives from `(SIM_SEED, batch index)`, so a dataset is
  fully reproducible, parallel seeders take disjoint identity ranges, and
  Postgres seeding is resumable after any crash.
- **1K → 300M via env only.** `SUBSCRIBER_DB_MODE=postgres` seeds the same
  generator into real PostgreSQL (`scripts/seed-telecom.ts` / `npm run seed`)
  with `SUBSCRIBER_PARTITIONS` (HASH(imsi) partitioning), `SEED_WORKERS`
  concurrent slices and `SEED_USE_COPY` (COPY FROM STDIN). Only the counts in
  `.env` change; nothing in code.
- **Honest failure.** `USE_DUMMY_SUBSCRIBER_DB=false` makes the repository
  factory throw `Real C-DOT Subscriber Repository Not Configured` — the app
  keeps running and the pipeline halts loudly at subscriber-matching, as it did
  before this module existed.

When C-DOT connects the real database, point `SUBSCRIBER_COL_*` at the real
schema (same config-driven pattern as the tower adapter) and implement
`SubscriberRepository` against it — the pipeline code does not change. See
`docs/telecom-simulation.md` for the full design.

## Running against the real tower DB (module 02)

```bash
# .env
DATABASE_URL=postgres://user:pass@host:5432/turant
TOWER_SOURCE_MODE=postgis
TOWER_TABLE=<C-DOT tower table>        # column mapping via TOWER_COL_*
TOWER_COVERAGE_MODEL=radius|polygon    # match the C-DOT schema
ENABLE_DEBUG_ENDPOINTS=true            # staging only
```

The reference schema and the GiST spatial indexes are in
`src/persistence/migrations/001_init.sql`. The PostGIS adapter builds one
`ST_Union` zone geometry from all CAP polygons/circles and matches with
`ST_Intersects` / `ST_DWithin` / `ST_Buffer(geography)`; a
`statement_timeout` equal to `TOWER_MATCH_TIME_BUDGET_MS` is enforced DB-side.

## Load testing (requirement #14)

See `scripts/load-test/README.md`. k6 script requires a real CAP XML file
(`--env CAP_XML_FILE=...`); it aborts rather than fabricating a payload.
