package com.turant.simulation;

import com.turant.types.sms.DeliveryOutcome;
import com.turant.types.sms.SmsMessage;
import com.turant.types.sms.SubmissionResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Simulated SMPP client for testing without real SMSC connection.
 * 
 * Simulates:
 * - Message acceptance/rejection
 * - Realistic latency
 * - Failure scenarios
 * - Message IDs
 * 
 * Enable with: simulation.mode=enabled
 */
@Component("simulatedSmppClient")
@ConditionalOnProperty(name = "simulation.mode", havingValue = "enabled")
public class SimulatedSmppClient {
    
    private static final Logger logger = LoggerFactory.getLogger(SimulatedSmppClient.class);
    
    // Simulation parameters
    private static final int SUCCESS_RATE_PERCENT = 95; // 95% success rate
    private static final int MIN_LATENCY_MS = 50;
    private static final int MAX_LATENCY_MS = 200;
    
    private final Random random = new Random();
    
    /**
     * Check if SMPP is configured (always true for simulation).
     */
    public boolean isConfigured() {
        return true;
    }
    
    /**
     * Simulate connection (always succeeds).
     */
    public CompletableFuture<Void> connect() {
        logger.info("Simulated SMPP connection established");
        return CompletableFuture.completedFuture(null);
    }
    
    /**
     * Submit a single message (simulated).
     */
    public CompletableFuture<SubmissionResult> submitSingle(SmsMessage message) {
        return CompletableFuture.supplyAsync(() -> {
            // Simulate network latency
            simulateLatency();
            
            return simulateSubmission(message);
        });
    }
    
    /**
     * Submit a batch of messages (simulated).
     */
    public CompletableFuture<List<SubmissionResult>> submitBatch(
            List<SmsMessage> messages,
            String traceKey) {
        
        return CompletableFuture.supplyAsync(() -> {
            logger.info("Simulating batch submission: {} messages", messages.size());
            
            List<SubmissionResult> results = new ArrayList<>();
            for (SmsMessage message : messages) {
                simulateLatency();
                results.add(simulateSubmission(message));
            }
            
            long accepted = results.stream()
                .filter(r -> r.outcome() == DeliveryOutcome.accepted)
                .count();
            
            logger.info("Batch simulation complete: {} submitted, {} accepted",
                messages.size(), accepted);
            
            return results;
        });
    }
    
    /**
     * Close simulated connection.
     */
    public void close() {
        logger.info("Simulated SMPP connection closed");
    }
    
    /**
     * Simulate message submission with realistic outcomes.
     */
    private SubmissionResult simulateSubmission(SmsMessage message) {
        // Determine outcome based on success rate
        boolean success = random.nextInt(100) < SUCCESS_RATE_PERCENT;
        
        if (success) {
            // Generate simulated SMSC message ID
            String smscMessageId = "SIM" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
            
            return new SubmissionResult(
                message.messageId(),
                message.msisdn(),
                DeliveryOutcome.accepted,
                smscMessageId,
                null,
                null,
                null
            );
        } else {
            // Simulate failure
            int errorCode = 4 + random.nextInt(10); // SMPP error codes 4-14
            String errorText = "ESME_RINVMSGLEN"; // Example error
            
            return new SubmissionResult(
                message.messageId(),
                message.msisdn(),
                DeliveryOutcome.rejected,
                null,
                errorCode,
                errorText,
                null
            );
        }
    }
    
    /**
     * Simulate network latency.
     */
    private void simulateLatency() {
        try {
            int latency = MIN_LATENCY_MS + random.nextInt(MAX_LATENCY_MS - MIN_LATENCY_MS);
            Thread.sleep(latency);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
