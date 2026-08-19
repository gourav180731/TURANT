package com.turant.cap;

import com.turant.pipeline.AlertPipeline;
import com.turant.pipeline.PipelineStatusRecord;
import com.turant.types.cap.CapAlert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * Manual alert controller - synthesize CAP XML from simple JSON payload.
 * Endpoint: POST /api/v1/alerts/manual
 * 
 * Migrated from TypeScript Module 01 manual-routes.ts
 * Updated to match frontend expectations and integrate with pipeline.
 */
@RestController
@RequestMapping("/api/v1/alerts")
public class ManualAlertController {
    
    private static final Logger logger = LoggerFactory.getLogger(ManualAlertController.class);
    
    private final CapIngestionService capIngestionService;
    private final AlertPipeline pipeline;
    
    public ManualAlertController(
            CapIngestionService capIngestionService,
            @Autowired(required = false) AlertPipeline pipeline) {
        this.capIngestionService = capIngestionService;
        this.pipeline = pipeline;
    }
    
    /**
     * POST /api/v1/alerts/manual
     * 
     * Create alert from simplified JSON payload and ingest as CAP.
     * Frontend payload format: {
     *   polygon: Array<[lat, lng]>,
     *   message: string,
     *   severity: "Extreme" | "Severe" | "Moderate" | "Minor",
     *   expiresInMinutes: number,
     *   hazardType?: string
     * }
     */
    @PostMapping(
        value = "/manual",
        consumes = MediaType.APPLICATION_JSON_VALUE,
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public CompletableFuture<ResponseEntity<Map<String, Object>>> createManualAlert(@RequestBody Map<String, Object> payload) {
        try {
            logger.info("Received manual alert creation request");
            
            // Extract frontend fields
            @SuppressWarnings("unchecked")
            List<List<Number>> polygon = (List<List<Number>>) payload.get("polygon");
            String message = (String) payload.get("message");
            String severity = (String) payload.get("severity");
            Integer expiresInMinutes = payload.containsKey("expiresInMinutes") 
                ? ((Number) payload.get("expiresInMinutes")).intValue() 
                : 60;
            String hazardType = (String) payload.get("hazardType");
            
            // Validate
            if (polygon == null || polygon.isEmpty()) {
                Map<String, Object> error = new HashMap<>();
                error.put("error", "ValidationError");
                error.put("message", "Polygon is required");
                return CompletableFuture.completedFuture(ResponseEntity.badRequest().body(error));
            }
            if (message == null || message.trim().isEmpty()) {
                Map<String, Object> error = new HashMap<>();
                error.put("error", "ValidationError");
                error.put("message", "Message is required");
                return CompletableFuture.completedFuture(ResponseEntity.badRequest().body(error));
            }
            
            // Build CAP-compliant structure
            String event = hazardType != null && !hazardType.trim().isEmpty() 
                ? hazardType.trim() 
                : "Emergency Alert";
            String headline = message.length() > 50 ? message.substring(0, 50) + "..." : message;
            
            // Create areas array
            List<Map<String, Object>> areas = new ArrayList<>();
            Map<String, Object> area = new HashMap<>();
            area.put("areaDesc", "Alert Zone");
            area.put("polygon", polygon);
            areas.add(area);
            
            // Generate CAP XML
            Instant expires = Instant.now().plus(expiresInMinutes, ChronoUnit.MINUTES);
            String capXml = synthesizeCapXml(
                event, 
                severity != null ? severity : "Severe",
                "Immediate",  // urgency
                "Observed",   // certainty
                headline,
                message,
                null,  // instruction
                areas,
                expiresInMinutes
            );
            
            // Ingest CAP alert
            CapAlert alert = capIngestionService.ingestCapAlert(capXml);
            String capIdentifier = alert.identifier();
            String alertId = capIdentifier;  // Use same for now
            
            // Trigger pipeline if available
            if (pipeline != null) {
                AlertPipeline.RunPipelineInput pipelineInput = 
                    new AlertPipeline.RunPipelineInput(alert, capIdentifier, alertId);
                
                return pipeline.runAlertPipeline(pipelineInput).thenApply(status -> {
                    // Build response matching frontend expectations
                    Map<String, Object> response = new HashMap<>();
                    response.put("alertId", alertId);
                    response.put("capIdentifier", capIdentifier);
                    response.put("expiresAt", expires.toString());
                    response.put("duplicate", false);
                    response.put("source", "manual");
                    response.put("sender", "turant@manual");
                    
                    // Pipeline reference
                    Map<String, Object> pipelineRef = new HashMap<>();
                    pipelineRef.put("status", status.status());
                    pipelineRef.put("stage", status.stage());
                    pipelineRef.put("statusUrl", "/api/v1/pipeline/status/" + capIdentifier);
                    response.put("pipeline", pipelineRef);
                    
                    return ResponseEntity.ok(response);
                }).exceptionally(err -> {
                    logger.error("Pipeline error", err);
                    Map<String, Object> error = new HashMap<>();
                    error.put("error", "PipelineError");
                    error.put("message", err.getMessage());
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
                });
            } else {
                // No pipeline - return basic response
                Map<String, Object> response = new HashMap<>();
                response.put("alertId", alertId);
                response.put("capIdentifier", capIdentifier);
                response.put("expiresAt", expires.toString());
                response.put("duplicate", false);
                response.put("source", "manual");
                response.put("sender", "turant@manual");
                
                Map<String, Object> pipelineRef = new HashMap<>();
                pipelineRef.put("status", "pending");
                pipelineRef.put("stage", "ingestion");
                pipelineRef.put("statusUrl", "/api/v1/pipeline/status/" + capIdentifier);
                response.put("pipeline", pipelineRef);
                
                return CompletableFuture.completedFuture(ResponseEntity.ok(response));
            }
            
        } catch (IllegalArgumentException e) {
            logger.warn("Manual alert validation error: {}", e.getMessage());
            Map<String, Object> error = new HashMap<>();
            error.put("error", "ValidationError");
            error.put("message", e.getMessage());
            return CompletableFuture.completedFuture(ResponseEntity.badRequest().body(error));
        } catch (Exception e) {
            logger.error("Error creating manual alert", e);
            Map<String, Object> error = new HashMap<>();
            error.put("error", "InternalError");
            error.put("message", e.getMessage());
            return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error));
        }
    }
    
    /**
     * Synthesize CAP 1.2 XML from simplified parameters.
     */
    private String synthesizeCapXml(
            String event, String severity, String urgency, String certainty,
            String headline, String description, String instruction,
            List<Map<String, Object>> areas, int expiresInMinutes) {
        
        String identifier = "manual-" + UUID.randomUUID();
        String sender = "turant@manual";
        Instant now = Instant.now();
        Instant expires = now.plus(expiresInMinutes, ChronoUnit.MINUTES);
        
        StringBuilder xml = new StringBuilder();
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        xml.append("<alert xmlns=\"urn:oasis:names:tc:emergency:cap:1.2\">\n");
        xml.append("  <identifier>").append(escapeXml(identifier)).append("</identifier>\n");
        xml.append("  <sender>").append(escapeXml(sender)).append("</sender>\n");
        xml.append("  <sent>").append(now).append("</sent>\n");
        xml.append("  <status>Actual</status>\n");
        xml.append("  <msgType>Alert</msgType>\n");
        xml.append("  <scope>Public</scope>\n");
        
        xml.append("  <info>\n");
        xml.append("    <language>en-US</language>\n");
        xml.append("    <category>Safety</category>\n");
        xml.append("    <event>").append(escapeXml(event)).append("</event>\n");
        xml.append("    <urgency>").append(escapeXml(urgency)).append("</urgency>\n");
        xml.append("    <severity>").append(escapeXml(severity)).append("</severity>\n");
        xml.append("    <certainty>").append(escapeXml(certainty)).append("</certainty>\n");
        xml.append("    <effective>").append(now).append("</effective>\n");
        xml.append("    <expires>").append(expires).append("</expires>\n");
        xml.append("    <senderName>TURANT Manual Alert</senderName>\n");
        xml.append("    <headline>").append(escapeXml(headline)).append("</headline>\n");
        xml.append("    <description>").append(escapeXml(description)).append("</description>\n");
        
        if (instruction != null && !instruction.isEmpty()) {
            xml.append("    <instruction>").append(escapeXml(instruction)).append("</instruction>\n");
        }
        
        // Add areas
        for (Map<String, Object> area : areas) {
            xml.append("    <area>\n");
            
            String areaDesc = (String) area.get("areaDesc");
            if (areaDesc != null) {
                xml.append("      <areaDesc>").append(escapeXml(areaDesc)).append("</areaDesc>\n");
            }
            
            // Polygon
            @SuppressWarnings("unchecked")
            List<List<Number>> polygon = (List<List<Number>>) area.get("polygon");
            if (polygon != null && !polygon.isEmpty()) {
                xml.append("      <polygon>");
                for (int i = 0; i < polygon.size(); i++) {
                    List<Number> coord = polygon.get(i);
                    if (i > 0) xml.append(" ");
                    xml.append(coord.get(0)).append(",").append(coord.get(1));
                }
                xml.append("</polygon>\n");
            }
            
            // Circle
            @SuppressWarnings("unchecked")
            Map<String, Object> circle = (Map<String, Object>) area.get("circle");
            if (circle != null) {
                @SuppressWarnings("unchecked")
                List<Number> center = (List<Number>) circle.get("center");
                Number radiusKm = (Number) circle.get("radiusKm");
                xml.append("      <circle>");
                xml.append(center.get(0)).append(",").append(center.get(1));
                xml.append(" ").append(radiusKm);
                xml.append("</circle>\n");
            }
            
            xml.append("    </area>\n");
        }
        
        xml.append("  </info>\n");
        xml.append("</alert>\n");
        
        return xml.toString();
    }
    
    private String getRequiredString(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (value == null) {
            throw new IllegalArgumentException("Missing required field: " + key);
        }
        return value.toString();
    }
    
    private String escapeXml(String text) {
        return text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&apos;");
    }
}
