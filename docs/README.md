# TURANT Documentation — Organized Index

> All `.md` files have been **moved (not edited)** into category folders inside `docs/` for easy discovery. Root now contains only `README.md` and `README_JAVA.md` (GitHub entry) plus hidden `.benchmark` files (gitignored). Use this index to find what you need without scrolling the root.

---

## 1. API — `docs/api/`

| File | Purpose |
|---|---|
| `API_DOCUMENTATION.md` | **Single source of truth** — canonical EWS `POST /api/v1/pipeline/trigger-by-cap` (application/xml ≤20 MB), `GET /api/v1/pipeline/status/{cap}`, `GET /api/v1/pipeline/towers/{cap}`, `GET /healthz`, error contract `ApiError`, OpenAPI `/api-docs` |
| `API_EXPOSURE_COMPLETE.md` | Item #1 completion report — endpoint table, Java `PipelineController.java:94`, Postman, curl, tests `179/179` |
| `ENDPOINTS_FIXED.md` | Endpoint fix log |
| `WORKING_ENDPOINT.md` | Working endpoint proof |
| `test-endpoints.md` | Manual endpoint test notes |
| `architecture.md` | System architecture (Spring Boot + PostGIS + SMPP) |

---

## 2. Security — `docs/security/`

| File | Purpose |
|---|---|
| `SECURITY_COMPLETE.md` | Item #2 — ApiKey `X-API-KEY` (`EWS_API_KEY` env), `ApiKeyAuthFilter.java`, `CORS`, `security headers`, `CapParser` XXE hardening, tests `401/200`, live `curl -i` evidence |

---

## 3. Audit & Data Integrity — `docs/audit/`

| File | Purpose |
|---|---|
| `AUDIT_REPORT.md` | Full audit |
| `AUDIT_FIXES_COMPLETE.md` | Fixes applied |
| `AUDIT_TSP-READINESS-2026-08-11.md` | TSP readiness 2026-08-11 |
| `DATA_INTEGRITY_REPORT.md` | `191M` rows `subscriber_dump` integrity, `100M` Delhi, `0` orphans |
| `DATA_MODEL_AUDIT.md` | Data model audit |
| `TSP_READINESS_REPORT.md`, `TSP_FINAL_READINESS_REPORT.md`, `TSP_PRESENTATION.md` | TSP packs |
| `ANY_STATE_PROOF.md` | Any-state proof |
| `README_AUDIT.md` | Audit readme |

---

## 4. Testing — `docs/testing/`

| File | Purpose |
|---|---|
| `TESTING_GUIDE.md` | Testing guide |
| `POSTMAN_TESTING_GUIDE.md` | Postman (uses `{{baseUrl}}` `{{capIdentifier}}` `{{apiKey}}`) |
| `PRODUCTION_TESTING_GUIDE.md` | Prod testing |
| `QUICK_TESTING_CHEATSHEET.md` | Cheatsheet |
| `TEST_DELHI_ALERT.md` | Delhi alert test |
| `TEST_FIXES_NEEDED.md` | Fixes needed |
| `TEST_SUCCESS_SUMMARY.md` | Success summary |
| `FINAL_TESTING_SUMMARY.md` | Final testing |
| `BRUTE_FORCE_VALIDATION.md` | Brute-force validation |
| `.benchmark-*.md`, `.telecom-data-validation.md` (hidden, gitignored) | Benchmark/telecom validation (root `.` files) |

---

## 5. Deployment — `docs/deployment/`

| File | Purpose |
|---|---|
| `DEPLOYMENT.md` | Deployment |
| `DEPLOYMENT_COMPLETE.md` | Deployment complete |
| `PRODUCTION_DEPLOYMENT_GUIDE.md` | Prod deploy |
| `FRONTEND_INTEGRATION_COMPLETE.md` | Frontend integration |
| `MIGRATION_REPORT.md`, `MIGRATION_STATUS.md`, `COMPLETE_MIGRATION_GUIDE.md` | Migrations |

