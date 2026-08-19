package com.turant.subscriber;

import com.turant.types.tower.CellTower;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Subscriber matcher contract - modules 03/04.
 * 
 * Given cell towers from module 02, returns all subscribers attached to those towers.
 * 
 * Migrated from TypeScript pipeline/subscriber-matcher.ts
 */
public interface SubscriberMatcher {
    
    /**
     * Stable name for logs/audit.
     */
    String getName();
    
    /**
     * Match subscribers to cell towers.
     *
     * @param towers List of cell towers from module 02
     * @param context Alert context (for logging and tracing)
     * @return List of subscriber matches per tower
     */
    CompletableFuture<List<SubscriberMatch>> matchSubscribers(
        List<CellTower> towers,
        MatchContext context
    );
    
    /**
     * Match result: tower → list of MSISDNs.
     */
    record SubscriberMatch(
        String towerId,
        List<String> msisdns
    ) {}
    
    /**
     * Context for subscriber matching.
     */
    record MatchContext(
        String alertId,
        String capIdentifier
    ) {}
}
