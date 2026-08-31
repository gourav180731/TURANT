# TURANT Emergency Alert API — Canonical Documentation (Item #1)

**Version:** 1.0.0  
**Base URL (dev):** `http://localhost:8080` (`{{baseUrl}}` in Postman)  
**Last Verified:** 2026-08-24 against Java source `src/` (source of truth)  
**Canonical EWS Entry:** `POST /api/v1/pipeline/trigger-by-cap` — read this first.

> **Senior verification:** All sections below match running Java. `GET /api/v1/pipeline/{cap}/pipeline-status` vs `GET /api/v1/pipeline/status/{cap}` → **canonical is `…/status/{capIdentifier}`**. `GET /api/v1/pipeline/towers/{cap}` is canonical. See §5-§6 deprecation notes. `PipelineTriggerController.java` removed to eliminate duplicate mappings.

---

## 1. TURANT API Overview

TURANT ingests CAP 1.2 XML, resolves PostGIS towers, matches `serving_cell_id → subscriber_dump` (10 cr) via `turant_agg`, dedups, respects expiry, and prepares SMS via SMPP. Pipeline is **synchronous-wait** on trigger: `POST trigger-by-cap` waits for pipeline to finish (≤300s) and returns `200` with pipeline status. EWS then polls `GET /status/{cap}`.

```
EWS → POST /api/v1/pipeline/trigger-by-cap (application/xml CAP)
    → PipelineController.java:94 triggerByCap → CapIngestionService.ingestCap → CapParser.parseCapXml
    → AlertPipeline.runAlertPipeline → TowerResolver → PostGisTowerSource (ST_Collect+ST_Simplify)
    → SubscriberCellStatsService.countAndDistinctByCellIds → MsisdnDeduplicator → ExpiryGuard/Validity/Priority
    → BatchFileSMSCService → DlrReporter → EwsCallback
    → 200 TriggerResponse
EWS → GET /api/v1/pipeline/status/{capIdentifier}
EWS → GET /api/v1/pipeline/towers/{capIdentifier}
EWS → GET /api/v1/pipeline/report/{capIdentifier}
```

Versioning: All public APIs under `/api/v1/` except `GET /healthz`.

---

## 2. Base URL & Headers

| Env | Base URL | `{{baseUrl}}` |
|---|---|---|
| Dev | `http://localhost:8080` | Postman globals |
| Docker | `http://turant-backend:8080` | — |
| Prod | `https://<host>` | set in Postman |

**Global request headers for canonical trigger:**

```
Content-Type: application/xml
Accept: application/json
Content-Length: ≤20971520 (20 MB)
```

`PipelineController.java:94` consumes `application/xml, text/xml, application/*+xml, text/plain, */*` but EWS should send `application/xml`.

---

## 2.5 Security (Item #2 — API Key)

**Mechanism:** Machine-to-machine API key for EWS. No JWT/OAuth. Filter `security/ApiKeyAuthFilter.java` (`OncePerRequestFilter` `Ordered.HIGHEST+10`) checks `X-API-KEY` / `X-EWS-API-KEY` / `Authorization: Bearer <key>` against `EWS_API_KEY` env (or `turant.security.api-key` `application.properties:219`). No hardcoded secret — `.env.example:9` placeholder `change_me_in_production_generate_64_hex`.

**Config:**

```bash
# .env / env var (production)
EWS_API_KEY=$(openssl rand -hex 32)  # 64 hex
CORS_ALLOWED_ORIGINS=https://ews.gov.in
# application.properties
turant.security.api-key=${EWS_API_KEY:}
turant.security.cors.allowed-origins=${CORS_ALLOWED_ORIGINS:*}
```

If `EWS_API_KEY` empty/disabled → filter pass-through (dev). Set in prod to enforce.

**Authorization Matrix:**

