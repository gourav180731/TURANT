# Postman Testing Guide - TURANT Alert System

## Quick Setup

1. **Make sure the application is running**:
   - Check that Java process is running on port 8080
   - Or start it: `java -jar target\turant-0.1.0.jar`

2. **Open Postman** (or any HTTP client like Thunder Client, Insomnia, etc.)

---

## Test 1: Basic Health Check ✅

**Verify the server is running**

### Request
```
Method: GET
URL: http://127.0.0.1:8080/api/v1/pipeline/test
```

### Steps in Postman
1. Click **"New"** → **"HTTP Request"**
2. Select **GET** from dropdown
3. Enter URL: `http://127.0.0.1:8080/api/v1/pipeline/test`
4. Click **"Send"**

### Expected Response
```
Status: 200 OK
Body: Pipeline controller is working
```

✅ If you see this, the server is running correctly!

---

## Test 2: Trigger Pipeline with CAP XML ✅

**This is the main endpoint you wanted to test**

### Request
```
Method: POST
URL: http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap
Headers:
  Content-Type: application/xml
Body: [CAP XML below]
```

### Steps in Postman

1. **Create new request**:
   - Click **"New"** → **"HTTP Request"**
   - Select **POST** from dropdown
   - Enter URL: `http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`

2. **Set Headers**:
   - Click **"Headers"** tab
   - Add header:
     - Key: `Content-Type`
     - Value: `application/xml`

3. **Set Body**:
   - Click **"Body"** tab
   - Select **"raw"** radio button
   - Make sure dropdown on right shows **"XML"** (or "Text")
   - Paste this CAP XML:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>postman-test-001</identifier>
  <sender>postman@test.com</sender>
  <sent>2026-08-20T12:00:00Z</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-US</language>
    <category>Safety</category>
    <event>Heat Wave Alert</event>
    <urgency>Immediate</urgency>
    <severity>Extreme</severity>
    <certainty>Observed</certainty>
    <effective>2026-08-20T12:00:00Z</effective>
    <expires>2026-08-20T18:00:00Z</expires>
    <senderName>TURANT Test System</senderName>
    <headline>Extreme Heat Wave - Delhi NCR</headline>
    <description>Temperatures expected to reach 45°C. Stay indoors and stay hydrated.</description>
    <instruction>Avoid going outside between 11 AM and 4 PM. Drink plenty of water.</instruction>
    <area>
      <areaDesc>Delhi NCR Region</areaDesc>
      <polygon>28.6,77.2 28.7,77.2 28.7,77.3 28.6,77.3 28.6,77.2</polygon>
    </area>
  </info>
</alert>
```

4. **Send Request**:
   - Click **"Send"** button

### Expected Response
```json
Status: 200 OK
Body:
{
  "capIdentifier": "postman-test-001",
  "alertId": "postman-test-001",
  "action": "triggered",
  "status": "completed",
  "stage": "done"
}
```

### What This Means
✅ **CAP alert ingested** - XML parsed successfully
✅ **Pipeline triggered** - Alert processing started
✅ **Towers resolved** - Simulated towers matched to alert area
✅ **Status tracked** - Pipeline completion recorded

📋 **Copy the `capIdentifier`** from response - you'll need it for the next test!

---

## Test 3: Check Pipeline Status ✅

**Check the status of the alert you just triggered**

### Request
```
Method: GET
URL: http://127.0.0.1:8080/api/v1/pipeline/{capIdentifier}/pipeline-status
```

### Steps in Postman

1. **Create new request**:
   - Click **"New"** → **"HTTP Request"**
   - Select **GET** from dropdown
   - Enter URL: `http://127.0.0.1:8080/api/v1/pipeline/postman-test-001/pipeline-status`
   - **Replace `postman-test-001`** with the capIdentifier from Test 2 response

2. **Send Request**:
   - Click **"Send"**

### Expected Response
```json
Status: 200 OK
Body:
{
  "capIdentifier": "postman-test-001",
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

### Understanding the Response

- **status**: `"completed"` - Pipeline finished successfully ✅
- **stage**: `"done"` - Final stage reached ✅
- **towerCount**: `34` - Number of cell towers matched to alert area ✅
- **matchedCount**: `0` - Subscribers matched (0 in simulation mode)
- **awaitingCredentials**: `true` - SMPP credentials not configured (expected in simulation)

---

## Test 4: Test with Real Delhi Heat Wave CAP (Optional)

If you have a full Delhi Heat Wave CAP XML file, use the same steps as Test 2 but with your CAP file content.

### Large CAP Files

If your CAP file is very large:
1. Copy the entire XML content
2. In Postman, go to **Body** → **raw** → **XML**
3. Paste the content
4. Click **Send**

The endpoint accepts CAP alerts with multiple polygons and areas.

---

## Troubleshooting

### ❌ Error: "Connection refused" or "Could not send request"
**Solution**: Make sure the Java application is running
```powershell
# Check if running
netstat -ano | findstr :8080

# Or restart it
java -jar target\turant-0.1.0.jar
```

---

### ❌ Error: 404 Not Found
**Solution**: Double-check the URL
- Correct: `http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`
- NOT: `http://localhost:8080...` (use 127.0.0.1)
- NOT: `/api/v1/alerts/trigger-by-cap` (wrong base path)

---

### ❌ Error: 400 Bad Request - "CAP parsing failed"
**Solution**: Check your XML
- Must be valid XML (starts with `<?xml version="1.0"?>`)
- Must have CAP 1.2 namespace: `xmlns="urn:oasis:names:tc:emergency:cap:1.2"`
- Must have required fields: identifier, sender, sent, status, msgType, scope

---

### ❌ Error: 415 Unsupported Media Type
**Solution**: Add the Content-Type header
- Header: `Content-Type: application/xml`
- Make sure it's set in the Headers tab

---

## Save as Postman Collection

To save these tests for future use:

1. **Create Collection**:
   - Click **"Collections"** in left sidebar
   - Click **"+"** to create new collection
   - Name it: "TURANT Alert System"

2. **Add Requests**:
   - For each request above, click **"Save"** button
   - Choose your "TURANT Alert System" collection
   - Give it a name like "1. Health Check", "2. Trigger Pipeline", etc.

3. **Export Collection** (optional):
   - Right-click collection → **"Export"**
   - Save as JSON file for backup

---

## Quick Reference

### Working Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/pipeline/test` | GET | Health check |
| `/api/v1/pipeline/trigger-by-cap` | POST | Trigger with CAP XML |
| `/api/v1/pipeline/{id}/pipeline-status` | GET | Get status |
| `/api/v1/pipeline/status/{id}` | GET | Get status (alt) |
| `/api/v1/pipeline/towers/{id}` | GET | Get matched towers |
| `/api/v1/pipeline/report/{id}` | GET | Get alert report |

### Base URL
```
http://127.0.0.1:8080
```

---

## Success Checklist

After running the tests above, you should have:

- ✅ Confirmed server is running (Test 1)
- ✅ Successfully triggered pipeline with CAP XML (Test 2)
- ✅ Retrieved pipeline status (Test 3)
- ✅ Seen tower count in response (shows spatial matching works)
- ✅ Got status "completed" (shows pipeline execution works)

**All working?** 🎉 Your TURANT Alert System is fully functional!

---

## Next Steps

1. **Test with real CAP alerts** from your alert provider
2. **Configure PostgreSQL** to enable real tower/subscriber data
3. **Configure SMPP** to enable actual SMS sending
4. **Monitor logs** to see detailed pipeline execution

For logs, check the terminal where Java is running or look for files in the project root.
