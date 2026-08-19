package com.turant.cellsite;

import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * TowerSource contract - requirement #2.
 * 
 * Any module needing "all cell towers whose coverage falls inside this alert zone"
 * talks to this interface.
 * 
 * Migrated from TypeScript Module 02 tower-source.ts
 */
public interface TowerSource {
    
    /**
     * Stable name for logs/audit, e.g. "postgis" | "http" | "memory"
     */
    String getName();
    
    /**
     * Find all towers whose coverage intersects the given zone.
     *
     * @param zone Alert geographic zone
     * @param options Search options (limit, timeout, tracing)
     * @return List of matching cell towers
     */
    CompletableFuture<List<CellTower>> findTowersInZone(GeoZone zone, FindTowersOptions options);
    
    /**
     * Options for tower search.
     */
    class FindTowersOptions {
        private Integer limit;
        private Long timeoutMs;
        private String traceKey;
        
        public Integer getLimit() {
            return limit;
        }
        
        public FindTowersOptions setLimit(Integer limit) {
            this.limit = limit;
            return this;
        }
        
        public Long getTimeoutMs() {
            return timeoutMs;
        }
        
        public FindTowersOptions setTimeoutMs(Long timeoutMs) {
            this.timeoutMs = timeoutMs;
            return this;
        }
        
        public String getTraceKey() {
            return traceKey;
        }
        
        public FindTowersOptions setTraceKey(String traceKey) {
            this.traceKey = traceKey;
            return this;
        }
        
        public static FindTowersOptions defaults() {
            return new FindTowersOptions();
        }
    }
}
