package com.turant.dlr;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for DlrReporter (Module 11).
 * 
 * Tests delivery report generation and aggregation.
 */
class DlrReporterTest {
    
    private DlrListener listener;
    private DlrReporter reporter;
    
    @BeforeEach
    void setUp() {
        listener = new DlrListener(() -> Instant.parse("2026-08-19T10:00:00Z"));
        reporter = new DlrReporter(listener);
    }
    
    @Test
    void testBuildDeliveryReportWithNoReceipts() {
        // Given: No receipts for alert
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-001");
        
        // Then: Should return empty report
        assertNotNull(report);
        assertEquals("alert-001", report.getCapIdentifier());
        assertEquals(0, report.getExpectedRecipients());
        assertEquals(0, report.getDelivered());
        assertTrue(report.getDeliveredTo().isEmpty());
        assertNull(report.getFirstReceivedEpochMs());
        assertNull(report.getLastReceivedEpochMs());
    }
    
    @Test
    void testBuildDeliveryReportWithSingleReceipt() {
        // Given: One submission and receipt
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-001");
        
        // Then: Should show one delivery
        assertNotNull(report);
        assertEquals("alert-001", report.getCapIdentifier());
        assertEquals(1, report.getDelivered());
        assertEquals(1, report.getDeliveredTo().size());
        assertNotNull(report.getFirstReceivedEpochMs());
        assertNotNull(report.getLastReceivedEpochMs());
    }
    
    @Test
    void testBuildDeliveryReportWithMultipleReceipts() {
        // Given: Multiple submissions and receipts
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.registerSubmission("SMSC-002", "msg-002", "alert-001", "+919000000002");
        listener.registerSubmission("SMSC-003", "msg-003", "alert-001", "+919000000003");
        
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-002 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-003 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-001");
        
        // Then: Should aggregate all deliveries
        assertNotNull(report);
        assertEquals("alert-001", report.getCapIdentifier());
        assertEquals(3, report.getDelivered());
        assertEquals(3, report.getDeliveredTo().size());
    }
    
    @Test
    void testBuildDeliveryReportWithExpectedCount() {
        // Given: Submissions with expected count
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.registerSubmission("SMSC-002", "msg-002", "alert-001", "+919000000002");
        
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-002 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // Set expected count
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        stats.setExpectedCount(10);
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-001");
        
        // Then: Should show expected vs actual
        assertNotNull(report);
        assertEquals(10, report.getExpectedRecipients());
        assertEquals(2, report.getDelivered());
    }
    
    @Test
    void testBuildDeliveryReportPartialDelivery() {
        // Given: Some successful, some failed
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.registerSubmission("SMSC-002", "msg-002", "alert-001", "+919000000002");
        listener.registerSubmission("SMSC-003", "msg-003", "alert-001", "+919000000003");
        
        // Only 2 receipts received
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-002 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-001");
        stats.setExpectedCount(3);
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-001");
        
        // Then: Should show partial delivery
        assertNotNull(report);
        assertEquals(3, report.getExpectedRecipients());
        assertEquals(2, report.getDelivered());
    }
    
    @Test
    void testDeliveryReportTracksTimings() {
        // Given: Receipts with timing
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-001");
        
        // Then: Should include timing information
        assertNotNull(report);
        assertNotNull(report.getFirstReceivedEpochMs());
        assertNotNull(report.getLastReceivedEpochMs());
    }
    
    @Test
    void testDeliveryReportFields() {
        // Given: Complete delivery scenario
        listener.registerSubmission("SMSC-001", "msg-001", "alert-earthquake", "+919000000001");
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        DlrListener.AlertReceiptStats stats = listener.receiptsForAlert("alert-earthquake");
        stats.setExpectedCount(5);
        
        // When: Building report
        DlrReporter.DeliveryReport report = reporter.buildDeliveryReport("alert-earthquake");
        
        // Then: All fields should be populated correctly
        assertEquals("alert-earthquake", report.getCapIdentifier());
        assertEquals(5, report.getExpectedRecipients());
        assertEquals(1, report.getDelivered());
        assertFalse(report.getDeliveredTo().isEmpty());
        assertEquals("SMSC-001", report.getDeliveredTo().get(0));
        assertNotNull(report.getFirstReceivedEpochMs());
        assertNotNull(report.getLastReceivedEpochMs());
    }
    
    @Test
    void testBuildReportForMultipleAlerts() {
        // Given: Multiple alerts with receipts
        listener.registerSubmission("SMSC-001", "msg-001", "alert-001", "+919000000001");
        listener.registerSubmission("SMSC-002", "msg-002", "alert-002", "+919000000002");
        
        listener.handleReceipt("id:SMSC-001 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        listener.handleReceipt("id:SMSC-002 sub:001 dlvrd:001 stat:DELIVRD err:000", null);
        
        // When: Building reports for different alerts
        DlrReporter.DeliveryReport report1 = reporter.buildDeliveryReport("alert-001");
        DlrReporter.DeliveryReport report2 = reporter.buildDeliveryReport("alert-002");
        
        // Then: Should generate separate reports
        assertNotNull(report1);
        assertNotNull(report2);
        assertEquals("alert-001", report1.getCapIdentifier());
        assertEquals("alert-002", report2.getCapIdentifier());
        assertEquals(1, report1.getDelivered());
        assertEquals(1, report2.getDelivered());
    }
}
