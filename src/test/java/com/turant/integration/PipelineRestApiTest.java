package com.turant.integration;

import com.turant.cap.CapIngestionService;
import com.turant.simulation.TestDataFixtures;
import com.turant.types.cap.CapAlert;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.hamcrest.Matchers.*;

/**
 * Integration tests for REST API endpoints.
 * Tests the complete REST API surface with simulation mode.
 * Uses in-memory test context without requiring real database.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("test")
class PipelineRestApiTest {
    
    @Autowired
    private MockMvc mockMvc;
    
    @Autowired
    private CapIngestionService capService;
    
    @Test
    void testHealthEndpoint() throws Exception {
        mockMvc.perform(get("/healthz"))
            .andExpect(status().isOk())
            .andExpect(content().string(containsString("ok")));
    }
    
    @Test
    void testTriggerPipelineWithValidAlert() throws Exception {
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capIdentifier").value(alert.identifier()))
            .andExpect(jsonPath("$.action").value("triggered"))
            .andExpect(jsonPath("$.status").isNotEmpty());
    }
    
    @Test
    void testTriggerPipelineWithMissingAlert() throws Exception {
        String requestBody = """
            {
                "capIdentifier": "non-existent-alert-123",
                "alertId": "non-existent-alert-123"
            }
            """;
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value(containsString("Not Found")));
    }
    
    @Test
    void testTriggerPipelineByCapXml() throws Exception {
        String capXml = TestDataFixtures.createSampleCapXml();
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                .contentType(MediaType.APPLICATION_XML)
                .content(capXml))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capIdentifier").isNotEmpty())
            .andExpect(jsonPath("$.action").value("triggered"));
    }
    
    @Test
    void testTriggerPipelineByInvalidXml() throws Exception {
        String invalidXml = "<invalid>Not a CAP alert</invalid>";
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                .contentType(MediaType.APPLICATION_XML)
                .content(invalidXml))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("CAP_PARSE_ERROR"));
    }
    
    @Test
    void testGetPipelineStatus() throws Exception {
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async)).andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert.identifier()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capIdentifier").value(alert.identifier()))
            .andExpect(jsonPath("$.status").isNotEmpty())
            .andExpect(jsonPath("$.stage").isNotEmpty());
    }
    
    @Test
    void testGetNonExistentPipelineStatus() throws Exception {
        mockMvc.perform(get("/api/v1/pipeline/status/non-existent-id"))
            .andExpect(status().isNotFound());
    }
    
    @Test
    void testGetPipelineReport() throws Exception {
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async)).andExpect(status().isOk());
        Thread.sleep(500);
        mockMvc.perform(get("/api/v1/pipeline/report/" + alert.identifier()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.alertId").value(alert.identifier()))
            .andExpect(jsonPath("$.capIdentifier").value(alert.identifier()));
    }
    
    @Test
    void testDeletePipelineStatus() throws Exception {
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async)).andExpect(status().isOk());
        mockMvc.perform(delete("/api/v1/pipeline/status/" + alert.identifier()))
            .andExpect(status().isNoContent());
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert.identifier()))
            .andExpect(status().isNotFound());
    }
    
    @Test
    void testGetMatchedTowers() throws Exception {
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(request().asyncStarted())
            .andReturn();
        mockMvc.perform(asyncDispatch(async)).andExpect(status().isOk());
        Thread.sleep(500);
        mockMvc.perform(get("/api/v1/pipeline/towers/" + alert.identifier()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.towers").isArray());
    }
    
    @Test
    void testConcurrentPipelineTriggers() throws Exception {
        String capXml1 = TestDataFixtures.createSampleCapXml();
        String capXml2 = TestDataFixtures.createFloodCapXml();
        CapAlert alert1 = capService.ingestCap(capXml1).join();
        CapAlert alert2 = capService.ingestCap(capXml2).join();
        String request1 = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert1.identifier(), alert1.identifier());
        String request2 = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert2.identifier(), alert2.identifier());
        MvcResult a1 = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(request1))
            .andExpect(request().asyncStarted()).andReturn();
        mockMvc.perform(asyncDispatch(a1)).andExpect(status().isOk());
        MvcResult a2 = mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(request2))
            .andExpect(request().asyncStarted()).andReturn();
        mockMvc.perform(asyncDispatch(a2)).andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert1.identifier())).andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert2.identifier())).andExpect(status().isOk());
    }
    
    @Test
    void testInvalidJsonRequest() throws Exception {
        String invalidJson = "{invalid json}";
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(invalidJson))
            .andExpect(status().isBadRequest());
    }
    
    @Test
    void testMissingContentType() throws Exception {
        String requestBody = """
            {
                "capIdentifier": "test-alert",
                "alertId": "test-alert"
            }
            """;
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .content(requestBody))
            .andExpect(status().isUnsupportedMediaType());
    }
}
