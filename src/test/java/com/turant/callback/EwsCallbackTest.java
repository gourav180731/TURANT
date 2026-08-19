package com.turant.callback;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.turant.types.report.AlertReport;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockserver.integration.ClientAndServer;
import org.mockserver.model.HttpRequest;
import org.mockserver.model.HttpResponse;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockserver.model.HttpRequest.request;
import static org.mockserver.model.HttpResponse.response;

/**
 * Unit tests for EwsCallback (Module 12).
 * 
 * Tests HTTP callback delivery, token authentication, and fallback behavior.
 */
class EwsCallbackTest {
    
    private EwsCallback ewsCallback;
    private ObjectMapper objectMapper;
    private ClientAndServer mockServer;
    
    @BeforeEach
    void setUp() {
        // Start mock HTTP server
        mockServer = ClientAndServer.startClientAndServer(18080);
        
        // Create EWS callback with real dependencies
        objectMapper = new ObjectMapper();
        objectMapper.registerModule(new JavaTimeModule());
        ewsCallback = new EwsCallback(objectMapper);
        
        // Configure with mock server URL
        ReflectionTestUtils.setField(ewsCallback, "callbackUrl", "http://localhost:18080/ews/callback");
        ReflectionTestUtils.setField(ewsCallback, "callbackToken", "test-token-123");
        ReflectionTestUtils.setField(ewsCallback, "callbackTimeoutMs", 5000L);
    }
    
    @AfterEach
    void tearDown() {
        if (mockServer != null) {
            mockServer.stop();
        }
    }
    
    @Test
    void testPushReportToEwsSuccess() throws Exception {
        // Given: Mock server expects POST with report
        mockServer
            .when(request()
                .withMethod("POST")
                .withPath("/ews/callback"))
            .respond(response()
                .withStatusCode(200)
                .withBody("OK"));
        
        // And: Alert report
        AlertReport report = createSampleReport();
        
        // When: Pushing report
        CompletableFuture<EwsCallback.EwsCallbackResult> future = ewsCallback.pushReportToEws(report);
        EwsCallback.EwsCallbackResult result = future.get(10, TimeUnit.SECONDS);
        
        // Then: Should succeed
        assertNotNull(result);
        assertTrue(result.isOk());
        assertEquals(EwsCallback.DeliveryChannel.HTTP, result.getDelivered());
        assertEquals(200, result.getStatusCode());
        assertNull(result.getError());
    }
    
    @Test
    void testPushReportWithAuthorization() throws Exception {
        // Given: Mock server expects Authorization header
        HttpRequest expectedRequest = request()
            .withMethod("POST")
            .withPath("/ews/callback")
            .withHeader("Authorization", "Bearer test-token-123");
        
        mockServer
            .when(expectedRequest)
            .respond(response()
                .withStatusCode(200));
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should succeed with token
        assertTrue(result.isOk());
        
        // Verify token was sent
        mockServer.verify(expectedRequest);
    }
    
    @Test
    void testPushReportWithoutToken() throws Exception {
        // Given: No token configured
        ReflectionTestUtils.setField(ewsCallback, "callbackToken", "");
        
        mockServer
            .when(request()
                .withMethod("POST")
                .withPath("/ews/callback"))
            .respond(response()
                .withStatusCode(200));
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should succeed without token
        assertTrue(result.isOk());
    }
    
    @Test
    void testPushReportRejectedByServer() throws Exception {
        // Given: Mock server rejects with 403
        mockServer
            .when(request()
                .withMethod("POST")
                .withPath("/ews/callback"))
            .respond(response()
                .withStatusCode(403)
                .withBody("Forbidden"));
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should fail with error status
        assertNotNull(result);
        assertFalse(result.isOk());
        assertEquals(EwsCallback.DeliveryChannel.HTTP, result.getDelivered());
        assertEquals(403, result.getStatusCode());
    }
    
    @Test
    void testPushReportServerError() throws Exception {
        // Given: Mock server returns 500
        mockServer
            .when(request()
                .withMethod("POST")
                .withPath("/ews/callback"))
            .respond(response()
                .withStatusCode(500)
                .withBody("Internal Server Error"));
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should fail
        assertFalse(result.isOk());
        assertEquals(500, result.getStatusCode());
    }
    
