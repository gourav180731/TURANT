package com.turant.cellsite;

import com.turant.types.tower.CellTower;

import java.util.List;

/**
 * Result of a tower-resolution query.
 *
 * Carries the matched towers PLUS the audit counters required to report the
 * REAL dedup behaviour (raw matches across all geometries, unique towers after
 * dedup, duplicates removed, and per-geometry counts). This makes the pipeline
 * status reflect the true database-derived numbers instead of being inferred.
 */
public record TowerResolutionResult(
        List<CellTower> towers,
        int rawTotal,
        int uniqueTotal,
        int duplicatesRemoved,
        List<Integer> perGeometryCounts
) {}
