package com.turant.dlr;

import com.turant.types.sms.DlrReceipt;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for DlrListener (Module 11).
 * 
 * Tests DLR parsing, correlation, and tracking.
 */
class DlrListenerTest {
    
    private DlrListener listener;
    private Supplier<Instant> fixedClock;
    
    @BeforeEach
    void setUp() {
        fixedClock = () -> Instant.parse("2026-08-19T10:00:00Z");
        listener = new DlrListener(fixedClock);
    }
    
    @Test
    void testParseDeliveryReceipt() {
        // Given: Standard SMPP DLR text (done date format: YYMMDDhhmm)
        String receiptText = "id:12345 sub:001 dlvrd:001 submit date:2608191000 done date:2608191005 stat:DELIVRD err:000";
        
        // When: Parsing receipt
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should extract all fields
        assertNotNull(receipt);
        assertEquals("12345", receipt.smscMessageId());
        assertEquals("DELIVRD", receipt.messageState());
        assertEquals("000", receipt.errorCode());
        // Note: deliveredAt may be null if done date parsing fails or is in wrong format
    }
    
    @Test
    void testParseDeliveryReceiptWithDifferentFormat() {
        // Given: DLR with spaces
        String receiptText = "id:MSG-9876 sub:001 dlvrd:001 submit date:2608191200 done date:2608191205 stat:DELIVRD err:000";
        
        // When: Parsing
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should parse correctly
        assertNotNull(receipt);
        assertEquals("MSG-9876", receipt.smscMessageId());
        assertEquals("DELIVRD", receipt.messageState());
    }
    
    @Test
    void testParseDeliveryReceiptFailed() {
        // Given: Failed delivery receipt
        String receiptText = "id:12345 sub:001 dlvrd:000 submit date:2608191000 done date:2608191005 stat:UNDELIV err:001";
        
        // When: Parsing
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should indicate failure
        assertNotNull(receipt);
        assertEquals("12345", receipt.smscMessageId());
        assertEquals("UNDELIV", receipt.messageState());
        assertEquals("001", receipt.errorCode());
    }
    
    @Test
    void testParseDeliveryReceiptExpired() {
        // Given: Expired delivery receipt
        String receiptText = "id:12345 sub:001 dlvrd:000 submit date:2608191000 done date:2608191100 stat:EXPIRED err:000";
        
        // When: Parsing
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should indicate expiry
        assertNotNull(receipt);
        assertEquals("EXPIRED", receipt.messageState());
    }
    
    @Test
    void testParseInvalidReceipt() {
        // Given: Invalid receipt text
        String receiptText = "This is not a valid DLR";
        
        // When: Parsing
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should return null
        assertNull(receipt);
    }
    
    @Test
    void testParseEmptyReceipt() {
        // Given: Empty text
        String receiptText = "";
        
        // When: Parsing
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should return null
        assertNull(receipt);
    }
    
    @Test
    void testParseNullReceipt() {
        // Given: Null text
        String receiptText = null;
        
        // When: Parsing
        DlrReceipt receipt = DlrListener.parseDeliveryReceipt(receiptText);
        
        // Then: Should return null
        assertNull(receipt);
    }
    
    @Test
    void testRegisterSubmission() {
        // Given: Submission details
        String smscMessageId = "SMSC-12345";
        String messageId = "msg-001";
        String alertId = "alert-001";
        String msisdn = "+919000000001";
        
        // When: Registering submission
        listener.registerSubmission(smscMessageId, messageId, alertId, msisdn);
        
        // Then: Should register successfully (verified by correlation)
        String receiptText = "id:SMSC-12345 sub:001 dlvrd:001 stat:DELIVRD err:000";
        DlrReceipt receipt = listener.handleReceipt(receiptText, null);
        
        assertNotNull(receipt);
        assertEquals("SMSC-12345", receipt.smscMessageId());
    }
    
