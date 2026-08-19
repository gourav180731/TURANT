package com.turant.types.report;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Per-alert processing report, produced by the pipeline and delivered to the
 * originating EWS via module 12's callback.
 * 
 * "SMS submitted count" must equal "successful push count" - see the
 * EWS callback contract in module 12.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AlertReport(
    String alertId,
    String capIdentifier,
    String processingStartedAt,
    String processingEndedAt,
    
    /** Subscribers matched after dedup. */
    int targetedSubscriberCount,
    
    /** SMS messages accepted for submission to the SMSC. */
    int smsSubmittedCount,
    
    /** SMS messages the SMSC accepted (submit_sm success). */
    int smsAcceptedCount,
    
    /** Messages confirmed delivered via DLR. */
    int deliveredCount,
    
    /** Messages rejected or failed. */
    int failedCount,
    
    /** Messages dropped because the alert expired before submission. */
    int expiredMessageCount,
    
    /** Always smsSubmittedCount === successfulPushCount. */
    int successfulPushCount,
    
    /** Per-tower breakdown for audit. */
    int towerCount,
    
    /**
     * Latency (measured from t0 = CAP ingestion) reported to the EWS so it can
     * judge delivery speed, not just volume. Absent until the first DLR arrives.
     */
    LatencyMetrics latencyMs,
    
    boolean completed
) {
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record LatencyMetrics(
        /** t0 → first successful delivery. */
        Long t0ToFirstDeliveryMs,
        /** t0 → 50% of intended recipients delivered. */
        Long t0ToP50Ms,
        /** t0 → 90% of intended recipients delivered. */
        Long t0ToP90Ms,
        /** t0 → 100% of intended recipients delivered. */
        Long t0ToP100Ms
    ) {}
}
