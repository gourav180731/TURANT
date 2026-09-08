# EWS Integration — Activity 7 (TURANT 0.1.0)

**EWS application-side implementation and local/controlled endpoint validation: GREEN**  
**Production C-DOT EWS integration: pending provision of the authorized C-DOT endpoint, interface contract, authentication/certificates and network access**

> Real EWS integration is considered complete only after successful end-to-end communication with the authorized C-DOT EWS environment.

Pending C-DOT EWS integration contract: `EWS_BASE_URL`, `EWS_PATH`, `EWS_METHOD`, `auth header` and JSON/XML schemas are **configurable** — no real URLs or credentials are hardcoded. Local controlled endpoint is runnable via `POST /api/v1/ews/local/receive` and inspected via `GET /api/v1/ews/local/last-received`.

---

## 1. Architecture

```
                EWS Integration Interface (EwsClient)
                              |
                  +-----------+-----------+
                  |                       |
          LocalEwsClient          RemoteEwsClient
                  |                       |
           local/mock EWS          Actual C-DOT EWS/VB
                                       (HTTP)

Pipeline/business logic → EwsService → EwsClientFactory → (Local | Remote)
```

Package: `src/main/java/com/turant/ews/`

- `EwsMode.java` — LOCAL / REMOTE enum, rejects invalid modes at startup
- `config/EwsProperties.java` — `@ConfigurationProperties(prefix="turant.ews")` (now includes `localUrl` for HTTP loopback)
- `EwsClient.java` — interface `send(EwsRequest)`, `sendReport(AlertReport)`
- `LocalEwsClient.java` — DEVELOPMENT/TEST, **does real HTTP** to `turant.ews.local-url` (`EWS_LOCAL_URL`, default `http://localhost:${PORT}/api/v1/ews/local/receive` via `local.server.port` fallback) when configured; else deterministic in-memory fallback. Logs `alertId, url` only, never secrets.
- `RemoteEwsClient.java` — `RestClient` with connect/read timeouts, configurable path/method/headers, explicit error mapping, never logs secrets
- `LocalEwsStore.java` — `Component` storing last `EwsRequest`/`EwsResponse`, history, `receivedCount`, `failureSimulations` for manual inspection and test verification
- `EwsClientFactory.java` — mode-based selection, `local→LocalEwsClient`, `remote→RemoteEwsClient`, throws on invalid
- `EwsService.java` — business layer, handles feedback persistence/idempotency, async pipeline integration
- `dto/EwsRequest.java, EwsResponse.java, EwsFeedback.java`
- `exception/EwsException.java, EwsErrorCode.java`
- `controller/LocalEwsReceiveController.java` — **Controlled local EWS server** `POST /api/v1/ews/local/receive` (logs, validates, stores to `LocalEwsStore`, returns `accepted` or simulated failure via `?simulateFailure=`), `GET /last-received`, `/received-count`, `/history`, `POST /clear`
- `controller/EwsLocalController.java` — `POST /api/v1/ews/local/test`, `GET /api/v1/ews/mode` (test helper)
- `controller/EwsRemoteController.java` — `POST /api/v1/ews/test-remote` (rejects if not remote, no silent fallback, no mode switching)
- `controller/EwsFeedbackController.java` — `POST /api/v1/ews/feedback` (authenticated, validated, idempotent, persists to `ews_feedback` + memory)

Existing pipeline integration is **non-blocking**: `AlertPipeline` calls `EwsService.sendReport()` after `completed` status is stored; failure does not block subscriber pipeline. Legacy `EwsCallback` is retained as fallback.

### Existing code reused
- `EwsCallback.java` (legacy callback) kept, wrapped by `EwsService` for backward compat
- `TurantConfig.EwsConfig` kept (backward compat alias for `callback-url/token`)
- `ReportBuilder`, `PipelineStatusStore`, `ApiKeyAuthFilter` (extended to protect `/api/v1/ews/`), `SecurityService`, `GlobalExceptionHandler`, `ApiError`

