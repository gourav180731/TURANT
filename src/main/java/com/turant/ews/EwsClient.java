package com.turant.ews;

import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import com.turant.types.report.AlertReport;

/**
 * Common EWS integration interface — pipeline and controllers depend on this,
 * not on concrete Local/Remote implementations.
 */
public interface EwsClient {

    /**
     * Send a generic EWS request. Used by local/remote test endpoints.
     */
    EwsResponse send(EwsRequest request);

    /**
     * Send a pipeline AlertReport to EWS origin (feedback/completion).
     * Default maps AlertReport to EwsRequest for backward compatibility with
     * existing EwsCallback usage.
     */
    default EwsResponse sendReport(AlertReport report) {
        EwsRequest req = new EwsRequest(
                report.alertId(),
                report.capIdentifier(),
                "Pipeline completion feedback",
                "INFO",
                report
        );
        return send(req);
    }

    /**
     * Human-readable mode name for this client (local / remote).
     */
    String getMode();
}
