package com.turant.delivery;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Configurable delivery strategy - requirement #10.
 * 
 * Resolves DELIVERY_STRATEGY / DELIVERY_RETRY_MAX / DELIVERY_RETRY_INTERVAL_MS
 * from configuration into a retry plan consumed by the retry queue and submit path.
 * 
 * Migrated from TypeScript Module 10 delivery-policy.ts
 */
@Component
public class DeliveryPolicy {
    
    public enum DeliveryStrategy {
        SINGLE_ATTEMPT("single-attempt"),
        RETRY("retry");
        
        private final String value;
        
        DeliveryStrategy(String value) {
            this.value = value;
        }
        
        public String getValue() {
            return value;
        }
        
        public static DeliveryStrategy fromString(String value) {
            for (DeliveryStrategy strategy : values()) {
                if (strategy.value.equals(value)) {
                    return strategy;
                }
            }
            throw new IllegalArgumentException("Unknown delivery strategy: " + value);
        }
    }
    
    @Value("${delivery.strategy:single-attempt}")
    private String strategyStr;
    
    @Value("${delivery.retry-max:3}")
    private int retryMax;
    
    @Value("${delivery.retry-interval-ms:5000}")
    private long retryIntervalMs;
    
    public DeliveryStrategy getStrategy() {
        return DeliveryStrategy.fromString(strategyStr);
    }
    
    /**
     * Max retry rounds after the initial attempt (ignored in single-attempt).
     */
    public int getRetryMax() {
        return getStrategy() == DeliveryStrategy.RETRY ? retryMax : 0;
    }
    
    /**
     * Delay between retry rounds (ms).
     */
    public long getRetryIntervalMs() {
        return retryIntervalMs;
    }
    
    /**
     * True when the strategy will re-attempt failed messages at all.
     */
    public boolean willRetry() {
        return getStrategy() == DeliveryStrategy.RETRY && retryMax > 0;
    }
}
