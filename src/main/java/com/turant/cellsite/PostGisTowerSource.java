package com.turant.cellsite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.config.ConditionalOnDatabaseConfigured;
import com.turant.types.cap.CapGeometry;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * PostGIS tower source - requirement #2.
 * 
 * Identifies towers whose coverage falls inside the alert zone using real
 * geospatial queries against the C-DOT database:
 * 
 * - radius coverage: ST_Intersects(point, zone) — indexed point-in-polygon
 *                    OR ST_DWithin(geography) — coverage circle overlaps zone
 * - polygon coverage: ST_Intersects(coverage_geom, zone) — indexed on GIST
 * 
 * Migrated from TypeScript Module 02 postgis-tower-source.ts
 * 
 * PER-GEOMETRY QUERIES (for auditability):
 * Each CAP polygon/circle is queried INDIVIDUALLY. Per-polygon counts are logged.
 * Towers matching multiple polygons are deduplicated by tower.id for the final result.
 * 
 * CONDITIONAL BEAN:
 * Only created when DataSource is available (i.e., database is configured).
 * In simulation mode without database, SimulatedTowerSource is used instead.
 */
@Component
@ConditionalOnDatabaseConfigured
public class PostGisTowerSource implements TowerSource {
    
    private static final Logger logger = LoggerFactory.getLogger(PostGisTowerSource.class);
    private static final ObjectMapper objectMapper = new ObjectMapper();
    
    private final JdbcTemplate jdbcTemplate;
    private final String towerTable;
    private final String colId;
    private final String colCellId;
    private final String colLat;
    private final String colLng;
    private final String colRadius;
    private final String colGeom;
    /**
     * Tower POINT geometry column (e.g. {@code geom}). When present in the
     * tower table, radius queries use it with a GiST {@code &&} prefilter
     * instead of per-row {@code ST_MakePoint(lat,lng)} expressions (which no
     * index can serve). Auto-detected at startup; legacy lat/lng behaviour
     * is kept when the column is absent.
     */
    private final String colPointGeom;
    private final boolean hasPointGeom;
    /** Conservative metres-to-degrees divisor (minimum latitude-degree length: superset-safe bbox). */
    private static final double METRES_PER_DEGREE = 110574.0;
    private final String coverageModel;
    private final int srid;
    private final int defaultLimit;
    private final long timeBudgetMs;
    
    public PostGisTowerSource(
            JdbcTemplate jdbcTemplate,
            @Value("${tower.table:sim_cell_towers}") String towerTable,
            @Value("${tower.column.id:site_id}") String colId,
            @Value("${tower.column.cell-id:cell_id}") String colCellId,
            @Value("${tower.column.latitude:latitude}") String colLat,
            @Value("${tower.column.longitude:longitude}") String colLng,
            @Value("${tower.column.coverage-radius-m:coverage_radius_m}") String colRadius,
            @Value("${tower.column.coverage-geom:coverage_geom}") String colGeom,
            @Value("${tower.column.point-geom:geom}") String colPointGeom,
            @Value("${tower.coverage-model:radius}") String coverageModel,
            @Value("${tower.geom-srid:4326}") int srid,
            @Value("${tower.match-limit:10000}") int defaultLimit,
            @Value("${tower.match-time-budget-ms:30000}") long timeBudgetMs) {
        this.jdbcTemplate = jdbcTemplate;
        this.towerTable = towerTable;
        this.colId = colId;
        this.colCellId = colCellId;
        this.colLat = colLat;
        this.colLng = colLng;
        this.colRadius = colRadius;
        this.colGeom = colGeom;
        this.colPointGeom = colPointGeom;
        this.hasPointGeom = probePointGeomColumn(jdbcTemplate, towerTable, colPointGeom);
        this.coverageModel = coverageModel;
        this.srid = srid;
        this.defaultLimit = defaultLimit;
        this.timeBudgetMs = timeBudgetMs;
        
        logger.info("============================================================");
        logger.info("PostGisTowerSource INSTANTIATED (REAL PostGIS ADAPTER):");
        logger.info("  towerTable          = {}", towerTable);
        logger.info("  coverageModel       = {}", coverageModel);
        logger.info("  srid                = {}", srid);
        logger.info("  Column mapping:");
        logger.info("    id                -> {}", colId);
        logger.info("    cell_id           -> {}", colCellId);
        logger.info("    latitude          -> {}", colLat);
        logger.info("    longitude         -> {}", colLng);
        logger.info("    coverage_radius_m -> {}", colRadius);
        logger.info("    coverage_geom     -> {}", colGeom);
        logger.info("  defaultLimit        = {}", defaultLimit);
        logger.info("  timeBudgetMs        = {}", timeBudgetMs);
        logger.info("  SOURCE_NAME         = postgis");
        logger.info("  IS_SIMULATED        = false");
        logger.info("============================================================");
    }

