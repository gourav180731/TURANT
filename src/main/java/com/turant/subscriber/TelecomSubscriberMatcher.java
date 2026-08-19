package com.turant.subscriber;

import com.turant.types.tower.CellTower;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

/**
 * Telecom subscriber matcher - modules 03/04 drop-in.
 * 
 * Implements the pipeline's SubscriberMatcher contract against the simulated
 * subscriber repository. For every tower the cell-site resolver returned, it
 * fetches the subscribers currently attached to that cell (chunked, via the
 * repository) and returns their real MSISDNs.
 * 
 * Migrated from TypeScript telecom/matcher/telecom-subscriber-matcher.ts
 */
@Service
public class TelecomSubscriberMatcher implements SubscriberMatcher {
    
    private static final Logger logger = LoggerFactory.getLogger(TelecomSubscriberMatcher.class);
    
    private final SubscriberRepository repository;
    
    @Value("${tower.match-limit:100000}")
    private int towerMatchLimit;
    
    public TelecomSubscriberMatcher(SubscriberRepository repository) {
        this.repository = repository;
    }
    
    @Override
    public String getName() {
        return "telecom-sim";
    }
    
    @Override
    public CompletableFuture<List<SubscriberMatch>> matchSubscribers(
            List<CellTower> towers,
            MatchContext ctx) {
        
        long startTime = System.currentTimeMillis();
        
        // Extract unique cell IDs
        List<String> cellIds = towers.stream()
            .map(CellTower::cellId)
            .filter(Objects::nonNull)
            .distinct()
            .collect(Collectors.toList());
        
        logger.info("Matching subscribers: alertId={}, towers={}, uniqueCells={}", 
            ctx.alertId(), towers.size(), cellIds.size());
        
        // Fetch subscribers by cell IDs
        return repository.findByCellIds(
            cellIds, 
            new SubscriberRepository.FindByCellIdsOptions().setLimit(towerMatchLimit)
        ).thenApply(rows -> {
            // Group subscribers by cell ID
            Map<String, List<String>> byCellId = new HashMap<>();
            for (SubscriberRepository.SubscriberRow row : rows) {
                byCellId.computeIfAbsent(row.cellId(), k -> new ArrayList<>())
                    .add(row.msisdn());
            }
            
            // Create matches for each tower
            List<SubscriberMatch> matches = towers.stream()
                .map(tower -> new SubscriberMatch(
                    tower.id(),
                    byCellId.getOrDefault(tower.cellId(), Collections.emptyList())
                ))
                .collect(Collectors.toList());
            
            int totalMatched = matches.stream()
                .mapToInt(m -> m.msisdns().size())
                .sum();
            
            long elapsedMs = System.currentTimeMillis() - startTime;
            
            logger.info("Subscriber matching completed: alertId={}, capIdentifier={}, towers={}, matched={}, elapsedMs={}", 
                ctx.alertId(), ctx.capIdentifier(), towers.size(), totalMatched, elapsedMs);
            
            return matches;
        });
    }
}
