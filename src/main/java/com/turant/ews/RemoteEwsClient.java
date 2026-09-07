package com.turant.ews;

import com.turant.ews.config.EwsProperties;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import com.turant.ews.exception.EwsErrorCode;
import com.turant.ews.exception.EwsException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

/**
 * REMOTE EWS implementation — communicates with actual C-DOT EWS/VB server.
 * Credentials and baseUrl come from configuration/environment, never hardcoded.
 * Never logs secrets (apiKey, password, Authorization header).
 *
 * Pending C-DOT EWS integration contract: path, method, headers are configurable.
 */
@Component
public class RemoteEwsClient implements EwsClient {

    private static final Logger log = LoggerFactory.getLogger(RemoteEwsClient.class);

    private final EwsProperties properties;
    private final RestClient restClient;

    public RemoteEwsClient(EwsProperties properties) {
        this.properties = properties;
        String baseUrl = properties.effectiveBaseUrl();
        String safeBase = (baseUrl != null && !baseUrl.isBlank()) ? baseUrl : "http://localhost:0";

        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) properties.getConnectTimeout().toMillis());
        factory.setReadTimeout((int) properties.getReadTimeout().toMillis());

        this.restClient = RestClient.builder()
                .baseUrl(safeBase)
                .requestFactory(factory)
                .build();
        log.info("RemoteEwsClient initialized: baseUrl={}, path={}, method={}, connectTimeout={}, readTimeout={}, sslEnabled={}",
                safeBase, properties.getPath(), properties.getMethod(),
                properties.getConnectTimeout(), properties.getReadTimeout(), properties.isSslEnabled());
    }

    @Override
    public EwsResponse send(EwsRequest request) {
        if (properties.getEwsMode() != com.turant.ews.EwsMode.REMOTE) {
            throw new EwsException(EwsErrorCode.UNSUPPORTED_MODE, "RemoteEwsClient invoked but EWS mode is not remote: " + properties.getMode());
        }
        String baseUrl = properties.effectiveBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            throw new EwsException(EwsErrorCode.NOT_CONFIGURED, "EWS remote mode requires turant.ews.base-url (EWS_BASE_URL)");
        }
        if (request == null || request.alertId() == null || request.alertId().isBlank()) {
            throw new EwsException(EwsErrorCode.INVALID_REQUEST, "alertId is required", 400);
        }

        String path = properties.getPath();
        if (path == null || path.isBlank()) path = "/ews/callback";
        if (!path.startsWith("/")) path = "/" + path;

        log.info("Remote EWS send: alertId={}, path={}, method={}", request.alertId(), path, properties.getMethod());

        try {
            String method = properties.getMethod() != null ? properties.getMethod().toUpperCase() : "POST";
            String apiKey = properties.effectiveApiKey();
            String username = properties.getUsername();
            String password = properties.getPassword();
            String headerName = properties.getAuthHeaderName() != null ? properties.getAuthHeaderName() : "Authorization";
            String prefix = properties.getAuthHeaderPrefix() != null ? properties.getAuthHeaderPrefix() : "Bearer ";

            String raw;
            if ("GET".equals(method)) {
                var spec = restClient.get().uri(path);
                if (apiKey != null && !apiKey.isBlank()) {
                    spec = spec.header(headerName, prefix + apiKey);
                } else if (username != null && !username.isBlank() && password != null) {
                    spec = spec.header(HttpHeaders.AUTHORIZATION, "Basic " + java.util.Base64.getEncoder().encodeToString((username + ":" + password).getBytes()));
                }
                raw = spec.retrieve().body(String.class);
            } else if ("PUT".equals(method)) {
                var spec = restClient.put().uri(path).contentType(MediaType.APPLICATION_JSON);
                if (apiKey != null && !apiKey.isBlank()) {
                    spec = spec.header(headerName, prefix + apiKey);
                } else if (username != null && !username.isBlank() && password != null) {
                    spec = spec.header(HttpHeaders.AUTHORIZATION, "Basic " + java.util.Base64.getEncoder().encodeToString((username + ":" + password).getBytes()));
                }
                raw = spec.body(request).retrieve().body(String.class);
            } else {
                var spec = restClient.post().uri(path).contentType(MediaType.APPLICATION_JSON);
                if (apiKey != null && !apiKey.isBlank()) {
                    spec = spec.header(headerName, prefix + apiKey);
                } else if (username != null && !username.isBlank() && password != null) {
                    spec = spec.header(HttpHeaders.AUTHORIZATION, "Basic " + java.util.Base64.getEncoder().encodeToString((username + ":" + password).getBytes()));
                }
                raw = spec.body(request).retrieve().body(String.class);
            }

            if (raw == null || raw.isBlank()) {
                log.warn("Remote EWS empty response for alertId={}", request.alertId());
                throw new EwsException(EwsErrorCode.SERVER_ERROR, "Empty response from remote EWS", 502);
            }
            log.info("Remote EWS success: alertId={}, status=200", request.alertId());
            return new EwsResponse("remote", EwsResponse.EwsStatus.SUCCESS.name(),
                    extractReferenceId(raw, request.alertId()), java.time.Instant.now().toString(),
                    request.alertId(), "Remote EWS accepted", "SUCCESS", 200);

        } catch (HttpClientErrorException e) {
            int code = e.getStatusCode().value();
            String body = e.getResponseBodyAsString();
            EwsErrorCode errorCode;
            if (code == 400) errorCode = EwsErrorCode.INVALID_REQUEST;
            else if (code == 401 || code == 403) errorCode = EwsErrorCode.AUTHENTICATION_FAILURE;
            else if (code == 404) errorCode = EwsErrorCode.INVALID_REQUEST;
            else if (code == 409) errorCode = EwsErrorCode.REMOTE_REJECTED;
            else if (code == 429) errorCode = EwsErrorCode.REMOTE_REJECTED;
            else errorCode = EwsErrorCode.REMOTE_REJECTED;
            log.warn("Remote EWS client error: alertId={}, httpStatus={}, errorCode={}", request.alertId(), code, errorCode);
            throw new EwsException(errorCode, "Remote EWS rejected: HTTP " + code + (body != null && body.length() < 500 ? " " + body : ""), code, e);
        } catch (HttpServerErrorException e) {
            int code = e.getStatusCode().value();
            log.error("Remote EWS server error: alertId={}, httpStatus={}", request.alertId(), code);
            throw new EwsException(EwsErrorCode.SERVER_ERROR, "Remote EWS server error: HTTP " + code, code, e);
        } catch (ResourceAccessException e) {
            String msg = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
            if (msg.contains("timeout") || msg.contains("timed out") || msg.contains("read timed out")) {
                log.error("Remote EWS timeout: alertId={}", request.alertId(), e);
                throw new EwsException(EwsErrorCode.TIMEOUT, "Remote EWS timeout: " + e.getMessage(), 504, e);
            } else {
                log.error("Remote EWS connection failure: alertId={}", request.alertId(), e);
                throw new EwsException(EwsErrorCode.CONNECTION_FAILURE, "Remote EWS connection failure: " + e.getMessage(), 502, e);
            }
        } catch (EwsException e) {
            throw e;
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
            if (msg.contains("timeout")) {
                throw new EwsException(EwsErrorCode.TIMEOUT, "Remote EWS timeout", 504, e);
            }
            if (msg.contains("connection") || msg.contains("refused") || msg.contains("unreachable") || msg.contains("dns") || msg.contains("unknownhost")) {
                throw new EwsException(EwsErrorCode.CONNECTION_FAILURE, "Remote EWS connection failure", 502, e);
            }
            throw new EwsException(EwsErrorCode.SERVER_ERROR, "Remote EWS error: " + e.getMessage(), 500, e);
        }
    }

    private String extractReferenceId(String raw, String fallback) {
        try {
            if (raw.contains("referenceId")) {
                int idx = raw.indexOf("referenceId");
                int colon = raw.indexOf(":", idx);
                int q1 = raw.indexOf("\"", colon);
                int q2 = raw.indexOf("\"", q1 + 1);
                if (q1 >= 0 && q2 > q1) return raw.substring(q1 + 1, q2);
            }
            if (raw.contains("reference_id")) {
                int idx = raw.indexOf("reference_id");
                int colon = raw.indexOf(":", idx);
                int q1 = raw.indexOf("\"", colon);
                int q2 = raw.indexOf("\"", q1 + 1);
                if (q1 >= 0 && q2 > q1) return raw.substring(q1 + 1, q2);
            }
        } catch (Exception ignore) {}
        return "REMOTE-" + fallback + "-" + java.util.UUID.randomUUID().toString().substring(0, 8).toUpperCase();
    }

    @Override
    public String getMode() {
        return "remote";
    }
}
