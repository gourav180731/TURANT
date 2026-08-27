# TURANT System Integration Requirements

**Date:** August 20, 2026  
**Version:** 1.0  
**Purpose:** C-DOT/TSP Integration Specification  
**Status:** Awaiting Real Data & Credentials

---

## Executive Summary

The TURANT backend is **architecturally complete** and ready for integration with real telecom infrastructure. This document specifies the exact requirements for connecting to:
1. C-DOT/TSP subscriber database (100M+ records)
2. PostGIS cell tower database (50K+ towers)
3. SMSC gateway (SMPP credentials)

**Timeline:** With access to required systems, integration can be completed in **2 weeks**.

---

## 1. Subscriber Database Integration

### 1.1 Database Requirements

**System:** PostgreSQL 12+ with PostGIS 3.0+ extension

**Connection Parameters:**
```properties
spring.datasource.url=jdbc:postgresql://<HOST>:<PORT>/<DATABASE>
spring.datasource.username=<USERNAME>
spring.datasource.password=<PASSWORD>
spring.datasource.hikari.maximum-pool-size=20
```

### 1.2 Required Table: `subscriber_dump`

**Purpose:** Maps subscribers to their current serving cell tower

**Schema:**
```sql
CREATE TABLE subscriber_dump (
    msisdn TEXT PRIMARY KEY,              -- E.164 format: +919876543210
    serving_cell_id TEXT NOT NULL,        -- Format: MCC-MNC-LAC-CID
    last_updated TIMESTAMP DEFAULT NOW(), -- When record was last updated
    operator TEXT,                        -- Optional: Operator name
    circle TEXT                           -- Optional: Telecom circle
);

-- Critical Index: Required for fast lookup by cell_id
CREATE INDEX idx_subscriber_dump_cell_id ON subscriber_dump(serving_cell_id);
```

**Alternative Schema (If Using TSP Format):**
```sql
CREATE TABLE subscribers (
    id BIGSERIAL PRIMARY KEY,
    mobile_number TEXT NOT NULL UNIQUE,   -- MSISDN
    current_cell_id TEXT NOT NULL,        -- Cell tower ID
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subscribers_cell_id ON subscribers(current_cell_id);
```

### 1.3 Sample Data Format

**Minimum Required Fields:**
```
| msisdn          | serving_cell_id      | last_updated        |
|-----------------|----------------------|---------------------|
| +919876543210   | 404-10-1234-5678     | 2026-08-20 10:30:00 |
| +919876543211   | 404-10-1234-5678     | 2026-08-20 10:30:00 |
| +919123456789   | 405-45-9999-1111     | 2026-08-20 10:29:55 |
```

**Cell ID Format:**
- **MCC (Mobile Country Code):** 404 or 405 (India)
- **MNC (Mobile Network Code):** 10-99 (Operator code)
- **LAC (Location Area Code):** 1000-9999
- **CID (Cell ID):** 1000-9999

### 1.4 Expected Data Volume

- **Total Records:** 100,000,000+ (100M+)
- **Unique Cell IDs:** 50,000+
- **Avg Subscribers/Cell:** 1,000-5,000
- **Update Frequency:** Near real-time (every 1-5 minutes)

### 1.5 Query Pattern

**What TURANT Will Execute:**
```sql
-- Query executed by TelecomSubscriberMatcher.java
SELECT msisdn, serving_cell_id 
FROM subscriber_dump
WHERE serving_cell_id = ANY(?)  -- Array of cell IDs from tower matching
LIMIT 100000;
```

**Performance Requirements:**
- Query must return results in <5 seconds for up to 50,000 cells
- Index on `serving_cell_id` is CRITICAL
- Consider partitioning by operator or circle for large datasets

### 1.6 Alternative: Cell Subscriber Stats (Optimized)

**For Count-Only Operations (Faster):**
```sql
CREATE TABLE cell_subscriber_stats (
    cell_id TEXT PRIMARY KEY,
    subscriber_count BIGINT NOT NULL,     -- Total subscribers (may include duplicates)
    unique_count BIGINT NOT NULL,         -- Unique subscribers
    last_updated TIMESTAMP DEFAULT NOW()
);
```

