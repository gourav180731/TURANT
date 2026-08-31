# Testing TURANT in Simulation Mode

## ✅ Application Status
- **Running**: Yes, on port 8080
- **Mode**: Simulation (no database required)
- **SimulatedTowerSource**: Registered
- **Ready for testing**: Yes

## API Endpoints for Testing

### 1. Trigger Pipeline with CAP XML
**Endpoint**: `POST http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`

⚠️ **NOTE**: If you get 404, the endpoint might be at `/api/v1/alerts/trigger-by-cap` instead.

**Headers**:
```
Content-Type: application/xml
Accept: application/json
```

**Body**: CAP XML (raw XML)
```xml
<alert>
  <identifier>1780655887295022</identifier>
  <sender>Delhi SDMA</sender>
  <sent>2026-08-17 11:25:07.274</sent>
  <!-- ... rest of CAP XML ... -->
</alert>
```

**Expected Response**:
```json
{
  "capIdentifier": "1780655887295022",
  "sender": "Delhi SDMA",
  "status": "Test",
  "msgType": "Alert",
  "severity": "WARNING",
  "urgency": "Immediate",
  "headline": "Heat Wave is Likely to occur...",
  "geometryCount": 3,
  "effectiveAt": "2026-08-17T11:20:07.274Z",
  "expiresAt": "2026-08-18T11:20:07.274Z"
}
```

**What Happens**:
1. CAP XML is parsed
2. Simulated towers generated (5-50 towers per polygon)
3. Simulated subscribers matched (based on tower density)
4. Simulated SMS delivery (instant, no real SMPP)
5. Pipeline completes

### 2. Check Pipeline Status
**Endpoint**: `GET http://127.0.0.1:8080/api/v1/alerts/{capIdentifier}/pipeline-status`

**⚠️ LIMITATION IN SIMULATION MODE**:
This endpoint **will fail** because alerts are not persisted to the database. You'll get:
```json
{"error": "No alert found for capIdentifier: 1780655887295022"}
```

This is expected behavior. In simulation mode, the pipeline processes the alert but doesn't save it.

### 3. Alternative: Trigger with JSON
**Endpoint**: `POST http://127.0.0.1:8080/api/v1/pipeline/trigger`

**Headers**:
```
Content-Type: application/json
Accept: application/json
```

**Body**:
```json
{
  "alertId": "test-alert-001",
  "severity": "WARNING",
  "urgency": "Immediate",
  "headline": "Test Alert",
  "description": "Testing simulation mode",
  "polygons": [
    [
      [28.698355, 77.298165],
      [28.697955, 77.298138],
      [28.695522, 77.297828]
    ]
  ]
}
```

## Testing with Postman

### Step 1: Trigger Pipeline
1. Create new **POST** request
2. URL: `http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`
3. Headers:
   - `Content-Type: application/xml`
   - `Accept: application/json`
4. Body → raw → paste your CAP XML
5. Send

### Step 2: Check Application Logs
Watch the console output for:
```
Ingesting CAP alert
Parsed CAP alert: 1780655887295022
Cell match start: source=simulated, geometries=3
Simulating tower search for zone with 3 geometries
Found X towers for 3 polygons
Simulated X towers in zone
Cell match completed: towers=X
Subscriber match start
Simulated X subscribers for X towers
Subscriber match completed: subscribers=X
SMS delivery start: recipients=X
Simulated SMS delivery: X messages
Pipeline completed
```

## Expected Behavior in Simulation Mode

### ✅ What Works
- CAP XML parsing
- Geographic zone extraction
- Simulated tower generation (5-50 per zone)
- Simulated subscriber matching (10-500 per tower)
- Simulated SMS delivery (instant, no SMPP)
- Pipeline execution completes

### ❌ What Doesn't Work (Expected)
- Alert persistence to database
- Alert status retrieval
- Real PostGIS tower queries
- Real subscriber data from telecom DB
- Real SMPP message delivery
- Delivery receipts (DLRs)

### 📊 Simulation Behavior
- **Towers**: Randomly generated within 5km of zone center
- **Subscribers**: 10-500 per tower (configurable)
- **Delivery**: Instant success (no real SMPP)
- **Latency**: Minimal (no database/network overhead)

## Troubleshooting

### Issue: "No alert found"
**Cause**: Trying to check status in simulation mode  
**Solution**: This is expected. Alerts aren't persisted without a database.

### Issue: "Tower resolution failed: TimeoutException"
**Cause**: SimulatedTowerSource not registered  
**Solution**: Check logs for "Registered SimulatedTowerSource" message

### Issue: Application won't start
**Cause**: Database dependency injection issues  
**Solution**: Check that `simulation.mode=enabled` in application.properties

### Issue: No towers/subscribers generated
**Cause**: Simulation components not created  
**Solution**: Verify logs show simulation components being registered

## Sample CAP XML for Testing

### Delhi Heat Wave (3 Polygons)
```xml
<alert>
  <identifier>1780655887295022</identifier>
  <sender>Delhi SDMA</sender>
  <sent>2026-08-17T11:25:07.274Z</sent>
  <status>Test</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-IN</language>
    <category>Met</category>
    <event>Heat Wave</event>
    <urgency>Immediate</urgency>
    <severity>WARNING</severity>
    <certainty>Likely</certainty>
    <effective>2026-08-17T11:20:07.274Z</effective>
    <expires>2026-08-18T11:20:07.274Z</expires>
    <headline>Heat Wave is Likely to occur over North East, South districts of Delhi</headline>
    <instruction>Please follow SDMA guidelines.</instruction>
    <area>
      <areaDesc>North East,South districts of Delhi</areaDesc>
      <polygon>28.698355,77.298165 28.697955,77.298138 28.695522,77.297828 ...</polygon>
      <polygon>28.431115,77.253067 28.428426,77.252016 28.426911,77.251294 ...</polygon>
      <polygon>28.558881,77.247329 28.557981,77.24694 28.557419,77.246606 ...</polygon>
    </area>
  </info>
</alert>
```

**Expected**: 15-150 towers, 150-75,000 subscribers

## Verifying Success

### In Logs
Look for these key messages:
1. ✅ "Parsed CAP alert: [identifier]"
2. ✅ "Registered SimulatedTowerSource (simulation mode)"
3. ✅ "Simulating tower search for zone with X geometries"
4. ✅ "Simulated X towers in zone"
5. ✅ "Simulated X subscribers for X towers"
6. ✅ "Simulated SMS delivery: X messages"

### In Response
The POST response should return the parsed CAP alert details with:
- Alert identifier
- Severity/urgency
- Headline
- Geometry count
- Effective/expiry times

## Next Steps

Once simulation mode testing is complete:

### To Enable Real Database Mode
1. Edit `.env`:
   ```
   DATABASE_URL=jdbc:postgresql://localhost:5432/turant
   SIMULATION_MODE=disabled
   ```

2. Restart application

3. Now uses:
   - Real PostGIS for tower resolution
   - Real telecom subscriber data
   - Real SMPP for message delivery
   - Alert persistence to database
   - Status endpoint works

## Summary

**Simulation mode is working correctly when**:
- Application starts without database
- SimulatedTowerSource is registered
- POST to `/trigger-by-cap` returns parsed CAP details
- Logs show simulated towers and subscribers
- No database connection errors

**The status check endpoint failing is EXPECTED** - it requires database persistence.
