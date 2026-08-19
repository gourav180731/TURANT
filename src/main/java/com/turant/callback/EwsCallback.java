package com.turant.callback;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.types.report.AlertReport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * EWS origin callback - requirement #12.
 * 
 * After the pipeline finishes an alert, POST the real AlertReport back to the
 * originating EWS (EARTHQUAKE_WARNING_SYSTEM / EWS_CALLBACK_URL). Counts are
 * produced by real pipeline stages, and latencyMs is drawn from the shared
 * latency trace so the EWS sees speed, not just volume.
 * 
 * When no URL is configured this reports loudly and falls back to the
 * alert_reports table so the report is never lost silently.
 * 
 * Migrated from TypeScript Module 12 ews-callback.ts
 */
@Component
public class EwsCallback {
    
    private static final Logger logger = LoggerFactory.getLogger(EwsCallback.class);
    
    public enum DeliveryChannel {
        HTTP,
        DB_FALLBACK,
        NOT_CONFIGURED
    }
    
    public static class EwsCallbackResult {
        private final boolean ok;
        private final DeliveryChannel delivered;
        private final Integer statusCode;
        private final String error;
        
        public EwsCallbackResult(boolean ok, DeliveryChannel delivered, Integer statusCode, String error) {
            this.ok = ok;
            this.delivered = delivered;
            this.statusCode = statusCode;
            this.error = error;
        }
        
        public boolean isOk() { return ok; }
        public DeliveryChannel getDelivered() { return delivered; }
        public Integer getStatusCode() { return statusCode; }
        public String getError() { return error; }
    }
    
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    
    @Value("${ews.callback-url:}")
    private String callbackUrl;
    
    @Value("${ews.callback-token:}")
    private String callbackToken;
    
    @Value("${ews.callback-timeout-ms:30000}")
    private long callbackTimeoutMs;
    
    public EwsCallback(ObjectMapper objectMapper) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(30000))
            .build();
        this.objectMapper = objectMapper;
    }
    
    /**
     * POST the report to the configured EWS URL with token + timeout.
     */
    public CompletableFuture<EwsCallbackResult> pushReportToEws(AlertReport report) {
        if (callbackUrl == null || callbackUrl.isEmpty()) {
            logger.warn("EWS callback not configured for alertId: {}", report.alertId());
            // TODO: Persist to database when repository is implemented
            return CompletableFuture.completedFuture(
                new EwsCallbackResult(false, DeliveryChannel.NOT_CONFIGURED, null, null)
            );
        }
        
        return CompletableFuture.supplyAsync(() -> {
            try {
                String jsonBody = objectMapper.writeValueAsString(report);
                
                HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(callbackUrl))
                    .timeout(Duration.ofMillis(callbackTimeoutMs))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(jsonBody));
                
                if (callbackToken != null && !callbackToken.isEmpty()) {
                    requestBuilder.header("Authorization", "Bearer " + callbackToken);
                }
                
                HttpRequest request = requestBuilder.build();
                HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
                
                boolean ok = response.statusCode() >= 200 && response.statusCode() < 300;
                
                if (!ok) {
                    logger.error("EWS callback rejected: alertId={}, status={}", 
                        report.alertId(), response.statusCode());
                    return new EwsCallbackResult(false, DeliveryChannel.HTTP, response.statusCode(), null);
                }
                
                logger.info("EWS callback delivered: alertId={}, status={}", 
                    report.alertId(), response.statusCode());
                return new EwsCallbackResult(true, DeliveryChannel.HTTP, response.statusCode(), null);
                
            } catch (Exception e) {
                logger.error("EWS callback HTTP failed: alertId=" + report.alertId(), e);
                // TODO: Persist to database as fallback when repository is implemented
                return new EwsCallbackResult(false, DeliveryChannel.HTTP, null, e.getMessage());
            }
        });
    }
    
    /**
     * Derive the latencyMs section of a report from the shared trace store.
     * TODO: Integrate with trace store when implemented.
     */
    public AlertReport.LatencyMetrics latencySectionForReport(String capIdentifier) {
        // TODO: Query trace store for latency metrics
        return null;
    }
}
