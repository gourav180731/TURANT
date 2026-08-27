package com.turant.config;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.type.AnnotatedTypeMetadata;

/**
 * Condition implementation that checks if database URL is configured and non-empty.
 * 
 * This allows simulation mode to run without PostgreSQL when DATABASE_URL is
 * not set or empty.
 */
public class DatabaseConfiguredCondition implements Condition {
    
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        String databaseUrl = context.getEnvironment().getProperty("spring.datasource.url");
        boolean configured = databaseUrl != null && !databaseUrl.trim().isEmpty();
        
        if (!configured) {
            System.out.println("DatabaseConfiguredCondition: Database URL not configured - beans will not be created");
        } else {
            System.out.println("DatabaseConfiguredCondition: Database URL configured - creating database beans");
        }
        
        return configured;
    }
}
