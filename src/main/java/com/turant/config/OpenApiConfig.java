package com.turant.config;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.info.Info;
import io.swagger.v3.oas.annotations.servers.Server;
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@OpenAPIDefinition(
        info = @Info(title = "TURANT Emergency Alert API", version = "1.0.0", description = "EWS → TURANT CAP alert pipeline. Canonical EWS entry: POST /api/v1/pipeline/trigger-by-cap"),
        servers = {@Server(url = "http://localhost:8080", description = "Development")}
)
public class OpenApiConfig {

    @Bean
    public OpenAPI turantOpenApi() {
        return new OpenAPI()
                .components(new Components())
                .info(new io.swagger.v3.oas.models.info.Info()
                        .title("TURANT Emergency Alert API")
                        .version("1.0.0")
                        .description("Canonical EWS integration: POST /api/v1/pipeline/trigger-by-cap (application/xml) → pipeline → status/towers/report. See API_DOCUMENTATION.md")
                        .contact(new Contact().name("TURANT").url("https://github.com/gourav180731/TURANT")));
    }
}
