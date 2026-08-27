package com.turant.cap;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.turant.types.cap.CapAlert;
import com.turant.types.cap.CapTiming;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * CAP ingestion service - business logic for processing CAP alerts.
 * Migrated from TypeScript Module 01 service.ts
 * 
 * SIMULATION MODE:
 * When no database is configured, jdbcTemplate will be null and alerts
 * will be stored in memory only (suitable for demos/testing).
 */
@Service
public class CapIngestionService {
    
    private static final Logger logger = LoggerFactory.getLogger(CapIngestionService.class);
    
    private static final ObjectMapper OBJECT_MAPPER =
        new ObjectMapper().registerModule(new JavaTimeModule());
    
    private final CapParser capParser;
    private final JdbcTemplate jdbcTemplate; // Can be null in simulation mode
    private final String preferredLanguage;
    
    public CapIngestionService(
            CapParser capParser,
            @Autowired(required = false) JdbcTemplate jdbcTemplate,
            @Value("${cap.preferred-language:en-US}") String preferredLanguage) {
        this.capParser = capParser;
        this.jdbcTemplate = jdbcTemplate;
        this.preferredLanguage = preferredLanguage;
        
        if (jdbcTemplate == null) {
            logger.warn("JdbcTemplate not available - alerts will not be persisted to database");
        }
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
     * If database is not configured, this is a no-op (simulation mode).
     */
    private void storeAlert(CapAlert alert) {
        if (jdbcTemplate == null) {
            logger.debug("Skipping alert storage (no database configured): capIdentifier={}", alert.identifier());
            return;
        }
        
        String sql = """
            INSERT INTO alerts (
                cap_identifier,
                sender,
                sent_at,
                status,
                msg_type,
                scope,
                severity,
                urgency,
                expires_at,
                effective_at,
                headline,
                description,
                instruction,
                raw_xml,
                payload,
                received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
            ON CONFLICT (cap_identifier, sender) DO UPDATE SET
                received_at = EXCLUDED.received_at,
                raw_xml = EXCLUDED.raw_xml,
                payload = EXCLUDED.payload
            """;
        
        CapTiming timing = capParser.parseCapTiming(alert.info());
        
        jdbcTemplate.update(
            sql,
            alert.identifier(),
            alert.sender(),
            toTimestamp(alert.sent()),
            alert.status().name(),
            alert.msgType().name(),
            alert.scope().name(),
            alert.info().severity().name(),
            alert.info().urgency().name(),
            toTimestamp(timing.expiresAt()),
            toTimestamp(timing.effectiveAt()),
            alert.info().headline(),
            alert.info().description(),
            alert.info().instruction(),
            alert.rawXml(),
            toPayloadJson(alert),
            toTimestamp(Instant.now())
        );
        
        logger.debug("Stored alert in database: {}", alert.identifier());
    }
    
    /** Serialize the parsed alert into the NOT NULL `payload` jsonb column. */
    private static String toPayloadJson(CapAlert alert) {
        try {
            return OBJECT_MAPPER.writeValueAsString(alert);
        } catch (JsonProcessingException e) {
            logger.warn("Failed to serialize CAP alert payload for {}; storing minimal payload", alert.identifier(), e);
            return "{\"cap_identifier\":\"" + escapeJson(alert.identifier()) + "\"}";
        }
    }
    
    private static String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
    
    /** Bind an Instant as a JDBC Timestamp (the pg driver cannot infer Instant). */
    private static Timestamp toTimestamp(Instant instant) {
        return instant != null ? Timestamp.from(instant) : null;
    }
    
    /** Bind an ISO-8601 instant string as a JDBC Timestamp. */
    private static Timestamp toTimestamp(String isoInstant) {
        return isoInstant == null ? null : Timestamp.from(Instant.parse(isoInstant));
    }
    
    /**
     * Get alert by ID from database.
     *
     * @param alertId Alert identifier
     * @return Optional containing the alert if found
     */
    public CompletableFuture<Optional<CapAlert>> getAlert(String alertId) {
        return CompletableFuture.supplyAsync(() -> {
            if (jdbcTemplate == null) {
                logger.warn("Cannot retrieve alert (no database configured): alertId={}", alertId);
                return Optional.<CapAlert>empty();
            }
            
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