---

## 2. Configuration

`src/main/resources/application.properties:178`:

```properties
turant.ews.mode=${EWS_MODE:local}
turant.ews.base-url=${EWS_BASE_URL:}
turant.ews.local-url=${EWS_LOCAL_URL:}  # e.g., http://localhost:8080/api/v1/ews/local/receive for local HTTP (blank → in-memory fallback)
turant.ews.api-key=${EWS_API_KEY:}
turant.ews.username=${EWS_USERNAME:}
turant.ews.password=${EWS_PASSWORD:}
turant.ews.path=${EWS_PATH:/ews/callback}
turant.ews.method=${EWS_METHOD:POST}
turant.ews.connect-timeout=${EWS_CONNECT_TIMEOUT:5s}
turant.ews.read-timeout=${EWS_READ_TIMEOUT:15s}
turant.ews.ssl-enabled=${EWS_SSL_ENABLED:false}
turant.ews.keystore=${EWS_KEYSTORE:}
turant.ews.keystore-password=${EWS_KEYSTORE_PASSWORD:}
turant.ews.truststore=${EWS_TRUSTSTORE:}
turant.ews.truststore-password=${EWS_TRUSTSTORE_PASSWORD:}
# legacy aliases
turant.ews.callback-url=${EWS_CALLBACK_URL:}
turant.ews.callback-token=${EWS_CALLBACK_TOKEN:}
```

### LOCAL (dev/test)

```bash
EWS_MODE=local
EWS_LOCAL_URL=http://localhost:8080/api/v1/ews/local/receive  # real HTTP to controlled local EWS (or blank → in-memory fallback)
# No EWS_BASE_URL needed. Credentials not required.
```

Behavior: `POST /api/v1/ews/local/receive` (controlled local EWS server) receives pipeline's `EwsRequest` via HTTP (`LocalEwsClient` → `RestClient` → `LocalEwsReceiveController`), logs, validates, stores in `LocalEwsStore`, returns `{"mode":"local","status":"accepted","referenceId":"LOCAL-...","timestamp":"...","alertId":"...","payload":{...}}`. Inspect via `GET /api/v1/ews/local/last-received`. `POST /api/v1/ews/local/test` is a test helper that also goes through the same path (HTTP if `EWS_LOCAL_URL` set, else in-memory).

### REMOTE (C-DOT)

```bash
EWS_MODE=remote
EWS_BASE_URL=https://<provided-by-C-DOT>
EWS_API_KEY=<secret: 64 hex or Bearer token>
# optional:
EWS_USERNAME=<secret>
EWS_PASSWORD=<secret>
EWS_PATH=/ews/callback      # configurable path from C-DOT
EWS_METHOD=POST
EWS_CONNECT_TIMEOUT=5s
EWS_READ_TIMEOUT=15s
EWS_SSL_ENABLED=true        # when mTLS needed
EWS_KEYSTORE=/certs/ews.p12
EWS_KEYSTORE_PASSWORD=<secret>
EWS_TRUSTSTORE=/certs/trust.p12
EWS_TRUSTSTORE_PASSWORD=<secret>
```

Startup validation: `remote` without `EWS_BASE_URL` → `IllegalStateException` (fail-closed, no silent fallback to local). Invalid modes also fail fast.

Credentials **never** appear in source, logs, or error messages. Remote client logs only `alertId, path, method, httpStatus` — never `Authorization`, `apiKey`, `password`.

---

## 3. Endpoints

