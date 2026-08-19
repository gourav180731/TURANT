package com.turant.types.tower;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Cell tower / site model as consumed by TURANT's geo-targeting pipeline.
 * 
 * The physical source schema lives in the C-DOT tower database; TURANT maps it
 * into this normalized shape via configurable column names (TOWER_COL_*).
 */
public record CellTower(
    @JsonProperty("id") String id,
    @JsonProperty("cellId") String cellId,
    @JsonProperty("latitude") double latitude,
    @JsonProperty("longitude") double longitude,
    @JsonProperty("coverageRadiusM") Double coverageRadiusM,
    @JsonProperty("coverageGeoJson") Object coverageGeoJson
) {}
