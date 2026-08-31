# TURANT - Quick Start Guide

Get the TURANT early-warning alert system running in 10 minutes.

---

## Prerequisites

Ensure you have:
- ✅ Java 21+ installed
- ✅ Maven 3.9+ installed
- ✅ PostgreSQL 16 + PostGIS 3.4 running
- ✅ Redis 7+ running (optional)

---

## Step 1: Clone & Setup

```bash
cd TURANT
```

---

## Step 2: Database Setup

```sql
-- Create database
CREATE DATABASE turant;

-- Connect to database
\c turant

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- Create schema (basic tables)
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cap_identifier TEXT UNIQUE NOT NULL,
    sender TEXT,
    sent TEXT,
    status TEXT,
    msg_type TEXT,
    scope TEXT,
    event TEXT,
    severity TEXT,
    urgency TEXT,
    certainty TEXT,
    expires TIMESTAMP,
    effective TIMESTAMP,
    onset TIMESTAMP,
    headline TEXT,
    description TEXT,
    instruction TEXT,
    raw_xml TEXT,
    received_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_alerts_cap_identifier ON alerts(cap_identifier);
CREATE INDEX idx_alerts_received_at ON alerts(received_at);
```

---

## Step 3: Configuration

Create `src/main/resources/application.properties`:

```properties
# Server
server.port=8080

# Database
spring.datasource.url=jdbc:postgresql://localhost:5432/turant
spring.datasource.username=postgres
spring.datasource.password=your_password_here
spring.datasource.driver-class-name=org.postgresql.Driver

# HikariCP
spring.datasource.hikari.maximum-pool-size=10
spring.datasource.hikari.minimum-idle=5

# Redis (optional - will use in-memory fallback)
spring.data.redis.host=localhost
spring.data.redis.port=6379

# Logging
logging.level.com.turant=INFO
logging.level.org.springframework=WARN

# Feature flags
subscriber.matching-available=false
tower.source-mode=postgis

# Timeouts
tower.match-time-budget-ms=30000
```

---

## Step 4: Build

```bash
mvn clean compile
```

Expected output:
```
[INFO] BUILD SUCCESS
[INFO] Compiling 66 source files
```

---

## Step 5: Run

```bash
mvn spring-boot:run
```

Server starts at `http://localhost:8080`

---

## Step 6: Test

### Health Check
```bash
curl http://localhost:8080/healthz
```

Expected:
```json
{
  "status": "UP",
  "timestamp": "2026-08-18T..."
}
```

### Ingest a Test Alert

Create `test-alert.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-2026-001</identifier>
  <sender>test@example.com</sender>
  <sent>2026-08-18T10:00:00+05:30</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-US</language>
    <category>Geo</category>
    <event>Test Alert</event>
    <urgency>Immediate</urgency>
    <severity>Minor</severity>
    <certainty>Observed</certainty>
    <effective>2026-08-18T10:00:00+05:30</effective>
    <expires>2026-08-18T10:30:00+05:30</expires>
    <senderName>Test System</senderName>
    <headline>Test Alert</headline>
    <description>This is a test alert</description>
    <instruction>No action required</instruction>
    <area>
      <areaDesc>Test Area</areaDesc>
      <polygon>28.7,77.1 28.7,77.3 28.5,77.3 28.5,77.1 28.7,77.1</polygon>
    </area>
  </info>
</alert>
```

Ingest it:
```bash
curl -X POST http://localhost:8080/api/v1/alerts/cap \
  -H "Content-Type: application/xml" \
  --data-binary @test-alert.xml
```

---

## Step 7: Trigger Pipeline

```bash
curl -X POST http://localhost:8080/api/v1/pipeline/trigger \
  -H "Content-Type: application/json" \
  -d '{"capIdentifier":"test-2026-001"}'
```

---

## Step 8: Check Status

```bash
curl http://localhost:8080/api/v1/pipeline/status/test-2026-001
```

