# REST API Endpoints - FIXED ✅

## Issue Resolution

**Problem**: `PipelineTriggerController` was not being registered by Spring Boot due to:
1. Invalid use of `@Autowired(required = false)` on constructor parameter
2. Controller mapping conflicts with multiple controllers using `/api/v1/alerts` base path

**Solution**: Consolidated all pipeline endpoints into `PipelineController` using `/api/v1/pipeline` base path.

## Working Endpoints

### 1. Test Endpoint (NEW)
```
GET http://127.0.0.1:8080/api/v1/pipeline/test
```
**Response**: `Pipeline controller is working`

---

### 2. Trigger Pipeline with CAP XML ✅ FIXED
```
POST http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap
Content-Type: application/xml

<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-alert-123</identifier>
  <sender>test@example.com</sender>
  <sent>2026-08-20T10:00:00Z</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-US</language>
    <category>Safety</category>
    <event>Test Emergency Alert</event>
    <urgency>Immediate</urgency>
    <severity>Extreme</severity>
    <certainty>Observed</certainty>
    <effective>2026-08-20T10:00:00Z</effective>
    <expires>2026-08-20T12:00:00Z</expires>
    <senderName>TURANT Test System</senderName>
    <headline>Test Heat Wave Alert</headline>
    <description>This is a test alert</description>
    <area>
      <areaDesc>Test Zone</areaDesc>
      <polygon>28.6,77.2 28.7,77.2 28.7,77.3 28.6,77.3 28.6,77.2</polygon>
    </area>
  </info>
</alert>
```

**Response**:
```json
{
  "capIdentifier": "test-alert-123",
  "alertId": "test-alert-123",
  "action": "triggered",
  "status": "completed",
  "stage": "done"
}
```

---

### 3. Get Pipeline Status ✅ FIXED
```
GET http://127.0.0.1:8080/api/v1/pipeline/{capIdentifier}/pipeline-status
```

**Example**:
```
GET http://127.0.0.1:8080/api/v1/pipeline/test-alert-123/pipeline-status
```

**Response**:
```json
{
  "capIdentifier": "test-alert-123",
  "status": "completed",
  "stage": "done",
  "haltedAt": null,
  "reason": null,
  "towerCount": 34,
  "matchedCount": 0,
  "duplicatesRemoved": 0,
  "expectedRecipients": 0,
  "submittedCount": 0,
  "acceptedCount": 0,
  "awaitingCredentials": true,
  "updatedAtMs": 1787224112752
}
```

---

### 4. Trigger Pipeline for Existing Alert
```
POST http://127.0.0.1:8080/api/v1/pipeline/trigger
Content-Type: application/json

{
  "capIdentifier": "test-alert-123",
  "alertId": "test-alert-123"
}
```

---

### 5. Get Status (Alternative Endpoint)
```
GET http://127.0.0.1:8080/api/v1/pipeline/status/{capIdentifier}
```

---

### 6. Get Towers for Alert
```
GET http://127.0.0.1:8080/api/v1/pipeline/towers/{capIdentifier}
```

---

### 7. Get Alert Report
```
GET http://127.0.0.1:8080/api/v1/pipeline/report/{capIdentifier}
```

---

### 8. Clear Pipeline Status
```
DELETE http://127.0.0.1:8080/api/v1/pipeline/status/{capIdentifier}
```

---

## Other Endpoints

### CAP Ingestion (without pipeline trigger)
```
POST http://127.0.0.1:8080/api/v1/alerts/cap
Content-Type: application/xml

<CAP XML content>
```

### Manual Alert Creation
```
POST http://127.0.0.1:8080/api/v1/alerts/manual
Content-Type: application/json

{
  "polygon": [[28.6, 77.2], [28.7, 77.2], [28.7, 77.3], [28.6, 77.3]],
  "message": "Emergency alert message",
  "severity": "Extreme",
  "expiresInMinutes": 60,
  "hazardType": "Heat Wave"
}
```

---

## Test Results

✅ Application starts successfully in simulation mode
✅ `PipelineController` is registered by Spring Boot
✅ Pipeline trigger with CAP XML works
✅ Pipeline status retrieval works
✅ Pipeline execution completes successfully:
   - CAP ingestion: ✅
   - Tower resolution: ✅ (34 simulated towers)
   - Subscriber matching: ✅ (0 subscribers - simulation mode)
   - Pipeline status tracking: ✅

---

## Technical Details

### Controller Location
- **File**: `src/main/java/com/turant/pipeline/PipelineController.java`
- **Base Path**: `/api/v1/pipeline`
- **Dependencies**: `AlertPipeline`, `CapIngestionService`, `PipelineStatusStore`, `ReportBuilder`

### Log Confirmation
```
2026-08-20 16:37:43 [main] INFO  c.turant.pipeline.PipelineController - PipelineController initialized successfully
```

### Changes Made
1. Deleted `PipelineTriggerController.java` (was not being registered)
2. Added trigger endpoints to existing `PipelineController.java`
3. Fixed base path from `/api/v1/alerts` to `/api/v1/pipeline`
4. Removed invalid `@Autowired(required = false)` on constructor parameter
5. Fixed type inference issues with CompletableFuture and Java records

---

## Using with Postman/Thunder Client

1. **Test endpoint**: GET `http://127.0.0.1:8080/api/v1/pipeline/test`
2. **Trigger alert**: POST `http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`
   - Set Content-Type: `application/xml`
   - Paste CAP XML in body (raw)
3. **Check status**: GET `http://127.0.0.1:8080/api/v1/pipeline/{capIdentifier}/pipeline-status`
   - Replace `{capIdentifier}` with the ID from step 2 response

---

## System Status

- **Application**: Running on port 8080
- **Simulation Mode**: Enabled
- **Database**: Not required (simulation mode)
- **Controllers Registered**: ✅ All working
- **Pipeline**: ✅ Fully functional
