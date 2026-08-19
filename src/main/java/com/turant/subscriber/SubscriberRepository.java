package com.turant.subscriber;

import com.turant.types.subscriber.Subscriber;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Subscriber repository contract for modules 03/04.
 * 
 * Provides access to subscriber data for matching against cell towers.
 * 
 * Migrated from TypeScript telecom/repositories/subscriber-repository.ts
 */
public interface SubscriberRepository {
    
    /**
     * Stable name for logs/audit, e.g. "telecom-sim:memory" | "telecom-sim:postgres"
     */
    String getName();
    
    /**
     * Total subscribers currently stored.
     */
    CompletableFuture<Long> count();
    
    /**
     * Subscribers currently attached to any of the given cell IDs.
     *
     * @param cellIds List of cell IDs to match
     * @param options Search options (limit)
     * @return List of subscriber rows
     */
    CompletableFuture<List<SubscriberRow>> findByCellIds(List<String> cellIds, FindByCellIdsOptions options);
    
    /**
     * Full records for a list of MSISDNs (lookup path).
     *
     * @param msisdns List of MSISDNs
     * @param options Search options
     * @return List of full subscriber records
     */
    CompletableFuture<List<Subscriber>> findByMsisdns(List<String> msisdns, FindByCellIdsOptions options);
    
    /**
     * The shape the matcher needs per matched cell.
     */
    record SubscriberRow(
        String imsi,
        String msisdn,
        String cellId,
        String towerId,
        String technology,
        String status,
        java.time.Instant lastSeen
    ) {}
    
    /**
     * Options for subscriber lookup.
     */
    class FindByCellIdsOptions {
        private Integer limit;
        
        public Integer getLimit() {
            return limit;
        }
        
        public FindByCellIdsOptions setLimit(Integer limit) {
            this.limit = limit;
            return this;
        }
        
        public static FindByCellIdsOptions defaults() {
            return new FindByCellIdsOptions();
        }
    }
}
