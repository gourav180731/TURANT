package com.turant.config;

import jakarta.servlet.*;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.embedded.tomcat.TomcatConnectorCustomizer;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Fix for 503 on large CAP payloads (3 MB) and 30s async timeout.
 *
 * Root cause: Spring MVC async timeout defaults to 30s (=user's 30.28s).
 * Tower resolution for many polygons + subscriber counting can exceed 30s.
 * Also Tomcat's maxPostSize defaults to 2 MB, so 3 MB bodies were rejected.
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private static final Logger logger = LoggerFactory.getLogger(WebConfig.class);

    @Value("${turant.security.cors.allowed-origins:*}")
    private String corsAllowedOrigins;

    @Value("${turant.security.cors.allowed-methods:GET,POST,PUT,DELETE,OPTIONS}")
    private String corsAllowedMethods;

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
        configurer.setDefaultTimeout(300000);
        logger.info("WebConfig: async timeout set to 300s");
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        // API security: CORS restricted to configured origins (default * for dev, set explicit in prod)
        registry.addMapping("/api/**")
                .allowedOrigins(corsAllowedOrigins.split(","))
                .allowedMethods(corsAllowedMethods.split(","))
                .allowedHeaders("*")
                .exposedHeaders("X-Request-Id")
                .maxAge(3600);
        // Health and docs are public CORS as well
        registry.addMapping("/healthz").allowedOrigins("*").allowedMethods("GET").maxAge(3600);
        logger.info("CORS configured: origins={} methods={}", corsAllowedOrigins, corsAllowedMethods);
    }

    @Bean
    public FilterRegistrationBean<Filter> securityHeadersFilter() {
        Filter filter = (ServletRequest req, ServletResponse res, FilterChain chain) -> {
            HttpServletResponse httpRes = (HttpServletResponse) res;
            httpRes.setHeader("X-Content-Type-Options", "nosniff");
            httpRes.setHeader("X-Frame-Options", "DENY");
            httpRes.setHeader("X-XSS-Protection", "0");
            httpRes.setHeader("Referrer-Policy", "no-referrer");
            httpRes.setHeader("Cache-Control", "no-store");
            httpRes.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
            chain.doFilter(req, res);
        };
        FilterRegistrationBean<Filter> reg = new FilterRegistrationBean<>(filter);
        reg.setOrder(org.springframework.core.Ordered.HIGHEST_PRECEDENCE + 5);
        reg.addUrlPatterns("/*");
        return reg;
    }

    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcatCustomizer() {
        return factory -> {
            factory.addConnectorCustomizers((TomcatConnectorCustomizer) connector -> {
                // Disable Tomcat maxPostSize limit (default 2 MB) for large CAP XML
                connector.setMaxPostSize(-1);
                connector.setProperty("maxSwallowSize", "-1");
                logger.info("WebConfig: Tomcat maxPostSize=-1, maxSwallowSize=-1 (unlimited)");
            });
        };
    }
}
