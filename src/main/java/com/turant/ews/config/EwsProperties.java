package com.turant.ews.config;

import com.turant.ews.EwsMode;
import jakarta.annotation.PostConstruct;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

/**
 * Strongly-typed EWS integration configuration.
 * Supports LOCAL (mock) and REMOTE (C-DOT) modes.
 *
 * All credentials must come from environment variables — never hardcoded.
 * Real EWS contract fields (path, method, headers) are configurable so C-DOT
 * can supply them later without code changes.
 *
 * Pending C-DOT EWS integration contract: baseUrl, path, and auth scheme are
 * intentionally configurable/adaptable.
 */
@Configuration
@ConfigurationProperties(prefix = "turant.ews")
public class EwsProperties {

    /**
     * Integration mode: local or remote. Defaults to local for dev safety.
     * Bound from ${EWS_MODE:local}
     */
    private String mode = "local";

    /**
     * Base URL for remote EWS. Required when mode=remote.
     * Bound from ${EWS_BASE_URL:}
     */
    private String baseUrl;

    /**
     * Legacy alias for baseUrl — kept for backward compat with ews.callback-url.
     * If set, it is used as fallback for baseUrl.
     */
    private String callbackUrl;

    /**
     * API key for remote EWS (Bearer token or header value).
     * Bound from ${EWS_API_KEY:}
     */
    private String apiKey;

    /**
     * Legacy alias for apiKey (ews.callback-token).
     */
    private String callbackToken;

    private String username;
    private String password;

    /**
     * Remote EWS HTTP path (appended to baseUrl). Configurable because C-DOT
     * contract path is not yet fixed. Default "/ews/callback".
     */
    private String path = "/ews/callback";

    /**
     * HTTP method for remote call (POST by default, configurable).
     */
    private String method = "POST";

    /**
     * Header name for API key authentication (Authorization by default).
     */
    private String authHeaderName = "Authorization";

    /**
     * Value prefix for auth header (e.g. "Bearer "). Empty means raw apiKey.
     */
    private String authHeaderPrefix = "Bearer ";

    private Duration connectTimeout = Duration.ofSeconds(5);
    private Duration readTimeout = Duration.ofSeconds(15);

    /**
     * Legacy timeout in ms (kept for backward compat with callback-timeout-ms).
     */
    private int callbackTimeoutMs = 5000;

    /**
     * Local EWS receive URL for HTTP loopback when mode=local.
     * If set, LocalEwsClient will POST via HTTP to this URL (real network interaction).
     * If blank, LocalEwsClient falls back to in-memory simulation (still deterministic).
     * Example: http://localhost:8080/api/v1/ews/local/receive
     * Bound from ${EWS_LOCAL_URL:} or ${turant.ews.local-url:}
     */
    private String localUrl;

    // SSL / mTLS hooks (only enabled when C-DOT certs are supplied)
    private boolean sslEnabled = false;
    private String keystore;
    private String keystorePassword;
    private String truststore;
    private String truststorePassword;

    @PostConstruct
    public void validate() {
        EwsMode.from(mode); // throws IllegalStateException on invalid mode
        EwsMode m = EwsMode.from(mode);
        if (m == EwsMode.REMOTE) {
            String effectiveBase = effectiveBaseUrl();
            if (effectiveBase == null || effectiveBase.isBlank()) {
                throw new IllegalStateException(
                        "EWS mode is 'remote' but turant.ews.base-url (EWS_BASE_URL) is not configured. "
                        + "Remote mode requires EWS_BASE_URL. "
                        + "Set EWS_MODE=local for development.");
            }
        }
    }

    public String effectiveBaseUrl() {
        if (baseUrl != null && !baseUrl.isBlank()) return baseUrl.trim();
        if (callbackUrl != null && !callbackUrl.isBlank()) return callbackUrl.trim();
        return null;
    }

    public String effectiveApiKey() {
        if (apiKey != null && !apiKey.isBlank()) return apiKey.trim();
        if (callbackToken != null && !callbackToken.isBlank()) return callbackToken.trim();
        return null;
    }

    public EwsMode getEwsMode() {
        return EwsMode.from(mode);
    }

    // Getters/setters
    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public String getCallbackUrl() { return callbackUrl; }
    public void setCallbackUrl(String callbackUrl) { this.callbackUrl = callbackUrl; }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    public String getCallbackToken() { return callbackToken; }
    public void setCallbackToken(String callbackToken) { this.callbackToken = callbackToken; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path; }

    public String getMethod() { return method; }
    public void setMethod(String method) { this.method = method; }

    public String getAuthHeaderName() { return authHeaderName; }
    public void setAuthHeaderName(String authHeaderName) { this.authHeaderName = authHeaderName; }

    public String getAuthHeaderPrefix() { return authHeaderPrefix; }
    public void setAuthHeaderPrefix(String authHeaderPrefix) { this.authHeaderPrefix = authHeaderPrefix; }

    public Duration getConnectTimeout() { return connectTimeout; }
    public void setConnectTimeout(Duration connectTimeout) { this.connectTimeout = connectTimeout; }

    public Duration getReadTimeout() { return readTimeout; }
    public void setReadTimeout(Duration readTimeout) { this.readTimeout = readTimeout; }

    public int getCallbackTimeoutMs() { return callbackTimeoutMs; }
    public void setCallbackTimeoutMs(int callbackTimeoutMs) { this.callbackTimeoutMs = callbackTimeoutMs; }

    public String getLocalUrl() { return localUrl; }
    public void setLocalUrl(String localUrl) { this.localUrl = localUrl; }

    public boolean isSslEnabled() { return sslEnabled; }
    public void setSslEnabled(boolean sslEnabled) { this.sslEnabled = sslEnabled; }

    public String getKeystore() { return keystore; }
    public void setKeystore(String keystore) { this.keystore = keystore; }

    public String getKeystorePassword() { return keystorePassword; }
    public void setKeystorePassword(String keystorePassword) { this.keystorePassword = keystorePassword; }

    public String getTruststore() { return truststore; }
    public void setTruststore(String truststore) { this.truststore = truststore; }

    public String getTruststorePassword() { return truststorePassword; }
    public void setTruststorePassword(String truststorePassword) { this.truststorePassword = truststorePassword; }
}
