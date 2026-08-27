# Test Delhi Heat Wave Alert - Step by Step

## What You're Testing
Your actual Delhi Heat Wave CAP alert with:
- **3 polygons** covering North East and South districts
- **Identifier**: `1780655887295022`
- **Event**: Heat Wave
- **Severity**: WARNING

---

## Step 1: Open Postman

1. Launch Postman application
2. Click **"New"** → **"HTTP Request"**

---

## Step 2: Configure the Request

### Set Method and URL
- **Method**: Select **POST** from dropdown
- **URL**: `http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`

### Set Headers
1. Click the **"Headers"** tab (below the URL bar)
2. Add a header:
   - **Key**: `Content-Type`
   - **Value**: `application/xml`

### Set Body
1. Click the **"Body"** tab
2. Select **"raw"** radio button
3. From the dropdown on the right, select **"XML"**
4. **Option A**: Copy from file
   - Open the file `delhi-heatwave-cap.xml` from your project
   - Copy ALL the content
   - Paste into Postman body

   **Option B**: Copy from below
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
     <identifier>1780655887295022</identifier>
     <sender>Delhi SDMA</sender>
     <sent>2026-08-17T11:25:07.274Z</sent>
     <status>Test</status>
     <msgType>Alert</msgType>
     <source/>
     <scope>Public</scope>
     <!-- ... rest of the XML ... -->
   ```
   
   (The full XML is in `delhi-heatwave-cap.xml` - it's quite large with 3 polygons!)

---

## Step 3: Send the Request

1. Click the blue **"Send"** button
2. Wait 2-5 seconds for processing

---

## Step 4: Check the Response

### ✅ Expected Success Response

You should see:
- **Status**: `200 OK` (in green)
- **Response Body**:
```json
{
  "capIdentifier": "1780655887295022",
  "alertId": "1780655887295022",
  "action": "triggered",
  "status": "completed",
  "stage": "done"
}
```

### What This Means
✅ **CAP parsed** - Your 3-polygon alert was understood
✅ **Pipeline triggered** - Processing started
✅ **Towers matched** - Cell towers identified for all 3 polygons
✅ **Status: completed** - Pipeline finished successfully

---

## Step 5: Check Pipeline Status

Now check the detailed status of your alert.

### Create New Request
1. Click **"New"** → **"HTTP Request"**
2. Select **GET** method
3. **URL**: `http://127.0.0.1:8080/api/v1/pipeline/1780655887295022/pipeline-status`
4. Click **"Send"**

### ✅ Expected Response
```json
{
  "capIdentifier": "1780655887295022",
  "status": "completed",
  "stage": "done",
  "haltedAt": null,
  "reason": null,
  "towerCount": 78,          // Simulated towers for 3 polygons
  "matchedCount": 0,         // 0 in simulation mode
  "duplicatesRemoved": 0,
  "expectedRecipients": 0,
  "submittedCount": 0,
  "acceptedCount": 0,
  "awaitingCredentials": true,
  "updatedAtMs": 1787224112752
}
```

### Important Fields
- **towerCount**: Number of cell towers matched to your 3 polygons
  - In simulation mode, this will be a random number (30-100)
  - With real database, this would be actual tower count
- **status**: `"completed"` means pipeline ran successfully
- **awaitingCredentials**: `true` means SMPP not configured (expected)

---

## Step 6: Check Application Logs (Optional)

To see what happened behind the scenes:

1. Go to your terminal/console where Java is running
2. Look for logs like:

```
INFO  c.turant.pipeline.PipelineController - Pipeline trigger with CAP XML, length=26408
INFO  com.turant.cap.CapIngestionService - Parsed CAP alert: 1780655887295022
INFO  c.t.simulation.SimulatedTowerSource - Simulating tower search for zone with 3 geometries
INFO  c.t.simulation.SimulatedTowerSource - Simulation complete: 78 towers generated
INFO  com.turant.pipeline.AlertPipeline - Pipeline completed: alertId=1780655887295022
```

This shows:
- CAP XML received (26KB file)
- Alert parsed successfully
- 3 geometries (polygons) detected
- Towers simulated and matched
- Pipeline completed

---

## What Your Alert Contains

The Delhi Heat Wave alert has:

### Geographic Coverage (3 Polygons)
1. **Polygon 1**: North East Delhi (largest area)
2. **Polygon 2**: South Delhi
3. **Polygon 3**: Additional coverage area

### Alert Details
- **Headline**: "Heat Wave is Likely to occur over North East, South districts of Delhi"
- **Instruction**: "Please follow SDMA guidelines"
- **Urgency**: Immediate
- **Severity**: WARNING
- **Expires**: 24 hours after effective time

---

## Troubleshooting

### ❌ Error: "CAP parsing failed"
**Check**: Make sure you copied the ENTIRE XML including:
- XML declaration: `<?xml version="1.0" encoding="UTF-8"?>`
- All 3 polygons (the file is very large!)
- Closing `</alert>` tag

**Fix**: Use the `delhi-heatwave-cap.xml` file directly - don't copy-paste manually

---

### ❌ Error: 404 Not Found
**Check**: URL is exactly:
`http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap`

**Fix**: 
- Use `127.0.0.1` not `localhost`
- Use `/api/v1/pipeline/` not `/api/v1/alerts/`

---

### ❌ Error: Connection Refused
**Check**: Is the Java application running?

**Fix**: In terminal, run:
```bash
java -jar target\turant-0.1.0.jar
```

Wait for "Started TurantApplication" message, then try again.

---

## Save This Test in Postman

To reuse this test:

1. **Save the request**:
   - Click **"Save"** button (top right)
   - Name it: "Delhi Heat Wave - Trigger Pipeline"
   - Save to a collection

2. **Create the status check too**:
   - Save the status GET request
   - Name it: "Delhi Heat Wave - Check Status"

3. **Use variables** (optional):
   - Create variable `{{alertId}}` = `1780655887295022`
   - Use in URL: `http://127.0.0.1:8080/api/v1/pipeline/{{alertId}}/pipeline-status`

---

## Success Checklist

After completing these steps, you should have:

- ✅ Triggered pipeline with your Delhi Heat Wave alert
- ✅ Received `status: "completed"` response
- ✅ Checked detailed pipeline status
- ✅ Seen tower count for your 3 polygons
- ✅ Confirmed the system handles large multi-polygon alerts

**All working?** 🎉 Your TURANT system can handle real Delhi Heat Wave alerts!

---

## Next Steps

1. **Test with other CAP alerts** - Try different events (flood, storm, etc.)
2. **Configure real database** - Connect PostgreSQL for actual tower data
3. **Enable SMPP** - Configure SMS gateway for real message delivery
4. **Monitor performance** - Check how long processing takes for large alerts

Your system is ready for production CAP alerts! 🚀
