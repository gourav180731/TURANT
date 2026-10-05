package com.turant.cellsite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.types.tower.GeoZone;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;

import java.sql.Driver;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tower-resolution SLA: 11 Delhi-district polygons (detailed ~1.4k-vertex
 * boundaries derived live from the tower distribution itself, so the test
 * can never drift from the dataset) must resolve in under 5 seconds.
 *
 * <p>Exercises the production {@link PostGisTowerSource} path: combined
 * ST_Collect + ST_Simplify zone, GiST {@code &&}-prefiltered radius match.
 * Gated on {@code TURANT_REALDB_TESTS=1}. Read-only.
 */
class TowerResolutionBenchmarkTest {

    private static JdbcTemplate jdbc;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @BeforeAll
    static void init() {
        boolean enabled = "1".equals(System.getProperty("TURANT_REALDB_TESTS",
                System.getenv("TURANT_REALDB_TESTS") == null ? ""
                        : System.getenv("TURANT_REALDB_TESTS")));
        Assumptions.assumeTrue(enabled, "Requires TURANT_REALDB_TESTS=1");
        try {
            @SuppressWarnings("unchecked")
            Class<? extends Driver> driver =
                    (Class<? extends Driver>) Class.forName("org.postgresql.Driver");
            SimpleDriverDataSource ds = new SimpleDriverDataSource();
            ds.setDriverClass(driver);
            ds.setUrl("jdbc:postgresql://localhost:5432/turant");
            ds.setUsername("turant");
            String pw = System.getenv("TURANT_TEST_PASSWORD");
            ds.setPassword(pw != null ? pw : "turant_dev_password");
            jdbc = new JdbcTemplate(ds);
            Assumptions.assumeTrue(Integer.valueOf(1).equals(
                    jdbc.queryForObject("SELECT 1", Integer.class)), "turant DB unreachable");
        } catch (Exception e) {
            Assumptions.abort("turant DB unreachable: " + e.getMessage());
        }
    }

    /** District boundary rings (GeoJSON [lng,lat]) straight from the tower distribution. */
    private List<GeoZone.ZoneGeometry> loadDistrictPolygons() throws Exception {
        List<String> geoJsons = jdbc.query(
                "SELECT ST_AsGeoJSON(ST_Segmentize("
                        + "ST_ConcaveHull(ST_Collect(geom), 0.85)::geography, 200)::geometry) "
                        + "FROM sim_cell_towers WHERE state = 'Delhi' GROUP BY district ORDER BY district",
                (rs, i) -> rs.getString(1));
        List<GeoZone.ZoneGeometry> out = new ArrayList<>();
        for (String gj : geoJsons) {
            JsonNode coords = MAPPER.readTree(gj).get("coordinates");
            List<List<List<Double>>> rings = new ArrayList<>();
            for (JsonNode ring : coords) {
                List<List<Double>> pts = new ArrayList<>();
                for (JsonNode p : ring) {
                    pts.add(List.of(p.get(0).asDouble(), p.get(1).asDouble()));
                }
                rings.add(pts);
            }
            out.add(new GeoZone.ZoneGeometry("Polygon", rings, null, null));
        }
        return out;
    }

    @Test
    void elevenDistrictResolutionUnder5Seconds() throws Exception {
        List<GeoZone.ZoneGeometry> polygons = loadDistrictPolygons();
        System.out.println("BENCH districts=" + polygons.size()
                + " vertices=" + polygons.stream()
                        .mapToInt(g -> g.coordinates().get(0).size()).sum());
        Assumptions.assumeTrue(polygons.size() >= 11, "11 Delhi districts required");

        PostGisTowerSource source = new PostGisTowerSource(
                jdbc, "sim_cell_towers", "site_id", "cell_id",
                "latitude", "longitude", "coverage_radius_m", "coverage_geom",
                "geom", "radius", 4326, 100000, 300000);
        TowerSource.FindTowersOptions options = TowerSource.FindTowersOptions.defaults()
                .setLimit(100000).setTraceKey("bench-11districts");

        long t0 = System.currentTimeMillis();
        TowerResolutionResult result = source.findTowersInZone(
                new GeoZone(polygons, 4326), options).get();
        long ms = System.currentTimeMillis() - t0;
        System.out.println("BENCH 11-district resolution: towers=" + result.towers().size()
                + " rawTotal=" + result.rawTotal()
                + " duplicatesRemoved=" + result.duplicatesRemoved()
                + " elapsedMs=" + ms);
        assertTrue(result.towers().size() > 20000,
                "11 districts must resolve tens of thousands of towers, got "
                        + result.towers().size());
        assertTrue(ms < 5000, "11-district SLA breached: " + ms + "ms (target <5000ms)");
    }
}
