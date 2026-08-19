package com.turant.dlr;

import com.turant.dlr.DlrListener.AlertReceiptStats;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Per-alert delivery reporting (module 11).
 * 
 * Aggregates DLR counts and merges them with latency trace data to answer
 * "how many of the intended recipients actually received the alert, and how fast?".
 * 
 * Migrated from TypeScript Module 11 dlr-reporter.ts
 */
@Component
public class DlrReporter {
    
    private static final Logger logger = LoggerFactory.getLogger(DlrReporter.class);
    
    public static class DeliveryReport {
        private final String capIdentifier;
        private final int expectedRecipients;
        private final int delivered;
        private final List<String> deliveredTo;
        private final Long firstReceivedEpochMs;
        private final Long lastReceivedEpochMs;
        
        public DeliveryReport(
                String capIdentifier,
                int expectedRecipients,
                int delivered,
                List<String> deliveredTo,
                Long firstReceivedEpochMs,
                Long lastReceivedEpochMs) {
            this.capIdentifier = capIdentifier;
            this.expectedRecipients = expectedRecipients;
            this.delivered = delivered;
            this.deliveredTo = deliveredTo;
            this.firstReceivedEpochMs = firstReceivedEpochMs;
            this.lastReceivedEpochMs = lastReceivedEpochMs;
        }
        
        public String getCapIdentifier() { return capIdentifier; }
        public int getExpectedRecipients() { return expectedRecipients; }
        public int getDelivered() { return delivered; }
        public List<String> getDeliveredTo() { return deliveredTo; }
        public Long getFirstReceivedEpochMs() { return firstReceivedEpochMs; }
        public Long getLastReceivedEpochMs() { return lastReceivedEpochMs; }
    }
    
    private final DlrListener listener;
    
    public DlrReporter(DlrListener listener) {
        this.listener = listener;
    }
    
    /**
     * Build a real per-alert delivery report.
     */
    public DeliveryReport buildDeliveryReport(String capIdentifier) {
        AlertReceiptStats stats = listener.receiptsForAlert(capIdentifier);
        
        List<String> deliveredTo = stats != null
            ? stats.getReceived().stream().map(r -> r.smscMessageId()).toList()
            : List.of();
        
        int expectedRecipients = stats != null ? stats.getExpectedCount() : 0;
        int delivered = stats != null ? stats.getReceivedCount() : 0;
        Long firstReceivedEpochMs = stats != null ? stats.getFirstReceivedEpochMs() : null;
        Long lastReceivedEpochMs = stats != null ? stats.getLastReceivedEpochMs() : null;
        
        // TODO: Integrate with trace store for percentiles and stage deltas when implemented
        
        DeliveryReport report = new DeliveryReport(
            capIdentifier,
            expectedRecipients,
            delivered,
            deliveredTo,
            firstReceivedEpochMs,
            lastReceivedEpochMs
        );
        
        logger.info("DLR report: capIdentifier={}, delivered={}, expected={}", 
            capIdentifier, delivered, expectedRecipients);
        
        return report;
    }
}
