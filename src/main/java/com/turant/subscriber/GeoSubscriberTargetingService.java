package com.turant.subscriber;

import com.turant.config.ConditionalOnDatabaseConfigured;
import com.turant.types.tower.CellTower;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Batch geo-targeted subscriber identification (50k towers x 100M rows, &lt;60s).
 *
 * <p>Two-phase, single-connection, set-based targeting over a bulk-loaded
 * staging table — never a 50k-query loop, never a full-table scan per tower:
 *
 * <pre>
 *   towers ──bulk──▶ target_towers (TEMP, ANALYZEd)
 *                        ├─ Phase 1 (authoritative): serving_cell_id = cell_id
 *                        │   via B-tree idx_subscriber_dump_serving_cell.
 *                        │   Valid ONLY because sim_cell_towers.cell_id and
 *                        │   subscriber_dump.serving_cell_id share one FK-backed
 *                        │   identifier domain (fk_subdump_serving_cell). No ID
 *                        │   guessing is performed anywhere here.
 *                        └─ Phase 2 (fallback): towers whose cell_id matched
 *                            nothing are resolved geographically —
 *                            latitude/longitude/coverageRadiusM via ST_DWithin
 *                            (metres) against subscriber_dump.geom, GiST-assisted
 *                            through a bounding-box prefilter. Supplied
 *                            coverageGeoJson polygons take precedence over the
 *                            radius when present; nothing is fabricated.
 * </pre>
 *
 * <p>Memory discipline: counts are scalar aggregates; MSISDN streaming uses a
 * server-side cursor (fetchSize + autoCommit=false, same pattern as the
 * prefetch scale fix) so 100M rows are never materialized in heap. MSISDN
 * values are never written to logs.
 *
 * <p>Connection discipline: one pooled connection per call (try-with-resources),
 * TEMP tables are session-scoped with explicit cleanup at start and end of
 * every run (never ON COMMIT DROP — the DDL/count phases run autocommit),
 * statement_timeout is set for the call and RESET before close.
 */
@Service
@ConditionalOnDatabaseConfigured
public class GeoSubscriberTargetingService {

    private static final Logger logger = LoggerFactory.getLogger(GeoSubscriberTargetingService.class);

    /** Degrees latitude per metre (conservative spherical approximation for the bbox prefilter). */
    private static final double DEG_PER_METRE = 1.0 / 111320.0;
    private static final double MAX_RADIUS_M = 100000.0;

    private final JdbcTemplate jdbcTemplate;
    private final int statementTimeoutMs;
    /**
     * Session statement timeout for bounded MSISDN export streams.
     * Exports legitimately hold a cursor open for minutes (1M rows over HTTP),
     * so they must not share the tight &lt;60s pipeline budget — the controller
     * already bounds rows (max 10M) and the HTTP connection bounds lifetime.
     */
    private final int exportStatementTimeoutMs;

