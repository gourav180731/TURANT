package com.turant.types.sms;

import java.time.Instant;

/**
 * Normalized delivery receipt parsed from a deliver_sm PDU (module 11).
 */
public record DlrReceipt(
    String smscMessageId,
    String messageState,
    String errorCode,
    Instant deliveredAt
) {}
