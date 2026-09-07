package com.turant.smpp;

import com.turant.dlr.DlrListener;
import com.turant.dlr.DlrReporter;
import com.turant.types.sms.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.Tag;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * LIVE SMPPSim test — validates real SmppClient against haifzhan/SMPPSim on 127.0.0.1:5555
 * Credentials: pavel / wpsd / SMPP (DEVELOPMENT/TEST ONLY)
 * Run: mvn test -Dtest=SmppsimLiveTest -o  OR  mvn test -Dgroups=live
 * Requires SMPPSim running on 127.0.0.1:5555
 * This test is NOT mocked — it performs real TCP + SMPP bind + submit_sm.
 * Excluded from default mvn test via surefire <excludes>SmppsimLiveTest.java</excludes> to avoid CI failure when SMPPSim is down.
 * Run explicitly: mvn test -Dtest=SmppsimLiveTest -o  (or mvn test -Dtest=SmppsimLiveTest#testTcpBindAndAuthentication)
 */
@SpringBootTest
@ActiveProfiles("test")
@TestPropertySource(properties = {
        "simulation.mode=enabled",
        "tower.source-mode=simulated",
        "smpp.host=127.0.0.1",
        "smpp.port=5555",
        "smpp.system-id=pavel",
        "smpp.password=wpsd",
        "smpp.system-type=SMPP",
        "smpp.bind-mode=transceiver",
        "smpp.submit-timeout-ms=10000",
        "turant.smpp.host=127.0.0.1",
        "turant.smpp.port=5555",
        "turant.smpp.system-id=pavel",
        "turant.smpp.password=wpsd",
        "turant.smpp.system-type=SMPP",
        "springdoc.api-docs.enabled=false",
        "springdoc.swagger-ui.enabled=false"
})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SmppsimLiveTest {

    @Autowired
    private SmppClient smppClient;

    @Autowired
    private DlrListener dlrListener;

    @Autowired
    private DlrReporter dlrReporter;

    @Test
    @Order(1)
    void testConfigurationBinding() {
        // Verify Spring correctly bound env vars to SmppClient fields
        assertTrue(smppClient.isConfigured(), "SmppClient should be configured with 127.0.0.1:5555 pavel");
        // Also verify via TurantConfig would be same (injected via @Value)
        // Host/port are read from ${smpp.host} and ${turant.smpp.host} — both map to SMPP_HOST
    }

    @Test
    @Order(2)
    void testTcpBindAndAuthentication() throws Exception {
        long start = System.currentTimeMillis();
        var future = smppClient.connect();
        assertDoesNotThrow(() -> future.get(10, TimeUnit.SECONDS), "SMPP connect/bind must succeed to SMPPSim 127.0.0.1:5555 pavel/wpsd");
        long elapsed = System.currentTimeMillis() - start;
        System.out.println("[LIVE] TCP+bind elapsedMs=" + elapsed + " host=127.0.0.1 port=5555 systemId=pavel bind=transceiver");
        // Second connect should be no-op (already bound)
        assertDoesNotThrow(() -> smppClient.connect().get(5, TimeUnit.SECONDS));
    }

    @Test
    @Order(3)
    void testSubmitSmAndMessageId() throws Exception {
        smppClient.connect().get(10, TimeUnit.SECONDS);
        Instant validity = Instant.now().plus(2, ChronoUnit.HOURS);
        byte priority = PriorityFlags.earlyWarningPriorityFlag(); // 3
        String validityStr = ValidityPeriod.toSmppValidityPeriod(validity);
        assertNotNull(validityStr);
        assertEquals(16, validityStr.length());
        assertTrue(PriorityFlags.isValidPriorityFlag(priority));

        SmsMessage msg = new SmsMessage(
                "live-test-" + System.currentTimeMillis(),
                "live-alert-001",
                "919000000001", // SMPPSim test MSISDN (no country + prefix, SMPPSim accepts 919... per fixtures)
                "TURANT SMPPSim validation against 127.0.0.1:5555",
                SmsDataCoding.SEVEN_BIT,
                validity,
                priority,
                1 // registered_delivery=1 for DLR if supported
        );

        long start = System.currentTimeMillis();
        var resultFuture = smppClient.submitSingle(msg);
        SubmissionResult result = resultFuture.get(10, TimeUnit.SECONDS);
        long elapsed = System.currentTimeMillis() - start;

        System.out.println("[LIVE] submit_sm result: messageId=" + result.messageId()
                + " msisdn=" + result.msisdn()
                + " outcome=" + result.outcome()
                + " smscMessageId=" + result.smscMessageId()
                + " errorCode=" + result.errorCode()
                + " errorText=" + result.errorText()
                + " elapsedMs=" + elapsed);

        assertNotNull(result);
        assertNotNull(result.messageId());
        assertEquals(msg.msisdn(), result.msisdn());
        // SMPPSim should accept — if rejected, log details but fail test
        if (result.outcome() != DeliveryOutcome.accepted) {
            fail("SMPPSim rejected submit_sm: outcome=" + result.outcome() + " errorCode=" + result.errorCode() + " error=" + result.errorText());
        }
        assertNotNull(result.smscMessageId(), "SMPPSim must return message ID on submit_sm_resp");
        assertFalse(result.smscMessageId().isEmpty(), "smscMessageId must not be empty");
        // Validity/priority preserved: verify via message construction, not via SMPPSim echo
        assertEquals(validity, msg.validityPeriod());
        assertEquals(priority, msg.priorityFlag());
    }

    @Test
    @Order(4)
    void testSmppErrorHandlingWithInvalidMessage() throws Exception {
        smppClient.connect().get(10, TimeUnit.SECONDS);
        // Empty content should be rejected by client-side validation (IllegalArgumentException → failed outcome)
        SmsMessage emptyMsg = new SmsMessage(
                "live-err-" + System.currentTimeMillis(),
                "live-alert-001",
                "919000000002",
                "", // empty — should trigger validation
                SmsDataCoding.SEVEN_BIT,
                Instant.now().plus(1, ChronoUnit.HOURS),
                (byte) 3,
                1
        );
        var result = smppClient.submitSingle(emptyMsg).get(10, TimeUnit.SECONDS);
        // Client validates length before submit, so this will be failed/rejected, not accepted
        assertNotNull(result);
        System.out.println("[LIVE] error handling result for empty content: outcome=" + result.outcome() + " error=" + result.errorText());
        // Outcome should be failed (client-side validation) — not accepted
        assertTrue(result.outcome() == DeliveryOutcome.failed || result.outcome() == DeliveryOutcome.rejected);
    }

    @Test
    @Order(5)
    void testRealClientNotSimulated() {
        // Verify we are using real SmppClient, not SimulatedSmppClient (both exist when simulation.mode=enabled, but we autowire real)
        assertEquals("com.turant.smpp.SmppClient", smppClient.getClass().getName(),
                "Must use real SmppClient, not simulated, when SMPP_HOST is configured");
        // Also verify real client is configured with 127.0.0.1:5555, not falling back to simulated
        assertTrue(smppClient.isConfigured());
    }

    @Test
    @Order(6)
    void testDlrReceiveAndCorrelation() throws Exception {
        smppClient.connect().get(10, TimeUnit.SECONDS);
        String alertId = "dlr-live-" + System.currentTimeMillis();
        Instant validity = Instant.now().plus(2, ChronoUnit.HOURS);
        SmsMessage msg = new SmsMessage(
                "dlr-msg-" + System.currentTimeMillis(),
                alertId,
                "919000000099",
                "DLR correlation test",
                SmsDataCoding.SEVEN_BIT,
                validity,
                PriorityFlags.earlyWarningPriorityFlag(),
                1 // registeredDelivery=1 to request DLR
        );
        SubmissionResult result = smppClient.submitSingle(msg).get(10, TimeUnit.SECONDS);
        assertNotNull(result);
        assertEquals(DeliveryOutcome.accepted, result.outcome());
        String smscMessageId = result.smscMessageId();
        assertNotNull(smscMessageId, "Must capture smscMessageId for DLR correlation");
        assertFalse(smscMessageId.isBlank());
        System.out.println("[LIVE-DLR] submitted smscMessageId=" + smscMessageId + " alertId=" + alertId);

        // Wait for deliver_sm (SMPPSim sends DLR asynchronously, typically <2s)
        DlrListener.AlertReceiptStats stats = null;
        DlrReceipt receipt = null;
        for (int i = 0; i < 20; i++) {
            Thread.sleep(500);
            stats = dlrListener.receiptsForAlert(alertId);
            if (stats != null && stats.getReceivedCount() > 0) {
                receipt = stats.getReceived().get(0);
                break;
            }
        }
        assertNotNull(stats, "DLR stats should be recorded for alertId " + alertId);
        assertTrue(stats.getReceivedCount() >= 1, "At least one DLR should be received");
        assertNotNull(receipt, "Receipt should be parsed");
        System.out.println("[LIVE-DLR] received smscMessageId=" + receipt.smscMessageId() + " state=" + receipt.messageState() + " err=" + receipt.errorCode() + " deliveredAt=" + receipt.deliveredAt());
        // Correlate: DLR id must match submit's smscMessageId
        assertEquals(smscMessageId, receipt.smscMessageId(), "DLR id must correlate with submit_sm_resp smscMessageId");
        // Handle at least DELIVRD (SMPPSim default)
        assertTrue(receipt.messageState() != null && (
                receipt.messageState().equals("DELIVRD") ||
                receipt.messageState().equals("EXPIRED") ||
                receipt.messageState().equals("UNDELIV") ||
                receipt.messageState().equals("REJECTD") ||
                receipt.messageState().equals("DELETED") ||
                receipt.messageState().equals("ACCEPTD") ||
                receipt.messageState().equals("ENROUTE")),
                "State should be one of expected DLR states, got " + receipt.messageState());
        // Verify DlrReporter aggregates correctly
        var report = dlrReporter.buildDeliveryReport(alertId);
        assertNotNull(report);
        assertEquals(alertId, report.getCapIdentifier());
        assertTrue(report.getDelivered() >= 1);
        System.out.println("[LIVE-DLR] report delivered=" + report.getDelivered() + " expected=" + report.getExpectedRecipients() + " firstMs=" + report.getFirstReceivedEpochMs());
    }

    @AfterEach
    void cleanup() {
        try { smppClient.close(); } catch (Exception ignored) {}
    }
}