    /**
     * Auto-detect the tower point-geometry column. Returns true only when the
     * configured column exists in the tower table; otherwise the adapter
     * keeps the legacy latitude/longitude expression path (with a warning,
     * since no GiST index can serve per-row expressions).
     */
    private static boolean probePointGeomColumn(
            JdbcTemplate jdbcTemplate, String towerTable, String colPointGeom) {
        if (colPointGeom == null || colPointGeom.isBlank()) {
            logger.warn("PostGisTowerSource: tower.column.point-geom is blank — "
                    + "radius queries will use per-row lat/lng expressions (no GiST pruning)");
            return false;
        }
        String schema = "public";
        String table = towerTable;
        int dot = towerTable.indexOf('.');
        if (dot > 0) {
            schema = towerTable.substring(0, dot);
            table = towerTable.substring(dot + 1);
        }
        try {
            Integer n = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.columns "
                            + "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                    Integer.class, schema, table, colPointGeom);
            if (n != null && n > 0) {
                logger.info("PostGisTowerSource: point-geometry column {}.{} found — "
                        + "radius queries will use the GiST &&-prefiltered path", towerTable, colPointGeom);
                return true;
            }
        } catch (Exception e) {
            logger.warn("PostGisTowerSource: point-geometry probe failed ({}), "
                    + "falling back to lat/lng expressions", e.getMessage());
        }
        logger.warn("PostGisTowerSource: column {}.{} NOT FOUND — radius queries "
                + "will use per-row lat/lng expressions (no GiST pruning)", towerTable, colPointGeom);
        return false;
    }

    /** Maximum coverage radius in the tower table (single cheap aggregate, cached per call). */
    private double maxCoverageRadiusM() {
        try {
            Double max = jdbcTemplate.queryForObject(
                    "SELECT MAX(" + colRadius + ") FROM " + towerTable, Double.class);
            if (max != null && max > 0) {
                return max;
            }
        } catch (Exception e) {
            logger.warn("PostGisTowerSource: MAX({}) probe failed ({}), using 5000m fallback",
                    colRadius, e.getMessage());
        }
        return 5000.0;
    }
    
    @Override
    public String getName() {
        return "postgis";
    }
    
