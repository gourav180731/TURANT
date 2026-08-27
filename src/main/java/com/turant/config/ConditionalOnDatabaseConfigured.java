package com.turant.config;

import org.springframework.context.annotation.Conditional;

import java.lang.annotation.*;

/**
 * Conditional annotation that checks if database URL is actually configured
 * (not just present but empty).
 * 
 * This is needed because @ConditionalOnProperty checks if a property exists,
 * not if it's non-empty. Since spring.datasource.url has a default of empty
 * string, we need custom logic.
 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Conditional(DatabaseConfiguredCondition.class)
public @interface ConditionalOnDatabaseConfigured {
}
