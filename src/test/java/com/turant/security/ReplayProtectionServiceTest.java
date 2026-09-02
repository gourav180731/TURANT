package com.turant.security;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import javax.sql.DataSource;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Layer 6 — Replay Protection tests.
 * Duplicate submission detection, concurrent duplicate race condition handling.
 */
class ReplayProtectionServiceTest {

    private ReplayProtectionService service;
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void setUp() {
        DataSource ds = new EmbeddedDatabaseBuilder()
                .setType(EmbeddedDatabaseType.H2)
                .build();
        jdbcTemplate = new JdbcTemplate(ds);
        jdbcTemplate.execute("""
            CREATE TABLE IF NOT EXISTS cap_replay (
                cap_identifier VARCHAR(128) NOT NULL,
                sender VARCHAR(256) NOT NULL,
                first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                cap_hash VARCHAR(128) NOT NULL,
                source_ip VARCHAR(64),
                client_id VARCHAR(128),
                PRIMARY KEY (cap_identifier, sender)
            )
        """);
        service = new ReplayProtectionService(jdbcTemplate);
    }

    @Test
    void firstSubmission_accepted() {
        var res = service.checkAndMark("ALERT-100", "sender-1", "<alert>100</alert>", "127.0.0.1", "tsp-a");
        assertEquals(ReplayProtectionService.ReplayResult.NOT_REPLAY, res);
        assertTrue(service.isReplay("ALERT-100", "sender-1"));
    }

    @Test
    void duplicateSubmission_detectedAsReplay() {
        service.checkAndMark("ALERT-200", "sender-1", "<alert>200</alert>", "127.0.0.1", "tsp-a");
        var res2 = service.checkAndMark("ALERT-200", "sender-1", "<alert>200</alert>", "127.0.0.1", "tsp-a");
        assertEquals(ReplayProtectionService.ReplayResult.REPLAY_DETECTED, res2);
    }

    @Test
    void differentSender_sameCapId_accepted() {
        var res1 = service.checkAndMark("ALERT-300", "sender-A", "<alert>300</alert>", "127.0.0.1", "tsp-a");
        var res2 = service.checkAndMark("ALERT-300", "sender-B", "<alert>300</alert>", "127.0.0.1", "tsp-b");
        assertEquals(ReplayProtectionService.ReplayResult.NOT_REPLAY, res1);
        assertEquals(ReplayProtectionService.ReplayResult.NOT_REPLAY, res2);
    }

    @Test
    void concurrentDuplicateSubmissions_onlyOneAccepted() throws Exception {
        String capId = "ALERT-CONCURRENT-RACE";
        String sender = "sender-race";
        String capXml = "<alert>race</alert>";

        int threads = 10;
        ExecutorService executor = Executors.newFixedThreadPool(threads);
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch doneLatch = new CountDownLatch(threads);

        AtomicInteger accepted = new AtomicInteger(0);
        AtomicInteger rejected = new AtomicInteger(0);

        for (int i = 0; i < threads; i++) {
            executor.submit(() -> {
                try {
                    startLatch.await();
                    var res = service.checkAndMark(capId, sender, capXml, "127.0.0.1", "tsp-a");
                    if (res == ReplayProtectionService.ReplayResult.NOT_REPLAY) {
                        accepted.incrementAndGet();
                    } else if (res == ReplayProtectionService.ReplayResult.REPLAY_DETECTED) {
                        rejected.incrementAndGet();
                    }
                } catch (Exception ignore) {
                } finally {
                    doneLatch.countDown();
                }
            });
        }

        startLatch.countDown(); // start all threads simultaneously
        doneLatch.await();
        executor.shutdown();

        assertEquals(1, accepted.get(), "Exactly ONE submission must be accepted in a concurrent race");
        assertEquals(threads - 1, rejected.get(), "All other concurrent submissions must be flagged as REPLAY_DETECTED");
    }
}
