package com.turant.types.subscriber;

/**
 * Subscriber model.
 * 
 * The real subscriber database is provided by C-DOT (subscriber-to-tower /
 * subscriber-to-cell mapping). TURANT normalizes it into this shape and stores
 * it in the Redis prefetch layer (module 03) keyed by tower/cell id.
 */
public record Subscriber(
    String msisdn,
    String towerId,
    String locationAreaCode,
    String cellId
) {}