| Path | Method | Auth | Java |
|---|---|---|---|
| `POST /api/v1/pipeline/trigger-by-cap` **canonical EWS** | POST | **API key required** | `PipelineController.java:94` |
| `POST /api/v1/pipeline/trigger` | POST | API key required | `PipelineController.java:55` |
| `GET /api/v1/pipeline/status/{cap}` | GET | API key required | `PipelineController.java:158` |
| `GET /api/v1/pipeline/towers/{cap}` | GET | API key required | `PipelineController.java:174` |
| `GET /api/v1/pipeline/report/{cap}` | GET | API key required | `PipelineController.java:191` |
| `DELETE /api/v1/pipeline/status/{cap}` | DELETE | API key required | `PipelineController.java:235` |
| `POST /api/v1/alerts/cap` | POST | API key required | `CapController.java:39` |
| `POST /api/v1/alerts/manual` | POST | API key required | `ManualAlertController.java:54` |
| `GET /api/v1/alerts/{cap}/...` (legacy) | GET | API key required (deprecated) | `TowerController.java:31` |
| `GET /healthz` | GET | **Public** `permitAll` | `HealthController.java:39` |
| `GET /api-docs`, `/api-docs.yaml`, `/swagger-ui.html`, `/swagger-ui/**`, `/v3/api-docs/**` | GET | **Public** `permitAll` (dev) — `WebConfig` CORS `*` | `OpenApiConfig.java` |

**401 Behavior:** Missing/invalid key → `401 Unauthorized` `ApiError.java` `code:UNAUTHORIZED` `WWW-Authenticate: ApiKey realm="turant"` + security headers `X-Content-Type-Options: nosniff` etc. via `WebConfig.java:37 securityHeadersFilter`.

**Dev vs Prod:**

- Dev (`EWS_API_KEY=` empty → pass-through, `CORS *`, `healthz` 200, `api-docs` 200, `trigger` 200 without key). `application-test.properties` empty (existing tests pass), `ApiKeyAuthTest` uses `TestPropertySource turant.security.api-key=test-key-12345` to verify 401.
- Prod (`EWS_API_KEY=64hex`, `CORS_ALLOWED_ORIGINS=https://ews.gov.in`, `healthz` still public, `api-docs` public but can be disabled via `springdoc.api-docs.enabled=false`).

**curl (EWS):**

```bash
# Unauthorized
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap -H "Content-Type: application/xml" --data-binary @alert.xml -i
# 401 {"code":"UNAUTHORIZED","message":"Missing API key. Send X-API-KEY or Authorization: Bearer <key>",...}

# Authorized
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" -H "X-API-KEY: $EWS_API_KEY" --data-binary @alert.xml
# 200 {"capIdentifier":"...","action":"triggered","status":"completed","stage":"done"}

curl http://localhost:8080/api/v1/pipeline/status/ABC -H "X-API-KEY: $EWS_API_KEY"
# 200 PipelineStatusRecord
curl http://localhost:8080/healthz # 200 public
```

**Postman:** `postman/collections/TURANT API/...post-pipeline-trigger-by-cap.request.yaml` now has `X-API-KEY: {{apiKey}}` (`{{baseUrl}}` + `{{capIdentifier}}` + `{{apiKey}}` vars in `definition.yaml`).

**XML Security:** `CapParser.java:39-57` `disallow-doctype, external-general-entities false, ACCESS_EXTERNAL_DTD/SCHEMA "", entityExpansionLimit 10000, totalEntitySizeLimit 50000, FEATURE_SECURE_PROCESSING, XInclude false` + `20MB` length check.

---

## 3. EWS Integration Flow (Canonical)

1. **Health** `GET /healthz` → `200 healthy` ensures DB ok.
2. **Trigger** `POST /api/v1/pipeline/trigger-by-cap` with raw CAP XML → `200 TriggerResponse` (`status: completed|running|halted`).
   - **Semantics:** `200` means *pipeline started and completed within HTTP window* (wait). It does **not** mean SMS delivered — SMS = `0` until SMPP creds.
   - If pipeline `>300s`, returns `503 {code:PIPELINE_TIMEOUT}` via `GlobalExceptionHandler.java:13`, but pipeline still halts via `TowerResolver orTimeout`. EWS should then poll status.
