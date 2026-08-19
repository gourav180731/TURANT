package com.turant.types.sms;

/**
 * Result of an SMS submission attempt.
 */
public record SubmissionResult(
    String messageId,
    String msisdn,
    DeliveryOutcome outcome,
    String smscMessageId,
    Integer errorCode,
    String errorText,
    DlrReceipt dlr
) {}
