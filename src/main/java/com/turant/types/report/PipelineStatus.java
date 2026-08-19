package com.turant.types.report;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Pipeline execution status for an alert.
 * Returned by GET /api/v1/alerts/:capIdentifier/pipeline-status
 */
public record PipelineStatus(
    @JsonProperty("capIdentifier") String capIdentifier,
    @JsonProperty("status") Status status,
    @JsonProperty("stage") String stage,
    @JsonProperty("haltedAt") String haltedAt,
    @JsonProperty("reason") String reason,
    @JsonProperty("towerCount") Integer towerCount,
    @JsonProperty("matchedCount") Integer matchedCount,
    @JsonProperty("duplicatesRemoved") Integer duplicatesRemoved,
    @JsonProperty("expectedRecipients") Integer expectedRecipients,
    @JsonProperty("submittedCount") Integer submittedCount,
    @JsonProperty("awaitingCredentials") Boolean awaitingCredentials,
    @JsonProperty("acceptedCount") Integer acceptedCount,
    @JsonProperty("updatedAtMs") long updatedAtMs,
    @JsonProperty("traceRef") String traceRef
) {
    public enum Status {
        running,
        halted,
        completed
    }
}
