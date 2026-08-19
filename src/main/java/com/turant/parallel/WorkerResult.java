package com.turant.parallel;

import com.turant.types.sms.SubmissionResult;

import java.util.List;

/**
 * Result from executing a worker job.
 * 
 * Migrated from TypeScript Module 13 types.ts
 */
public class WorkerResult {
    private final boolean ok;
    private final String alertId;
    private final String capIdentifier;
    private final AlertSubmitSummary summary;
    private final String error;
    
    public WorkerResult(boolean ok, String alertId, String capIdentifier, 
                       AlertSubmitSummary summary, String error) {
        this.ok = ok;
        this.alertId = alertId;
        this.capIdentifier = capIdentifier;
        this.summary = summary;
        this.error = error;
    }
    
    public boolean isOk() { return ok; }
    public String getAlertId() { return alertId; }
    public String getCapIdentifier() { return capIdentifier; }
    public AlertSubmitSummary getSummary() { return summary; }
    public String getError() { return error; }
    
    public static class AlertSubmitSummary {
        private final int total;
        private final int accepted;
        private final int rejected;
        private final int failed;
        private final int retried;
        private final int gaveUpExpired;
        private final int exhaustedRetries;
        private final boolean awaitingCredentials;
        private final List<SubmissionResult> results;
        
        public AlertSubmitSummary(int total, int accepted, int rejected, int failed,
                                 int retried, int gaveUpExpired, int exhaustedRetries,
                                 boolean awaitingCredentials, List<SubmissionResult> results) {
            this.total = total;
            this.accepted = accepted;
            this.rejected = rejected;
            this.failed = failed;
            this.retried = retried;
            this.gaveUpExpired = gaveUpExpired;
            this.exhaustedRetries = exhaustedRetries;
            this.awaitingCredentials = awaitingCredentials;
            this.results = results;
        }
        
        public int getTotal() { return total; }
        public int getAccepted() { return accepted; }
        public int getRejected() { return rejected; }
        public int getFailed() { return failed; }
        public int getRetried() { return retried; }
        public int getGaveUpExpired() { return gaveUpExpired; }
        public int getExhaustedRetries() { return exhaustedRetries; }
        public boolean isAwaitingCredentials() { return awaitingCredentials; }
        public List<SubmissionResult> getResults() { return results; }
    }
}
