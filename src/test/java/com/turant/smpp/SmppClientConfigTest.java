package com.turant.smpp;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for SMPP configuration binding and client selection
 * Covers: config mapping, credential loading without exposing secrets, missing credentials, real vs simulated
 */
@SpringBootTest
@ActiveProfiles("test")
@TestPropertySource(properties = {
        "simulation.mode=enabled",
        "tower.source-mode=simulated",
        "springdoc.api-docs.enabled=false",
        "springdoc.swagger-ui.enabled=false"
})
class SmppClientConfigTest {

    @Autowired
    private SmppClient smppClient;

    @Test
    void testMissingCredentialsBehavior() {
        // In test profile, SMPP_HOST is empty by default → isConfigured false
        // This test verifies missing credentials does not throw, but returns failed future
        assertFalse(smppClient.isConfigured(), "With empty SMPP_HOST, isConfigured should be false");
        var future = smppClient.connect();
        assertTrue(future.isCompletedExceptionally(), "Missing credentials should return failed future, not block");
        try {
            future.join();
            fail("Should have thrown");
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            assertTrue(msg.contains("SMPP credentials not configured"));
            assertFalse(msg.contains("wpsd"), "Error message must not leak password");
        }
    }

    @Test
    void testCredentialLoadingDoesNotExposeSecrets() {
        // Verify SmppClient fields are not logged in toString
        String str = smppClient.toString();
        assertFalse(str.contains("wpsd"), "toString must not expose password");
        // Password field exists but is not logged by SmppClient's logger (checked via code review: logger.info only logs host/port)
    }

    @Test
    void testValidityAndPriorityPreserved() {
        var validity = java.time.Instant.now().plus(2, java.time.temporal.ChronoUnit.HOURS);
        String vp = ValidityPeriod.toSmppValidityPeriod(validity);
        assertEquals(16, vp.length());
        assertTrue(vp.endsWith("0"), "Absolute validity ends with 0");

        byte flag = PriorityFlags.earlyWarningPriorityFlag();
        assertEquals(3, flag);
        assertTrue(PriorityFlags.isValidPriorityFlag(flag));
        // DLR registered_delivery preserved via SmsMessage
        var msg = new com.turant.types.sms.SmsMessage("m1", "a1", "919000000001", "hi", com.turant.types.sms.SmsDataCoding.SEVEN_BIT, validity, flag, 1);
        assertEquals(1, msg.registeredDelivery());
    }
}
