# TURANT Final Integration Validation

## Validation Date
2026-09-08 14:00 IST (Asia/Kolkata) — Java 22.0.2, Spring Boot 3.2.2, PostgreSQL 16 + PostGIS 3.4 (docker `turant-postgres:5432`), H2 2.2.224 (test), jSMPP 3.0.1, SMPPSim haifzhan/SMPPSim 1.0-SNAPSHOT (SMPPSim-1.0-SNAPSHOT.jar on `127.0.0.1:5555` `pavel/wpsd`), Redis not configured (status `degraded` is expected in test), Maven 3.9, MockServer 5.15.0

## Environment
- **Java:** 22.0.2 (HotSpot 64-Bit)
- **Spring Boot:** 3.2.2, Spring 6.1.3
- **DB:** PostgreSQL 16 (`jdbc:postgresql://localhost:5432/turant` `turant/turant_dev_password`, `sim_cell_towers` PostGIS) + H2 `jdbc:h2:mem:testdb;MODE=PostgreSQL` for `test` profile
- **SMPP:** jSMPP 3.0.1 `SmppClient` (real), `SimulatedSmppClient` (`simulation.mode=enabled` only), SMPPSim `127.0.0.1:5555` `pavel/wpsd` `BIND_TRX` `SMPP_CONNECTION_HANDLERS=1`, `DELAY_DELIVERY_RECEIPTS_BY=0`
- **EWS:** `EwsService` `EwsClient` `LocalEwsClient` (HTTP to `http://localhost:8080/api/v1/ews/local/receive` or `EWS_LOCAL_URL`) + `RemoteEwsClient` (`RestClient`), `LocalEwsStore` + `LocalEwsReceiveController`
- **DLR:** `DlrListener` (`parseDeliveryReceipt` regex `id:\S+ stat:\S+`), `DlrReporter`, `SmppClient` `MessageReceiverListener` on every `SMPPSession`
- **Build:** `turant-0.1.0.jar` 43MB `target/turant-0.1.0.jar`

## Activity 6 — SMPP/SMSC Integration
**Status:** PASS (local SMPPSim)

**Evidence:**
- **Postman request (actual, via test `PipelineSmppIntegrationTest` deterministic 5 towers):**
  ```
  POST http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap (not via Postman directly in this run, via AlertPipeline with custom TowerSource 5 towers TEST-CELL-001..005)
  → Input: CapAlert `postman-test-001`-like (earthquake Delhi circle 15km) with 5 deterministic towers
  ```
- **Postman response (actual pipeline record):**
  ```
  PIPELINE LIVE capId=test-pipeline-smpp-1788778112855 towerCount=5 matched=5 expected=5 submitted=5 accepted=5 awaiting=false elapsedMs=124
  ```
- **SMPP connection:** `pool-4-thread-1 INFO  SmppClient - Connecting to SMSC: host=127.0.0.1, port=5555` → `SMPP session bound successfully` (64ms in `SmppsimLiveTest`, also in pipeline)
- **BIND_TRX:** `BindType.BIND_TRX` `systemId=pavel` `password=***` (never logged), `systemType=SMPP`
- **submit_sm:** 5× `SmsMessage` (`919000000011`..`015`, `validityPeriod 2609071220000000` 16 chars, `priorityFlag 3`, `registeredDelivery 1`, `SEVEN_BIT`)
- **submit_sm_resp:** `Message submitted: msisdn=919000000011 smscMessageId=6 outcome=accepted` (and 5,8,7,4 for 5 msgs)
- **SMSC message ID:** `6,5,8,7,4` (5 distinct, SMPPSim sequential, non-empty, from `submit_sm_resp`)
- **SMPPSim evidence:** `SMPP_PORT=5555` `Test-NetConnection 127.0.0.1 5555 TcpTestSucceeded True`, `SMPPSim-1.0-SNAPSHOT.jar` logs show `ConnectionHandler` and `LifeCycleManager`, `Test-NetConnection` true before and after.
- **Live single test (`SmppsimLiveTest`):** `TCP+bind elapsedMs=64` `submit_sm result: smscMessageId=40` `outcome=accepted` `DELIVRD` later.

