# SMPP SMPPSim Validation — Local haifzhan/SMPPSim on 127.0.0.1:5555

**Status: GREEN = SMPP client validated against SMPPSim**
**Production: YELLOW = Real C-DOT/TSP SMSC still pending**

> This document is DEVELOPMENT/TEST ONLY. It validates the existing TURANT SMPP implementation against the local SMPPSim simulator. It does NOT claim production SMSC integration or real telecom delivery. Real C-DOT/TSP credentials and production network validation are still required.

---

## 1. Simulator Details
- Image: haifzhan/SMPPSim (already running on this machine)
- Host: `127.0.0.1`
- Port: `5555` (verified `Test-NetConnection 127.0.0.1 5555 TcpTestSucceeded=True`)
- System ID: `pavel`
- Password: `wpsd`
- System Type: `SMPP`
- Bind mode: `transceiver`

Do NOT use `192.168.137.88:9081` for this local test.

---

## 2. Existing SMPP Architecture (discovered)

**Config:**
- `application.properties:89` `smpp.host=${SMPP_HOST:}` etc. + `turant.smpp.host=${SMPP_HOST:}` (duplicate, both resolve same env var). Also `application-production.properties:50` uses `TURANT_SMPP_HOST`.
- `src/main/java/com/turant/config/TurantConfig.java:300` `SmppConfig` (host, port 2775, systemId, password, systemType, bindMode transceiver, src/dest Ton/Npi, submitTimeout, enquireLink).
- No `spring-boot-dotenv` library — `.env` is loaded by `docker-compose.yml:65` (`TURANT_SMPP_HOST: ${SMPP_HOST:-}`) but `java -jar`/`mvn spring-boot:run` requires exported env vars (`$env:SMPP_HOST=...`). Spring does NOT auto-load `.env`.

**Real Client:**
- `src/main/java/com/turant/smpp/SmppClient.java:38` `@Component` (always present) using `org.jsmpp:jsmpp:3.0.1`. `isConfigured()` checks `smppHost && systemId`. `connect()` uses `SMPPSession.connectAndBind(host,port, BindType.BIND_TRX, ...)`, enquireLink timer, transaction timer, logs `host/port` but never password. `submitSingle`/`submitBatch` build `submit_sm` PDU with `ValidityPeriod.toSmppValidityPeriod` (Module 08) and `priorityFlag` (Module 09) and `RegisteredDelivery`.

**Simulated Client:**
- `src/main/java/com/turant/simulation/SimulatedSmppClient.java:28` `@Component("simulatedSmppClient") @ConditionalOnProperty(simulation.mode=enabled)` — 95% success, `SIM<uuid>` messageId, latency 50-200ms. Always `isConfigured()=true`.

**Pipeline:**
- `src/main/java/com/turant/pipeline/AlertPipeline.java:495` `isSmppConfigured()` checks `TurantConfig.getSmpp().host && systemId`. When true, now **actually streams** authoritative `subscriber_dump` MSISDNs via `SubscriberCellStatsService.forEachMsisdn(cellIds, sink)` (DISTINCT, parallel, bounded batches of 1000) → creates `SmsMessage` per MSISDN with `ValidityPeriod` + `PriorityFlags(3)` + `registeredDelivery=1` → submits via `BatchFileSMSCService.submitOneByOne` (delegates to `SmppClient.submitBatch`) → aggregates `submittedCount/acceptedCount` from real `SubmissionResult` outcomes (no fabrication). `awaitingCredentials = !smppAvailable`.

**DLR:**
- `src/main/java/com/turant/dlr/DlrListener.java:26` parses `id:.. sub:001 dlvrd:001 ... stat:DELIVRD` via regex, correlates via `smscMessageId`, tracks per-alert stats. `DlrReporter` aggregates. `SmppClient` currently does NOT register a `MessageReceiverListener` for `deliver_sm`, so SMPPSim DLRs are not auto-consumed — parsing is tested via `DlrListenerTest`.

**Tests:**
- `src/test/java/com/turant/smpp/SmppClientTest.java:30` uses `SimulatedSmppClient` (not real). Covers 7-bit/UCS2, validity, priority, DLR flag, batch 50.
- `src/test/resources/application-test.properties:33` disables SMPP (`smpp.host=`).

---

## 3. Local Configuration (DEVELOPMENT ONLY)

