package com.turant.ews;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.ews.config.EwsProperties;
import com.turant.ews.dto.EwsFeedback;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import com.turant.ews.exception.EwsException;
import org.junit.jupiter.api.*;
import org.mockserver.integration.ClientAndServer;
import org.mockserver.model.HttpRequest;
import org.mockserver.model.HttpResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockserver.model.HttpRequest.request;
import static org.mockserver.model.HttpResponse.response;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = {
        "turant.ews.mode=local",
        "turant.ews.base-url=",
        "turant.ews.connect-timeout=2s",
        "turant.ews.read-timeout=2s"
})
class EwsIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EwsClientFactory clientFactory;

    @Autowired
    private EwsProperties properties;

    @Autowired
    private EwsService ewsService;

    @Autowired
    private ObjectMapper objectMapper;

    private static ClientAndServer mockServer;

    @BeforeAll
    static void startMock() {
        mockServer = ClientAndServer.startClientAndServer(18082);
    }

    @AfterAll
    static void stopMock() {
        if (mockServer != null) mockServer.stop();
    }

    @BeforeEach
    void resetMock() {
        mockServer.reset();
        // Ensure local mode for most tests
        properties.setMode("local");
        properties.setBaseUrl("");
    }

    // 1. Local mode selects LocalEwsClient
    @Test
    void localModeSelectsLocalClient() {
        properties.setMode("local");
        EwsClient client = clientFactory.getClient();
        assertInstanceOf(LocalEwsClient.class, client);
        assertEquals("local", client.getMode());
        assertTrue(clientFactory.isLocalMode());
        assertFalse(clientFactory.isRemoteMode());
    }

    // 2. Remote mode selects RemoteEwsClient
    @Test
    void remoteModeSelectsRemoteClient() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        EwsClient client = clientFactory.getClient();
        assertInstanceOf(RemoteEwsClient.class, client);
        assertEquals("remote", client.getMode());
        assertTrue(clientFactory.isRemoteMode());
    }

    // 3. Invalid mode fails safely
    @Test
    void invalidModeFailsSafely() {
        properties.setMode("invalid_mode");
        assertThrows(IllegalStateException.class, () -> clientFactory.getClient());
        assertThrows(IllegalStateException.class, () -> properties.validate());
        // also EwsMode.from should throw
        assertThrows(IllegalStateException.class, () -> EwsMode.from("bogus"));
    }

    // 4. Local EWS endpoint works
    @Test
    void localEwsEndpointWorks() throws Exception {
        String json = objectMapper.writeValueAsString(new EwsRequest("TEST-001", "TEST-001", "Test EWS message", "INFO", null));
        mockMvc.perform(post("/api/v1/ews/local/test")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mode").value("local"))
                .andExpect(jsonPath("$.status").value("accepted"))
                .andExpect(jsonPath("$.referenceId").exists())
                .andExpect(jsonPath("$.timestamp").exists());
    }

    @Test
    void localEwsEndpointRequiresAlertId() throws Exception {
        String json = "{\"message\":\"missing alertId\",\"severity\":\"INFO\"}";
        mockMvc.perform(post("/api/v1/ews/local/test")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isBadRequest());
    }

    // 5. Remote EWS request is constructed correctly (mock server verifies headers/body)
    @Test
    void remoteEwsRequestConstructedCorrectly() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("test-api-key-123");
        properties.setPath("/ews/callback");
        // recreate RemoteEwsClient with new props to pick up baseUrl (client caches baseUrl at construction)
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/ews/callback"))
                .respond(response().withStatusCode(200).withBody("{\"referenceId\":\"REMOTE-123\"}"));

        EwsRequest req = new EwsRequest("ALERT-REMOTE-001", "ALERT-REMOTE-001", "Remote test", "CRITICAL", null);
        EwsResponse resp = remote.send(req);
        assertNotNull(resp);
        assertEquals("remote", resp.mode());
        assertEquals("SUCCESS", resp.status());

        // Verify headers and body
        HttpRequest[] recorded = mockServer.retrieveRecordedRequests(request().withPath("/ews/callback"));
        assertEquals(1, recorded.length);
        String auth = recorded[0].getFirstHeader("Authorization");
        assertEquals("Bearer test-api-key-123", auth);
        String body = recorded[0].getBodyAsString();
        assertTrue(body.contains("ALERT-REMOTE-001"));
    }

    // 6. Remote EWS authentication headers supplied from configuration
    @Test
    void remoteEwsAuthHeadersFromConfig() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("secret-key-xyz");
        properties.setPath("/ews/callback");
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/ews/callback"))
                .respond(response().withStatusCode(200).withBody("ok"));
        remote.send(new EwsRequest("ALERT-AUTH", "ALERT-AUTH", "msg", "INFO", null));
        HttpRequest[] reqs = mockServer.retrieveRecordedRequests(request().withPath("/ews/callback"));
        assertEquals(1, reqs.length);
        String auth = reqs[0].getFirstHeader("Authorization");
        assertNotNull(auth);
        assertTrue(auth.contains("secret-key-xyz"));
    }

    // 7. Credentials never logged — ensure exception messages do not leak apiKey
    @Test
    void credentialsNeverLoggedInException() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("super-secret-999");
        properties.setPath("/ews/callback");
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/ews/callback"))
                .respond(response().withStatusCode(401).withBody("Unauthorized"));
        EwsException ex = assertThrows(EwsException.class, () -> remote.send(new EwsRequest("ALERT-SECRET", "ALERT-SECRET", "msg", "INFO", null)));
        assertNotNull(ex.getMessage());
        assertFalse(ex.getMessage().contains("super-secret-999"), "Exception message must not leak apiKey");
    }

    // 8. Remote timeout handled (short readTimeout)
    @Test
    void remoteTimeoutHandled() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("k");
        properties.setPath("/slow");
        properties.setConnectTimeout(java.time.Duration.ofSeconds(1));
        properties.setReadTimeout(java.time.Duration.ofMillis(500));
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/slow"))
                .respond(response().withStatusCode(200).withBody("ok").withDelay(org.mockserver.model.Delay.milliseconds(2000)));
        EwsException ex = assertThrows(EwsException.class, () -> remote.send(new EwsRequest("ALERT-TIMEOUT", "ALERT-TIMEOUT", "msg", "INFO", null)));
        // Should be TIMEOUT or CONNECTION_FAILURE depending on underlying client
        assertTrue(ex.getErrorCode() == com.turant.ews.exception.EwsErrorCode.TIMEOUT
                || ex.getErrorCode() == com.turant.ews.exception.EwsErrorCode.SERVER_ERROR
                || ex.getErrorCode() == com.turant.ews.exception.EwsErrorCode.CONNECTION_FAILURE);
    }

    // 9. Remote 401/403 handled as AUTHENTICATION_FAILURE
    @Test
    void remote401Handled() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("k");
        properties.setPath("/auth401");
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/auth401"))
                .respond(response().withStatusCode(401).withBody("Unauthorized"));
        EwsException ex = assertThrows(EwsException.class, () -> remote.send(new EwsRequest("ALERT-401", "ALERT-401", "msg", "INFO", null)));
        assertEquals(com.turant.ews.exception.EwsErrorCode.AUTHENTICATION_FAILURE, ex.getErrorCode());
        assertEquals(401, ex.getHttpStatus());
    }

    @Test
    void remote403Handled() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("k");
        properties.setPath("/auth403");
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/auth403"))
                .respond(response().withStatusCode(403).withBody("Forbidden"));
        EwsException ex = assertThrows(EwsException.class, () -> remote.send(new EwsRequest("ALERT-403", "ALERT-403", "msg", "INFO", null)));
        assertEquals(com.turant.ews.exception.EwsErrorCode.AUTHENTICATION_FAILURE, ex.getErrorCode());
    }

    // 10. Remote 5xx handled as SERVER_ERROR
    @Test
    void remote5xxHandled() {
        properties.setMode("remote");
        properties.setBaseUrl("http://localhost:18082");
        properties.setApiKey("k");
        properties.setPath("/err500");
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        mockServer.when(request().withMethod("POST").withPath("/err500"))
                .respond(response().withStatusCode(500).withBody("Internal Error"));
        EwsException ex = assertThrows(EwsException.class, () -> remote.send(new EwsRequest("ALERT-500", "ALERT-500", "msg", "INFO", null)));
        assertEquals(com.turant.ews.exception.EwsErrorCode.SERVER_ERROR, ex.getErrorCode());
        assertEquals(500, ex.getHttpStatus());
    }

    // 11. Feedback endpoint validates input
    @Test
    void feedbackEndpointValidatesInput() throws Exception {
        String invalid = "{\"referenceId\":\"REF-1\",\"status\":\"delivered\"}";
        mockMvc.perform(post("/api/v1/ews/feedback")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(invalid))
                .andExpect(status().isBadRequest());

        String blankAlert = "{\"alertId\":\"\",\"referenceId\":\"REF-1\"}";
        mockMvc.perform(post("/api/v1/ews/feedback")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(blankAlert))
                .andExpect(status().isBadRequest());
    }

    @Test
    void feedbackEndpointAcceptsValidPayload() throws Exception {
        String valid = objectMapper.writeValueAsString(new EwsFeedback("ALERT-FB-001", "CAP-001", "REF-001", "delivered", "ok", 10, 0, "2026-09-07T00:00:00Z", null));
        mockMvc.perform(post("/api/v1/ews/feedback")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(valid))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("acknowledged"))
                .andExpect(jsonPath("$.alertId").value("ALERT-FB-001"));
    }

    // 12. Duplicate feedback handled safely (idempotent)
    @Test
    void duplicateFeedbackIdempotent() throws Exception {
        String payload = objectMapper.writeValueAsString(new EwsFeedback("ALERT-DUP-001", "CAP-DUP", "REF-DUP", "delivered", "first", 5, 0, "2026-09-07T00:00:00Z", null));
        mockMvc.perform(post("/api/v1/ews/feedback").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.duplicate").value(false));

        // Second identical feedback -> duplicate true, still 200
        mockMvc.perform(post("/api/v1/ews/feedback").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.duplicate").value(true));
    }

    // 13. Production/remote mode cannot silently fall back to local
    @Test
    void remoteModeCannotFallbackToLocal() throws Exception {
        properties.setMode("remote");
        // No baseUrl -> validate should fail if we trigger validate via factory's Remote client?
        // Instead test endpoint returns rejected when mode != remote for remote test, and test-remote fails when mode=local
        properties.setMode("local");
        String json = objectMapper.writeValueAsString(new EwsRequest("ALERT-FALLBACK", "ALERT-FALLBACK", "msg", "INFO", null));
        mockMvc.perform(post("/api/v1/ews/test-remote")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value("rejected"))
                .andExpect(jsonPath("$.reason").exists());

        // Also verify sendRemote throws when not in remote mode
        assertThrows(EwsException.class, () -> ewsService.sendRemote(new EwsRequest("X", "X", "m", "INFO", null)));

        // Remote mode with missing baseUrl should throw NOT_CONFIGURED, not fallback to local
        properties.setMode("remote");
        properties.setBaseUrl("");
        RemoteEwsClient remote = new RemoteEwsClient(properties);
        EwsException ex = assertThrows(EwsException.class, () -> remote.send(new EwsRequest("ALERT-NO-URL", "ALERT-NO-URL", "msg", "INFO", null)));
        assertEquals(com.turant.ews.exception.EwsErrorCode.NOT_CONFIGURED, ex.getErrorCode());
    }

    // 14. Mode endpoint returns configured mode
    @Test
    void modeEndpoint() throws Exception {
        properties.setMode("local");
        mockMvc.perform(get("/api/v1/ews/mode"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mode").value("local"));
    }

    @Test
    void testRemoteEndpointRejectedWhenLocal() throws Exception {
        properties.setMode("local");
        String json = objectMapper.writeValueAsString(new EwsRequest("ALERT-REJECT", "ALERT-REJECT", "msg", "INFO", null));
        mockMvc.perform(post("/api/v1/ews/test-remote")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MODE"));
    }
}