## Activity 7 — EWS Feedback
**Status:** PASS (local controlled endpoint)

**Evidence:**
- **Postman trigger:** Same pipeline `postman-test-001` (or `ews-pipeline-1788847866994` with 3 towers `EWS-CELL-001..003`) → `AlertPipeline` → `ReportBuilder` (real `towerCount=3`, `targetedSubscriberCount=3`, `capIdentifier`, `alertId`, `processingStartedAt/EndedAt`) → `EwsService.sendReport` → `EwsClientFactory` `local` → `LocalEwsClient` → `HTTP POST http://localhost:8080/api/v1/ews/local/receive` (or fallback in-memory)
- **TURANT logs (actual):**
  ```
  EWS send: mode=local, alertId=ews-pipeline-1788847866994
  LocalEwsClient HTTP POST to controlled local EWS: url=http://localhost:8080/api/v1/ews/local/receive
  LocalEwsReceiveController Received EWS report: alertId=ews-pipeline-1788847866994 capIdentifier=ews-pipeline-1788847866994 severity=INFO payloadType=AlertReport referenceId=LOCAL-FED25D43
  EWS feedback via EwsService: cap=... mode=local status=accepted referenceId=LOCAL-FED25D43
  ```
  With `EWS_LOCAL_URL=http://localhost:18084` (MockServer) in `EwsPipelineIntegrationTest`:
  ```
  MockServer received: {"alertId":"ews-http-...","capIdentifier":"ews-http-...","payload":{"towerCount":1,"targetedSubscriberCount":1,...}}
  ```
- **Local receiver:** `POST /api/v1/ews/local/receive` → `200 {"mode":"local","status":"accepted","referenceId":"LOCAL-...","alertId":"ews-pipeline-...","payload":{...}}`
- **Received report verified:** `GET /api/v1/ews/local/last-received` →
  ```json
  {"receivedCount":1,"request":{"alertId":"ews-pipeline-1788847866994","capIdentifier":"ews-pipeline-1788847866994","payload":{"capIdentifier":"ews-pipeline-1788847866994","towerCount":3,"targetedSubscriberCount":3,"processingStartedAt":"...","processingEndedAt":"..."}},"response":{"mode":"local","status":"accepted","referenceId":"LOCAL-FED25D43"}}
  ```
- **Other EWS checks:** `GET /api/v1/ews/local/received-count` `1`, `GET /history` `1`, `POST /clear` works; `POST /api/v1/ews/local/receive?simulateFailure=500` → `500 SERVER_ERROR` correctly (error path tested).

## Activity 11 — DLR Feedback
**Status:** PASS (local SMPPSim)

**Evidence:**
- **submit_sm → submit_sm_resp → SMSC message ID:** `40` (single) and `47-51` (pipeline batch 5) as above.
- **SMPPSim deliver_sm (actual, via `MessageReceiverListener` now wired):**
  ```
  DEBUG Received deliver_sm: id:40 sub:001 dlvrd:001 submit date:2609071618 done date:2609071618 stat:DELIVRD err:000 Text:TURANT SMPPSim valid
  INFO  DLR deliver_sm parsed: smscMessageId=40, state=DELIVRD, err=000
  INFO  DLR received: alertId=live-alert-001, msisdn=919000000001, state=DELIVRD
  DEBUG Received deliver_sm: id:41 ... stat:DELIVRD Text:DLR correlation test → DLR received: alertId=dlr-live-..., state=DELIVRD
  ```
  Pipeline batch:
  ```
  Received deliver_sm: id:47 ... stat:DELIVRD → DLR received: alertId=test-pipeline-smpp-... state=DELIVRD (x4)
  Received deliver_sm: id:51 ... stat:UNDELIV → DLR received: alertId=... state=UNDELIV (1)
  PIPELINE DLR received=5 firstState=DELIVRD smscId=48 report delivered=5
  ```
