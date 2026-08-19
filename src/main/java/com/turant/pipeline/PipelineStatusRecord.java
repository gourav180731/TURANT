package com.turant.pipeline;

/**
 * Pipeline status record for tracking alert processing progress.
 * 
 * Migrated from TypeScript src/pipeline/pipeline-status.ts
 */
public record PipelineStatusRecord(
    String capIdentifier,
    String status,              // "running", "halted", "completed"
    String stage,               // Current stage
    String haltedAt,            // Stage where pipeline halted (if halted)
    String reason,              // Halt reason (if halted)
    Integer towerCount,
    Integer matchedCount,
    Integer duplicatesRemoved,
    Integer expectedRecipients,
    Integer submittedCount,
    Integer acceptedCount,
    Boolean awaitingCredentials,
    Long updatedAtMs
) {}
