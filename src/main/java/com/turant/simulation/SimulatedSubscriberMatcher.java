package com.turant.simulation;

import com.turant.subscriber.SubscriberMatcher;
import com.turant.types.tower.CellTower;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * Simulated subscriber matcher for testing without real subscriber database.
 * 
 * Generates deterministic test data based on cell IDs.
 * Useful for:
 * - Integration testing
 * - Demo scenarios
 * - Load testing
 * - Development without real subscriber data
 * 
 * Enable with: simulation.mode=enabled
 */
@Component
@ConditionalOnProperty(name = "simulation.mode", havingValue = "enabled")
public class SimulatedSubscriberMatcher implements SubscriberMatcher {
    
    private static final Logger logger = LoggerFactory.getLogger(SimulatedSubscriberMatcher.class);
    
    // Configuration for simulation
    private static final int MIN_SUBSCRIBERS_PER_TOWER = 50;
    private static final int MAX_SUBSCRIBERS_PER_TOWER = 500;
    private static final int DUPLICATE_RATE_PERCENT = 5; // 5% duplicates
    
    @Override
    public String getName() {
        return "simulated";
    }
    
    @Override
    public CompletableFuture<List<SubscriberMatch>> matchSubscribers(
            List<CellTower> towers,
            MatchContext context) {
        
        return CompletableFuture.supplyAsync(() -> {
            logger.info("Simulating subscriber matching for {} towers", towers.size());
            
            List<SubscriberMatch> results = new ArrayList<>();
            Set<String> allMsisdns = new HashSet<>();
            int totalSubscribers = 0;
            
            for (CellTower tower : towers) {
                // Generate deterministic subscriber count based on cell ID
                int subscriberCount = generateSubscriberCount(tower.cellId());
                
                // Generate MSISDNs for this tower
                List<String> msisdns = generateMsisdns(tower.cellId(), subscriberCount);
                
                // Add to global set for duplicate detection
                allMsisdns.addAll(msisdns);
                totalSubscribers += subscriberCount;
                
                // Create result
                results.add(new SubscriberMatch(
                    tower.id(),
                    msisdns
                ));
            }
            
            logger.info("Simulation complete: {} towers, {} total subscribers, {} unique MSISDNs",
                towers.size(), totalSubscribers, allMsisdns.size());
            
            return results;
        });
    }
    
    /**
     * Generate a deterministic subscriber count for a cell.
     * Uses cell ID hash to ensure consistent results.
     */
    private int generateSubscriberCount(String cellId) {
        Random random = new Random(cellId.hashCode());
        return MIN_SUBSCRIBERS_PER_TOWER + 
               random.nextInt(MAX_SUBSCRIBERS_PER_TOWER - MIN_SUBSCRIBERS_PER_TOWER);
    }
    
    /**
     * Generate MSISDNs for a cell.
     * Format: +91XXXXXXXXXX (Indian mobile numbers)
     */
    private List<String> generateMsisdns(String cellId, int count) {
        List<String> msisdns = new ArrayList<>();
        Random random = new Random(cellId.hashCode());
        
        for (int i = 0; i < count; i++) {
            // Generate 10-digit number
            long number = 7000000000L + random.nextInt(1000000000);
            String msisdn = "+91" + number;
            msisdns.add(msisdn);
            
            // Add some duplicates to simulate real-world scenario
            if (random.nextInt(100) < DUPLICATE_RATE_PERCENT && i > 0) {
                // Duplicate a previous MSISDN
                int dupIndex = random.nextInt(msisdns.size() - 1);
                msisdns.add(msisdns.get(dupIndex));
            }
        }
        
        return msisdns;
    }
}
