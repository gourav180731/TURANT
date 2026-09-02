package com.turant.security;

import com.turant.simulation.TestDataFixtures;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * End-to-end integration tests for TURANT API Security Architecture.
 * Tests defense-in-depth across authentication, authorization, rate-limiting, replay protection, and audit verification.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = {
        "turant.security.api-key=test-key-12345"
})
class SecurityIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private AuditService auditService;

    private static final String VALID_KEY_TSP_A = "test-key-12345";
    private static final String LIMITED_KEY_TSP_B = "test-key-bbbbb";

    private String createUniqueCapXml() {
        String id = "alert-" + UUID.randomUUID();
        return TestDataFixtures.createSampleCapXml().replace("earthquake-delhi-001", id);
    }

    @Test
    void testMissingAuth_returns401() throws Exception {
        mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(createUniqueCapXml()))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
    }

    @Test
    void testInvalidAuth_returns401() throws Exception {
        mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", "wrong-key-value")
                        .content(createUniqueCapXml()))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
    }

    @Test
    void testUnauthorizedOperation_tspB_returns403() throws Exception {
        // tsp-b has only GET_STATUS role in seeded credentials
        var async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", LIMITED_KEY_TSP_B)
                        .content(createUniqueCapXml()))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }

    @Test
    void testValidCapSubmission_tspA_acceptedAndAudited() throws Exception {
        String capXml = createUniqueCapXml();
        var async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY_TSP_A)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capIdentifier").isNotEmpty());

        // Verify audit chain remains valid and includes events
        assertTrue(auditService.verifyChain());
    }

    @Test
    void testReplayCapSubmission_returns409Conflict() throws Exception {
        String capXml = createUniqueCapXml();

        // 1st request -> 200 OK
        var async1 = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY_TSP_A)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async1)).andExpect(status().isOk());

        // 2nd identical request -> 409 Conflict (Replay Detected)
        var async2 = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY_TSP_A)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async2))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("REPLAY_DETECTED"));
    }

    @Test
    void testMalformedCap_returns400() throws Exception {
        String malformedXml = "<alert><invalid>Malformed XML without required fields</invalid>";
        var async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY_TSP_A)
                        .content(malformedXml))
                .andExpect(request().asyncStarted())
                .andReturn();

        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("CAP_PARSE_ERROR"));
    }

    @Test
    void testDeleteEndpoint_requiresAdminRole_normalClientForbidden() throws Exception {
        mockMvc.perform(delete("/api/v1/pipeline/status/alert-999")
                        .header("X-API-KEY", VALID_KEY_TSP_A))
                .andExpect(status().isForbidden());
    }

    @Test
    void testGetStatus_allowedForAuthorizedClient() throws Exception {
        // tsp-a and tsp-b both have GET_STATUS role
        mockMvc.perform(get("/api/v1/pipeline/status/non-existent-id")
                        .header("X-API-KEY", VALID_KEY_TSP_A))
                .andExpect(status().isNotFound()); // 404 means passed authentication & authorization!

        mockMvc.perform(get("/api/v1/pipeline/status/non-existent-id")
                        .header("X-API-KEY", LIMITED_KEY_TSP_B))
                .andExpect(status().isNotFound());
    }
}
