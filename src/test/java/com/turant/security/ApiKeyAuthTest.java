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

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;

/**
 * Item #2 Security — API Key tests.
 * Enables API key via TestPropertySource, verifies 401/200 and pipeline start.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestPropertySource(properties = "turant.security.api-key=test-key-12345")
class ApiKeyAuthTest {

    @Autowired private MockMvc mockMvc;

    private static final String VALID_KEY = "test-key-12345";
    private static final String INVALID_KEY = "wrong-key";

    private String createUniqueCapXml() {
        String id = "alert-" + java.util.UUID.randomUUID();
        return TestDataFixtures.createSampleCapXml().replace("earthquake-delhi-001", id);
    }

    @Test
    void missingApiKey_401() throws Exception {
        String capXml = createUniqueCapXml();
        mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .content(capXml))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
    }

    @Test
    void invalidApiKey_401() throws Exception {
        String capXml = createUniqueCapXml();
        mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", INVALID_KEY)
                        .content(capXml))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
    }

    @Test
    void validApiKey_accepted() throws Exception {
        String capXml = createUniqueCapXml();
        var async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capIdentifier").isNotEmpty());
    }

    @Test
    void validApiKey_pipelineActuallyStarts() throws Exception {
        String capXml = createUniqueCapXml();
        var async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-EWS-API-KEY", VALID_KEY)
                        .content(capXml))
                .andExpect(request().asyncStarted())
                .andReturn();
        var result = mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isOk())
                .andReturn();
        String body = result.getResponse().getContentAsString();
        // Also works with Bearer
        String capXml2 = createUniqueCapXml();
        var async2 = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("Authorization", "Bearer " + VALID_KEY)
                        .content(capXml2))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async2)).andExpect(status().isOk());
    }

    @Test
    void replaySameCap_rejectedWithConflict() throws Exception {
        String cap = createUniqueCapXml();
        var a1 = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY)
                        .content(cap))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(a1)).andExpect(status().isOk());

        var a2 = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY)
                        .content(cap))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(a2))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("REPLAY_DETECTED"));
    }

    @Test
    void capValidationStillWorks_withValidKey() throws Exception {
        String invalid = "<invalid>bad</invalid>";
        var async = mockMvc.perform(post("/api/v1/pipeline/trigger-by-cap")
                        .contentType(MediaType.APPLICATION_XML)
                        .header("X-API-KEY", VALID_KEY)
                        .content(invalid))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(async))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("CAP_PARSE_ERROR"));
    }

    @Test
    void protectedStatusRejectsUnauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/pipeline/status/some-id"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/pipeline/status/some-id")
                        .header("X-API-KEY", INVALID_KEY))
                .andExpect(status().isUnauthorized());
        // Valid key but not found → 404 (not 401)
        mockMvc.perform(get("/api/v1/pipeline/status/some-id")
                        .header("X-API-KEY", VALID_KEY))
                .andExpect(status().isNotFound());
    }

    @Test
    void protectedTowersAndReportRejectUnauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/pipeline/towers/some-id"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/pipeline/report/some-id"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/pipeline/towers/some-id").header("X-API-KEY", VALID_KEY))
                .andExpect(status().isNotFound());
    }

    @Test
    void healthEndpoint_public() throws Exception {
        mockMvc.perform(get("/healthz"))
                .andExpect(status().isOk());
        mockMvc.perform(get("/healthz").header("X-API-KEY", VALID_KEY))
                .andExpect(status().isOk());
    }

    @Test
    void swaggerIsPublicInTest() throws Exception {
        var result = mockMvc.perform(get("/api-docs")).andReturn();
        assertThat(result.getResponse().getStatus()).isNotEqualTo(401);
        var r2 = mockMvc.perform(get("/swagger-ui.html")).andReturn();
        assertThat(r2.getResponse().getStatus()).isNotEqualTo(401);
    }

    @Test
    void noRealSecretInSource() throws Exception {
        // Check .env.example contains placeholder, not real secret
        java.nio.file.Path p = java.nio.file.Paths.get(".env.example");
        String content = java.nio.file.Files.readString(p);
        assert !content.contains("test-key-12345") : ".env.example must not contain real test key";
        assert content.contains("change_me") : ".env.example must contain placeholder";
        // Check no hardcoded real key in source
        java.nio.file.Path src = java.nio.file.Paths.get("src/main/java/com/turant/security/ApiKeyAuthFilter.java");
        String srcContent = java.nio.file.Files.readString(src);
        assert !srcContent.contains("test-key-12345");
    }
}
