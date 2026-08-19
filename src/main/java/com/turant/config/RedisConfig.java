package com.turant.config;

import io.lettuce.core.ClientOptions;
import io.lettuce.core.TimeoutOptions;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;

import java.time.Duration;

/**
 * Redis configuration for caching and shared state.
 * 
 * Preserves exact behavior from TypeScript ioredis client:
 * - Subscriber prefetch cache
 * - Pipeline state sharing
 * - Trace record mirroring
 * - DLR state tracking
 */
@Configuration
public class RedisConfig {

    @Value("${spring.data.redis.url:}")
    private String redisUrl;

    @Autowired
    private TurantConfig turantConfig;

    @Bean
    public RedisConnectionFactory redisConnectionFactory() {
        if (redisUrl == null || redisUrl.isEmpty()) {
            // No Redis configured - return null, modules will handle gracefully
            return null;
        }

        // Parse Redis URL (redis://host:port or redis://user:pass@host:port)
        RedisStandaloneConfiguration config = parseRedisUrl(redisUrl);

        // Configure Lettuce client (equivalent to ioredis)
        ClientOptions clientOptions = ClientOptions.builder()
            .timeoutOptions(TimeoutOptions.enabled(Duration.ofSeconds(10)))
            .build();

        LettuceClientConfiguration clientConfig = LettuceClientConfiguration.builder()
            .clientOptions(clientOptions)
            .commandTimeout(Duration.ofSeconds(10))
            .build();

        return new LettuceConnectionFactory(config, clientConfig);
    }

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory connectionFactory) {
        if (connectionFactory == null) {
            return null;
        }

        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);

        // Use String serializer for keys (with prefix support)
        template.setKeySerializer(new StringRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());

        // Use JSON serializer for values (matching Node.js behavior)
        GenericJackson2JsonRedisSerializer serializer = new GenericJackson2JsonRedisSerializer();
        template.setValueSerializer(serializer);
        template.setHashValueSerializer(serializer);

        template.afterPropertiesSet();
        return template;
    }

    @Bean
    public StringRedisTemplate stringRedisTemplate(RedisConnectionFactory connectionFactory) {
        if (connectionFactory == null) {
            return null;
        }
        return new StringRedisTemplate(connectionFactory);
    }

    /**
     * Get Redis key with configured prefix.
     * Preserves exact key structure from TypeScript version.
     */
    public String key(String suffix) {
        return turantConfig.getRedisKeyPrefix() + suffix;
    }

    /**
     * Check if Redis is configured and available.
     */
    public boolean isRedisAvailable() {
        return redisUrl != null && !redisUrl.isEmpty();
    }

    /**
     * Parse Redis URL into configuration.
     * Supports: redis://host:port and redis://user:pass@host:port
     */
    private RedisStandaloneConfiguration parseRedisUrl(String url) {
        RedisStandaloneConfiguration config = new RedisStandaloneConfiguration();

        // Remove redis:// prefix
        String cleaned = url.replace("redis://", "");

        // Parse user:pass@host:port or host:port
        String[] parts = cleaned.split("@");
        String hostPort;
        
        if (parts.length == 2) {
            // Has authentication
            String[] auth = parts[0].split(":");
            if (auth.length == 2) {
                config.setPassword(auth[1]);
            }
            hostPort = parts[1];
        } else {
            hostPort = parts[0];
        }

        // Parse host:port
        String[] hp = hostPort.split(":");
        config.setHostName(hp[0]);
        if (hp.length == 2) {
            config.setPort(Integer.parseInt(hp[1]));
        } else {
            config.setPort(6379); // Default Redis port
        }

        return config;
    }
}
