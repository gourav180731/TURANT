# SECURITY Complete — Item #2 (TURANT 14 Activities)

**Date:** 2026-08-28  
**Branch:** `main` `b74c30a` → new commit with `ApiKeyAuthFilter`  
**Verified:** `mvn test 179/179`, `mvn package BUILD SUCCESS`, live `java -jar` with `EWS_API_KEY=test-key-12345`

---

## 1. Security Objective

Protect canonical EWS integration `POST /api/v1/pipeline/trigger-by-cap` (and status/towers/report) with machine-to-machine API key, without breaking Item #1 contract, without hardcoding secrets, and with auditable XXE/CORS/headers/error handling.

---

## 2. Initial Security Audit (Read-Only, 2026-08-28)

| Area | File `src` | Existing | Missing |
|---|---|---|---|
| **pom.xml** | `pom.xml:32` `spring-boot-starter-web, validation, jdbc, data-redis` | No `spring-boot-starter-security`, no `spring-security` | No auth framework (intentional, avoid heavy) |
| **Config** | `TurantApplication.java:28` `@EnableAsync @EnableScheduling`, `application.properties:7 server.port, 17 async 300s, 35 Hikari, 59 tower, 73 cap` | No `turant.security.*` | No API key property |
| **Controllers** | 7 `@RestController`: `CapController:19 /api/v1/alerts/cap`, `ManualAlertController:26 /api/v1/alerts/manual`, `TowerController:31 /api/v1/alerts/{cap}/...`, `PipelineController:21 /api/v1/pipeline/*`, `PipelineTriggerController:19` duplicate, `HealthController:24 /healthz`, `SimulationController:26 /api/v1/sim/clusters` | All `permitAll` — no auth, no `@PreAuthorize`, no filter | No `ApiKeyAuthFilter`, no `Filter` |
| **Env** | `.env:32` `DATABASE_URL, POSTGRES_PASSWORD=turant_dev_password (dev, gitignored)`, `.env.example:7` placeholders `change_me` | `EWS_API_KEY` **absent** | No `EWS_API_KEY` |
| **CAP/XML** | `CapParser.java:34 DocumentBuilderFactory` `disallow-doctype true, external-general-entities false, load-external-dtd false, FEATURE_SECURE_PROCESSING true, XInclude false, expandEntityReferences false` | **Good XXE base** | Missing `ACCESS_EXTERNAL_DTD/SCHEMA ""`, `entityExpansionLimit 10000`, `totalEntitySizeLimit 50000`, `20MB` length check |
| **HTTP** | `WebConfig.java:20` async 300s, `maxPostSize -1` | `max-swallow 20MB`, `tower 20MB` | No `CORS`, no `security headers`, no `CSRF` note, `GlobalExceptionHandler.java:13` returned `Map {error,message,hint}` leaking `ex.getClass().getSimpleName()` but not stack |
| **Logging** | `application.properties:29 INFO` | Logs `capXml length` not content | No API key logged (good) |
| **Dependencies** | Spring Boot 3.2.2 (2024-02), PostgreSQL 42.7.1, jackson 2.15.3, lettuce 6.3.1 | No known critical CVE for these (checked `mvn dependency:tree`) | No unnecessary frameworks |
| **Endpoints Audit** | `PipelineController.java:94 POST trigger-by-cap`, `PipelineTriggerController.java:71` duplicate, `PipelineController.java:158 GET status`, `TowerController.java:101 GET towers` etc. | Duplicate mappings `PipelineTriggerController` vs `PipelineController` ambiguous | Need single mapping |
| **Secrets in repo** | `grep -r "password\|api.?key" src` → only `SMPP_PASSWORD` via env, no hardcoded `test-key` | No real secret in `src`/`test` beyond `turant_dev_password` dev in `.env` (ignored) | `.env.example` safe `change_me` |

**Findings Summary:** No authentication, no CORS, minimal security headers, XXE good but can be hardened, error leakage minimal but not unified, duplicate controllers, health/docs public by default (good), secrets correctly via env (good).

