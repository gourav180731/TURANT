package com.turant.cap;

import com.turant.types.cap.CapAlert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * CAP ingestion REST controller.
 * Endpoint: POST /api/v1/alerts/cap
 * 
 * Migrated from TypeScript Module 01 routes.ts
 */
@RestController
@RequestMapping("/api/v1/alerts")
public class CapController {
    
    private static final Logger logger = LoggerFactory.getLogger(CapController.class);
    
    private final CapIngestionService capIngestionService;
    private final com.turant.security.SecurityService securityService;
    private final com.turant.security.AuditService auditService;
    
    public CapController(CapIngestionService capIngestionService,
                         @org.springframework.beans.factory.annotation.Autowired(required = false) com.turant.security.SecurityService securityService,
                         @org.springframework.beans.factory.annotation.Autowired(required = false) com.turant.security.AuditService auditService) {
        this.capIngestionService = capIngestionService;
        this.securityService = securityService;
        this.auditService = auditService;
    }
    
    /**
     * POST /api/v1/alerts/cap
     * 
     * Ingest a CAP XML alert document.
     * 
     * Request body: Raw CAP XML (application/xml or text/xml)
     * Response: { capIdentifier: string, status: string, message: string }
     */
    @PostMapping(
        value = "/cap",
        consumes = { MediaType.APPLICATION_XML_VALUE, MediaType.TEXT_XML_VALUE, MediaType.TEXT_PLAIN_VALUE },
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<?> ingestCapAlert(@RequestBody String capXml, jakarta.servlet.http.HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, capXml, null);
            if (!sec.allowed()) {
                if (auditService != null) {
                    auditService.audit(new com.turant.security.AuditService.HttpContext(
                            (String) httpReq.getAttribute("turant.requestId"),
                            sec.clientId(),
                            (String) httpReq.getAttribute("turant.certSubject"),
                            httpReq.getRemoteAddr(),
                            httpReq.getRequestURI(),
                            httpReq.getMethod(),
                            null
                    ), com.turant.security.AuditService.AuditEvent.AUTHENTICATION_FAILURE, "DENIED", sec.message());
                }
                return ResponseEntity.status(sec.httpStatus()).body(Map.of(
                        "error", sec.code(),
                        "message", sec.message()
                ));
            }
        }
        try {
            logger.info("Received CAP alert ingestion request");
            
            CapAlert alert = capIngestionService.ingestCapAlert(capXml);
            
            return ResponseEntity.ok(Map.of(
                "capIdentifier", alert.identifier(),
                "status", "ingested",
                "message", "CAP alert ingested successfully"
            ));
            
        } catch (CapParseException e) {
            logger.warn("CAP parse error: {}", e.getMessage());
            return ResponseEntity
                .status(HttpStatus.BAD_REQUEST)
                .body(Map.of(
                    "error", "CapParseError",
                    "message", e.getMessage()
                ));
        } catch (Exception e) {
            logger.error("Error ingesting CAP alert", e);
            return ResponseEntity
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of(
                    "error", "InternalError",
                    "message", "Failed to ingest CAP alert: " + e.getMessage()
                ));
        }
    }
}