Expected (will halt at subscriber-matching):
```json
{
  "capIdentifier": "test-2026-001",
  "status": "halted",
  "stage": "subscriber-matching",
  "reason": "awaiting subscriber data - modules 03/04 not yet connected",
  "towerCount": 0
}
```

---

## Troubleshooting

### Build Fails?
```bash
# Check Java version
java --version  # Should be 21+

# Clean and retry
mvn clean
mvn compile
```

### Can't Connect to Database?
```bash
# Verify PostgreSQL is running
pg_isready

# Test connection
psql -U postgres -d turant -c "SELECT version();"
```

### PostGIS Not Found?
```sql
-- In psql
CREATE EXTENSION postgis;

-- Verify
SELECT postgis_version();
```

### Port 8080 Already in Use?
```properties
# In application.properties
server.port=8081
```

---

## What's Next?

### Add Tower Data
To test tower matching, you need cell tower data in PostGIS:

```sql
CREATE TABLE cell_towers (
    id TEXT PRIMARY KEY,
    cell_id TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    coverage_radius_m INTEGER,
    geom GEOMETRY(Point, 4326)
);

-- Example tower
INSERT INTO cell_towers VALUES (
    'tower-001',
    '404-10-1234-5678',
    28.6139,
    77.2090,
    2000,
    ST_SetSRID(ST_MakePoint(77.2090, 28.6139), 4326)
);
```

### Add Subscriber Data
For subscriber matching (when ready):

```sql
CREATE TABLE subscribers (
    msisdn TEXT PRIMARY KEY,
    cell_id TEXT,
    -- other fields
);
```

### Configure SMPP
For SMS submission (when credentials available):

```properties
smpp.host=smsc.example.com
smpp.port=2775
smpp.system-id=your-system-id
smpp.password=your-password
```

---

## API Quick Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/healthz` | GET | Health check |
| `/api/v1/alerts/cap` | POST | Ingest CAP XML |
| `/api/v1/pipeline/trigger` | POST | Trigger pipeline |
| `/api/v1/pipeline/status/:id` | GET | Get status |
| `/api/v1/pipeline/report/:id` | GET | Get report |

Full API documentation: See `API_DOCUMENTATION.md`

---

## Development Mode

### Hot Reload
```bash
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-Dspring.devtools.restart.enabled=true"
```

### Debug Mode
```bash
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"
```

Connect debugger to `localhost:5005`

---

## Useful Commands

```bash
# Compile only
mvn compile

# Package JAR
mvn package

# Run tests (when implemented)
mvn test

# Clean everything
mvn clean

# Check dependencies
mvn dependency:tree

# Run specific class
mvn exec:java -Dexec.mainClass="com.turant.TurantApplication"
```

---

## Environment Variables

Override properties via environment:

```bash
export SPRING_DATASOURCE_URL=jdbc:postgresql://prod-db:5432/turant
export SPRING_DATASOURCE_PASSWORD=prod-password
export SMPP_HOST=smsc.production.com

mvn spring-boot:run
```

---

## Docker (Future)

```bash
# Build image
docker build -t turant:latest .

# Run container
docker run -p 8080:8080 \
  -e SPRING_DATASOURCE_URL=jdbc:postgresql://host.docker.internal:5432/turant \
  turant:latest
```

---

## Support

- **Build issues?** Check Maven output for errors
- **Database issues?** Verify PostgreSQL + PostGIS setup
- **API issues?** Check logs in `target/` directory
- **Other issues?** See `TROUBLESHOOTING.md` (when created)

---

## Success Checklist

- [ ] Java 21+ installed and working
- [ ] Maven can build successfully
- [ ] PostgreSQL + PostGIS connected
- [ ] Application starts on port 8080
- [ ] Health check returns `{"status":"UP"}`
- [ ] Can ingest CAP XML alert
- [ ] Can trigger pipeline
- [ ] Can retrieve pipeline status

---

**You're ready to develop! 🚀**

For more details:
- Architecture: `MIGRATION_STATUS.md`
- API Reference: `API_DOCUMENTATION.md`
- Full Summary: `SESSION_FINAL_SUMMARY.md`
