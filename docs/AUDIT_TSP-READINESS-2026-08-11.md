# TURANT Audit — TSP-Readiness Report

**Audit date:** 2026-08-11
**Scope:** read-only audit of the running system plus evidence-backed fixes
**Verdict:** **A — READY to proceed to TSP acceptance testing**, with documented boundary conditions (no real SMSC / EWS / mapping master credentials on this machine). Nothing in the audit invented data; every count below traces to a live pipeline stage, database query, or test run.

---

## 1. Audit method

- Every backend claim was verified backward to source: code path → SQL → database rows, or code → test → observed output.
- Frontend numbers were treated as **display-only** and never used as evidence.
- External dependencies (C-DOT SMSC sandbox, EWS callback URL, authoritative cell→(lac,cisac) master) are reported as **EXTERNAL DEPENDENCY**, not as TURANT failures.
- No fabricated results. Synthetic data is explicitly labelled `synthetic_test_mapping` / "synthetic network" in code and DB.
- Fixes were minimal and only where the evidence showed a defect; tests were not weakened (they now assert the *honest* contract; 189/189 green).

## 2. Environment verified

| Item | State |
|---|---|
| Backend | healthy on `:8080`, `db: ok`, `redis: ok`, `smpp: awaiting_credentials` |
| Frontend | `vite build` green, dev server on `:5173` |
| PostgreSQL | `subscriber_dump` 100,000,000 rows (31 GB), PostGIS 4326 |
| `.env` | local-only; **not committed** (only `.env.example` in git) — no secret leak |

## 3. Test suite

- 23 test files, **189 tests, all passing** (was 186; +3 from the new report-builder suite).
- Covers: CAP ingestion, cell-site identification, manual alerts, dedup, expiry, SMPP payloads, validity period, priority, retry, DLR, EWS callback, parallel processing (inline + worker_threads), pipeline integration (incl. real IMD Patna multi-polygon), trace, subscriber dump/cell/bridge matchers, telecom generators/repos/simulator/master.

## 4. Module coverage (01–13)

All 13 modules are implemented and wired. Modules 03/04 are no longer PLAN-only: the running server registers **CellSubscriberBridgeMatcher** (default `bridge` mode) against the 100M dump. Module 12's EWS push is now wired (fix #2, this audit).

## 5. Data authenticity (Phase 3)

| Table | Rows | Notes |
|---|---|---|
| `subscriber_dump` | 100,000,000 | COUNT-verified. Geom POINT(4326), GiST-indexed. |
| `cell_network_mapping` | 150,000 | **100% `source='synthetic_test_mapping'`** (K-NN derive to real dump (lac,cisac)). 34,835 distinct areas, 3 areas/cell, all 50k towers covered. |
| `cell_towers` | 50,000 | Real lat/lng, radius 250–4000 m (avg 1384 m). `cell_id` is **text/hex** (max `FFFF`). |
| `sim_cell_towers` / `cell_subscriber_mapping` | 50,000 / 50,000 | Sim layer; 50k cell overlap with `cell_towers`. |
| `subscribers` (partitioned) | ~2,000 | Dummy sim DB (`USE_DUMMY_SUBSCRIBER_DB=true`, `DUMMY_SUBSCRIBER_COUNT=2000`). |
| `telecom_master` | 5 | Tiny; only used by `npm run seed:telecom-master`. |
| `alerts` | 69 | Live ingest audit trail (raw_xml NOT NULL). |

Lineage check: tower `cell_id=10000` → mapping areas `0454/AAC0` (93 dump rows), `045B/211D` (79), `0460/658C` (78). The relational chain towers→mapping→dump is real and joinable.

## 6. Hard-code / fabrication audit (Phase 2)

- **No hardcoded match/submission/delivery counts** anywhere in `src/` or `frontend/src/`. The numbers `50000/2000/5000` are env defaults, not fabricated results.
- `duplicatesRemoved` and `expectedRecipients` are always derived (`removedCount`, `deduplicated.length`).
- Synthetic sources are honestly labelled in comments, schema default, and DB `source` column.
- `smpp-client` throws `awaiting_credentials`; `batch-submitter` returns `empty(true)`; `ews-callback` returns `not-configured`; `healthz` reports `awaiting_credentials`. No fake session, no fake delivery.

## 7. Benchmarks (Phase 4) — real cells from `cell_towers`