**Benefits:**
- 50,000 rows vs 100M rows (1000x smaller)
- Instant count aggregation: `SELECT SUM(unique_count) WHERE cell_id = ANY(?)`
- No need to materialize MSISDNs for reporting

**Trade-off:** Cannot send actual SMS without `subscriber_dump` table.

### 1.7 Configuration

**Update `.env` file:**
```properties
# Remove comment symbols to enable
SPRING_DATASOURCE_URL=jdbc:postgresql://tsp-db.example.com:5432/subscribers
SPRING_DATASOURCE_USERNAME=turant_readonly
SPRING_DATASOURCE_PASSWORD=<secure_password>

# Disable simulation mode
SIMULATION_MODE=disabled
```

---

## 2. Cell Tower Database Integration

### 2.1 Database Requirements

**System:** PostgreSQL 12+ with **PostGIS 3.0+** extension

**PostGIS Setup:**
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
```

### 2.2 Required Table: `cell_towers`

**Purpose:** Geospatial index of all cell tower locations and coverage

**Schema (Radius Coverage Model):**
```sql
CREATE TABLE cell_towers (
    id TEXT PRIMARY KEY,                  -- Unique tower identifier
    cell_id TEXT NOT NULL UNIQUE,         -- Format: MCC-MNC-LAC-CID
    latitude DOUBLE PRECISION NOT NULL,   -- Decimal degrees (WGS84)
    longitude DOUBLE PRECISION NOT NULL,  -- Decimal degrees (WGS84)
    coverage_radius_m DOUBLE PRECISION,   -- Coverage radius in meters (e.g., 500)
    operator TEXT,                        -- Optional: Operator name
    technology TEXT,                      -- Optional: 3G, 4G, 5G
    installed_date DATE,                  -- Optional: Installation date
    geom GEOMETRY(Point, 4326)            -- PostGIS point geometry
);

-- CRITICAL: GIST spatial index for fast geospatial queries
CREATE INDEX idx_cell_towers_geom ON cell_towers USING GIST(geom);

-- Index for cell_id lookup
CREATE INDEX idx_cell_towers_cell_id ON cell_towers(cell_id);

-- Auto-populate geom from lat/lng
CREATE TRIGGER update_cell_tower_geom 
BEFORE INSERT OR UPDATE ON cell_towers
FOR EACH ROW
EXECUTE FUNCTION ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
```

**Alternative Schema (Polygon Coverage Model - More Accurate):**
```sql
CREATE TABLE cell_towers (
    id TEXT PRIMARY KEY,
    cell_id TEXT NOT NULL UNIQUE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    coverage_radius_m DOUBLE PRECISION,
    coverage_geom GEOMETRY(Polygon, 4326), -- Actual coverage polygon (from RF modeling)
    operator TEXT,
    technology TEXT
);

-- CRITICAL: GIST index on coverage_geom
CREATE INDEX idx_cell_towers_coverage_geom ON cell_towers USING GIST(coverage_geom);
```

### 2.3 Sample Data Format

**Minimum Required Fields:**
```
| id            | cell_id              | latitude  | longitude | coverage_radius_m |
|---------------|----------------------|-----------|-----------|-------------------|
| tower-0001    | 404-10-1234-5678     | 28.6139   | 77.2090   | 500               |
| tower-0002    | 404-10-1234-5679     | 28.6150   | 77.2100   | 800               |
| tower-0003    | 405-45-9999-1111     | 19.0760   | 72.8777   | 600               |
```

**Coordinate Format:**
- **Latitude:** -90 to +90 (decimal degrees)
- **Longitude:** -180 to +180 (decimal degrees)
- **SRID:** 4326 (WGS84 - standard GPS coordinate system)

### 2.4 Expected Data Volume

- **Total Towers:** 50,000+ (all India)
- **Towers per Region:** 500-5,000
- **Coverage Radius:** 200m (urban) to 5,000m (rural)

### 2.5 Query Pattern

**What TURANT Will Execute:**
```sql
-- Query executed by PostGisTowerSource.java
WITH zone_geom AS (
    SELECT ST_Union(g.geom) AS geom
    FROM (VALUES 
        (ST_GeomFromGeoJSON(?)),  -- CAP polygon 1
        (ST_GeomFromGeoJSON(?))   -- CAP polygon 2
    ) AS g(geom)
)
SELECT id, cell_id, latitude, longitude, coverage_radius_m
FROM cell_towers t, zone_geom z
WHERE z.geom IS NOT NULL
  AND (ST_Intersects(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326), z.geom)
       OR ST_DWithin(
           ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
           z.geom::geography,
           coverage_radius_m
       ))
