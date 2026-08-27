package com.turant.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

/**
 * PostgreSQL + PostGIS database configuration.
 * 
 * Preserves exact connection pool behavior from TypeScript version:
 * - HikariCP connection pool (equivalent to pg Pool)
 * - PostGIS type support
 * - Statement timeout configuration
 * - Transaction management
 * 
 * CONDITIONAL CONFIGURATION:
 * - Only creates DataSource when database URL is configured
 * - Allows simulation mode to run without PostgreSQL
 * - Components should use @ConditionalOnBean(DataSource.class) if they require DB
 */
@Configuration
public class DatabaseConfig {
    
    private static final Logger logger = LoggerFactory.getLogger(DatabaseConfig.class);

    private final String databaseUrl;
    private final String databaseUsername;
    private final String databasePassword;
    private final int poolMax;
    private final long connectionTimeout;
    private final long idleTimeout;

    public DatabaseConfig(
            @Value("${spring.datasource.url:}") String databaseUrl,
            @Value("${spring.datasource.username:}") String databaseUsername,
            @Value("${spring.datasource.password:}") String databasePassword,
            @Value("${spring.datasource.hikari.maximum-pool-size:20}") int poolMax,
            @Value("${spring.datasource.hikari.connection-timeout:10000}") long connectionTimeout,
            @Value("${spring.datasource.hikari.idle-timeout:30000}") long idleTimeout) {
        this.databaseUrl = databaseUrl;
        this.databaseUsername = databaseUsername;
        this.databasePassword = databasePassword;
        this.poolMax = poolMax;
        this.connectionTimeout = connectionTimeout;
        this.idleTimeout = idleTimeout;
        
        if (databaseUrl != null && !databaseUrl.isBlank()) {
            String maskedUrl = databaseUrl.replaceAll("(:|//)([^:@/]+)(:[^:@]+)?@", "$1$2:***@");
            logger.info("============================================================");
            logger.info("DatabaseConfig: REAL PostgreSQL configuration detected:");
            logger.info("  URL                = {}", maskedUrl);
            logger.info("  Username           = {}", 
                (databaseUsername != null && !databaseUsername.isBlank()) ? databaseUsername : "(not set - will use OS default)");
            logger.info("  Password           = {}", 
                (databasePassword != null && !databasePassword.isBlank()) ? "***SET***" : "(not set)");
            logger.info("  Hikari poolMax     = {}", poolMax);
            logger.info("  connectionTimeout  = {} ms", connectionTimeout);
            logger.info("  idleTimeout        = {} ms", idleTimeout);
            logger.info("============================================================");
        }
    }

    /**
     * Create DataSource only when database URL is configured (not empty).
     * This allows simulation mode to work without PostgreSQL.
     * 
     * Uses custom @ConditionalOnDatabaseConfigured which checks that the
     * URL is not just present but actually non-empty.
     */
    @Bean
    @ConditionalOnDatabaseConfigured
    public DataSource dataSource() {
        logger.info("Creating REAL HikariDataSource for: {}", 
            databaseUrl.replaceAll("(:|//)([^:@/]+)(:[^:@]+)?@", "$1$2:***@"));
        
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(databaseUrl);
        
        if (databaseUsername != null && !databaseUsername.isBlank()) {
            config.setUsername(databaseUsername);
        }
        if (databasePassword != null && !databasePassword.isBlank()) {
            config.setPassword(databasePassword);
        }
        
        config.setMaximumPoolSize(poolMax);
        config.setConnectionTimeout(connectionTimeout);
        config.setIdleTimeout(idleTimeout);
        
        // Enable PostGIS support
        config.addDataSourceProperty("stringtype", "unspecified");
        
        // Connection validation
        config.setConnectionTestQuery("SELECT 1");
        
        // Pool name for monitoring
        config.setPoolName("TurantHikariPool");
        
        return new HikariDataSource(config);
    }

    /**
     * Check if database is configured and available.
     */
    public boolean isDatabaseAvailable() {
        return databaseUrl != null && !databaseUrl.isEmpty();
    }
}
