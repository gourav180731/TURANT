package com.turant.ews;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.ews.dto.EwsRequest;
import org.junit.jupiter.api.*;
import org.mockserver.integration.ClientAndServer;
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

/**
 * Verifies the controlled local EWS HTTP endpoint actually receives via HTTP,
 * and that pipeline's Activity 7 uses real values.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = {
        "turant.ews.mode=local",
        "turant.ews.local-url=",
        "turant.ews.connect-timeout=2s",
        "turant.ews.read-timeout=2s"
})
class EwsLocalHttpIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private LocalEwsStore store;

    @Autowired
    private ObjectMapper objectMapper;

    private static ClientAndServer mockServer;

    @BeforeAll
    static void startMock() {
        mockServer = ClientAndServer.startClientAndServer(18083);
    }

    @AfterAll
    static void stopMock() {
        if (mockServer != null) mockServer.stop();
    }

    @BeforeEach
    void clearStore() throws Exception {
        mockServer.reset();
        mockMvc.perform(post("/api/v1/ews/local/clear")).andExpect(status().isOk());
        assertEquals(0, store.getReceivedCount());
    }

    @Test
    void localReceiveEndpointStoresAndReturnsDeterministicSuccess() throws Exception {
        EwsRequest req = new EwsRequest("TEST-LOCAL-001", "CAP-001", "Local EWS test", "INFO", null);
        String json = objectMapper.writeValueAsString(req);

        mockMvc.perform(post("/api/v1/ews/local/receive")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mode").value("local"))
                .andExpect(jsonPath("$.status").value("accepted"))
                .andExpect(jsonPath("$.referenceId").value(org.hamcrest.Matchers.startsWith("LOCAL-")))
                .andExpect(jsonPath("$.alertId").value("TEST-LOCAL-001"));

        // Verify store for manual inspection
        assertEquals(1, store.getReceivedCount());
        assertNotNull(store.getLastRequest());
        assertEquals("TEST-LOCAL-001", store.getLastRequest().alertId());
        assertEquals("CAP-001", store.getLastRequest().capIdentifier());

        // Verify inspection endpoint
        mockMvc.perform(get("/api/v1/ews/local/last-received"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.receivedCount").value(1))
                .andExpect(jsonPath("$.request.alertId").value("TEST-LOCAL-001"));

        mockMvc.perform(get("/api/v1/ews/local/received-count"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.receivedCount").value(1));
    }

    @Test
    void localReceiveValidatesAndHandlesFailureSimulation() throws Exception {
        // Missing alertId → 400
        String invalid = "{\"capIdentifier\":\"CAP-001\",\"message\":\"hi\"}";
        mockMvc.perform(post("/api/v1/ews/local/receive")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(invalid))
                .andExpect(status().isBadRequest());

        // Simulate 500
        EwsRequest req = new EwsRequest("FAIL-001", "CAP-001", "fail", "INFO", null);
        String json = objectMapper.writeValueAsString(req);
        mockMvc.perform(post("/api/v1/ews/local/receive")
                        .param("simulateFailure", "500")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.status").value("SERVER_ERROR"));
        assertEquals(1, store.getFailureSimulations());
    }

    @Test
    void localEwsClientDoesRealHttpWhenLocalUrlConfigured() {
        // Configure LocalEwsClient to use MockServer as controlled local EWS
        com.turant.ews.config.EwsProperties props = new com.turant.ews.config.EwsProperties();
        props.setMode("local");
        props.setLocalUrl("http://localhost:18083/api/v1/ews/local/receive");
        // Use same connect/read timeouts as test properties
        LocalEwsClient client = new LocalEwsClient(props, "18083", null, null);

        mockServer.when(request().withMethod("POST").withPath("/api/v1/ews/local/receive"))
                .respond(response().withStatusCode(200).withBody("{\"mode\":\"local\",\"status\":\"accepted\",\"referenceId\":\"LOCAL-TEST123\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"alertId\":\"HTTP-LOCAL-001\",\"message\":\"ok\",\"code\":\"ACCEPTED\",\"httpStatus\":200}").withHeader("Content-Type", "application/json"));

        EwsRequest req = new EwsRequest("HTTP-LOCAL-001", "CAP-HTTP-001", "HTTP local test", "INFO", null);
        var resp = client.send(req);
        assertNotNull(resp);
        assertEquals("local", resp.mode());
        // MockServer should have received exactly one POST
        var recorded = mockServer.retrieveRecordedRequests(request().withPath("/api/v1/ews/local/receive"));
        assertEquals(1, recorded.length);
        assertTrue(recorded[0].getBodyAsString().contains("HTTP-LOCAL-001"));
    }

    @Test
    void localEwsClientFallsBackToInMemoryWhenNoLocalUrl() {
        com.turant.ews.config.EwsProperties props = new com.turant.ews.config.EwsProperties();
        props.setMode("local");
        props.setLocalUrl(""); // blank → in-memory fallback
        LocalEwsClient client = new LocalEwsClient(props, "8080", null, null);
        EwsRequest req = new EwsRequest("FALLBACK-001", "CAP-FB-001", "fallback", "INFO", null);
        var resp = client.send(req);
        assertNotNull(resp);
        assertEquals("local", resp.mode());
        assertEquals("accepted", resp.status());
        assertTrue(resp.referenceId().startsWith("LOCAL-"));
    }
}