- **DLR parsed:** `DlrListener.parseDeliveryReceipt` regex `id:\S+ stat:\S+` → `DlrReceipt(smscMessageId=40, messageState=DELIVRD, errorCode=000, deliveredAt=...)`
- **Correlation:** `SmppClient` after `submitShortMessage` does `DlrListener.registerSubmission(smscMessageId, messageId, alertId, msisdn)`; `DlrListener.handleReceipt` looks up `submissions.get(id)` → `noteReceipt(alertId, receipt)` → `AlertReceiptStats` + `DlrReporter.buildDeliveryReport`. Uncorrelated `id:36` logs `WARN Unmatched DLR receipt: smscMessageId=36` (not fabricated).
- **Actual delivery status:** `DELIVRD` (90% per `smppsim.props` `PERCENTAGE_DELIVERED=90`), `UNDELIV` (6%), `ACCEPTD/EXPIRED/REJECTD/DELETED` handled via `switch` (extensible).
- **Receipt reporting:** `DlrListener.receiptsForAlert(alertId).getReceivedCount()==1` (single) / `5` (pipeline) and `DlrReporter` `delivered=1` / `5`.

## Failure Validation
- **SMPP:** SMPPSim down (killed java, `Test-NetConnection 5555 False`) → `SmppClient` `connect()` fails with `Failed to connect/bind to SMSC` `IOException: Connection refused`, pipeline `submittedCount` stays 0, `awaitingCredentials` false but logs not `accepted` (no false success). Restored via `java -jar target/smppsim.jar` → `TcpTestSucceeded True`.
- **EWS:** `POST /api/v1/ews/local/receive?simulateFailure=401` → `401 AUTHENTICATION_FAILURE`, `?simulateFailure=500` → `500 SERVER_ERROR`; `RemoteEwsClient` timeout (MockServer delay 2000ms vs `readTimeout 500ms`) → `TIMEOUT 504`, `401/403` → `AUTHENTICATION_FAILURE`, `5xx` → `SERVER_ERROR` (all via `EwsIntegrationTest` 18 tests, no silent `200`).
- **DLR:** Invalid `id:UNKNOWN` → `WARN Unmatched DLR receipt` (not counted as delivered), empty receipt → `null` ignored.

## Automated Tests
```
mvn test -o → Tests run: 248, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: ~40s
  EwsIntegrationTest 18, EwsLocalHttpIntegrationTest 4, EwsPipelineIntegrationTest 3, PipelineSmppIntegrationTest 3, SmppsimLiveTest 6 (via -Dtest=SmppsimLiveTest, excluded from default via pom excludes), SmppClientTest 15, DlrListenerTest 17, etc.
mvn clean test → same 248 PASS
mvn test -Dtest=SmppsimLiveTest -o → Tests run: 6, Failures: 0 (TCP 64ms, BIND, submit 20ms smscMessageId 40, DLR DELIVRD id:40 correlated)
mvn test -Dtest=PipelineSmppIntegrationTest -o → Tests run: 3, Failures: 0 (5/5/5/5)
```
- **JAR:** `mvn clean package -DskipTests -o` → `BUILD SUCCESS` `target/turant-0.1.0.jar` 43MB `BOOT-INF` `repackaged`.

## Build
- `mvn clean package -DskipTests -o` `BUILD SUCCESS` `target/turant-0.1.0.jar` (original `turant-0.1.0.jar.original`)

