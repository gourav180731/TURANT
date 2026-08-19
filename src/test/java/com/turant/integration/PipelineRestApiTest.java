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

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.hamcrest.Matchers.*;

/**
 * Integration tests for REST API endpoints.
 * 
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
        // Given: An ingested CAP alert
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        
        // When: Triggering the pipeline
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            // Then: Should accept the request
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capIdentifier").value(alert.identifier()))
            .andExpect(jsonPath("$.action").value("triggered"))
            .andExpect(jsonPath("$.status").isNotEmpty());
    }
    
    @Test
    void testTriggerPipelineWithMissingAlert() throws Exception {
        // Given: A non-existent alert ID
        String requestBody = """
            {
                "capIdentifier": "non-existent-alert-123",
                "alertId": "non-existent-alert-123"
            }
            """;
        
        // When: Triggering the pipeline
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            // Then: Should return 404
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value(containsString("not found")));
    }
    
    @Test
    void testTriggerPipelineByCapXml() throws Exception {
        // Given: Valid CAP XML
        String capXml = TestDataFixtures.createSampleCapXml();
        
        // When: Triggering via CAP XML
        mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                .contentType(MediaType.APPLICATION_XML)
                .content(capXml))
            // Then: Should ingest and trigger
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capIdentifier").isNotEmpty())
            .andExpect(jsonPath("$.action").value("triggered"));
    }
    
    @Test
    void testTriggerPipelineByInvalidXml() throws Exception {
        // Given: Invalid XML
        String invalidXml = "<invalid>Not a CAP alert</invalid>";
        
        // When: Triggering via invalid XML
        mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                .contentType(MediaType.APPLICATION_XML)
                .content(invalidXml))
            // Then: Should return 400
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value(containsString("parsing failed")));
    }
    
    @Test
    void testGetPipelineStatus() throws Exception {
        // Given: An alert with pipeline status
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        
        // Trigger pipeline first
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(status().isOk());
        
        // When: Checking status
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert.identifier()))
            // Then: Should return status
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.capIdentifier").value(alert.identifier()))
            .andExpect(jsonPath("$.status").isNotEmpty())
            .andExpect(jsonPath("$.stage").isNotEmpty());
    }
    
    @Test
    void testGetNonExistentPipelineStatus() throws Exception {
        // When: Checking status for non-existent alert
        mockMvc.perform(get("/api/v1/pipeline/status/non-existent-id"))
            // Then: Should return 404
            .andExpect(status().isNotFound());
    }
    
    @Test
    void testGetPipelineReport() throws Exception {
        // Given: An alert that has run through pipeline
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        
        // Trigger and wait for completion
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(status().isOk());
        
        // Wait a moment for pipeline to process
        Thread.sleep(500);
        
        // When: Getting report
        mockMvc.perform(get("/api/v1/pipeline/report/" + alert.identifier()))
            // Then: Should return report
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.alertId").value(alert.identifier()))
            .andExpect(jsonPath("$.capIdentifier").value(alert.identifier()));
    }
    
    @Test
    void testDeletePipelineStatus() throws Exception {
        // Given: An alert with pipeline status
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(status().isOk());
        
        // When: Deleting status
        mockMvc.perform(delete("/api/v1/pipeline/status/" + alert.identifier()))
            // Then: Should succeed
            .andExpect(status().isOk());
        
        // And: Status should no longer exist
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert.identifier()))
            .andExpect(status().isNotFound());
    }
    
    @Test
    void testGetMatchedTowers() throws Exception {
        // Given: An alert that has matched towers
        String capXml = TestDataFixtures.createSampleCapXml();
        CapAlert alert = capService.ingestCap(capXml).join();
        
        String requestBody = """
            {
                "capIdentifier": "%s",
                "alertId": "%s"
            }
            """.formatted(alert.identifier(), alert.identifier());
        
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(requestBody))
            .andExpect(status().isOk());
        
        // Wait for tower matching to complete
        Thread.sleep(500);
        
        // When: Getting matched towers
        mockMvc.perform(get("/api/v1/pipeline/towers/" + alert.identifier()))
            // Then: Should return tower list
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.towers").isArray());
    }
    
    @Test
    void testConcurrentPipelineTriggers() throws Exception {
        // Given: Multiple alerts
        String capXml1 = TestDataFixtures.createSampleCapXml();
        String capXml2 = TestDataFixtures.createFloodCapXml(); // Use different alert
        
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
        
        // When: Triggering both concurrently
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(request1))
            .andExpect(status().isOk());
        
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(request2))
            .andExpect(status().isOk());
        
        // Then: Both should have status
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert1.identifier()))
            .andExpect(status().isOk());
        
        mockMvc.perform(get("/api/v1/pipeline/status/" + alert2.identifier()))
            .andExpect(status().isOk());
    }
    
    @Test
    void testInvalidJsonRequest() throws Exception {
        // Given: Invalid JSON
        String invalidJson = "{invalid json}";
        
        // When: Posting invalid JSON
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .contentType(MediaType.APPLICATION_JSON)
                .content(invalidJson))
            // Then: Should return 400
            .andExpect(status().isBadRequest());
    }
    
    @Test
    void testMissingContentType() throws Exception {
        // Given: Request without content type
        String requestBody = """
            {
                "capIdentifier": "test-alert",
                "alertId": "test-alert"
            }
            """;
        
        // When: Posting without content type
        mockMvc.perform(post("/api/v1/pipeline/trigger")
                .content(requestBody))
            // Then: Should return 415 (Unsupported Media Type)
            .andExpect(status().isUnsupportedMediaType());
    }
}
