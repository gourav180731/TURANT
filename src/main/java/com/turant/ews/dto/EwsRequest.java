package com.turant.ews.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;

/**
 * Generic EWS integration request.
 * Supports both simple test payloads and full AlertReport forwarding.
 * C-DOT contract: request shape is configurable — this DTO is extensible.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EwsRequest(
        @NotBlank String alertId,
        String capIdentifier,
        String message,
        String severity,
        Object payload
) {
    public static EwsRequest of(String alertId, String message, String severity) {
        return new EwsRequest(alertId, alertId, message, severity, null);
    }
}