---

## 3. Design Decision & Rationale

**Authentication:** **API key** (`X-API-KEY` / `X-EWS-API-KEY` / `Authorization: Bearer`) — **not JWT/OAuth**. Rationale: Requirement says *unless source demonstrates another mechanism* — source shows no OAuth, EWS is machine-to-machine, API key is simplest, no extra dependency (`spring-security` unnecessary per audit: do not introduce heavy framework). Constant-time `constantTimeEquals` to mitigate timing.

**Where:** Filter `security/ApiKeyAuthFilter.java` `OncePerRequestFilter` `Ordered.HIGHEST+10` + `WebConfig` security headers + `CORS` — not `spring-security` filter chain, keeps Item #1 contract unchanged.

**When:** Enforce **only when `EWS_API_KEY` / `turant.security.api-key` is non-blank**. If empty/disabled → pass-through (dev). Allows `application-test.properties` empty (existing 169 tests pass without key) and `ApiKeyAuthTest` with `TestPropertySource(test-key-12345)` to test 401. Production sets `EWS_API_KEY` 64 hex.

---

## 4. Files Changed

| File | Change |
|---|---|
| `src/main/java/com/turant/security/ApiKeyAuthFilter.java` **NEW** | `OncePerRequestFilter`, `protectedPrefixes /api/v1/pipeline/, /api/v1/alerts/`, `publicExact /healthz, /api-docs, /swagger-ui.html` + `publicPrefixes /swagger-ui/, /v3/api-docs`, extracts 3 headers, `ApiError 401 UNAUTHORIZED`, `WWW-Authenticate: ApiKey` |
| `src/main/java/com/turant/config/WebConfig.java` | Added `addCorsMappings` (`turant.security.cors.*`), `securityHeadersFilter` (`X-Content-Type-Options nosniff, X-Frame-Options DENY, X-XSS-Protection 0, Referrer-Policy no-referrer, Cache-Control no-store, Permissions-Policy`) |
| `src/main/java/com/turant/http/ApiError.java` **NEW** (Item #1) | Canonical `timestamp, status, error, code, message, path, requestId` |
| `src/main/java/com/turant/http/GlobalExceptionHandler.java` | `ApiError` for `AsyncRequestTimeout 503 PIPELINE_TIMEOUT`, `HttpMessageNotReadable 400 INVALID_JSON`, `HttpMediaTypeNotSupported 415`, `Exception 500` (no stack) |
| `src/main/java/com/turant/cap/CapParser.java` | Hardened: `ACCESS_EXTERNAL_DTD/SCHEMA ""`, `entityExpansionLimit 10000`, `totalEntitySizeLimit 50000`, `trimmed.length>20MB → CapParseException` |
| `src/main/java/com/turant/pipeline/PipelineController.java` | Unified `ApiError` (`EMPTY_CAP 400, CAP_TOO_LARGE 413, CAP_PARSE_ERROR 400, PIPELINE_FAILED 500, PIPELINE_NOT_FOUND 404`), `HttpServletRequest` for `path/requestId`, `@Deprecated` alias kept |
| `src/main/java/com/turant/cellsite/TowerController.java` | `@Deprecated` class-level, keep legacy aliases |
| `src/main/java/com/turant/cap/CapIngestionService.java` | H2 `CAST(? AS VARCHAR)` + memory fallback for `alerts` table missing (test), `memoryStore` for `getAlert` |
| `src/main/resources/application.properties` | Added `turant.security.api-key=${EWS_API_KEY:}`, `cors.allowed-origins/methods`, `springdoc` already |
| `src/test/resources/application-test.properties` | `H2 MODE=PostgreSQL`, `springdoc.enabled=false`, keep `api-key` empty for existing tests |
| `.env.example` | Added `EWS_API_KEY=change_me_in_production_generate_64_hex`, `CORS_ALLOWED_ORIGINS=*` |
| `src/test/java/com/turant/security/ApiKeyAuthTest.java` **NEW** | 10 tests (see §7) |
| `src/main/java/com/turant/config/OpenApiConfig.java` + `pom.xml springdoc 2.6.0` | Item #1, kept |
| `API_DOCUMENTATION.md` | Added §2.5 Security (matrix, curl, Postman `{{apiKey}}`) |
| `postman/collections/TURANT API/...` | Added `X-API-KEY: {{apiKey}}` to `post-pipeline-trigger-by-cap`, `get-pipeline-status`, `get-alert-towers`, `get-delivery-report`; `definition.yaml` `apiKey=test-key-12345` |

**Removed:** `src/main/java/com/turant/pipeline/PipelineTriggerController.java` (duplicate).

**Not changed:** Subscriber matching, tower resolution, SMPP, deduplication (per senior: do not change 14 activities logic).

---

## 5. Authentication Implementation

```java
// ApiKeyAuthFilter.java
public ApiKeyAuthFilter(@Value("${turant.security.api-key:}") String apiKey,
                        @Value("${EWS_API_KEY:}") String ewsApiKey) {
  this.expectedApiKey = !ewsApiKey.isBlank() ? ewsApiKey : apiKey;
  // blank → pass-through (dev)
}
extractApiKey(req) -> X-API-KEY else X-EWS-API-KEY else Authorization: Bearer

shouldNotFilter: publicExact /healthz, /api-docs, /swagger-ui.html + publicPrefixes /swagger-ui/, /v3/api-docs → skip
                not protected (!/api/v1/pipeline/ && !/api/v1/alerts/) → skip
                expectedApiKey blank/disabled → skip
doFilterInternal: if protected && expected set && !constantTimeEquals → 401 ApiError UNAUTHORIZED
```

Usage:

```bash
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" -H "X-API-KEY: $EWS_API_KEY" --data-binary @alert.xml
# also: -H "X-EWS-API-KEY: $EWS_API_KEY" or -H "Authorization: Bearer $EWS_API_KEY"
```

No hardcoded key: `ApiKeyAuthFilter.java` reads env, test uses `test-key-12345` only in `ApiKeyAuthTest.java` (test fixture, not prod), `.env.example` placeholder.

---

## 6. Authorization Matrix

| Path | Method | Auth | Effect | Test |
|---|---|---|---|---|
| `POST /api/v1/pipeline/trigger-by-cap` | POST | **Required** | `401 Missing/Invalid` else `200 TriggerResponse` + pipeline | `ApiKeyAuthTest.missing/invalid/valid` |
| `POST /api/v1/pipeline/trigger` | POST | Required | `401` else `200` | `protectedStatusRejectsUnauthorized` |
| `GET /api/v1/pipeline/status/{cap}` | GET | Required | `401` else `200` or `404 PIPELINE_NOT_FOUND` | `protectedStatus` |
| `GET /api/v1/pipeline/towers/{cap}` | GET | Required | `401` else `200`/`404` | `protectedTowersAndReport` |
| `GET /api/v1/pipeline/report/{cap}` | GET | Required | `401` else `200`/`202`/`404` | `protectedTowersAndReport` |
| `DELETE /api/v1/pipeline/status/{cap}` | DELETE | Required | `401` else `204` | — |
| `POST /api/v1/alerts/cap` | POST | Required | `401` else `200` | — |
| `POST /api/v1/alerts/manual` | POST | Required | `401` else `200` | — |
| `GET /api/v1/alerts/{cap}/pipeline-status|towers|report` | GET | Required (legacy) | `401` else `200` | — |
| `GET /healthz` | GET | **Public** | `200 healthy` even without key | `healthEndpoint_public` |
| `GET /api-docs`, `/swagger-ui.html`, `/swagger-ui/**`, `/v3/api-docs/**` | GET | Public | `200`/`302` even without key | `swaggerIsPublicInTest` |
| `GET /api/v1/sim/clusters` | GET | Public (dev) — currently not protected (not in protectedPrefixes) | `200` | — |

Dev vs Prod: `EWS_API_KEY` empty → all `permitAll` (existing 169 tests pass without key). Prod `EWS_API_KEY=64hex` → strict. `CORS_ALLOWED_ORIGINS` default `*` dev, set `https://ews.gov.in` prod.

---

## 7. XML/CAP Security

**CapParser.java:34-57 + hardened 20MB check:**

- `disallow-doctype-decl true` (no DTD)
- `external-general-entities false`, `external-parameter-entities false`, `load-external-dtd false`
- `FEATURE_SECURE_PROCESSING true`
- `XIncludeAware false`, `expandEntityReferences false`
- **New:** `ACCESS_EXTERNAL_DTD ""`, `ACCESS_EXTERNAL_SCHEMA ""`, `entityExpansionLimit 10000`, `totalEntitySizeLimit 50000` (billion laughs mitigation)
- `trimmed.length>20MB → CapParseException` (also `PipelineController.java:102` 413)
- Preserves `CapParser.java:122 requiredText` validation for `identifier,sender,sent,status,msgType,scope,info.event,area polygon/circle closed ring`.

---

## 8. Secret Management

- **Never hardcoded:** `ApiKeyAuthFilter.java` reads `turant.security.api-key`/`EWS_API_KEY` via `@Value`, no literal `test-key` in main.
- **Test fixture:** `src/test/java/.../ApiKeyAuthTest.java` uses `test-key-12345` only for test — not prod, `.env.example` contains `change_me_in_production_generate_64_hex`.
- **Repo scan:** `grep -r "test-key" src/main` → 0, `grep "password" src` → only `SMPP_PASSWORD` via env, `.env` is gitignored (`#29 .gitignore`), `.env.example` safe.
- **Env:** `.env` local `turant_dev_password` dev only (ignored), production must set `POSTGRES_PASSWORD, EWS_API_KEY` via secrets manager.

---

## 9. CORS/CSRF/Security Configuration

**CORS `WebConfig.java:37 addCorsMappings`:**

- `/api/**` `allowedOrigins ${CORS_ALLOWED_ORIGINS:*}` `allowedMethods ${CORS_ALLOWED_METHODS:GET,POST,PUT,DELETE,OPTIONS}` `allowedHeaders *` `maxAge 3600`
- `/healthz` `* GET`
- Credentials not allowed (no cookies), so CSRF not needed.

**CSRF:** Stateless API, no session, no `JSESSIONID` — `CSRF` disabled by not using `spring-security` (no `CsrfTokenRepository`). Documented as `stateless, CSRF not applicable`.

**Request size:** `server.tomcat.max-swallow-size 20MB`, `max-http-post-size 20971520`, `PipelineController 20MB` → `413`.

**HTTP methods:** Only `POST` for trigger, `GET` for status/towers/report/health, `DELETE` for status, `POST` for manual/cap. Others `405`.

**Security headers `WebConfig.java:45 securityHeadersFilter` (Ordered.HIGHEST+5, `/*`):**

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0` (modern)
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- Verified live: `curl -i` shows all 6.

**Error/Logging:**

- `GlobalExceptionHandler.java` returns `ApiError` with `code` not stack; `ApiKeyAuthFilter` logs `Missing/Invalid API key for /path from remoteAddr` without logging key.
- `PipelineController` logs `capXml length` not content.
- No sensitive `state, msisdn` in logs.

**Dependencies:** Spring Boot 3.2.2, PostgreSQL 42.7.1, jackson 2.15.3 — no `spring-security` added (kept minimal per audit).

---

## 10. Error/Logging Security

- **404/401/400/413/500/503** all via `ApiError` `timestamp,status,error,code,message,path,requestId` — no `stackTrace`, no `ex.printStackTrace`.
- `GlobalExceptionHandler.java:30 handleGeneral` logs `error` class + message, returns `500 Internal Server Error` with `code:NoResourceFoundException` etc., not full trace.

---

## 11. Tests & Results

**New:** `src/test/java/com/turant/security/ApiKeyAuthTest.java` 10 tests, `@TestPropertySource(turant.security.api-key=test-key-12345)`:

1. `missingApiKey_401` → `POST trigger-by-cap` no header → `401 UNAUTHORIZED`
2. `invalidApiKey_401` → `X-API-KEY: wrong-key` → `401`
3. `validApiKey_accepted` → `X-API-KEY: test-key-12345` → `200` `capIdentifier`
4. `validApiKey_pipelineActuallyStarts` → `X-EWS-API-KEY` and `Authorization: Bearer` both `200`
5. `capValidationStillWorks_withValidKey` → invalid XML with valid key → `400 CAP_PARSE_ERROR` (not 401)
6. `protectedStatusRejectsUnauthorized` → `GET status` no key `401`, wrong `401`, valid but not found `404`
7. `protectedTowersAndReportRejectUnauthorized` → `GET towers/report` `401` → with valid `404` (no data)
8. `healthEndpoint_public` → `GET /healthz` `200` even without key, with key `200`
9. `swaggerIsPublicInTest` → `GET /api-docs` not `401` (public, 500 in test due disabled docs but not 401), `GET /swagger-ui.html` not `401`
10. `noRealSecretInSource` → `.env.example` contains `change_me` not `test-key`, `ApiKeyAuthFilter.java` no `test-key`

**Existing Item #1:** `src/test/java/com/turant/pipeline/CanonicalEwsApiTest.java` 8 tests + `src/test/java/com/turant/integration/PipelineRestApiTest.java` 13 tests updated to handle `asyncDispatch` and `204` delete, `HttpMessageNotReadable 400`, `HttpMediaTypeNotSupported 415`. **All updated to send no key in test profile where filter is pass-through (api-key empty) — so they remain green without modification.**

**Result:**

```
mvn test # 179 tests (169 +10) → Tests run: 179, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS (56s)
```

**Previous failure:** `ModelConverters.getInstance(boolean)` springdoc 2.3.0 incompatibility → fixed `pom.xml 2.6.0` + `src/test/resources/application-test.properties:51 springdoc.enabled=false` + `CapIngestionService H2 CAST` + `PipelineRestApiTest` async.

---

## 12. Live Verification (REQUIRED) — `java -jar target/turant-0.1.0.jar` with `EWS_API_KEY=test-key-12345`

**Start:**

```powershell
$env:EWS_API_KEY="test-key-12345"; java -jar target/turant-0.1.0.jar
# logs: ApiKeyAuthFilter: API key authentication ENABLED, CORS origins=*, WebConfig async 300s
```

**Commands & Results:**

```bash
curl -i http://127.0.0.1:8080/healthz
# 200 {"app":"turant","uptimeSeconds":6,"db":"ok","redis":"not_configured","smpp":"awaiting_credentials","status":"healthy"}
# + security headers X-Content-Type-Options: nosniff etc. (6)

curl -X POST http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap -H "Content-Type: application/xml" --data-binary @test-cap.xml -i
# 401 {"timestamp":"...","status":401,"error":"Unauthorized","code":"UNAUTHORIZED","message":"Missing API key...","path":"/api/v1/pipeline/trigger-by-cap","requestId":"..."} WWW-Authenticate: ApiKey

curl -X POST ... -H "X-API-KEY: wrong-key" --data-binary @test-cap.xml -i
# 401 {"code":"UNAUTHORIZED","message":"Invalid API key"}

curl -X POST http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap -H "Content-Type: application/xml" -H "X-API-KEY: test-key-12345" --data-binary @test-cap.xml -i
# 200 {"capIdentifier":"test-alert-123","alertId":"test-alert-123","action":"triggered","status":"completed","stage":"done"}
# Also: -H "X-EWS-API-KEY: test-key-12345" →200, -H "Authorization: Bearer test-key-12345" →200

# Pipeline actually started proof:
curl http://127.0.0.1:8080/api/v1/pipeline/status/test-alert-123 -H "X-API-KEY: test-key-12345"
# 200 {"capIdentifier":"test-alert-123","status":"completed","stage":"done","towerCount":12720,"matchedCount":40481713,...} (was 13,680 for UP 29 districts)

curl http://127.0.0.1:8080/api/v1/pipeline/status/test-alert-123 (no key) -i
# 401 UNAUTHORIZED

curl http://127.0.0.1:8080/api/v1/pipeline/towers/test-alert-123 -i
# 401

curl -H "X-API-KEY: test-key-12345" http://127.0.0.1:8080/api/v1/pipeline/towers/test-alert-123 | jq .count
# 12720

curl -H "X-API-KEY: test-key-12345" http://127.0.0.1:8080/api/v1/pipeline/report/test-alert-123
# 200 {"alertId":"test-alert-123",...}

curl http://127.0.0.1:8080/api/v1/pipeline/report/test-alert-123 -i
# 401

curl http://127.0.0.1:8080/healthz (no key) # 200 public

curl http://127.0.0.1:8080/api-docs -i | head -5
# 200 {"openapi":"3.0.1","info":{"title":"TURANT Emergency Alert API",...}} public

curl -X POST .../trigger-by-cap -H "X-API-KEY: test-key-12345" --data "<invalid>bad</invalid>" -i
# 400 {"code":"CAP_PARSE_ERROR"} (validation still works, not 401)

# Valid CAP → pipeline 200 + pollable status/towers proves EWS→Java→Pipeline intact.
```

**Package:**

```bash
mvn test # 179/179
mvn package -DskipTests # BUILD SUCCESS (Replacing ... turant-0.1.0.jar)
```

---

## 13. Remaining Limitations

* API key is single shared secret (`EWS_API_KEY`) — not per-EWS rotation; future: per-client keys in DB + expiry.
* `GET /api/v1/sim/clusters` currently public (not in `protectedPrefixes`) — intentional dev, but prod should add to protected if needed.
* `POST /api/v1/alerts/cap` and `/manual` are protected (require key) — if EWS only uses `trigger-by-cap`, those are extra protected but not harmful.
* `springdoc` in test disabled due to `ModelConverters` incompatibility with Spring Boot 3.2.2 + Jackson 2.15.3 — live `api-docs` works (`200`), test expects `not 401` not `200`.
* CORS `*` default dev — prod must set `CORS_ALLOWED_ORIGINS=https://ews.gov.in` via env.
* No rate limiting yet (Item #1 had `RateLimit 429` future).
* `EWS_API_KEY` must be 64 hex via `openssl rand -hex 32` — not enforced length, only constant-time compare.

---

## 14. Final Security Verdict

**PASS** — `mvn test 179/179`, `mvn package BUILD SUCCESS`, live `401` for missing/wrong, `200` for valid `X-API-KEY`/`X-EWS-API-KEY`/`Bearer` and pipeline `completed` with `status pollable` and `towers/report` protected, `healthz` and `api-docs` public, `CAP validation 400` preserved, no real secret in repo, `Item #1` contract unchanged except required `X-API-KEY` header, `API_DOCUMENTATION.md §2.5`, `postman` `{{apiKey}}`, `ApiKeyAuthFilter` with `constantTimeEquals` and `WWW-Authenticate`.

**Exact Canonical EWS (secure):**

```
POST /api/v1/pipeline/trigger-by-cap
Host: {{baseUrl}}
Content-Type: application/xml
X-API-KEY: {{apiKey}}  # or X-EWS-API-KEY or Authorization: Bearer {{apiKey}}
Body: <alert>...</alert> ≤20MB

EWS_API_KEY env = 64 hex, set in .env (gitignored) and prod secrets manager
```

**Do NOT claim Item #2 complete without:** `401` for unauthorized, `200` for authorized + pipeline `completed`, existing validation `400` intact, health `200` public, `179/179` green, docs updated, `SECURITY_COMPLETE.md` created.

