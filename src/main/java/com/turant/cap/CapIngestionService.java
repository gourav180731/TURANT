package com.turant.cap;

import com.turant.types.cap.CapAlert;
import com.turant.types.cap.CapTiming;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * CAP ingestion service - business logic for processing CAP alerts.
 * Migrated from TypeScript Module 01 service.ts
 */
@Service
public class CapIngestionService {
    
    private static final Logger logger = LoggerFactory.getLogger(CapIngestionService.class);
    
    private final CapParser capParser;
    private final JdbcTemplate jdbcTemplate;
    private final String preferredLanguage;
    
    public CapIngestionService(
            CapParser capParser,
            JdbcTemplate jdbcTemplate,
            @Value("${cap.preferred-language:en-US}") String preferredLanguage) {
        this.capParser = capParser;
        this.jdbcTemplate = jdbcTemplate;
        this.preferredLanguage = preferredLanguage;
    }
    
    /**
     * Ingest a CAP XML alert - parse and store in database.
     *
     * @param capXml Raw CAP XML document
     * @return Parsed CAP alert (async)
     */
    public CompletableFuture<CapAlert> ingestCap(String capXml) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return ingestCapAlert(capXml);
            } catch (CapParseException e) {
                throw new RuntimeException("CAP parsing failed", e);
            }
        });
    }
    
    /**
     * Ingest a CAP XML alert - parse and store in database (synchronous).
     *
     * @param capXml Raw CAP XML document
     * @return Parsed CAP alert
     * @throws CapParseException if XML is invalid
     */
    @Transactional
    public CapAlert ingestCapAlert(String capXml) throws CapParseException {
        logger.info("Ingesting CAP alert");
        
        // Parse CAP XML
        CapAlert alert = capParser.parseCapXml(capXml, preferredLanguage);
        logger.info("Parsed CAP alert: {}", alert.identifier());
        
        // Store in database
        storeAlert(alert);
        
        logger.info("CAP alert ingested successfully: {}", alert.identifier());
        return alert;
    }
    
    /**
     * Store parsed CAP alert in the alerts table.
     */
    private void storeAlert(CapAlert alert) {
        String sql = """
            INSERT INTO alerts (
                cap_identifier,
                sender,
                sent,
                status,
                msg_type,
                scope,
                event,
                severity,
                urgency,
                certainty,
                expires,
                effective,
                onset,
                headline,
                description,
                instruction,
                raw_xml,
                received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (cap_identifier) DO UPDATE SET
                received_at = EXCLUDED.received_at,
                raw_xml = EXCLUDED.raw_xml
            """;
        
        CapTiming timing = capParser.parseCapTiming(alert.info());
        
        jdbcTemplate.update(
            sql,
            alert.identifier(),
            alert.sender(),
            alert.sent(),
            alert.status().name(),
            alert.msgType().name(),
            alert.scope().name(),
            alert.info().event(),
            alert.info().severity().name(),
            alert.info().urgency().name(),
            alert.info().certainty().name(),
            timing.expiresAt(),
            timing.effectiveAt(),
            timing.onsetAt(),
            alert.info().headline(),
            alert.info().description(),
            alert.info().instruction(),
            alert.rawXml(),
            Instant.now()
        );
        
        logger.debug("Stored alert in database: {}", alert.identifier());
    }
    
    /**
     * Get alert by ID from database.
     *
     * @param alertId Alert identifier
     * @return Optional containing the alert if found
     */
    public CompletableFuture<Optional<CapAlert>> getAlert(String alertId) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                String sql = "SELECT raw_xml FROM alerts WHERE cap_identifier = ?";
                
                return jdbcTemplate.query(
                    sql,
                    rs -> {
                        if (rs.next()) {
                            String rawXml = rs.getString("raw_xml");
                            try {
                                CapAlert alert = capParser.parseCapXml(rawXml, preferredLanguage);
                                return Optional.of(alert);
                            } catch (CapParseException e) {
                                logger.error("Failed to parse stored CAP XML for alert: " + alertId, e);
                                return Optional.<CapAlert>empty();
                            }
                        }
                        return Optional.<CapAlert>empty();
                    },
                    alertId
                );
            } catch (Exception e) {
                logger.error("Failed to fetch alert: " + alertId, e);
                return Optional.<CapAlert>empty();
            }
        });
    }
}
