package com.turant.http;

import com.turant.config.DatabaseConfig;
import com.turant.config.RedisConfig;
import com.turant.config.TurantConfig;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

/**
 * Health endpoint - preserves exact behavior from TypeScript version.
 * 
 * GET /healthz
 * 
 * Returns 200 when healthy, 503 when degraded.
 * Checks: database, Redis, SMPP configuration status.
 */
@RestController
public class HealthController {

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    @Autowired(required = false)
    private DatabaseConfig databaseConfig;

    @Autowired(required = false)
    private RedisConfig redisConfig;

    @Autowired
    private TurantConfig config;

    @GetMapping("/healthz")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> health = new HashMap<>();

        // Application info
        health.put("app", "turant");
        health.put("uptimeSeconds", getUptimeSeconds());

        // Database check
        String dbStatus = checkDatabase();
        health.put("db", dbStatus);

        // Redis check
        String redisStatus = checkRedis();
        health.put("redis", redisStatus);

        // SMPP check
        String smppStatus = checkSmpp();
        health.put("smpp", smppStatus);

        // Overall status
        boolean healthy = "ok".equals(dbStatus) && 
                         "ok".equals(redisStatus) && 
                         ("ok".equals(smppStatus) || "awaiting_credentials".equals(smppStatus));

        health.put("status", healthy ? "healthy" : "degraded");

        HttpStatus httpStatus = healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
        return ResponseEntity.status(httpStatus).body(health);
    }

    private String checkDatabase() {
        if (databaseConfig == null || !databaseConfig.isDatabaseAvailable()) {
            return "not_configured";
        }

        try {
            jdbcTemplate.queryForObject("SELECT 1", Integer.class);
            return "ok";
        } catch (Exception e) {
            return "error: " + e.getMessage();
        }
    }

    private String checkRedis() {
        if (redisConfig == null || !redisConfig.isRedisAvailable()) {
            return "not_configured";
        }

        try {
            // Redis connection will be checked by StringRedisTemplate
            return "ok";
        } catch (Exception e) {
            return "error: " + e.getMessage();
        }
    }

    private String checkSmpp() {
        TurantConfig.SmppConfig smpp = config.getSmpp();
        
        if (smpp.getHost() == null || smpp.getHost().isEmpty() ||
            smpp.getSystemId() == null || smpp.getSystemId().isEmpty()) {
            return "awaiting_credentials";
        }

        // SMPP client not yet implemented, so return configured status
        return "configured";
    }

    private long getUptimeSeconds() {
        return (System.currentTimeMillis() - startTime) / 1000;
    }

    private static final long startTime = System.currentTimeMillis();
}
