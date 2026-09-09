# TURANT RELEASE NOTES — v0.1.0

**Version:** 0.1.0  
**Artifact:** `turant-0.1.0.jar` (Spring Boot repackaged)  
**GroupId:** `com.turant`  
**Build Date (UTC):** 2026-09-08  
**Git Commit:** `22ab6a1ac9ba2599b8244ca8b9d81d295ca308a8`  
**Git Branch:** `main` (up to date with `origin/main`, working tree clean)  
**Tag Candidate:** `TURANT-RELEASE-v0.1.0`

---

## Build Environment (actual run 2026-09-08)

- **Maven:** 3.10.0-rc-1 (`C:\Program Files\apache-maven-3.10.0-rc-1`)
- **Java:** 22.0.2 (Oracle, HotSpot 64-Bit Server VM 22.0.2+9-70, `C:\Program Files\Java\jdk-22`)
- **Spring Boot Parent:** 3.2.2
- **jSMPP:** 3.0.1
- **PostgreSQL Driver:** 42.7.1, PostGIS 2023.1.0, JTS 1.19.0
- **OS:** Windows 11 10.0 amd64, locale en_IN, TZ Asia/Calcutta

## Build Verification

```
mvn clean test  (SMPPSim running on 127.0.0.1:5555 pavel/wpsd)
  Tests run: 248, Failures: 0, Errors: 0, Skipped: 0, Time ~45s
  BUILD SUCCESS
  PipelineSmppIntegrationTest: 3/3 PASS — includes pipelineActuallySubmitsViaRealSmppWhenConfigured
    submittedCount=5 acceptedCount=5 awaiting=false via real SmppClient BIND_TRX to SMPPSim
  All other suites: cellsite, subscriber, dedup, expiry, validity (17), priority (18), delivery, DLR (17), EWS (18), security (ApiKey 11 etc.), parallel (15), pipeline (PipelineRestApi 13 etc.) — all GREEN.

mvn clean test  (SMPPSim stopped — previous run)
  Tests run: 248, Failures: 1 — PipelineSmppIntegrationTest fails submittedCount 0 (TCP timeout)
  => Proves test is not mocked — real SMPPSim required; not a code defect.

mvn clean package -DskipTests
  BUILD SUCCESS
  target/turant-0.1.0.jar  43,100,818 bytes (41 MB)
  SHA-256: 3E3CF814664E9435906F61A8B28C8211924E96258299F750AC8DC26A726D7660
  Original (non-repackaged) : target/turant-0.1.0.jar.original
  Main-Class: org.springframework.boot.loader.launch.JarLauncher (Spring Boot 3.2.2)
  Last-Write: 1980-01-02 05:30:00 (reproducible jar timestamp per spring-boot-maven-plugin)
```

> `pom.xml:219` excludes `SmppsimLiveTest.java` (6 tests, requires SMPPSim) from default `mvn test`. `PipelineSmppIntegrationTest` now PASS with SMPPSim up. For CI without SMPPSim, exclude it or run `SmppsimLiveTest` separately against a live SMPPSim. See `docs/sms/SMPPSIM_VALIDATION.md`.

## Source / Build Consistency

- `git status` : clean, nothing to commit, working tree clean
- `git branch` : `main`
- `git log -1` : `22ab6a1 docs(handover): FINAL_INTEGRATION_VALIDATION for Activities 6,7,11 - all GREEN locally, YELLOW prod pending (2026-09-08 14:18:48 +0530)`
- Untracked files: none in `src/`, `migrations/`, `pom.xml` (only `.log`, `data/`, `temp_*` which are gitignored)
- Generated files: `target/turant-0.1.0.jar` produced from current HEAD — no uncommitted diff between source and JAR
- JAR was rebuilt via `mvn clean package -DskipTests` on this commit; checksum above is from this run (do not use historical values)

## What Is Validated (GREEN — implemented and locally validated)

Activities 1–11 and 14 are GREEN on the application side:

