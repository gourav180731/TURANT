package com.turant.subscriber;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Optimized per-cell subscriber access (migration 010).
 *
 * Turns the polygon alert's "how many subscribers are in this zone?" question
 * into a compact aggregate over the precomputed {@code cell_subscriber_stats}
 * table keyed by tower {@code cell_id} — instead of repeatedly scanning the
 * 100M+ row {@code subscriber_dump}. No MSISDNs are materialized just to
 * produce a recipient count; MSISDN streaming (real submit path) happens
 * lazily and only when SMSC credentials exist.
 * 
 * AUTHORITATIVE RELATIONSHIP (from migrations 008 and 010):
 *   subscriber_dump.serving_cell_id  →  sim_cell_towers.cell_id  →  cell_subscriber_stats.cell_id
 *   (FK: fk_subdump_serving_cell)       (UX: ux_sim_cell_towers_cell_id)     (PK)
 * 
 * So the JOIN key for subscriber stats is: tower.cell_id == cell_subscriber_stats.cell_id
 *
 * DETAILED DIAGNOSTICS:
 * On first invocation, probes the relationship to detect schema mismatches.
 * All SQL queries are logged at DEBUG level for auditability.
 * 
 * SIMULATION MODE:
 * When no database is configured, jdbcTemplate will be null and this service
 * will return 0 for all counts (suitable for simulation mode). However, in
 * REAL mode a null jdbcTemplate will cause a clear error in TowerResolver
 * before we ever reach this point.
 */
@Service
public class SubscriberCellStatsService implements DisposableBean {
    
    private static final Logger logger = LoggerFactory.getLogger(SubscriberCellStatsService.class);

    private final JdbcTemplate jdbcTemplate; // Can be null ONLY in simulation mode
    private final String simulationMode;
    private final boolean realMode;
    private final String statsTable;
    private final String cellCol;
    private final String countCol;
    private final String uniqueCol;
    // Authoritative raw subscriber table (subscriber_dump) — the complete real
    // source of truth the CAP pipeline must count against. cell_subscriber_stats
    // is only a DERIVED, possibly-partial aggregate of this table.
    private final String dumpTable;
    private final String dumpCellCol;
    private final String dumpMsisdnCol;

    // Precomputed per-cell aggregate table (turant_agg.cell_subscriber_agg).
    // Built ONCE from subscriber_dump as: (serving_cell_id, sub_count, distinct_count).
    // This turns the O(rows) count into O(cells) — the key optimization that lets a
    // 50k-cell / 100M-row zone count complete in milliseconds instead of minutes.
    private final String aggTable;
    private final String aggCellCol;
    private final String aggCountCol;
    private final String aggUniqueCol;

    // Parallelism for the indexed dump scans / MSISDN streaming. Bounded by the
    // Hikari pool (default 20) so we never exhaust connections.
    private final int parallelism;
    private final ExecutorService executor;

    /** Flag to run first-call diagnostics only once */
    private final AtomicBoolean diagnosticsRun = new AtomicBoolean(false);

