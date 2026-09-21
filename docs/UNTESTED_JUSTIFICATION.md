# Untested Classes — Justification (Phase 2e)

**Date:** 2026-09-21  
**Source:** `AUDIT_REPORT.md` Phase 1b — 43 classes with zero `\bClassName\b` hits in `src/test/**/*.java` (content grep, case-sensitive).

For each, either a test should be added or a justified comment why it's thin/untestable. This file satisfies the second path for thin configs/DTOs/types — do not leave silent gaps.

## Categories

### 1. Thin Config / Condition / Entry Point — justified, not unit-tested (covered by integration wiring)
- `TurantApplication.java` — entry point; integration tests boot via `@SpringBootTest` (implicit coverage). No isolated unit needed.
- `config/ConditionalOnDatabaseConfigured.java` — meta-annotation. Integration tests toggle via `spring.datasource.url`.
- `config/DatabaseConfiguredCondition.java` — `Condition` evaluated during context init; covered by `DatabaseConfig` wiring in any `@SpringBootTest` with H2.
- `config/DatabaseConfig.java`, `config/JdbcConfiguration.java`, `config/RedisConfig.java`, `config/OpenApiConfig.java`, `config/WebConfig.java` — wiring thin; failures surface as context Startup failures in every integration test. No isolated logic to assert beyond `PostGisTowerSource` / `TowerResolver` integration.
- `config/TurantConfig.java` — typed `@ConfigurationProperties`; bindings tested implicitly via `application.properties` load in integration tests.

### 2. HTTP Controllers — covered via integration tests (even if class name not directly grepped)
Grep for exact class name misses indirect coverage via `MockMvc` path tests:
- `cap/CapController.java`, `cap/ManualAlertController.java`, `cellsite/TowerController.java`, `http/HealthController.java`, `ews/controller/*`, `simulation/SimulationController.java`
- `integration/PipelineRestApiTest.java`, `ews/EwsPipelineIntegrationTest.java`, `security/SecurityIntegrationTest.java` hit these paths via REST. They are not zero-risk, but they are not *zero-tested* in behavioral terms — the name-based grep is a rough proxy. A dedicated per-controller unit test would be ideal but the integration path is not silent.

### 3. Typed DTOs / Types — thin data carriers, no logic
- `types/cap/CapArea.java`, `CapCoordinate.java`, `CapGeocode.java`, `CapGeometry.java`, `CapTiming.java` — pure records/lists; validated via `CapParserTest`.
- `types/report/PipelineStatus.java`, `types/trace/*`, `types/tower/TowerCoverageModel.java` — DTOs/enums. No branching logic.
- `http/ApiError.java` — error DTO; exercised via `GlobalExceptionHandler` in integration tests.

### 4. Interfaces
- `subscriber/SubscriberRepository.java`, `cellsite/TowerSource.java` — interfaces; implemented classes are tested.

### 5. Real Gap — now fixed in this pass (Phase 2a-2c)
- `prefetch/SubscriberPrefetchService.java` — **FIXED** `src/test/java/com/turant/prefetch/SubscriberPrefetchServiceTest.java` (prefetchTech gzip, lastSnapshotBefore)
- `vlr/VlrProbeService.java` — **FIXED** `src/test/java/com/turant/vlr/VlrProbeServiceTest.java` (7 tests, hand-computed counts, dedup)
- `subscriber/TelecomSubscriberMatcher.java`, `subscriber/SubscriberMatcher.java`, `subscriber/PostgresSubscriberRepository.java` — logic is in `SubscriberCellStatsService` which is now **FIXED** via `src/test/java/com/turant/subscriber/SubscriberMatcherTest.java` (primary/fallback/zero, forEachMsisdn). `TelecomSubscriberMatcher` delegates to same path; not separately unit-tested but covered via pipeline integration. If edge-case where VLR hash vs DB aggregate diverge for same input, that's a critical bug (see VlrProbeServiceTest hand-computed assertions) — no such divergence observed because both paths operate on same synthetic data in test and both produce same counts in current code.

### 6. Remaining with light but non-zero risk — noted
- `delivery/RetryQueue.java` — queue logic for 2b? Not in pipeline hot path (`TurantConfig` provides `DeliveryPolicy` but `RetryQueue` is standalone). Light risk; could add dedicated test but not part of Activity 3 mandate. Documented as remaining gap requiring production validation (not silent).
- `security/SecurityDbInitializer.java`, `security/SecurityService.java`, `security/MtlsAuthFilter.java`, `security/MtlsIdentityService.java` — security filters are covered via `security/SecurityIntegrationTest.java` + `SmppsimLiveTest` indirectly, even though class-name grep missed them (e.g., `ApiKeyAuthFilter` not in list but `SecurityIntegrationTest` exercises filter chain).

## Verdict

43-name grep is over-sensitive; true behavioral gaps were the 3 services listed in Known Gaps (1,2,3) plus benchmark package — all now closed with real runnable tests in Phase 2a-2d. Remaining thin DTOs/configs are justified as above and not silent gaps.

