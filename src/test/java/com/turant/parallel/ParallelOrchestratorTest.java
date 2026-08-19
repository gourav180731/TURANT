package com.turant.parallel;

import com.turant.types.cap.*;
import com.turant.types.sms.SubmissionResult;
import com.turant.parallel.WorkerResult.AlertSubmitSummary;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for ParallelOrchestrator (Module 13).
 * 
 * Tests batch splitting, parallel execution, and result aggregation.
 */
class ParallelOrchestratorTest {
    
    private ParallelOrchestrator orchestrator;
    
    @BeforeEach
    void setUp() {
        orchestrator = new ParallelOrchestrator();
        ReflectionTestUtils.setField(orchestrator, "workerCount", 4);
        ReflectionTestUtils.setField(orchestrator, "executionMode", "threads");
        ReflectionTestUtils.setField(orchestrator, "maxBatchSize", 500);
    }
    
    @Test
    void testSplitBatchesEmpty() {
        // Given: Empty list
        List<String> msisdns = List.of();
        
        // When: Splitting
        List<List<String>> batches = orchestrator.splitBatches(msisdns, 4, 500);
        
        // Then: Should return empty list
        assertTrue(batches.isEmpty());
    }
    
    @Test
    void testSplitBatchesSingleBatch() {
        // Given: Small list that fits in one batch
        List<String> msisdns = List.of("+919000000001", "+919000000002", "+919000000003");
        
        // When: Splitting with 4 workers
        List<List<String>> batches = orchestrator.splitBatches(msisdns, 4, 500);
        
        // Then: Should return single batch
        assertEquals(1, batches.size());
        assertEquals(3, batches.get(0).size());
        assertEquals(msisdns, batches.get(0));
    }
    
    @Test
    void testSplitBatchesMultipleBatches() {
        // Given: List with 10 items
        List<String> msisdns = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            msisdns.add("+91900000000" + i);
        }
        
        // When: Splitting with 4 workers
        List<List<String>> batches = orchestrator.splitBatches(msisdns, 4, 500);
        
        // Then: Should split - but since 10 < maxBatchSize (500), may return single batch
        // The implementation returns single batch if total <= maxBatchSize
        assertTrue(batches.size() >= 1);
        