LIMIT 10000;
```

**Performance Requirements:**
- Query must return results in <30 seconds for complex polygons
- GIST index on `geom` is CRITICAL
- Consider pre-computing `ST_Buffer` for radius coverage

### 2.6 Configuration

**Update `.env` file:**
```properties
# Tower table and column names (adjust if your schema differs)
TOWER_TABLE=cell_towers
TOWER_COLUMN_ID=id
TOWER_COLUMN_CELL_ID=cell_id
TOWER_COLUMN_LATITUDE=latitude
TOWER_COLUMN_LONGITUDE=longitude
TOWER_COLUMN_COVERAGE_RADIUS_M=coverage_radius_m

# Coverage model: "radius" or "polygon"
TOWER_COVERAGE_MODEL=radius

# Geom SRID (4326 for WGS84)
TOWER_GEOM_SRID=4326

# Query limits
TOWER_MATCH_LIMIT=100000
TOWER_MATCH_TIMEOUT_MS=30000
```

---

## 3. SMSC Gateway Integration (SMPP)

### 3.1 SMPP Requirements

**Protocol:** SMPP v3.4 (Short Message Peer-to-Peer)

**Client Library:** jSMPP 3.0.0 (already integrated)

### 3.2 Required Credentials

**Connection Parameters:**
```properties
SMPP_HOST=smsc.cdot.example.com         # SMSC gateway hostname/IP
SMPP_PORT=2775                          # Standard SMPP port
SMPP_SYSTEM_ID=turant_user              # Your assigned system ID
SMPP_PASSWORD=<secure_password>         # Your SMPP password
SMPP_SYSTEM_TYPE=                       # Optional: CMT, VMS, etc.
```

**Additional Configuration:**
```properties
# Bind mode: "transmitter", "receiver", "transceiver"
SMPP_BIND_MODE=transceiver

# SMPP protocol version
SMPP_INTERFACE_VERSION=52               # 0x34 = 52 decimal (SMPP 3.4)

# Source address (sender ID)
SMPP_SRC_ADDR=NDMA-ALERT               # 11-char alphanumeric sender
SMPP_SRC_ADDR_TON=5                    # 5 = Alphanumeric
SMPP_SRC_ADDR_NPI=0                    # 0 = Unknown

# Destination address (recipient)
SMPP_DEST_ADDR_TON=1                   # 1 = International
SMPP_DEST_ADDR_NPI=1                   # 1 = E.164

# Timeouts and concurrency
SMPP_SUBMIT_TIMEOUT_MS=60000           # 60 seconds per submit_sm
SMPP_SUBMIT_CONCURRENCY=10             # Parallel submissions
SMPP_RECONNECT_DELAY_MS=5000           # 5 seconds between reconnects
SMPP_ENQUIRE_LINK_PERIOD_MS=30000      # 30 seconds keepalive
```

### 3.3 Expected SMPP Behavior

**Bind Sequence:**
```
1. TCP connect to SMPP_HOST:SMPP_PORT
2. Send bind_transceiver PDU with system_id + password
3. Receive bind_transceiver_resp with status = 0 (success)
4. Start enquire_link keepalive every 30 seconds
```

**Submit Sequence:**
```
1. Construct submit_sm PDU with:
   - source_addr = SMPP_SRC_ADDR
   - dest_addr = recipient MSISDN (+919876543210)
   - short_message = alert text (160 chars GSM7 or 70 chars UCS2)
   - priority_flag = 0-3 (from CAP severity)
   - validity_period = from CAP <expires> timestamp
   - registered_delivery = 1 (request DLR)
   
