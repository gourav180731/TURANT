package com.turant.smpp;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for ValidityPeriod (Module 08).
 * 
 * Tests SMPP validity_period encoding per SMPP 3.4 specification.
 * Format: YYMMDDhhmmsstnnp (16 characters)
 */
class ValidityPeriodTest {
    
    @Test
    void testAbsoluteValidityEncoding() {
        // Given: Specific timestamp
        // 2026-08-04T03:30:00Z
        Instant instant = Instant.parse("2026-08-04T03:30:00Z");
        
        // When: Encoding to SMPP format
        String validity = ValidityPeriod.toSmppValidityPeriod(instant);
        
        // Then: Should match SMPP 3.4 format
        // YYMMDDhhmmsstnnp
        // 2608040330000000
        assertEquals("2608040330000000", validity);
        assertEquals(16, validity.length());
        assertTrue(validity.endsWith("0"), "Absolute time should end with '0'");
    }
    
    @Test
    void testAbsoluteValidityWithSeconds() {
        // Given: Timestamp with seconds
        Instant instant = Instant.parse("2026-08-04T03:30:45Z");
        
        // When: Encoding with seconds preserved
        String validity = ValidityPeriod.toSmppValidityPeriod(instant, false);
        
        // Then: Should include seconds
        assertEquals("2608040330450000", validity);
        assertTrue(validity.contains("45"), "Should include seconds");
    }
    
    @Test
    void testAbsoluteValidityWithSecondsTruncated() {
        // Given: Timestamp with seconds
        Instant instant = Instant.parse("2026-08-04T03:30:45Z");
        
        // When: Encoding with seconds truncated (default)
        String validity = ValidityPeriod.toSmppValidityPeriod(instant, true);
        
        // Then: Seconds should be zero
        assertEquals("2608040330000000", validity);
        assertFalse(validity.contains("45"), "Seconds should be truncated to 00");
    }
    
    @Test
    void testValidityAtMidnight() {
        // Given: Midnight timestamp
        Instant instant = Instant.parse("2026-12-31T00:00:00Z");
        
        // When: Encoding
        String validity = ValidityPeriod.toSmppValidityPeriod(instant);
        
        // Then: Should encode midnight correctly
        assertEquals("2612310000000000", validity);
    }
    
    @Test
    void testValidityAtEndOfDay() {
        // Given: End of day timestamp
        Instant instant = Instant.parse("2026-12-31T23:59:59Z");
        
        // When: Encoding with seconds
        String validity = ValidityPeriod.toSmppValidityPeriod(instant, false);
        
        // Then: Should encode correctly
        assertEquals("2612312359590000", validity);
    }
    
    @Test
    void testValidityFormatStructure() {
        // Given: Any timestamp
        Instant instant = Instant.parse("2026-05-15T14:30:22Z");
        
        // When: Encoding
        String validity = ValidityPeriod.toSmppValidityPeriod(instant, false);
        
        // Then: Should have correct structure
        assertEquals(16, validity.length());
        
        // Extract components
        String yy = validity.substring(0, 2);
        String mm = validity.substring(2, 4);
        String dd = validity.substring(4, 6);
        String hh = validity.substring(6, 8);
        String min = validity.substring(8, 10);
        String ss = validity.substring(10, 12);
        String t = validity.substring(12, 13);
        String nn = validity.substring(13, 15);
        String p = validity.substring(15, 16);
        
        assertEquals("26", yy, "Year");
        assertEquals("05", mm, "Month");
        assertEquals("15", dd, "Day");
        assertEquals("14", hh, "Hour");
        assertEquals("30", min, "Minute");
        assertEquals("22", ss, "Second");
        assertEquals("0", t, "Tenths");
        assertEquals("00", nn, "UTC offset");
        assertEquals("0", p, "Absolute time indicator");
    }
    