    public SubscriberCellStatsService(
            @Autowired(required = false) JdbcTemplate jdbcTemplate,
            @Value("${simulation.mode:disabled}") String simulationMode,
            @Value("${turant.subscriber.stats-table:cell_subscriber_stats}") String statsTable,
            @Value("${turant.subscriber.stats-cell-col:cell_id}") String cellCol,
            @Value("${turant.subscriber.stats-count-col:subscriber_count}") String countCol,
            @Value("${turant.subscriber.stats-unique-col:unique_subscriber_count}") String uniqueCol,
            @Value("${turant.subscriber.dump-table:subscriber_dump}") String dumpTable,
            @Value("${turant.subscriber.dump-cell-col:serving_cell_id}") String dumpCellCol,
            @Value("${turant.subscriber.dump-msisdn-col:msisdn}") String dumpMsisdnCol,
            @Value("${turant.subscriber.agg-table:turant_agg.cell_subscriber_agg}") String aggTable,
            @Value("${turant.subscriber.agg-cell-col:serving_cell_id}") String aggCellCol,
            @Value("${turant.subscriber.agg-count-col:sub_count}") String aggCountCol,
            @Value("${turant.subscriber.agg-unique-col:distinct_count}") String aggUniqueCol,
            @Value("${turant.subscriber.parallelism:16}") int parallelism) {
        this.jdbcTemplate = jdbcTemplate;
        this.simulationMode = simulationMode;
        this.realMode = !"enabled".equalsIgnoreCase(simulationMode);
        this.statsTable = statsTable;
        this.cellCol = cellCol;
        this.countCol = countCol;
        this.uniqueCol = uniqueCol;
        this.dumpTable = dumpTable;
        this.dumpCellCol = dumpCellCol;
        this.dumpMsisdnCol = dumpMsisdnCol;
        this.aggTable = aggTable;
        this.aggCellCol = aggCellCol;
        this.aggCountCol = aggCountCol;
        this.aggUniqueCol = aggUniqueCol;
        this.parallelism = Math.max(1, parallelism);
        this.executor = (jdbcTemplate == null) ? null
                : Executors.newFixedThreadPool(this.parallelism, r -> {
                    Thread t = new Thread(r, "sub-agg-worker");
                    t.setDaemon(true);
                    return t;
                });

        if (jdbcTemplate == null) {
            if (realMode) {
                logger.error("============================================================");
                logger.error("REAL MODE ASSERTION FAILED: SubscriberCellStatsService has JdbcTemplate=null");
                logger.error("  BUT simulation.mode={} (REAL MODE is active)!", simulationMode);
                logger.error("  This is NOT acceptable. The pipeline MUST have real DB access in REAL mode.");
                logger.error("  Check that:");
                logger.error("    1. DATABASE_URL is set in environment");
                logger.error("    2. spring.datasource.url in application.properties is set");
                logger.error("    3. PostgreSQL is running and reachable");
                logger.error("    4. DatabaseConfig.dataSource() bean created successfully (check logs)");
                logger.error("============================================================");
                throw new IllegalStateException(
                    "REAL MODE: SubscriberCellStatsService has no JdbcTemplate. " +
                    "simulation.mode='" + simulationMode + "' (REAL MODE). " +
                    "Cannot return fake subscriber counts. Configure PostgreSQL/DATABASE_URL."
                );
            } else {
                logger.warn("SubscriberCellStatsService: JdbcTemplate NOT INJECTED. " +
                    "All subscriber counts will return 0. simulation.mode={} (SIMULATION MODE).", simulationMode);
            }
        } else {
            logger.info("============================================================");
            logger.info("SubscriberCellStatsService INITIALIZED (REAL DB ACCESS):");
            logger.info("  simulation.mode = {}", simulationMode);
            logger.info("  realMode active = {}", realMode);
            logger.info("  statsTable      = {} (cell_col={}, count_col={}, unique_col={})",
                statsTable, cellCol, countCol, uniqueCol);
            logger.info("  dumpTable       = {} (cell_col={}, msisdn_col={}) [SECONDARY real source, parallel scan]",
                dumpTable, dumpCellCol, dumpMsisdnCol);
            logger.info("  aggTable        = {} (cell_col={}, count_col={}, unique_col={}) [PRIMARY instant source]",
                aggTable, aggCellCol, aggCountCol, aggUniqueCol);
            logger.info("  parallelism     = {} (parallel indexed scan / MSISDN streaming)",
                this.parallelism);
            logger.info("  JdbcTemplate    = AVAILABLE");
            logger.info("============================================================");
        }
    }

