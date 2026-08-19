package com.turant.performance;

import com.turant.dedup.MsisdnDeduplicator;
import com.turant.parallel.ParallelOrchestrator;
import com.turant.parallel.WorkerJob;
import com.turant.parallel.WorkerResult.AlertSubmitSummary;
import com.turant.simulation.TestDataFixtures;
import com.turant.types.cap.CapAlert;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Performance benchmarks for batch processing.
 * 
 * Tests system throughput with various batch sizes:
 * - Small batch: 100 MSISDNs
 * - Medium batch: 1,000 MSISDNs
 * - Large batch: 10,000 MSISDNs
 * - Extra large batch: 50,000 MSISDNs
 * 
 * Measures:
 * - Batch splitting performance
 * - Parallel execution throughput
 * - Deduplication speed
 * - Overall messages per second
 */
class BatchProcessingBenchmark {
    
    private ParallelOrchestrator orchestrator;
    private MsisdnDeduplicator deduplicator;
    
    @BeforeEach
    void setUp() {
        orchestrator = new ParallelOrchestrator();
        deduplicator = new MsisdnDeduplicator();
    }
    
    @Test
    void benchmarkSmallBatch() throws Exception {
        // Given: 100 MSISDNs
        List<String> msisdns = createMsisdns(100);
        
        // When: Processing
        BenchmarkResult result = runBenchmark("Small Batch (100)", msisdns);
        
        // Then: Should complete quickly
        assertTrue(result.durationMs < 1000, "Small batch should complete in <1s");
        assertTrue(result.throughput > 100, "Should process >100 msg/sec");
        
        printResult(result);
    }
    
    @Test
    void benchmarkMediumBatch() throws Exception {
        // Given: 1,000 MSISDNs
        List<String> msisdns = createMsisdns(1000);
        
        // When: Processing
        BenchmarkResult result = runBenchmark("Medium Batch (1K)", msisdns);
        
        // Then: Should maintain good throughput
        assertTrue(result.durationMs < 5000, "Medium batch should complete in <5s");
        assertTrue(result.throughput > 200, "Should process >200 msg/sec");
        
        printResult(result);
    }
    
    @Test
    void benchmarkLargeBatch() throws Exception {
        // Given: 10,000 MSISDNs
        List<String> msisdns = createMsisdns(10000);
        
        // When: Processing
        BenchmarkResult result = runBenchmark("Large Batch (10K)", msisdns);
        
        // Then: Should scale well
        assertTrue(result.durationMs < 30000, "Large batch should complete in <30s");
        assertTrue(result.throughput > 300, "Should process >300 msg/sec");
        
        printResult(result);
    }
    
    @Test
    void benchmarkExtraLargeBatch() throws Exception {
        // Given: 50,000 MSISDNs
        List<String> msisdns = createMsisdns(50000);
        
        // When: Processing
        BenchmarkResult result = runBenchmark("Extra Large Batch (50K)", msisdns);
        
        // Then: Should handle large volumes
        assertTrue(result.durationMs < 150000, "XL batch should complete in <2.5min");
        assertTrue(result.throughput > 300, "Should maintain >300 msg/sec");
        
        printResult(result);
    }
    
    @Test
    void benchmarkDeduplication() {
        // Given: 10,000 MSISDNs with 20% duplicates
        List<String> msisdns = createMsisdnsWithDuplicates(10000, 0.2);
        
        // When: Deduplicating
        Instant start = Instant.now();
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "benchmark");
        Instant end = Instant.now();
        
        long durationMs = Duration.between(start, end).toMillis();
        double throughput = (msisdns.size() * 1000.0) / Math.max(1, durationMs); // Avoid divide by zero
        
        // Then: Should be fast
        assertTrue(durationMs < 1000, "Dedup should complete in <1s for 10K items");
        assertTrue(throughput > 10000, "Should process >10K msg/sec");
        assertEquals(8000, result.deduplicated().size(), "Should remove 20% duplicates");
        
