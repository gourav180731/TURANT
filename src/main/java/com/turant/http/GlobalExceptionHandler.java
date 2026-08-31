package com.turant.http;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestTimeoutException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger logger = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(AsyncRequestTimeoutException.class)
    public ResponseEntity<ApiError> handleAsyncTimeout(AsyncRequestTimeoutException ex, HttpServletRequest req) {
        logger.error("Async timeout: {}", ex.getMessage(), ex);
        ApiError body = ApiError.of(req, 503, "Service Unavailable", "PIPELINE_TIMEOUT",
                "Pipeline exceeded async timeout (300s) — retry or reduce polygon count. " + ex.getMessage());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(body);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> handleNotReadable(HttpMessageNotReadableException ex, HttpServletRequest req) {
        logger.warn("Bad request (not readable): {}", ex.getMessage());
        ApiError body = ApiError.of(req, 400, "Bad Request", "INVALID_JSON", "Invalid JSON: " + ex.getMostSpecificCause().getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ApiError> handleUnsupportedMedia(HttpMediaTypeNotSupportedException ex, HttpServletRequest req) {
        logger.warn("Unsupported media type: {}", ex.getMessage());
        ApiError body = ApiError.of(req, 415, "Unsupported Media Type", "UNSUPPORTED_MEDIA_TYPE", ex.getMessage());
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(body);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleGeneral(Exception ex, HttpServletRequest req) {
        logger.error("Unhandled exception at {}: {}", ex.getClass().getSimpleName(), ex.getMessage(), ex);
        ApiError body = ApiError.of(req, 500, "Internal Server Error", ex.getClass().getSimpleName(),
                ex.getMessage() != null ? ex.getMessage() : "Internal error");
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }
}
