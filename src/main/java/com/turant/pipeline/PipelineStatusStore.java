package com.turant.pipeline;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.turant.types.tower.CellTower;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Pipeline status tracking with database persistence fallback.
 * 
 * Tracks the progress of each alert through pipeline stages in-memory,
 * and durably persists / recovers completed pipeline statuses via the
 * database (alert_reports and alerts/cap_replay).
 * 
 * Migrated from TypeScript src/pipeline/pipeline-status.ts
 */
@Component
public class PipelineStatusStore {
    
    private static final Logger log = LoggerFactory.getLogger(PipelineStatusStore.class);
    
    private final Map<String, PipelineStatusRecord> statuses = new ConcurrentHashMap<>();
    private final Map<String, List<CellTower>> towers = new ConcurrentHashMap<>();
    private final Map<String, Long> startedAt = new ConcurrentHashMap<>();
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    
    public PipelineStatusStore(@Autowired(required = false) JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.objectMapper = new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }
    
    /**
     * Record when the pipeline started for an alert (first-write wins so later
     * stage updates never overwrite the true start time).
     */
    public void markStarted(String capIdentifier, long timestampMs) {
        startedAt.putIfAbsent(capIdentifier, timestampMs);
    }
    
    /**
     * Real pipeline start time for an alert (epoch ms), or null if unknown.
     * Falls back to persisted status if in-memory timestamp was lost after restart.
     */
    public Long startedAtOf(String capIdentifier) {
        if (capIdentifier == null) return null;
        Long start = startedAt.get(capIdentifier);
        if (start != null) return start;
        PipelineStatusRecord rec = get(capIdentifier);
        return rec != null ? rec.updatedAtMs() : null;
    }
    
    /**
     * Update pipeline status (updates in-memory cache and persists completed status to DB).
     */
    public void update(PipelineStatusRecord record) {
        if (record == null || record.capIdentifier() == null) return;
        statuses.put(record.capIdentifier(), record);
        
        // Persist completed alert to alert_reports
        if (jdbc != null && "completed".equalsIgnoreCase(record.status())) {
            persistToDb(record);
        }
    }
    
    /**
     * Get pipeline status for an alert.
     * Checks in-memory cache first, then recovers from persistent storage (alert_reports
     * or alerts/cap_replay) if the application was restarted.
     */
    public PipelineStatusRecord get(String capIdentifier) {
        if (capIdentifier == null) return null;
        PipelineStatusRecord mem = statuses.get(capIdentifier);
        if (mem != null) {
            return mem;
        }
        
        if (jdbc == null) {
            return null;
        }
        
        // 1. Check alert_reports table
        try {
            String sql = "SELECT report_json, completed, tower_count, targeted_subscribers, sms_submitted, sms_accepted, processing_ended_at " +
                         "FROM alert_reports WHERE cap_identifier = ? ORDER BY processing_ended_at DESC NULLS LAST LIMIT 1";
            List<PipelineStatusRecord> list = jdbc.query(sql, (rs, rowNum) -> {
                String rptJson = rs.getString("report_json");
                if (rptJson != null && !rptJson.isBlank()) {
                    try {
                        PipelineStatusRecord parsed = objectMapper.readValue(rptJson, PipelineStatusRecord.class);
                        if (parsed != null && parsed.status() != null) {
                            return parsed;
                        }
                    } catch (Exception ignore) {}
                }
                boolean completed = rs.getBoolean("completed");
                long towerCount = rs.getLong("tower_count");
                long targeted = rs.getLong("targeted_subscribers");
                long submitted = rs.getLong("sms_submitted");
                long accepted = rs.getLong("sms_accepted");
                Timestamp endedAt = rs.getTimestamp("processing_ended_at");
                long endedMs = endedAt != null ? endedAt.getTime() : System.currentTimeMillis();
                return new PipelineStatusRecord(
                    capIdentifier,
                    completed ? "completed" : "halted",
                    completed ? "done" : "halted",
                    null,
                    null,
                    (int) towerCount,
                    (int) targeted,
                    0,
                    (int) targeted,
                    (int) submitted,
                    (int) accepted,
                    submitted == 0,
                    endedMs
                );
            }, capIdentifier);
            
            if (!list.isEmpty()) {
                PipelineStatusRecord record = list.get(0);
                statuses.put(capIdentifier, record);
                return record;
            }
        } catch (Exception e) {
            log.debug("Non-fatal: could not read alert_reports for {}: {}", capIdentifier, e.getMessage());
        }
        
        // 2. Check alerts + cap_replay (durable fallback for alerts processed before alert_reports was populated)
        try {
            String sql = "SELECT a.id, a.status, a.received_at, cr.first_seen " +
                         "FROM alerts a " +
                         "JOIN cap_replay cr ON cr.cap_identifier = a.cap_identifier " +
                         "WHERE a.cap_identifier = ? " +
                         "ORDER BY a.received_at DESC LIMIT 1";
            List<PipelineStatusRecord> fallbackList = jdbc.query(sql, (rs, rowNum) -> {
                Timestamp receivedAt = rs.getTimestamp("received_at");
                Timestamp firstSeen = rs.getTimestamp("first_seen");
                long ts = receivedAt != null ? receivedAt.getTime() : (firstSeen != null ? firstSeen.getTime() : System.currentTimeMillis());
                return new PipelineStatusRecord(
                    capIdentifier,
                    "completed",
                    "done",
                    null,
                    null,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    true,
                    ts
                );
            }, capIdentifier);
            
            if (!fallbackList.isEmpty()) {
                PipelineStatusRecord fallbackRecord = fallbackList.get(0);
                statuses.put(capIdentifier, fallbackRecord);
                // Also write to alert_reports so subsequent lookups hit step 1
                persistToDb(fallbackRecord);
                return fallbackRecord;
            }
        } catch (Exception e) {
            log.debug("Non-fatal: could not read alerts/cap_replay fallback for {}: {}", capIdentifier, e.getMessage());
        }
        
        return null;
    }
    
