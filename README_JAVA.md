# TURANT — Java/Spring Boot Version

**MIGRATION STATUS: FOUNDATION COMPLETE - MODULES IN PROGRESS**

This is the Java/Spring Boot migration of TURANT (originally TypeScript/Node.js).

## Quick Start

```bash
# Build
mvn clean install

# Run tests
mvn test

# Run application
mvn spring-boot:run

# Or run packaged JAR
java -jar target/turant-0.1.0.jar
```

## What's Been Migrated

### ✅ Complete
- Maven project structure with all dependencies
- Spring Boot application configuration
- All 100+ environment variables mapped
- CAP type definitions (Alert, Info, Area, Geometry, etc.)
- Tower type definitions
- Main application entry point

### 🟡 In Progress
- Remaining type definitions (Subscriber, SMS, Trace, Report)
- Configuration loading and validation
- Persistence layer (PostgreSQL, PostGIS, Redis)
- All 13 modules

### ❌ Not Started
- Module implementations
- Test migration
- Frontend TypeScript→JavaScript conversion
- Utility scripts

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Language | Java 21 |
| Framework | Spring Boot 3.2.2 |
| Build | Maven |
| Database | PostgreSQL + PostGIS |
| Cache | Redis (Lettuce) |
| SMS | SMPP (jSMPP 3.0.1) |
| Logging | Logback + Logstash JSON |
| Testing | JUnit 5 + Mockito |
| Spatial | JTS + PostGIS JDBC |

## Configuration

All environment variables from the TypeScript version are preserved:

```bash
# Copy and configure
cp .env.example .env

# Key variables (same names as TypeScript version)
DATABASE_URL=postgres://user:pass@localhost:5432/turant
REDIS_URL=redis://localhost:6379
SMPP_HOST=
SMPP_PORT=2775
SMPP_SYSTEM_ID=
SMPP_PASSWORD=
PORT=8080
```

See `COMPLETE_MIGRATION_GUIDE.md` for full details.

## Project Structure

```
src/
├── main/
│   ├── java/com/turant/
│   │   ├── TurantApplication.java (main entry point)
│   │   ├── types/
│   │   │   ├── cap/ (CAP 1.2 types)
│   │   │   ├── tower/ (Cell tower types)
│   │   │   ├── subscriber/ (TODO)
│   │   │   ├── sms/ (TODO)
│   │   │   └── trace/ (TODO)
│   │   ├── config/ (TODO)
│   │   ├── cap/ (Module 01 - TODO)
│   │   ├── cellsite/ (Module 02 - TODO)
│   │   ├── subscriber/ (Modules 03/04 - TODO)
│   │   ├── dedup/ (Module 05 - TODO)
│   │   ├── expiry/ (Module 06 - TODO)
│   │   ├── smpp/ (Module 07 - TODO)
│   │   ├── validity/ (Module 08 - TODO)
│   │   ├── priority/ (Module 09 - TODO)
│   │   ├── delivery/ (Module 10 - TODO)
│   │   ├── dlr/ (Module 11 - TODO)
│   │   ├── ews/ (Module 12 - TODO)
│   │   ├── parallel/ (Module 13 - TODO)
│   │   ├── pipeline/ (TODO)
│   │   ├── telecom/ (Simulation - TODO)
│   │   ├── tracing/ (TODO)
│   │   ├── persistence/ (TODO)
│   │   └── utils/ (TODO)
│   └── resources/
│       ├── application.properties (complete)
│       └── db/migration/ (SQL migrations - to be copied)
└── test/ (TODO)
```

## Migration Status by Module

