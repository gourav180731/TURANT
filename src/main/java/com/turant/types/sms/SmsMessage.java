package com.turant.types.sms;

import java.time.Instant;

/**
 * Per-recipient message ready for submit_sm.
 * Shared by SMPP client (module 07), validity enforcement (module 08),
 * priority flagging (module 09) and delivery strategy (module 10).
 */
public record SmsMessage(
    String messageId,
    String alertId,
    String msisdn,
    String content,
    SmsDataCoding dataCoding,
    Instant validityPeriod,
    byte priorityFlag,
    int registeredDelivery
) {
    public SmsMessage {
        if (priorityFlag < 0 || priorityFlag > 3) {
            throw new IllegalArgumentException("Priority flag must be 0-3");
        }
    }
}
