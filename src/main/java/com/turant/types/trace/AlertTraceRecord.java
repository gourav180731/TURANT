package com.turant.types.trace;

import java.util.Map;

/**
 * Complete per-alert trace record with timestamps and delivery metrics.
 */
public record AlertTraceRecord(
    String capIdentifier,
    Map<TraceStage, TracePoint> points,
    int expectedRecipients,
    int deliveredCount,
    DeliveryPercentiles percentiles,
    long updatedAtMs
) {}
