package com.turant.ews.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;

/**
 * Inbound EWS feedback/callback payload — EWS calls TURANT with delivery feedback.
 * Pending C-DOT contract: fields are documented as adaptable.
 * Persisted and processed idempotently.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EwsFeedback(
        @NotBlank String alertId,
        String capIdentifier,
        String referenceId,
        String status,
        String message,
        Integer deliveredCount,
        Integer failedCount,
        String timestamp,
        String rawPayload
) {
}
