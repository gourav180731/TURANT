package com.turant.ews.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.UUID;

/**
 * EWS integration response — clearly distinguishes outcome per spec:
 * SUCCESS, REMOTE_REJECTED, AUTHENTICATION_FAILURE, TIMEOUT, CONNECTION_FAILURE,
 * INVALID_REQUEST, SERVER_ERROR.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EwsResponse(
        String mode,
        String status,
        String referenceId,
        String timestamp,
        String alertId,
        String message,
        String code,
        Integer httpStatus
) {
    public enum EwsStatus {
        SUCCESS,
        REMOTE_REJECTED,
        AUTHENTICATION_FAILURE,
        TIMEOUT,
        CONNECTION_FAILURE,
        INVALID_REQUEST,
        SERVER_ERROR,
        ACCEPTED // for local mode
    }

    public static EwsResponse success(String mode, String alertId, String referenceId) {
        return new EwsResponse(mode, EwsStatus.SUCCESS.name(), referenceId,
                Instant.now().toString(), alertId, "EWS request succeeded", "SUCCESS", 200);
    }

    public static EwsResponse accepted(String mode, String alertId, String referenceId) {
        return new EwsResponse(mode, EwsStatus.ACCEPTED.name(), referenceId,
                Instant.now().toString(), alertId, "Request accepted", "ACCEPTED", 200);
    }

    public static EwsResponse localAccepted(String alertId, String referenceId) {
        return new EwsResponse("local", "accepted", referenceId,
                Instant.now().toString(), alertId, "Local EWS test request accepted", "ACCEPTED", 200);
    }

    public static EwsResponse error(String mode, EwsStatus status, String code, String message, Integer httpStatus) {
        return new EwsResponse(mode, status.name(), "LOCAL-" + UUID.randomUUID(),
                Instant.now().toString(), null, message, code, httpStatus);
    }

    public static EwsResponse rejected(String reason) {
        return new EwsResponse("remote", EwsStatus.REMOTE_REJECTED.name(), null,
                Instant.now().toString(), null, reason, "REMOTE_REJECTED", 400);
    }
}
