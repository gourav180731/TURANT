package com.turant.delivery;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for DeliveryPolicy (Module 10).
 * 
 * Tests delivery strategy configuration and retry behavior.
 */
@SpringBootTest
@ActiveProfiles("test")
class DeliveryPolicyTest {
    
    @Autowired
    private DeliveryPolicy policy;
    
    @Test
    void testDefaultStrategy() {
        // Then: Default should be single-attempt
        assertEquals(DeliveryPolicy.DeliveryStrategy.SINGLE_ATTEMPT, policy.getStrategy());
    }
    
    @Test
    void testSingleAttemptDoesNotRetry() {
        // Given: Default policy (single-attempt)
        
        // When: Checking retry behavior
        boolean willRetry = policy.willRetry();
        int retryMax = policy.getRetryMax();
        
        // Then: Should not retry
        assertFalse(willRetry);
        assertEquals(0, retryMax);
    }
    
    @Test
    void testRetryIntervalIsConfigured() {
        // Given: Policy with retry interval
        
        // When: Getting retry interval
        long intervalMs = policy.getRetryIntervalMs();
        
        // Then: Should return configured value (5000ms default)
        assertTrue(intervalMs > 0);
    }
    
    @Test
    void testStrategyFromString() {
        // Given: Valid strategy strings
        
        // When/Then: Should parse correctly
        assertEquals(
            DeliveryPolicy.DeliveryStrategy.SINGLE_ATTEMPT,
            DeliveryPolicy.DeliveryStrategy.fromString("single-attempt")
        );
        
        assertEquals(
            DeliveryPolicy.DeliveryStrategy.RETRY,
            DeliveryPolicy.DeliveryStrategy.fromString("retry")
        );
    }
    
    @Test
    void testInvalidStrategyThrows() {
        // Given: Invalid strategy string
        String invalid = "invalid-strategy";
        
        // When/Then: Should throw exception
        assertThrows(IllegalArgumentException.class, () -> {
            DeliveryPolicy.DeliveryStrategy.fromString(invalid);
        });
    }
    
    @Test
    void testStrategyEnumValues() {
        // Given: Strategy enum
        
        // When: Getting values
        DeliveryPolicy.DeliveryStrategy singleAttempt = DeliveryPolicy.DeliveryStrategy.SINGLE_ATTEMPT;
        DeliveryPolicy.DeliveryStrategy retry = DeliveryPolicy.DeliveryStrategy.RETRY;
        
        // Then: Should have correct string values
        assertEquals("single-attempt", singleAttempt.getValue());
        assertEquals("retry", retry.getValue());
    }
}

/**
 * Tests with retry strategy enabled.
 */
@SpringBootTest
@ActiveProfiles("test")
@TestPropertySource(properties = {
    "delivery.strategy=retry",
    "delivery.retry-max=3",
    "delivery.retry-interval-ms=2000"
})
class DeliveryPolicyRetryTest {
    
    @Autowired
    private DeliveryPolicy policy;
    
    @Test
    void testRetryStrategyEnabled() {
        // Then: Strategy should be retry
        assertEquals(DeliveryPolicy.DeliveryStrategy.RETRY, policy.getStrategy());
    }
    
    @Test
    void testRetryStrategyWillRetry() {
        // When: Checking retry behavior
        boolean willRetry = policy.willRetry();
        int retryMax = policy.getRetryMax();
        
        // Then: Should retry up to max
        assertTrue(willRetry);
        assertEquals(3, retryMax);
    }
    
    @Test
    void testRetryIntervalConfigured() {
        // When: Getting retry interval
        long intervalMs = policy.getRetryIntervalMs();
        
        // Then: Should match configured value
        assertEquals(2000, intervalMs);
    }
}

/**
 * Tests with retry strategy but zero max retries.
 */
@SpringBootTest
@ActiveProfiles("test")
@TestPropertySource(properties = {
    "delivery.strategy=retry",
    "delivery.retry-max=0"
})
class DeliveryPolicyZeroRetriesTest {
    
    @Autowired
    private DeliveryPolicy policy;
    
    @Test
    void testZeroRetriesDoesNotRetry() {
        // Given: Retry strategy with max=0
        
        // When: Checking retry behavior
        boolean willRetry = policy.willRetry();
        
        // Then: Should not retry even with retry strategy
        assertFalse(willRetry);
        assertEquals(0, policy.getRetryMax());
    }
}