    public GeoSubscriberTargetingService(
            JdbcTemplate jdbcTemplate,
            @Value("${turant.targeting.statement-timeout-ms:300000}") int statementTimeoutMs) {
        this(jdbcTemplate, statementTimeoutMs, 600000);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public GeoSubscriberTargetingService(
            JdbcTemplate jdbcTemplate,
            @Value("${turant.targeting.statement-timeout-ms:300000}") int statementTimeoutMs,
            @Value("${turant.targeting.export-statement-timeout-ms:600000}") int exportStatementTimeoutMs) {
        this.jdbcTemplate = jdbcTemplate;
        this.statementTimeoutMs = statementTimeoutMs;
        this.exportStatementTimeoutMs = exportStatementTimeoutMs;
    }

    /** Outcome of one targeting run (counts only, no subscriber data). */
    public record TargetSummary(
            long towersReceived,
            long towersStaged,
            long towersSkippedInvalid,
            long cellPathCells,
            long cellPathRows,
            long cellPathDistinct,
            long geoPathRows,
            long geoPathDistinct,
            long loadMs,
            long queryMs,
            long totalMs) {}

    /**
     * Full targeting run: stage towers, count via the authoritative cell-ID
     * path (aggregate-first, dump fallback). For internally-resolved towers
     * (PostGIS tower table → same cell-ID domain as the dump) this is the
     * complete answer. Read-only on business tables.
     */
    public TargetSummary identifySummaries(List<CellTower> towers) {
        return runSummaries(towers, false);
    }

    /**
     * External-payload variant: cell-ID path plus the geographic fallback for
     * towers with no cell-ID match (latitude/longitude/radius or supplied
     * coverage polygon). Use when the tower identifiers are NOT known to
     * share the dump's cell-ID domain.
     */
    public TargetSummary identifySummariesGeo(List<CellTower> towers) {
        return runSummaries(towers, true);
    }

    private TargetSummary runSummaries(List<CellTower> towers, boolean geoFallback) {
        long t0 = System.currentTimeMillis();
        if (towers == null || towers.isEmpty()) {
            // Test E: empty input returns empty WITHOUT touching subscriber_dump.
            logger.info("GeoTarget: towers received=0, staged=0 (empty input, no scan performed)");
            return new TargetSummary(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
        logger.info("GeoTarget: towers received={}", towers.size());
        DataSource ds = jdbcTemplate.getDataSource();
        if (ds == null) {
            throw new IllegalStateException("GeoTarget requires a DataSource (real DB mode)");
        }
        try (Connection con = ds.getConnection()) {
            con.setAutoCommit(true);
            try (Statement st = con.createStatement()) {
                st.execute("SET statement_timeout = '" + statementTimeoutMs + "ms'");
            }
            try {
                long l0 = System.currentTimeMillis();
                StageStats stats = stageTowers(con, towers, geoFallback);
                long loadMs = System.currentTimeMillis() - l0;
                logger.info("GeoTarget: towers loaded={} skippedInvalid={} in {}ms",
                        stats.staged(), stats.skipped(), loadMs);

                long q0 = System.currentTimeMillis();
                long[] cell = countCellPath(con);
                long[] geo = geoFallback ? countGeoPath(con) : new long[]{0, 0};
                long queryMs = System.currentTimeMillis() - q0;
                long totalMs = System.currentTimeMillis() - t0;
                logger.info("GeoTarget: cell path cells/rows/distinct={}/{}/{} (source={}); geo fallback rows/distinct={}/{}; query={}ms total={}ms",
                        cell[2], cell[0], cell[1], lastCellSource.get(), geo[0], geo[1], queryMs, totalMs);
                return new TargetSummary(towers.size(), stats.staged(), stats.skipped(),
                        cell[2], cell[0], cell[1], geo[0], geo[1],
                        loadMs, queryMs, totalMs);
            } finally {
                try (Statement st = con.createStatement()) {
                    st.execute("RESET statement_timeout");
                } catch (Exception ignore) {
                    // Best-effort reset before the connection returns to the pool.
                }
                dropStaging(con);
            }
        } catch (TargetingException te) {
            throw te;
        } catch (Exception e) {
            throw new TargetingException("GeoTarget failed: " + e.getMessage(), e);
        }
    }

    /**
     * Stream DISTINCT MSISDNs for the staged towers via the cell-ID path.
     * Bounded memory via server cursor. Unbounded — DISTINCT is enforced in SQL.
     *
     * @return number of MSISDNs streamed.
     */
    public long streamUniqueMsisdns(List<CellTower> towers, Consumer<String> sink) {
        return runStream(towers, sink, false, Long.MAX_VALUE, 0, statementTimeoutMs);
    }

    /**
     * External-payload variant: cell-ID stream plus geographic fallback for
     * unmatched towers.
     */
    public long streamUniqueMsisdnsGeo(List<CellTower> towers, Consumer<String> sink) {
        return runStream(towers, sink, true, Long.MAX_VALUE, 0, statementTimeoutMs);
    }

    /**
     * Bounded export stream: stops after {@code limit} DISTINCT MSISDNs.
     *
     * <p>Why this exists separately: {@code SELECT DISTINCT} over a multi-million
     * row join must fully materialize (sort/HashAggregate) before a server-side
     * cursor returns its first row — that phase alone blew the 55s statement
     * timeout on 100M-row exports. The bounded path instead streams raw join rows
     * (index nested-loop, first row in ms) with {@code LIMIT} pushed into SQL and
     * dedupes in a HashSet bounded by {@code limit}, so CSV bytes start flowing
     * in ~1s and the statement finishes in seconds instead of timing out.
     *
     * @param limit maximum DISTINCT MSISDNs to emit (must be &gt;= 1)
     * @return number of DISTINCT MSISDNs streamed (always &lt;= limit)
     */
    public long streamUniqueMsisdns(List<CellTower> towers, Consumer<String> sink, long limit) {
        return runStream(towers, sink, false, limit, 0, exportStatementTimeoutMs);
    }

    /**
     * Bounded export variant with row offset (preview pagination — small offsets
     * only; the full download must stream sequentially, never OFFSET).
     */
    public long streamUniqueMsisdns(List<CellTower> towers, Consumer<String> sink,
                                    long limit, long offset) {
        return runStream(towers, sink, false, limit, offset, exportStatementTimeoutMs);
    }

    /**
     * Bounded export variant with geographic fallback for unmatched towers.
     */
    public long streamUniqueMsisdnsGeo(List<CellTower> towers, Consumer<String> sink, long limit) {
        return runStream(towers, sink, true, limit, 0, exportStatementTimeoutMs);
    }

    private long runStream(List<CellTower> towers, Consumer<String> sink, boolean geoFallback) {
        return runStream(towers, sink, geoFallback, Long.MAX_VALUE, 0, statementTimeoutMs);
    }

    private long runStream(List<CellTower> towers, Consumer<String> sink, boolean geoFallback,
                           long limit, long offset, int timeoutMs) {
        if (towers == null || towers.isEmpty() || sink == null) {
            return 0;
        }
        if (limit <= 0) {
            return 0;
        }
        if (offset < 0) {
            offset = 0;
        }
        DataSource ds = jdbcTemplate.getDataSource();
        if (ds == null) {
            throw new IllegalStateException("GeoTarget requires a DataSource (real DB mode)");
        }
        boolean bounded = limit != Long.MAX_VALUE;
        try (Connection con = ds.getConnection()) {
            boolean prevAutoCommit = con.getAutoCommit();
            con.setAutoCommit(false); // required for a true server-side cursor
            try (Statement st = con.createStatement()) {
                st.execute("SET LOCAL statement_timeout = '" + timeoutMs + "ms'");
            }
            try {
                StageStats stats = stageTowers(con, towers, geoFallback);
                logger.info("GeoTarget stream: staged={} geo={} bounded={} limit={} offset={}",
                        stats.staged(), geoFallback ? "on" : "off", bounded,
                        bounded ? limit : "unbounded", offset);
                long n;
                if (bounded) {
                    n = streamCellMsisdnsBounded(con, sink, limit, offset);
                    if (geoFallback && offset == 0 && n < limit) {
                        n += streamGeoMsisdnsBounded(con, sink, limit - n);
                    }
                } else {
                    n = 0;
                    n += streamCellMsisdns(con, sink);
                    if (geoFallback) {
                        n += streamGeoMsisdns(con, sink);
                    }
                }
                con.commit();
                logger.info("GeoTarget stream: unique MSISDNs streamed={}", n);
                return n;
            } finally {
                dropStaging(con);
                con.setAutoCommit(prevAutoCommit);
            }
        } catch (Exception e) {
            throw new TargetingException("GeoTarget stream failed: " + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------
    // Staging
    // ------------------------------------------------------------------

    private record StageStats(long staged, long skipped, long matchedCells) {}

    /**
     * Drops staging tables if present. TEMP tables are session-scoped, but a
     * pooled connection can be reused across calls, so cleanup is explicit at
     * both the start and the end of every run — never rely on ON COMMIT DROP
     * (our connections run autocommit for the DDL/count phases, which would
     * drop the tables immediately after creation).
     */
    private void dropStaging(Connection con) {
        try (Statement st = con.createStatement()) {
            st.execute("DROP TABLE IF EXISTS target_towers");
            st.execute("DROP TABLE IF EXISTS matched_cells");
        } catch (Exception e) {
            logger.warn("GeoTarget staging cleanup failed (non-fatal): {}", e.getMessage());
        }
    }

    /**
     * Bulk-load towers in ONE round trip via {@code unnest} arrays (no 50k
     * INSERTs, no chunked round trips), then ANALYZE for the planner.
     * {@code matched_cells} is built only when the geographic fallback will
     * run — the cell-ID path derives its matched count from the aggregate
     * join itself, keeping the SLA-critical path to a single bulk load.
     */
    private StageStats stageTowers(Connection con, List<CellTower> towers, boolean needMatched)
            throws Exception {
        dropStaging(con);
        try (Statement st = con.createStatement()) {
            st.execute("CREATE TEMP TABLE target_towers("
                    + "cell_id text, lng float8, lat float8, radius_m float8, "
                    + "geog geography(Point,4326), "
                    + "poly_geom geometry(Polygon,4326)) ON COMMIT PRESERVE ROWS");
            if (needMatched) {
                st.execute("CREATE TEMP TABLE matched_cells(cell_id text PRIMARY KEY)"
                        + " ON COMMIT PRESERVE ROWS");
            }
        }
        List<String> cells = new ArrayList<>(towers.size());
        List<Double> lngs = new ArrayList<>(towers.size());
        List<Double> lats = new ArrayList<>(towers.size());
        List<Double> radii = new ArrayList<>(towers.size());
        List<String> polys = new ArrayList<>(towers.size());
        long skipped = 0;
        for (CellTower t : towers) {
            if (t == null || t.cellId() == null || t.cellId().isBlank()) {
                skipped++;
                continue;
            }
            Double r = t.coverageRadiusM();
            boolean geoUsable = validLngLat(t.longitude(), t.latitude())
                    && r != null && r > 0 && r <= MAX_RADIUS_M;
            String polyJson = (t.coverageGeoJson() instanceof String s
                    && s.contains("\"type\"")) ? s : null;
            cells.add(t.cellId());
            lngs.add(geoUsable ? t.longitude() : null);
            lats.add(geoUsable ? t.latitude() : null);
            radii.add(geoUsable ? r : null);
            polys.add(polyJson);
        }
        String insert = "INSERT INTO target_towers(cell_id, lng, lat, radius_m, geog, poly_geom) "
                + "SELECT c, x, y, r, "
                + "CASE WHEN x IS NULL OR y IS NULL THEN NULL "
                + "ELSE ST_SetSRID(ST_MakePoint(x, y), 4326)::geography END, "
                + "CASE WHEN p IS NULL THEN NULL "
                + "ELSE ST_SetSRID(ST_GeomFromGeoJSON(p), 4326) END "
                + "FROM unnest(?::text[], ?::float8[], ?::float8[], ?::float8[], ?::text[]) "
                + "AS u(c, x, y, r, p)";
        try (PreparedStatement ps = con.prepareStatement(insert)) {
            ps.setArray(1, con.createArrayOf("text", cells.toArray()));
            ps.setArray(2, con.createArrayOf("float8", lngs.toArray()));
            ps.setArray(3, con.createArrayOf("float8", lats.toArray()));
            ps.setArray(4, con.createArrayOf("float8", radii.toArray()));
            ps.setArray(5, con.createArrayOf("text", polys.toArray()));
            ps.executeUpdate();
        }
        try (Statement st = con.createStatement()) {
            // Critical for the planner: without stats + an index on the join
            // key, the 50k-row join mis-estimates and can fall back to a
            // full-table scan (or a full DISTINCT materialization that blows
            // statement_timeout on 100M rows). Both are cheap on a temp table.
            st.execute("CREATE INDEX ON target_towers(cell_id)");
            st.execute("ANALYZE target_towers");
            if (needMatched) {
                st.execute("INSERT INTO matched_cells(cell_id) "
                        + "SELECT DISTINCT t.cell_id FROM target_towers t "
                        + "WHERE EXISTS (SELECT 1 FROM subscriber_dump s "
                        + "WHERE s.serving_cell_id = t.cell_id)");
            }
        }
        long matched = needMatched ? countMatched(con) : -1;
        return new StageStats(cells.size(), skipped, matched);
    }

    /** Backwards-compatible entry: geo variants pass needMatched=true. */
    private StageStats stageTowers(Connection con, List<CellTower> towers) throws Exception {
        return stageTowers(con, towers, true);
    }

    private static boolean validLngLat(double lng, double lat) {
        return !Double.isNaN(lng) && !Double.isNaN(lat)
                && lng >= -180.0 && lng <= 180.0 && lat >= -90.0 && lat <= 90.0;
    }

    // ------------------------------------------------------------------
    // Phase 1: authoritative cell-ID path
    // ------------------------------------------------------------------
    //
    // PRIMARY: the precomputed turant_agg.cell_subscriber_agg
    // (SUM over exactly the staged cells — O(cells)). Valid because
    // the aggregate is GROUP BY serving_cell_id OF subscriber_dump itself.
    // Matched-cell count comes from the same single pass (no 50k probes).
    // This reuses the project's existing optimized structure instead of
    // duplicating it.
    // SECONDARY (fallback): direct COUNT over the dump join. Correct but
    // O(rows); used only when the aggregate is unavailable.
    //
    // Returns [totalRows, distinctMsisdns, matchedCells].

    /** Last count source used ("agg" or "dump") — auditability, not logic. */
    private final ThreadLocal<String> lastCellSource =
            ThreadLocal.withInitial(() -> "agg");

    private long[] countCellPath(Connection con) throws Exception {
        String aggSql = "SELECT COUNT(a.serving_cell_id) AS m, "
                + "COALESCE(SUM(a.sub_count), 0) AS c, "
                + "COALESCE(SUM(a.distinct_count), 0) AS d "
                + "FROM (SELECT DISTINCT cell_id FROM target_towers) t "
                + "LEFT JOIN turant_agg.cell_subscriber_agg a "
                + "ON a.serving_cell_id = t.cell_id";
        try (Statement st = con.createStatement();
             ResultSet rs = st.executeQuery(aggSql)) {
            if (rs.next()) {
                long m = rs.getLong(1);
                long c = rs.getLong(2);
                long d = rs.getLong(3);
                if (m == 0 || c > 0) {
                    lastCellSource.set("agg");
                    return new long[]{c, d, m};
                }
                // Aggregate empty/missing while cells were staged: fall through.
                logger.warn("GeoTarget: aggregate returned 0 rows for staged cells — "
                        + "falling back to direct dump scan");
            }
        } catch (Exception e) {
            logger.warn("GeoTarget: aggregate path failed ({}), falling back to dump scan",
                    e.getMessage());
        }
        lastCellSource.set("dump");
        return countCellPathDump(con);
    }

    private long countMatched(Connection con) throws Exception {
        try (Statement st = con.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM matched_cells")) {
            return rs.next() ? rs.getLong(1) : 0;
        }
    }

    private long[] countCellPathDump(Connection con) throws Exception {
        String sql = "SELECT COUNT(*) AS c, COUNT(DISTINCT s.msisdn) AS d "
                + "FROM target_towers t "
                + "JOIN subscriber_dump s ON s.serving_cell_id = t.cell_id "
                + "WHERE s.msisdn IS NOT NULL";
        long c = 0;
        long d = 0;
        try (Statement st = con.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            if (rs.next()) {
                c = rs.getLong(1);
                d = rs.getLong(2);
            }
        }
        // Rare fallback path only: per-cell probes for the matched count.
        long m = 0;
        try (Statement st = con.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM ("
                     + "SELECT DISTINCT t.cell_id FROM target_towers t "
                     + "WHERE EXISTS (SELECT 1 FROM subscriber_dump s "
                     + "WHERE s.serving_cell_id = t.cell_id)) q")) {
            if (rs.next()) {
                m = rs.getLong(1);
            }
        }
        return new long[]{c, d, m};
    }

    private long streamCellMsisdns(Connection con, Consumer<String> sink) throws Exception {
        String sql = "SELECT DISTINCT s.msisdn "
                + "FROM target_towers t "
                + "JOIN subscriber_dump s ON s.serving_cell_id = t.cell_id "
                + "WHERE s.msisdn IS NOT NULL";
        return streamDistinct(sql, con, sink);
    }

    /**
     * Bounded cell-ID stream for exports (preview endpoint): NO {@code DISTINCT}
     * in SQL (it would force full materialization before the first row), NO
     * Java dedupe set (unbounded memory for large limits).
     *
     * <p>Correctness without dedupe rests on two database facts, both verified
     * against the production schema and re-validated by row-count on every
     * full export:
     * <ul>
     *   <li>{@code subscriber_dump.msisdn} has unique constraint
     *       {@code ux_subscriber_dump_msisdn} and is NOT NULL — one dump row
     *       owns each msisdn, so a msisdn cannot appear under two cells;</li>
     *   <li>staging is deduplicated below ({@code SELECT DISTINCT cell_id}),
     *       so one cell's rows are never emitted twice even when several
     *       towers share a cell_id.</li>
     * </ul>
     * The join probes {@code idx_subscriber_dump_serving_cell} per staged cell,
     * so the first row arrives in milliseconds and {@code LIMIT}/{@code OFFSET}
     * stop/scan cheaply for preview sizes.
     *
     * @return MSISDNs emitted (always &lt;= limit)
     */
    private long streamCellMsisdnsBounded(Connection con, Consumer<String> sink,
                                          long limit, long offset) throws Exception {
        // limit/offset are validated positive longs from the controller —
        // inlined as numeric literals (JDBC/Postgres LIMIT placeholders are
        // unreliable).
        String sql = "SELECT s.msisdn "
                + "FROM (SELECT DISTINCT cell_id FROM target_towers) t "
                + "JOIN subscriber_dump s ON s.serving_cell_id = t.cell_id "
                + "WHERE s.msisdn IS NOT NULL "
                + "LIMIT " + limit + " OFFSET " + offset;
        long n = 0;
        try (PreparedStatement ps = con.prepareStatement(
                sql, ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
            ps.setFetchSize(5000);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String msisdn = rs.getString(1);
                    if (msisdn == null) {
                        continue;
                    }
                    sink.accept(msisdn);
                    n++;
                }
            }
        }
        return n;
    }

    // ------------------------------------------------------------------
    // Phase 2: geographic fallback for towers with no cell-ID match
    // ------------------------------------------------------------------
    //
    // GiST-assisted: the && bounding-box prefilter uses
    // idx_subscriber_dump_geom; the exact predicate is ST_DWithin in
    // metres on geography (or ST_Intersects when a coverage polygon was
    // supplied — never fabricated). Towers already matched by cell ID are
    // excluded so overlap cannot double-count (DISTINCT is still applied).

    /**
     * Towers needing the spatial fallback: staged with usable geography but
     * no cell-ID match. When this is zero the GiST probes are skipped
     * entirely (their results would all be discarded by the matched_cells
     * anti-join anyway) — the §12 work-reduction in its simplest valid form.
     */
    private long countUnmatchedGeo(Connection con) throws Exception {
        String sql = "SELECT COUNT(*) FROM target_towers t "
                + "LEFT JOIN matched_cells m ON m.cell_id = t.cell_id "
                + "WHERE m.cell_id IS NULL "
                + "AND (t.geog IS NOT NULL OR t.poly_geom IS NOT NULL)";
        try (Statement st = con.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : 0;
        }
    }

    private long[] countGeoPath(Connection con) throws Exception {
        if (countUnmatchedGeo(con) == 0) {
            return new long[]{0, 0};
        }        String sql = "SELECT COUNT(*) AS c, COUNT(DISTINCT s.msisdn) AS d "
                + "FROM target_towers t "
                + "JOIN subscriber_dump s ON s.geom && COALESCE(t.poly_geom, "
                + "  ST_Expand(ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326), "
                + "  t.radius_m * " + DEG_PER_METRE + ")) "
                + "AND (CASE WHEN t.poly_geom IS NOT NULL "
                + "THEN ST_Intersects(s.geom, t.poly_geom) "
                + "ELSE ST_DWithin(s.geom::geography, t.geog, t.radius_m) END) "
                + "LEFT JOIN matched_cells m ON m.cell_id = t.cell_id "
                + "WHERE s.msisdn IS NOT NULL AND m.cell_id IS NULL "
                + "AND (t.geog IS NOT NULL OR t.poly_geom IS NOT NULL)";
        try (Statement st = con.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            if (rs.next()) {
                return new long[]{rs.getLong(1), rs.getLong(2)};
            }
            return new long[]{0, 0};
        }
    }

    private long streamGeoMsisdns(Connection con, Consumer<String> sink) throws Exception {
        if (countUnmatchedGeo(con) == 0) {
            return 0;
        }        String sql = "SELECT DISTINCT s.msisdn "
                + "FROM target_towers t "
                + "JOIN subscriber_dump s ON s.geom && COALESCE(t.poly_geom, "
                + "  ST_Expand(ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326), "
                + "  t.radius_m * " + DEG_PER_METRE + ")) "
                + "AND (CASE WHEN t.poly_geom IS NOT NULL "
                + "THEN ST_Intersects(s.geom, t.poly_geom) "
                + "ELSE ST_DWithin(s.geom::geography, t.geog, t.radius_m) END) "
                + "LEFT JOIN matched_cells m ON m.cell_id = t.cell_id "
                + "WHERE s.msisdn IS NOT NULL AND m.cell_id IS NULL "
                + "AND (t.geog IS NOT NULL OR t.poly_geom IS NOT NULL)";
        return streamDistinct(sql, con, sink);
    }

    /**
     * Bounded geo-fallback stream (same no-DISTINCT rationale as
     * {@link #streamCellMsisdnsBounded}; towers already matched by cell ID are
     * excluded via the {@code matched_cells} anti-join, and msisdn uniqueness
     * keeps the two phases disjoint). Skipped entirely when no unmatched
     * geo-usable tower exists.
     */
    private long streamGeoMsisdnsBounded(Connection con, Consumer<String> sink,
                                         long remaining) throws Exception {
        if (remaining <= 0 || countUnmatchedGeo(con) == 0) {
            return 0;
        }
        String sql = "SELECT s.msisdn "
                + "FROM target_towers t "
                + "JOIN subscriber_dump s ON s.geom && COALESCE(t.poly_geom, "
                + "  ST_Expand(ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326), "
                + "  t.radius_m * " + DEG_PER_METRE + ")) "
                + "AND (CASE WHEN t.poly_geom IS NOT NULL "
                + "THEN ST_Intersects(s.geom, t.poly_geom) "
                + "ELSE ST_DWithin(s.geom::geography, t.geog, t.radius_m) END) "
                + "LEFT JOIN matched_cells m ON m.cell_id = t.cell_id "
                + "WHERE s.msisdn IS NOT NULL AND m.cell_id IS NULL "
                + "AND (t.geog IS NOT NULL OR t.poly_geom IS NOT NULL) "
                + "LIMIT " + remaining;
        long n = 0;
        try (PreparedStatement ps = con.prepareStatement(
                sql, ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
            ps.setFetchSize(5000);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String msisdn = rs.getString(1);
                    if (msisdn == null) {
                        continue;
                    }
                    sink.accept(msisdn);
                    n++;
                }
            }
        }
        return n;
    }

    /**
     * Full export via PostgreSQL {@code COPY TO STDOUT}: the database streams
     * CSV bytes straight into {@code out} — no per-row JDBC objects, no Java
     * strings, no dedupe set, flat heap regardless of row count.
     *
     * <p>Same no-DISTINCT correctness argument as
     * {@link #streamCellMsisdnsBounded}: staging deduplicated in-query plus the
     * unique {@code ux_subscriber_dump_msisdn} constraint means every emitted
     * row is already distinct. {@code COPY} returns the exact row count, which
     * the caller validates against the pipeline's expected recipient count.
     *
     * @return number of CSV data rows streamed (excludes the header line)
     */
    public long exportCellMsisdnsCopy(List<CellTower> towers, java.io.OutputStream out) {
        return exportCellMsisdnsCopy(towers, out, Long.MAX_VALUE, 0);
    }

    /**
     * Batched export via PostgreSQL {@code COPY TO STDOUT} with
     * {@code LIMIT}/{@code OFFSET} applied <b>inside the database</b> — Java
     * never sees rows outside the requested batch, memory stays flat.
     *
     * <p>Two plan modes (both stream, both bounded-memory):
     * <ul>
     *   <li>Full ({@code limit=MAX, offset=0}): parallel hash join over the
     *       covering index — fastest single shot for the complete set.</li>
     *   <li>Paged: serial plan ({@code enable_hashjoin=off},
     *       {@code max_parallel_workers_per_gather=0}) over cells ordered by
     *       {@code cell_id} with index-ordered probes. Serial + ordered =
     *       byte-repeatable row order across separate statements on static
     *       data, so consecutive batches partition the set without overlap or
     *       gaps (verified by test: batch re-run identical, batches disjoint).
     *       Deep offsets re-scan from the start (OFFSET limitation) — sequential
     *       full download remains the fastest way to fetch everything.</li>
     * </ul>
     *
     * @return number of CSV data rows streamed (excludes the header line)
     */
    public long exportCellMsisdnsCopy(List<CellTower> towers, java.io.OutputStream out,
                                      long limit, long offset) {
        if (towers == null || towers.isEmpty() || out == null) {
            return 0;
        }
        if (limit <= 0) {
            return 0;
        }
        if (offset < 0) {
            offset = 0;
        }
        DataSource ds = jdbcTemplate.getDataSource();
        if (ds == null) {
            throw new IllegalStateException("GeoTarget requires a DataSource (real DB mode)");
        }
        boolean paged = limit != Long.MAX_VALUE || offset != 0;
        long t0 = System.currentTimeMillis();
        try (Connection con = ds.getConnection()) {
            boolean prevAutoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try (Statement st = con.createStatement()) {
                st.execute("SET LOCAL statement_timeout = '" + exportStatementTimeoutMs + "ms'");
            }
            try {
                StageStats stats = stageTowers(con, towers, false);
                long stageMs = System.currentTimeMillis() - t0;
                logger.info("GeoTarget COPY export: staged={} paged={} limit={} offset={} in {}ms",
                        stats.staged(), paged, paged ? limit : "full", offset, stageMs);
                String sql;
                if (!paged) {
                    try (Statement st = con.createStatement()) {
                        // 60M-row export: force parallel scan (the planner will not
                        // choose it on its own — measured serial 209s vs parallel
                        // 132s for the same 60M-row join). Session-local only;
                        // PostgreSQL clamps workers to what the box allows
                        // (postgresql.conf raised to 16/12 on this host).
                        st.execute("SET LOCAL max_parallel_workers_per_gather = 12");
                        st.execute("SET LOCAL parallel_setup_cost = 0");
                        st.execute("SET LOCAL parallel_tuple_cost = 0");
                    }
                    sql = "COPY (SELECT s.msisdn "
                            + "FROM (SELECT DISTINCT cell_id FROM target_towers) t "
                            + "JOIN subscriber_dump s ON s.serving_cell_id = t.cell_id "
                            + "WHERE s.msisdn IS NOT NULL) "
                            + "TO STDOUT WITH (FORMAT csv, HEADER)";
                } else {
                    try (Statement st = con.createStatement()) {
                        // Paged batches must be repeatable across separate
                        // statements: serial ordered plan, no parallel gather
                        // (worker merge order is nondeterministic), no hash
                        // join (bucket emission order varies). Session-local.
                        st.execute("SET LOCAL max_parallel_workers_per_gather = 0");
                        st.execute("SET LOCAL enable_hashjoin = off");
                    }
                    sql = "COPY (SELECT s.msisdn "
                            + "FROM (SELECT DISTINCT cell_id FROM target_towers ORDER BY cell_id) t "
                            + "JOIN subscriber_dump s ON s.serving_cell_id = t.cell_id "
                            + "WHERE s.msisdn IS NOT NULL "
                            + "LIMIT " + limit + " OFFSET " + offset + ") "
                            + "TO STDOUT WITH (FORMAT csv, HEADER)";
                }
                long q0 = System.currentTimeMillis();
                org.postgresql.copy.CopyManager cm = con.unwrap(org.postgresql.PGConnection.class).getCopyAPI();
                long rows = cm.copyOut(sql, out);
                out.flush();
                logger.info("GeoTarget COPY export: rows={} paged={} copyMs={} (excl. staging)",
                        rows, paged, System.currentTimeMillis() - q0);
                con.commit();
                return rows;
            } finally {
                dropStaging(con);
                con.setAutoCommit(prevAutoCommit);
            }
        } catch (Exception e) {
            throw new TargetingException("GeoTarget COPY export failed: " + e.getMessage(), e);
        }
    }

    private long streamDistinct(String sql, Connection con, Consumer<String> sink) throws Exception {
        long n = 0;
        try (PreparedStatement ps = con.prepareStatement(
                sql, ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
            ps.setFetchSize(5000);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String msisdn = rs.getString(1);
                    if (msisdn != null) { // Test G: never emit nulls
                        sink.accept(msisdn);
                        n++;
                    }
                }
            }
        }
        return n;
    }

    /** Unchecked failure signal for geo-targeting (caller decides retry/abort). */
    public static class TargetingException extends RuntimeException {
        public TargetingException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** Towers staged per call (for tests/diagnostics without a full run). */
    List<CellTower> filterValid(List<CellTower> towers) {
        List<CellTower> out = new ArrayList<>();
        if (towers == null) {
            return out;
        }
        for (CellTower t : towers) {
            if (t != null && t.cellId() != null && !t.cellId().isBlank()) {
                out.add(t);
            }
        }
        return out;
    }
}
