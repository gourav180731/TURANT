# Telecom Simulation Layer (`src/telecom/`)

The simulation is a **drop-in replacement for the C-DOT subscriber database**
that modules 03/04 wait on. It is a real, production-grade module — the pipeline
runs its real tower resolution, matching, dedup and submission code; only the
*source* of subscriber records is simulated. When the real DB arrives, an
adapter implements the same interface and nothing else changes.

## What it is

A synthetic but **structurally valid** telecom network over a geographic region:

- `DUMMY_TOWER_COUNT` cell towers, each with operator (MTNL/BSNL/AIRTEL/JIO/VI,
  weighted toward MTNL to match the canonical Delhi sample), vendor, controller,
  LAC/RNC, cell id, PLMN, radio planning params (ARFCN/UARFCN/EARFCN, PCI, band,
  azimuth, beamwidth, height, capacity `maxUsers`), coverage radius, backhaul,
  state/district/city/zone/PIN and GeoJSON geometry. Tech mix 20/20/40/20
  GSM/UMTS/LTE/NR5G (`TECH_*_PCT`, must sum to 100).
- `TELECOM_MASTER_TOWER_COUNT` (default **5,000**) cell towers in the
  **Telecom Master Dataset**: a second, C-DOT BTS-shaped reference table
  (`telecom_master`) with `cell_id`/`bts_id` unique, clustered around 15
  weighted Delhi-NCR hotspots, and C-DOT-style columns (`service_provider`,
  `service_area`, `site_type`, `switch_make/model`, `state_id`, `rnc_id`,
  `tsp_name`, `msc_ip`, `technology`, WKT `geom`). Module 02 can read this
  table directly (`TOWER_TABLE=telecom_master`), and module 03 subscribers are
  attached to the same `cell_id`s. See **Telecom master dataset** below.
- `DUMMY_SUBSCRIBER_COUNT` subscribers attached to those towers. Each has a
  15-digit IMSI (`404|405 + MNC + MSIN`), MSISDN (`91` + 10 digits, series
  6–9), Luhn-valid IMEI, TMSI, LAC/TAC/RNC/eNB/gNB, `last_seen` within 48h,
  per-RAT signal metrics, roaming/registration/paging state, device vendor +
  model (RAT-appropriate), APN, IPv4/IPv6. A subscriber's RAT always matches
  its tower's RAT.

Everything is **internally consistent** and **deterministic**: one `SIM_SEED`
drives a seeded PRNG (mulberry32) — there is no `Math.random` in dataset
generation.

## Architecture

```
src/telecom/
  entities/          TelecomSubscriber, TelecomCellTower, LocationArea
  generators/        prng (mulberry32 + gaussian), identity (IMSI/MSISDN/IMEI/TMSI),
                     device-catalog, geography (Delhi NCR + operator/vendor/switch
                     pools), tower-generator (hotspot clustering), subscriber-
                     generator (capacity-weighted allocation)
  repositories/      SubscriberRepository contract + errors, SQL builders,
                     InMemorySubscriberRepository, PostgresSubscriberRepository
  matcher/           TelecomSimSubscriberMatcher (pipeline modules 03/04 wiring)
  seeders/           DDL builders (partition-aware) + PostgresSimSeeder,
                     TelecomMasterSeeder + master-sql (C-DOT BTS table builder)
  services/          TelecomSimulator (bootstrapping), createSubscriberRepository
  debug-routes.ts    GET /api/v1/debug/sim*
  tower-store.ts     In-memory tower store (module 02 memory tower source)
```

### Pipeline integration

- Module 02 (`TOWER_SOURCE_MODE=memory`) resolves towers from the in-memory
  tower store, matching the same radius-coverage semantics as the PostGIS
  adapter (`src/telecom/utils/geo.ts`). In memory sim mode the mode is selected
  automatically (derived in `src/config/env.ts`); in Postgres mode the seeder
  also writes the module-02 subset into `cell_towers` so `postgis` works too.
