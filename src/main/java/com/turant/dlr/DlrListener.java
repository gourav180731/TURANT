package com.turant.dlr;

import com.turant.types.sms.DlrReceipt;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Delivery receipt (DLR) listener - requirement #11.
 * 
 * Watches the SMSC session for deliver_sm PDUs (registered_delivery was
 * set on submit_sm so the SMSC pushes receipts). Each receipt is parsed into a
 * DlrReceipt, matched back to the originating alert, and tracked for reporting.
 * 
 * Migrated from TypeScript Module 11 dlr-listener.ts
 */
@Component
public class DlrListener {
    
    private static final Logger logger = LoggerFactory.getLogger(DlrListener.class);
    
    public static class RegisteredSubmission {
        private final String messageId;
        private final String smscMessageId;
        private final String alertId;
        private final String msisdn;
        
        public RegisteredSubmission(String messageId, String smscMessageId, String alertId, String msisdn) {
            this.messageId = messageId;
            this.smscMessageId = smscMessageId;
            this.alertId = alertId;
            this.msisdn = msisdn;
        }
        
        public String getMessageId() { return messageId; }
        public String getSmscMessageId() { return smscMessageId; }
        public String getAlertId() { return alertId; }
        public String getMsisdn() { return msisdn; }
    }
    
    public static class AlertReceiptStats {
        private final String alertId;
        private int receivedCount;
        private int expectedCount;
        private Long firstReceivedEpochMs;
        private Long lastReceivedEpochMs;
        private final List<DlrReceipt> received;
        
        public AlertReceiptStats(String alertId) {
            this.alertId = alertId;
            this.receivedCount = 0;
            this.expectedCount = 0;
            this.firstReceivedEpochMs = null;
            this.lastReceivedEpochMs = null;
            this.received = new ArrayList<>();
        }
        
        public String getAlertId() { return alertId; }
        public int getReceivedCount() { return receivedCount; }
        public int getExpectedCount() { return expectedCount; }
        public Long getFirstReceivedEpochMs() { return firstReceivedEpochMs; }
        public Long getLastReceivedEpochMs() { return lastReceivedEpochMs; }
        public List<DlrReceipt> getReceived() { return received; }
        
        public void addReceipt(DlrReceipt receipt, long epochMs) {
            received.add(receipt);
            receivedCount++;
            lastReceivedEpochMs = epochMs;
            if (firstReceivedEpochMs == null) {
                firstReceivedEpochMs = epochMs;
            }
        }
        
        public void setExpectedCount(int count) {
            this.expectedCount = count;
        }
    }
    
    private final Map<String, RegisteredSubmission> submissions = new ConcurrentHashMap<>();
    private final Map<String, AlertReceiptStats> alerts = new ConcurrentHashMap<>();
    private final Supplier<Instant> clock;
    
    public DlrListener() {
        this(Instant::now);
    }
    
    public DlrListener(Supplier<Instant> clock) {
        this.clock = clock;
    }
    
    /**
     * Record a submission so an arriving receipt can be correlated.
     */
    public void registerSubmission(String smscMessageId, String messageId, String alertId, String msisdn) {
        if (smscMessageId == null || smscMessageId.isEmpty()) {
            return;
        }
        
        RegisteredSubmission sub = new RegisteredSubmission(messageId, smscMessageId, alertId, msisdn);
        submissions.put(smscMessageId, sub);
        submissions.put(messageId, sub);
    }
    
    /**
     * Correlate and record a receipt; returns the parsed receipt or null.
     * This would be called by SMPP session's deliver_sm handler.
     */
    public DlrReceipt handleReceipt(String receiptText, String messageId) {
        DlrReceipt receipt = parseDeliveryReceipt(receiptText);
        if (receipt == null) {
            logger.debug("Non-receipt PDU ignored");
            return null;
        }
        
        RegisteredSubmission sub = submissions.get(receipt.smscMessageId());
        if (sub == null && messageId != null) {
            sub = submissions.get(messageId);
        }
        
        long deliveredAt = receipt.deliveredAt() != null 
            ? receipt.deliveredAt().toEpochMilli() 
            : clock.get().toEpochMilli();
        
        if (sub != null) {
            noteReceipt(sub.getAlertId(), receipt, deliveredAt);
            logger.info("DLR received: alertId={}, msisdn={}, state={}", 
                sub.getAlertId(), sub.getMsisdn(), receipt.messageState());
        } else {
            logger.warn("Unmatched DLR receipt: smscMessageId={}", receipt.smscMessageId());
        }
        
        return receipt;
    }
    
    /**
     * Per-alert DLR aggregation for the reporter.
     */
    public AlertReceiptStats receiptsForAlert(String alertId) {
        return alerts.get(alertId);
    }
    
    private void noteReceipt(String alertId, DlrReceipt receipt, long deliveredEpochMs) {
        AlertReceiptStats stats = alerts.computeIfAbsent(alertId, AlertReceiptStats::new);
        stats.addReceipt(receipt, deliveredEpochMs);
        
        // TODO: Integrate with trace store when implemented
        // traceStore.recordDelivery(alertId, deliveredEpochMs);
        // traceStore.mark(alertId, "t4", "dlr.first", deliveredEpochMs);
    }
    
    /**
     * Parse a delivery receipt text into a DlrReceipt.
     * Expected format: "id:.. sub:001 dlvrd:001 submit date:.. done date:.. stat:DELIVRD err:000"
     */
    private static final Pattern FIELD_PATTERN = Pattern.compile("(?:^| )(\\w+):(\\S+)");
    
    public static DlrReceipt parseDeliveryReceipt(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        
        Map<String, String> fields = new ConcurrentHashMap<>();
        Matcher matcher = FIELD_PATTERN.matcher(text);
        while (matcher.find()) {
            fields.put(matcher.group(1), matcher.group(2));
        }
        
        String smscMessageId = fields.get("id");
        String stat = fields.get("stat");
        
        if (smscMessageId == null || smscMessageId.isEmpty() || stat == null) {
            return null;
        }
        
        String errorCode = fields.get("err");
        Instant deliveredAt = parseDoneDate(fields.get("done"));
        
        return new DlrReceipt(smscMessageId, stat, errorCode, deliveredAt);
    }
    
    /**
     * Parse done date from SMPP YYMMDDhhmm format.
     */
    private static Instant parseDoneDate(String raw) {
        if (raw == null || !raw.matches("^\\d{10}$")) {
            return null;
        }
        
        try {
            int year = 2000 + Integer.parseInt(raw.substring(0, 2));
            int month = Integer.parseInt(raw.substring(2, 4));
            int day = Integer.parseInt(raw.substring(4, 6));
            int hour = Integer.parseInt(raw.substring(6, 8));
            int minute = Integer.parseInt(raw.substring(8, 10));
            
            return Instant.parse(String.format("%04d-%02d-%02dT%02d:%02d:00Z", 
                year, month, day, hour, minute));
        } catch (Exception e) {
            return null;
        }
    }
}
