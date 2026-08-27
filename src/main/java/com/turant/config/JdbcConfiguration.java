package com.turant.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;

import javax.sql.DataSource;

/**
 * JDBC configuration - only loaded when DataSource is available.
 * 
 * This class is separate from DatabaseConfig to provide JdbcTemplate and
 * TransactionManager beans only when a database is actually configured.
 * 
 * Uses @ConditionalOnDatabaseConfigured (custom condition) which checks that
 * spring.datasource.url is not just present but actually non-empty.
 */
@Configuration
@ConditionalOnDatabaseConfigured
public class JdbcConfiguration {
    
    /**
     * Create JdbcTemplate when DataSource exists.
     */
    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }
    
    /**
     * Create TransactionManager when DataSource exists.
     */
    @Bean
    public PlatformTransactionManager transactionManager(DataSource dataSource) {
        return new DataSourceTransactionManager(dataSource);
    }
}
