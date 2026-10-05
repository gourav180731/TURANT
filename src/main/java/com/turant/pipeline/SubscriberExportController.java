package com.turant.pipeline;

import com.turant.security.SecurityService;
import com.turant.subscriber.GeoSubscriberTargetingService;
import com.turant.types.tower.CellTower;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Streaming CSV export of pipeline-matched subscriber MSISDNs.
 *
 * <p>{@code GET /api/v1/export/msisdns/{capIdentifier}?limit=N} reuses the
 * towers already resolved for a completed pipeline run and streams the
 * DISTINCT MSISDNs through the batch-staging targeting path straight to the
 * HTTP response — no in-memory aggregation of millions of strings
 * (server-side cursor + periodic flush). Nothing here changes CAP ingestion,
 * SMS formatting, or authentication: the same {@link SecurityService} gate
 * as the sibling pipeline endpoints applies.
 *
 * <p>{@code limit} is mandatory-bounded (default 1,000,000, max 10,000,000)
 * so one export cannot hold a connection indefinitely. MSISDN values are
 * never logged.
 */
@RestController
@RequestMapping("/api/v1/export")
public class SubscriberExportController {

    private static final Logger logger = LoggerFactory.getLogger(SubscriberExportController.class);

    private static final long DEFAULT_LIMIT = 1_000_000L;
    private static final long MAX_LIMIT = 10_000_000L;
    /** Preview offsets stay cheap only while small; deep OFFSET scans+discards. */
    private static final long MAX_OFFSET = 1_000_000L;
    private static final int FLUSH_EVERY = 5_000;

    private final PipelineStatusStore statusStore;
    private final GeoSubscriberTargetingService geoTargeting;
    private final SecurityService securityService;

    public SubscriberExportController(
            PipelineStatusStore statusStore,
            @Autowired(required = false) GeoSubscriberTargetingService geoTargeting,
            @Autowired(required = false) SecurityService securityService) {
        this.statusStore = statusStore;
        this.geoTargeting = geoTargeting;
        this.securityService = securityService;
    }

