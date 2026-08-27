package com.turant.pipeline;

import com.turant.cap.CapIngestionService;
import com.turant.types.cap.CapAlert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.concurrent.CompletableFuture;

/**
 * REST API for triggering pipeline execution and checking status.
 * 
 * Consolidated controller for all pipeline operations.
 */
@RestController
@RequestMapping("/api/v1/pipeline")
public class PipelineTriggerController {
    
    private static final Logger logger = LoggerFactory.getLogger(PipelineTriggerController.class);
    
    private final AlertPipeline pipeline;
    private final CapIngestionService capService;
    private final PipelineStatusStore statusStore;
    
    public PipelineTriggerController(
            AlertPipeline pipeline, 
            CapIngestionService capService,
            PipelineStatusStore statusStore) {
        this.pipeline = pipeline;
        this.capService = capService;
        this.statusStore = statusStore;
        logger.info("PipelineTriggerController initialized successfully");
    }
    
    @PostMapping("/trigger")
    public CompletableFuture<ResponseEntity<?>> triggerPipeline(@RequestBody TriggerRequest request) {
        String capIdentifier = request.capIdentifier();
        String alertId = request.alertId() != null ? request.alertId() : capIdentifier;
        
        logger.info("Pipeline trigger: capIdentifier={}, alertId={}", capIdentifier, alertId);
        
        return capService.getAlert(alertId).thenCompose(alertOpt -> {
            if (alertOpt.isEmpty()) {
                return CompletableFuture.completedFuture(
                    ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .<Object>body(new ErrorResponse("Alert not found: " + alertId))
                );
            }
            
            CapAlert alert = alertOpt.get();
            AlertPipeline.RunPipelineInput input = new AlertPipeline.RunPipelineInput(
                alert, capIdentifier, alertId
            );
            
            return pipeline.runAlertPipeline(input).handle((status, err) -> {
                if (err != null) {
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                        .<Object>body(new ErrorResponse("Pipeline failed: " + err.getMessage()));
                }
                return ResponseEntity.<Object>ok(new TriggerResponse(
                    capIdentifier, alertId, "triggered", status.status(), status.stage()
                ));
            });
        });
    }
    
    @PostMapping(value = "/trigger-by-cap", consumes = "application/xml")
    public CompletableFuture<ResponseEntity<?>> triggerByCap(@RequestBody String capXml) {
        logger.info("Pipeline trigger with CAP XML, length={}", capXml.length());
        
        return capService.ingestCap(capXml).thenCompose(alert -> {
            String capIdentifier = alert.identifier();
            AlertPipeline.RunPipelineInput input = new AlertPipeline.RunPipelineInput(
                alert, capIdentifier, capIdentifier
            );
            
            return pipeline.runAlertPipeline(input).handle((status, err) -> {
                if (err != null) {
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                        .<Object>body(new ErrorResponse("Pipeline failed: " + err.getMessage()));
                }
                return ResponseEntity.<Object>ok(new TriggerResponse(
                    capIdentifier, capIdentifier, "triggered", status.status(), status.stage()
                ));
            });
        }).exceptionally(err -> 
            ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .<Object>body(new ErrorResponse("CAP parsing failed: " + err.getMessage()))
        );
    }
    
    @GetMapping("/{capIdentifier}/pipeline-status")
    public ResponseEntity<?> getPipelineStatus(@PathVariable String capIdentifier) {
        logger.info("Checking pipeline status for: {}", capIdentifier);
        
        if (statusStore == null) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(new ErrorResponse("Pipeline status store not available"));
        }
        
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ErrorResponse("No pipeline status found for: " + capIdentifier));
        }
        
        return ResponseEntity.ok(status);
    }
    
    record TriggerRequest(String capIdentifier, String alertId) {}
    record TriggerResponse(String capIdentifier, String alertId, String action, String status, String stage) {}
    record ErrorResponse(String error) {}
}
