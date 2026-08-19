package com.turant.types.report;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * Per-alert delivery report from DLR receipts.
 * Returned by GET /api/v1/alerts/:capIdentifier/report
 */
public record DeliveryReport(
    @JsonProperty("capIdentifier") String capIdentifier,
    @JsonProperty("expectedRecipients") int expectedRecipients,
    @JsonProperty("delivered") int delivered,
    @JsonProperty("deliveredTo") List<String> deliveredTo,
    @JsonProperty("firstReceivedEpochMs") Long firstReceivedEpochMs,
    @JsonProperty("lastReceivedEpochMs") Long lastReceivedEpochMs
) {}
