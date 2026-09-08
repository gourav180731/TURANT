package com.turant.ews;

import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Controlled local EWS store — records every EWS report received by the local endpoint.
 * Used for manual demonstration (payload inspection) and automated verification.
 * Keeps HTTP interaction real: LocalEwsClient → HTTP → LocalEwsReceiveController → store.
 */
@Component
public class LocalEwsStore {

    private final AtomicReference<EwsRequest> lastRequest = new AtomicReference<>();
    private final AtomicReference<EwsResponse> lastResponse = new AtomicReference<>();
    private final AtomicReference<Instant> lastReceivedAt = new AtomicReference<>();
    private final CopyOnWriteArrayList<EwsRequest> history = new CopyOnWriteArrayList<>();
    private volatile int receivedCount = 0;
    private volatile int failureSimulations = 0;

    public synchronized void record(EwsRequest request, EwsResponse response) {
        lastRequest.set(request);
        lastResponse.set(response);
        lastReceivedAt.set(Instant.now());
        history.add(request);
        receivedCount++;
    }

    public synchronized void recordFailureAttempt() {
        failureSimulations++;
    }

    public EwsRequest getLastRequest() {
        return lastRequest.get();
    }

    public EwsResponse getLastResponse() {
        return lastResponse.get();
    }

    public Instant getLastReceivedAt() {
        return lastReceivedAt.get();
    }

    public List<EwsRequest> getHistory() {
        return new ArrayList<>(history);
    }

    public int getReceivedCount() {
        return receivedCount;
    }

    public int getFailureSimulations() {
        return failureSimulations;
    }

    public synchronized void clear() {
        lastRequest.set(null);
        lastResponse.set(null);
        lastReceivedAt.set(null);
        history.clear();
        receivedCount = 0;
        failureSimulations = 0;
    }
}
