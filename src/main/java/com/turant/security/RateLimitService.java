package com.turant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Item #2 Layer 9 — Rate Limiting (per-client, per-endpoint, thread-safe, burst handling)
 * Token bucket with Redis future extension (currently in-memory, suitable for single instance; distributed via Redis later).
 */
@Service
public class RateLimitService {

    private static final Logger log = LoggerFactory.getLogger(RateLimitService.class);

    private static class Bucket {
        final AtomicInteger count = new AtomicInteger(0);
        final AtomicLong windowStart = new AtomicLong(Instant.now().toEpochMilli());
    }

    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

    public boolean tryAcquire(String clientId, String endpoint, int limitPerMin) {
        if (limitPerMin <= 0) return true;
        String key = clientId + ":" + endpoint;
        Bucket b = buckets.computeIfAbsent(key, k -> new Bucket());
        synchronized (b) {
            long now = Instant.now().toEpochMilli();
            if (now - b.windowStart.get() > 60000) {
                b.windowStart.set(now);
                b.count.set(0);
            }
            int current = b.count.incrementAndGet();
            boolean allowed = current <= limitPerMin;
            if (!allowed) log.warn("Rate limit exceeded client={} endpoint={} {}/{} per min", clientId, endpoint, current, limitPerMin);
            return allowed;
        }
    }

    public boolean tryAcquire(String clientId, String endpoint, ClientCredentialsService.ClientRecord rec) {
        int limit = rec != null ? rec.rateLimitPerMin() : 60;
        return tryAcquire(clientId, endpoint, limit);
    }
}
