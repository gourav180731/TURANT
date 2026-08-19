package com.turant.cellsite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.types.cap.CapGeometry;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
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
 */
@Component
public class PostGisTowerSource implements TowerSource {
    
    private static final Logger logger = LoggerFactory.getLogger(PostGisTowerSource.class);
    private static final ObjectMapper objectMapper = new ObjectMapper();
    
    private final JdbcTemplate jdbcTemplate;
    
    @Value("${tower.table:cell_towers}")
    private String towerTable;
    
    @Value("${tower.column.id:id}")
    private String colId;
    
    @Value("${tower.column.cell-id:cell_id}")
    private String colCellId;
    
    @Value("${tower.column.latitude:latitude}")
    private String colLat;
    
    @Value("${tower.column.longitude:longitude}")
    private String colLng;
    
    @Value("${tower.column.coverage-radius-m:coverage_radius_m}")
    private String colRadius;
    
    @Value("${tower.column.coverage-geom:coverage_geom}")
    private String colGeom;
    
    @Value("${tower.coverage-model:radius}")
    private String coverageModel;
    
    @Value("${tower.geom-srid:4326}")
    private int srid;
    
    @Value("${tower.match-limit:10000}")
    private int defaultLimit;
    
    @Value("${tower.match-time-budget-ms:30000}")
    private long timeBudgetMs;
    
    public PostGisTowerSource(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }
    
    @Override
    public String getName() {
        return "postgis";
    }
    
    @Override
    public CompletableFuture<List<CellTower>> findTowersInZone(GeoZone zone, FindTowersOptions options) {
        return CompletableFuture.supplyAsync(() -> {
            int limit = options.getLimit() != null ? options.getLimit() : defaultLimit;
            
            try {
                // Set statement timeout for DB-side enforcement
                jdbcTemplate.execute("BEGIN");
                jdbcTemplate.execute("SET LOCAL statement_timeout = " + timeBudgetMs);
                
                // Guard for polygon coverage model
                if (!"radius".equals(coverageModel)) {
                    Integer nonNullCount = jdbcTemplate.queryForObject(
                        "SELECT COUNT(*) FROM " + towerTable + " WHERE " + colGeom + " IS NOT NULL",
                        Integer.class
                    );
                    
                    if (nonNullCount == null || nonNullCount == 0) {
                        jdbcTemplate.execute("ROLLBACK");
                        throw new IllegalStateException(
                            "TOWER_COVERAGE_MODEL=" + coverageModel + " requires non-null " + 
                            towerTable + "." + colGeom + ", but every row is NULL"
                        );
                    }
                }
                
                // Build and execute query
                QuerySpec querySpec = buildTowerZoneQuery(zone, limit);
                long startTime = System.currentTimeMillis();
                
                List<CellTower> towers = jdbcTemplate.query(
                    querySpec.sql,
                    querySpec.params.toArray(),
                    this::mapTower
                );
                
                jdbcTemplate.execute("COMMIT");
                
                long elapsedMs = System.currentTimeMillis() - startTime;
                logger.info("PostGIS tower query completed: {} towers, {}ms", towers.size(), elapsedMs);
                
                return towers;
                
            } catch (Exception e) {
                try {
                    jdbcTemplate.execute("ROLLBACK");
                } catch (Exception rollbackError) {
                    logger.warn("Error during rollback", rollbackError);
                }
                throw new RuntimeException("PostGIS tower query failed", e);
            }
        });
    }
    
    /**
     * Build PostGIS spatial query for tower matching.
     */
    private QuerySpec buildTowerZoneQuery(GeoZone zone, int limit) {
        List<String> zoneGeoms = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        
        // Build zone geometries from CAP polygons and circles
        for (GeoZone.ZoneGeometry geom : zone.geometries()) {
            if ("Polygon".equals(geom.type())) {
                // For polygons: ST_GeomFromGeoJSON
                String geoJson = String.format(
                    "{\"type\":\"Polygon\",\"coordinates\":%s}",
                    serializeCoordinates(geom.coordinates())
                );
                params.add(geoJson);
                zoneGeoms.add(String.format("ST_SetSRID(ST_GeomFromGeoJSON(?), %d)", srid));
            } else if ("Circle".equals(geom.type())) {
                // For circles: ST_Buffer with geography
                GeoZone.ZoneCenter center = geom.center();
                double radiusMeters = geom.radiusMeters();
                
                params.add(center.lng());
                params.add(center.lat());
                params.add(radiusMeters);
                zoneGeoms.add(String.format(
                    "ST_Buffer(ST_SetSRID(ST_MakePoint(?, ?), %d)::geography, ?)::geometry",
                    srid
                ));
            }
        }
        
        if (zoneGeoms.isEmpty()) {
            throw new IllegalArgumentException("GeoZone has no geometries");
        }
        
        // Build coverage match expression
        String pointExpr = String.format("ST_SetSRID(ST_MakePoint(%s, %s), %d)", colLng, colLat, srid);
        String coverageMatch = "radius".equals(coverageModel)
            ? String.format("ST_DWithin((%s)::geography, z.geom::geography, %s)", pointExpr, colRadius)
            : String.format("ST_Intersects(%s, zone_geom)", colGeom);
        
        String selectCoverage = "radius".equals(coverageModel)
            ? String.format("%s AS coverage_radius_m, NULL AS coverage_geom", colRadius)
            : String.format("NULL AS coverage_radius_m, ST_AsGeoJSON(%s) AS coverage_geom", colGeom);
        
        // Build complete query
        String sql = String.format("""
            WITH zone_geom AS (
                SELECT ST_Union(g.geom) AS geom
                FROM (VALUES %s) AS g(geom)
            )
            SELECT %s AS id, %s AS cell_id, %s AS latitude, %s AS longitude,
                   %s
            FROM %s t, zone_geom z
            WHERE z.geom IS NOT NULL
              AND (ST_Intersects(%s, z.geom)
                   OR %s)
            LIMIT %d
            """,
            String.join(", ", zoneGeoms.stream().map(g -> "(" + g + ")").toList()),
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