    /** Release the parallel worker pool on shutdown. */
    @Override
    public void destroy() {
        if (executor != null && !executor.isShutdown()) {
            executor.shutdownNow();
            try {
                executor.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Total subscribers across the given cell ids (REAL data only).
     *
     * Strategy (all REAL, no simulation, no fabrication):
     *   1. PRIMARY: count rows in the authoritative {dumpTable}
     *      (subscriber_dump) where {dumpCellCol} (serving_cell_id) IN (...).
     *      This is the complete raw subscriber dataset and is the source the
     *      CAP pipeline must reflect.
     *   2. FALLBACK: if the dump yields nothing but {statsTable}
     *      (cell_subscriber_stats) has matching rows, use its precomputed
     *      SUM({countCol}). This keeps the derived aggregate path alive without
     *      ever inventing numbers.
     */
    public long countByCellIds(List<String> cellIds) {
        if (jdbcTemplate == null) {
            if (realMode) {
                logger.error("REAL MODE ASSERTION FAILED: countByCellIds() called with JdbcTemplate=null AND simulation.mode={} (REAL MODE)! " +
                    "Throwing exception — will NOT fabricate 0 subscribers in REAL mode.", simulationMode);
                throw new IllegalStateException(
                    "REAL MODE: countByCellIds has no JdbcTemplate (simulation.mode='" + simulationMode + "'). " +
                    "Cannot fabricate subscriber counts."
                );
            }
            logger.warn("countByCellIds: JdbcTemplate=null, returning 0 (SIMULATION MODE only)");
            return 0;
        }

        runFirstCallDiagnostics(cellIds);

        if (cellIds == null || cellIds.isEmpty()) {
            logger.warn("countByCellIds: EMPTY cellIds list, returning 0");
            return 0;
        }

        // ---- PRIMARY: subscriber_dump (authoritative raw data) ----
        long dumpTotal = aggregateOverDump(cellIds)[0];
        if (dumpTotal > 0) {
            logger.info("countByCellIds RESULT (source={}, PRIMARY): {} cell_ids → {} subscriber rows",
                dumpTable, cellIds.size(), dumpTotal);
            return dumpTotal;
        }

        // ---- FALLBACK: cell_subscriber_stats (derived aggregate) ----
        long statsTotal = aggregateOverStats(cellIds)[0];
        if (statsTotal > 0) {
            logger.info("countByCellIds RESULT (source={}, FALLBACK): {} cell_ids → SUM({})={}",
                statsTable, cellIds.size(), countCol, statsTotal);
            return statsTotal;
        }

        // ---- Neither source has data for these cells — diagnose clearly ----
        logger.error("============================================================");
        logger.error("SUBSCRIBER MATCH DIAGNOSTICS");
        logger.error("  sourceUsed         = NONE (no matches in {} or {})", dumpTable, statsTable);
        logger.error("  towerCellIds       = {}", cellIds.size());
        logger.error("  statsMatches       = 0");
        logger.error("  sampleTowerCellIds = {}", cellIds.subList(0, Math.min(10, cellIds.size())));
        logger.error("  sampleStatsCellIds = {}", sampleCellIdsFrom(statsTable, cellCol));
        logger.error("  sampleDumpCellIds  = {}", sampleCellIdsFrom(dumpTable, dumpCellCol));
        logger.error("  subscriberSum      = 0");
        logger.error("  >> The REAL towers selected by this CAP genuinely have 0 subscribers");
        logger.error("     in both the raw dump and the precomputed stats. This is NOT a bug");
        logger.error("     unless the tower cell_ids are wrong/mis-mapped.");
        logger.error("============================================================");
        return 0;
    }

    /**
     * Distinct subscriber count across the given cell ids (REAL data only).
     *
     * PRIMARY: COUNT(DISTINCT {dumpMsisdnCol}) over {dumpTable}.
     * FALLBACK: SUM({uniqueCol}) over {statsTable}.
     */
    public long uniqueCountByCellIds(List<String> cellIds) {
        if (jdbcTemplate == null) {
            if (realMode) {
                logger.error("REAL MODE ASSERTION FAILED: uniqueCountByCellIds() called with JdbcTemplate=null AND simulation.mode={} (REAL MODE)! " +
                    "Throwing exception — will NOT fabricate 0 in REAL mode.", simulationMode);
                throw new IllegalStateException(
                    "REAL MODE: uniqueCountByCellIds has no JdbcTemplate (simulation.mode='" + simulationMode + "'). " +
                    "Cannot fabricate unique subscriber counts."
                );
            }
            logger.warn("uniqueCountByCellIds: JdbcTemplate=null, returning 0 (SIMULATION MODE only)");
            return 0;
        }

        if (cellIds == null || cellIds.isEmpty()) {
            return 0;
        }

        long dumpUnique = aggregateOverDump(cellIds)[1];
        if (dumpUnique > 0) {
            logger.info("uniqueCountByCellIds RESULT (source={}, PRIMARY): {} cell_ids → distinct {} = {}",
                dumpTable, cellIds.size(), dumpMsisdnCol, dumpUnique);
            return dumpUnique;
        }

        long statsUnique = aggregateOverStats(cellIds)[1];
        if (statsUnique > 0) {
            logger.info("uniqueCountByCellIds RESULT (source={}, FALLBACK): {} cell_ids → SUM({})={}",
                statsTable, cellIds.size(), uniqueCol, statsUnique);
            return statsUnique;
        }

        logger.info("uniqueCountByCellIds RESULT: no distinct subscribers found for {} cell_ids", cellIds.size());
        return 0;
    }

    /**
     * Combined single-pass lookup returning BOTH the total matched subscriber
     * rows and the distinct subscriber count for the given cell ids.
     *
     * Strategy (all REAL, no simulation, no fabrication):
     *   1. PRIMARY: one query over the authoritative {dumpTable}
     *      (subscriber_dump) — SELECT COUNT(*), COUNT(DISTINCT {dumpMsisdnCol})
     *      WHERE {dumpCellCol} (serving_cell_id) IN (...). This is the complete
     *      raw subscriber dataset and is the source the CAP pipeline must reflect.
     *   2. FALLBACK: if the dump yields nothing but {statsTable}
     *      (cell_subscriber_stats) has matching rows, use its precomputed
     *      SUM({countCol}) and SUM({uniqueCol}). This keeps the derived
     *      aggregate path alive without ever inventing numbers.
     *
     * Doing both aggregates in a SINGLE pass over the data halves the query
     * cost compared to calling countByCellIds + uniqueCountByCellIds separately.
     *
     * @return long[0] = total subscriber rows matched, long[1] = distinct subscribers
     */
    public long[] countAndDistinctByCellIds(List<String> cellIds) {
        if (jdbcTemplate == null) {
            if (realMode) {
                logger.error("REAL MODE ASSERTION FAILED: countAndDistinctByCellIds() called with JdbcTemplate=null " +
                    "AND simulation.mode={} (REAL MODE)! Throwing exception — will NOT fabricate 0 subscribers.", simulationMode);
                throw new IllegalStateException(
                    "REAL MODE: countAndDistinctByCellIds has no JdbcTemplate (simulation.mode='" + simulationMode + "').");
            }
            logger.warn("countAndDistinctByCellIds: JdbcTemplate=null, returning 0 (SIMULATION MODE only)");
            return new long[] { 0L, 0L };
        }

        if (cellIds == null || cellIds.isEmpty()) {
            logger.warn("countAndDistinctByCellIds: EMPTY cellIds list, returning 0");
            return new long[] { 0L, 0L };
        }

        // ---- PRIMARY: precomputed per-cell aggregate (turant_agg.cell_subscriber_agg) ----
        // O(cells) lookup — the key optimization: a 50k-cell / 100M-row zone counts
        // in milliseconds instead of scanning the raw dump. This is the COMPLETE
        // source because the aggregate is built from ALL of subscriber_dump.
        long[] agg = aggregateOverAggTable(cellIds);
        if (agg[0] > 0) {
            logger.info("countAndDistinctByCellIds RESULT (source={}, PRIMARY aggregate): {} cell_ids → " +
                "total={}, distinct={}", aggTable, cellIds.size(), agg[0], agg[1]);
            return agg;
        }

        // ---- SECONDARY: subscriber_dump (authoritative raw data), parallel scan ----
        // Used only if the aggregate table is empty/unavailable. Runs chunked IN()
        // queries concurrently across the worker pool using the serving_cell_id index.
        long[] dump = parallelAggregateOverDump(cellIds);
        if (dump[0] > 0) {
            logger.info("countAndDistinctByCellIds RESULT (source={}, SECONDARY parallel dump): {} cell_ids → " +
                "total={}, distinct={}", dumpTable, cellIds.size(), dump[0], dump[1]);
            return dump;
        }

        // ---- FALLBACK: cell_subscriber_stats (derived aggregate) ----
        long[] stats = aggregateOverStats(cellIds);
        if (stats[0] > 0) {
            logger.info("countAndDistinctByCellIds RESULT (source={}, FALLBACK): {} cell_ids → " +
                "total SUM({})={}, distinct SUM({})={}", statsTable, cellIds.size(), countCol, stats[0], uniqueCol, stats[1]);
            return stats;
        }

        // ---- Neither source has data — diagnose clearly ----
        logger.error("============================================================");
        logger.error("SUBSCRIBER MATCH DIAGNOSTICS");
        logger.error("  sourceUsed         = NONE (no matches in {} or {})", dumpTable, statsTable);
        logger.error("  towerCellIds       = {}", cellIds.size());
        logger.error("  statsMatches       = 0");
        logger.error("  sampleTowerCellIds = {}", cellIds.subList(0, Math.min(10, cellIds.size())));
        logger.error("  sampleStatsCellIds = {}", sampleCellIdsFrom(statsTable, cellCol));
        logger.error("  sampleDumpCellIds  = {}", sampleCellIdsFrom(dumpTable, dumpCellCol));
        logger.error("  subscriberSum      = 0");
        logger.error("  >> The REAL towers selected by this CAP genuinely have 0 subscribers");
        logger.error("     in both the raw dump and the precomputed stats. This is NOT a bug");
        logger.error("     unless the tower cell_ids are wrong/mis-mapped.");
        logger.error("============================================================");
        return new long[] { 0L, 0L };
    }

    /** [SUM(countCol), SUM(uniqueCol)] over cell_subscriber_stats. */
    private long[] aggregateOverStats(List<String> cellIds) {
        long total = 0;
        long distinct = 0;
        int chunkNum = 0;
        for (List<String> chunk : chunk(cellIds, 500)) {
            chunkNum++;
            String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
            String sql = "SELECT COALESCE(SUM(" + countCol + "),0) AS total, COALESCE(SUM(" + uniqueCol + "),0) AS dtotal FROM " + statsTable
                + " WHERE " + cellCol + " IN (" + placeholders + ")";
            try {
                Map<String, Object> row = jdbcTemplate.queryForMap(sql, chunk.toArray());
                total += toLong(row.get("total"));
                distinct += toLong(row.get("dtotal"));
            } catch (Exception e) {
                logger.warn("aggregateOverStats chunk[{}] failed (non-fatal): {}", chunkNum, e.getMessage());
            }
        }
        return new long[] { total, distinct };
    }

    /** [COUNT(*), COUNT(DISTINCT msisdn)] over the authoritative subscriber_dump. */
    private long[] aggregateOverDump(List<String> cellIds) {
        long total = 0;
        long distinct = 0;
        int chunkNum = 0;
        for (List<String> chunk : chunk(cellIds, 500)) {
            chunkNum++;
            String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
            String sql = "SELECT COUNT(*) AS c, COUNT(DISTINCT " + dumpMsisdnCol + ") AS d FROM " + dumpTable
                + " WHERE " + dumpCellCol + " IN (" + placeholders + ")";
            try {
                if (logger.isDebugEnabled()) {
                    logger.debug("aggregateOverDump chunk[{}] SQL: {}", chunkNum, sql);
                }
                Map<String, Object> row = jdbcTemplate.queryForMap(sql, chunk.toArray());
                long chunkTotal = toLong(row.get("c"));
                long chunkDistinct = toLong(row.get("d"));
                total += chunkTotal;
                distinct += chunkDistinct;
                if (chunkTotal > 0) {
                    logger.info("  [dump] chunk[{}]: {} cell_ids → total={}, distinct={}",
                        chunkNum, chunk.size(), chunkTotal, chunkDistinct);
                }
            } catch (Exception e) {
                logger.warn("aggregateOverDump chunk[{}] failed (non-fatal): {}", chunkNum, e.getMessage());
            }
        }
        return new long[] { total, distinct };
    }

    /**
     * [SUM(sub_count), SUM(distinct_count)] over the precomputed aggregate table.
     * One cheap indexed lookup per chunk of cells — effectively O(cells).
     */
    private long[] aggregateOverAggTable(List<String> cellIds) {
        long total = 0;
        long distinct = 0;
        int chunkNum = 0;
        for (List<String> chunk : chunk(cellIds, 2000)) {
            chunkNum++;
            String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
            String sql = "SELECT COALESCE(SUM(" + aggCountCol + "),0) AS total, COALESCE(SUM(" + aggUniqueCol + "),0) AS dtotal FROM " + aggTable
                + " WHERE " + aggCellCol + " IN (" + placeholders + ")";
            try {
                Map<String, Object> row = jdbcTemplate.queryForMap(sql, chunk.toArray());
                total += toLong(row.get("total"));
                distinct += toLong(row.get("dtotal"));
            } catch (Exception e) {
                // Aggregate table may not be built yet — fall through to dump path.
                logger.warn("aggregateOverAggTable chunk[{}] failed (will try dump): {}", chunkNum, e.getMessage());
                return new long[] { -1L, -1L }; // signal caller to fall back
            }
        }
        return new long[] { total, distinct };
    }

    /**
     * Parallel indexed scan of the authoritative subscriber_dump for the given cells.
     * Each chunk is a concurrent COUNT(*), COUNT(DISTINCT msisdn) query using the
     * serving_cell_id index. Results are summed. Bounded by the worker pool so we
     * never exhaust Hikari connections.
     */
    private long[] parallelAggregateOverDump(List<String> cellIds) {
        long total = 0;
        long distinct = 0;
        List<List<String>> chunks = chunk(cellIds, 500);
        if (chunks.isEmpty()) return new long[] { 0L, 0L };

        int threads = Math.min(parallelism, chunks.size());
        if (threads <= 1) {
            for (List<String> c : chunks) {
                long[] r = aggregateOverDumpChunk(c);
                total += r[0]; distinct += r[1];
            }
            return new long[] { total, distinct };
        }

        List<java.util.concurrent.Future<long[]>> futures = new ArrayList<>();
        for (List<String> c : chunks) {
            futures.add(executor.submit(() -> aggregateOverDumpChunk(c)));
        }
        for (var f : futures) {
            try {
                long[] r = f.get();
                total += r[0]; distinct += r[1];
            } catch (Exception e) {
                logger.warn("parallelAggregateOverDump chunk failed (non-fatal): {}", e.getMessage());
            }
        }
        return new long[] { total, distinct };
    }

    /** Single-chunk COUNT(*), COUNT(DISTINCT msisdn) over subscriber_dump. */
    private long[] aggregateOverDumpChunk(List<String> chunk) {
        String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
        String sql = "SELECT COUNT(*) AS c, COUNT(DISTINCT " + dumpMsisdnCol + ") AS d FROM " + dumpTable
            + " WHERE " + dumpCellCol + " IN (" + placeholders + ")";
        try {
            Map<String, Object> row = jdbcTemplate.queryForMap(sql, chunk.toArray());
            return new long[] { toLong(row.get("c")), toLong(row.get("d")) };
        } catch (Exception e) {
            logger.warn("aggregateOverDumpChunk failed (non-fatal): {}", e.getMessage());
            return new long[] { 0L, 0L };
        }
    }

    /**
     * Identify (stream) the distinct mobile numbers for the target cell ids.
     *
     * This is the core mandate: given ~50k target cells, return the corresponding
     * mobile numbers. Implemented as a PARALLEL indexed scan over subscriber_dump
     * (serving_cell_id index), with each matched MSISDN pushed to the supplied
     * consumer. Streaming (rather than collecting into a List) keeps memory bounded
     * even for tens of millions of numbers; the consumer typically writes to the
     * SMSC delivery buffer / a file.
     *
     * @return total number of MSISDN rows streamed (non-distinct; use a Set-backed
     *         consumer if de-duplication is required, or call distinctMsisdnCount()).
     */
    public long forEachMsisdn(List<String> cellIds, Consumer<String> sink) {
        if (jdbcTemplate == null) {
            if (realMode) throw new IllegalStateException("REAL MODE: forEachMsisdn has no JdbcTemplate.");
            return 0;
        }
        if (cellIds == null || cellIds.isEmpty()) return 0;

        List<List<String>> chunks = chunk(cellIds, 500);
        if (chunks.isEmpty()) return 0;

        AtomicLong streamed = new AtomicLong(0);
        int threads = Math.min(parallelism, chunks.size());
        if (threads <= 1) {
            for (List<String> c : chunks) streamed.addAndGet(forEachMsisdnChunk(c, sink));
            return streamed.get();
        }
        List<java.util.concurrent.Future<Long>> futures = new ArrayList<>();
        for (List<String> c : chunks) {
            final List<String> fc = c;
            futures.add(executor.submit(() -> forEachMsisdnChunk(fc, sink)));
        }
        for (var f : futures) {
            try { streamed.addAndGet(f.get()); } catch (Exception e) {
                logger.warn("forEachMsisdn chunk failed (non-fatal): {}", e.getMessage());
            }
        }
        return streamed.get();
    }

    private long forEachMsisdnChunk(List<String> chunk, Consumer<String> sink) {
        String placeholders = String.join(",", Collections.nCopies(chunk.size(), "?"));
        String sql = "SELECT DISTINCT " + dumpMsisdnCol + " FROM " + dumpTable
            + " WHERE " + dumpCellCol + " IN (" + placeholders + ")";
        try {
            AtomicLong n = new AtomicLong(0);
            jdbcTemplate.query(sql, (rs) -> {
                String msisdn = rs.getString(1);
                if (msisdn != null) { sink.accept(msisdn); n.incrementAndGet(); }
            }, chunk.toArray());
            return n.get();
        } catch (Exception e) {
            logger.warn("forEachMsisdnChunk failed (non-fatal): {}", e.getMessage());
            return 0L;
        }
    }

    /**
     * Distinct mobile-number COUNT for the target cells — instant via the
     * precomputed aggregate table (SUM of distinct_count). If the aggregate table
     * is unavailable, falls back to a parallel COUNT(DISTINCT) scan of the dump.
     */
    public long distinctMsisdnCount(List<String> cellIds) {
        if (cellIds == null || cellIds.isEmpty()) return 0;
        long[] agg = aggregateOverAggTable(cellIds);
        if (agg[1] > 0) return agg[1];
        return parallelAggregateOverDump(cellIds)[1];
    }

    /** Collect distinct mobile numbers into a thread-safe Set (use for modest sets). */
    public Set<String> collectMsisdns(List<String> cellIds) {
        Set<String> out = ConcurrentHashMap.newKeySet();
        forEachMsisdn(cellIds, out::add);
        return out;
    }

    private static long toLong(Object o) {
        if (o == null) return 0L;
        return ((Number) o).longValue();
    }

    private List<String> sampleCellIdsFrom(String table, String col) {
        try {
            List<String> sample = jdbcTemplate.query(
                "SELECT " + col + " FROM " + table + " WHERE " + col + " IS NOT NULL LIMIT 10",
                (rs, rn) -> rs.getString(1));
            return sample != null ? sample : List.of();
        } catch (Exception e) {
            return List.of("(error sampling " + table + "." + col + ")");
        }
    }
    
    // ========================================================================
    // DIAGNOSTIC METHODS — run once on first call + when matchedCount=0
    // ========================================================================
    
    private void runFirstCallDiagnostics(List<String> sampleCellIds) {
        if (!diagnosticsRun.compareAndSet(false, true)) {
            return; // Already ran
        }
        
        try {
            logger.info("============================================================");
            logger.info("SubscriberCellStatsService FIRST-CALL DIAGNOSTICS:");
            logger.info("============================================================");
            
            Integer statsRows = null;
            Object globalSubscriberSum = null;
            Object globalUniqueSum = null;
            List<String> sampleStatsCellIds = null;
            
            // 1. Check stats table row count
            try {
                statsRows = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM " + statsTable, Integer.class);
                logger.info("  1. cell_subscriber_stats TOTAL ROWS: {}", statsRows);
            } catch (Exception e) {
                logger.error("  1. FAILED to count stats table rows: {}", e.getMessage());
            }
            
            // 2. Check global SUMs
            try {
                var row = jdbcTemplate.queryForMap(
                    "SELECT COALESCE(SUM(" + countCol + "),0) AS gcount, " +
                    "COALESCE(SUM(" + uniqueCol + "),0) AS gunique FROM " + statsTable);
                globalSubscriberSum = row.get("gcount");
                globalUniqueSum = row.get("gunique");
                logger.info("  2. Global SUM({}) = {}, Global SUM({}) = {}",
                    countCol, globalSubscriberSum, uniqueCol, globalUniqueSum);
            } catch (Exception e) {
                logger.error("  2. FAILED to compute global SUMs: {}", e.getMessage());
            }
            
            // 3. Sample of cell_ids in the stats table (for comparison with tower cell_ids)
            try {
                sampleStatsCellIds = jdbcTemplate.query(
                    "SELECT " + cellCol + " FROM " + statsTable + " ORDER BY RANDOM() LIMIT 10",
                    (rs, rn) -> rs.getString(1));
                logger.info("  3. Sample {} cell_ids FROM STATS TABLE {}.{}: {}",
                    sampleStatsCellIds.size(), statsTable, cellCol, sampleStatsCellIds);
            } catch (Exception e) {
                logger.error("  3. FAILED to sample stats cell_ids: {}", e.getMessage());
            }
            
            // 4. If we have sample input cell_ids, show how many match
            if (sampleCellIds != null && !sampleCellIds.isEmpty()) {
                logMatchDiagnostics(
                    sampleCellIds.subList(0, Math.min(10, sampleCellIds.size())),
                    -1, -1
                );
            }
            
            logger.info("============================================================");
            
        } catch (Exception e) {
            logger.error("First-call diagnostics failed", e);
        }
    }
    
    /**
     * Detailed diagnostics: exactly how many of the input cell_ids match rows
     * in the stats table? Logs match count and sample matches/mismatches.
     * This is the KEY diagnostic for matchedCount=0.
     * 
     * EXACT FORMAT:
     *   SUBSCRIBER MATCH DIAGNOSTICS
     *   towerCellIds=N
     *   statsMatches=M
     *   sampleTowerCellIds=[...]
     *   sampleStatsCellIds=[...]
     *   subscriberSum=S
     */
    private void logMatchDiagnostics(List<String> cellIds, int statsMatchesParam, long subscriberSumParam) {
        if (jdbcTemplate == null || cellIds.isEmpty()) return;
        
        try {
            List<String> probe = cellIds.size() > 100 
                ? new ArrayList<>(cellIds).subList(0, 100) 
                : cellIds;
            
            String placeholders = String.join(",", Collections.nCopies(probe.size(), "?"));
            
            // How many input cell_ids exist in the stats table?
            String matchCountSql = "SELECT COUNT(*) FROM " + statsTable + 
                " WHERE " + cellCol + " IN (" + placeholders + ")";
            Integer matched = jdbcTemplate.queryForObject(matchCountSql, Integer.class, probe.toArray());
            
            // Compute subscriber sum for the probe
            String subscriberSumSql = "SELECT COALESCE(SUM(" + countCol + "),0) FROM " + statsTable + 
                " WHERE " + cellCol + " IN (" + placeholders + ")";
            Long probeSubscriberSum = jdbcTemplate.queryForObject(subscriberSumSql, Long.class, probe.toArray());
            
            // Collect sample stats cell_ids for comparison
            List<String> sampleStatsCellIds;
            try {
                sampleStatsCellIds = jdbcTemplate.query(
                    "SELECT " + cellCol + " FROM " + statsTable + " LIMIT 10",
                    (rs, rn) -> rs.getString(1));
            } catch (Exception e) {
                sampleStatsCellIds = List.of("(error sampling stats)");
            }
            
            int towerCellIdsCount = cellIds.size();
            int statsMatches = statsMatchesParam >= 0 ? statsMatchesParam : (matched != null ? matched : 0);
            long subscriberSum = subscriberSumParam >= 0 ? subscriberSumParam : (probeSubscriberSum != null ? probeSubscriberSum : 0L);
            
            // ============================================================
            // EXACT DIAGNOSTIC FORMAT REQUIRED BY SPEC
            // ============================================================
            logger.error("============================================================");
            logger.error("SUBSCRIBER MATCH DIAGNOSTICS");
            logger.error("  towerCellIds         = {}", towerCellIdsCount);
            logger.error("  statsMatches         = {}", statsMatches);
            logger.error("  sampleTowerCellIds   = {}", probe.subList(0, Math.min(10, probe.size())));
            logger.error("  sampleStatsCellIds   = {}", sampleStatsCellIds);
            logger.error("  subscriberSum        = {}", subscriberSum);
            logger.error("------------------------------------------------------------");
            logger.error("Probe size: {} cell_ids, {} matched in {}.{}", probe.size(), 
                matched != null ? matched : "?", statsTable, cellCol);
            logger.error("------------------------------------------------------------");
            
            // Show a few that DID match (if any)
            if (matched != null && matched > 0) {
                String sampleMatchSql = "SELECT " + cellCol + ", " + countCol + ", " + uniqueCol +
                    " FROM " + statsTable + 
                    " WHERE " + cellCol + " IN (" + placeholders + ") LIMIT 5";
                List<Map<String, Object>> sampleRows = jdbcTemplate.queryForList(
                    sampleMatchSql, probe.toArray());
                logger.error("  Sample MATCHING stats rows: {}", sampleRows);
            }
            
            // Count null/blank input cell_ids
            int nullOrBlank = 0;
            for (String s : probe) {
                if (s == null || s.isBlank()) nullOrBlank++;
            }
            if (nullOrBlank > 0) {
                logger.error("  {} probe cell_ids were null/blank", nullOrBlank);
            }
            
            // Format comparison
            String firstInputCell = probe.get(0);
            logger.error("  First input tower cell_id: '{}'", firstInputCell);
            logger.error("  Format comparison: tower = '{}'  vs  stats sample first = '{}'",
                firstInputCell, sampleStatsCellIds.isEmpty() ? "N/A" : sampleStatsCellIds.get(0));
            
            // Fuzzy: any stats row starting/ending with same pattern?
            try {
                String[] parts = firstInputCell.split("-");
                if (parts.length >= 2) {
                    String last2 = parts[parts.length - 1];
                    List<String> fuzzy = jdbcTemplate.query(
                        "SELECT " + cellCol + " FROM " + statsTable + 
                            " WHERE CAST(" + cellCol + " AS TEXT) LIKE ? LIMIT 5",
                        (rs, rn) -> rs.getString(1),
                        "%" + last2 + "%"
                    );
                    if (!fuzzy.isEmpty()) {
                        logger.error("  Fuzzy match (ending '{}'): {}", last2, fuzzy);
                    }
                }
            } catch (Exception e2) {
                logger.error("  Fuzzy diagnostic: {}", e2.getMessage());
            }
            
            logger.error("============================================================");
            
        } catch (Exception e) {
            logger.error("Match diagnostics failed: {}", e.getMessage(), e);
        }
    }

    private static List<List<String>> chunk(List<String> values, int size) {
        List<List<String>> chunks = new ArrayList<>();
        for (int i = 0; i < values.size(); i += size) {
            chunks.add(values.subList(i, Math.min(i + size, values.size())));
        }
        return chunks;
    }
}
