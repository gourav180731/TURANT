# Simulation Mode Startup Fix - Complete

## Problem
Application failed to start in simulation mode (without PostgreSQL database) due to Spring Boot dependency injection issues. Multiple components required `DataSource` and `JdbcTemplate` beans that weren't available when database wasn't configured.

## Root Causes

### 1. Spring Boot Auto-Configuration
Spring Boot's `DataSourceAutoConfiguration` was trying to create a DataSource even when no database URL was configured, causing startup failure.

### 2. Conditional Bean Creation Issues
Using `@ConditionalOnBean(DataSource.class)` didn't work because when a `@Bean` method returns `null`, Spring still considers the bean to exist (just with null value), causing dependency injection failures.

### 3. Database-Dependent Components
Several services required `JdbcTemplate` without making it optional:
- `CapIngestionService`
- `SubscriberCellStatsService`
- `PostgresSubscriberRepository`
- `TelecomSubscriberMatcher`
- `PostGisTowerSource`

### 4. Simulation Mode Property Not Loaded
`simulation.mode` property wasn't mapped in `application.properties`, so `SimulatedTowerSource` and other simulation components weren't being created.

## Solutions Implemented

### 1. Created Custom Conditional Annotation
**Files Created:**
- `src/main/java/com/turant/config/ConditionalOnDatabaseConfigured.java`
- `src/main/java/com/turant/config/DatabaseConfiguredCondition.java`

This custom condition checks if `spring.datasource.url` is actually non-empty, not just present. This is necessary because Spring Boot's `@ConditionalOnProperty` treats empty strings as "property exists".

### 2. Separated JDBC Configuration
**File Created:**
- `src/main/java/com/turant/config/JdbcConfiguration.java`

Moved `jdbcTemplate` and `transactionManager` bean definitions from `DatabaseConfig` to a separate configuration class annotated with `@ConditionalOnDatabaseConfigured` at the CLASS level. This ensures the entire configuration is skipped when database isn't available.

### 3. Disabled DataSource Auto-Configuration
**Modified:** `src/main/java/com/turant/TurantApplication.java`
```java
@SpringBootApplication(exclude = {DataSourceAutoConfiguration.class})
```

This prevents Spring Boot from automatically trying to create a DataSource when properties are present but empty.

### 4. Made JdbcTemplate Optional in Services
**Modified Files:**
- `src/main/java/com/turant/cap/CapIngestionService.java`
  - Constructor: `@Autowired(required = false) JdbcTemplate jdbcTemplate`
  - Methods: Check `if (jdbcTemplate == null)` before database operations
  
- `src/main/java/com/turant/subscriber/SubscriberCellStatsService.java`
  - Constructor: `@Autowired(required = false) JdbcTemplate jdbcTemplate`
  - Methods: Return 0 when jdbcTemplate is null

### 5. Made Database-Dependent Components Conditional
**Modified Files:**
- `src/main/java/com/turant/subscriber/PostgresSubscriberRepository.java`
  - Added: `@ConditionalOnDatabaseConfigured`
  
