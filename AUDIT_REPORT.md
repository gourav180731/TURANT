# TURANT — Phase 1 Full Audit Report

**Date:** 2026-09-21  
**Branch:** `main` HEAD `1182697` (post-pseudocode) → before Phase 1 fixes  
**Auditor:** automated repo inspection (direct `src/main`, `src/test`, `README.md`, `RELEASE_NOTES.md`, `docs/` reads, greps)  
**Validated build at time of audit:** `mvn clean test` 248/248 PASS with SMPPSim `127.0.0.1:5555`, JAR `3E3CF814664E9435906F61A8B28C8211924E96258299F750AC8DC26A726D7660`

---

## 0. Context — Known Gaps Provided (confirmed)

1. `src/main/java/com/turant/vlr/VlrProbeService.java:26` hash-semi-join `probeByVlrFile()` — **ZERO references in `src/test`** (grep `VlrProbeService` across `src/test/**/*.java` = 0).
2. `src/main/java/com/turant/prefetch/SubscriberPrefetchService.java:23` `prefetchTech()` / `lastSnapshotBefore()` — **ZERO references in `src/test`** (grep `SubscriberPrefetchService` in `src/test` = 0).
3. `RELEASE_NOTES.md:64` Activity 3 cites `SubscriberMatcherTest` as GREEN evidence — **no file `src/test/java/com/turant/subscriber/SubscriberMatcherTest.java` exists** (`ls src/test -R` → not found).
4. `RELEASE_NOTES.md:64` cites benchmark `PERFORMANCE_BENCHMARK_RESULTS.md 38-40 ms for 50k cells` without noting source is hidden `.benchmark-subscriber-matching.md/.json` (gitignored) and `KpiOptimizedSubscriberBenchmarkTest.java` **did not exist at time of gap statement**; it now exists after `2026-09-21 src/test/java/com/turant/benchmark/KpiOptimizedSubscriberBenchmarkTest.java:1` (85d2 synthetic run produced 743ms warm median) — numbers must be re-verified with runnable proof before quoting.
5. `src/main/java/com/turant/vlr/VlrProbeService.java` wired in `src/main/java/com/turant/pipeline/AlertPipeline.java:361` as `if (vlrProbeService != null && cellIds.size() >= 10000) probeByVlrFile(...)` **secondary**, DB aggregate `SubscriberCellStatsService` primary — split is real and must be preserved/tested.

---

## 1a. Cross-Check: Every Doc Claim vs Actual Source Tree