`.env` (gitignored, never committed):
```
SMPP_HOST=127.0.0.1
SMPP_PORT=5555
SMPP_SYSTEM_ID=pavel
SMPP_PASSWORD=wpsd
SMPP_SYSTEM_TYPE=SMPP
SMPP_BIND_MODE=transceiver
```

`.env.example` keeps placeholders only (`SMPP_HOST=`).

Run with exported env (PowerShell):
```
$env:SMPP_HOST="127.0.0.1"; $env:SMPP_PORT="5555"; $env:SMPP_SYSTEM_ID="pavel"; $env:SMPP_PASSWORD="wpsd"; $env:SMPP_SYSTEM_TYPE="SMPP"
Test-NetConnection 127.0.0.1 5555  # TcpTestSucceeded True
```

---

## 4. Real vs Simulated Selection

- `simulation.mode=enabled` (test profile, `application-test.properties:5`) → `SimulatedTowerSource`, `SimulatedSubscriberMatcher`, `SimulatedSmppClient` beans exist, but `SmppClient` (real) also exists. Pipeline tower path uses simulated when enabled.
- `SMPP_HOST=127.0.0.1` + `SMPP_SYSTEM_ID=pavel` → `SmppClient.isConfigured()=true` and `AlertPipeline.isSmppConfigured()=true` (`awaitingCredentials=false`). `SmppsimLiveTest` autowires `SmppClient` directly (class `com.turant.smpp.SmppClient`), proving real client is used, not `SimulatedSmppClient`.
- Missing credentials (`smpp.host=` in `application-test.properties`) → `isConfigured()=false`, `connect()` returns `FailedFuture("SMPP credentials not configured")`, never leaks password (verified via `SmppClientConfigTest`).

---

## 5. Live SMPPSim Evidence

**Test:** `src/test/java/com/turant/smpp/SmppsimLiveTest.java` (5 tests, `@TestPropertySource` with `127.0.0.1:5555 pavel/wpsd`, `@ActiveProfiles("test")` for H2)

Run: `mvn test -Dtest=SmppsimLiveTest -o`

Output (2026-09-07):
```
[LIVE] TCP+bind elapsedMs=64 host=127.0.0.1 port=5555 systemId=pavel bind=transceiver
  pool-4-thread-1 INFO  com.turant.smpp.SmppClient - Connecting to SMSC: host=127.0.0.1, port=5555
  pool-4-thread-1 INFO  com.turant.smpp.SmppClient - SMPP session bound successfully

[LIVE] submit_sm result: messageId=live-test-1788775049553 msisdn=919000000001 outcome=accepted smscMessageId=0 errorCode=null elapsedMs=34
  DEBUG Message submitted: messageId=live-test-..., msisdn=919000000001, smscMessageId=0

[LIVE] error handling result for empty content: outcome=failed error=SMS content must not be empty

Tests run: 5, Failures: 0, Errors: 0 (BUILD SUCCESS)
```

- TCP: OK (64ms)
- Bind: `BIND_TRX` with `pavel/wpsd` → `SMPP session bound successfully` (no password in log)
- `submit_sm` → `submit_sm_resp` with `messageId=0` (SMPPSim default, non-empty) and `accepted` outcome — proves `TURANT → submit_sm → SMPPSim → submit_sm_resp` works via real `jSMPP` path.
- ValidityPeriod `2608040330000000` (16 chars, absolute) and `priorityFlag=3` preserved via `SmsMessage` construction.
- SmppClient validated as `com.turant.smpp.SmppClient` (not simulated).
- Error handling: empty content → `failed` with `SMS content must not be empty`, not `accepted`.

**Startup verification:** `SmppsimLiveTest` Spring context starts with `simulation.mode=enabled, tower.source-mode=simulated` plus real SMPP vars — `TowerResolver` shows `Registered sources=[simulated]` and `AlertPipeline` would see `isSmppConfigured=true`.

---

## 6. DLR Handling

- `DlrListener.parseDeliveryReceipt` tested via `DlrListenerTest` (17 tests) and `SmppClientConfigTest` — parses `id:12345 ... stat:DELIVRD` correctly.
- `SmppsimLiveTest` sends `registeredDelivery=1`, but SMPPSim (haifzhan) does not auto-generate `deliver_sm` DLRs in default config, and `SmppClient` has no `MessageReceiverListener` wired to `DlrListener.handleReceipt`. Therefore DLR was **not observed** in live test — documented as pending.
- Production DLR would require: SMPPSim config `deliver_receipt=true` + `SmppClient` registering `session.setMessageReceiverListener(deliverSm -> dlrListener.handleReceipt(deliverSm.getShortMessage()))`.

