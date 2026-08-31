# TURANT - TypeScript to Java Migration Report

## Migration Status: IN PROGRESS

This document tracks the migration of TURANT from TypeScript/Node.js to Java/Spring Boot.

## Objective

Language/runtime migration ONLY - preserving 100% of existing functionality, APIs, database schema, and business logic.

## Project Scope

### TypeScript Source Files Analyzed
- **Total TypeScript Files**: ~150+
- **Modules**: 13 (01-CAP through 13-Parallel)
- **Supporting Code**: Config, Types, Persistence, Tracing, Utils, Telecom
- **Test Files**: 100+
- **Scripts**: 20+ utility scripts
- **Frontend**: React/TypeScript/Vite with Leaflet

### Technology Stack Mapping

| TypeScript/Node.js | Java/Spring Boot |
|-------------------|------------------|
| Node.js 20+ | Java 21 |
| Express 5 | Spring Web MVC |
| TypeScript strict mode | Java records + strict null checks |
| pg (PostgreSQL) | Spring JDBC + PostgreSQL JDBC |
| PostGIS queries | PostGIS JDBC + JTS |
| ioredis | Spring Data Redis (Lettuce) |
| smpp (0.6.0-rc.4) | jSMPP 3.0.1 |
| pino (JSON logging) | Logback + Logstash encoder |
| zod (validation) | Spring Validation + Jakarta |
| fast-xml-parser | Jackson XML |
| vitest | JUnit 5 + Mockito |
| tsx watch | Spring Boot DevTools |

## Migration Phases

### Phase 1: Foundation ✅ COMPLETE
- [x] Repository inspection
- [x] Dependency analysis
- [x] Maven pom.xml with all dependencies
- [x] application.properties with ALL env variables
- [x] Main Spring Boot application class

### Phase 2: Core Types (IN PROGRESS)
- [ ] CAP types (Alert, Info, Area, Polygon, Circle)
- [ ] Tower types (CellTower, GeoZone, TowerSource)
- [ ] Subscriber types (TelecomSubscrriber, SubscriberRepository)
- [ ] SMS types (SmsMessage, SubmissionResult)
- [ ] Trace types (TraceRecord, TraceStore)
- [ ] Report types (DeliveryReport, PipelineStatus)

### Phase 3: Configuration
- [ ] Environment variable loading
- [ ] Config validation
- [ ] Connection pool configuration

### Phase 4: Persistence Layer
- [ ] PostgreSQL connection pool
- [ ] PostGIS spatial query support
- [ ] Redis client
- [ ] Migration scripts (SQL preserved as-is)

### Phase 5: Module 01 - CAP Ingestion
- [ ] CAP XML parser (fast-xml-parser → Jackson XML)
- [ ] CAP schema validation
- [ ] CAP ingestion service
- [ ] CAP REST routes
- [ ] CAP directory poller
- [ ] Manual alert synthesizer

### Phase 6: Module 02 - Cell Site Identification
- [ ] Tower source abstraction
- [ ] PostGIS adapter (ST_Intersects, ST_DWithin, ST_Buffer)
- [ ] HTTP adapter
- [ ] Memory adapter
- [ ] Tower resolver
- [ ] Debug routes

### Phase 7: Module 03/04 - Subscriber Matching
- [ ] Subscriber repository interface
- [ ] In-memory repository
- [ ] PostgreSQL repository
- [ ] Subscriber matcher interface
- [ ] Cell-indexed matcher
- [ ] Polygon matcher
- [ ] Bridge matcher (LAC/CISAC)
- [ ] Benchmark routes

### Phase 8: Module 05 - Deduplication
- [ ] E.164 MSISDN deduplication
- [ ] Set-based uniqueness

### Phase 9: Module 06 - Expiry Control
- [ ] Expiry guard
- [ ] CAP expires timestamp handling
- [ ] Submission halt logic

### Phase 10: Module 07 - SMPP Integration
- [ ] SMPP client (node-smpp → jSMPP)
- [ ] SMPP session lifecycle
- [ ] Bind (transceiver/transmitter)
- [ ] submit_sm PDU building
- [ ] Reconnect logic
- [ ] Batch submitter