2. Send submit_sm to SMSC
3. Receive submit_sm_resp with:
   - command_status = 0 (accepted) or error code
   - message_id = SMSC tracking ID
```

**Error Handling:**
```
- command_status = 0x00 → accepted
- command_status = 0x04 → ESME_RINVMSGLEN (message too long)
- command_status = 0x08 → ESME_RINVSRCADR (invalid source address)
- command_status = 0x0a → ESME_RINVDSTADR (invalid destination)
- command_status = 0x400 → ESME_RTHROTTLED (rate limit exceeded)
```

### 3.4 Throughput Expectations

**Typical SMSC Performance:**
- **Single Connection:** 20-50 msg/sec
- **Multiple Connections (10):** 200-500 msg/sec
- **Latency:** 10-50ms per submit_sm

**TURANT Processing Performance (Measured):**
- **Deduplication:** 149,254 msg/sec
- **Batch Processing:** 15,924 msg/sec (8 workers)
- **Bottleneck:** SMSC connection speed, NOT application

**Recommendation:** Request 10-20 concurrent SMSC connections for high-volume alerts.

### 3.5 Configuration

**Update `.env` file:**
```properties
# Uncomment and fill in with real C-DOT credentials
SMPP_HOST=smsc.cdot.example.com
SMPP_PORT=2775
SMPP_SYSTEM_ID=turant_prod
SMPP_PASSWORD=<secure_password>

# Sender ID (must be pre-registered with SMSC)
SMPP_SRC_ADDR=NDMA-ALERT

# Disable simulation mode
SIMULATION_MODE=disabled
```

### 3.6 Testing Plan

**Phase 1: Sandbox Testing (Week 1)**
1. Connect to C-DOT SMPP sandbox
2. Send 10 test messages
3. Verify delivery receipts
4. Measure latency and throughput

**Phase 2: Load Testing (Week 2)**
1. Send 1,000 messages in 1 minute
2. Send 10,000 messages in 10 minutes
3. Test throttling behavior
4. Verify error handling

**Phase 3: Production Pilot (Week 3)**
1. Send real alerts to 100 test subscribers
2. Monitor delivery success rate
3. Validate end-to-end latency
4. Adjust connection pool size

---

## 4. Redis Integration (Optional - For Caching)

### 4.1 Redis Requirements

**System:** Redis 6.0+

**Purpose:** 
- Cache subscriber counts by cell_id
- Store pipeline status records
- Cache delivery reports (DLR tracking)

### 4.2 Configuration

```properties
REDIS_HOST=redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=<optional_password>
REDIS_DB=0
REDIS_POOL_MAX_TOTAL=20
REDIS_POOL_MAX_IDLE=10
```

### 4.3 Data Structures

**Cell Stats Cache:**
```
Key: cell:stats:{cell_id}
Type: Hash
Fields:
  - subscriber_count: 1234
  - unique_count: 1200
  - last_updated: 1692518400
TTL: 5 minutes
```

**Pipeline Status:**
```
Key: pipeline:status:{capIdentifier}
Type: Hash
Fields:
  - status: "completed"
  - stage: "done"
  - towers: 145
  - matched: 97450
  - submitted: 97450
