package com.turant.dedup;

import com.turant.simulation.TestDataFixtures;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for MsisdnDeduplicator (Module 05).
 * 
 * Tests:
 * - Duplicate removal
 * - MSISDN normalization
 * - Edge cases (empty, single, all duplicates)
 */
class MsisdnDeduplicatorTest {
    
    private MsisdnDeduplicator deduplicator;
    
    @BeforeEach
    void setUp() {
        deduplicator = new MsisdnDeduplicator();
    }
    
    @Test
    void testDeduplicateRemovesDuplicates() {
        // Given: List with duplicates
        List<String> msisdns = TestDataFixtures.createMsisdnsWithDuplicates();
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "test-alert");
        
        // Then: Should have only unique values
        assertEquals(4, result.deduplicated().size(), "Should have 4 unique MSISDNs");
        assertEquals(6, result.originalCount(), "Original count should be 6");
        assertEquals(2, result.removedCount(), "Should have removed 2 duplicates");
        assertTrue(result.deduplicated().contains("+919000000001"));
        assertTrue(result.deduplicated().contains("+919000000002"));
        assertTrue(result.deduplicated().contains("+919000000003"));
        assertTrue(result.deduplicated().contains("+919000000004"));
    }
    
    @Test
    void testDeduplicateEmptyList() {
        // Given: Empty list
        List<String> msisdns = List.of();
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "test-alert");
        
        // Then: Should return empty result
        assertTrue(result.deduplicated().isEmpty());
        assertEquals(0, result.originalCount());
        assertEquals(0, result.removedCount());
    }
    
    @Test
    void testDeduplicateSingleElement() {
        // Given: Single MSISDN
        List<String> msisdns = List.of("+919000000001");
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "test-alert");
        
        // Then: Should return single element
        assertEquals(1, result.deduplicated().size());
        assertEquals(1, result.originalCount());
        assertEquals(0, result.removedCount());
        assertTrue(result.deduplicated().contains("+919000000001"));
    }
    
    @Test
    void testDeduplicateAllDuplicates() {
        // Given: All same MSISDN
        List<String> msisdns = List.of(
            "+919000000001",
            "+919000000001",
            "+919000000001"
        );
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "test-alert");
        
        // Then: Should return single unique value
        assertEquals(1, result.deduplicated().size());
        assertEquals(3, result.originalCount());
        assertEquals(2, result.removedCount());
        assertTrue(result.deduplicated().contains("+919000000001"));
    }
    
    @Test
    void testDeduplicateNoDuplicates() {
        // Given: No duplicates
        List<String> msisdns = TestDataFixtures.createSampleMsisdns(5);
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "test-alert");
        
        // Then: Should have all elements
        assertEquals(5, result.deduplicated().size());
        assertEquals(5, result.originalCount());
        assertEquals(0, result.removedCount());
    }
    
    @Test
    void testDeduplicatePreservesFormat() {
        // Given: Various MSISDN formats
        List<String> msisdns = List.of(
            "+919000000001",
            "+919000000001", // Duplicate
            "+919876543210"
        );
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(msisdns, "test-alert");
        
        // Then: Should preserve original format
        assertEquals(2, result.deduplicated().size());
        assertEquals(3, result.originalCount());
        assertEquals(1, result.removedCount());
        assertTrue(result.deduplicated().contains("+919000000001"));
        assertTrue(result.deduplicated().contains("+919876543210"));
        
        // Verify format is preserved (starts with +91)
        for (String msisdn : result.deduplicated()) {
            assertTrue(msisdn.startsWith("+91"));
            assertEquals(13, msisdn.length());
        }
    }
    
    @Test
    void testDeduplicateLargeSet() {
        // Given: Large set with 50% duplication rate
        List<String> msisdns = TestDataFixtures.createSampleMsisdns(100);
        List<String> withDuplicates = new java.util.ArrayList<>(msisdns);
        withDuplicates.addAll(msisdns); // Add all again (100% duplication)
        
        // When: Deduplicating
        MsisdnDeduplicator.DedupResult result = deduplicator.deduplicate(withDuplicates, "test-alert");
        
        // Then: Should remove all 100 duplicates
        assertEquals(100, result.deduplicated().size(), "Should remove all 100 duplicates");
        assertEquals(200, result.originalCount());
        assertEquals(100, result.removedCount());
    }
}