### Phase 11: Module 08 - SMPP Validity
- [ ] CAP expires → SMPP validity_period conversion
- [ ] Absolute/relative validity formats
- [ ] UTC timezone handling

### Phase 12: Module 09 - Priority
- [ ] priority_flag=3 for early-warning
- [ ] CAP severity mapping

### Phase 13: Module 10 - Delivery Strategy
- [ ] Single-attempt mode
- [ ] Retry mode
- [ ] Retry queue
- [ ] Backoff logic
- [ ] Expiry-aware retry stopping

### Phase 14: Module 11 - DLR
- [ ] deliver_sm PDU handling
- [ ] DLR listener
- [ ] DLR reporter
- [ ] Per-message state tracking
- [ ] Report routes

### Phase 15: Module 12 - EWS Callback
- [ ] HTTP callback client
- [ ] Completion report payload
- [ ] Token authentication

### Phase 16: Module 13 - Parallel Processing
- [ ] Worker thread orchestrator (worker_threads → ExecutorService)
- [ ] Batch distribution
- [ ] Worker pool executor
- [ ] Inline mode
- [ ] Threads mode
- [ ] Expiry propagation

### Phase 17: Pipeline Integration
- [ ] Alert pipeline orchestrator
- [ ] Pipeline status tracking
- [ ] Report builder
- [ ] Routes (status, towers, report)

### Phase 18: Telecom Simulation
- [ ] PRNG (deterministic seeding)
- [ ] Identity generators (IMSI, MSISDN, IMEI)
- [ ] Tower generator
- [ ] Subscriber generator
- [ ] Geography (Delhi-NCR, 18-city clusters)
- [ ] In-memory seeder
- [ ] PostgreSQL seeder (COPY support)
- [ ] Master dataset seeder
- [ ] Simulator service

### Phase 19: Tracing
- [ ] Trace store (memory + Redis mirror)
- [ ] t0-t5 stage recording
- [ ] Latency routes
- [ ] Percentile calculations

### Phase 20: Utilities
- [ ] Structured JSON logging (pino → Logback)
- [ ] Geometry conversion (GeoJSON, WKT)
- [ ] Audit trail

### Phase 21: REST API
- [ ] Health endpoint
- [ ] CAP routes
- [ ] Manual alert routes
- [ ] Pipeline status routes
- [ ] Tower routes
- [ ] Sim cluster routes
- [ ] Trace routes
- [ ] Report routes
- [ ] Debug routes

### Phase 22: Frontend
- [ ] React component migration (TSX → JSX)
- [ ] Remove TypeScript types
- [ ] Preserve all UI behavior
- [ ] Leaflet map integration
- [ ] API client (fetch calls)
- [ ] Polygon drawing
- [ ] Tower markers
- [ ] Status polling

### Phase 23: Tests
- [ ] CAP ingestion tests
- [ ] Tower matching tests
- [ ] Subscriber matching tests
- [ ] Dedup tests
- [ ] Expiry tests
- [ ] SMPP tests
- [ ] Validity tests
- [ ] Priority tests
- [ ] Retry tests
- [ ] DLR tests
- [ ] Parallel execution tests
- [ ] Pipeline integration tests
- [ ] Telecom generator tests
- [ ] Trace tests

### Phase 24: Scripts
- [ ] Telecom seed script
- [ ] Master dataset seed
- [ ] Benchmark scripts
- [ ] Validation scripts
- [ ] Profiling tools

### Phase 25: Build & Deployment
- [ ] Maven build configuration
- [ ] Dockerfile (Node → Java)
- [ ] Docker Compose updates
- [ ] CI/CD updates

## Environment Variables Preserved

ALL 100+ environment variables from .env.example are preserved with identical names:

### Application
- NODE_ENV → (Spring profiles)
- PORT
- APP_NAME
- ENABLE_DEBUG_ENDPOINTS

### Logging
- LOG_LEVEL
- LOG_PRETTY
- AUDIT_LOG_FILE

### Database
- DATABASE_URL
- PG_POOL_MAX
- PG_POOL_IDLE_TIMEOUT_MS
- PG_POOL_CONNECTION_TIMEOUT_MS

### Redis
- REDIS_URL
- REDIS_KEY_PREFIX

