package com.turant.expiry;

import com.turant.types.cap.CapAlert;
import com.turant.types.cap.CapTiming;
import com.turant.cap.CapParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.function.Supplier;

/**
 * Expiry-aware submission control - requirement #6.
 * 
 * Before submitting each batch to the SMSC, check the CAP alert's real
 * `expires` timestamp; the moment it is reached, halt all further submission.
 * 
 * The guard is seeded with the real CAP timing output of module 01
 * (`capTiming(alert).expiresAt`) - never a placeholder date.
 * 
 * NOT a Spring component - instances are created per-alert using factory methods.
 * 
 * Migrated from TypeScript Module 06 expiry-guard.ts
 */
public class ExpiryGuard {
    
    private static final Logger logger = LoggerFactory.getLogger(ExpiryGuard.class);
    
    private final Instant expiresAt;
    private final Supplier<Instant> clock;
    private final long leadMarginMs;
    private final boolean haltEnabled;
    
    /**
     * Create expiry guard with options.
     */
    public ExpiryGuard(ExpiryGuardOptions options) {
        this.expiresAt = options.expiresAt;
        this.clock = options.clock != null ? options.clock : Instant::now;
        this.leadMarginMs = options.leadMarginMs != null ? options.leadMarginMs : 0;
        this.haltEnabled = options.haltEnabled != null ? options.haltEnabled : true;
    }
    
    /**
     * Create expiry guard from CAP alert.
     */
    public static ExpiryGuard forAlert(CapAlert alert, CapParser capParser, ExpiryGuardOptions overrides) {
        CapTiming timing = capParser.parseCapTiming(alert.info());
        
        ExpiryGuardOptions options = new ExpiryGuardOptions();
        options.expiresAt = timing.expiresAt();
        
        if (overrides != null) {
            if (overrides.clock != null) options.clock = overrides.clock;
            if (overrides.leadMarginMs != null) options.leadMarginMs = overrides.leadMarginMs;
            if (overrides.haltEnabled != null) options.haltEnabled = overrides.haltEnabled;
        }
        
        return new ExpiryGuard(options);
    }
    
    /**
     * True when submission should proceed for the current instant.
     */
    public boolean canSubmit() {
        return status().canSubmit;
    }
    
    /**
     * Detailed status for logging / counting expired messages.
     */
    public ExpiryStatus status() {
        if (!haltEnabled) {
            return new ExpiryStatus(true, "halt-disabled", null, expiresAt);
        }
        
        if (expiresAt == null) {
            return new ExpiryStatus(true, "no-expiry", null, null);
        }
        
        Instant now = clock.get();
        long nowMs = now.toEpochMilli();
        long expiresMs = expiresAt.toEpochMilli();
        long remainingMs = expiresMs - nowMs - leadMarginMs;
        
        if (remainingMs <= 0) {
            return new ExpiryStatus(false, "expired", remainingMs, expiresAt);
        }
        
        return new ExpiryStatus(true, "ok", remainingMs, expiresAt);
    }
    
    /**
     * Milliseconds until the (margin-adjusted) expiry; null when no expiry/halt.
     */
    public Long remainingMs() {
        return status().remainingMs;
    }
    
    /**
     * Mark expiry trace when submission halts at expiry.
     */
    public void markExpiryTrace(String traceKey) {
        logger.warn("Submission halted due to expiry: traceKey={}", traceKey);
        
        // TODO: Mark t5 on trace store when implemented
        // traceStore.mark(traceKey, "t5", "alert.expiry", System.currentTimeMillis());
    }
    
    /**
     * One-shot check for the current instant, with default halt behavior.
     */
    public static boolean isExpiredNow(Instant expiresAt, long leadMarginMs) {
        ExpiryGuardOptions options = new ExpiryGuardOptions();
        options.expiresAt = expiresAt;
        options.leadMarginMs = leadMarginMs;
        
        return !new ExpiryGuard(options).canSubmit();
    }
    
    /**
     * Options for creating an expiry guard.
     */
    public static class ExpiryGuardOptions {
        public Instant expiresAt;
        public Supplier<Instant> clock;
        public Long leadMarginMs;
        public Boolean haltEnabled;
    }
    
    /**
     * Status of expiry check.
     */
    public record ExpiryStatus(
        boolean canSubmit,
        String reason,
        Long remainingMs,
        Instant expiresAt
    ) {}
}