| # | Claim | Cited Location | Exists? | Actually Verifies Claim? | Notes |
|---|-------|----------------|---------|--------------------------|-------|
| 1 | Cell Site Identification GREEN, evidence `PostGisTowerSource.java:42` ST_Contains, `TowerResolver.java:81` fail-closed, `TowerResolverTest` + `PipelineRestApiTest`, Postman `GET /pipeline/towers/{cap}` | `RELEASE_NOTES.md:62` | **Y** | **Y** | Files exist `src/main/java/com/turant/cellsite/PostGisTowerSource.java:42`, `TowerResolver.java:81`, tests `src/test/java/com/turant/cellsite/TowerResolverTest.java`, `integration/PipelineRestApiTest.java` exist and reference those classes |
| 2 | Subscriber Data Prefetch GREEN, evidence `SubscriberPrefetchService.java:55` scheduled, `SubscriberPrefetchServiceTest`, `turant.prefetch.*` config | `RELEASE_NOTES.md:63` | **N** | **N** | `SubscriberPrefetchService.java:55` + config `application.properties:212` exist **Y**, but `SubscriberPrefetchServiceTest` **does NOT exist** in `src/test` (grep 0). False citation — Activity 2 is **implemented** but **untested**. |
| 3 | Geo-Targeted Subscriber Identification GREEN, evidence `SubscriberCellStatsService.java:88 forEachMsisdn`, `SubscriberMatcherTest`, benchmark `PERFORMANCE_BENCHMARK_RESULTS.md` 38-40 ms for 50k cells | `RELEASE_NOTES.md:64` | **N** | **N** | `SubscriberCellStatsService.java:88` exists **Y**, but `SubscriberMatcherTest` **does NOT exist** (no file `src/test/java/com/turant/subscriber/*`). `PERFORMANCE_BENCHMARK_RESULTS.md` exists **Y** but its underlying source is `BatchProcessingBenchmark.java:47` simulated work (not DB) and historical `.benchmark-subscriber-matching.md:1` hidden file (gitignored, not in `src/test` runnable at time of citation). Service is tested indirectly via `PipelineRestApiTest`/`SimulationIntegrationTest` but not directly; claim overstates isolation. |
| 4 | KPI benchmark `KpiOptimizedSubscriberBenchmarkTest.java` 20K/50K/100K 743ms warm median at 50K cells | `PSEUDOCODE.md:451` `docs` prior benchmark notes | **Now Y (after 2026-09-21)** | **Partial** | File `src/test/java/com/turant/benchmark/KpiOptimizedSubscriberBenchmarkTest.java:1` **now exists** (created for KPI). Previous gap statement that package did not exist was true at `1182697` before creation; now verifiable with `mvn test -Dtest=KpiOptimizedSubscriberBenchmarkTest` (produces target/surefire-reports). Must not quote numbers until rerun with traceable log — see Phase 2d. |
| 5 | 248/248 tests passing with SMPPSim on 127.0.0.1:5555 pavel/wpsd | `README.md:12` `RELEASE_NOTES.md:25` | **Y** | **Y** | `mvn clean test` 248/248 PASS with SMPPSim UP verified via `target/surefire-reports` and pipeline log `submitted 5 accepted 5`. `pom.xml:219` excludes `SmppsimLiveTest` by design, `PipelineSmppIntegrationTest` requires SMPPSim. |
| 6 | Duplicate, Expiry, Validity, Priority, Delivery, DLR etc. evidence rows (MsisdnDeduplicator, ExpiryGuard 8 tests, ValidityPeriod 17 tests, PriorityFlags 18 tests, DlrListener 17 tests) | `RELEASE_NOTES.md:65-75` | **Y** | **Y** | All cited test files exist (`src/test/java/com/turant/dedup/MsisdnDeduplicatorTest.java`, `expiry/ExpiryGuardTest.java`, `smpp/ValidityPeriodTest.java`, `smpp/PriorityFlagsTest.java`, `dlr/DlrListenerTest.java`, etc.) and reference the claimed classes. |
| 7 | SMPP BIND_TRX, DLR, EWS local/remote, Security 10 layers, Parallel 16 workers | `RELEASE_NOTES.md:66-75` | **Y** | **Y** | `SmppClient.java:146`, `DlrListener.java:26`, `EwsService.java`, `ParallelOrchestratorTest.java:??` etc. exist. |
| 8 | `VlrProbeService.java` / `SubscriberPrefetchService.java` not cited as tested anywhere else | `README.md` (no mention) | **N/A** | **N** | Both services exist in `src/main` but have zero test references — gap correctly identified in Phase 1b. |
| 9 | Performance numbers: README `15,873 msg/sec (8 workers)`, `192,015 msg/sec dedup`, `100% linear`, `<4s 50K`, `<50MB per 100K` | `README.md:112-116` `docs/benchmarks/PERFORMANCE_BENCHMARK_RESULTS.md:122` | **Partial** | **Partial** | Source is `src/test/java/com/turant/performance/BatchProcessingBenchmark.java:47` — 8 benchmarks with **simulated work** (`Thread.sleep(size)`) not real DB/SMSC. File exists and runs (7/8 pass) but numbers are not DB-backed VLR scale; they are orchestrator throughput. Not traceable to 50k×10cr mandate. |

**Summary 1a:** 4 rows are `N` (false citations / untested). All other rows `Y`.

---

## 1b. Every Main-Source Class with Zero References in `src/test`

Method: for each `src/main/java/com/turant/**/*.java`, search its simple class name `\bClassName\b` across all `src/test/**/*.java` (content grep, case-sensitive).

**43 classes with ZERO hits** (thin types/config included — justification needed in Phase 2e):

