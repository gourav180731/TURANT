package com.turant.types.cap;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A "lat,lng" vertex pair (decimal degrees, WGS84).
 * Preserves TypeScript interface exactly.
 */
public record CapCoordinate(
    @JsonProperty("lat") double lat,
    @JsonProperty("lng") double lng
) {
    public CapCoordinate {
        if (lat < -90 || lat > 90) {
            throw new IllegalArgumentException("Latitude must be between -90 and 90");
        }
        if (lng < -180 || lng > 180) {
            throw new IllegalArgumentException("Longitude must be between -180 and 180");
        }
    }
}
