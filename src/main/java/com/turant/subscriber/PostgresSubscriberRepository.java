package com.turant.subscriber;

import com.turant.types.subscriber.Subscriber;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

/**
 * PostgreSQL subscriber repository - the sim's 1K → 300M path.
 * 
 * Reads are parameterized and chunked by SUBSCRIBER_LOOKUP_CHUNK_SIZE.
 * Table + column names come from SUBSCRIBER_COL_* env vars, so pointing
 * this at the real C-DOT subscriber schema is a .env change only.
 * 
 * Migrated from TypeScript telecom/repositories/postgres-subscriber-repository.ts
 */
@Repository
public class PostgresSubscriberRepository implements SubscriberRepository {
    
    private static final Logger logger = LoggerFactory.getLogger(PostgresSubscriberRepository.class);
    
    private final JdbcTemplate jdbcTemplate;
    
    @Value("${subscriber.table:subscribers}")
    private String subscriberTable;
    
    @Value("${subscriber.column.imsi:imsi}")
    private String colImsi;
    
    @Value("${subscriber.column.msisdn:msisdn}")
    private String colMsisdn;
    
    @Value("${subscriber.column.cell-id:serving_cell_id}")
    private String colCellId;
    
    @Value("${subscriber.column.tower-id:tower_id}")
    private String colTowerId;
    
    @Value("${subscriber.column.technology:technology}")
    private String colTechnology;
    
    @Value("${subscriber.column.status:status}")
    private String colStatus;
    
    @Value("${subscriber.column.last-seen:last_seen}")
    private String colLastSeen;
    
    @Value("${subscriber.lookup-chunk-size:1000}")
    private int chunkSize;
    
    public PostgresSubscriberRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }
    
    @Override
    public String getName() {
        return "telecom-sim:postgres";
    }
    
    @Override
    public CompletableFuture<Long> count() {
        return CompletableFuture.supplyAsync(() -> {
            Long count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM " + subscriberTable,
                Long.class
            );
            return count != null ? count : 0L;
        });
    }
    
    @Override
    public CompletableFuture<List<SubscriberRow>> findByCellIds(
            List<String> cellIds, 
            FindByCellIdsOptions options) {
        
        return CompletableFuture.supplyAsync(() -> {
            List<SubscriberRow> result = new ArrayList<>();
            int limit = options.getLimit() != null ? options.getLimit() : Integer.MAX_VALUE;
            
            // Process in chunks to avoid huge IN clauses
            for (int i = 0; i < cellIds.size(); i += chunkSize) {
                if (result.size() >= limit) {
                    break;
                }
                
                int end = Math.min(i + chunkSize, cellIds.size());
                List<String> chunk = cellIds.subList(i, end);
                
                int remaining = limit - result.size();
                int chunkLimit = Math.min(remaining, chunkSize);
                
                String sql = buildFindByCellIdsSql(chunk, chunkLimit);
                Object[] params = chunk.toArray();
                
                List<SubscriberRow> chunkResult = jdbcTemplate.query(sql, params, this::mapSubscriberRow);
                result.addAll(chunkResult);
            }
            
            logger.info("Found {} subscribers for {} cell IDs", result.size(), cellIds.size());
            return result;
        });
    }
    
    @Override
    public CompletableFuture<List<Subscriber>> findByMsisdns(
            List<String> msisdns, 
            FindByCellIdsOptions options) {
        
        return CompletableFuture.supplyAsync(() -> {
            List<Subscriber> result = new ArrayList<>();
            int limit = options.getLimit() != null ? options.getLimit() : Integer.MAX_VALUE;
            
            for (int i = 0; i < msisdns.size(); i += chunkSize) {
                if (result.size() >= limit) {
                    break;
                }
                
                int end = Math.min(i + chunkSize, msisdns.size());
                List<String> chunk = msisdns.subList(i, end);
                
                int remaining = limit - result.size();
                int chunkLimit = Math.min(remaining, chunkSize);
                
                String sql = buildFindByMsisdnsSql(chunk, chunkLimit);
                Object[] params = chunk.toArray();
                
                List<Subscriber> chunkResult = jdbcTemplate.query(sql, params, this::mapSubscriber);
                result.addAll(chunkResult);
            }
            
            return result;
        });
    }
    
    /**
     * Build SQL for finding subscribers by cell IDs.
     */
    private String buildFindByCellIdsSql(List<String> cellIds, int limit) {
        String placeholders = cellIds.stream()
            .map(id -> "?")
            .collect(Collectors.joining(", "));
        
        return String.format("""
            SELECT %s AS imsi, %s AS msisdn, %s AS cell_id, 
                   %s AS tower_id, %s AS technology, %s AS status, %s AS last_seen
            FROM %s
            WHERE %s IN (%s)
            LIMIT %d
            """,
            colImsi, colMsisdn, colCellId,
            colTowerId, colTechnology, colStatus, colLastSeen,
            subscriberTable,
            colCellId, placeholders,
            limit
        );
    }
    
    /**
     * Build SQL for finding subscribers by MSISDNs.
     */
    private String buildFindByMsisdnsSql(List<String> msisdns, int limit) {
        String placeholders = msisdns.stream()
            .map(id -> "?")
            .collect(Collectors.joining(", "));
        
        return String.format("""
            SELECT *
            FROM %s
            WHERE %s IN (%s)
            LIMIT %d
            """,
            subscriberTable,
            colMsisdn, placeholders,
            limit
        );
    }
    
    /**
     * Map result set to SubscriberRow.
     */
    private SubscriberRow mapSubscriberRow(ResultSet rs, int rowNum) throws SQLException {
        String imsi = rs.getString("imsi");
        String msisdn = rs.getString("msisdn");
        String cellId = rs.getString("cell_id");
        String towerId = rs.getString("tower_id");
        String technology = rs.getString("technology");
        String status = rs.getString("status");
        
        Instant lastSeen = null;
        java.sql.Timestamp ts = rs.getTimestamp("last_seen");
        if (ts != null) {
            lastSeen = ts.toInstant();
        }
        
        return new SubscriberRow(imsi, msisdn, cellId, towerId, technology, status, lastSeen);
    }
    
    /**
     * Map result set to full Subscriber.
     */
    private Subscriber mapSubscriber(ResultSet rs, int rowNum) throws SQLException {
        String msisdn = rs.getString(colMsisdn);
        String towerId = rs.getString(colTowerId);
        String cellId = rs.getString(colCellId);
        
        // Extract LAC from cell ID if available (simplified)
        String locationAreaCode = null;
        
        return new Subscriber(msisdn, towerId, locationAreaCode, cellId);
    }
}