    private void persistToDb(PipelineStatusRecord record) {
        if (jdbc == null || record == null || record.capIdentifier() == null) return;
        try {
            String capId = record.capIdentifier();
            String alertIdSql = "SELECT id FROM alerts WHERE cap_identifier = ? ORDER BY received_at DESC LIMIT 1";
            List<UUID> alertIds = jdbc.query(alertIdSql, (rs, rowNum) -> (UUID) rs.getObject("id"), capId);
            if (alertIds.isEmpty()) {
                return;
            }
            UUID alertId = alertIds.get(0);

            Long startMs = startedAt.get(capId);
            Timestamp startedAtTs = startMs != null ? Timestamp.from(Instant.ofEpochMilli(startMs)) 
                : (record.updatedAtMs() != null ? Timestamp.from(Instant.ofEpochMilli(record.updatedAtMs())) : Timestamp.from(Instant.now()));
            Timestamp endedAtTs = record.updatedAtMs() != null ? Timestamp.from(Instant.ofEpochMilli(record.updatedAtMs())) : Timestamp.from(Instant.now());

            boolean completed = "completed".equalsIgnoreCase(record.status());
            int towerCount = record.towerCount() != null ? record.towerCount() : 0;
            int targetedSubs = record.expectedRecipients() != null ? record.expectedRecipients() 
                : (record.matchedCount() != null ? record.matchedCount() : 0);
            int submitted = record.submittedCount() != null ? record.submittedCount() : 0;
            int accepted = record.acceptedCount() != null ? record.acceptedCount() : 0;

            String reportJson = objectMapper.writeValueAsString(record);

            boolean isH2 = isH2Database();
            String upsertSql = isH2 ? """
                MERGE INTO alert_reports (
                    alert_id, cap_identifier, processing_started_at, processing_ended_at,
                    targeted_subscribers, sms_submitted, sms_accepted, delivered, failed,
                    expired, successful_push, tower_count, completed, report_json
                ) KEY(alert_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, CAST(? AS VARCHAR))
            """ : """
                INSERT INTO alert_reports (
                    alert_id, cap_identifier, processing_started_at, processing_ended_at,
                    targeted_subscribers, sms_submitted, sms_accepted, delivered, failed,
                    expired, successful_push, tower_count, completed, report_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, CAST(? AS JSONB))
                ON CONFLICT (alert_id) DO UPDATE SET
                    processing_ended_at = EXCLUDED.processing_ended_at,
                    targeted_subscribers = EXCLUDED.targeted_subscribers,
                    sms_submitted = EXCLUDED.sms_submitted,
                    sms_accepted = EXCLUDED.sms_accepted,
                    tower_count = EXCLUDED.tower_count,
                    completed = EXCLUDED.completed,
                    report_json = EXCLUDED.report_json
            """;

            jdbc.update(upsertSql, alertId, capId, startedAtTs, endedAtTs, targetedSubs, submitted, accepted, submitted, towerCount, completed, reportJson);
            log.debug("Persisted pipeline status to alert_reports for alertId={}, capId={}", alertId, capId);
        } catch (Exception e) {
            log.debug("Non-fatal: could not persist alert_report for {}: {}", record.capIdentifier(), e.getMessage());
        }
    }
    
    private boolean isH2Database() {
        if (jdbc == null) return false;
        try {
            var ds = jdbc.getDataSource();
            if (ds == null) return false;
            try (var conn = ds.getConnection()) {
                String name = conn.getMetaData().getDatabaseProductName();
                return name != null && name.toLowerCase().contains("h2");
            }
        } catch (Exception ignore) {
            return false;
        }
    }
    
    /**
     * Store matched towers for an alert.
     */
    public void setTowers(String capIdentifier, List<CellTower> towerList) {
        towers.put(capIdentifier, towerList);
    }
    
    /**
     * Get matched towers for an alert.
     */
    public List<CellTower> getTowers(String capIdentifier) {
        return towers.get(capIdentifier);
    }
    
    /**
     * Remove pipeline data for an alert.
     */
    public void remove(String capIdentifier) {
        statuses.remove(capIdentifier);
        towers.remove(capIdentifier);
        startedAt.remove(capIdentifier);
    }
}