        System.out.printf("""
            
            === Deduplication Benchmark ===
            Input:       %,d MSISDNs (20%% duplicates)
            Output:      %,d unique
            Duration:    %d ms
            Throughput:  %,.0f msg/sec
            
            """, msisdns.size(), result.deduplicated().size(), durationMs, throughput);
    }
    
    @Test
    void benchmarkBatchSplitting() {
        // Given: Various batch sizes
        int[] sizes = {100, 1000, 10000, 50000};
        
        System.out.println("\n=== Batch Splitting Benchmark ===");
        
        for (int size : sizes) {
            List<String> msisdns = createMsisdns(size);
            
            Instant start = Instant.now();
            List<List<String>> batches = orchestrator.splitBatches(msisdns, 4, 500);
            Instant end = Instant.now();
            
            long durationMs = Duration.between(start, end).toMillis();
            
            System.out.printf("Size: %,6d | Batches: %3d | Duration: %3d ms%n",
                size, batches.size(), durationMs);
            
            // Verify correctness
            int total = batches.stream().mapToInt(List::size).sum();
            assertEquals(size, total, "All MSISDNs should be in batches");
            
            // Should be very fast
            assertTrue(durationMs < 100, "Batch splitting should be <100ms");
        }
        
        System.out.println();
    }
    
    @Test
    void benchmarkParallelVsSequential() throws Exception {
        // Given: 5,000 MSISDNs
        List<String> msisdns = createMsisdns(5000);
        CapAlert alert = TestDataFixtures.createSampleCapAlert();
        
        // Simulate work per message (1ms each)
        AtomicInteger processed = new AtomicInteger(0);
        java.util.function.Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = 
            (WorkerJob job) -> CompletableFuture.supplyAsync(() -> {
                int size = job.batch().size();
                // Simulate work
                try {
                    Thread.sleep(size); // 1ms per message
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                processed.addAndGet(size);
                return new AlertSubmitSummary(size, size, 0, 0, 0, 0, 0, false, List.of());
            });
        
        // When: Processing with parallelism
        Instant start = Instant.now();
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Benchmark", msisdns, executor)
                .get();
        Instant end = Instant.now();
        
        long parallelDuration = Duration.between(start, end).toMillis();
        
        // Calculate theoretical sequential time (5000ms for 5000 messages at 1ms each)
        long sequentialEstimate = 5000;
        double speedup = (double) sequentialEstimate / Math.max(1, parallelDuration);
        
        // Then: Verify completion
        assertEquals(5000, processed.get(), "All messages should be processed");
        assertEquals(5000, result.getAggregate().getTotal());
        
        System.out.printf("""
            
            === Parallel vs Sequential Benchmark ===
            Messages:         %,d
            Sequential (est): %,d ms
            Parallel (actual): %,d ms
            Speedup:          %.2fx
            Workers:          4
            Batches:          %d
            Note: Speedup depends on batch size and work per message
            
            """, msisdns.size(), sequentialEstimate, parallelDuration, speedup, result.getBatches());
    }
    
    @Test
    void benchmarkWorkerScaling() throws Exception {
        // Given: 10,000 MSISDNs
        List<String> msisdns = createMsisdns(10000);
        CapAlert alert = TestDataFixtures.createSampleCapAlert();
        
        java.util.function.Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = 
            (WorkerJob job) -> CompletableFuture.supplyAsync(() -> {
                int size = job.batch().size();
                // Simulate light work
                try {
                    Thread.sleep(size / 2); // 0.5ms per message
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return new AlertSubmitSummary(size, size, 0, 0, 0, 0, 0, false, List.of());
            });
        
        System.out.println("\n=== Worker Scaling Benchmark ===");
        System.out.println("Messages: 10,000 (0.5ms simulated work per message)");
        
        // Test with different worker counts
        int[] workerCounts = {1, 2, 4, 8};
        
        for (int workers : workerCounts) {
            ParallelOrchestrator testOrch = new ParallelOrchestrator();
            org.springframework.test.util.ReflectionTestUtils.setField(testOrch, "workerCount", workers);
            
            Instant start = Instant.now();
            ParallelOrchestrator.OrchestrateResult result = 
                testOrch.orchestrateAlertPipeline(alert, "Scaling Test", msisdns, executor)
                    .get();
            Instant end = Instant.now();
            
            long duration = Duration.between(start, end).toMillis();
            double throughput = (10000.0 * 1000) / duration;
            
            System.out.printf("Workers: %d | Duration: %,5d ms | Throughput: %,6.0f msg/sec | Batches: %d%n",
                workers, duration, throughput, result.getBatches());
        }
        
        System.out.println();
    }
    
    // ========== Helper Methods ==========
    
    private BenchmarkResult runBenchmark(String name, List<String> msisdns) throws Exception {
        CapAlert alert = TestDataFixtures.createSampleCapAlert();
        
        // Simulate fast processing (no actual SMPP delay)
        java.util.function.Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor = 
            (WorkerJob job) -> {
                int size = job.batch().size();
                return CompletableFuture.completedFuture(
                    new AlertSubmitSummary(size, size, 0, 0, 0, 0, 0, false, List.of())
                );
            };
        
        // Measure
        Instant start = Instant.now();
        ParallelOrchestrator.OrchestrateResult result = 
            orchestrator.orchestrateAlertPipeline(alert, "Benchmark", msisdns, executor)
                .get();
        Instant end = Instant.now();
        
        long durationMs = Duration.between(start, end).toMillis();
        double throughput = (msisdns.size() * 1000.0) / durationMs;
        
        return new BenchmarkResult(
            name,
            msisdns.size(),
            durationMs,
            throughput,
            result.getBatches()
        );
    }
    
    private void printResult(BenchmarkResult result) {
        System.out.printf("""
            
            === %s ===
            Messages:   %,d
            Duration:   %,d ms
            Throughput: %,.0f msg/sec
            Batches:    %d
            
            """, result.name, result.messageCount, result.durationMs, 
                result.throughput, result.batchCount);
    }
    
    private List<String> createMsisdns(int count) {
        List<String> msisdns = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            long number = 9000000000L + i;
            msisdns.add("+91" + number);
        }
        return msisdns;
    }
    
    private List<String> createMsisdnsWithDuplicates(int count, double duplicateRatio) {
        List<String> msisdns = new ArrayList<>(count);
        int uniqueCount = (int) (count * (1 - duplicateRatio));
        
        // Add unique numbers
        for (int i = 0; i < uniqueCount; i++) {
            long number = 9000000000L + i;
            msisdns.add("+91" + number);
        }
        
        // Add duplicates
        for (int i = uniqueCount; i < count; i++) {
            int idx = i % uniqueCount;
            long number = 9000000000L + idx;
            msisdns.add("+91" + number);
        }
        
        return msisdns;
    }
    
    private record BenchmarkResult(
        String name,
        int messageCount,
        long durationMs,
        double throughput,
        int batchCount
    ) {}
}