    @Override
    public CompletableFuture<TowerResolutionResult> findTowersInZone(GeoZone zone, FindTowersOptions options) {
        return CompletableFuture.supplyAsync(() -> {
            int limit = options.getLimit() != null ? options.getLimit() : defaultLimit;

            List<Integer> perGeometryCounts = new ArrayList<>();

            try {
                // Use a single statement_timeout without explicit BEGIN/COMMIT transaction
                // holding a connection for 29 huge polygons (each 7000 vertices) caused
                // 60s orTimeout to fire (1787287355633013). Now we do one combined scan.
                jdbcTemplate.execute("SET LOCAL statement_timeout = " + timeBudgetMs);
                // Also set for this session as fallback when not in transaction
                try { jdbcTemplate.execute("SET statement_timeout = " + timeBudgetMs); } catch (Exception ignore) {}

                if (!"radius".equals(coverageModel)) {
                    Integer nonNullCount = jdbcTemplate.queryForObject(
                        "SELECT COUNT(*) FROM " + towerTable + " WHERE " + colGeom + " IS NOT NULL",
                        Integer.class
                    );

                    if (nonNullCount == null || nonNullCount == 0) {
                        throw new IllegalStateException(
                            "TOWER_COVERAGE_MODEL=" + coverageModel + " requires non-null " +
                            towerTable + "." + colGeom + ", but every row is NULL"
                        );
                    }
                }

                long overallStart = System.currentTimeMillis();
                int geomCount = zone.geometries().size();

                logger.info("REAL PostGIS tower query STARTED: geometries={}, towerTable={}, " +
                    "coverageModel={}, limit={}, timeBudgetMs={}", geomCount, towerTable, coverageModel, limit, timeBudgetMs);

                // Optimization for CAP 1787287355633013: 29 polygons each 6000+ vertices (3 MB)
                // Per-geometry sequential scan = 29 * Parallel Seq Scan (~300ms) = ~9s + geography OR = 60s timeout.
                // Combined single scan with ST_Collect + ST_Simplify = one Seq Scan (~400ms).
                // Use combined query when >5 geometries or any polygon >1000 points.
                boolean useCombined = geomCount > 5 || hasHugePolygon(zone, 1000);

                // Bounding-box expansion for the GiST &&-prefilter, derived once
                // per call from the table's own maximum coverage radius
                // (conservative superset — exact filtering stays per-tower).
                final double maxRadiusDeg = (hasPointGeom && "radius".equals(coverageModel))
                        ? maxCoverageRadiusM() / METRES_PER_DEGREE
                        : 0.0;
                if (hasPointGeom && "radius".equals(coverageModel)) {
                    logger.info("PostGIS indexed radius path: pointGeom={}.{}, maxRadiusDeg={}",
                            towerTable, colPointGeom, maxRadiusDeg);
                }

                if (useCombined) {
                    logger.info("Using COMBINED MultiPolygon query optimization (geomCount={}, hugePolygon=true)", geomCount);
                    long gStart = System.currentTimeMillis();
                    QuerySpec combined = buildCombinedGeometryQuery(zone.geometries(), limit, maxRadiusDeg);
                    if (logger.isDebugEnabled()) {
                        logger.debug("PostGIS combined SQL: {}", combined.sql);
                    }
                    List<CellTower> uniqueTowers = jdbcTemplate.query(
                        combined.sql,
                        combined.params.toArray(),
                        this::mapTower
                    );
                    long gElapsed = System.currentTimeMillis() - gStart;
                    logger.info("PostGIS COMBINED query matched towers={}, elapsedMs={}", uniqueTowers.size(), gElapsed);
                    // For combined path, perGeometryCounts is approximated as single bucket
                    perGeometryCounts.add(uniqueTowers.size());
                    for (int g = 1; g < geomCount; g++) perGeometryCounts.add(0);
                    long overallElapsed = System.currentTimeMillis() - overallStart;
                    logger.info("REAL PostGIS tower query COMPLETE (combined): uniqueTowers={}, elapsedMs={}",
                        uniqueTowers.size(), overallElapsed);
                    try {
                        Integer totalRowsInTable = jdbcTemplate.queryForObject(
                            "SELECT COUNT(*) FROM " + towerTable, Integer.class);
                        logger.info("Tower table '{}' total rows (for context): {}", towerTable, totalRowsInTable);
                    } catch (Exception e) {
                        logger.warn("Could not query tower table row count (non-fatal): {}", e.getMessage());
                    }
                    // reset statement_timeout
                    try { jdbcTemplate.execute("RESET statement_timeout"); } catch (Exception ignore) {}
                    return new TowerResolutionResult(uniqueTowers, uniqueTowers.size(), uniqueTowers.size(),
                        0, new ArrayList<>(perGeometryCounts));
                }

                // Small geomCount path: per-geometry queries run in PARALLEL on a
                // bounded pool (previous sequential loop multiplied latency by
                // the polygon count). Order of perGeometryCounts is preserved
                // via index-aligned futures. Pool is shut down in finally.
                List<List<CellTower>> perGeometryTowers = new ArrayList<>();
                int[] perGeometryCountArr = new int[geomCount];
                java.util.concurrent.ExecutorService geomPool =
                        java.util.concurrent.Executors.newFixedThreadPool(
                                Math.max(1, Math.min(geomCount, 4)),
                                r -> {
                                    Thread t = new Thread(r, "tower-geom-worker");
                                    t.setDaemon(true);
                                    return t;
                                });
                try {
                    List<java.util.concurrent.Future<List<CellTower>>> futures = new ArrayList<>();
                    for (int g = 0; g < geomCount; g++) {
                        final int gi = g;
                        final GeoZone.ZoneGeometry ggeom = zone.geometries().get(gi);
                        final QuerySpec querySpec =
                                buildSingleGeometryQuery(ggeom, limit, maxRadiusDeg);

                        logger.info("PostGIS geometry[{}] query: type={}, SQL params count={}",
                            gi, ggeom.type(), querySpec.params.size());
                        if (logger.isDebugEnabled()) {
                            logger.debug("PostGIS geometry[{}] SQL: {}", gi, querySpec.sql);
                        }

                        futures.add(geomPool.submit(() -> {
                            long gStart = System.currentTimeMillis();
                            List<CellTower> towersForGeom = jdbcTemplate.query(
                                querySpec.sql,
                                querySpec.params.toArray(),
                                this::mapTower
                            );
                            long gElapsed = System.currentTimeMillis() - gStart;
                            perGeometryCountArr[gi] = towersForGeom.size();
                            logger.info("PostGIS polygon/circle [{}] matched towers={}, elapsedMs={}, type={}",
                                gi, towersForGeom.size(), gElapsed, ggeom.type());
                            return towersForGeom;
                        }));
                    }
                    for (int g = 0; g < geomCount; g++) {
                        try {
                            List<CellTower> towersForGeom = futures.get(g).get();
                            perGeometryCounts.add(towersForGeom.size());
                            perGeometryTowers.add(towersForGeom);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            throw new RuntimeException(
                                "Tower geometry queries interrupted", ie);
                        } catch (java.util.concurrent.ExecutionException ee) {
                            throw new RuntimeException(
                                "Tower geometry query failed: "
                                        + String.valueOf(ee.getCause() == null
                                            ? ee : ee.getCause().getMessage()),
                                ee.getCause() == null ? ee : ee.getCause());
                        }
                    }
                } finally {
                    geomPool.shutdownNow();
                }

                // Deduplicate by tower.id
                Map<String, CellTower> uniqueById = new LinkedHashMap<>();
                int rawTotal = 0;
                for (List<CellTower> geomTowers : perGeometryTowers) {
                    rawTotal += geomTowers.size();
                    for (CellTower t : geomTowers) {
                        String key = t.id() != null ? t.id() :
                            (t.cellId() + ":" + t.latitude() + ":" + t.longitude());
                        uniqueById.put(key, t);
                    }
                }

                List<CellTower> uniqueTowers = new ArrayList<>(uniqueById.values());
                int duplicatesRemoved = rawTotal - uniqueTowers.size();

                long overallElapsed = System.currentTimeMillis() - overallStart;

                StringBuilder perGeomLog = new StringBuilder();
                for (int g = 0; g < geomCount; g++) {
                    if (g > 0) perGeomLog.append(", ");
                    perGeomLog.append("geom[").append(g).append("]=").append(perGeometryCountArr[g]);
                }

                logger.info("REAL PostGIS tower query COMPLETE: " +
                    "rawTotalFromAllGeometries={}, uniqueTowersAfterDedup={}, duplicatesRemoved={}, " +
                    "elapsedMs={}, perGeometryCounts: [{}]",
                    rawTotal, uniqueTowers.size(), duplicatesRemoved, overallElapsed, perGeomLog);

                // Log tower table metadata for auditability
                try {
                    Integer totalRowsInTable = jdbcTemplate.queryForObject(
                        "SELECT COUNT(*) FROM " + towerTable, Integer.class);
                    logger.info("Tower table '{}' total rows (for context): {}", towerTable, totalRowsInTable);
                } catch (Exception e) {
                    logger.warn("Could not query tower table row count (non-fatal): {}", e.getMessage());
                }

                try { jdbcTemplate.execute("RESET statement_timeout"); } catch (Exception ignore) {}

                return new TowerResolutionResult(uniqueTowers, rawTotal, uniqueTowers.size(),
                    duplicatesRemoved, new ArrayList<>(perGeometryCounts));

            } catch (Exception e) {
                try { jdbcTemplate.execute("RESET statement_timeout"); } catch (Exception ignore) {}
                logger.error("PostGIS tower query FAILED", e);
                throw new RuntimeException("PostGIS tower query failed: " + e.getMessage(), e);
            }
        });
    }

