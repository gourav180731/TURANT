package com.turant.types.trace;

/**
 * Percentile-based delivery times measured from t0.
 */
public record DeliveryPercentiles(
    long firstDeliveryMs,
    long p50Ms,
    long p90Ms,
    long p100Ms
) {}
