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

**Build status:** modules 01–02, 05–13 are implemented, tested and runnable
now. Modules 03–04 are designed but blocked on the real C-DOT subscriber DB
(their `PLAN.md` documents the interface they wait on). Every implemented module
is built against the real protocol/interface; the ones whose data source has not
arrived yet report loudly and are marked **AWAITING** in the table below.

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
| 01 CAP | CAP XML feed (push URL or drop dir), language codes    | Built; needs live feed     |
| 02 Towers | PostGIS DB (`DATABASE_URL`) + tower table schema    | Built; **AWAITING DB creds** |
| 03 Subscribers | Subscriber DB + Redis (`REDIS_URL`)               | Designed; **AWAITING DB**  |
| 04 Matching | Module 03 cache populated                             | Designed; depends on 03    |
| 05 Dedup | none                                                  | Built; tested              |
| 06 Expiry | none (uses CAP `expires`)                             | Built; tested              |
| 07 SMPP | `SMPP_HOST/PORT/SYSTEM_ID/PASSWORD/SYSTEM_TYPE`       | Built; tested; **AWAITING CREDENTIALS** |
| 08 Validity | none (uses CAP `expires` + module 07)                 | Built; tested              |
| 09 Priority | none                                                 | Built; tested              |
| 10 Delivery | none                                                 | Built; tested              |
| 11 DLR | SMSC that forwards `deliver_sm` (part of 07)          | Built; tested; **AWAITING CREDENTIALS** |
| 12 EWS callback | `EWS_CALLBACK_URL` + `EWS_CALLBACK_TOKEN`           | Built; tested; **AWAITING URL** |
| 13 Parallel | none                                                 | Built; tested              |
| 14 Load | real CAP XML for k6                                   | Script ready               |

Every pending value lives in `.env` (see `.env.example`). When a credential
arrives you only edit `.env` — **zero code changes**.

---

## API (implemented today)

- `GET /healthz` — app, DB, Redis, SMPP status (SMPP reports `awaiting_credentials`).
- `POST /api/v1/alerts/cap` — push a CAP XML document. Returns `202` with
  `alertId`, `capIdentifier`, `expiresAt`. `400` on malformed CAP, `413` when
  over `CAP_MAX_XML_BYTES`.
- `GET /api/v1/traces` — latency dashboard: recent per-alert traces with
  precomputed stage deltas.
- `GET /api/v1/traces/:capIdentifier` — full latency timeline for one alert:
  t0..t5 timestamps, inter-stage deltas, and delivery percentiles
  (t0 → first / 50% / 90% / 100% of recipients).
- `GET /api/v1/alerts/:capIdentifier/report` — per-alert delivery report:
  DLR counts + latency, built from real receipts by module 11.
- `POST /api/v1/debug/towers/resolve` — only with `ENABLE_DEBUG_ENDPOINTS=true`;
  exercises module 02 against the real tower DB once connected.

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

## Audit trail

Every stage logs structured JSON keyed by `alertId`
(`cap.ingest.parsed`, `cell.match.start/completed`, `dedup.completed`,
`retry.round`, `dlr.received`, `ews_callback.delivered`, …). Set
`AUDIT_LOG_FILE` to append JSON-lines for the traceability record. Modules 03–04
will log their own events when the subscriber DB arrives.

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