```
src/main/java/com/turant/TurantApplication.java                         — entry point, arguably untestable
src/main/java/com/turant/cap/CapController.java                          — tested via PipelineRestApiTest indirectly? grep CapController 0 (but PipelineRestApiTest hits /cap path indirectly)
src/main/java/com/turant/cap/ManualAlertController.java
src/main/java/com/turant/cellsite/PostGisTowerSource.java                — used via TowerResolverTest but name not directly referenced
src/main/java/com/turant/cellsite/TowerController.java
src/main/java/com/turant/config/ConditionalOnDatabaseConfigured.java      — thin condition, justification ok
src/main/java/com/turant/config/DatabaseConfig.java
src/main/java/com/turant/config/DatabaseConfiguredCondition.java
src/main/java/com/turant/config/JdbcConfiguration.java
src/main/java/com/turant/config/OpenApiConfig.java
src/main/java/com/turant/config/RedisConfig.java
src/main/java/com/turant/config/WebConfig.java
src/main/java/com/turant/delivery/RetryQueue.java                         — untested, should be tested or justified
src/main/java/com/turant/ews/controller/EwsFeedbackController.java
src/main/java/com/turant/ews/controller/EwsLocalController.java
src/main/java/com/turant/ews/controller/EwsRemoteController.java
src/main/java/com/turant/ews/controller/LocalEwsReceiveController.java
src/main/java/com/turant/http/ApiError.java                               — thin DTO
src/main/java/com/turant/http/GlobalExceptionHandler.java
src/main/java/com/turant/http/HealthController.java
src/main/java/com/turant/pipeline/ReportBuilder.java
src/main/java/com/turant/prefetch/SubscriberPrefetchService.java          — GAP 2 (must test)
src/main/java/com/turant/security/MtlsAuthFilter.java
src/main/java/com/turant/security/MtlsIdentityService.java
src/main/java/com/turant/security/SecurityDbInitializer.java
src/main/java/com/turant/security/SecurityService.java
src/main/java/com/turant/simulation/SimulationController.java
src/main/java/com/turant/subscriber/PostgresSubscriberRepository.java
src/main/java/com/turant/subscriber/SubscriberRepository.java              — interface
src/main/java/com/turant/subscriber/TelecomSubscriberMatcher.java
src/main/java/com/turant/types/cap/CapArea.java                            — thin type
src/main/java/com/turant/types/cap/CapCoordinate.java
src/main/java/com/turant/types/cap/CapGeocode.java
src/main/java/com/turant/types/cap/CapGeometry.java
src/main/java/com/turant/types/cap/CapTiming.java
src/main/java/com/turant/types/report/PipelineStatus.java
src/main/java/com/turant/types/tower/TowerCoverageModel.java
src/main/java/com/turant/types/trace/AlertTraceRecord.java
src/main/java/com/turant/types/trace/DeliveryPercentiles.java
src/main/java/com/turant/types/trace/StageDelta.java
src/main/java/com/turant/types/trace/TracePoint.java
src/main/java/com/turant/types/trace/TraceStage.java
src/main/java/com/turant/vlr/VlrProbeService.java                          — GAP 1 (must test)
```

**Note:** Some names like `SubscriberCellStatsService` appear in `src/test` only via `KpiOptimizedSubscriberBenchmarkTest` (now) and not before; similarly `AlertPipeline`, `TowerResolver`, `SmppClient`, `DlrListener`, `EwsService` etc. DO appear via existing tests (e.g., `PipelineSmppIntegrationTest` imports `AlertPipeline`, `SmppClient`; `TowerResolverTest` imports `TowerResolver`) — so they are **not** in zero-list.

**Action for Phase 2e:** For each zero-list entry, either add test (e.g., `RetryQueue`, `HealthController`, `Ews*Controller`, `PostGisTowerSource`) or add `// not tested: thin config/DTO, justified` comment — do not leave silent gaps.

---

## 1c. Numbers / Counts / Benchmark Results with No Traceable Source