- Modules 03/04 (`registerSubscriberMatcher`) register the
  `TelecomSimSubscriberMatcher` on boot; the pipeline then continues past
  `subscriber-matching` unchanged.
- `createSubscriberRepository` throws `Real C-DOT Subscriber Repository Not
  Configured` when `USE_DUMMY_SUBSCRIBER_DB=false` — the app keeps running and
  the pipeline halts loudly at subscriber-matching as before.

## Two run modes

### `SUBSCRIBER_DB_MODE=memory` (dev / tests)

`TelecomSimulator.boot()` generates towers + subscribers in-process, registers
them with the tower store and a shared `InMemorySubscriberRepository`, and
registers the matcher. No database required. The pipeline is fully exercisable
through `POST /api/v1/alerts/cap`.

### `SUBSCRIBER_DB_MODE=postgres` (the 1K → 300M path)

`PostgresSimSeeder` creates the sim schema (migration `002_telecom_sim.sql`
ships the same DDL for ops), then seeds:

1. `sim_cell_towers` (full tower entity + geometry) and the `cell_towers`
   subset module 02 reads.
2. `telecom_master` — the **Telecom Master Dataset** (C-DOT BTS reference
   table), written by `TelecomMasterSeeder` (see below).
3. `subscribers` — `SUBSCRIBER_PARTITIONS` HASH(imsi)-partitions the table
   (0 = plain), `SEED_WORKERS` slices run concurrently, `SEED_USE_COPY=true`
   streams batches through COPY FROM STDIN (`pg-copy-streams`), otherwise
   batched `INSERT … ON CONFLICT (imsi) DO UPDATE`.

