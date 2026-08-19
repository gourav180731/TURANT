package com.turant.types.cap;

import java.util.List;

/**
 * One CAP <area> element.
 * Preserves TypeScript interface exactly.
 */
public record CapArea(
    String areaDesc,
    List<List<CapCoordinate>> polygons,
    List<CircleDefinition> circles,
    List<CapGeometry> geometries,
    List<CapGeocode> geocodes
) {
    public record CircleDefinition(
        CapCoordinate center,
        double radiusMeters
    ) {}
}
