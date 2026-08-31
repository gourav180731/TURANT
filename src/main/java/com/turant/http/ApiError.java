package com.turant.http;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.servlet.http.HttpServletRequest;

import java.time.Instant;
import java.util.UUID;

/**
 * Canonical API error contract for pipeline APIs (Activity 1).
 * Fields are only populated when available from implementation.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiError(
        String timestamp,
        int status,
        String error,
        String code,
        String message,
        String path,
        String requestId
) {
    public static ApiError of(HttpServletRequest req, int status, String error, String code, String message) {
        String path = req != null ? req.getRequestURI() : null;
        String requestId = UUID.randomUUID().toString();
        String timestamp = Instant.now().toString();
        String reason = error != null ? error : httpReason(status);
        return new ApiError(timestamp, status, reason, code, message, path, requestId);
    }

    public static ApiError of(int status, String error, String code, String message, String path) {
        return new ApiError(Instant.now().toString(), status, error != null ? error : httpReason(status), code, message, path, UUID.randomUUID().toString());
    }

    private static String httpReason(int status) {
        return switch (status) {
            case 400 -> "Bad Request";
            case 404 -> "Not Found";
            case 413 -> "Payload Too Large";
            case 500 -> "Internal Server Error";
            case 503 -> "Service Unavailable";
            default -> "Error";
        };
    }
}