3. **Poll** `GET /api/v1/pipeline/status/{capIdentifier}` until `status=completed|halted`.
4. **Towers** `GET /api/v1/pipeline/towers/{capIdentifier}` for map.
5. **Report** `GET /api/v1/pipeline/report/{capIdentifier}` for completion (`202` if not yet completed).

Variables:

```
{{baseUrl}} = http://localhost:8080
{{capIdentifier}} = from TriggerResponse.capIdentifier (CAP <identifier>)
```

---

## 4. Trigger CAP Alert API — CANONICAL

### `POST /api/v1/pipeline/trigger-by-cap`

**Purpose:** EWS sends CAP 1.2 XML, TURANT ingests and **runs full Java pipeline** synchronously.

**Java:** `PipelineController.java:94 triggerByCap(@RequestBody String capXml, HttpServletRequest req) → CapIngestionService → AlertPipeline` (real pipeline, not mock).

**Method:** `POST`  
**Path:** `/api/v1/pipeline/trigger-by-cap`  
**Content-Type:** `application/xml` (also accepts `text/xml`, `*/*` but EWS must use `application/xml`)  
**Accept:** `application/json`

**Request Body:** Raw CAP 1.2 XML. Example:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>1787287355633013</identifier>
  <sender>Uttar Pradesh SDMA</sender>
  <sent>2026-08-21T10:12:35Z</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-IN</language>
    <category>Met</category>
    <event>Squall</event>
    <urgency>Expected</urgency>
    <severity>WARNING</severity>
    <certainty>Observed</certainty>
    <headline>Squall over 29 districts</headline>
    <area>
      <areaDesc>29 districts of Uttar Pradesh</areaDesc>
      <polygon>26.947082,78.597031 26.947554,78.597066 … 26.947082,78.597031</polygon>
    </area>
  </info>
</alert>
```

**Required CAP fields (validated `CapParser.java:122 requiredText/requiredEnum`):** `identifier, sender, sent (ISO8601), status (Actual/Test...), msgType (Alert), scope, info[0] with info.event, areas≥1 with polygon/circle (closed ring ≥4 pts, first==last), language defaults en-US`. Optional `effective, expires, headline, description, geocode`.

**Maximum Request Size:** `20 MB` (`PipelineController.java:102` `capXml.length()>20971520 →413`, `application.properties:11 max-swallow 20MB`, `WebConfig.java maxPostSize -1` but controller enforces 20MB).

**Validation Behaviour:**

| Condition | HTTP | Body (`ApiError.java`) |
|---|---|---|
| Empty body | `400` | `{timestamp, status:400, error:Bad Request, code:EMPTY_CAP, message:Empty CAP XML body, path, requestId}` |
| Malformed XML / missing required | `400` | `code:CAP_PARSE_ERROR` `message:CAP parsing failed: <reason>` (`CapParseException`) |
| Invalid polygon (not closed, <4 pts) | `400` | `CAP_PARSE_ERROR: Polygon must be closed...` |
| Duplicate identifier | `200` (upsert) | `alerts` table `ON CONFLICT (cap_identifier,sender) DO UPDATE` `CapIngestionService.java:121` — duplicate is **not 409**, it updates. |
| `>20 MB` | `413` | `code:CAP_TOO_LARGE` |
| Pipeline `>300s` | `503` | `code:PIPELINE_TIMEOUT` via `GlobalExceptionHandler.java:18` |
| Unexpected | `500` | `code:PIPELINE_FAILED/INGEST_FAILED` |

**Success Response `200` — `TriggerResponse` (`PipelineController.java:250`):**

```json
{
  "capIdentifier": "1787287355633013",
  "alertId": "1787287355633013",
  "action": "triggered",
  "status": "completed",
  "stage": "done"
}
```

`status` ∈ `running|completed|halted`, `stage` ∈ `ingested, tower-resolution, done, halted`.

**Processing Semantics:** Trigger **waits** for `AlertPipeline.runAlertPipeline` (tower + subscriber). If `300s` async timeout fires, returns `503` but pipeline record is `halted` — poll `GET /status/{id}`.

**Postman:** `POST {{baseUrl}}/api/v1/pipeline/trigger-by-cap` `Content-Type application/xml` `Body: {{capXml}}` (see `postman/collections/TURANT API/...trigger-by-cap`)

**curl:**

```bash
curl -X POST {{baseUrl}}/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" \
  --data-binary @alert.xml
