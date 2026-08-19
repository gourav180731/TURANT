# TURANT Alert System - API Documentation

**Version:** 1.0.0  
**Base URL:** `http://localhost:8080` (development)  
**Last Updated:** 2026-08-19

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Health & Status](#health--status)
4. [Alert Ingestion](#alert-ingestion)
5. [Pipeline Management](#pipeline-management)
6. [Tower Resolution](#tower-resolution)
7. [Error Handling](#error-handling)
8. [Rate Limiting](#rate-limiting)

---

## Overview

The TURANT Alert System provides REST APIs for ingesting CAP (Common Alerting Protocol) alerts, managing alert processing pipelines, and retrieving status/reports for emergency broadcast messaging.

### Key Features

- **CAP Alert Ingestion**: Parse and validate CAP 1.2 XML alerts
- **Manual Alert Creation**: Create alerts from simplified JSON payloads
- **Pipeline Management**: Track alert processing through multi-stage pipeline
- **Tower Resolution**: Resolve cell towers within alert zones
- **Real-time Status**: Monitor pipeline execution and completion reports

---

## Authentication

**Current Status:** Not implemented (development only)

Future authentication will use:
- **API Keys** for machine-to-machine communication
- **JWT tokens** for user sessions
- **Role-based access control** (Admin, Operator, Read-only)

For now, all endpoints are publicly accessible in development mode.

---

## Health & Status

### GET /healthz

**Description:** Health check endpoint for monitoring system status

**Response Codes:**
- `200 OK` - System is healthy
- `503 Service Unavailable` - System is degraded

**Response Body:**

```json
{
  "app": "turant",
  "uptimeSeconds": 3600,
  "db": "ok",
  "redis": "ok",
  "smpp": "configured",
  "status": "healthy"
}
```

**Status Values:**

| Field | Values | Description |
|-------|--------|-------------|
| `db` | `ok`, `not_configured`, `error: <msg>` | Database connectivity |
| `redis` | `ok`, `not_configured`, `error: <msg>` | Redis cache connectivity |
| `smpp` | `ok`, `configured`, `awaiting_credentials` | SMPP gateway status |
| `status` | `healthy`, `degraded` | Overall system health |

**Example:**

```bash
curl http://localhost:8080/healthz
```

---

## Alert Ingestion

### POST /api/v1/alerts/cap

**Description:** Ingest a CAP 1.2 XML alert document

**Content-Type:** 
- `application/xml`
- `text/xml`
- `text/plain`

**Request Body:** Raw CAP XML string

```xml
<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>ABC123</identifier>
  <sender>emergency@example.com</sender>
  <sent>2026-08-19T10:00:00Z</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <category>Safety</category>
    <event>Severe Weather</event>
    <urgency>Immediate</urgency>
    <severity>Extreme</severity>
    <certainty>Observed</certainty>
    <headline>Severe Thunderstorm Warning</headline>
    <description>Take shelter immediately</description>
    <area>
      <areaDesc>Downtown Area</areaDesc>
      <circle>40.7128,-74.0060 10</circle>
    </area>
  </info>
</alert>
```

**Response Codes:**
- `200 OK` - Alert ingested successfully
- `400 Bad Request` - Invalid CAP XML or parsing error
- `500 Internal Server Error` - Server error during ingestion

**Success Response:**

```json
{
  "capIdentifier": "ABC123",
  "status": "ingested",
  "message": "CAP alert ingested successfully"
}
```

**Error Response:**

```json
{
  "error": "CapParseError",
  "message": "Invalid CAP XML: Missing required field 'identifier'"
}
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/v1/alerts/cap \
  -H "Content-Type: application/xml" \
  --data @alert.xml
```

---

### POST /api/v1/alerts/manual

**Description:** Create alert from simplified JSON payload (auto-generates CAP XML)

**Content-Type:** `application/json`

**Request Body:**

```json
{
  "event": "Severe Weather",
  "severity": "Extreme",
  "urgency": "Immediate",
  "certainty": "Observed",
  "headline": "Tornado Warning",
  "description": "A tornado has been sighted. Take shelter immediately.",
  "instruction": "Move to basement or interior room. Stay away from windows.",
  "areas": [
    {
      "areaDesc": "Downtown Manhattan",
      "circle": {
        "center": [40.7128, -74.0060],
        "radiusKm": 5
      }
    },
    {
      "areaDesc": "Brooklyn Heights",
      "polygon": [
        [40.6955, -73.9951],
        [40.6970, -74.0000],
        [40.6925, -74.0010],
        [40.6955, -73.9951]
      ]
    }
  ],
  "expiresInMinutes": 60
}
```

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | Yes | Event type (e.g., "Tornado", "Earthquake") |
| `severity` | enum | Yes | `Extreme`, `Severe`, `Moderate`, `Minor` |
| `urgency` | enum | Yes | `Immediate`, `Expected`, `Future` |
| `certainty` | enum | Yes | `Observed`, `Likely`, `Possible` |
| `headline` | string | Yes | Brief alert headline |
| `description` | string | Yes | Detailed description |
| `instruction` | string | No | Action instructions for recipients |
| `areas` | array | Yes | At least one area definition (see below) |
| `expiresInMinutes` | number | No | Alert validity duration (default: 60) |

**Area Object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `areaDesc` | string | Yes | Human-readable area name |
| `circle` | object | No | Circular area: `{ center: [lat, lng], radiusKm: number }` |
| `polygon` | array | No | Polygon: `[[lat1, lng1], [lat2, lng2], ...]` |

**Response Codes:**
- `200 OK` - Alert created and ingested
- `400 Bad Request` - Missing required fields or validation error
- `500 Internal Server Error` - Server error

**Success Response:**

```json
{
  "capIdentifier": "manual-a1b2c3d4-e5f6-7890-abcd-1234567890ab",
  "status": "created",
  "message": "Manual alert created and ingested successfully"
}
```

**Error Response:**

```json
{
  "error": "ValidationError",
  "message": "At least one area is required"
}
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/v1/alerts/manual \
  -H "Content-Type: application/json" \
  -d @manual-alert.json
```

---

## Pipeline Management

### POST /api/v1/pipeline/trigger

**Description:** Trigger pipeline execution for an existing alert

**Content-Type:** `application/json`

**Request Body:**

```json
{
  "capIdentifier": "ABC123",
  "alertId": "alert-001"
}
```

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `capIdentifier` | string | Yes | CAP alert identifier |
| `alertId` | string | No | Internal alert ID (defaults to capIdentifier) |

**Response Codes:**
- `200 OK` - Pipeline triggered successfully
- `404 Not Found` - Alert not found
- `500 Internal Server Error` - Pipeline execution error

**Success Response:**

```json
{
  "capIdentifier": "ABC123",
  "alertId": "alert-001",
  "action": "triggered",
  "status": "active",
  "stage": "tower_resolution"
}
```

**Error Response:**

```json
{
  "error": "Alert not found: ABC123"
}
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/v1/pipeline/trigger \
  -H "Content-Type: application/json" \
  -d '{"capIdentifier": "ABC123"}'
```

---

### POST /api/v1/pipeline/trigger-by-cap

**Description:** Ingest CAP XML and immediately trigger pipeline

**Content-Type:** `application/xml`

**Request Body:** Raw CAP XML (same format as `/api/v1/alerts/cap`)

**Response Codes:**
- `200 OK` - Alert ingested and pipeline triggered
- `400 Bad Request` - Invalid CAP XML
- `500 Internal Server Error` - Pipeline error

**Success Response:**

```json
{
  "capIdentifier": "ABC123",
  "alertId": "ABC123",
  "action": "triggered",
  "status": "active",
  "stage": "tower_resolution"
}
```

**Example:**

```bash
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" \
  --data @alert.xml
```

---

### GET /api/v1/pipeline/status/:capIdentifier

**Description:** Get current pipeline status for an alert

**Path Parameters:**
- `capIdentifier` - CAP alert identifier

**Response Codes:**
- `200 OK` - Status found
- `404 Not Found` - No status for this alert

**Response Body:**

```json
{
  "capIdentifier": "ABC123",
  "alertId": "alert-001",
  "status": "active",
  "stage": "subscriber_matching",
  "towerCount": 42,
  "expectedRecipients": 15000,
  "submittedCount": 8500,
  "acceptedCount": 8450,
  "startTime": "2026-08-19T10:00:00Z",
  "lastUpdateTime": "2026-08-19T10:05:30Z"
}
```

**Status Values:**

| Field | Description |
|-------|-------------|
| `status` | `pending`, `active`, `completed`, `failed` |
| `stage` | Current pipeline stage (see below) |
| `towerCount` | Number of matched cell towers |
| `expectedRecipients` | Total MSISDNs to be notified |
| `submittedCount` | Messages submitted to SMPP gateway |
| `acceptedCount` | Messages accepted by gateway |

**Pipeline Stages:**

1. `tower_resolution` - Resolving cell towers in alert zone
2. `subscriber_matching` - Matching subscribers to towers
3. `deduplication` - Removing duplicate subscribers
4. `message_preparation` - Preparing SMS messages
5. `smpp_submission` - Submitting to SMPP gateway
6. `delivery_tracking` - Tracking delivery receipts
7. `report_generation` - Generating completion report

**Example:**

```bash
curl http://localhost:8080/api/v1/pipeline/status/ABC123
```

---

### GET /api/v1/pipeline/towers/:capIdentifier

**Description:** Get matched cell towers for an alert (for map visualization)

**Path Parameters:**
- `capIdentifier` - CAP alert identifier

**Response Codes:**
- `200 OK` - Towers found
- `404 Not Found` - No towers for this alert

**Response Body:**

```json
{
  "capIdentifier": "ABC123",
  "count": 42,
  "towers": [
    {
      "towerid": "T001",
      "latitude": 40.7128,
      "longitude": -74.0060,
      "coverageRadiusMeters": 1500
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:8080/api/v1/pipeline/towers/ABC123
```

---

### GET /api/v1/pipeline/report/:capIdentifier

**Description:** Get completion report for a finished alert

**Path Parameters:**
- `capIdentifier` - CAP alert identifier

**Response Codes:**
- `200 OK` - Report available
- `202 Accepted` - Processing not yet complete
- `404 Not Found` - Alert not found

**Response Body:**

```json
{
  "alertId": "alert-001",
  "capIdentifier": "ABC123",
  "summary": {
    "expectedRecipients": 15000,
    "messagesSubmitted": 15000,
    "messagesAccepted": 14950,
    "messagesDelivered": 14800,
    "messagesFailed": 150,
    "deliveryRate": 98.67,
    "acceptanceRate": 99.67
  },
  "coverage": {
    "towersMatched": 42,
    "zonesProcessed": 1
  },
  "performance": {
    "processingDurationMs": 12500,
    "throughputPerSecond": 1200
  },
  "timestamp": "2026-08-19T10:15:00Z"
}
```

**Example:**

```bash
curl http://localhost:8080/api/v1/pipeline/report/ABC123
```

---

### DELETE /api/v1/pipeline/status/:capIdentifier

**Description:** Clear pipeline status (cleanup after completion)

**Path Parameters:**
- `capIdentifier` - CAP alert identifier

**Response Codes:**
- `204 No Content` - Status cleared successfully

**Example:**

```bash
curl -X DELETE http://localhost:8080/api/v1/pipeline/status/ABC123
```

---

## Tower Resolution

### GET /api/v1/alerts/:capIdentifier/towers

**Description:** Get resolved cell towers for an alert

**Path Parameters:**
- `capIdentifier` - CAP alert identifier

**Response Codes:**
- `200 OK` - Towers resolved
- `404 Not Found` - Alert not found
- `500 Internal Server Error` - Resolution error

**Response Body:**

```json
{
  "towers": [
    {
      "towerid": "T001",
      "latitude": 40.7128,
      "longitude": -74.0060,
      "coverageRadiusMeters": 1500
    }
  ],
  "count": 42
}
```

**Note:** Full tower resolution implementation is in progress.

**Example:**

```bash
curl http://localhost:8080/api/v1/alerts/ABC123/towers
```

---

## Error Handling

### Standard Error Response

All error responses follow this format:

```json
{
  "error": "ErrorType",
  "message": "Human-readable error description"
}
```

### Error Types

| Error Type | HTTP Code | Description |
|------------|-----------|-------------|
| `CapParseError` | 400 | Invalid CAP XML structure or content |
| `ValidationError` | 400 | Request validation failed (missing/invalid fields) |
| `NotFoundError` | 404 | Resource not found (alert, status, etc.) |
| `InternalError` | 500 | Server-side processing error |
| `DatabaseError` | 500 | Database connectivity or query error |
| `SmppError` | 500 | SMPP gateway communication error |

### Common Error Scenarios

**Missing Required Field:**
```json
{
  "error": "ValidationError",
  "message": "Missing required field: event"
}
```

**Alert Not Found:**
```json
{
  "error": "Alert not found: ABC123"
}
```

**CAP Parse Error:**
```json
{
  "error": "CapParseError",
  "message": "Invalid CAP XML: Missing required field 'identifier'"
}
```

**Pipeline Still Processing:**
```json
{
  "error": "Alert processing not yet complete: subscriber_matching"
}
```

---

## Rate Limiting

**Current Status:** Not implemented (development only)

Future rate limiting will implement:
- **100 requests/minute** per API key (global endpoints)
- **10 alerts/minute** per API key (ingestion endpoints)
- **Burst allowance**: 20 requests in 10 seconds
- **Headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

**429 Too Many Requests Response:**

```json
{
  "error": "RateLimitExceeded",
  "message": "Rate limit exceeded. Retry after 60 seconds.",
  "retryAfter": 60
}
```

---

## Complete Request Examples

### Example 1: Manual Alert End-to-End

```bash
# 1. Create manual alert
curl -X POST http://localhost:8080/api/v1/alerts/manual \
  -H "Content-Type: application/json" \
  -d '{
    "event": "Tornado Warning",
    "severity": "Extreme",
    "urgency": "Immediate",
    "certainty": "Observed",
    "headline": "Take Shelter Now",
    "description": "Tornado spotted heading northeast",
    "areas": [{
      "areaDesc": "Downtown",
      "circle": {"center": [40.7128, -74.0060], "radiusKm": 5}
    }],
    "expiresInMinutes": 30
  }'

# Response: {"capIdentifier": "manual-abc123", ...}

# 2. Trigger pipeline
curl -X POST http://localhost:8080/api/v1/pipeline/trigger \
  -H "Content-Type: application/json" \
  -d '{"capIdentifier": "manual-abc123"}'

# 3. Monitor status
curl http://localhost:8080/api/v1/pipeline/status/manual-abc123

# 4. Get completion report
curl http://localhost:8080/api/v1/pipeline/report/manual-abc123
```

### Example 2: CAP Ingestion with Immediate Pipeline Trigger

```bash
# Single request: ingest + trigger
curl -X POST http://localhost:8080/api/v1/pipeline/trigger-by-cap \
  -H "Content-Type: application/xml" \
  --data @alert.xml

# Monitor progress
curl http://localhost:8080/api/v1/pipeline/status/ABC123
```

### Example 3: Health Check for Monitoring

```bash
# Check system health
curl http://localhost:8080/healthz

# Expected healthy response:
# {
#   "app": "turant",
#   "status": "healthy",
#   "db": "ok",
#   "redis": "ok",
#   "smpp": "configured"
# }
```

---

## Integration Patterns

### Pattern 1: External CAP Feed Integration

```javascript
// Webhook receiver for external CAP alerts
app.post('/external/cap-webhook', async (req, res) => {
  const capXml = req.body;
  
  // Forward to TURANT
  const response = await fetch('http://turant:8080/api/v1/pipeline/trigger-by-cap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: capXml
  });
  
  const result = await response.json();
  res.json({ success: true, capIdentifier: result.capIdentifier });
});
```

### Pattern 2: Frontend Dashboard Integration

```javascript
// Real-time alert monitoring
async function monitorAlert(capIdentifier) {
  const pollInterval = 2000; // 2 seconds
  
  while (true) {
    const response = await fetch(
      `http://turant:8080/api/v1/pipeline/status/${capIdentifier}`
    );
    const status = await response.json();
    
    updateUI(status);
    
    if (status.status === 'completed' || status.status === 'failed') {
      // Get final report
      const report = await fetch(
        `http://turant:8080/api/v1/pipeline/report/${capIdentifier}`
      ).then(r => r.json());
      
      displayReport(report);
      break;
    }
    
    await sleep(pollInterval);
  }
}
```

### Pattern 3: Automated Testing

```bash
#!/bin/bash
# Integration test script

# 1. Check system health
HEALTH=$(curl -s http://localhost:8080/healthz | jq -r '.status')
if [ "$HEALTH" != "healthy" ]; then
  echo "System not healthy: $HEALTH"
  exit 1
fi

# 2. Create test alert
CAP_ID=$(curl -s -X POST http://localhost:8080/api/v1/alerts/manual \
  -H "Content-Type: application/json" \
  -d @test-alert.json | jq -r '.capIdentifier')

echo "Created alert: $CAP_ID"

# 3. Trigger pipeline
curl -s -X POST http://localhost:8080/api/v1/pipeline/trigger \
  -H "Content-Type: application/json" \
  -d "{\"capIdentifier\": \"$CAP_ID\"}"

# 4. Wait for completion (max 60 seconds)
for i in {1..30}; do
  STATUS=$(curl -s http://localhost:8080/api/v1/pipeline/status/$CAP_ID | jq -r '.status')
  echo "Status: $STATUS"
  
  if [ "$STATUS" = "completed" ]; then
    # Get report
    curl -s http://localhost:8080/api/v1/pipeline/report/$CAP_ID | jq
    break
  fi
  
  sleep 2
done

# 5. Cleanup
curl -s -X DELETE http://localhost:8080/api/v1/pipeline/status/$CAP_ID
```

---

## Changelog

### Version 1.0.0 (2026-08-19)
- Initial API documentation
- All endpoints migrated from TypeScript implementation
- Core functionality: CAP ingestion, pipeline management, tower resolution
- Performance benchmarks: 15,873 msg/sec (8 workers), 192K dedup/sec

---

## Support

For issues, questions, or feature requests:
- **GitHub Issues**: [turant/issues](https://github.com/turant/issues)
- **Documentation**: `COMPLETE_MIGRATION_GUIDE.md`
- **Performance**: `PERFORMANCE_BENCHMARK_RESULTS.md`

---

## License

Copyright © 2026 TURANT Alert System
