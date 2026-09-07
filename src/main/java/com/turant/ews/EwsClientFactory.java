package com.turant.ews;

import com.turant.ews.config.EwsProperties;
import org.springframework.stereotype.Component;

/**
 * Mode-based EWS client selection. The rest of TURANT depends on EwsClient interface,
 * not directly on either implementation.
 */
@Component
public class EwsClientFactory {

    private final LocalEwsClient localEwsClient;
    private final RemoteEwsClient remoteEwsClient;
    private final EwsProperties properties;

    public EwsClientFactory(LocalEwsClient localEwsClient,
                            RemoteEwsClient remoteEwsClient,
                            EwsProperties properties) {
        this.localEwsClient = localEwsClient;
        this.remoteEwsClient = remoteEwsClient;
        this.properties = properties;
    }

    public EwsClient getClient() {
        EwsMode mode = properties.getEwsMode();
        return switch (mode) {
            case LOCAL -> localEwsClient;
            case REMOTE -> remoteEwsClient;
        };
    }

    public EwsClient getLocalClient() {
        return localEwsClient;
    }

    public EwsClient getRemoteClient() {
        return remoteEwsClient;
    }

    public boolean isLocalMode() {
        return properties.getEwsMode() == EwsMode.LOCAL;
    }

    public boolean isRemoteMode() {
        return properties.getEwsMode() == EwsMode.REMOTE;
    }
}