| Module | TypeScript Files | Java Status | Priority |
|--------|-----------------|-------------|----------|
| Foundation | - | ✅ COMPLETE | - |
| Types | 7 | 🟡 40% | HIGH |
| Config | 2 | ❌ 0% | ⚠️ CRITICAL |
| Persistence | 10 | ❌ 0% | ⚠️ CRITICAL |
| 01-CAP | 8 | ❌ 0% | HIGH |
| 02-Towers | 6 | ❌ 0% | HIGH |
| 03/04-Subscribers | 15 | ❌ 0% | ⚠️ CRITICAL |
| 05-Dedup | 2 | ❌ 0% | MEDIUM |
| 06-Expiry | 2 | ❌ 0% | MEDIUM |
| 07-SMPP | 4 | ❌ 0% | ⚠️ CRITICAL |
| 08-Validity | 2 | ❌ 0% | MEDIUM |
| 09-Priority | 2 | ❌ 0% | LOW |
| 10-Delivery | 3 | ❌ 0% | MEDIUM |
| 11-DLR | 4 | ❌ 0% | HIGH |
| 12-EWS | 2 | ❌ 0% | MEDIUM |
| 13-Parallel | 4 | ❌ 0% | ⚠️ CRITICAL |
| Pipeline | 5 | ❌ 0% | HIGH |
| Telecom Sim | 20+ | ❌ 0% | HIGH |
| Tracing | 1 | ❌ 0% | MEDIUM |
| Utils | 3 | ❌ 0% | MEDIUM |

## Estimated Completion

**Current Progress:** ~5% (Foundation only)

**Remaining Effort:** 200-400 development hours

**Critical Path:**
1. Config + Persistence (18 hours)
2. CAP + Towers + SMPP (54 hours)
3. Subscribers + Parallel (36 hours)
4. Remaining modules (40 hours)
5. Tests + Validation (60 hours)
6. Frontend + Scripts (36 hours)

**Recommended:** Professional development team for 6-8 weeks

## API Endpoints (When Complete)

Same as TypeScript version:

- `GET /healthz`
- `POST /api/v1/alerts/cap`
- `POST /api/v1/alerts/manual`
- `GET /api/v1/alerts/:capIdentifier/pipeline-status`
- `GET /api/v1/alerts/:capIdentifier/towers`
- `GET /api/v1/alerts/:capIdentifier/report`
- `GET /api/v1/sim/clusters`
- `GET /api/v1/traces`
- `GET /api/v1/traces/:capIdentifier`

## Database

Same PostgreSQL database as TypeScript version. No schema changes.

```sql
-- Migrations preserved exactly
src/main/resources/db/migration/
  001_init.sql
  002_telecom_sim.sql
  004_subscriber_dump_enrichment.sql
  005_subscriber_dump_cell_index.sql
  006_cell_subscriber_mapping.sql
  007_cell_network_mapping.sql
```

## Dependencies

Key Java libraries chosen to match TypeScript equivalents:

- **express** → **Spring Web MVC**
- **pg** → **PostgreSQL JDBC + Spring JDBC**
- **ioredis** → **Lettuce (Spring Data Redis)**
- **smpp** → **jSMPP**
- **fast-xml-parser** → **Jackson XML**
- **pino** → **Logback + Logstash encoder**
- **vitest** → **JUnit 5 + Mockito**

## Testing

```bash
# Run all tests
mvn test

# Run specific test
mvn test -Dtest=CapParserTest

# Integration tests with Testcontainers
mvn verify
```

## Contributing to Migration

See `COMPLETE_MIGRATION_GUIDE.md` for:
- Detailed file-by-file mapping
- Critical patterns to preserve
- Module-by-module migration steps
- Validation checklist

## Migration Principles

1. **Behavior preservation** - Same inputs → same outputs
2. **API compatibility** - Identical REST endpoints
3. **Database compatibility** - Same schema, same queries
4. **Configuration compatibility** - Same environment variables
5. **Protocol compatibility** - Same SMPP, same PostGIS

**NO changes to functionality, business logic, or external contracts.**

## License

UNLICENSED (same as original)

## Original TypeScript Version

The original TypeScript/Node.js implementation remains in the repository for reference during migration. See `README.md` for original documentation.