    private boolean hasHugePolygon(GeoZone zone, int threshold) {
        for (GeoZone.ZoneGeometry g : zone.geometries()) {
            if ("Polygon".equals(g.type()) && g.coordinates() != null && !g.coordinates().isEmpty()) {
                int pts = g.coordinates().get(0).size();
                if (pts > threshold) return true;
            }
        }
        return false;
    }
    
    /**
     * Combined query for 29 huge polygons (1787287355633013): one scan instead of 29.
     * Builds ST_Collect of all geometries, then ST_Simplify to reduce 7000-pts polygons
     * to ~500 pts (tolerance 0.001 ~100m) and ST_MakeValid to fix topology.
     */
    /**
     * GiST-assisted radius query over the tower POINT geometry column.
     *
     * <p>Two-stage filtering: {@code &&} bounding-box prefilter on
     * {@code idx_<table>_geom} (box = zone expanded by the table's maximum
     * coverage radius — a conservative superset), then the exact predicate
     * ({@code ST_Intersects} point-in-zone OR per-tower
     * {@code ST_DWithin} in metres). Replaces per-row
     * {@code ST_MakePoint(lat,lng)} expressions, which no index can serve.
     */
    private QuerySpec buildIndexedRadiusQuery(
            String zoneGeomExpr, List<Object> params, int limit, double maxRadiusDeg) {
        String selectCoverage = String.format("%s AS coverage_radius_m, NULL AS coverage_geom", colRadius);
        String sql = String.format("""
            WITH zone_geom AS (
                SELECT %s AS geom
            ),
            bounds AS (
                SELECT geom AS zone, geom::geography AS zone_geog,
                       ST_Expand(geom, %s) AS box FROM zone_geom
            )
            SELECT DISTINCT ON (t.%s)
                   %s AS id, %s AS cell_id, %s AS latitude, %s AS longitude,
                   %s
            FROM %s t, bounds
            WHERE bounds.zone IS NOT NULL
              AND t.%s && bounds.box
              AND (ST_Intersects(t.%s, bounds.zone)
                   OR ST_DWithin(t.%s::geography, bounds.zone_geog, %s))
            LIMIT %d
            """,
            zoneGeomExpr,
            Double.toString(maxRadiusDeg),
            colId,
            colId, colCellId, colLat, colLng,
            selectCoverage,
            towerTable,
            colPointGeom,
            colPointGeom,
            colPointGeom, colRadius,
            limit
        );
        return new QuerySpec(sql, params);
    }

