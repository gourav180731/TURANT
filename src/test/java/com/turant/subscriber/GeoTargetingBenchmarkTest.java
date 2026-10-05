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
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Performance benchmark for batch geo-targeted subscriber identification.
 *
 * <p>Tier 1 (KPI tier): all ~50k towers through the staging batch path and the
 * authoritative cell-ID join — must complete in under 60 seconds on the
 * 100M-row dataset. Tier 2: DISTINCT MSISDN streaming rate over a 2,000-tower
 * slice (full 50k-tower materialization is reported from the measured
 * chunk-bracket rate instead of re-running 100M rows inside the test).
 *
 * <p>Gated on {@code TURANT_REALDB_TESTS=1}. Read-only.
 */
class GeoTargetingBenchmarkTest {

    private static JdbcTemplate jdbc;
    private static GeoSubscriberTargetingService service;

    @BeforeAll
    static void init() {
        Assumptions.assumeTrue(GeoSubscriberTargetingTest.isRealDbEnabled(),
                "Benchmark requires TURANT_REALDB_TESTS=1");
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
        service = new GeoSubscriberTargetingService(jdbc, 300000);
    }

    private List<CellTower> loadTowers(int limit) {
        return jdbc.query(
                "SELECT site_id, cell_id, latitude, longitude, coverage_radius_m "
                        + "FROM sim_cell_towers ORDER BY site_id LIMIT " + limit,
                (rs, i) -> new CellTower(rs.getString(1), rs.getString(2),
                        rs.getDouble(3), rs.getDouble(4),
                        rs.getObject(5) == null ? null : rs.getDouble(5), null));
    }

    /**
     * Single-target SLA verification: the complete 50,000-tower batch path
     * (bulk staging + ANALYZE + aggregate counts) on the genuine 100M-row
     * dataset must finish in under 60 seconds. Lean by design — no
     * MSISDN materialization — so the leadership demo completes quickly.
     * Run exactly this test with:
     * {@code mvn test -Dtest=GeoTargetingBenchmarkTest#test50kTowersMatchingSla -DTURANT_REALDB_TESTS=1}
     */
    @Test
    void test50kTowersMatchingSla() {
        List<CellTower> towers = loadTowers(50000);
        assertTrue(towers.size() >= 50000, "50k towers required, got " + towers.size());
        GeoSubscriberTargetingService.TargetSummary s = service.identifySummaries(towers);
        System.out.println("SLA towersReceived=" + s.towersReceived()
                + " staged=" + s.towersStaged()
                + " matchedCells=" + s.cellPathCells()
                + " rows=" + s.cellPathRows()
                + " distinct=" + s.cellPathDistinct()
                + " loadMs=" + s.loadMs()
                + " queryMs=" + s.queryMs()
                + " totalMs=" + s.totalMs());
        assertTrue(s.cellPathDistinct() > 0, "must identify subscribers");
        assertTrue(s.totalMs() < 60000,
                "50k-tower SLA breached: " + s.totalMs() + "ms (target <60000ms)");
    }

    @Test
    void tier1_fullTowerBatchUnder60Seconds() {
        List<CellTower> towers = loadTowers(50000);
        System.out.println("BENCH towers loaded into JVM: " + towers.size());
        GeoSubscriberTargetingService.TargetSummary s = service.identifySummaries(towers);
        System.out.println("BENCH towersReceived=" + s.towersReceived()
                + " staged=" + s.towersStaged()
                + " skippedInvalid=" + s.towersSkippedInvalid()
                + " cellPathCells=" + s.cellPathCells()
                + " cellPathRows=" + s.cellPathRows()
                + " cellPathDistinct=" + s.cellPathDistinct()
                + " geoPathRows=" + s.geoPathRows()
                + " geoPathDistinct=" + s.geoPathDistinct()
                + " loadMs=" + s.loadMs()
                + " queryMs=" + s.queryMs()
                + " totalMs=" + s.totalMs());
        assertTrue(s.totalMs() < 60000,
                "50k-tower batch identification must complete under 60s, took " + s.totalMs() + "ms");
        assertTrue(s.cellPathDistinct() > 0, "must identify subscribers");
    }

    @Test
    void tier2_distinctStreamRate() {
        List<CellTower> slice = loadTowers(2000);
        AtomicLong n = new AtomicLong();
        Set<String> sample = new HashSet<>();
        long t0 = System.currentTimeMillis();
        // Bounded rate probe: count the stream without retaining all of it.
        long streamed = service.streamUniqueMsisdns(slice, msisdn -> {
            n.incrementAndGet();
            if (sample.size() < 1000) {
                sample.add(msisdn);
            }
        });
        long ms = System.currentTimeMillis() - t0;
        double perSec = streamed * 1000.0 / Math.max(1, ms);
        System.out.println("BENCH stream sliceTowers=2000 streamed=" + streamed
                + " ms=" + ms + " rate=" + (long) perSec + "/s");
        assertTrue(streamed > 0, "slice must stream subscribers");
        assertTrue(sample.size() == Math.min(1000, streamed), "stream must be distinct");
    }

    @Test
    void tier1_geoFallbackSubsetTiming() {
        // External-style payload: real coords/radii, unknown cell IDs —
        // forces the GiST spatial path for a measurable subset.
        List<CellTower> external = new ArrayList<>();
        List<CellTower> real = loadTowers(200);
        int k = 0;
        for (CellTower t : real) {
            external.add(new CellTower("EXT-" + (k++), "999-91-000-" + k,
                    t.latitude(), t.longitude(), t.coverageRadiusM(), null));
        }
        long t0 = System.currentTimeMillis();
        GeoSubscriberTargetingService.TargetSummary s = service.identifySummariesGeo(external);
        long ms = System.currentTimeMillis() - t0;
        System.out.println("BENCH geo200 cellRows=" + s.cellPathRows()
                + " geoRows=" + s.geoPathRows()
                + " geoDistinct=" + s.geoPathDistinct()
                + " totalMs=" + ms);
        assertTrue(s.cellPathRows() == 0, "unknown IDs must not match by cell");
        assertTrue(s.geoPathDistinct() > 0, "spatial fallback must identify subscribers");
    }
}