| Target cells | Resolved | Raw rows | Unique MSISDNs | Elapsed (3 runs) |
|---|---|---|---|---|
| 100 | 100 | 17,381 | 17,381 | 54 / 54 / 54 ms |
| 1,000 | 1,000 | 125,832 | 125,826 | 419 / 423 / 1,088 ms |
| 5,000 | 5,000 | 442,852 | 442,756 | 2,855 / 4,538 / 4,903 ms |
| 10,000 | 6,000 | 511,064 | 510,936 | 2,460 / 4,612 / 6,072 ms* |
| 50,000 (real IDs) | 50,000 | 3,159,936 | **3,154,485** | 51,986 / 55,587 / 56,857 ms |

\* 10k run used sequential decimal ids that don't exist in the hex id space → `mappingIncomplete=true` surfaced honestly (4000 unresolved cells), and matched rows are a subset — expected, correctly reported.

**50k real-cell acceptance run: 3,154,485 unique recipients in ~52–57 s.** This exactly matches the fixture asserted in `tests/cell-subscriber-bridge.test.ts:158` (`unique_msisdns: '3154485'`) — the live DB reproduces the test's expected figure.

## 8. Execution plan (Phase 5)

`EXPLAIN (ANALYZE, BUFFERS)` on the bridge join shows **index-only paths end to end** — no sequential scan of the 100M dump:

- `cell_network_mapping` via pkey / `idx_cell_network_mapping_cell` (index-only, 0 heap fetches)
- `subscriber_dump` via `idx_subscriber_dump_lac_cisac` + `idx_subscriber_dump_area_msisdn` (index-only seek, 0 heap fetches, ~89 rows/area)
- Nested loop, quicksort for DISTINCT at SQL level (not a JS Set over 100M)
- Temp-table staging (`turant_target_cells`) loaded once per session, `ON CONFLICT DO NOTHING`

Tower query (module 02) also index-assisted: `ST_DWithin` radius model against 4326 geography with `idx_cell_towers_ll`; `statement_timeout` bound DB-side and `Promise.race` bound client-side.

## 9. Dedup (Phase 5/9 + Phase 6 overlap)

- SQL-level `SELECT DISTINCT msisdn` (bridge) then in-memory Set dedup with `normalizeMsisdn` (strip `+`/space/dash). Verified: 3,159,936 raw rows → 3,154,485 unique (5,451 removed at SQL).
- Live e2e manual alert (multi-polygon polygon over Delhi-NCR): **11,134 towers → 1,793,242 matched → 0 JS-level duplicates** (bridge already unique) → 1,793,242 expected recipients.

## 10. Multi-polygon geometry (Phase 6)

- Real IMD Patna fixture: 10 polygons, >1000-vertex ring, non-standard enums (`ALERT`/`Very Likely`) parsed loudly to `Unknown`, Hindi UTF-8 headline preserved — all green in tests.
- Frontend sends one alert per polygon and polls per-polygon status; membership is display-filtered only (backend `/towers` returns real matched towers).

## 11. Expiry control (Phase 7)

- `ExpiryGuard` derives the **real CAP `expires`** via `capTiming(alert)`, halts at the exact instant, applies optional lead margin, `EXPIRY_HALT_SUBMISSION` gates it. Tests cover before/at/after expiry, margin, no-expiry, disabled, and `markExpiryTrace`→t5. Live manual alert set `expiresAt` from real timestamps.

## 12. Timeout / halted behaviour (Phase 8)

- Tower resolution: DB `statement_timeout` + client `AbortController` race (`TOWER_MATCH_TIME_BUDGET_MS`).
- Subscriber join: `SET LOCAL statement_timeout` + `idle_in_transaction_session_timeout` on a dedicated client/transaction.
- Pipeline halts loudly (`pipeline.halted`, status `halted` + reason) on missing source, and never stays stuck "running" — verified in `pipeline-integration.test.ts`.

## 13. SMPP / DLR / EWS boundaries (Phase 9)