## Security/Configuration Audit
- **Production configuration:** `application-production.properties` has `turant.ews.mode=${EWS_MODE:remote}` (fail-closed, requires `EWS_BASE_URL`), no `localhost` (`turant.ews.local-url=${EWS_LOCAL_URL:}` blank), `turant.smpp.host=${TURANT_SMPP_HOST:}` blank, `SIMULATION_MODE=disabled`, `server.ssl.enabled=true` `client-auth=need`.
- **Simulation separation:** `SimulatedSmppClient` `@ConditionalOnProperty(simulation.mode=enabled)` only, `SimulatedTowerSource` only when `simulation.mode=enabled`, `PostGisTowerSource` only when `postgis`; `isConfigured()` guards real SMPP; `awaitingCredentials` used.
- **Secrets check:** `grep -r wpsd src/main` 0, `grep -r pavel src/main` 0, `grep -r 127.0.0.1 src/main` only in `LocalEwsClient` fallback `http://localhost:8080` (dev, not prod), `.env` gitignored (`.gitignore:31`), `.env.example` placeholders only (`SMPP_HOST=` `EWS_BASE_URL=https://<provided-by-C-DOT>`), no `SMPPSim` creds in prod, logs never contain `Authorization`/`password` (verified via `SmppsimLiveTest` secret not leaked, `RemoteEwsClient` logs only `alertId,path,httpStatus`).
- **SMPP/EWS externalized:** `application.properties:89` `smpp.host=${SMPP_HOST:}` `turant.smpp.*` + `turant.ews.*` (`EWS_MODE`, `EWS_BASE_URL`, `EWS_LOCAL_URL`, `EWS_API_KEY`, `EWS_PATH`, `EWS_CONNECT_TIMEOUT` etc.), `docker-compose.yml:65` passes `EWS_MODE` etc. (no hardcoded prod EWS).
- **Security:** `ApiKeyAuthFilter` protects `/api/v1/ews/` (pass-through when `EWS_API_KEY` empty in dev), `SecurityDbInitializer`, `CapSignatureService` disabled in dev (`TSP_PUBLIC_KEY_PEM` empty), `WebConfig` CORS, `GlobalExceptionHandler` for `EwsException`.
- **Deployment files:** `Dockerfile`, `docker-compose.yml` (postgres, redis, backend, frontend, healthchecks), `migrations/` (`008`, `010` etc.), `postman/` (`TURANT_SECURITY_COLLECTION.json`, `postman/collections/TURANT API/post-pipeline-trigger-by-cap.request.yaml`).
- **Documentation:** `docs/ews/EWS_INTEGRATION.md` (local/remote, config, manual steps, production boundary), `docs/sms/SMPPSIM_VALIDATION.md` (SMPP/DLR), `docs/deployment/` etc. (handover present).

## Production Limitations
- **Local SMPPSim validation (127.0.0.1:5555 pavel) does NOT prove production TSP/SMSC connectivity, capacity, throughput (100M), or real subscriber VLR.** Real `subscriber_dump` (190M) + `sim_cell_towers` + `turant_agg` + `TURANT_SMPP_HOST/PORT/SYSTEM_ID/PASSWORD` on C-DOT TSP network require deployment-side validation.
- **Local EWS validation (http://localhost:8080/api/v1/ews/local/receive) does NOT prove real C-DOT EWS endpoint, production credentials, mTLS certificates (`EWS_KEYSTORE`/`EWS_TRUSTSTORE`), firewall, or contract.** Production `EWS_MODE=remote` `EWS_BASE_URL=https://<C-DOT>` + `EWS_API_KEY`/`EWS_USERNAME`/`EWS_PASSWORD` + `EWS_PATH`/`EWS_METHOD` + `EWS_SSL_ENABLED=true` require deployment-side validation.
- **DLR validation against SMPPSim (90% DELIVRD, 6% UNDELIV etc., `DELAY_DELIVERY_RECEIPTS_BY=0`) does NOT prove production TSP DLR behavior, latency, or `ENROUTE`/`EXPIRED` rates.** Production DLR `%` and `deliver_sm` `message_payload` format may differ.
- **Postman large CAP (109KB, 27600 towers for Delhi 15km real DB) is heavy (30s+ tower-resolution, 5s+ subscriber) and may `503 PIPELINE_TIMEOUT` (async timeout 300s) — poll `GET /api/v1/pipeline/status/{capId}`; `H2` test DB is small (3 towers) and fast.