    // NOTE: no `produces` on the mapping — StreamingResponseBody is written
    // by ResourceHttpMessageConverter (any media type); declaring text/csv
    // up front breaks converter selection. The content type is set
    // explicitly on the success response below.
    // NOTE: streaming writes straight to the servlet output stream (no
    // HttpMessageConverter involved — converter selection cannot express
    // "already-serialized CSV bytes"). Pre-stream failures use standard
    // servlet error codes; the success body is text/csv.
    /**
     * Preview endpoint (verification only): first {@code limit} MSISDNs starting
     * at {@code offset}. Small offsets are cheap; deep offsets scan+discard and
     * are capped — use {@code /download} for the complete set.
     */
    @GetMapping(value = "/msisdns/{capIdentifier}")
    public void exportMsisdns(
            @PathVariable String capIdentifier,
            @RequestParam(required = false) Long limit,
            @RequestParam(required = false, defaultValue = "0") Long offset,
            HttpServletRequest httpReq,
            HttpServletResponse httpRes) throws IOException {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) {
                httpRes.sendError(sec.httpStatus(), sec.code() + ": " + sec.message());
                return;
            }
        }
        List<CellTower> towers = statusStore.getTowers(capIdentifier);
        if (towers == null || towers.isEmpty()) {
            httpRes.sendError(HttpStatus.NOT_FOUND.value(),
                    "TOWERS_NOT_FOUND: run the pipeline first: " + capIdentifier);
            return;
        }
        if (geoTargeting == null) {
            httpRes.sendError(HttpStatus.SERVICE_UNAVAILABLE.value(),
                    "TARGETING_UNAVAILABLE: real database required (not simulation mode)");
            return;
        }
        final long maxRows = limit == null ? DEFAULT_LIMIT
                : Math.max(1, Math.min(MAX_LIMIT, limit));
        final long off = offset == null ? 0 : Math.max(0, Math.min(MAX_OFFSET, offset));
        if (offset != null && offset > MAX_OFFSET) {
            httpRes.sendError(HttpStatus.BAD_REQUEST.value(),
                    "OFFSET_TOO_LARGE: preview offset capped at " + MAX_OFFSET + "; use /download for the full set");
            return;
        }
        final String safeId = capIdentifier.replaceAll("[^A-Za-z0-9_-]", "_");

        httpRes.setContentType("text/csv");
        httpRes.setCharacterEncoding(StandardCharsets.UTF_8.name());
        httpRes.setHeader(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"msisdns-" + safeId + ".csv\"");

        PrintWriter pw = new PrintWriter(
                new BufferedWriter(new OutputStreamWriter(
                        httpRes.getOutputStream(), StandardCharsets.UTF_8)), false);
        AtomicLong n = new AtomicLong(0);
        long t0 = System.currentTimeMillis();
        long heapBefore = heapUsedMb();
        pw.println("msisdn");
        pw.flush(); // commit response headers immediately: first CSV byte in ~1s
        AtomicLong firstRowMs = new AtomicLong(-1);
        try {
            // Bounded export path: LIMIT/OFFSET pushed into SQL over
            // deduplicated staging (no DISTINCT materialization, no Java set).
            geoTargeting.streamUniqueMsisdns(towers, msisdn -> {
                if (firstRowMs.get() < 0) {
                    firstRowMs.set(System.currentTimeMillis() - t0);
                }
                n.incrementAndGet();
                pw.println(msisdn);
                if (n.get() % FLUSH_EVERY == 0) {
                    pw.flush();
                }
            }, maxRows, off);
        } catch (GeoSubscriberTargetingService.TargetingException te) {
            logger.error("MSISDN preview failed for cap={}: {}", capIdentifier, te.getMessage());
            throw te;
        }
        pw.flush();
        long ms = System.currentTimeMillis() - t0;
        long rows = n.get();
        logger.info("MSISDN_EXPORT cap={} count={} offset={} dbStageAndReadMs~{} csvAndHttpMs~{} totalMs={} firstRowMs={} rate={}/s heapBeforeMb={} heapAfterMb={}",
                capIdentifier, rows, off, firstRowMs.get(), ms - Math.max(0, firstRowMs.get()), ms, firstRowMs.get(),
                ms == 0 ? rows : (rows * 1000 / ms), heapBefore, heapUsedMb());
    }

    /**
     * Download endpoint: streams the identified MSISDN set for a completed
     * pipeline run as CSV (or gzip CSV) via PostgreSQL {@code COPY TO STDOUT} —
     * bytes flow DB → socket with no per-row Java objects and flat heap.
     * Nothing is loaded into memory, nothing is rendered: save the response
     * body to disk.
     *
     * <p>Full set: {@code GET /api/v1/export/msisdns/1787287306181055/download}
     * <p>Batches (pagination applied <b>inside PostgreSQL</b>, never in Java):
     * {@code .../download?limit=3000000&offset=0} → rows 1–3,000,000,
     * {@code .../download?limit=3000000&offset=3000000} → rows 3,000,001–6,000,000, …
     * <p>Gzip variant: append {@code &gzip=true} (.csv.gz, ~6× smaller).
     */
    @GetMapping(value = "/msisdns/{capIdentifier}/download")
    public void downloadMsisdns(
            @PathVariable String capIdentifier,
            @RequestParam(required = false) Long limit,
            @RequestParam(required = false, defaultValue = "0") Long offset,
            @RequestParam(required = false, defaultValue = "false") boolean gzip,
            HttpServletRequest httpReq,
            HttpServletResponse httpRes) throws IOException {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) {
                httpRes.sendError(sec.httpStatus(), sec.code() + ": " + sec.message());
                return;
            }
        }
        List<CellTower> towers = statusStore.getTowers(capIdentifier);
        if (towers == null || towers.isEmpty()) {
            httpRes.sendError(HttpStatus.NOT_FOUND.value(),
                    "TOWERS_NOT_FOUND: run the pipeline first: " + capIdentifier);
            return;
        }
        if (geoTargeting == null) {
            httpRes.sendError(HttpStatus.SERVICE_UNAVAILABLE.value(),
                    "TARGETING_UNAVAILABLE: real database required (not simulation mode)");
            return;
        }
        final boolean paged = limit != null;
        final long batchLimit = !paged ? Long.MAX_VALUE : Math.max(1, Math.min(MAX_LIMIT, limit));
        final long batchOffset = offset == null ? 0 : Math.max(0, offset);
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        long expected = status != null && status.expectedRecipients() != null
                ? status.expectedRecipients() : -1;
        final String safeId = capIdentifier.replaceAll("[^A-Za-z0-9_-]", "_");

        String filename = paged
                ? "msisdns-" + safeId + "-offset-" + batchOffset + "-limit-" + batchLimit + (gzip ? ".csv.gz" : ".csv")
                : "msisdns-" + safeId + (gzip ? ".csv.gz" : ".csv");
        if (gzip) {
            httpRes.setContentType("application/gzip");
        } else {
            httpRes.setContentType("text/csv");
            httpRes.setCharacterEncoding(StandardCharsets.UTF_8.name());
        }
        httpRes.setHeader(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"");
        if (expected >= 0) {
            httpRes.setHeader("X-Msisdn-Expected", Long.toString(expected));
        }
        if (paged) {
            httpRes.setHeader("X-Msisdn-Offset", Long.toString(batchOffset));
            httpRes.setHeader("X-Msisdn-Limit", Long.toString(batchLimit));
        }

        long t0 = System.currentTimeMillis();
        long heapBefore = heapUsedMb();
        long rows;
        try (java.io.OutputStream raw = new java.io.BufferedOutputStream(httpRes.getOutputStream(), 65536);
             java.io.OutputStream body = gzip ? new java.util.zip.GZIPOutputStream(raw, 65536) : raw) {
            // COPY writes the CSV header itself; pagination lives in the
            // COPY's SELECT (LIMIT/OFFSET), so only batch rows cross into Java.
            rows = geoTargeting.exportCellMsisdnsCopy(towers, body, batchLimit, batchOffset);
            body.flush();
        } catch (GeoSubscriberTargetingService.TargetingException te) {
            logger.error("MSISDN download failed for cap={}: {}", capIdentifier, te.getMessage());
            throw te;
        }
        long ms = System.currentTimeMillis() - t0;
        long heapAfter = heapUsedMb();
        String verdict;
        if (!paged && expected >= 0) {
            verdict = rows == expected ? "MATCH" : "MISMATCH(expected=" + expected + ")";
        } else if (paged && expected >= 0) {
            long batchExpected = Math.max(0, Math.min(batchLimit, expected - batchOffset));
            verdict = rows == batchExpected ? "MATCH" : "MISMATCH(batchExpected=" + batchExpected + ")";
        } else {
            verdict = "UNVALIDATED";
        }
        logger.info("MSISDN_EXPORT cap={} count={} offset={} limit={} totalMs={} rate={}/s heapBeforeMb={} heapAfterMb={} gzip={} filename={} validation={}",
                capIdentifier, rows, paged ? batchOffset : 0, paged ? batchLimit : "full", ms,
                ms == 0 ? rows : (rows * 1000 / ms),
                heapBefore, heapAfter, gzip, filename, verdict);
    }

    private static long heapUsedMb() {
        Runtime rt = Runtime.getRuntime();
        return (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024);
    }

}
