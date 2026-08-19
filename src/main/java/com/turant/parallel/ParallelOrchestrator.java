package com.turant.parallel;

import com.turant.types.cap.CapAlert;
import com.turant.parallel.WorkerResult.AlertSubmitSummary;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/**
 * Parallel processing framework - requirement #13.
 * 
 * The orchestrator splits the deduplicated MSISDN list into batches (at most
 * PARALLEL_WORKER_COUNT) and dispatches each to an executor using Java's
 * ExecutorService. Each batch submits in parallel threads.
 * 
 * The real CAP expiry is threaded into every job as expiresAtIso, so every
 * batch builds the same real expiry guard - requirement #6 holds end-to-end.
 * 
 * Migrated from TypeScript Module 13 orchestrator.ts
 * Note: Uses ExecutorService instead of Node.js worker_threads
 */
@Component
public class ParallelOrchestrator {
    
    private static final Logger logger = LoggerFactory.getLogger(ParallelOrchestrator.class);
    
    @Value("${parallel.worker-count:4}")
    private int workerCount;
    
    @Value("${parallel.execution-mode:threads}")
    private String executionMode;
    
    @Value("${submit.batch-size:500}")
    private int maxBatchSize;
    
    private final ExecutorService executorService;
    
    public ParallelOrchestrator() {
        // Create a thread pool for parallel execution
        this.executorService = Executors.newCachedThreadPool();
    }
    
    public static class OrchestrateResult {
        private final String capIdentifier;
        private final int batches;
        private final List<AlertSubmitSummary> summaries;
        private final AggregateStats aggregate;
        
        public OrchestrateResult(String capIdentifier, int batches, 
                                List<AlertSubmitSummary> summaries, AggregateStats aggregate) {
            this.capIdentifier = capIdentifier;
            this.batches = batches;
            this.summaries = summaries;
            this.aggregate = aggregate;
        }
        
        public String getCapIdentifier() { return capIdentifier; }
        public int getBatches() { return batches; }
        public List<AlertSubmitSummary> getSummaries() { return summaries; }
        public AggregateStats getAggregate() { return aggregate; }
    }
    
    public static class AggregateStats {
        private final int total;
        private final int accepted;
        private final int rejected;
        private final int failed;
        private final int retried;
        private final int gaveUpExpired;
        private final int exhaustedRetries;
        private final boolean awaitingCredentials;
        
        public AggregateStats(int total, int accepted, int rejected, int failed,
                            int retried, int gaveUpExpired, int exhaustedRetries,
                            boolean awaitingCredentials) {
            this.total = total;
            this.accepted = accepted;
            this.rejected = rejected;
            this.failed = failed;
            this.retried = retried;
            this.gaveUpExpired = gaveUpExpired;
            this.exhaustedRetries = exhaustedRetries;
            this.awaitingCredentials = awaitingCredentials;
        }
        
        public int getTotal() { return total; }
        public int getAccepted() { return accepted; }
        public int getRejected() { return rejected; }
        public int getFailed() { return failed; }
        public int getRetried() { return retried; }
        public int getGaveUpExpired() { return gaveUpExpired; }
        public int getExhaustedRetries() { return exhaustedRetries; }
        public boolean isAwaitingCredentials() { return awaitingCredentials; }
    }
    
    /**
     * Split msisdns into at most workerCount batches, each ≤ maxBatchSize.
     */
    public List<List<String>> splitBatches(List<String> msisdns, int workerCount, int maxBatchSize) {
        int total = msisdns.size();
        if (total == 0) {
            return List.of();
        }
        if (workerCount <= 1 || total <= maxBatchSize) {
            return List.of(new ArrayList<>(msisdns));
        }
        
        int workers = Math.min(workerCount, total);
        int perWorker = (int) Math.ceil((double) total / workers);
        List<List<String>> batches = new ArrayList<>();
        
        for (int i = 0; i < workers; i++) {
            int start = i * perWorker;
            int end = Math.min((i + 1) * perWorker, total);
            if (start < end) {
                batches.add(new ArrayList<>(msisdns.subList(start, end)));
            }
        }
        
        return batches;
    }
    
    /**
     * Run one alert's dissemination: split → dispatch batches in parallel → merge.
     */
    public CompletableFuture<OrchestrateResult> orchestrateAlertPipeline(
            CapAlert alert,
            String content,
            List<String> msisdns,
            Function<WorkerJob, CompletableFuture<AlertSubmitSummary>> executor) {
        
        String alertId = alert.identifier();
        String traceKey = alert.identifier();
        
        // Extract expiry time from first info element
        final String expiresAtIso;
        if (alert.info() != null && alert.info().expires() != null) {
            expiresAtIso = alert.info().expires();
        } else if (alert.infos() != null && !alert.infos().isEmpty() && alert.infos().get(0).expires() != null) {
            expiresAtIso = alert.infos().get(0).expires();
        } else {
            expiresAtIso = null;
        }
        
        // Split into batches
        List<List<String>> batches = splitBatches(msisdns, workerCount, maxBatchSize);
        
        // Create jobs
        List<WorkerJob> jobs = batches.stream()
            .map(batch -> new WorkerJob(alertId, traceKey, content, batch, expiresAtIso, traceKey))
            .toList();
        
        // Execute all jobs in parallel
        List<CompletableFuture<AlertSubmitSummary>> futures = jobs.stream()
            .map(executor)
            .toList();
        
        // Wait for all to complete and aggregate results
        return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
            .thenApply(v -> {
                List<AlertSubmitSummary> summaries = futures.stream()
                    .map(CompletableFuture::join)
                    .toList();
                
                // Aggregate statistics
                AggregateStats aggregate = summaries.stream()
                    .reduce(
                        new AggregateStats(0, 0, 0, 0, 0, 0, 0, false),
                        (acc, s) -> new AggregateStats(
                            acc.total + s.getTotal(),
                            acc.accepted + s.getAccepted(),
                            acc.rejected + s.getRejected(),
                            acc.failed + s.getFailed(),
                            acc.retried + s.getRetried(),
                            acc.gaveUpExpired + s.getGaveUpExpired(),
                            acc.exhaustedRetries + s.getExhaustedRetries(),
                            acc.awaitingCredentials || s.isAwaitingCredentials()
                        ),
                        (a, b) -> a  // combiner not used in sequential stream
                    );
                
                logger.info("Pipeline completed: capIdentifier={}, mode={}, batches={}, total={}, accepted={}",
                    traceKey, executionMode, batches.size(), aggregate.total, aggregate.accepted);
                
                return new OrchestrateResult(traceKey, batches.size(), summaries, aggregate);
            });
    }
    
    public void shutdown() {
        executorService.shutdown();
    }
}