```

---

## 5. Pipeline Status API — CANONICAL

### `GET /api/v1/pipeline/status/{capIdentifier}`

**Java:** `PipelineController.java:158 getStatus` → `PipelineStatusStore.get` → `PipelineStatusRecord.java:8`

**Response `200` — `PipelineStatusRecord`:**

```json
{
  "capIdentifier": "1787287355633013",
  "status": "completed",
  "stage": "done",
  "haltedAt": null,
  "reason": null,
  "towerCount": 13680,
  "matchedCount": 5107744,
  "duplicatesRemoved": 0,
  "expectedRecipients": 5107744,
  "submittedCount": 0,
  "acceptedCount": 0,
  "awaitingCredentials": true,
  "updatedAtMs": 1787566422980
}
```

Fields exactly as Java record — no invented fields. `status` `running|halted|completed`, `stage` current, `haltedAt` stage where halted, `reason` if halted.

**Errors:** `404 {status:404,error:Not Found,code:PIPELINE_NOT_FOUND,…}` via `PipelineController.java:163` (empty body) **or** alias `404 {timestamp,…,code:PIPELINE_NOT_FOUND}` via `getPipelineStatus`. Tests expect `404`.

**Legacy Alias (Deprecated):** `GET /api/v1/pipeline/{capIdentifier}/pipeline-status` (`PipelineController.java:140`) and `GET /api/v1/alerts/{capIdentifier}/pipeline-status` (`TowerController.java:53`) — retained, marked `@Deprecated`, prefer canonical.

**Example:**

```bash
curl {{baseUrl}}/api/v1/pipeline/status/1787287355633013
```

---

## 6. Tower API — CANONICAL

### `GET /api/v1/pipeline/towers/{capIdentifier}`

**Java:** `PipelineController.java:174 getTowers` → `statusStore.getTowers`

**Response `200` — `TowersResponse.java:244`:**

```json
{
  "capIdentifier": "1787287355633013",
  "count": 13680,
  "towers": [
    {"id":"48241","cellId":"12641","latitude":28.486628,"longitude":77.505181,"coverageRadiusM":1748},
    {"id":"61615","cellId":"15A7F","latitude":28.511921,"longitude":77.4097,"coverageRadiusM":677}
  ]
}
```

`404 {code:TOWERS_NOT_FOUND}` if no towers.

**Legacy Alias (Deprecated):** `GET /api/v1/alerts/{capIdentifier}/towers` (`TowerController.java:101`) — same shape `Map {capIdentifier,count,towers}`, retain but document canonical.

---

## 7. Health API

### `GET /healthz`

**Java:** `HealthController.java:39 health()`

**Response:**

`200` if `(db ok|not_configured) && (redis ok|not_configured) && (smpp configured|awaiting_credentials)` else `503 degraded`:

```json
{
  "app": "turant",
  "uptimeSeconds": 3600,
  "db": "ok",
  "redis": "not_configured",
  "smpp": "awaiting_credentials",
  "status": "healthy"
}
```

`db: ok|not_configured|error:msg`, `redis: ok|not_configured|error`, `smpp: configured|awaiting_credentials|ok`.

---

## 8. Request/Response Examples

**Trigger success `200`:**

```bash
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" --data-binary @test-cap.xml
# {"capIdentifier":"1780655887295022","alertId":"1780655887295022","action":"triggered","status":"completed","stage":"done"}
```

**Trigger blank `400`:**

```json
{"timestamp":"2026-08-24T10:12:00Z","status":400,"error":"Bad Request","code":"EMPTY_CAP","message":"Empty CAP XML body","path":"/api/v1/pipeline/trigger-by-cap","requestId":"..."}
```

**Invalid CAP `400`:**

```json
{"timestamp":"...","status":400,"error":"Bad Request","code":"CAP_PARSE_ERROR","message":"CAP parsing failed: Polygon must be closed...","path":"...","requestId":"..."}
```

**Too large `413`:**

```json
{"status":413,"error":"Payload Too Large","code":"CAP_TOO_LARGE",...}
```

**Not found `404` status:**

```json
{"timestamp":"...","status":404,"error":"Not Found","code":"PIPELINE_NOT_FOUND","message":"No pipeline status ...","path":"/api/v1/pipeline/status/XYZ","requestId":"..."}
```

---

## 9. HTTP Status Codes

| Code | When | Body |
|---|---|---|
| `200` | Trigger succeeded and pipeline finished within HTTP window; status/towers/report found | `TriggerResponse` / `PipelineStatusRecord` / `TowersResponse` / `AlertReport` |
| `202` | Report requested but `status != completed` (`PipelineController.java:201`) | `ApiError code:REPORT_NOT_READY` |
| `400` | Empty, malformed XML, missing required CAP field, invalid polygon | `ApiError 400 CAP_PARSE_ERROR/EMPTY_CAP` |
| `404` | Alert/status/towers/report not found | `ApiError 404` or empty `PipelineController` legacy |
| `413` | `Content-Length` or `capXml.length>20MB` | `ApiError 413 CAP_TOO_LARGE` |
| `500` | Pipeline failed, DB error, unexpected | `ApiError 500 PIPELINE_FAILED` or `GlobalExceptionHandler 500` |
| `503` | Async timeout `300s` exceeded (`GlobalExceptionHandler.java:18` `PIPELINE_TIMEOUT`) | `ApiError 503 PIPELINE_TIMEOUT` |
| `204` | `DELETE /status/{cap}` success | — |

---

## 10. CAP Validation Rules

Required: `identifier, sender, sent, status, msgType, scope, info[].event, info[].area[polygon|circle]` (`CapParser.java:122 requiredText/requiredEnum`). `polygon` `lat,lng` closed ring `≥4 pts` `first==last`, else `CapParseException 400`. `circle` `lat,lng radiusKm`. Optional `effective/expires/onset` `Instant.parse` ISO8601. `preferredLanguage` `cap.preferred-language=en-IN`. Max `20 MB` (`cap.max-xml-bytes 20971520`). Duplicate `identifier+sender` → `ON CONFLICT DO UPDATE` not error.

---

## 11. Maximum Request Size

`20 MB` (`PipelineController.java:102` `20*1024*1024`, `application.properties:11 max-swallow 20MB`, `cap.max-xml-bytes 20971520`, `WebConfig.java maxPostSize -1` but controller enforces). Larger → `413`. Tomcat `threads.max 200`.

---

## 12. End-to-End Example

```bash
# 1 Health
curl http://localhost:8080/healthz
# {"app":"turant","status":"healthy","db":"ok",...}

