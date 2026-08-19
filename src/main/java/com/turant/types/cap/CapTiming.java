package com.turant.types.cap;

import java.time.Instant;

/**
 * Time-derived values computed at parse time.
 */
public record CapTiming(
    Instant expiresAt,
    Instant effectiveAt,
    Instant onsetAt
) {}