    private QuerySpec buildCombinedGeometryQuery(
            List<GeoZone.ZoneGeometry> geoms, int limit, double maxRadiusDeg) {
        List<Object> params = new ArrayList<>();
        List<String> partExprs = new ArrayList<>();
        for (GeoZone.ZoneGeometry geom : geoms) {
            if ("Polygon".equals(geom.type())) {
                String geoJson = String.format(
                    "{\"type\":\"Polygon\",\"coordinates\":%s}",
                    serializeCoordinates(geom.coordinates())
                );
                params.add(geoJson);
                partExprs.add(String.format("ST_SetSRID(ST_GeomFromGeoJSON(?), %d)", srid));
            } else if ("Circle".equals(geom.type())) {
                GeoZone.ZoneCenter center = geom.center();
                params.add(center.lng());
                params.add(center.lat());
                params.add(geom.radiusMeters());
                partExprs.add(String.format(
                    "ST_Buffer(ST_SetSRID(ST_MakePoint(?, ?), %d)::geography, ?)::geometry",
                    srid));
            }
        }
        // ST_Collect is cheaper than ST_Union for point-in-polygon test; simplify huge vertices
        String collectExpr = "ST_Collect(ARRAY[" + String.join(", ", partExprs) + "]::geometry[])";
        String simplifiedCollect = String.format("ST_MakeValid(ST_Simplify(%s, 0.001))", collectExpr);
        // Also fallback to ST_UnaryUnion for overlapping districts deduplication if needed
        String zoneGeomExpr = simplifiedCollect;

        if (hasPointGeom) {
            return buildIndexedRadiusQuery(zoneGeomExpr, params, limit, maxRadiusDeg);
        }
        String pointExpr = String.format("ST_SetSRID(ST_MakePoint(%s, %s), %d)", colLng, colLat, srid);
        String coverageMatch = "radius".equals(coverageModel)
            ? String.format("ST_DWithin((%s)::geography, zone_geom.geom::geography, %s)", pointExpr, colRadius)
            : String.format("ST_Intersects(%s, zone_geom.geom)", colGeom);
        String selectCoverage = "radius".equals(coverageModel)
            ? String.format("%s AS coverage_radius_m, NULL AS coverage_geom", colRadius)
            : String.format("NULL AS coverage_radius_m, ST_AsGeoJSON(%s) AS coverage_geom", colGeom);
        String sql = String.format("""
            WITH zone_geom AS (
                SELECT %s AS geom
            )
            SELECT DISTINCT ON (t.%s) 
                   %s AS id, %s AS cell_id, %s AS latitude, %s AS longitude,
                   %s
            FROM %s t, zone_geom
            WHERE zone_geom.geom IS NOT NULL
              AND (ST_Intersects(%s, zone_geom.geom)
                   OR %s)
            LIMIT %d
            """,
            zoneGeomExpr,
            colId,
            colId, colCellId, colLat, colLng,
            selectCoverage,
            towerTable,
            pointExpr,
            coverageMatch,
            limit
        );
        return new QuerySpec(sql, params);
    }

