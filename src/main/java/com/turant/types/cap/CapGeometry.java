package com.turant.types.cap;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

import java.util.List;

/**
 * CAP-origin geometry in CAP coordinate convention (lat,lng).
 * Discriminated union type from TypeScript.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = CapPolygonGeometry.class, name = "Polygon"),
    @JsonSubTypes.Type(value = CapCircleGeometry.class, name = "Circle")
})
public sealed interface CapGeometry permits CapPolygonGeometry, CapCircleGeometry {
    String getType();
    
    /**
     * Factory method for creating polygon geometry.
     */
    static CapGeometry polygon(List<List<CapCoordinate>> coordinates) {
        return new CapPolygonGeometry("Polygon", coordinates);
    }
    
    /**
     * Factory method for creating circle geometry.
     */
    static CapGeometry circle(CapCoordinate center, double radiusMeters) {
        return new CapCircleGeometry("Circle", center, radiusMeters);
    }
}

/**
 * Polygon geometry with coordinate rings.
 */
record CapPolygonGeometry(
    String type,
    List<List<CapCoordinate>> coordinates
) implements CapGeometry {
    public CapPolygonGeometry {
        if (!"Polygon".equals(type)) {
            throw new IllegalArgumentException("Type must be 'Polygon'");
        }
    }
    
    @Override
    public String getType() {
        return type;
    }
}

/**
 * Circle geometry with center and radius.
 */
record CapCircleGeometry(
    String type,
    CapCoordinate center,
    double radiusMeters
) implements CapGeometry {
    public CapCircleGeometry {
        if (!"Circle".equals(type)) {
            throw new IllegalArgumentException("Type must be 'Circle'");
        }
        if (radiusMeters <= 0) {
            throw new IllegalArgumentException("Radius must be positive");
        }
    }
    
    @Override
    public String getType() {
        return type;
    }
}
