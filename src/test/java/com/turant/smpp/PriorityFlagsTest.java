package com.turant.smpp;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for PriorityFlags (Module 09).
 * 
 * Tests TURANT priority to SMPP priority_flag mapping.
 */
class PriorityFlagsTest {
    
    @Test
    void testPriorityToSmppFlagLow() {
        // Given: Low priority
        PriorityFlags.TurantPriority priority = PriorityFlags.TurantPriority.LOW;
        
        // When: Converting to SMPP flag
        byte flag = PriorityFlags.priorityToSmppFlag(priority);
        
        // Then: Should map to 0
        assertEquals(0, flag);
    }
    
    @Test
    void testPriorityToSmppFlagNormal() {
        // Given: Normal priority
        PriorityFlags.TurantPriority priority = PriorityFlags.TurantPriority.NORMAL;
        
        // When: Converting to SMPP flag
        byte flag = PriorityFlags.priorityToSmppFlag(priority);
        
        // Then: Should map to 1
        assertEquals(1, flag);
    }
    
    @Test
    void testPriorityToSmppFlagHigh() {
        // Given: High priority
        PriorityFlags.TurantPriority priority = PriorityFlags.TurantPriority.HIGH;
        
        // When: Converting to SMPP flag
        byte flag = PriorityFlags.priorityToSmppFlag(priority);
        
        // Then: Should map to 2
        assertEquals(2, flag);
    }
    
    @Test
    void testPriorityToSmppFlagCritical() {
        // Given: Critical priority
        PriorityFlags.TurantPriority priority = PriorityFlags.TurantPriority.CRITICAL;
        
        // When: Converting to SMPP flag
        byte flag = PriorityFlags.priorityToSmppFlag(priority);
        
        // Then: Should map to 3
        assertEquals(3, flag);
    }
    
    @Test
    void testPriorityToSmppFlagEarlyWarning() {
        // Given: Early warning priority
        PriorityFlags.TurantPriority priority = PriorityFlags.TurantPriority.EARLY_WARNING;
        
        // When: Converting to SMPP flag
        byte flag = PriorityFlags.priorityToSmppFlag(priority);
        
        // Then: Should map to 3 (highest)
        assertEquals(3, flag);
    }
    
    @Test
    void testPriorityToSmppFlagNull() {
        // Given: Null priority
        PriorityFlags.TurantPriority priority = null;
        
        // When/Then: Should throw IllegalArgumentException
        assertThrows(IllegalArgumentException.class, () -> {
            PriorityFlags.priorityToSmppFlag(priority);
        });
    }
    
    @Test
    void testEarlyWarningPriorityFlag() {
        // When: Getting early warning flag
        byte flag = PriorityFlags.earlyWarningPriorityFlag();
        
        // Then: Should always return 3 (highest)
        assertEquals(3, flag);
    }
    
    @Test
    void testSmsPriorityFlagWithEarlyWarning() {
        // Given: Early warning boolean
        boolean isEarlyWarning = true;
        
        // When: Getting SMS priority flag
        byte flag = PriorityFlags.smsPriorityFlag(isEarlyWarning);
        
        // Then: Should return 3
        assertEquals(3, flag);
    }
    
    @Test
    void testSmsPriorityFlagWithoutEarlyWarning() {
        // Given: Not early warning
        boolean isEarlyWarning = false;
        
        // When: Getting SMS priority flag
        byte flag = PriorityFlags.smsPriorityFlag(isEarlyWarning);
        
        // Then: Should return 0 (lowest)
        assertEquals(0, flag);
    }
    
    @Test
    void testIsValidPriorityFlagMinimum() {
        // Given: Minimum valid flag (0)
        byte flag = 0;
        
        // When: Validating
        boolean valid = PriorityFlags.isValidPriorityFlag(flag);
        
        // Then: Should be valid
        assertTrue(valid);
    }
    
    @Test
    void testIsValidPriorityFlagMaximum() {
        // Given: Maximum valid flag (3)
        byte flag = 3;
        
        // When: Validating
        boolean valid = PriorityFlags.isValidPriorityFlag(flag);
        
        // Then: Should be valid
        assertTrue(valid);
    }
    
    @Test
    void testIsValidPriorityFlagMiddle() {
        // Given: Middle valid flags (1, 2)
        
        // When/Then: Both should be valid
        assertTrue(PriorityFlags.isValidPriorityFlag((byte) 1));
        assertTrue(PriorityFlags.isValidPriorityFlag((byte) 2));
    }
    
    @Test
    void testIsValidPriorityFlagTooLow() {
        // Given: Flag below minimum
        byte flag = -1;
        
        // When: Validating
        boolean valid = PriorityFlags.isValidPriorityFlag(flag);
        
        // Then: Should be invalid
        assertFalse(valid);
    }
    
    @Test
    void testIsValidPriorityFlagTooHigh() {
        // Given: Flag above maximum
        byte flag = 4;
        
        // When: Validating
        boolean valid = PriorityFlags.isValidPriorityFlag(flag);
        
        // Then: Should be invalid
        assertFalse(valid);
    }
    
    @Test
    void testConstants() {
        // Then: Constants should have correct values
        assertEquals(0, PriorityFlags.SMPP_PRIORITY_FLAG_MIN);
        assertEquals(3, PriorityFlags.SMPP_PRIORITY_FLAG_MAX);
    }
    
    @Test
    void testEarlyWarningIsCritical() {
        // Given: Both early warning and critical priorities
        PriorityFlags.TurantPriority earlyWarning = PriorityFlags.TurantPriority.EARLY_WARNING;
        PriorityFlags.TurantPriority critical = PriorityFlags.TurantPriority.CRITICAL;
        
        // When: Converting both
        byte earlyWarningFlag = PriorityFlags.priorityToSmppFlag(earlyWarning);
        byte criticalFlag = PriorityFlags.priorityToSmppFlag(critical);
        
        // Then: Should have same SMPP flag (3)
        assertEquals(criticalFlag, earlyWarningFlag);
        assertEquals(3, earlyWarningFlag);
    }
    
    @Test
    void testConstructorThrowsException() {
        // When/Then: Should not be able to instantiate utility class
        assertThrows(Exception.class, () -> {
            // Use reflection to test private constructor
            java.lang.reflect.Constructor<PriorityFlags> constructor = 
                PriorityFlags.class.getDeclaredConstructor();
            constructor.setAccessible(true);
            try {
                constructor.newInstance();
            } catch (java.lang.reflect.InvocationTargetException e) {
                // Unwrap the actual exception
                throw e.getCause();
            }
        });
    }
    
    @Test
    void testAllPrioritiesHaveValidFlags() {
        // Given: All priority types
        PriorityFlags.TurantPriority[] priorities = PriorityFlags.TurantPriority.values();
        
        // When/Then: All should map to valid SMPP flags
        for (PriorityFlags.TurantPriority priority : priorities) {
            byte flag = PriorityFlags.priorityToSmppFlag(priority);
            assertTrue(PriorityFlags.isValidPriorityFlag(flag), 
                "Priority " + priority + " maps to invalid flag " + flag);
            assertTrue(flag >= 0 && flag <= 3, 
                "Priority " + priority + " flag " + flag + " out of range");
        }
    }
}
