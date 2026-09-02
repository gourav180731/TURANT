package com.turant.security;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Layer 9 — Rate Limiting tests.
 * Token bucket, burst quota, concurrency thread-safety.
 */
class RateLimitServiceTest {

    private final RateLimitService rateLimit = new RateLimitService();

    @Test
    void withinLimit_allowed() {
        String client = "test-client-1";
        String endpoint = "/api/v1/pipeline/trigger-by-cap";
        for (int i = 0; i < 5; i++) {
            assertTrue(rateLimit.tryAcquire(client, endpoint, 5));
        }
    }

    @Test
    void exceedsLimit_rejected() {
        String client = "test-client-2";
        String endpoint = "/api/v1/pipeline/trigger-by-cap";
        int limit = 3;
        for (int i = 0; i < limit; i++) {
            assertTrue(rateLimit.tryAcquire(client, endpoint, limit));
        }
        // Exceeds limit
        assertFalse(rateLimit.tryAcquire(client, endpoint, limit));
    }

    @Test
    void concurrentRequests_threadSafeEnforcement() throws Exception {
        String client = "test-client-concurrent";
        String endpoint = "/api/v1/pipeline/trigger-by-cap";
        int limit = 20;
        int totalRequests = 50;

        ExecutorService executor = Executors.newFixedThreadPool(10);
        CountDownLatch latch = new CountDownLatch(totalRequests);
        AtomicInteger allowedCount = new AtomicInteger(0);
        AtomicInteger rejectedCount = new AtomicInteger(0);

        for (int i = 0; i < totalRequests; i++) {
            executor.submit(() -> {
                try {
                    if (rateLimit.tryAcquire(client, endpoint, limit)) {
                        allowedCount.incrementAndGet();
                    } else {
                        rejectedCount.incrementAndGet();
                    }
                } finally {
                    latch.countDown();
                }
            });
        }

        latch.await();
        executor.shutdown();

        assertEquals(limit, allowedCount.get(), "Exactly the limit count should be allowed");
        assertEquals(totalRequests - limit, rejectedCount.get(), "The remaining requests should be rejected");
    }
}