    /**
     * Build a PostGIS spatial query for a SINGLE geometry.
     * This enables per-polygon/per-circle audit logging.
     */
    private QuerySpec buildSingleGeometryQuery(
            GeoZone.ZoneGeometry geom, int limit, double maxRadiusDeg) {
        List<Object> params = new ArrayList<>();
        String zoneGeomExpr;
        
        if ("Polygon".equals(geom.type())) {
            String geoJson = String.format(
                "{\"type\":\"Polygon\",\"coordinates\":%s}",
                serializeCoordinates(geom.coordinates())
            );
            params.add(geoJson);
            zoneGeomExpr = String.format("ST_SetSRID(ST_GeomFromGeoJSON(?), %d)", srid);
            
        } else if ("Circle".equals(geom.type())) {
            GeoZone.ZoneCenter center = geom.center();
            double radiusMeters = geom.radiusMeters();
            
            params.add(center.lng());
            params.add(center.lat());
            params.add(radiusMeters);
            zoneGeomExpr = String.format(
                "ST_Buffer(ST_SetSRID(ST_MakePoint(?, ?), %d)::geography, ?)::geometry",
                srid
            );
        } else {
            throw new IllegalArgumentException("Unknown geometry type: " + geom.type());
        }

        if (hasPointGeom && "radius".equals(coverageModel)) {
            return buildIndexedRadiusQuery(zoneGeomExpr, params, limit, maxRadiusDeg);
        }

        String pointExpr = String.format("ST_SetSRID(ST_MakePoint(%s, %s), %d)", colLng, colLat, srid);
        String coverageMatch = "radius".equals(coverageModel)
            ? String.format("ST_DWithin((%s)::geography, zone_geom.geom::geography, %s)", pointExpr, colRadius)
            : String.format("ST_Intersects(%s, zone_geom.geom)", colGeom);
        
        String selectCoverage = "radius".equals(coverageModel)
            ? String.format("%s AS coverage_radius_m, NULL AS coverage_geom", colRadius)
            : String.format("NULL AS coverage_radius_m, ST_AsGeoJSON(%s) AS coverage_geom", colGeom);
        
        String sql = String.format("""
            WITH zone_geom AS (
                SELECT %s AS geom
            )
            SELECT DISTINCT ON (t.%s) 
                   %s AS id, %s AS cell_id, %s AS latitude, %s AS longitude,
                   %s
            FROM %s t, zone_geom
            WHERE zone_geom.geom IS NOT NULL
              AND (ST_Intersects(%s, zone_geom.geom)
                   OR %s)
            LIMIT %d
            """,
            zoneGeomExpr,
            colId,
            colId, colCellId, colLat, colLng,
            selectCoverage,
            towerTable,
            pointExpr,
            coverageMatch,
            limit
        );
        
        return new QuerySpec(sql, params);
    }
    
    /**
     * Serialize polygon coordinates for GeoJSON.
     * Coordinates are already in [lng, lat] order from AlertPipeline.convertCapGeometry.
     */
    private String serializeCoordinates(List<List<List<Double>>> coordinates) {
        try {
            return objectMapper.writeValueAsString(coordinates);
        } catch (Exception e) {
            throw new RuntimeException("Failed to serialize coordinates", e);
        }
    }
    
    /**
     * Map database row to CellTower.
     */
    private CellTower mapTower(ResultSet rs, int rowNum) throws SQLException {
        String id = rs.getString("id");
        String cellId = rs.getString("cell_id");
        double latitude = rs.getDouble("latitude");
        double longitude = rs.getDouble("longitude");
        
        Double coverageRadiusM = null;
        Object radiusObj = rs.getObject("coverage_radius_m");
        if (radiusObj != null) {
            coverageRadiusM = ((Number) radiusObj).doubleValue();
        }
        
        JsonNode coverageGeoJson = null;
        String geoJsonStr = rs.getString("coverage_geom");
        if (geoJsonStr != null) {
            try {
                coverageGeoJson = objectMapper.readTree(geoJsonStr);
            } catch (Exception e) {
                logger.warn("Failed to parse coverage GeoJSON", e);
            }
        }
        
        return new CellTower(id, cellId, latitude, longitude, coverageRadiusM, coverageGeoJson);
    }
    
    /**
     * Query specification with SQL and parameters.
     */
    private static class QuerySpec {
        final String sql;
        final List<Object> params;
        
        QuerySpec(String sql, List<Object> params) {
            this.sql = sql;
            this.params = params;
        }
    }
}