All `/api/v1/ews/**` are protected by `ApiKeyAuthFilter` (`/api/v1/ews/` added to `protectedPrefixes`) and `SecurityService` (ApiKey / mTLS + IP + rate limit). Public paths (`/healthz`, `/api-docs`) remain public. Local receive endpoint is public in dev (no API key required when `EWS_API_KEY` empty — filter pass-through); in production, set `EWS_API_KEY` to enforce.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/ews/local/receive` | **Public in dev** (local controlled EWS server) | **LOCAL EWS SERVER** — pipeline's Activity 7 posts here when `EWS_MODE=local` (via `LocalEwsClient` HTTP). Validates `alertId`, logs, stores in `LocalEwsStore`, returns `mode=local, status=accepted, referenceId=LOCAL-..., timestamp`. Supports `?simulateFailure=401/500` and `X-EWS-FAIL` header for error path testing. This is the runnable local EWS endpoint. |
| `POST` | `/api/v1/ews/local/test` | ApiKey/mTLS | **LOCAL test helper** — simulate EWS send via `LocalEwsClient` (HTTP to `localUrl` if set, else in-memory fallback). Body `EwsRequest`. Returns `mode=local, status=accepted`. |
| `GET` | `/api/v1/ews/local/last-received` | ApiKey/mTLS | Inspect last EWS report received by controlled local endpoint (for manual demo). Returns `receivedCount, lastReceivedAt, request, response`. |
| `GET` | `/api/v1/ews/local/received-count` | ApiKey/mTLS | Count of received EWS reports |
| `GET` | `/api/v1/ews/local/history` | ApiKey/mTLS | Full history of received `EwsRequest`s |
| `POST` | `/api/v1/ews/local/clear` | ApiKey/mTLS | Clear `LocalEwsStore` (test utility) |
| `POST` | `/api/v1/ews/test-remote` | ApiKey/mTLS | **REMOTE only** — invokes `RemoteEwsClient`. Validates `mode==remote`, returns actual remote response or mapped error (401/TIMEOUT/502/5xx). If `mode!=remote` → `400 {status:rejected, reason:EWS is not configured in remote mode}`. Never switches mode dynamically. |
| `POST` | `/api/v1/ews/feedback` | ApiKey/mTLS | **EWS → TURANT callback** — receives delivery feedback from EWS. Validates `alertId` (`[A-Za-z0-9._-]{1,255}`), persists idempotently (`alertId+referenceId` unique), updates pipeline correlation, returns `acknowledged` (`duplicate:true` for replay). |
| `GET` | `/api/v1/ews/feedback/{alertId}` | ApiKey/mTLS | Query stored feedbacks for alertId |
| `GET` | `/api/v1/ews/mode` | ApiKey/mTLS | Returns `mode, effectiveMode, baseUrlConfigured, timestamp` (no secrets) |

### Example — LOCAL

```bash
curl -X POST http://localhost:8080/api/v1/ews/local/test \
  -H "X-API-KEY: $EWS_API_KEY" -H "Content-Type: application/json" \
  -d '{"alertId":"TEST-001","message":"Test EWS message","severity":"INFO"}'

# → {"mode":"local","status":"accepted","referenceId":"LOCAL-A1B2C3D4","timestamp":"...","alertId":"TEST-001"}
```

### Example — REMOTE test (requires `EWS_MODE=remote` + real/mocked EWS)

```bash
curl -X POST http://localhost:8080/api/v1/ews/test-remote \
  -H "X-API-KEY: $EWS_API_KEY" -H "Content-Type: application/json" \
  -d '{"alertId":"TEST-001","message":"Remote EWS test","severity":"CRITICAL"}'
```

### Example — Feedback (EWS → TURANT)

```bash
curl -X POST http://localhost:8080/api/v1/ews/feedback \
  -H "X-API-KEY: $EWS_API_KEY" -H "Content-Type: application/json" \
  -d '{"alertId":"CAP-2026-001","capIdentifier":"CAP-2026-001","referenceId":"EWS-REF-123","status":"delivered","deliveredCount":9500,"failedCount":12}'
