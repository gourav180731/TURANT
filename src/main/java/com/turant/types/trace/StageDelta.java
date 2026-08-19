package com.turant.types.trace;

/**
 * Inter-stage timing delta.
 */
public record StageDelta(
    TraceStage from,
    TraceStage to,
    String label,
    long deltaMs
) {}
