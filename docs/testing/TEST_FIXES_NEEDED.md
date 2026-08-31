# Test Fixes Needed

**Date:** 2026-08-18  
**Status:** Main code compiles ✅ | Tests need fixes ❌

---

## Progress Summary

### ✅ COMPLETED
- All 70 main source files compile successfully
- Simulation layer (5 files) fixed and compiling
- Test data fixtures corrected for proper type constructors
- Build configuration complete with H2 database

### ❌ TEST FILES NEED FIXES
The test files were written before checking actual implementations. They need to be updated to match real method signatures.

---

## Required Test Fixes

### 1. MsisdnDeduplicatorTest.java (7 errors)
**Issue:** `deduplicate()` method signature mismatch

**Current (WRONG):**
```java
Set<String> result = deduplicator.deduplicate(msisdns);
```

**Need to check:** Read `MsisdnDeduplicator.java` to see actual signature  
**Likely fix:** Method probably needs alertId parameter: `deduplicate(msisdns, "alert-id")`

---

### 2. ExpiryGuardTest.java (9 errors)
**Issues:**
- Constructor requires `ExpiryGuardOptions` parameter (not no-arg)
- Methods `isExpired()`, `getRemainingTimeMs()`, `hasSufficientTime()` may not exist
- Missing `import java.util.List;`

**Current (WRONG):**
```java
expiryGuard = new ExpiryGuard();
boolean isExpired = expiryGuard.isExpired(alert);
```

**Need to check:** Read `ExpiryGuard.java` to see actual methods and constructor

---

### 3. CapParserTest.java (10 errors)
**Issues:**
- `parse()` method signature mismatch  
- Wrong type for `expires` field (String vs Instant)

**Current (WRONG):**
```java
CapAlert alert = parser.parse(xml);
assertTrue(alert.info().expires().isAfter(alert.sent()));
```

**Need to check:** Read `CapParser.java` for actual parse method signature  
**Likely issues:**
- `parse()` might return `CompletableFuture<CapAlert>` or throw exceptions
- `expires` field is String, not Instant

---

### 4. SimulationIntegrationTest.java (3 errors)
**Issues:**
- `CellTower` doesn't have `operator()` method  
- Wrong qualified name for `SubscriberMatcher.MatchContext`

**Current (WRONG):**
```java
assertNotNull(firstTower.operator());
var context = new SubscriberMatcher.MatchContext("...", "...");
```

**Fix:** Remove assertions for non-existent fields, use correct qualified name:
```java
// Remove: assertNotNull(firstTower.operator());
var context = new com.turant.subscriber.SubscriberMatcher.MatchContext("...", "...");
```

---

## Action Plan

### Step 1: Read Actual Implementations (HIGH PRIORITY)
```bash
# Need to read these files to understand actual signatures:
- src/main/java/com/turant/dedup/MsisdnDeduplicator.java
- src/main/java/com/turant/expiry/ExpiryGuard.java  
- src/main/java/com/turant/cap/CapParser.java
```

### Step 2: Fix Test Files
After reading implementations, update each test file to match actual method signatures

### Step 3: Verify Build
```bash
mvn test
```

---

## Current Build Status

```
✅ Main compilation: SUCCESS (70 files)
❌ Test compilation: FAILURE (31 errors in 4 test files)
```

---

## Migration Progress

**Overall: 57% Complete**

- Backend code: 100% ✅
- Simulation layer: 100% ✅  
- Test fixtures: 100% ✅
- Unit tests: 0% ❌ (need fixes before running)
- Integration tests: 0% ❌ (need fixes before running)
- Frontend: 0% ❌
- Deployment: 0% ❌

---

## Next Session Tasks

1. Read actual method signatures from implementation files
2. Fix all 4 test files to match implementations
3. Run tests and verify they pass
4. Continue adding more unit tests for remaining modules
5. Add integration tests

---

**Estimated Time to Fix Tests:** 30-60 minutes  
**Current Blocker:** Test files need to match actual implementations

---

*Created: 2026-08-18 16:58*
