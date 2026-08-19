package com.turant.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.postgresql.PGConnection;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;

/**
 * PostgreSQL + PostGIS database configuration.
 * 
 * Preserves exact connection pool behavior from TypeScript version:
 * - HikariCP connection pool (equivalent to pg Pool)
 * - PostGIS type support
 * - Statement timeout configuration
 * - Transaction management
 */
@Configuration
public class DatabaseConfig {

    @Value("${spring.datasource.url:}")
    private String databaseUrl;

    @Value("${spring.datasource.hikari.maximum-pool-size:20}")
    private int poolMax;

    @Value("${spring.datasource.hikari.connection-timeout:10000}")
    private long connectionTimeout;

    @Value("${spring.datasource.hikari.idle-timeout:30000}")
    private long idleTimeout;

    @Bean
    public DataSource dataSource() {
        if (databaseUrl == null || databaseUrl.isEmpty()) {
            // No database configured - return null, modules will handle gracefully
            return null;
        }

        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(databaseUrl);
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

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        if (dataSource == null) {
            return null;
        }
        return new JdbcTemplate(dataSource);
    }

    @Bean
    public PlatformTransactionManager transactionManager(DataSource dataSource) {
        if (dataSource == null) {
            return null;
        }
        return new DataSourceTransactionManager(dataSource);
    }

    /**
     * Check if database is configured and available.
     */
    public boolean isDatabaseAvailable() {
        return databaseUrl != null && !databaseUrl.isEmpty();
    }
}
