package com.turant.pipeline;

import com.turant.types.tower.CellTower;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory pipeline status tracking.
 * 
 * Tracks the progress of each alert through the pipeline stages.
 * In production, this would be backed by Redis or a database.
 * 
 * Migrated from TypeScript src/pipeline/pipeline-status.ts
 */
@Component
public class PipelineStatusStore {
    
    private final Map<String, PipelineStatusRecord> statuses = new ConcurrentHashMap<>();
    private final Map<String, List<CellTower>> towers = new ConcurrentHashMap<>();
    
    /**
     * Update pipeline status.
     */
    public void update(PipelineStatusRecord record) {
        statuses.put(record.capIdentifier(), record);
    }
    
    /**
     * Get pipeline status for an alert.
     */
    public PipelineStatusRecord get(String capIdentifier) {
        return statuses.get(capIdentifier);
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
    }
}
