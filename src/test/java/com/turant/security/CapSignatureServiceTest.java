package com.turant.security;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Layer 3 — Digital CAP Signing tests.
 * Real asymmetric cryptography (RSA 2048 SHA256withRSA), canonicalization, tampering detection.
 */
class CapSignatureServiceTest {

    private KeyPair keyPair;
    private String publicKeyPem;
    private CapSignatureService service;

    @BeforeEach
    void setUp() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(2048);
        keyPair = kpg.generateKeyPair();
        publicKeyPem = "-----BEGIN PUBLIC KEY-----\n" +
                Base64.getMimeEncoder(64, new byte[]{'\n'}).encodeToString(keyPair.getPublic().getEncoded()) +
                "\n-----END PUBLIC KEY-----";
        service = new CapSignatureService(publicKeyPem, null, "SHA256withRSA");
    }

    @Test
    void validSignature_verifiesSuccessfully() throws Exception {
        String capXml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
                <identifier>TURANT-ALERT-001</identifier>
                <sender>india.ews@gov.in</sender>
                <sent>2026-09-02T10:00:00Z</sent>
                <status>Actual</status>
                <msgType>Alert</msgType>
                <scope>Public</scope>
                <info>
                    <event>Cyclone Warning</event>
                    <urgency>Immediate</urgency>
                    <severity>Extreme</severity>
                    <certainty>Observed</certainty>
                </info>
            </alert>
            """;
        String canonical = service.canonicalize(capXml);
        String signature = CapSignatureService.signWithPrivateKey(canonical, keyPair.getPrivate(), "SHA256withRSA");

        var result = service.verify(capXml, signature, "tsp-a");
        assertEquals(CapSignatureService.SignatureResult.VALID, result);
    }

    @Test
    void tamperedCap_failsVerification() throws Exception {
        String originalCap = """
            <?xml version="1.0" encoding="UTF-8"?>
            <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
                <identifier>TURANT-ALERT-002</identifier>
                <sender>india.ews@gov.in</sender>
                <info><event>Flood</event></info>
            </alert>
            """;
        String canonical = service.canonicalize(originalCap);
        String signature = CapSignatureService.signWithPrivateKey(canonical, keyPair.getPrivate(), "SHA256withRSA");

        // Attacker alters payload (e.g. changing event to Earthquake)
        String tamperedCap = originalCap.replace("Flood", "Earthquake");

        var result = service.verify(tamperedCap, signature, "tsp-a");
        assertEquals(CapSignatureService.SignatureResult.INVALID, result);
    }

    @Test
    void malformedSignature_returnsMalformed() {
        String capXml = "<alert><identifier>ALERT-003</identifier></alert>";
        var result = service.verify(capXml, "NOT-VALID-BASE64!@#$", "tsp-a");
        assertEquals(CapSignatureService.SignatureResult.MALFORMED, result);
    }

    @Test
    void missingSignature_returnsMissing() {
        String capXml = "<alert><identifier>ALERT-004</identifier></alert>";
        var result = service.verify(capXml, null, "tsp-a");
        assertEquals(CapSignatureService.SignatureResult.MISSING, result);
    }

    @Test
    void signatureSignedWithWrongKey_failsVerification() throws Exception {
        KeyPairGenerator kpg2 = KeyPairGenerator.getInstance("RSA");
        kpg2.initialize(2048);
        KeyPair untrustedPair = kpg2.generateKeyPair();

        String capXml = "<alert><identifier>ALERT-005</identifier><sender>untrusted@bad.org</sender></alert>";
        String canonical = service.canonicalize(capXml);
        String signature = CapSignatureService.signWithPrivateKey(canonical, untrustedPair.getPrivate(), "SHA256withRSA");

        var result = service.verify(capXml, signature, "untrusted-client");
        assertEquals(CapSignatureService.SignatureResult.INVALID, result);
    }

    @Test
    void disabledMode_returnsDisabled() throws Exception {
        CapSignatureService disabledService = new CapSignatureService(null, null, "SHA256withRSA");
        var result = disabledService.verify("<alert/>", "any-sig", "client");
        assertEquals(CapSignatureService.SignatureResult.DISABLED, result);
    }

    @Test
    void extractSignatureFromCapXml_findsEmbeddedSignature() {
        String xml = """
            <alert>
                <code><valueName>signature</valueName><value>dGVzdC1zaWduYXR1cmU=</value></code>
            </alert>
            """;
        var extracted = service.extractSignatureFromCap(xml);
        assertTrue(extracted.isPresent());
        assertEquals("dGVzdC1zaWduYXR1cmU=", extracted.get());
    }
}