    @Test
    void testRelativeValidity1Hour() {
        // Given: 1 hour in milliseconds
        long durationMs = 3600000L;
        
        // When: Encoding relative validity
        String validity = ValidityPeriod.toSmppRelativeValidity(durationMs);
        
        // Then: Should encode 1 hour
        // Format: YYMMDDhhmmsstnnp
        // 00 00 00 01 00 00 0 00 R (1 hour)
        assertEquals("000000010000000R", validity);
        assertEquals(16, validity.length());
        assertTrue(validity.endsWith("R"), "Relative time should end with 'R'");
    }
    
    @Test
    void testRelativeValidity30Minutes() {
        // Given: 30 minutes
        long durationMs = 30 * 60 * 1000L;
        
        // When: Encoding
        String validity = ValidityPeriod.toSmppRelativeValidity(durationMs);
        
        // Then: Should encode 30 minutes
        assertEquals("000000003000000R", validity);
    }
    
    @Test
    void testRelativeValidity1Day() {
        // Given: 1 day
        long durationMs = 24 * 60 * 60 * 1000L;
        
        // When: Encoding
        String validity = ValidityPeriod.toSmppRelativeValidity(durationMs);
        
        // Then: Should encode 1 day
        assertEquals("000001000000000R", validity);
    }
    
    @Test
    void testRelativeValidityComplex() {
        // Given: 1 day, 2 hours, 30 minutes, 45 seconds
        long durationMs = (1 * 24 * 60 * 60 + 2 * 60 * 60 + 30 * 60 + 45) * 1000L;
        
        // When: Encoding
        String validity = ValidityPeriod.toSmppRelativeValidity(durationMs);
        
        // Then: Should encode all components
        assertEquals("000001023045000R", validity);
    }
    
    @Test
    void testRelativeValidityZero() {
        // Given: Zero duration
        long durationMs = 0L;
        
        // When: Encoding
        String validity = ValidityPeriod.toSmppRelativeValidity(durationMs);
        
        // Then: Should encode zero
        assertEquals("000000000000000R", validity);
    }
    
    @Test
    void testRelativeValidityNegativeFails() {
        // Given: Negative duration
        long durationMs = -1000L;
        
        // When/Then: Should throw exception
        assertThrows(IllegalArgumentException.class, () -> {
            ValidityPeriod.toSmppRelativeValidity(durationMs);
        });
    }
    
    @Test
    void testQuarterHourOffsetUTC() {
        // Given: UTC (0 minutes offset)
        int offsetMinutes = 0;
        
        // When: Calculating quarter hours
        int qh = ValidityPeriod.smppQuarterHourOffset(offsetMinutes);
        
        // Then: Should be 0
        assertEquals(0, qh);
    }
    
    @Test
    void testQuarterHourOffsetIST() {
        // Given: IST (+5:30 = 330 minutes)
        int offsetMinutes = 330;
        
        // When: Calculating quarter hours
        int qh = ValidityPeriod.smppQuarterHourOffset(offsetMinutes);
        
        // Then: Should be 22 quarter hours (330/15 = 22)
        assertEquals(22, qh);
    }
    
    @Test
    void testQuarterHourOffsetNegative() {
        // Given: Negative offset (-120 minutes = -2 hours)
        int offsetMinutes = -120;
        
        // When/Then: Should throw for negative
        assertThrows(IllegalArgumentException.class, () -> {
            ValidityPeriod.smppQuarterHourOffset(offsetMinutes);
        });
    }
    
    @Test
    void testQuarterHourOffsetMax() {
        // Given: Maximum offset (48 quarter hours = 720 minutes = 12 hours)
        int offsetMinutes = 720;
        
        // When: Calculating
        int qh = ValidityPeriod.smppQuarterHourOffset(offsetMinutes);
        
        // Then: Should be 48
        assertEquals(48, qh);
    }
    
    @Test
    void testQuarterHourOffsetExceedsMax() {
        // Given: Offset exceeding max (750 minutes)
        int offsetMinutes = 750;
        
        // When/Then: Should throw
        assertThrows(IllegalArgumentException.class, () -> {
            ValidityPeriod.smppQuarterHourOffset(offsetMinutes);
        });
    }
}
