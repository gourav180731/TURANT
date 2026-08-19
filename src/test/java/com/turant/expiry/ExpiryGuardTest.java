package com.turant.expiry;

import com.turant.simulation.TestDataFixtures;
import com.turant.types.cap.CapAlert;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for ExpiryGuard (Module 06).
 * 
 * Tests:
 * - Alert expiration checking
 * - Time budget validation
 * - Edge cases (null expiry, past expiry, future expiry)
 */
class ExpiryGuardTest {
    
    @Test
    void testAlertNotExpired() {
        // Given: Guard with expiry in 2 hours
        Instant futureExpiry = Instant.now().plus(2, ChronoUnit.HOURS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = futureExpiry;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Checking expiry
        boolean canSubmit = guard.canSubmit();
        
        // Then: Should allow submission
        assertTrue(canSubmit, "Should allow submission before expiry");
    }
    
    @Test
    void testAlertExpired() {
        // Given: Guard with past expiry
        Instant pastExpiry = Instant.now().minus(1, ChronoUnit.HOURS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = pastExpiry;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Checking expiry
        boolean canSubmit = guard.canSubmit();
        
        // Then: Should not allow submission
        assertFalse(canSubmit, "Should not allow submission after expiry");
    }
    
    @Test
    void testAlertExpiringNow() {
        // Given: Guard expiring within next minute
        Instant soonExpiry = Instant.now().plus(30, ChronoUnit.SECONDS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = soonExpiry;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Checking expiry
        ExpiryGuard.ExpiryStatus status = guard.status();
        
        // Then: Should still have time
        assertTrue(status.canSubmit());
        assertNotNull(status.remainingMs());
        assertTrue(status.remainingMs() > 0);
    }
    
    @Test
    void testAlertWithNullExpiry() {
        // Given: Guard with no expiry time
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = null;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Checking expiry
        boolean canSubmit = guard.canSubmit();
        
        // Then: Should allow submission (no expiry)
        assertTrue(canSubmit, "Alert with no expiry should allow submission");
    }
    
    @Test
    void testRemainingTimeForValidAlert() {
        // Given: Guard expiring in 2 hours
        Instant futureExpiry = Instant.now().plus(2, ChronoUnit.HOURS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = futureExpiry;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Getting remaining time
        Long remainingMs = guard.remainingMs();
        
        // Then: Should have approximately 2 hours remaining
        assertNotNull(remainingMs);
        assertTrue(remainingMs > 0, "Should have positive remaining time");
        assertTrue(remainingMs > 7000000, "Should have > 1.9 hours remaining"); // ~1.9 hours in ms
        assertTrue(remainingMs < 7300000, "Should have < 2.1 hours remaining"); // ~2.1 hours in ms
    }
    
    @Test
    void testRemainingTimeForExpiredAlert() {
        // Given: Expired guard
        Instant pastExpiry = Instant.now().minus(1, ChronoUnit.HOURS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = pastExpiry;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Getting remaining time
        Long remainingMs = guard.remainingMs();
        
        // Then: Should have negative or zero remaining time
        assertNotNull(remainingMs);
        assertTrue(remainingMs <= 0, "Expired alert should have <= 0 remaining time");
    }
    
    @Test
    void testLeadMargin() {
        // Given: Guard with 1 hour remaining but 2 hour lead margin
        Instant futureExpiry = Instant.now().plus(1, ChronoUnit.HOURS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = futureExpiry;
        options.leadMarginMs = 7200000L; // 2 hours
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Checking expiry with lead margin
        boolean canSubmit = guard.canSubmit();
        
        // Then: Should not allow submission (expired with margin)
        assertFalse(canSubmit, "Should respect lead margin");
    }
    
    @Test
    void testHaltDisabled() {
        // Given: Guard with halt disabled
        Instant pastExpiry = Instant.now().minus(1, ChronoUnit.HOURS);
        ExpiryGuard.ExpiryGuardOptions options = new ExpiryGuard.ExpiryGuardOptions();
        options.expiresAt = pastExpiry;
        options.haltEnabled = false;
        ExpiryGuard guard = new ExpiryGuard(options);
        
        // When: Checking expiry
        boolean canSubmit = guard.canSubmit();
        
        // Then: Should allow submission even if expired
        assertTrue(canSubmit, "Should allow submission when halt is disabled");
    }
    
}