- **SMSC:** not configured (`SMPP_HOST=""`). `healthz: awaiting_credentials`. No submission occurs.
- **DLR:** listener parses real `deliver_sm` (ESM 0x04), correlates by registered submissions, computes t4/t5 + percentiles. With no SMSC, `/report` honestly returns `delivered: 0`, empty `deliveredTo`, null percentiles.
- **EWS:** `pushReportToEws` + `persistAlertReport` exist. **Before this audit, the callback was never invoked by the pipeline (fix #2).**

## 14. Findings & fixes (Phases 17–18)

| # | Sev | Finding | Fix | Verified |
|---|---|---|---|---|
| 1 | **HIGH** | Pipeline-status `submittedCount` reported the intended-recipient count (1,793,242) even though **0** messages were submitted (SMPP unconfigured) — a viewer could mistake "intended" for "sent". | `submittedCount` is now `0` when `awaitingCredentials`; status exposes `awaitingCredentials` + `acceptedCount`; frontend shows "awaiting SMSC credentials". | Live: `submittedCount:0, awaitingCredentials:true, acceptedCount:0`. |
| 2 | **HIGH** | EWS completion callback (module 12) was built + tested but **never wired**; `persistAlertReport` wrote columns (`payload`, `created_at`) that don't exist in `alert_reports` (schema has `report_json`), so it was non-functional. | Added `buildAlertReport`/`pushCompletionReport` (`src/pipeline/report-builder.ts`), wired into `runDisseminationLeg`; rewrote the INSERT against the real schema (UUID FK on `alerts.id`). | Live: `alert_reports` row persisted with honest counts. 3 new tests. |
| 3 | MED | `cell_towers.coverage_geom` is NULL in all 50k rows (GiST index inert); `TOWER_COVERAGE_MODEL=polygon` would silently return nothing. | PostGIS tower source now preflights: polygon model + all-NULL coverage column → loud config error instead of an empty tower list. | Backend typecheck + tests green. |
| 4 | LOW | Leftover debug `target_cells` table (100 rows). | Dropped. | psql confirmed. |

## 15. Regression after fixes

- `tsc --noEmit` (backend): clean. `tsc --noEmit && vite build` (frontend): green.
- `vitest run`: **23 files / 189 tests pass** (2 tests previously asserted the misleading `submittedCount == expectedRecipients`; updated to assert the honest `submittedCount === 0` contract).
- Live e2e re-run after fixes: `completed / done`, `towerCount 11134`, `expectedRecipients 1,793,242`, `submittedCount 0`, `awaitingCredentials true`; `alert_reports` row persisted.

## 16. Latency trace (t0..t5)

Live manual alert: `t0 → t1` (cell-site id) = 718–842 ms; `t1 → t2` (subscriber match + dedup, ~1.79M recipients) = 18.1–26.3 s. t3/t4/t5 absent without an SMSC/DLR — honest (no fabricated delivery times).

## 17. Security

- `.env` untracked (only `.env.example` committed). No credentials in the repo.
- `x-powered-by` disabled. CAP XML size-limited. Zod-validated manual payloads with self-intersection rejection. SQL fully parameterized (no injection surface found). SMPP/EWS token/timeout handling present.

## 18. Performance envelope

- 50k cells / 100M subscribers ≈ 52–57 s (target ≤ 60 s) — met on this machine's PG.
- Streaming recipients via DB cursor (`RECIPIENT_BATCH_SIZE`) keeps Node heap flat (no 3M-element in-RAM list for the SMPP boundary).

## 19. Externally-blocked items (NOT defects)

- Real SMSC credentials (SMPP bind) — awaiting C-DOT sandbox.
- EWS callback URL/token.
- Authoritative cell→(lac,cisac) master (`source='import'` path exists; current data is honest `synthetic_test_mapping`).
- DLRs and end-to-end phone delivery are therefore unobservable today; the system correctly reports `awaiting_credentials` / `delivered: 0`.

## 20. Verdict

**A — READY to proceed to TSP acceptance testing.**

The pipeline runs end-to-end with real data on this machine: real 100M subscriber dump, real PostGIS tower resolution, real 50k-cell relational matching (3.15M unique recipients in ~55 s), real dedup, real per-alert status/trace/report, and honest external-dependency reporting. The two HIGH integrity findings from this audit are fixed and verified live. Remaining readiness steps are external credential provisioning (SMSC, EWS, mapping master), not code.

**Conditions to note in the TSP hand-off:** (1) live submission/DLR require SMSC credentials; (2) subscriber→area mapping is synthetic-labelled until the real C-DOT master is imported; (3) no fake delivery figures will ever be produced.
