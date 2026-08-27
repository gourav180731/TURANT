package com.turant.http;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestTimeoutException;

import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger logger = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(AsyncRequestTimeoutException.class)
    public ResponseEntity<Map<String,Object>> handleAsyncTimeout(AsyncRequestTimeoutException ex) {
        logger.error("Async timeout (was 30s before fix): {}", ex.getMessage(), ex);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(Map.of(
                "error", "Pipeline timeout",
                "message", "Pipeline exceeded async timeout — retry or reduce polygon count. " + ex.getMessage(),
                "hint", "Server async timeout is now 300s; if you still see this, check PostGIS per-geometry time"
            ));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String,Object>> handleGeneral(Exception ex) {
        logger.error("Unhandled exception at {}: {}", ex.getClass().getSimpleName(), ex.getMessage(), ex);
        // Don't leak stack to client — return structured error instead of default 500/503 whirlpool page
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(Map.of(
                "error", ex.getClass().getSimpleName(),
                "message", ex.getMessage() != null ? ex.getMessage() : "Internal error",
                "hint", "Check server logs for full trace"
            ));
    }
}