**Seeding is deterministic, idempotent and resumable.** Batch *i* derives from
`subscriberBatchSeed(SIM_SEED, i)` with identity offset `i × SEED_BATCH_SIZE`,
so regenerating a batch reproduces identical rows. Before inserting, the seeder
checks the batch's IMSI range against the table (`count(*) WHERE imsi BETWEEN
range`) and skips complete batches — resume is exact after any crash.
`SIM_SEED_RESET=true` drops and recreates the sim tables for a full reseed.

```bash
USE_DUMMY_SUBSCRIBER_DB=true SUBSCRIBER_DB_MODE=postgres \
DUMMY_SUBSCRIBER_COUNT=1000000 DUMMY_TOWER_COUNT=10000 \
SUBSCRIBER_PARTITIONS=32 SEED_WORKERS=8 SEED_USE_COPY=true \
DATABASE_URL=postgres://… npx tsx scripts/seed-telecom.ts
# or: npm run seed
```

## Telecom master dataset (C-DOT BTS reference table)

The master dataset is a **realistic, C-DOT-shaped tower reference table**
(`telecom_master`) produced from the same deterministic generator, so it is
fully reproducible (`SIM_SEED`). It mirrors the canonical C-DOT BTS columns
(`id, service_provider, cell_id, latitude, longitude, service_area, state,
district, city_town, pincode, bts_id, site_type, switch_make, switch_model,
state_id, geom, rnc_id, tsp_name, msc_ip, technology, coverage_radius_m,
created_at`) with `cell_id`/`bts_id` unique, a GIST index on `geom`, and a
generated `ll` GIST index on `ST_MakePoint(longitude, latitude)` (migration
`002_telecom_sim.sql`).

Realism properties:

- **Geography** — towers cluster around 15 weighted Delhi-NCR hotspots (Delhi
  districts + Gurugram, Faridabad, Noida, Ghaziabad, Greater Noida, Vaishali);
  a Box–Muller `gaussian(rand)` jitter (σ ≈ 0.028°, clamped ±0.06) makes the
  distribution street-cluster-like, not uniform. Coordinates round to 6
  decimals and the WKT `geom` (`POINT(lng lat)`) uses the *same* rounded values,
  so geometry and columns always agree.
- **Operators** — MTNL/BSNL/AIRTEL/JIO/VI with market-share weights
  10/10/28/30/22; `bts_id` = `<OP>-<6-digit>`, `msc_ip` = `10.<mnc>.<x>.<y>`,
  `rnc_id` = `RNC-<OP>-<nnnn>`, and ECGI/CGI/eNB/gNB + PLMN derive from the
  operator's MCC/MNC.
- **Site & switching** — `site_type` (MACRO/ROOFTOP/TOWER/MICRO/INDOOR),
  `switch_make`/`switch_model` chosen per RAT from the `SWITCH_MODELS` pools.
- **Consistency with the sim** — subscribers are attached to the *same*
  `cell_id`s, and each subscriber's RAT matches its master row's `technology`,
  so module 03 lookups and module 02 tower resolution agree exactly.

To seed only the master dataset (default 5,000 rows):

```bash
USE_DUMMY_SUBSCRIBER_DB=true SUBSCRIBER_DB_MODE=postgres \
DATABASE_URL=postgres://… npx tsx scripts/seed-telecom-master.ts
# or: npm run seed:telecom-master
```

Requires PostGIS for the `geom GEOMETRY(Point,4326)` column. Where the
extension is unavailable, `TelecomMasterSeeder.seedMasterTowers(towers, {
geometry: 'raw' })` stores the WKT as `TEXT` instead (the verified fallback
used for schema-mirror testing).

## Scaling 1K → 300M

Only `.env` values change — no code:

| Knob | 1K (dev) | 300M (prod) |
|------|----------|-------------|
| `DUMMY_SUBSCRIBER_COUNT` | 1000 | 300_000_000 |
| `DUMMY_TOWER_COUNT` | 100 | 100_000 |
| `SUBSCRIBER_PARTITIONS` | 0 | 64–256 |
| `SEED_WORKERS` | 1 | 8–16 |
| `SEED_USE_COPY` | false | true |
| `SEED_BATCH_SIZE` | 1000 | 10_000–50_000 |

Identities are counter-derived (no in-memory uniqueness sets), matching is
chunked by `SUBSCRIBER_LOOKUP_CHUNK_SIZE`, and the memory mode is replaced by
the Postgres path at scale.

## Tests

- `tests/telecom-generators.test.ts` — determinism, identity validity,
  tower/subscriber invariants, RAT distribution, allocation bounds.
- `tests/telecom-repositories.test.ts` — in-memory idempotency, lookups, the
  not-configured error, pure SQL builders (no DB).
- `tests/telecom-simulator.test.ts` — boot + matcher registration, matching
  contract, and a full HTTP end-to-end run (01→02→03/04→05→13) against
  `tests/fixtures/cap-delhi-ncr.xml` with no database and no SMSC.
- `tests/telecom-master-dataset.test.ts` — master-dataset field population,
  global uniqueness (cell/site/bts id), operator/switch/site realism and
  `mscIp` format, RAT mix, NCR bounds + clustering, subscriber↔master cell
  reference, module-03 `findByCellIds`, module-02 memory + PostGIS-SQL paths
  against `TOWER_TABLE=telecom_master`, `MASTER_COLUMNS` coverage, WKT
  validity, parameterized (`$16` geom) and raw-WKT INSERT builders, and DDL
  constraints/indexes.

## Load testing

`scripts/load-test/subscriber-lookup.k6.js` drives the full simulated pipeline
and asserts towers resolved, recipients matched, and completion. See
`scripts/load-test/README.md`.

## Swapping in the real C-DOT subscriber DB

1. Implement `SubscriberRepository` against the real schema (reuse the
   config-driven `SUBSCRIBER_COL_*` names already in place).
2. Register a real matcher: `registerSubscriberMatcher(new CdotMatcher(...))`.
3. Set `USE_DUMMY_SUBSCRIBER_DB=false`.

No pipeline, config-schema or HTTP code changes are required.
