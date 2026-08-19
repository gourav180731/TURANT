package com.turant.dedup;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Duplicate elimination - requirement #5.
 * 
 * Order-preserving in-memory dedup over a list of MSISDNs using a Set, with a
 * removed-duplicate count for the audit trail.
 * 
 * Migrated from TypeScript Module 05 dedupe.ts
 */
@Service
public class MsisdnDeduplicator {
    
    private static final Logger logger = LoggerFactory.getLogger(MsisdnDeduplicator.class);
    
    /**
     * Deduplicate MSISDNs in memory. O(n) single pass; order-preserving; the
     * original spelling of each first occurrence is kept.
     *
     * @param msisdns Input MSISDN list
     * @param traceKey Optional CAP alert identifier for tracing
     * @return Deduplication result with stats
     */
    public DedupResult deduplicate(List<String> msisdns, String traceKey) {
        long startTime = System.currentTimeMillis();
        
        Set<String> seen = new HashSet<>();
        List<String> deduplicated = new ArrayList<>();
        int removed = 0;
        
        for (String msisdn : msisdns) {
            String normalized = normalizeMsisdn(msisdn);
            if (seen.contains(normalized)) {
                removed++;
                continue;
            }
            seen.add(normalized);
            deduplicated.add(msisdn);
        }
        
        long elapsedMs = System.currentTimeMillis() - startTime;
        
        logger.info("Dedup completed: originalCount={}, deduplicated={}, removed={}, elapsedMs={}", 
            msisdns.size(), deduplicated.size(), removed, elapsedMs);
        
        // TODO: Mark t2 on trace store when implemented
        // if (traceKey != null) {
        //     traceStore.setExpectedRecipients(traceKey, deduplicated.size());
        //     traceStore.mark(traceKey, "t2", "subscriber.match+dedup", System.currentTimeMillis());
        // }
        
        return new DedupResult(
            deduplicated,
            msisdns.size(),
            removed,
            elapsedMs
        );
    }
    
    /**
     * Normalize an MSISDN for duplicate detection (strip +, spaces, dashes).
     */
    public static String normalizeMsisdn(String msisdn) {
        return msisdn
            .replaceFirst("^\\+", "")
            .replaceAll("[\\s-]", "");
    }
    
    /**
     * Deduplication result.
     */
    public record DedupResult(
        List<String> deduplicated,
        int originalCount,
        int removedCount,
        long elapsedMs
    ) {}
}