TTL: 24 hours
```

**Note:** Redis is OPTIONAL. System works without it (uses in-memory cache).

---

## 5. Network & Firewall Requirements

### 5.1 Inbound Traffic (To TURANT)

**Port 8080 (HTTP REST API):**
- Source: EWS Dashboard, monitoring systems
- Protocol: HTTP
- Purpose: CAP alert ingestion, status queries

**Recommendation:** Use HTTPS (port 443) with TLS certificate in production.

### 5.2 Outbound Traffic (From TURANT)

**PostgreSQL Database:**
- Destination: TSP subscriber DB + PostGIS tower DB
- Port: 5432
- Protocol: TCP (PostgreSQL wire protocol)

**Redis Cache (Optional):**
- Destination: Redis server
- Port: 6379
- Protocol: TCP (Redis protocol)

**SMSC Gateway:**
- Destination: C-DOT SMSC
- Port: 2775 (standard SMPP)
- Protocol: TCP (SMPP 3.4)
- **CRITICAL:** Long-lived connection (not HTTP-style request/response)

### 5.3 Firewall Rules

**Allow TURANT → PostgreSQL:**
```
Source: 10.x.x.x (TURANT server IP)
Destination: 10.y.y.y (PostgreSQL server IP)
Port: 5432
Protocol: TCP
```

**Allow TURANT → SMSC:**
```
Source: 10.x.x.x (TURANT server IP)
Destination: 10.z.z.z (SMSC gateway IP)
Port: 2775
Protocol: TCP
```

**Allow EWS → TURANT:**
```
Source: 10.a.a.a (EWS dashboard IP)
Destination: 10.x.x.x (TURANT server IP)
Port: 8080 or 443
Protocol: TCP (HTTP/HTTPS)
```

---

## 6. Security Requirements

### 6.1 Database Credentials

**Use Read-Only Account for Queries:**
```sql
-- Create read-only user for TURANT
CREATE USER turant_readonly WITH PASSWORD '<secure_password>';

-- Grant SELECT only on required tables
GRANT SELECT ON subscriber_dump TO turant_readonly;
GRANT SELECT ON cell_towers TO turant_readonly;
GRANT SELECT ON cell_subscriber_stats TO turant_readonly;

-- Revoke write permissions
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM turant_readonly;
```

### 6.2 SMPP Credentials

**Protect SMPP Credentials:**
- Never commit to Git (use environment variables or secret manager)
- Rotate passwords quarterly
- Use unique credentials per environment (sandbox, production)
- Monitor for unauthorized bind attempts

### 6.3 TLS/SSL

**Database Connection:**
```properties
spring.datasource.url=jdbc:postgresql://host:5432/db?sslmode=require
```

**SMPP Connection:**
- SMPP v3.4 uses TCP (not TLS by default)
- Consider VPN or IPSec tunnel for SMSC connection
- Use IP whitelisting on SMSC side

**REST API:**
- Use HTTPS with valid TLS certificate in production
- Disable HTTP (port 8080) or redirect to HTTPS

### 6.4 API Authentication (Future)

**Current Status:** Not implemented (development only)

**Recommended for Production:**
1. **API Keys:** For machine-to-machine (EWS dashboard → TURANT)
2. **JWT Tokens:** For user sessions (operators, admins)
3. **Role-Based Access Control:**
   - Admin: Full access (create alerts, view reports)
   - Operator: Create alerts, view status
   - Read-only: View reports only

---

## 7. Deployment Requirements

### 7.1 Server Specifications

**Minimum:**
- CPU: 4 cores
- RAM: 8 GB
- Disk: 50 GB SSD
- OS: Ubuntu 20.04+ or RHEL 8+
- Java: OpenJDK 22+

**Recommended (Production):**
- CPU: 8 cores
- RAM: 16 GB
- Disk: 100 GB SSD
- OS: Ubuntu 22.04 LTS
- Java: OpenJDK 22+
- PostgreSQL: Separate server (not colocated)

### 7.2 Software Dependencies

**Required:**
- Java 22+ Runtime (OpenJDK or Oracle JDK)
- PostgreSQL 12+ client libraries
- Network connectivity to database and SMSC

**Optional:**
- Docker Engine 20.10+ (for containerized deployment)
- nginx (for HTTPS termination and load balancing)
- Prometheus + Grafana (for monitoring)

### 7.3 Environment Variables

**Copy `.env.example` to `.env` and configure:**
```bash
cp .env.example .env
nano .env  # Edit with real credentials
```

**Key Variables to Configure:**
```properties
# Database
SPRING_DATASOURCE_URL=jdbc:postgresql://...
SPRING_DATASOURCE_USERNAME=turant_readonly
SPRING_DATASOURCE_PASSWORD=<password>

# SMPP
SMPP_HOST=smsc.cdot.example.com
SMPP_SYSTEM_ID=turant_prod
SMPP_PASSWORD=<password>