### Tower Configuration
- TOWER_SOURCE_MODE
- TOWER_TABLE
- TOWER_COL_* (all column mappings)
- TOWER_COVERAGE_MODEL
- TOWER_MATCH_TIME_BUDGET_MS
- TOWER_MATCH_LIMIT

### CAP Configuration
- CAP_POLL_ENABLED
- CAP_POLL_DIR
- CAP_POLL_INTERVAL_MS
- CAP_PREFERRED_LANGUAGE
- CAP_MAX_XML_BYTES

### Subscriber Configuration
- SUBSCRIBER_PREFETCH_ENABLED
- SUBSCRIBER_TABLE
- SUBSCRIBER_COL_* (all column mappings)
- SUBSCRIBER_LOOKUP_MODE
- MATCH_TIME_BUDGET_MS

### Telecom Simulation
- USE_DUMMY_SUBSCRIBER_DB
- SUBSCRIBER_DB_MODE
- SIM_REGION
- SIM_SEED
- DUMMY_SUBSCRIBER_COUNT
- DUMMY_TOWER_COUNT
- MIN_USERS_PER_TOWER
- MAX_USERS_PER_TOWER
- ACTIVE_SUBSCRIBER_PCT
- SEED_BATCH_SIZE
- SEED_WORKERS
- SEED_USE_COPY
- SIM_SEED_RESET
- SUBSCRIBER_PARTITIONS
- TECH_GSM_PCT
- TECH_UMTS_PCT
- TECH_LTE_PCT
- TECH_NR5G_PCT

### SMPP Configuration
- SMPP_HOST
- SMPP_PORT
- SMPP_SYSTEM_ID
- SMPP_PASSWORD
- SMPP_SYSTEM_TYPE
- SMPP_BIND_MODE
- SMPP_INTERFACE_VERSION
- SMPP_SRC_ADDR_TON
- SMPP_SRC_ADDR_NPI
- SMPP_SRC_ADDR
- SMPP_DEST_ADDR_TON
- SMPP_DEST_ADDR_NPI
- SMS_DATA_CODING
- SMS_REGISTERED_DELIVERY
- SMPP_RECONNECT_DELAY_MS
- SMPP_SUBMIT_TIMEOUT_MS
- SMPP_ENQUIRE_LINK_PERIOD_MS
- SMPP_SUBMIT_CONCURRENCY

### Delivery & Expiry
- DELIVERY_STRATEGY
- DELIVERY_RETRY_MAX
- DELIVERY_RETRY_INTERVAL_MS
- EXPIRY_HALT_SUBMISSION

### EWS Callback
- EWS_CALLBACK_URL
- EWS_CALLBACK_TOKEN
- EWS_CALLBACK_TIMEOUT_MS

### Parallel Processing
- PARALLEL_EXECUTION_MODE
- PARALLEL_WORKER_COUNT
- SUBMIT_BATCH_SIZE

### Tracing
- TRACE_TTL_HOURS

## API Endpoints Preserved

ALL REST endpoints preserved with identical paths, methods, request/response formats:

### Core Endpoints
- `GET /healthz`
- `POST /api/v1/alerts/cap`
- `POST /api/v1/alerts/manual`
- `GET /api/v1/alerts/:capIdentifier/pipeline-status`
- `GET /api/v1/alerts/:capIdentifier/towers`
- `GET /api/v1/alerts/:capIdentifier/report`
- `GET /api/v1/sim/clusters`
- `GET /api/v1/traces`
- `GET /api/v1/traces/:capIdentifier`

### Debug Endpoints (when enabled)
- `POST /api/v1/debug/towers/resolve`
- `GET /api/v1/debug/sim`
- `GET /api/v1/debug/sim/towers`
- `GET /api/v1/debug/sim/subscribers`

### Benchmark Endpoints
- `POST /api/v1/benchmark/subscriber-match`

## Database Schema Preserved

ALL PostgreSQL tables, columns, indexes, constraints, and PostGIS spatial functions preserved exactly as-is.

### Tables
- alerts
- cell_towers
- subscribers
- subscriber_dump
- telecom_master
- cell_network_mapping
- delivery_reports
- (all tables from migrations 001-010)

### Spatial Functions
- ST_Intersects
- ST_DWithin
- ST_Buffer
- ST_GeomFromGeoJSON
- ST_GeomFromText
- ST_SetSRID
- (all PostGIS semantics preserved)

