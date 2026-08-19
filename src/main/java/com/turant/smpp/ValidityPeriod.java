package com.turant.smpp;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;

/**
 * SMSC-side validity enforcement - requirement #8.
 * 
 * Converts a CAP expires Instant into the SMPP 3.4 validity_period field so
 * the SMSC itself will not deliver an expired alert.
 * 
 * SMPP 3.4 section 5.2.9 defines the time format:
 * 
 *   YY MM DD hh mm ss t nn p
 *   2  2  2  2  2  2  1  2  1   = 16 characters
 * 
 *   YY  - last two digits of the year
 *   MM  - month
 *   DD  - day
 *   hh  - hour (00-23)
 *   mm  - minute
 *   ss  - second
 *   t   - tenths of a second (0-9)
 *   nn  - difference in quarter hours between local time and UTC (00-48)
 *   p   - 'R' for Relative time, '0' for Absolute time
 * 
 * TURANT encodes absolute validity from the CAP expires timestamp in UTC
 * with nn = 00, which is the least ambiguous form for SMSCs.
 * 
 * Migrated from TypeScript Module 08 validity-period.ts
 */
public class ValidityPeriod {
    
    /**
     * Encode an absolute validity_period (16 chars, trailing '0') from an Instant.
     * 
     * Example: 2026-08-04T03:30:00Z renders as "2608040330000000"
     */
    public static String toSmppValidityPeriod(Instant instant) {
        return toSmppValidityPeriod(instant, true);
    }
    
    /**
     * Encode an absolute validity_period with optional seconds truncation.
     */
    public static String toSmppValidityPeriod(Instant instant, boolean truncateSeconds) {
        ZonedDateTime wallClock = instant.atZone(ZoneOffset.UTC);
        
        String yy = pad2(wallClock.getYear() % 100);
        String mm = pad2(wallClock.getMonthValue());
        String dd = pad2(wallClock.getDayOfMonth());
        String hh = pad2(wallClock.getHour());
        String min = pad2(wallClock.getMinute());
        String ss = truncateSeconds ? "00" : pad2(wallClock.getSecond());
        String t = "0"; // tenths of a second
        String nn = "00"; // UTC offset (always 00 for UTC)
        String p = "0"; // absolute time
        
        return yy + mm + dd + hh + min + ss + t + nn + p;
    }
    
    /**
     * Relative validity_period (16 chars, trailing 'R') for a duration from the
     * moment of submission, per SMPP 3.4.
     */
    public static String toSmppRelativeValidity(long durationMs) {
        if (durationMs < 0) {
            throw new IllegalArgumentException("durationMs must be >= 0");
        }
        
        long totalSeconds = durationMs / 1000;
        long days = totalSeconds / 86_400;
        long hours = (totalSeconds % 86_400) / 3600;
        long minutes = (totalSeconds % 3600) / 60;
        long seconds = totalSeconds % 60;
        
        return pad2(0) + pad2(0) + pad2(days) + pad2(hours) + pad2(minutes) + 
               pad2(seconds) + "0" + pad2(0) + "R";
    }
    
    /**
     * Quarter-hour difference (nn, 0-48) for a given UTC offset in minutes.
     */
    public static int smppQuarterHourOffset(int offsetMinutes) {
        int qh = Math.round(offsetMinutes / 15.0f);
        if (qh < 0 || qh > 48) {
            throw new IllegalArgumentException(
                String.format("SMPP nn field requires offset in 0..48 quarter hours; got %d", qh)
            );
        }
        return qh;
    }
    
    private static String pad2(long n) {
        return String.format("%02d", n);
    }
}