# Disable simulation
SIMULATION_MODE=disabled
```

### 7.4 Deployment Options

**Option 1: Bare Metal (Systemd Service)**
```bash
# Build JAR
mvn clean package -DskipTests

# Copy to server
scp target/turant-1.0.0.jar user@server:/opt/turant/

# Create systemd service
sudo nano /etc/systemd/system/turant.service

# Start service
sudo systemctl start turant
sudo systemctl enable turant
```

**Option 2: Docker Container**
```bash
# Build image
docker build -t turant:latest .

# Run container
docker run -d \
  --name turant \
  -p 8080:8080 \
  --env-file .env \
  turant:latest
```

**Option 3: Kubernetes (Production)**
```bash
# Deploy with Helm chart
helm install turant ./helm/turant \
  --values production-values.yaml \
  --namespace turant-prod
```

---

## 8. Validation & Testing

### 8.1 Integration Checklist

**Database Integration:**
- [ ] PostgreSQL connection successful
- [ ] PostGIS extension installed
- [ ] `cell_towers` table populated with 50K+ records
- [ ] `subscriber_dump` table populated with 100M+ records
- [ ] Spatial indexes created (GIST on `geom`)
- [ ] Query performance <5 seconds for 50K cells

**SMSC Integration:**
- [ ] SMPP bind successful
- [ ] Test message sent and acknowledged
- [ ] Delivery receipt received
- [ ] Error handling works (invalid MSISDN, throttling)
- [ ] Throughput measured (20-50 msg/sec per connection)

**End-to-End Test:**
- [ ] CAP alert ingested via REST API
- [ ] Towers resolved from PostGIS (<30 seconds)
- [ ] Subscribers matched from database
- [ ] Deduplication completes
- [ ] Messages submitted to SMSC
- [ ] Delivery status tracked

### 8.2 Performance Validation

**50K Cell Tower Query:**
```
Requirement: <60 seconds for 50,000 cell towers in alert zone
Test: Create CAP alert covering large area (e.g., entire Delhi)
Measure: Tower resolution time
Success: <60 seconds with 50K towers
```

**100M Subscriber Matching:**
```
Requirement: Query 100M records, match by cell_id
Test: Query 50,000 cell IDs from subscriber_dump
Measure: Query execution time
Success: <5 seconds with indexes
```

**SMPP Throughput:**
```
Requirement: Submit 10,000 messages
Test: Send batch via ParallelOrchestrator
Measure: End-to-end time
Success: <10 minutes (16 msg/sec+)
```

### 8.3 Failure Scenarios

**Test These Error Conditions:**
1. PostgreSQL connection lost mid-query
2. SMSC connection dropped during submission
3. Invalid cell_id (no matching tower)
4. Empty subscriber list (no one in affected area)
5. SMPP throttling (rate limit exceeded)
6. Database timeout (query >30 seconds)

---

## 9. Support & Contacts

### 9.1 Required Information from C-DOT/TSP

**Database Access:**
- [ ] PostgreSQL connection string
- [ ] Read-only username and password
- [ ] Database schema documentation
- [ ] Sample data (10K records) for testing

**SMPP Sandbox:**
- [ ] SMSC hostname/IP
- [ ] Sandbox system_id and password
- [ ] Allowed sender IDs (e.g., "NDMA-ALERT")
- [ ] Rate limits and throttling policy

**Network Access:**
- [ ] Firewall rules configured (TURANT → DB, TURANT → SMSC)
- [ ] VPN credentials (if required)
- [ ] IP whitelisting completed

### 9.2 TURANT Team Contacts

**Technical Lead:** [Your Name]  
**Email:** [your.email@example.com]  
**Phone:** [+91-XXXXXXXXXX]

**For Integration Support:**
- Database issues: [db-team@example.com]
- SMPP issues: [smpp-team@example.com]
- Deployment issues: [devops@example.com]

---

## 10. Timeline & Milestones

### Week 1: Database Integration
- **Day 1-2:** Receive PostgreSQL credentials and schema
- **Day 3:** Connect TURANT to database
- **Day 4:** Test tower resolution with 50K towers
- **Day 5:** Test subscriber matching with 100M records
- **Deliverable:** Performance benchmark report

### Week 2: SMPP Integration
- **Day 1-2:** Receive SMSC sandbox credentials
- **Day 3:** Connect TURANT to SMSC
- **Day 4:** Send 100 test messages
- **Day 5:** Load test with 10,000 messages
- **Deliverable:** SMPP integration report

### Week 3: End-to-End Testing
- **Day 1-2:** Full pipeline test (CAP → SMS)
- **Day 3:** Error handling validation
- **Day 4:** Performance tuning
- **Day 5:** Documentation and handover
- **Deliverable:** Production readiness certificate

---

## Appendix A: Sample CAP Alert

```xml
<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>NDMA-TEST-2026-001</identifier>
  <sender>ndma@nic.in</sender>
  <sent>2026-08-20T10:00:00+05:30</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  
  <info>
    <language>en-IN</language>
    <category>Met</category>
    <event>Severe Thunderstorm</event>
    <urgency>Immediate</urgency>
    <severity>Extreme</severity>
    <certainty>Observed</certainty>
    <expires>2026-08-20T14:00:00+05:30</expires>
    
    <headline>Severe Thunderstorm Warning for Delhi NCR</headline>
    <description>
      A severe thunderstorm is approaching Delhi NCR region. 
      Heavy rain, lightning, and strong winds expected.
      Take shelter immediately.
    </description>
    
    <area>
      <areaDesc>Delhi NCR</areaDesc>
      <polygon>
        28.5,77.1 28.7,77.1 28.7,77.3 28.5,77.3 28.5,77.1
      </polygon>
    </area>
  </info>
