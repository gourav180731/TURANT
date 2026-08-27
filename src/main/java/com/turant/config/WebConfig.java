package com.turant.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.embedded.tomcat.TomcatConnectorCustomizer;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
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

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
        // 5 minutes — matches spring.mvc.async.request-timeout but enforced at code level
        configurer.setDefaultTimeout(300000);
        logger.info("WebConfig: async timeout set to 300s");
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