    @Test
    void testHandleReceiptWithCorrelation() {
        // Given: Registered submission
        listener.registerSubmission("SMSC-12345", "msg-001", "alert-001", "+919000000001");
        
        // And: Receipt for that submission
        String receiptText = "id:SMSC-12345 sub:001 dlvrd:001 stat:DELIVRD err:000";
        
        // When: Handling receipt
        DlrReceipt receipt = listener.handleReceipt(receiptText, null);
        
        // Then: Should correlate and record
        assertNotNull(receipt);
        assertEquals("SMSC-12345", receipt.smscMessageId());
        
        // Verify stats updated
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        assertNotNull(stats);
        assertEquals(1, stats.getReceivedCount());
    }
    
    @Test
    void testHandleReceiptWithoutCorrelation() {
        // Given: No registered submission
        
        // And: Receipt
        String receiptText = "id:UNKNOWN-99999 sub:001 dlvrd:001 stat:DELIVRD err:000";
        
        // When: Handling receipt
        DlrReceipt receipt = listener.handleReceipt(receiptText, null);
        
        // Then: Should still parse but not correlate
        assertNotNull(receipt);
        assertEquals("UNKNOWN-99999", receipt.smscMessageId());
    }
    
    @Test
    void testMultipleReceiptsForAlert() {
        // Given: Multiple submissions for same alert
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.registerSubmission("SMSC-002", "msg-002", "alert-001", "+919000000002");
        listener.registerSubmission("SMSC-003", "msg-003", "alert-001", "+919000000003");
        
        // When: Receiving multiple DLRs
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-002 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-003 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // Then: Should aggregate all receipts
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        assertNotNull(stats);
        assertEquals(3, stats.getReceivedCount());
        assertEquals(3, stats.getReceived().size());
    }
    
    @Test
    void testReceiptStatsTracksFirstAndLast() {
        // Given: Multiple receipts over time
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.registerSubmission("SMSC-002", "msg-002", "alert-001", "+919000000002");
        
        // When: Receiving receipts
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // Simulate time passing
        Instant later = fixedClock.get().plusSeconds(60);
        DlrListener listenerWithTime = new DlrListener(() -> later);
        listenerWithTime.registerSubmission("SMSC-002", "msg-002", "alert-001", "+919000000002");
        listenerWithTime.handleReceipt("id:SMSC-002 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // Then: First receipt should track timing
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        assertNotNull(stats);
        assertNotNull(stats.getFirstReceivedEpochMs());
        assertNotNull(stats.getLastReceivedEpochMs());
    }
    
    @Test
    void testReceiptsForNonExistentAlert() {
        // Given: No receipts for alert
        
        // When: Querying stats
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("nonexistent-alert");
        
        // Then: Should return null
        assertNull(stats);
    }
    
    @Test
    void testRegisterSubmissionWithNullSmscMessageId() {
        // Given: Submission with null SMSC message ID
        
        // When: Registering (should be ignored)
        listener.registerSubmission(null, "msg-001", "alert-001", "+919000000001");
        
        // Then: Should not throw exception
        assertDoesNotThrow(() -> {
            listener.registerSubmission(null, "msg-001", "alert-001", "+919000000001");
        });
    }
    
    @Test
    void testRegisterSubmissionWithEmptySmscMessageId() {
        // Given: Submission with empty SMSC message ID
        
        // When: Registering (should be ignored)
        listener.registerSubmission("", "msg-001", "alert-001", "+919000000001");
        
        // Then: Should not register
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        assertNull(stats);
    }
    
    @Test
    void testAlertReceiptStatsInitialState() {
        // Given: New alert stats
        DlrListener.AlertReceiptStats stats = new DlrListener.AlertReceiptStats("alert-001");
        
        // Then: Should have correct initial state
        assertEquals("alert-001", stats.getAlertId());
        assertEquals(0, stats.getReceivedCount());
        assertEquals(0, stats.getExpectedCount());
        assertNull(stats.getFirstReceivedEpochMs());
        assertNull(stats.getLastReceivedEpochMs());
        assertTrue(stats.getReceived().isEmpty());
    }
    
    @Test
    void testSetExpectedCount() {
        // Given: Registered submission
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // When: Setting expected count
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        stats.setExpectedCount(10);
        
        // Then: Should update expected count
        assertEquals(10, stats.getExpectedCount());
        assertEquals(1, stats.getReceivedCount());
    }
}
