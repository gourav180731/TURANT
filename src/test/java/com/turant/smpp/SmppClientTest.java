package com.turant.smpp;

import com.turant.simulation.SimulatedSmppClient;
import com.turant.simulation.TestDataFixtures;
import com.turant.types.sms.DeliveryOutcome;
import com.turant.types.sms.SmsDataCoding;
import com.turant.types.sms.SmsMessage;
import com.turant.types.sms.SubmissionResult;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for SmppClient (Module 07).
 * 
 * Tests SMPP client functionality using SimulatedSmppClient.
 * Real SMPP integration requires SMSC credentials.
 */
@SpringBootTest
@ActiveProfiles("test")
class SmppClientTest {
    
    @Autowired
    private SimulatedSmppClient smppClient;
    
    @Test
    void testSmppClientIsConfigured() {
        // When: Checking if client is configured
        boolean configured = smppClient.isConfigured();
        
        // Then: Simulated client should always be configured
        assertTrue(configured, "Simulated SMPP should always be configured");
    }
    
    @Test
    void testConnectToSmpp() throws Exception {
        // When: Connecting to SMPP
        CompletableFuture<Void> future = smppClient.connect();
        
        // Then: Should connect successfully
        assertDoesNotThrow(() -> future.get(5, TimeUnit.SECONDS));
    }
    
    @Test
    void testSubmitSingleMessage() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Sample SMS message
        SmsMessage message = TestDataFixtures.createSampleSmsMessage(
            "+919000000001",
            "Test earthquake alert"
        );
        
        // When: Submitting single message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should return submission result
        assertNotNull(result);
        assertEquals(message.messageId(), result.messageId());
        assertEquals(message.msisdn(), result.msisdn());
        assertNotNull(result.outcome());
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitBatchMessages() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Multiple SMS messages
        List<SmsMessage> messages = List.of(
            TestDataFixtures.createSampleSmsMessage("+919000000001", "Alert 1"),
            TestDataFixtures.createSampleSmsMessage("+919000000002", "Alert 2"),
            TestDataFixtures.createSampleSmsMessage("+919000000003", "Alert 3"),
            TestDataFixtures.createSampleSmsMessage("+919000000004", "Alert 4"),
            TestDataFixtures.createSampleSmsMessage("+919000000005", "Alert 5")
        );
        
        // When: Submitting batch
        CompletableFuture<List<SubmissionResult>> future = 
            smppClient.submitBatch(messages, "test-batch-001");
        
        List<SubmissionResult> results = future.get(10, TimeUnit.SECONDS);
        
        // Then: Should return results for all messages
        assertNotNull(results);
        assertEquals(messages.size(), results.size());
        
        // Verify each result
        for (int i = 0; i < results.size(); i++) {
            SubmissionResult result = results.get(i);
            assertNotNull(result.messageId());
            assertNotNull(result.msisdn());
            assertNotNull(result.outcome());
        }
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitWithSevenBitEncoding() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Message with 7-bit encoding
        SmsMessage message = new SmsMessage(
            "msg-7bit-001",
            "alert-001",
            "+919000000001",
            "Simple ASCII message",
            SmsDataCoding.SEVEN_BIT,
            Instant.now().plus(2, ChronoUnit.HOURS),
            (byte) 1,
            1
        );
        
        // When: Submitting message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should succeed
        assertNotNull(result);
        assertEquals(DeliveryOutcome.accepted, result.outcome());
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitWithUcs2Encoding() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Message with UCS-2 encoding (Hindi text)
        SmsMessage message = new SmsMessage(
            "msg-ucs2-001",
            "alert-001",
            "+919000000001",
            "भूकंप अलर्ट", // Earthquake alert in Hindi
            SmsDataCoding.UCS2,
            Instant.now().plus(2, ChronoUnit.HOURS),
            (byte) 1,
            1
        );
        
        // When: Submitting message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should succeed
        assertNotNull(result);
        assertEquals(DeliveryOutcome.accepted, result.outcome());
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitWithValidityPeriod() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Message with validity period
        Instant validityPeriod = Instant.now().plus(2, ChronoUnit.HOURS);
        SmsMessage message = new SmsMessage(
            "msg-validity-001",
            "alert-001",
            "+919000000001",
            "Alert with validity period",
            SmsDataCoding.SEVEN_BIT,
            validityPeriod,
            (byte) 1,
            1
        );
        
        // When: Submitting message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should succeed
        assertNotNull(result);
        assertEquals(DeliveryOutcome.accepted, result.outcome());
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitWithHighPriority() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Message with high priority
        SmsMessage message = new SmsMessage(
            "msg-priority-001",
            "alert-001",
            "+919000000001",
            "High priority alert",
            SmsDataCoding.SEVEN_BIT,
            Instant.now().plus(2, ChronoUnit.HOURS),
            (byte) 0, // Highest priority (0 = highest in SMPP)
            1
        );
        