## Redis Key Contracts Preserved

ALL Redis keys preserve exact structure:

- `turant:trace:{capIdentifier}` - Trace records
- `turant:subscriber:prefetch:{cellId}` - Cached subscribers
- `turant:pipeline:{capIdentifier}` - Pipeline status
- `turant:dlr:{messageId}` - Delivery receipts

## Critical Behavioral Preservation

### SMPP Protocol
- Exact SMPP 3.4 PDU structure
- bind_transceiver / bind_transmitter semantics
- submit_sm command format
- deliver_sm handling
- command_status error codes
- Reconnect behavior
- Enquire_link keepalive

### PostGIS Spatial Queries
- ST_Intersects logic for polygon-tower matching
- ST_DWithin(geography) for circle-radius matching
- ST_Buffer for coverage footprints
- Exact SRID handling (4326 = WGS84)
- statement_timeout enforcement

### CAP XML Processing
- CAP 1.2 specification compliance
- Polygon ring validation
- Circle validation
- Multi-polygon support
- Language preference
- Expires timestamp handling

### Pipeline Execution
- Stage ordering: 01 → 02 → 03/04 → 05 → 06-10 → 11 → 12 → 13
- Halt-on-error behavior
- Async execution
- Status reporting

### Worker Thread Execution
- Batch distribution algorithm
- Expiry propagation to workers
- Result aggregation
- Thread pool lifecycle

### Tracing
- t0-t5 stage timestamps
- Delta calculations
- Percentile computations
- Redis mirroring

## Build Commands

### TypeScript (Original)
```bash
npm install
npm run build
npm test
npm run dev
npm start
```

### Java (Migrated)
```bash
mvn clean install
mvn test
mvn spring-boot:run
java -jar target/turant-0.1.0.jar
```

## Testing Strategy

### Unit Tests
- Every TypeScript test → JUnit 5 test
- vitest assertions → JUnit assertions
- Mockito for mocking

### Integration Tests
- Testcontainers for PostgreSQL + PostGIS
- Testcontainers for Redis
- Real SMPP server for protocol tests

### Behavioral Parity Tests
- Compare TypeScript output vs Java output
- Same inputs → same outputs
- Same errors → same error codes
- Same status codes

## Known Technical Differences

### Unavoidable Due to Language/Runtime

1. **Worker Threads**: Node.js worker_threads → Java ExecutorService
   - Behavior preserved, implementation differs

2. **Event Loop**: Node.js async/event loop → Java thread pool
   - Async behavior preserved via CompletableFuture

3. **Dynamic Typing**: TypeScript optional → Java Optional<T>
   - Null safety preserved, explicit types

4. **Module System**: ES modules → Java packages
   - Structure preserved, import syntax differs

5. **JSON Serialization**: JavaScript native → Jackson
   - Field names preserved exactly

### All Other Behavior Identical

- Database queries (SQL preserved verbatim)
- SMPP PDU structure
- Redis key format
- API request/response JSON
- Configuration variable names
- Error messages
- Status codes
- Pipeline logic
- Business rules

## Validation Checklist

- [ ] Maven build succeeds
- [ ] All tests pass
- [ ] Spring Boot starts
- [ ] PostgreSQL connects
- [ ] PostGIS queries work
- [ ] Redis connects
- [ ] SMPP client initializes
- [ ] CAP XML parses
- [ ] Tower matching works
- [ ] Subscriber matching works
- [ ] Deduplication works
- [ ] Expiry stops processing
- [ ] SMPP submits work
- [ ] DLR handling works
- [ ] EWS callback works
- [ ] Parallel execution works
- [ ] Tracing works
- [ ] API endpoints return correct responses
- [ ] Frontend behavior unchanged
- [ ] No TypeScript remaining
- [ ] No Node.js backend

## Current Status

**Foundation Complete**: ✅
- pom.xml with all dependencies
- application.properties with all configuration
- Main Spring Boot class

**Next Steps**: Continue with type definitions and module migration

**Estimated Completion**: This is a multi-day/multi-week effort requiring systematic module-by-module migration.

---

*This migration preserves 100% of TURANT's functionality while changing only the implementation language from TypeScript to Java.*