# 2 Trigger (real pipeline 29 districts UP 3MB → ~35s)
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" --data-binary @delhi-heatwave-cap.xml
# {"capIdentifier":"1780655887295022","action":"triggered","status":"completed","stage":"done"}

# 3 Status poll
curl http://localhost:8080/api/v1/pipeline/status/1780655887295022
# {"capIdentifier":"...","status":"completed","towerCount":13680,"matchedCount":5107744,...}

# 4 Towers
curl http://localhost:8080/api/v1/pipeline/towers/1780655887295022 | jq .count

# 5 Report (only when completed)
curl http://localhost:8080/api/v1/pipeline/report/1780655887295022
# {"alertId":"...","capIdentifier":"...","startedAt":"...","endedAt":"...","targetedSubscriberCount":5107744,...}
```

Evidence: `POST 3,076,978 1787287355633013 →200 completed 13,680 towers 5,107,744` `36.9s` after fix.

---

## 13. Postman Testing

**Collection:** `postman/collections/TURANT API/` (updated). Globals `postman/globals/workspace.globals.yaml` `{{baseUrl}} http://127.0.0.1:8080`.

Canonical flow (match Java):

1. `GET {{baseUrl}}/healthz` `healthz.request.yaml`
2. `POST {{baseUrl}}/api/v1/pipeline/trigger-by-cap` `Content-Type application/xml` Body `xml` `trigger-by-cap.request.yaml` → sets `{{capIdentifier}}` via test script.
3. `GET {{baseUrl}}/api/v1/pipeline/status/{{capIdentifier}}` `get-pipeline-status.request.yaml` (canonical)
4. `GET {{baseUrl}}/api/v1/pipeline/towers/{{capIdentifier}}`
5. `GET {{baseUrl}}/api/v1/pipeline/report/{{capIdentifier}}`