        // Verify total count
        int total = batches.stream().mapToInt(List::size).sum();
        assertEquals(10, total);
    }
    
    @Test
    void testSplitBatchesExceedsWorkerCount() {
        // Given: More workers than items
        List<String> msisdns = List.of("+919000000001", "+919000000002");
        
        // When: Splitting with 4 workers
        List<List<String>> batches = orchestrator.splitBatches(msisdns, 4, 500);
        
        // Then: Should return single batch since total (2) <= maxBatchSize (500)
        assertEquals(1, batches.size());
        assertEquals(2, batches.get(0).size());
    }
    
    @Test
    void testSplitBatchesLargeBatch() {
        // Given: Large list
        List<String> msisdns = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            msisdns.add("+919" + String.format("%09d", i));
        }
        
        // When: Splitting with 4 workers
        List<List<String>> batches = orchestrator.splitBatches(msisdns, 4, 500);
        
        // Then: Should create 4 batches
        assertEquals(4, batches.size());
        
        // Verify total count
        int total = batches.stream().mapToInt(List::size).sum();
        assertEquals(1000, total);
        
        // Each batch should have ~250 items
        batches.forEach(batch -> {
            assertTrue(batch.size() >= 200);
            assertTrue(batch.size() <= 300);
        });
    }
    
    @Test
    void testSplitBatchesOneWorker() {
        // Given: List with multiple items
        List<String> msisdns = List.of("+919000000001", "+919000000002", "+919000000003");
        
        // When: Splitting with 1 worker
        List<List<String>> batches = orchestrator.splitBatches(msisdns, 1, 500);
        
        // Then: Should return single batch
        assertEquals(1, batches.size());
        assertEquals(3, batches.get(0).size());
    }
    
    @Test
    void testOrchestrateAlertPipelineSuccess() throws Exception {
        // Given: Alert with MSISDNs
        CapAlert alert = createSampleAlert();
        List<String> msisdns = List.of("+919000000001", "+919000000002", "+919000000003");
        
        // And: Executor that simulates successful submission
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            int size = job.batch().size();
            AlertSubmitSummary summary = new AlertSubmitSummary(
                size, size, 0, 0, 0, 0, 0, false, List.of()
            );
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
                .get(10, TimeUnit.SECONDS);
        
        // Then: Should succeed
        assertNotNull(result);
        assertEquals("alert-001", result.getCapIdentifier());
        assertEquals(3, result.getAggregate().getTotal());
        assertEquals(3, result.getAggregate().getAccepted());
        assertEquals(0, result.getAggregate().getRejected());
    }
    
    @Test
    void testOrchestrateAlertPipelineWithFailures() throws Exception {
        // Given: Alert with MSISDNs
        CapAlert alert = createSampleAlert();
        List<String> msisdns = List.of("+919000000001", "+919000000002", "+919000000003", "+919000000004");
        
        // And: Executor that simulates some failures
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            int size = job.batch().size();
            int failed = 1;  // One failure per batch
            AlertSubmitSummary summary = new AlertSubmitSummary(
                size, size - failed, 0, failed, 0, 0, 0, false, List.of()
            );
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
                .get(10, TimeUnit.SECONDS);
        
        // Then: Should aggregate failures
        assertNotNull(result);
        assertEquals(4, result.getAggregate().getTotal());
        assertTrue(result.getAggregate().getAccepted() > 0);
        assertTrue(result.getAggregate().getFailed() > 0);
    }
    
    @Test
    void testOrchestrateAlertPipelineMultipleBatches() throws Exception {
        // Given: Alert with enough MSISDNs to force multiple batches (>500 to exceed maxBatchSize)
        CapAlert alert = createSampleAlert();
        List<String> msisdns = new ArrayList<>();
        for (int i = 0; i < 800; i++) {
            msisdns.add("+919" + String.format("%09d", i));
        }
        
        // And: Executor that tracks batch count
        final int[] batchCount = {0};
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            synchronized (batchCount) {
                batchCount[0]++;
            }
            int size = job.batch().size();
            AlertSubmitSummary summary = new AlertSubmitSummary(
                size, size, 0, 0, 0, 0, 0, false, List.of()
            );
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
                .get(10, TimeUnit.SECONDS);
        
        // Then: Should create multiple batches (800 MSISDNs > 500 maxBatchSize)
        assertTrue(result.getBatches() > 1, "Should have multiple batches with 800 MSISDNs");
        assertTrue(batchCount[0] > 1, "Should execute multiple batches");
        assertEquals(800, result.getAggregate().getTotal());
    }
    
    @Test
    void testOrchestrateAlertPipelineAggregation() throws Exception {
        // Given: Alert with enough MSISDNs to force multiple batches (>500)
        CapAlert alert = createSampleAlert();
        List<String> msisdns = new ArrayList<>();
        for (int i = 0; i < 800; i++) {
            msisdns.add("+919" + String.format("%09d", i));
        }
        
        // And: Executor with varied results per batch
        final int[] batchIndex = {0};
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            int idx = batchIndex[0]++;
            int size = job.batch().size();
            
            // Different stats for different batches
            AlertSubmitSummary summary = new AlertSubmitSummary(
                size,
                size - 1,  // accepted (all but one)
                idx == 0 ? 1 : 0,  // rejected (only first batch)
                idx == 1 ? 1 : 0,  // failed (only second batch)
                idx % 2,   // retried (alternating batches)
                0,         // gaveUpExpired
                0,         // exhaustedRetries
                false,     // awaitingCredentials
                List.of()
            );
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
                .get(10, TimeUnit.SECONDS);
        
        // Then: Should aggregate correctly across multiple batches
        assertNotNull(result);
        assertEquals(800, result.getAggregate().getTotal());
        assertTrue(result.getAggregate().getAccepted() > 0, "Should have accepted submissions");
        assertTrue(result.getAggregate().getRejected() > 0, "Should have rejected (from batch 0)");
        assertTrue(result.getAggregate().getFailed() > 0, "Should have failed (from batch 1)");
        assertTrue(result.getBatches() > 1, "Should have multiple batches");
    }
    
    @Test
    void testOrchestrateAlertPipelineAwaitingCredentials() throws Exception {
        // Given: Alert
        CapAlert alert = createSampleAlert();
        List<String> msisdns = List.of("+919000000001", "+919000000002");
        
        // And: Executor that flags awaiting credentials
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            AlertSubmitSummary summary = new AlertSubmitSummary(
                job.batch().size(), 0, 0, 0, 0, 0, 0, true, List.of()
            );
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
                .get(10, TimeUnit.SECONDS);
        
        // Then: Should propagate awaiting credentials flag
        assertTrue(result.getAggregate().isAwaitingCredentials());
    }
    
    @Test
    void testOrchestrateAlertPipelineEmptyList() throws Exception {
        // Given: Alert with no MSISDNs
        CapAlert alert = createSampleAlert();
        List<String> msisdns = List.of();
        
        // And: Executor
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            AlertSubmitSummary summary = new AlertSubmitSummary(0, 0, 0, 0, 0, 0, 0, false, List.of());
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
                .get(10, TimeUnit.SECONDS);
        
        // Then: Should handle empty list
        assertNotNull(result);
        assertEquals(0, result.getBatches());
        assertEquals(0, result.getAggregate().getTotal());
    }
    
    @Test
    void testOrchestrateAlertPipelineExpiryPropagation() throws Exception {
        // Given: Alert with expiry
        CapAlert alert = createSampleAlert();
        List<String> msisdns = List.of("+919000000001");
        
        // And: Executor that checks expiry is present
        final String[] capturedExpiry = {null};
        Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = job -> {
            capturedExpiry[0] = job.expiresAtIso();
            AlertSubmitSummary summary = new AlertSubmitSummary(1, 1, 0, 0, 0, 0, 0, false, List.of());
            return CompletableFuture.completedFuture(summary);
        };
        
        // When: Orchestrating
        orchestrator.orchestrateAlertPipeline(alert, "Test content", msisdns, executor)
            .get(10, TimeUnit.SECONDS);
        
        // Then: Expiry should be propagated to worker job
        assertNotNull(capturedExpiry[0]);
        assertEquals("2026-08-19T12:00:00Z", capturedExpiry[0]);
    }
    
    @Test
    void testAggregateStatsGetters() {
        // Given: AggregateStats
        ParallelOrchestrator.AggregateStats stats = new ParallelOrchestrator.AggregateStats(
            100, 95, 2, 3, 5, 1, 1, false
        );
        
        // Then: All getters should work
        assertEquals(100, stats.getTotal());
        assertEquals(95, stats.getAccepted());
        assertEquals(2, stats.getRejected());
        assertEquals(3, stats.getFailed());
        assertEquals(5, stats.getRetried());
        assertEquals(1, stats.getGaveUpExpired());
        assertEquals(1, stats.getExhaustedRetries());
        assertFalse(stats.isAwaitingCredentials());
    }
    
    @Test
    void testOrchestrateResultGetters() {
        // Given: OrchestrateResult
        ParallelOrchestrator.AggregateStats stats = new ParallelOrchestrator.AggregateStats(
            10, 10, 0, 0, 0, 0, 0, false
        );
        List<AlertSubmitSummary> summaries = List.of();
        ParallelOrchestrator.OrchestrateResult result = 
            new ParallelOrchestrator.OrchestrateResult("alert-001", 2, summaries, stats);
        
        // Then: All getters should work
        assertEquals("alert-001", result.getCapIdentifier());
        assertEquals(2, result.getBatches());
        assertEquals(summaries, result.getSummaries());
        assertEquals(stats, result.getAggregate());
    }
    
    private CapAlert createSampleAlert() {
        CapInfo info = new CapInfo(
            "en-US",
            List.of("Safety"),
            "Test Alert",
            List.of("Monitor"),
            CapUrgency.Immediate,
            CapSeverity.Extreme,
            CapCertainty.Observed,
            null,
            List.of(),
            "2026-08-19T10:00:00Z",
            null,
            "2026-08-19T12:00:00Z",
            null,
            "Test alert",
            "This is a test alert",
            null,
            null,
            List.of()
        );
        
        return new CapAlert(
            "alert-001",
            "test@example.com",
            "2026-08-19T10:00:00Z",
            CapStatus.Actual,
            CapMsgType.Alert,
            null,
            CapScope.Public,
            null,
            null,
            List.of(),
            null,
            null,
            null,
            List.of(info),
            info,
            null
        );
    }
}
