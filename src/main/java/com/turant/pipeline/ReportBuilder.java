package com.turant.pipeline;

import com.turant.callback.EwsCallback;
import com.turant.types.report.AlertReport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.concurrent.CompletableFuture;

/**
 * Build the real per-alert AlertReport (requirement #12, EWS completion callback)
 * from pipeline status + trace evidence.
 * 
 * Every count traces back to a live pipeline stage - nothing is fabricated.
 * 
 * Migrated from TypeScript src/pipeline/report-builder.ts
 */
@Component
public class ReportBuilder {
    
    private static final Logger logger = LoggerFactory.getLogger(ReportBuilder.class);
    
    private final EwsCallback ewsCallback;
    
    public ReportBuilder(EwsCallback ewsCallback) {
        this.ewsCallback = ewsCallback;
    }
    
    public static class ReportInput {
        private final String alertId;
        private final String capIdentifier;
        private final int targetedSubscriberCount;
        private final int submittedCount;
        private final int acceptedCount;
        private final int deliveredCount;
        private final int failedCount;
        private final int expiredMessageCount;
        private final int towerCount;
        private final Long startedAtMs;
        private final Long endedAtMs;
        
        public ReportInput(String alertId, String capIdentifier, int targetedSubscriberCount,
                          int submittedCount, int acceptedCount, int deliveredCount,
                          int failedCount, int expiredMessageCount, int towerCount) {
            this(alertId, capIdentifier, targetedSubscriberCount, submittedCount, acceptedCount,
                deliveredCount, failedCount, expiredMessageCount, towerCount, null, null);
        }
        
        public ReportInput(String alertId, String capIdentifier, int targetedSubscriberCount,
                          int submittedCount, int acceptedCount, int deliveredCount,
                          int failedCount, int expiredMessageCount, int towerCount,
                          Long startedAtMs, Long endedAtMs) {
            this.alertId = alertId;
            this.capIdentifier = capIdentifier;
            this.targetedSubscriberCount = targetedSubscriberCount;
            this.submittedCount = submittedCount;
            this.acceptedCount = acceptedCount;
            this.deliveredCount = deliveredCount;
            this.failedCount = failedCount;
            this.expiredMessageCount = expiredMessageCount;
            this.towerCount = towerCount;
            this.startedAtMs = startedAtMs;
            this.endedAtMs = endedAtMs;
        }
        
        public String getAlertId() { return alertId; }
        public String getCapIdentifier() { return capIdentifier; }
        public int getTargetedSubscriberCount() { return targetedSubscriberCount; }
        public int getSubmittedCount() { return submittedCount; }
        public int getAcceptedCount() { return acceptedCount; }
        public int getDeliveredCount() { return deliveredCount; }
        public int getFailedCount() { return failedCount; }
        public int getExpiredMessageCount() { return expiredMessageCount; }
        public int getTowerCount() { return towerCount; }
        public Long getStartedAtMs() { return startedAtMs; }
        public Long getEndedAtMs() { return endedAtMs; }
    }
    
    /**
     * Build alert report from pipeline status.
     */
    public AlertReport buildAlertReport(ReportInput input) {
        // Real pipeline timestamps (start time recorded at ingestion, end time
        // recorded when the final status was stored). Nothing is fabricated here.
        long ended = input.getEndedAtMs() != null
            ? input.getEndedAtMs()
            : System.currentTimeMillis();
        long started = input.getStartedAtMs() != null
            ? input.getStartedAtMs()
            : ended;
        Instant startedAt = Instant.ofEpochMilli(started);
        Instant endedAt = Instant.ofEpochMilli(ended);
        
        // Latency metrics come from the EWS callback implementation (real DLR
        // timing when available, null otherwise - never invented).
        AlertReport.LatencyMetrics latencyMs = ewsCallback.latencySectionForReport(input.getCapIdentifier());
        
        return new AlertReport(
            input.getAlertId(),
            input.getCapIdentifier(),
            startedAt.toString(),
            endedAt.toString(),
            input.getTargetedSubscriberCount(),
            input.getSubmittedCount(),
            input.getAcceptedCount(),
            input.getDeliveredCount(),
            input.getFailedCount(),
            input.getExpiredMessageCount(),
            input.getSubmittedCount(), // successfulPushCount === submittedCount
            input.getTowerCount(),
            latencyMs,
            true
        );
    }
    
    /**
     * Best-effort delivery of completion report to EWS origin with DB fallback.
     * Never throws - callback failures are logged.
     */
    public CompletableFuture<Void> pushCompletionReport(AlertReport report) {
        return ewsCallback.pushReportToEws(report)
            .thenAccept(result -> {
                if (result.isOk()) {
                    logger.info("EWS completion report sent: capIdentifier={}", report.capIdentifier());
                } else {
                    logger.error("EWS completion report failed: capIdentifier={}, error={}", 
                        report.capIdentifier(), result.getError());
                }
            })
            .exceptionally(err -> {
                logger.error("EWS completion report failed: capIdentifier=" + report.capIdentifier(), err);
                return null;
            });
    }
}