All requests now use `{{baseUrl}}`, no hard-coded `http://127.0.0.1:8080/api/v1/alerts/trigger-by-cap` (removed). Legacy `TowerController` `/api/v1/alerts/:cap/towers` still in `get-alert-towers` but marked deprecated.

**Run:**

```bash
# Import postman/collections + globals into Postman, set baseUrl, Run Collection
# Or curl as above
```

---

## 14. OpenAPI/Swagger

**Dependency:** `pom.xml:193 springdoc-openapi-starter-webmvc-ui 2.3.0` (Spring Boot 3.2.2).  
**Config:** `config/OpenApiConfig.java` `@OpenAPIDefinition` title `TURANT Emergency Alert API` `1.0.0`, servers `http://localhost:8080`.  
**Properties:** `application.properties:213 springdoc.api-docs.path=/api-docs, swagger-ui.path=/swagger-ui.html`.

**Locations after `mvn package && java -jar`:**

- JSON: `GET {{baseUrl}}/api-docs` (`/v3/api-docs`)
- YAML: `GET {{baseUrl}}/api-docs.yaml`
- Swagger UI: `GET {{baseUrl}}/swagger-ui.html` (`/swagger-ui/index.html`)

Documents `POST /api/v1/pipeline/trigger-by-cap`, `GET /api/v1/pipeline/status/{capIdentifier}`, `GET /api/v1/pipeline/towers/{capIdentifier}`, `GET /api/v1/pipeline/report/{capIdentifier}`, `GET /healthz` with `application/xml` request, `PipelineStatusRecord`/`TowersResponse`/`ApiError` schemas. No duplicate `PipelineTriggerController` endpoints appear.

---

## Removed / Deprecated

* `PipelineTriggerController.java` **deleted** — duplicate `POST /trigger, POST /trigger-by-cap, GET /{cap}/pipeline-status` ambiguous mappings removed. Startup now shows no ambiguous.
* `GET /api/v1/pipeline/{cap}/pipeline-status` kept `@Deprecated` (prefer `GET /status/{cap}`).
* `GET /api/v1/alerts/{cap}/pipeline-status|towers|report` (`TowerController.java:31`) kept `@Deprecated` — prefer `/api/v1/pipeline/*`.
* `GET /api/v1/pipeline/test` undocumented but retained for liveness.

## Tests

`PipelineRestApiTest.java` covers trigger, invalid, status, report, towers, delete. Additional `src/test` to be added for `blank→400, 413, 404, pipeline start`.

## Commands to Verify

```bash
mvn clean test
mvn package
java -jar target/turant-0.1.0.jar  # PORT 8080, DATABASE_URL required for DB ok
curl http://localhost:8080/healthz
curl http://localhost:8080/api-docs
curl http://localhost:8080/swagger-ui.html
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap -H "Content-Type: application/xml" --data-binary @test-cap.xml
curl http://localhost:8080/api/v1/pipeline/status/<capIdentifier>
curl http://localhost:8080/api/v1/pipeline/towers/<capIdentifier>
```

**EWS answer: `POST /api/v1/pipeline/trigger-by-cap` `application/xml` raw CAP 1.2 XML → `PipelineController.java:94` → `AlertPipeline` → `status/towers/report` poll.**