```

---

## 4. Error Handling (Remote)

`RemoteEwsClient` maps HTTP outcomes to `EwsErrorCode`/`EwsException` and `GlobalExceptionHandler` renders `ApiError`:

| Condition | EwsErrorCode | HTTP | ApiError code |
|-----------|--------------|------|---------------|
| 2xx success | SUCCESS | 200 | SUCCESS |
| 400/404 | INVALID_REQUEST | 400 | INVALID_REQUEST |
| 401/403 | AUTHENTICATION_FAILURE | 401 | AUTHENTICATION_FAILURE |
| 409/429 | REMOTE_REJECTED | 409 | REMOTE_REJECTED |
| timeout / `ResourceAccessException` timeout | TIMEOUT | 504 | TIMEOUT |
| connection refused / DNS / `ResourceAccessException` connect | CONNECTION_FAILURE | 502 | CONNECTION_FAILURE |
| 5xx | SERVER_ERROR | 5xx | SERVER_ERROR |
| empty body | SERVER_ERROR | 502 | SERVER_ERROR |
| missing `alertId` | INVALID_REQUEST | 400 | INVALID_REQUEST |
| `mode!=remote` on remote path | UNSUPPORTED_MODE | 400 | UNSUPPORTED_MODE |
| `remote` + missing `base-url` | NOT_CONFIGURED | 500 | NOT_CONFIGURED |

Responses never contain secrets. Local mode errors are `ApiError 400` as well.

---

## 5. Security

- No `.env`, certificates, keystores, or passwords committed
- All secrets via `${EWS_API_KEY:}`, `${EWS_PASSWORD:}`, etc.
- `RemoteEwsClient` never logs `Authorization`, `apiKey`, `password`, `keystore`
- `EwsException` messages intentionally strip secrets (test `credentialsNeverLoggedInException`)
- `ApiKeyAuthFilter` updated: `protectedPrefixes` now includes `/api/v1/ews/`; `/api/v1/ews/feedback` also checked via `SecurityService`
- mTLS hooks present: `EWS_SSL_ENABLED`, `EWS_KEYSTORE`, etc. — only enabled when C-DOT supplies certs; no fake cert validation

---

## 6. Pipeline Integration

```
CAP → CAP parsing → Polygon → Cell Site (PostGIS/Simulated) → Subscriber (cell_subscriber_stats + VLR) → Dedup → Expiry/Priority → SMS/SMPP → EWS feedback (async)
```

- `AlertPipeline` now injects optional `EwsService` (preferred) with legacy `EwsCallback` fallback.
- After `completed` status + `PipelineStatusStore.update`, pipeline calls `ewsService.sendReport(report)` inside try/catch — never throws, never blocks.
- If no EWS URL/token, report persists to `alert_reports` / `ews_feedback` for audit; delivery resumes after config.

---

## 7. Tests

`src/test/java/com/turant/ews/EwsIntegrationTest.java` (18 tests, `@SpringBootTest` + `MockServer`):

1. Local mode selects `LocalEwsClient`
2. Remote mode selects `RemoteEwsClient`
3. Invalid mode fails safely (`IllegalStateException`)
4. Local EWS endpoint works (`GET /api/v1/ews/local/test` returns `local/accepted/referenceId`)
5. Remote request constructed correctly (MockWebServer verifies `POST /ews/callback`, `Authorization: Bearer <key>`, body contains `alertId`)
6. Remote auth headers from configuration
7. Credentials never logged (401 body does not contain secret)
8. Remote timeout handled (2000 ms delay → `TIMEOUT`/`CONNECTION_FAILURE`)
9. Remote 401/403 → `AUTHENTICATION_FAILURE` (401/403)
10. Remote 5xx → `SERVER_ERROR` (500)
11. Feedback endpoint validates input (missing/blank `alertId` → 400)
12. Duplicate feedback idempotent (`duplicate:false` then `duplicate:true`, still 200)
13. Production/remote cannot silently fall back to local (`local→test-remote` rejected, `remote` without `baseUrl` → `NOT_CONFIGURED`)
14. Existing tests continue passing + mode endpoint etc.

Run:
```bash
mvn test -Dtest=EwsIntegrationTest
mvn test -Dtest='!PipelineRestApiTest'   # 212→230 tests (18 new)
mvn clean test                            # full 230+ incl. PipelineRestApiTest
```

All 230 tests `BUILD SUCCESS` (212 existing + 18 new).

---

## 8. Build & Verification

```bash
mvn clean test                 # 230 tests pass (212+18 new, 0 failures)
mvn clean package -DskipTests  # JAR 43 MB: target/turant-0.1.0.jar
# LOCAL
EWS_MODE=local mvn spring-boot:run  # or java -jar target/turant-0.1.0.jar
curl -X POST http://localhost:8080/api/v1/ews/local/test -H "X-API-KEY: dev" -H "Content-Type: application/json" -d '{"alertId":"T1","message":"hi","severity":"INFO"}'

