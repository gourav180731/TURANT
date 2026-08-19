package com.turant.types.trace;

/**
 * Single timestamp recording for a trace stage.
 */
public record TracePoint(
    TraceStage stage,
    String label,
    long epochMs
) {}