---

## 6. Guides — `docs/guides/`

| File | Purpose |
|---|---|
| `QUICKSTART.md` | Quickstart |
| `START_HERE.md` | Start here |
| `DEMO_QUICK_REFERENCE.md` | Demo ref |
| `INTEGRATION_REQUIREMENTS.md` | Integration |
| `telecom-simulation.md` | Telecom simulation |
| `SUBSCRIBER_GENERATION.md` | Subscriber generation |
| `ROLLBACK_PROCEDURE.md` | Rollback |
| `MATCHING_ALGORITHM.md` | Matching algorithm |
| `REPORT-08-item-optimization.md` | 08 optimization |
| `QUICK_STATUS.md` | Quick status |
| `PUSH_COMPLETE.md` | Push complete |

---

## 7. Fixes — `docs/fixes/`

| File | Purpose |
|---|---|
| `FIX_CAP_XML_TO_POSTGIS.md` | CAP → PostGIS fix |
| `FIX_COMPLETE.md` | Fix complete |
| `FIXES_APPLIED.md` | Fixes applied |
| `LANGUAGE_FIX_COMPLETE.md` | Language fix |
| `SIMULATION_MODE_FIX.md`, `SIMULATION_MODE_TESTING.md` | Simulation mode |
| `TASK_9_COMPLETE.md` | Task 9 |

---

## 8. Benchmarks — `docs/benchmarks/`

| File | Purpose |
|---|---|
| `BENCHMARK_REPORT.md` | Benchmark report (`50k` cell) |
| `PERFORMANCE_BENCHMARK_RESULTS.md` | Perf results `15k msg/sec` |
| `.explain-*.md` (hidden) | Explain analyze |

---

## 9. Sessions — `docs/sessions/`

| File | Purpose |
|---|---|
| `CONTEXT_TRANSFER_COMPLETE.md` | Context transfer |
| `CURRENT_PROGRESS_SUMMARY.md`, `CURRENT_SESSION_COMPLETE.md`, `CURRENT_SESSION_PROGRESS.md` | Current session |
| `NEW_SESSION_SUMMARY.md` | New session |
| `SESSION_COMPLETE.md`, `SESSION_COMPLETE_SUMMARY.md`, `SESSION_FINAL_COMPLETE.md`, `SESSION_FINAL_SUMMARY.md`, `SESSION_HANDOFF_NOTES.md`, `SESSION_SUMMARY.md` | Sessions |
| `TODAY_SESSION_SUMMARY.md` | Today |
| `PROGRESS_UPDATE.md` | Progress |

---

## 10. Reports — `docs/reports/`

| File | Purpose |
|---|---|
| `FINAL_100_PERCENT_COMPLETION.md`, `FINAL_COMPLETE_100_PERCENT.md`, `FINAL_DELIVERY_SUMMARY.md`, `FINAL_PROJECT_STATUS.md`, `FINAL_SESSION_COMPLETE.md`, `FINAL_SESSION_PROGRESS.md`, `FINAL_SESSION_STATUS.md` | Final reports |
| `PROJECT_98_PERCENT_COMPLETE.md`, `PROJECT_COMPLETION_SUMMARY.md`, `PROJECT_HANDOFF.md` | Project |
| `VERIFICATION_REPORT.md` | Verification |

---

## 11. Other

| Path | Notes |
|---|---|
| `docs/sql/` | SQL evidence views `01-11` |
| `postman/` | Collections use `{{baseUrl}}` `{{capIdentifier}}` `{{apiKey}}` |
| `README.md`, `README_JAVA.md` (root) | Kept at root for GitHub |
| `.benchmark-*.md`, `.telecom-*.md` (root `.*.md`) | Hidden, gitignored, not moved |

**How to find:** `docs/<category>/<file>.md` — all moves were `git mv` (history preserved, content unchanged).
