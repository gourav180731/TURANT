package com.turant;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * TURANT — Targeted Urgent Rapid Alert Notification Tool
 * 
 * Main Spring Boot application entry point.
 * Migrated from TypeScript/Node.js to Java/Spring Boot.
 * 
 * This is a direct language/runtime migration preserving ALL existing functionality:
 * - 14 requirements (CAP ingestion through capacity testing)
 * - PostgreSQL/PostGIS spatial queries
 * - Redis caching
 * - SMPP 3.4 protocol
 * - Real-time DLR tracking
 * - Parallel worker execution
 * - Telecom simulation
 * - t0-t5 latency tracing
 */
@SpringBootApplication
@EnableAsync
@EnableScheduling
public class TurantApplication {

    public static void main(String[] args) {
        SpringApplication.run(TurantApplication.class, args);
    }
}