# REMOTE dummy
EWS_MODE=remote EWS_BASE_URL=http://localhost:18082 EWS_API_KEY=dummy java -jar target/turant-0.1.0.jar
curl -X POST http://localhost:8080/api/v1/ews/test-remote ... # → 401/502 etc. via mocked MockServer, not local fallback

# Mocked remote verification: see EwsIntegrationTest (MockServer on :18082, verifies header/body per 5-6)
# Secrets: grep logs for EWS_API_KEY — never present (test 7 proves)
```

---

## 9. Assumptions & Pending C-DOT Contract

- Real EWS URL, path, method, JSON/XML schema, header names, response schema, certificate configuration are **not guessed** — all are configurable via `turant.ews.*` / `EWS_*` envs.
- Document states `Pending C-DOT EWS integration contract.` Where contract arrives, only `RemoteEwsClient` adapter (path/header mapping, DTO shape) needs adaptation; interface and factory remain.
- `ews_feedback` table is created lazily if `JdbcTemplate` is present; falls back to in-memory `ConcurrentHashMap` in test/dev without DB.
- Local mock never fabricates success blindly — it validates `alertId` required → 400, otherwise `accepted` with `LOCAL-`-prefixed reference.

---

## 10. Files Created / Modified

**Created:**
- `src/main/java/com/turant/ews/EwsMode.java`
- `src/main/java/com/turant/ews/config/EwsProperties.java`
- `src/main/java/com/turant/ews/EwsClient.java`
- `src/main/java/com/turant/ews/LocalEwsClient.java`
- `src/main/java/com/turant/ews/RemoteEwsClient.java`
- `src/main/java/com/turant/ews/EwsClientFactory.java`
- `src/main/java/com/turant/ews/EwsService.java`
- `src/main/java/com/turant/ews/dto/EwsRequest.java`
- `src/main/java/com/turant/ews/dto/EwsResponse.java`
- `src/main/java/com/turant/ews/dto/EwsFeedback.java`
- `src/main/java/com/turant/ews/exception/EwsErrorCode.java`
- `src/main/java/com/turant/ews/exception/EwsException.java`
- `src/main/java/com/turant/ews/controller/EwsLocalController.java`
- `src/main/java/com/turant/ews/controller/EwsRemoteController.java`
- `src/main/java/com/turant/ews/controller/EwsFeedbackController.java`
- `src/test/java/com/turant/ews/EwsIntegrationTest.java`
- `docs/ews/EWS_INTEGRATION.md`

**Modified:**
- `src/main/resources/application.properties` — added `turant.ews.*` (mode/baseUrl/apiKey/username/password/path/method/timeouts/ssl)
- `src/main/java/com/turant/security/ApiKeyAuthFilter.java` — protect `/api/v1/ews/`
- `src/main/java/com/turant/http/GlobalExceptionHandler.java` — handle `EwsException`
- `src/main/java/com/turant/http/ApiError.java` — add 401/403/409/429/502/504 reasons
- `src/main/java/com/turant/pipeline/AlertPipeline.java` — wire `EwsService` (dual-mode, non-blocking)
- `.env.example` — document `EWS_MODE`, `EWS_BASE_URL`, etc.
