package com.turant.types.tower;

import java.util.List;

/**
 * Input zone handed to a TowerSource: one or more GeoJSON geometries.
 */
public record GeoZone(
    List<ZoneGeometry> geometries,
    Integer srid
) {
    public record ZoneGeometry(
        String type,
        List<List<List<Double>>> coordinates,
        ZoneCenter center,
        Double radiusMeters
    ) {}
    
    public record ZoneCenter(
        double lat,
        double lng
    ) {}
}
