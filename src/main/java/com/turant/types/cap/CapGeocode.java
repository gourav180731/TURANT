package com.turant.types.cap;

/**
 * A key/value pair from CAP <geocode>.
 */
public record CapGeocode(
    String valueName,
    String value
) {}
