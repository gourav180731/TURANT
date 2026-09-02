package com.turant.pipeline;

import com.turant.cap.CapIngestionService;
import com.turant.simulation.TestDataFixtures;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;

/**
 * Item #1 — API Exposure: 8 canonical EWS tests proving HTTP → Java controller → pipeline.
 * Canonical EWS entry: POST /api/v1/pipeline/trigger-by-cap (PipelineController.java:94)
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("test")
class CanonicalEwsApiTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private PipelineStatusStore statusStore;
    @Autowired private CapIngestionService capService;

    private static String validCapXml() {
        String id = "earthquake-delhi-" + java.util.UUID.randomUUID();
        return TestDataFixtures.createSampleCapXml().replace("earthquake-delhi-001", id);
    }

    @Test
    void test1_validCap_successfulTrigger() throws Exception {
        String capXml = validCapXml();
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();
        MvcResult result = mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isOk())
                .andReturn();
        System.out.println("TEST1 body: " + result.getResponse().getContentAsString());
        String body = result.getResponse().getContentAsString();
        assertThat(body).contains("capIdentifier");
        String capId = body.replaceAll(".*\"capIdentifier\"\\s*:\\s*\"([^\"]+)\".*", "$1");
        assertThat(statusStore.get(capId)).isNotNull();
    }

    @Test
    void test2_blankRequest_400() throws Exception {
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(""))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").exists())
                .andExpect(jsonPath("$.code").value("EMPTY_CAP"));
    }

    @Test
    void test3_invalidCap_400() throws Exception {
        String invalid = "<invalid>Not a CAP alert</invalid>";
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(invalid))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("CAP_PARSE_ERROR"));
    }

    @Test
    void test4_capLargerThanMax_413() throws Exception {
        String large = "A".repeat(21 * 1024 * 1024);
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(large))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.code").value("CAP_TOO_LARGE"));
    }

    @Test
    void test5_validTrigger_pipelineActuallyStarts() throws Exception {
        String capXml = validCapXml();
        String capId = capService.ingestCap(capXml).join().identifier();
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/pipeline/status/" + capId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capIdentifier").value(capId))
                .andExpect(jsonPath("$.status").isNotEmpty());
    }

    @Test
    void test6_statusEndpoint_returnsPipelineStatus() throws Exception {
        String capXml = validCapXml();
        String capId = capService.ingestCap(capXml).join().identifier();
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"capIdentifier\":\"" + capId + "\"}"))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async)).andExpect(status().isOk());
        Thread.sleep(300);
        mockMvc.perform(get("/api/v1/pipeline/status/" + capId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capIdentifier").value(capId))
                .andExpect(jsonPath("$.towerCount").isNumber())
                .andExpect(jsonPath("$.matchedCount").isNumber());
    }

    @Test
    void test7_towerEndpoint_returnsStoredTowers() throws Exception {
        String capXml = validCapXml();
        String capId = capService.ingestCap(capXml).join().identifier();
        MvcResult async = mockMvc.perform(post("/api/v1/pipeline/trigger")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"capIdentifier\":\"" + capId + "\"}"))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async)).andExpect(status().isOk());
        Thread.sleep(400);
        mockMvc.perform(get("/api/v1/pipeline/towers/" + capId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capIdentifier").value(capId))
                .andExpect(jsonPath("$.count").isNumber())
                .andExpect(jsonPath("$.towers").isArray());
    }

    @Test
    void test8_unknownCapIdentifier_404() throws Exception {
        mockMvc.perform(get("/api/v1/pipeline/status/non-existent-999"))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/pipeline/towers/non-existent-999"))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/pipeline/report/non-existent-999"))
                .andExpect(status().isNotFound());
    }
}
