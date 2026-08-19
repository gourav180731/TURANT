package com.turant.parallel;

import java.util.List;

/**
 * Job/result contract for the parallel processing orchestrator.
 * 
 * expiresAtIso carries the real CAP expiry so workers reconstruct the same
 * real expiry guard - never a hardcoded "never expires" one.
 * 
 * Migrated from TypeScript Module 13 types.ts
 */
public record WorkerJob(
    String alertId,
    String capIdentifier,
    String content,
    /** Post-dedup MSISDNs for this worker's whole slice. */
    List<String> batch,
    /** CAP expires as ISO-8601 (or null when the alert declares none). */
    String expiresAtIso,
    String traceKey
) {}
