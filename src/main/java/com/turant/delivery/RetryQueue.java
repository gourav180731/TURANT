package com.turant.delivery;

import com.turant.expiry.ExpiryGuard;
import com.turant.types.sms.DeliveryOutcome;
import com.turant.types.sms.SubmissionResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * In-memory retry queue - requirement #10.
 * 
 * Takes a list of failed MSISDNs and re-attempts submission up to the
 * configured max, respecting the module 06 expiry guard before every retry
 * round. Returns final counts.
 * 
 * Migrated from TypeScript Module 10 retry-queue.ts
 */
@Component
public class RetryQueue {
    
    private static final Logger logger = LoggerFactory.getLogger(RetryQueue.class);
    
    public static class RetryOutcome {
        private final int retried;
        private final int gaveUpExpired;
        private final int exhaustedRetries;
        private final List<String> finalFailures;
        
        public RetryOutcome(int retried, int gaveUpExpired, int exhaustedRetries, List<String> finalFailures) {
            this.retried = retried;
            this.gaveUpExpired = gaveUpExpired;
            this.exhaustedRetries = exhaustedRetries;
            this.finalFailures = finalFailures;
        }
        
        public int getRetried() { return retried; }
        public int getGaveUpExpired() { return gaveUpExpired; }
        public int getExhaustedRetries() { return exhaustedRetries; }
        public List<String> getFinalFailures() { return finalFailures; }
    }
    
    /**
     * Re-attempt failedMsisdns per policy. Single-attempt mode never retries.
     * Each round: (1) consult the expiry guard, (2) wait the configured interval
     * (after the first round), (3) re-submit the still-pending list.
     */
    public CompletableFuture<RetryOutcome> runRetryQueue(
            List<String> failedMsisdns,
            DeliveryPolicy policy,
            ExpiryGuard guard,
            Function<List<String>, CompletableFuture<List<SubmissionResult>>> submitter) {
        
        if (failedMsisdns.isEmpty()) {
            return CompletableFuture.completedFuture(
                new RetryOutcome(0, 0, 0, List.of())
            );
        }
        
        // Single-attempt: no retry configured
        if (!policy.willRetry()) {
            logger.info("Retry skipped (single-attempt mode), failed count: {}", failedMsisdns.size());
            return CompletableFuture.completedFuture(
                new RetryOutcome(0, 0, 0, new ArrayList<>(failedMsisdns))
            );
        }
        
        return runRetryRounds(failedMsisdns, policy, guard, submitter);
    }
    
    private CompletableFuture<RetryOutcome> runRetryRounds(
            List<String> failedMsisdns,
            DeliveryPolicy policy,
            ExpiryGuard guard,
            Function<List<String>, CompletableFuture<List<SubmissionResult>>> submitter) {
        
        List<String> pending = new ArrayList<>(failedMsisdns);
        int[] retriedCount = {0};
        
        return retryRound(pending, 1, policy, guard, submitter, retriedCount);
    }
    
    private CompletableFuture<RetryOutcome> retryRound(
            List<String> pending,
            int round,
            DeliveryPolicy policy,
            ExpiryGuard guard,
            Function<List<String>, CompletableFuture<List<SubmissionResult>>> submitter,
            int[] retriedCount) {
        
        // Check expiry before attempting
        if (!guard.canSubmit()) {
            int remaining = pending.size();
            logger.warn("Retry halted: alert expired at round {}, remaining: {}", round, remaining);
            return CompletableFuture.completedFuture(
                new RetryOutcome(retriedCount[0], remaining, 0, List.of())
            );
        }
        
        // Wait before retry (except first round)
        CompletableFuture<Void> delay = round == 1 
            ? CompletableFuture.completedFuture(null)
            : delayAsync(policy.getRetryIntervalMs());
        
        return delay.thenCompose(v -> {
            // Re-check expiry after delay
            if (round > 1 && !guard.canSubmit()) {
                int remaining = pending.size();
                logger.warn("Retry halted: alert expired during backoff at round {}, remaining: {}", round, remaining);
                return CompletableFuture.completedFuture(
                    new RetryOutcome(retriedCount[0], remaining, 0, List.of())
                );
            }
            
            logger.info("Retry round {}, count: {}", round, pending.size());
            
            return submitter.apply(pending).thenCompose(results -> {
                retriedCount[0] += pending.size();
                
                // Filter still-failing MSISDNs
                Set<String> stillFailing = new HashSet<>();
                for (SubmissionResult result : results) {
                    if (result.outcome() != DeliveryOutcome.accepted) {
                        stillFailing.add(result.msisdn());
                    }
                }
                
                List<String> nextPending = pending.stream()
                    .filter(stillFailing::contains)
                    .toList();
                
                if (nextPending.isEmpty()) {
                    logger.info("Retry completed successfully after {} rounds", round);
                    return CompletableFuture.completedFuture(
                        new RetryOutcome(retriedCount[0], 0, 0, List.of())
                    );
                }
                
                if (round >= policy.getRetryMax()) {
                    logger.info("Retry exhausted after {} rounds, failures: {}", round, nextPending.size());
                    return CompletableFuture.completedFuture(
                        new RetryOutcome(retriedCount[0], 0, nextPending.size(), nextPending)
                    );
                }
                
                return retryRound(nextPending, round + 1, policy, guard, submitter, retriedCount);
            });
        });
    }
    
    private CompletableFuture<Void> delayAsync(long delayMs) {
        return CompletableFuture.runAsync(() -> {
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Retry delay interrupted", e);
            }
        });
    }
}