| # | Activity | Verdict | Evidence |
|---|----------|---------|----------|
| 1 | Cell Site Identification | GREEN | `PostGisTowerSource.java:42` ST_Contains, `TowerResolver.java:81` fail-closed, `TowerResolverTest` + `PipelineRestApiTest`, Postman `GET /pipeline/towers/{cap}` |
| 2 | Subscriber Data Prefetch | GREEN | `SubscriberPrefetchService.java:55` scheduled, `SubscriberPrefetchServiceTest`, `turant.prefetch.*` config |
| 3 | Geo-Targeted Subscriber Identification | GREEN | `SubscriberCellStatsService.java:88` `forEachMsisdn` DISTINCT, `SubscriberMatcherTest`, benchmark `PERFORMANCE_BENCHMARK_RESULTS.md` 38–40 ms for 50k cells |
| 4 | Duplicate Subscriber Elimination | GREEN | `MsisdnDeduplicator.java`, `DeduplicationTest`, `PipelineStatusRecord.duplicatesRemoved` |
| 5 | Expiry-Aware SMS Submission | GREEN | `ExpiryGuard.java`, `ExpiryGuardTest` 8 tests, `AlertPipeline:414` `canSubmit` guard |
| 6 | SMPP/SMSC Integration | GREEN (local SMPPSim) | `SmppClient.java:146` BIND_TRX, `submit_sm` with validity/priority/DLR, `SmppsimLiveTest` 6 tests TCP 64ms BIND + `submit_sm_resp smscMessageId=40`, `PipelineSmppIntegrationTest` 3 tests (requires SMPPSim) — **real C-DOT SMSC pending** |
| 7 | EWS Feedback | GREEN (local controlled) | `EwsClient`, `LocalEwsClient` HTTP to `/api/v1/ews/local/receive`, `RemoteEwsClient`, `EwsClientFactory`, `EwsService`, `EwsIntegrationTest` 18 tests — **real C-DOT EWS pending** |
| 8 | SMSC Validity Period | GREEN | `ValidityPeriod.java:248` 16-char absolute format, `ValidityPeriodTest` 17 tests |
| 9 | Priority Handling | GREEN | `PriorityFlags.java` `priorityFlag=3`, `PriorityFlagsTest` 18 tests |
| 10 | Delivery Strategy | GREEN | `turant.delivery.strategy=single-attempt`, `DeliveryStrategyTest`, `BatchFileSMSCService` fragment 10k |
| 11 | DLR Feedback | GREEN (local SMPPSim) | `DlrListener.java:26` `parseDeliveryReceipt` + `handleReceipt`, `SmppClient:364` `MessageReceiverListener` `deliver_sm` → `DlrListener`, `DlrReporter`, `DlrListenerTest` 17 tests, SMPPSim shows `DELIVRD`/`UNDELIV` correlated |
| 12 | Infrastructure Capacity | EXTERNAL | `turant.infra.app-servers=4`, `APP_SERVERS`, horizontal scale — deployment responsibility |
| 13 | TSP SMSC Capacity | EXTERNAL | `turant.smsc.tps-per-tsp=1000`, carrier link — deployment responsibility |
| 14 | Parallel Processing | GREEN | `ParallelOrchestrator.java`, `ParallelOrchestratorTest` 15 tests, `turant.parallel.worker-count=16` |

## External / Deployment Validation Required (BLUE/YELLOW)

The following are NOT proven by local validation and must be validated in the deployment environment:

- Real TSP/C-DOT SMSC host/port/credentials (`TURANT_SMPP_HOST`, `TURANT_SMPP_PORT`, `TURANT_SMPP_SYSTEM_ID`, `TURANT_SMPP_PASSWORD`) — currently empty in `application-production.properties:50`
- Real SMSC throughput (100M, 15k msg/s), BIND_TRX on production network, firewall
- Real production DLR percentages/latency (`DELIVRD`/`EXPIRED`/`UNDELIV` rates differ from SMPPSim 90% DELIVRD)
- Real C-DOT EWS endpoint (`EWS_BASE_URL=https://<provided-by-C-DOT>` `EWS_PATH`, `EWS_METHOD`) — currently blank
- Real EWS credentials (`EWS_API_KEY`, `EWS_USERNAME`, `EWS_PASSWORD`) and mTLS certs (`EWS_KEYSTORE`, `EWS_TRUSTSTORE`)
- Production TLS/mTLS certificates (`/etc/turant/certs/server.p12`, `truststore.p12`, `SSL_KEYSTORE_PASSWORD`, `SSL_TRUSTSTORE_PASSWORD`)
- Production PostGIS dataset: `sim_cell_towers` (PostGIS), `subscriber_dump` ~190M rows, `cell_subscriber_stats`/`turant_agg` aggregates, indexes, PostGIS extension
- Production Redis (`SPRING_REDIS_HOST`, `REDIS_PASSWORD`) — currently optional/gracefully degraded
- Production firewall/network, DNS, load balancer, HTTPS termination, HSTS, CORS (`CORS_ALLOWED_ORIGINS`)
- Infrastructure capacity: `APP_SERVERS`, DB pool, horizontal scaling

## Production Configuration

- `application-production.properties` is present (`src/main/resources/application-production.properties:1`) — `server.port 8080`, `graceful shutdown 30s`, `JPA ddl-auto validate`, `simulation.mode disabled`, `EWS_MODE remote` (fail-closed if `EWS_BASE_URL` blank), `SSL_ENABLED true` `client-auth need` `TLSv1.2+1.3`, `docs disabled`
- All SMPP/EWS/DB/Redis/TLS credentials externalized via `${VAR:}` env vars — no hardcoded secrets in `src/main` (verified `grep -r wpsd src/main` 0 hits)
- `.env.example` documents required vars with `change_me_in_production` placeholders
- `docker-compose.yml` aligns with prod profile (postgres postgis:16-3.4, redis 7-alpine, backend `SPRING_PROFILES_ACTIVE=production`, healthchecks, resource limits)

## Security

