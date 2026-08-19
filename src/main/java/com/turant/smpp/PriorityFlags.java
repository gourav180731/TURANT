package com.turant.smpp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Priority flagging - requirement #9.
 * 
 * Maps TURANT's internal priority concept to SMPP priority_flag values
 * (0 = lowest ... 3 = highest). Every early-warning alert resolves to
 * the highest value (3) so the SMSC queues it ahead of normal traffic.
 * 
 * This is an exported utility called by module 07's submit_sm construction.
 * 
 * Migrated from TypeScript Module 09 priority.ts
 */
public class PriorityFlags {
    
    private static final Logger logger = LoggerFactory.getLogger(PriorityFlags.class);
    
    public static final byte SMPP_PRIORITY_FLAG_MIN = 0;
    public static final byte SMPP_PRIORITY_FLAG_MAX = 3;
    
    /**
     * TURANT-internal priority taxonomy.
     */
    public enum TurantPriority {
        LOW(0),
        NORMAL(1),
        HIGH(2),
        CRITICAL(3),
        EARLY_WARNING(3);
        
        private final byte smppFlag;
        
        TurantPriority(int smppFlag) {
            this.smppFlag = (byte) smppFlag;
        }
        
        public byte getSmppFlag() {
            return smppFlag;
        }
    }
    
    /**
     * Resolve a TURANT priority to an SMPP priority_flag (0-3).
     */
    public static byte priorityToSmppFlag(TurantPriority priority) {
        if (priority == null) {
            throw new IllegalArgumentException("Priority cannot be null");
        }
        return priority.getSmppFlag();
    }
    
    /**
     * The flag for an early-warning SMS - always the maximum (3).
     * Early-warning is the only category TURANT disseminates, so this is
     * the value every submit_sm carries.
     */
    public static byte earlyWarningPriorityFlag() {
        return 3;
    }
    
    /**
     * Convenience: flag for a boolean early-warning marker (used by callers).
     */
    public static byte smsPriorityFlag(boolean isEarlyWarning) {
        if (isEarlyWarning) {
            return earlyWarningPriorityFlag();
        }
        logger.warn("smsPriorityFlag called with isEarlyWarning=false - TURANT only disseminates early warnings");
        return SMPP_PRIORITY_FLAG_MIN;
    }
    
    /**
     * Validate that a priority flag value is in valid SMPP range (0-3).
     */
    public static boolean isValidPriorityFlag(byte flag) {
        return flag >= SMPP_PRIORITY_FLAG_MIN && flag <= SMPP_PRIORITY_FLAG_MAX;
    }
    
    /**
     * Private constructor - utility class should not be instantiated.
     */
    private PriorityFlags() {
        throw new UnsupportedOperationException("Utility class");
    }
}