</alert>
```

---

## Appendix B: Configuration Files

### B.1 Complete `.env` for Production

```properties
# Application
SPRING_PROFILES_ACTIVE=production
SERVER_PORT=8080

# Simulation Mode (DISABLE for production)
SIMULATION_MODE=disabled

# Database (REQUIRED for production)
SPRING_DATASOURCE_URL=jdbc:postgresql://tsp-db.cdot.in:5432/subscribers?sslmode=require
SPRING_DATASOURCE_USERNAME=turant_readonly
SPRING_DATASOURCE_PASSWORD=<REPLACE_WITH_REAL_PASSWORD>
SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE=20
SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT=10000
SPRING_DATASOURCE_HIKARI_IDLE_TIMEOUT=30000

# Redis (OPTIONAL for production)
REDIS_HOST=redis.cdot.in
REDIS_PORT=6379
REDIS_PASSWORD=<REPLACE_WITH_REAL_PASSWORD>

# SMPP (REQUIRED for production)
SMPP_HOST=smsc.cdot.in
SMPP_PORT=2775
SMPP_SYSTEM_ID=turant_prod
SMPP_PASSWORD=<REPLACE_WITH_REAL_PASSWORD>
SMPP_SRC_ADDR=NDMA-ALERT
SMPP_SRC_ADDR_TON=5
SMPP_SRC_ADDR_NPI=0
SMPP_DEST_ADDR_TON=1
SMPP_DEST_ADDR_NPI=1
SMPP_SUBMIT_TIMEOUT_MS=60000
SMPP_SUBMIT_CONCURRENCY=10

# Logging
LOGGING_LEVEL_ROOT=INFO
LOGGING_LEVEL_COM_TURANT=INFO

# Parallel Processing
TURANT_PARALLEL_MAX_WORKERS=8
TURANT_PARALLEL_BATCH_SIZE=500

# Tower Configuration
TURANT_TOWER_MATCH_LIMIT=100000
TURANT_TOWER_MATCH_TIMEOUT_MS=30000

# Subscriber Configuration
TURANT_SUBSCRIBER_CHUNK_SIZE=5000
TURANT_SUBSCRIBER_MATCH_TIMEOUT_MS=300000
```

---

**END OF INTEGRATION REQUIREMENTS**

**Next Steps:**
1. Review this document with C-DOT/TSP team
2. Schedule access provisioning meeting
3. Obtain credentials for sandbox environment
4. Begin Week 1 integration testing

**Questions?** Contact: [your.email@example.com]