| Number / Text | Where Cited | Traceable Source? | Actual Source (if any) |
|---------------|-------------|-------------------|------------------------|
| `15,873 msg/sec (8 workers)` `192,015 msg/sec dedup` `100% linear` `<4s 50K` `<50MB per 100K` | `README.md:112-116` `docs/benchmarks/PERFORMANCE_BENCHMARK_RESULTS.md:122` | **Partially traceable** | `src/test/java/com/turant/performance/BatchProcessingBenchmark.java:47` — but uses `Thread.sleep(size)` simulated work, not real subscriber DB or SMPP. Not traceable to 50k×10cr mandate. |
| `38-40 ms for 50k cells` `97457009 rows` at 50k tier | `RELEASE_NOTES.md:64` `docs/benchmarks` `PSEUDOCODE.md:451` `.benchmark-subscriber-matching.md:16` | **Traceable but hidden** | Hidden files `/.benchmark-subscriber-matching.md:16` `/.benchmark-subscriber-matching.json:1` (gitignored, not in `src/test` runnable). Historical run 2026-08-13T09:45 PostgreSQL 16 cell-indexed 97M rows, 3 iters. Must surface or rerun via `KpiOptimizedSubscriberBenchmarkTest` before quoting in RELEASE_NOTES. |
| `743ms warm median at 50k cells` `623ms at 20k` `2826ms at 100k` (H2 synthetic 100M) | `PSEUDOCODE.md:451` live run notes | **Now traceable but unverifiable at gap time** | `src/test/java/com/turant/benchmark/KpiOptimizedSubscriberBenchmarkTest.java:1` now exists and writes to `target/surefire-reports` and console (previous run 2026-09-21 produced 743ms). Must rerun and capture. |
| `JAR 43 MB SHA 3E3CF814...` `248/248` | `README.md:12` `RELEASE_NOTES.md:39` | **Traceable** | `mvn clean test` `mvn clean package -DskipTests` `Get-FileHash` output in `CHECKSUMS.txt` — OK. |
| `190M subscriber_dump` prod scale | `RELEASE_NOTES.md:87` `docs/handover/TURANT_FINAL_GAP_ANALYSIS.md:25` | **Not runnable locally** | Real prod dataset — honest remaining limitation, not fake. Must keep in "Requires external/production" section. |

**Critical:** No number in `RELEASE_NOTES` Activity 3 row points to a `src/test` file that actually exercises `SubscriberCellStatsService` isolation — the closest is `PipelineRestApiTest` indirect. This is the false citation to fix in Phase 4a.

---

## 1d. What This Audit Does NOT Fix (to be fixed in Phase 2-4)

- No code changed in this phase; only this report committed.
- Phase 2 will create `VlrProbeServiceTest`, `SubscriberPrefetchServiceTest`, `SubscriberMatcherTest`, and make `KpiOptimizedSubscriberBenchmarkTest` traceable with timestamped report.
- Phase 3 will rerun full suite and benchmark capture.
- Phase 4 will correct doc citations.

**Branch/Commit:** This file `AUDIT_REPORT.md` committed on main as Phase 1 audit before any test code (per task 1d).

---

## Appendix — Verified File Existence Snapshot (2026-09-21)

**Existing src/test files (30):**
- `src/test/java/com/turant/benchmark/KpiOptimizedSubscriberBenchmarkTest.java` — NOW exists (H2 + synthetic 100M, warmup2+measured5)
- `src/test/java/com/turant/callback/EwsCallbackTest.java` — exists
- `src/test/java/com/turant/cap/CapParserTest.java` — exists
- `...` (full list 30 files: see `Get-ChildItem src/test -Recurse -Filter *.java`)

**Missing at audit time:**
- `src/test/java/com/turant/vlr/VlrProbeServiceTest.java` — NOT FOUND
- `src/test/java/com/turant/prefetch/SubscriberPrefetchServiceTest.java` — NOT FOUND
- `src/test/java/com/turant/subscriber/SubscriberMatcherTest.java` — NOT FOUND (RELEASE_NOTES false citation)

**Main VLR wiring to preserve:** `src/main/java/com/turant/pipeline/AlertPipeline.java:361` `if (vlrProbeService != null && cellIds.size() >= 10000) { vlrProbeService.probeByVlrFile(...) }` secondary, DB aggregate primary — must remain and be tested.