    @Test
    void testPushReportConnectionFailure() throws Exception {
        // Given: Invalid URL (no server listening)
        ReflectionTestUtils.setField(ewsCallback, "callbackUrl", "http://localhost:19999/nonexistent");
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should fail
        assertFalse(result.isOk());
        // Error message may be null or have text depending on the connection failure type
    }
    
    @Test
    void testPushReportNoUrlConfigured() throws Exception {
        // Given: No callback URL configured
        ReflectionTestUtils.setField(ewsCallback, "callbackUrl", "");
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should return not configured
        assertNotNull(result);
        assertFalse(result.isOk());
        assertEquals(EwsCallback.DeliveryChannel.NOT_CONFIGURED, result.getDelivered());
        assertNull(result.getStatusCode());
    }
    
    @Test
    void testPushReportNullUrl() throws Exception {
        // Given: Null callback URL
        ReflectionTestUtils.setField(ewsCallback, "callbackUrl", null);
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        EwsCallback.EwsCallbackResult result = ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should return not configured
        assertFalse(result.isOk());
        assertEquals(EwsCallback.DeliveryChannel.NOT_CONFIGURED, result.getDelivered());
    }
    
    @Test
    void testPushReportValidatesJsonPayload() throws Exception {
        // Given: Mock server captures request body
        mockServer
            .when(request()
                .withMethod("POST")
                .withPath("/ews/callback"))
            .respond(response()
                .withStatusCode(200));
        
        // When: Pushing report
        AlertReport report = createSampleReport();
        ewsCallback.pushReportToEws(report).get(10, TimeUnit.SECONDS);
        
        // Then: Should send valid JSON
        HttpRequest[] requests = mockServer.retrieveRecordedRequests(request().withPath("/ews/callback"));
        assertEquals(1, requests.length);
        
        String body = requests[0].getBodyAsString();
        assertNotNull(body);
        assertTrue(body.contains("alert-001")); // Should contain alert ID
        assertTrue(body.contains("\"alertId\"")); // Should have JSON field
    }
    
    @Test
    void testEwsCallbackResultGetters() {
        // Given: Result with all fields
        EwsCallback.EwsCallbackResult result = new EwsCallback.EwsCallbackResult(
            true,
            EwsCallback.DeliveryChannel.HTTP,
            200,
            null
        );
        
        // Then: Getters should work
        assertTrue(result.isOk());
        assertEquals(EwsCallback.DeliveryChannel.HTTP, result.getDelivered());
        assertEquals(200, result.getStatusCode());
        assertNull(result.getError());
    }
    
    @Test
    void testEwsCallbackResultWithError() {
        // Given: Result with error
        EwsCallback.EwsCallbackResult result = new EwsCallback.EwsCallbackResult(
            false,
            EwsCallback.DeliveryChannel.HTTP,
            null,
            "Connection refused"
        );
        
        // Then: Should have error
        assertFalse(result.isOk());
        assertEquals("Connection refused", result.getError());
        assertNull(result.getStatusCode());
    }
    
    @Test
    void testDeliveryChannelEnum() {
        // Then: All delivery channels should be defined
        assertEquals(3, EwsCallback.DeliveryChannel.values().length);
        assertNotNull(EwsCallback.DeliveryChannel.HTTP);
        assertNotNull(EwsCallback.DeliveryChannel.DB_FALLBACK);
        assertNotNull(EwsCallback.DeliveryChannel.NOT_CONFIGURED);
    }
    
    @Test
    void testLatencySectionForReportNotYetImplemented() {
        // Given: Alert ID
        String capIdentifier = "alert-001";
        
        // When: Getting latency section
        AlertReport.LatencyMetrics latency = ewsCallback.latencySectionForReport(capIdentifier);
        
        // Then: Should return null (not yet implemented)
        assertNull(latency);
    }
    
    private AlertReport createSampleReport() {
        return new AlertReport(
            "alert-001",
            "cap-id-001",
            "2026-08-19T09:00:00Z",
            "2026-08-19T09:10:00Z",
            100,    // targetedSubscriberCount
            95,     // smsSubmittedCount
            95,     // smsAcceptedCount
            90,     // deliveredCount
            5,      // failedCount
            0,      // expiredMessageCount
            95,     // successfulPushCount
            10,     // towerCount
            null,   // latencyMs
            true    // completed
        );
    }
}