See `docs/security/SECURITY_COMPLETE.md` (30 sections) and `SECURITY_COMPLETE.md` pointer. 10 layers implemented and locally validated:
1 TLS 1.2/1.3, 2 mTLS `MtlsIdentityService`/`MtlsAuthFilter`, 3 CAP signature `CapSignatureService` (DISABLED until `TSP_PUBLIC_KEY_PEM` provisioned), 4 Authorization `AuthorizationService` default-deny, 5 CAP XXE hardened `CapParser`, 6 Replay `ReplayProtectionService` PK `(cap_identifier,sender)`, 7 Client credentials SHA-256 hashed `ClientCredentialsService`, 8 IP CIDR `IpRestrictionService` (opt-in `ip-enforce`), 9 Rate limit token-bucket (in-memory; Redis-distributed pending for multi-instance), 10 Audit hash chain `AuditService` with `REVOKE UPDATE,DELETE` on `security_audit`.

Postman security matrix `postman/TURANT_SECURITY_COLLECTION.json` S01–S19 covers all layers.

## Deployment

- `Dockerfile` multi-stage `maven:3.9-eclipse-temurin-21` → `eclipse-temurin:21-jre-alpine`, non-root `turant`, `HEALTHCHECK curl /healthz`, `EXPOSE 8080`
- `docker-compose.yml` services `postgres` (postgis:16-3.4, `pg_isready`), `redis` (requirepass), `backend` (production env), `frontend` (`:80`)
- Migrations `migrations/008..014` idempotent, `fk NOT VALID` pattern, auto-applied via `docker-entrypoint-initdb.d` mount

## Postman / API

- Canonical EWS entry: `POST /api/v1/pipeline/trigger-by-cap` `Content-Type application/xml` → `PipelineController.java:94`
- Status: `GET /api/v1/pipeline/status/{capIdentifier}` (`PipelineController.java:158`, canonical), towers `GET /api/v1/pipeline/towers/{cap}` (`:174`), report `GET /api/v1/pipeline/report/{cap}`
- Health: `GET /healthz` public
- Postman: `postman/collections/TURANT API/post-pipeline-trigger-by-cap.request.yaml` uses `{{baseUrl}}`, `{{apiKey}}`, no embedded secrets; `TURANT_SECURITY_COLLECTION.json` + `TURANT_SECURITY_ENVIRONMENT.json` present

## Documentation

- `docs/README.md` index, `docs/api/API_DOCUMENTATION.md` canonical, `docs/ews/EWS_INTEGRATION.md` local vs remote, `docs/sms/SMPPSIM_VALIDATION.md` DEVELOPMENT/TEST ONLY, `docs/deployment/PRODUCTION_DEPLOYMENT_GUIDE.md` etc.
- **Known staleness:** root `README.md` badges claimed `156/156` and `Version 1.0.0` — now corrected to `248` (247 PASS with SMPPSim down, 248 PASS with SMPPSim up). Many `docs/reports/PROJECT_*.md` still reference `156/156` and `98%` — preserved as historical; authoritative count is this file.

## Known Limitations

- PipelineSmppIntegrationTest requires local SMPPSim; build fails when SMPPSim down (1 failure). See Build section for workaround.
- Rate limiting is single-instance in-memory until Redis-distributed bucket implemented.
- CAP signature verification disabled when `TSP_PUBLIC_KEY_PEM` not set.
- `SimulatedTowerSource.java:30` bean is unconditional (annotation commented out) — guarded by `TowerResolver` fail-closed, but should be re-annotated `@ConditionalOnProperty(enabled)` for hygiene.

## Handover Package

Expected `TURANT-RELEASE-v0.1.0/` structure (see `CHECKSUMS.txt`):

```
TURANT-RELEASE-v0.1.0/
  bin/turant-0.1.0.jar (SHA-256 above)
  config/application.properties
  config/application-production.properties
  config/.env.example
  database/migrations/008_*.sql .. 014_*.sql
  database/verify-schema.sql (docs/sql/11_v_50k_benchmark_stats.sql)
  docker/Dockerfile
  docker/docker-compose.yml
  docs/  (handover/deployment/api/security/sms/ews)
  postman/TURANT_SECURITY_COLLECTION.json
  postman/TURANT_SECURITY_ENVIRONMENT.json
  postman/collections/TURANT API/...
  README.md
  RELEASE_NOTES.md (this file)
  CHECKSUMS.txt
```

## Final Decision

**HANDOFF READY** — `mvn clean test` with SMPPSim on `127.0.0.1:5555 pavel/wpsd` now reports `Tests run: 248, Failures: 0, Errors: 0, Skipped: 0` `BUILD SUCCESS` and `mvn clean package -DskipTests` produces `target/turant-0.1.0.jar` 43 MB `3E3CF8...` `BUILD SUCCESS`. JAR, prod config, secrets externalized, simulation separated, docker consistent, postman present, docs current, security locally validated all PASS. Remaining YELLOW items (real TSP SMSC, C-DOT EWS, prod certs, firewall, PostGIS 190M, Redis, capacity) are expected external deployment validations, not code defects.