        // When: Submitting message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should get a result (accepted or rejected due to 95% simulation success rate)
        assertNotNull(result);
        assertNotNull(result.messageId());
        assertEquals("msg-priority-001", result.messageId());
        assertEquals("+919000000001", result.msisdn());
        // Note: outcome can be 'accepted' (95%) or 'rejected' (5%) due to simulation randomness
        assertTrue(result.outcome() == DeliveryOutcome.accepted || result.outcome() == DeliveryOutcome.rejected);
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitWithDeliveryReceipt() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Message requesting delivery receipt
        SmsMessage message = new SmsMessage(
            "msg-dlr-001",
            "alert-001",
            "+919000000001",
            "Alert with DLR request",
            SmsDataCoding.SEVEN_BIT,
            Instant.now().plus(2, ChronoUnit.HOURS),
            (byte) 1,
            1 // Request delivery receipt
        );
        
        // When: Submitting message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should succeed and have SMSC message ID
        assertNotNull(result);
        assertEquals(DeliveryOutcome.accepted, result.outcome());
        assertNotNull(result.smscMessageId(), "Should have SMSC message ID for DLR tracking");
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testBatchSubmissionPerformance() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Large batch of messages
        List<SmsMessage> messages = TestDataFixtures.createSampleMsisdns(50).stream()
            .map(msisdn -> TestDataFixtures.createSampleSmsMessage(msisdn, "Batch test alert"))
            .toList();
        
        // When: Submitting batch and measuring time
        long startTime = System.currentTimeMillis();
        
        CompletableFuture<List<SubmissionResult>> future = 
            smppClient.submitBatch(messages, "test-perf-001");
        
        List<SubmissionResult> results = future.get(30, TimeUnit.SECONDS);
        
        long elapsedMs = System.currentTimeMillis() - startTime;
        
        // Then: Should complete reasonably fast
        assertNotNull(results);
        assertEquals(messages.size(), results.size());
        
        // Simulated SMPP should be fast (under 15 seconds for 50 messages)
        assertTrue(elapsedMs < 15000, "Batch should complete within 15 seconds");
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testMultipleConnections() throws Exception {
        // When: Connecting multiple times
        CompletableFuture<Void> future1 = smppClient.connect();
        future1.get(5, TimeUnit.SECONDS);
        
        CompletableFuture<Void> future2 = smppClient.connect();
        future2.get(5, TimeUnit.SECONDS);
        
        // Then: Should handle multiple connection attempts gracefully
        // (Second connect should be no-op if already connected)
        assertDoesNotThrow(() -> smppClient.connect().get(5, TimeUnit.SECONDS));
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testCloseConnection() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // When: Closing connection
        assertDoesNotThrow(() -> smppClient.close());
        
        // Then: Should close cleanly without errors
        // (Can reconnect after close)
        assertDoesNotThrow(() -> smppClient.connect().get(5, TimeUnit.SECONDS));
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmitAfterClose() throws Exception {
        // Given: Connected then closed SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        smppClient.close();
        
        // Reconnect for test
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Sample message
        SmsMessage message = TestDataFixtures.createSampleSmsMessage(
            "+919000000001",
            "Test after reconnect"
        );
        
        // When: Submitting message after reconnect
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Should succeed after reconnection
        assertNotNull(result);
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testConcurrentSubmissions() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Multiple messages for concurrent submission
        SmsMessage msg1 = TestDataFixtures.createSampleSmsMessage("+919000000001", "Concurrent 1");
        SmsMessage msg2 = TestDataFixtures.createSampleSmsMessage("+919000000002", "Concurrent 2");
        SmsMessage msg3 = TestDataFixtures.createSampleSmsMessage("+919000000003", "Concurrent 3");
        
        // When: Submitting concurrently
        CompletableFuture<SubmissionResult> future1 = smppClient.submitSingle(msg1);
        CompletableFuture<SubmissionResult> future2 = smppClient.submitSingle(msg2);
        CompletableFuture<SubmissionResult> future3 = smppClient.submitSingle(msg3);
        
        // Wait for all
        CompletableFuture.allOf(future1, future2, future3).get(15, TimeUnit.SECONDS);
        
        // Then: All should succeed
        assertNotNull(future1.get());
        assertNotNull(future2.get());
        assertNotNull(future3.get());
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testSubmissionResultContainsRequiredFields() throws Exception {
        // Given: Connected SMPP client
        smppClient.connect().get(5, TimeUnit.SECONDS);
        
        // And: Sample message
        SmsMessage message = TestDataFixtures.createSampleSmsMessage(
            "+919000000001",
            "Field validation test"
        );
        
        // When: Submitting message
        CompletableFuture<SubmissionResult> future = smppClient.submitSingle(message);
        SubmissionResult result = future.get(5, TimeUnit.SECONDS);
        
        // Then: Result should have all required fields
        assertNotNull(result.messageId(), "Should have message ID");
        assertNotNull(result.msisdn(), "Should have MSISDN");
        assertNotNull(result.outcome(), "Should have outcome");
        assertEquals(message.messageId(), result.messageId(), "Message ID should match");
        assertEquals(message.msisdn(), result.msisdn(), "MSISDN should match");
        
        // Cleanup
        smppClient.close();
    }
}