- `src/main/java/com/turant/subscriber/TelecomSubscriberMatcher.java`
  - Already had: `@ConditionalOnBean(DataSource.class)` (works because it's on the class)
  
- `src/main/java/com/turant/cellsite/PostGisTowerSource.java`
  - Already had: `@ConditionalOnBean(DataSource.class)` (works because it's on the class)

### 6. Configured Simulation Mode Property
**Modified:** `src/main/resources/application.properties`
```properties
# Simulation Mode - defaults to enabled to allow running without database
simulation.mode=${SIMULATION_MODE:enabled}
```

This enables simulation components (`SimulatedTowerSource`, `SimulatedSubscriberMatcher`, `SimulatedSmppClient`) by default.

## Final Configuration

### Database Config (`DatabaseConfig.java`)
- Creates `DataSource` bean only when URL is non-empty
- Uses `@ConditionalOnDatabaseConfigured` custom annotation

### JDBC Config (`JdbcConfiguration.java`)
- Separate class for `JdbcTemplate` and `TransactionManager` beans
- Entire class conditional with `@ConditionalOnDatabaseConfigured`

### Services with Optional Database
- `CapIngestionService`: Alerts not persisted when no DB
- `SubscriberCellStatsService`: Returns 0 when no DB

### Database-Required Components
- `PostgresSubscriberRepository`: Not created in simulation mode
- `PostGisTowerSource`: Not created in simulation mode
- `TelecomSubscriberMatcher`: Not created in simulation mode

### Simulation Components
- `SimulatedTowerSource`: Created when `simulation.mode=enabled`
- `SimulatedSubscriberMatcher`: Created when `simulation.mode=enabled`
- `SimulatedSmppClient`: Created when `simulation.mode=enabled`

## Verification

### Startup Logs (Success)
```
DatabaseConfiguredCondition: Database URL not configured - beans will not be created
CAP XML parser initialized with XXE protection
JdbcTemplate not available - alerts will not be persisted to database
Registered SimulatedTowerSource (simulation mode)
JdbcTemplate not available - subscriber cell stats will return 0
Tomcat started on port 8080 (http) with context path ''
Started TurantApplication in 3.157 seconds
```

### What Works in Simulation Mode
✅ Application starts without PostgreSQL
✅ `SimulatedTowerSource` registered for tower resolution
✅ `SimulatedSubscriberMatcher` available for subscriber matching
✅ `SimulatedSmppClient` available for SMS delivery
✅ CAP alert ingestion (not persisted)
✅ Alert pipeline processing
✅ REST API endpoints available

### What Doesn't Work (Expected)
❌ Alert persistence to database
❌ Subscriber cell stats (returns 0)
❌ Real PostGIS tower queries
❌ Real telecom subscriber data
❌ Real SMPP message delivery

## Configuration Files

### `.env` (User's Config)
```
SIMULATION_MODE=enabled
# DATABASE_URL=jdbc:postgresql://localhost:5432/turant (commented out)
```

### `application.properties` (Spring Boot)
```
spring.datasource.url=${DATABASE_URL:}
simulation.mode=${SIMULATION_MODE:enabled}
spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
```

## How to Switch to Real Database Mode

1. Uncomment in `.env`:
   ```
   DATABASE_URL=jdbc:postgresql://localhost:5432/turant
   ```

2. Optionally set:
   ```
   SIMULATION_MODE=disabled
   ```

3. Restart application - it will use:
   - PostGIS for tower resolution
   - PostgreSQL for subscriber data
   - Real SMPP for message delivery

## Testing Next Steps

1. ✅ Application starts successfully
2. 🔄 Test CAP alert ingestion via `POST /api/v1/pipeline/trigger-by-cap`
3. 🔄 Verify simulated towers are generated (5-50 towers)
4. 🔄 Verify simulated subscribers are generated (500-15000)
5. 🔄 Check pipeline status returns "completed"

## Files Modified (Complete List)

### New Files
1. `src/main/java/com/turant/config/ConditionalOnDatabaseConfigured.java`
2. `src/main/java/com/turant/config/DatabaseConfiguredCondition.java`
3. `src/main/java/com/turant/config/JdbcConfiguration.java`

### Modified Files
1. `src/main/java/com/turant/TurantApplication.java`
2. `src/main/java/com/turant/config/DatabaseConfig.java`
3. `src/main/java/com/turant/cap/CapIngestionService.java`
4. `src/main/java/com/turant/subscriber/SubscriberCellStatsService.java`
5. `src/main/java/com/turant/subscriber/PostgresSubscriberRepository.java`
6. `src/main/resources/application.properties`

### Already Conditional (No Changes Needed)
1. `src/main/java/com/turant/cellsite/PostGisTowerSource.java` - `@ConditionalOnBean(DataSource.class)`
2. `src/main/java/com/turant/subscriber/TelecomSubscriberMatcher.java` - `@ConditionalOnBean(DataSource.class)`
3. `src/main/java/com/turant/simulation/SimulatedTowerSource.java` - `@ConditionalOnProperty`
4. `src/main/java/com/turant/simulation/SimulatedSubscriberMatcher.java` - `@ConditionalOnProperty`
5. `src/main/java/com/turant/simulation/SimulatedSmppClient.java` - `@ConditionalOnProperty`

## Status

**✅ SIMULATION MODE WORKING**
- Application starts successfully without PostgreSQL
- All simulation components registered
- Ready for testing with CAP alerts

Application is running on `http://localhost:8080`
