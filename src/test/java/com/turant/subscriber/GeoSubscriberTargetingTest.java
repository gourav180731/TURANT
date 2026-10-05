package com.turant.subscriber;

import com.turant.types.tower.CellTower;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SimpleDriverDataSource;

import java.sql.Driver;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Correctness tests for {@link GeoSubscriberTargetingService} (Tests A-G).
 *
 * <p>READ-ONLY against the reconstructed office database: every assertion is
 * a SELECT; no business table is written. Gated on
 * {@code TURANT_REALDB_TESTS=1} plus DB reachability so plain unit-test runs
 * (H2/CI) skip silently.
 */
class GeoSubscriberTargetingTest {

    private static JdbcTemplate jdbc;
    private static GeoSubscriberTargetingService service;
    private static CellTower realTower;

    @BeforeAll
    static void init() {
        Assumptions.assumeTrue(isRealDbEnabled(),
                "Real-DB geo-targeting tests require TURANT_REALDB_TESTS=1");
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
            Integer one = jdbc.queryForObject("SELECT 1", Integer.class);
            Assumptions.assumeTrue(one != null && one == 1, "turant DB unreachable");
        } catch (Exception e) {
            Assumptions.abort("turant DB unreachable: " + e.getMessage());
        }
        service = new GeoSubscriberTargetingService(jdbc, 120000);
        // One authoritative Delhi tower (cell-ID, coords, radius all real).
        realTower = jdbc.query(
                "SELECT site_id, cell_id, latitude, longitude, coverage_radius_m "
                        + "FROM sim_cell_towers WHERE state = 'Delhi' "
                        + "AND coverage_radius_m IS NOT NULL LIMIT 1",
                rs -> {
                    assertTrue(rs.next(), "seed tower required");
                    return new CellTower(rs.getString(1), rs.getString(2),
                            rs.getDouble(3), rs.getDouble(4), rs.getDouble(5), null);
                });
    }

    /** Enabled via env {@code TURANT_REALDB_TESTS=1} or {@code -DTURANT_REALDB_TESTS=1}. */
    static boolean isRealDbEnabled() {
        return "1".equals(System.getProperty("TURANT_REALDB_TESTS",
                System.getenv("TURANT_REALDB_TESTS") == null ? ""
                        : System.getenv("TURANT_REALDB_TESTS")));
    }

    private long directCellCount(String cellId) {        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM subscriber_dump WHERE serving_cell_id = ?",
                Long.class, cellId);
        return n == null ? 0 : n;
    }

    @Test
    void testA_exactCellMatch() {
        GeoSubscriberTargetingService.TargetSummary s =
                service.identifySummaries(List.of(realTower));
        assertEquals(1, s.towersStaged());
        assertTrue(s.cellPathRows() > 0, "real cell must match subscribers");
        assertEquals(directCellCount(realTower.cellId()), s.cellPathRows(),
                "staging path must equal the direct B-tree lookup");
        assertEquals(s.cellPathRows(), s.cellPathDistinct(),
                "MSISDNs are globally unique in this dataset");
        assertEquals(0, s.geoPathRows(), "fully-matched towers need no fallback");
    }

    @Test
    void testB_cellMismatchButSpatialMatch() {
        CellTower foreign = new CellTower("EXT-1", "999-99-999-99999",
                realTower.latitude(), realTower.longitude(),
                realTower.coverageRadiusM(), null);
        GeoSubscriberTargetingService.TargetSummary s =
                service.identifySummariesGeo(List.of(foreign));
        assertEquals(0, s.cellPathRows(), "unknown cell_id must match nothing by ID");
        assertTrue(s.geoPathRows() > 0, "spatial fallback must find in-coverage subscribers");
        long ownCell = directCellCount(realTower.cellId());
        assertTrue(s.geoPathDistinct() >= ownCell,
                "the tower's own in-coverage subscribers must be a subset of the spatial result");
        // Stronger: every MSISDN of the real cell is contained in the geo set.
        Set<String> cellSet = new HashSet<>();
        service.streamUniqueMsisdns(List.of(realTower), cellSet::add);
        Set<String> geoSet = new HashSet<>();
        service.streamUniqueMsisdnsGeo(List.of(foreign), geoSet::add);
        assertTrue(geoSet.containsAll(cellSet),
                "spatial fallback must cover the co-located cell's subscribers");
    }

    @Test
    void testC_outsideRadiusExcluded() {
        // Mid-ocean point: nothing within 100 m.
        CellTower ocean = new CellTower("EXT-2", "999-99-999-99998", 0.5, 0.5, 100.0, null);
        GeoSubscriberTargetingService.TargetSummary s =
                service.identifySummariesGeo(List.of(ocean));
        assertEquals(0, s.cellPathRows());
        assertEquals(0, s.geoPathRows());
        assertEquals(0, s.geoPathDistinct());
    }

    @Test
    void testD_overlappingTowersDeduplicated() {
        CellTower dup = new CellTower("EXT-3", realTower.cellId(),
                realTower.latitude(), realTower.longitude(),
                realTower.coverageRadiusM(), null);
        Set<String> single = new HashSet<>();
        service.streamUniqueMsisdns(List.of(realTower), single::add);
        Set<String> doubled = new HashSet<>();
        service.streamUniqueMsisdns(List.of(realTower, dup), doubled::add);
        assertFalse(single.isEmpty());
        assertEquals(single, doubled, "overlapping towers must not duplicate MSISDNs");
    }

    @Test
    void testE_emptyTowerListNoScan() {
        long t0 = System.currentTimeMillis();
        GeoSubscriberTargetingService.TargetSummary s =
                service.identifySummaries(List.of());
        assertEquals(0, s.cellPathRows());
        assertEquals(0, s.geoPathRows());
        assertTrue(System.currentTimeMillis() - t0 < 5000,
                "empty input must short-circuit without scanning");
    }

    @Test
    void testF_nullInvalidCoordinatesSafe() {
        List<CellTower> mixed = new ArrayList<>();
        mixed.add(null);
        mixed.add(new CellTower("BAD-1", null, 28.6, 77.2, 350.0, null));
        mixed.add(new CellTower("BAD-2", "   ", 28.6, 77.2, 350.0, null));
        mixed.add(new CellTower("BAD-3", "999-99-999-99997",
                Double.NaN, Double.NaN, 350.0, null));
        mixed.add(new CellTower("BAD-4", "999-99-999-99996", 28.6, 77.2, -5.0, null));
        mixed.add(realTower);
        GeoSubscriberTargetingService.TargetSummary s = service.identifySummaries(mixed);
        // null/blank-cellId rows are skipped; rows with unusable geography but a
        // cellId still stage (cell-ID matching needs no coordinates).
        assertEquals(3, s.towersSkippedInvalid());
        assertEquals(3, s.towersStaged());
        assertTrue(s.cellPathRows() > 0, "the valid tower must still match");
    }

    @Test
    void testG_noNullMsisdnEmitted() {
        Set<String> out = new HashSet<>();
        long n = service.streamUniqueMsisdns(List.of(realTower), out::add);
        assertTrue(n > 0);
        assertEquals(n, out.size(), "stream must already be distinct");
        assertTrue(out.stream().noneMatch(Objects::isNull),
                "null MSISDNs must never be emitted");
    }
}