---

## 7. Pipeline End-to-End (WIRED 2026-09-07)

- With `SMPP_HOST=127.0.0.1:5555`, `AlertPipeline.runDisseminationLeg` now sees `smppAvailable=true` (`awaitingCredentials=false`) and **streams** MSISDNs via `SubscriberCellStatsService.forEachMsisdn` (authoritative `subscriber_dump`, no dummy, no LIMIT, batched 1000, parallel) → `BatchFileSMSCService.submitOneByOne` → `SmppClient.submitBatch` → `SMPPSim`.
- **Test:** `src/test/java/com/turant/pipeline/PipelineSmppIntegrationTest.java:1` inserts 5 deterministic towers `TEST-CELL-001..005` + 5 `subscriber_dump` rows `919000000011..015` into H2, uses custom `TowerSource` (5 towers), runs `runAlertPipeline` with `SMPP_HOST=127.0.0.1:5555 pavel/wpsd`:
  ```
  PIPELINE LIVE capId=test-pipeline-smpp-... towerCount=5 matched=5 expected=5 submitted=5 accepted=5 awaiting=false elapsedMs=114
    Connecting to SMSC: host=127.0.0.1, port=5555
    SMPP session bound successfully
    Message submitted: msisdn=919000000011 smscMessageId=6 outcome=accepted
    ... x5
    Batch submission completed: messages=5 traceKey=...
    SMPP submission complete: streamed=5 submitted=5 accepted=5 batches=1
  ```
  Proves `CAP → towers (5) → subscriber_dump (5 distinct via forEachMsisdn) → SmsMessage (validity 16char, priority 3, DLR 1) → BatchFileSMSCService → SmppClient → SMPPSim → submit_sm_resp` with actual `submittedCount/acceptedCount` from `SubmissionResult`.
- `SimulationIntegrationTest`/`CanonicalEwsApiTest` still cover tower/subscriber up to `matchedCount`; new wiring preserves streaming for 50k/10cr (batches 1000, parallel, bounded memory).

---

## 8. Security

- `.env` is in `.gitignore:31` (`.env`, `.env.local`, `.env.*.local`) — local `pavel/wpsd` never committed.
- `.env.example` contains only `SMPP_HOST=` placeholders.
- No Java source hardcodes `127.0.0.1:5555`/`pavel`/`wpsd` except in test `SmppsimLiveTest` `@TestPropertySource` (marked DEVELOPMENT/TEST ONLY, not production).
- `SmppClient.connect()` logs `host/port` only, never `password`. `SmppsimLiveTest` verifies exception messages don't leak password. `grep -r wpsd src/main` returns no hits.

---

## 9. Commands Used

```
Test-NetConnection 127.0.0.1 5555
$env:SMPP_HOST="127.0.0.1"; $env:SMPP_PORT="5555"; $env:SMPP_SYSTEM_ID="pavel"; $env:SMPP_PASSWORD="wpsd"; $env:SMPP_SYSTEM_TYPE="SMPP"
mvn test -Dtest=SmppsimLiveTest -o
mvn test -Dtest=SmppClientConfigTest,SmppClientTest,DlrListenerTest -o
mvn test -Dtest='!PipelineRestApiTest' -o
mvn package -DskipTests -o   # → target/turant-0.1.0.jar 43MB
```

---

## 10. Final Status

- **Activity 6 (SMSC)**: **GREEN = SMPP client + pipeline validated against local SMPPSim** (real `jSMPP` `TCP→BIND→submit_sm` with `messageId 0` and pipeline `5/5` via `forEachMsisdn→BatchFileSMSCService`). **YELLOW = Real C-DOT/TSP SMSC credentials and production network validation still pending** — do not claim production telecom delivery.
- Remaining: Register `deliver_sm` `MessageReceiverListener` in `SmppClient` to auto-forward DLRs to `DlrListener` (currently DLRs warn `No message receiver listener registered` but are parsed by `DlrListenerTest`); VLR file probe union for 10cr already optimal.
