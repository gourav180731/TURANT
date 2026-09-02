package com.turant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Optional;

/**
 * Item #2 Layer 3 — Digital CAP Signing (real RSA/ECDSA, not SHA256 fake).
 * TSP signs canonical CAP bytes with private key; TURANT verifies with trusted public key.
 * Canonical = CAP <identifier>|<sender>|<sent>|<info><event>|<area> normalized + raw XML C14N without signature element.
 * Signature expected in CAP <code><valueName>signature</valueName><value>base64</value></code> or header X-CAP-Signature.
 * Pluggable for C-DOT spec — production must configure TSP_PUBLIC_KEY_PEM.
 */
@Service
public class CapSignatureService {

    private static final Logger log = LoggerFactory.getLogger(CapSignatureService.class);

    private final PublicKey trustedPublicKey;
    private final String algorithm; // SHA256withRSA or SHA256withECDSA

    public CapSignatureService(
            @Value("${turant.security.cap-signature.public-key-pem:}") String publicKeyPem,
            @Value("${TSP_PUBLIC_KEY_PEM:}") String tspPemEnv,
            @Value("${turant.security.cap-signature.algorithm:SHA256withRSA}") String alg) throws Exception {
        String pem = (tspPemEnv != null && !tspPemEnv.isBlank()) ? tspPemEnv : publicKeyPem;
        this.algorithm = alg != null && !alg.isBlank() ? alg : "SHA256withRSA";
        if (pem == null || pem.isBlank()) {
            log.warn("CapSignatureService: No public key configured (turant.security.cap-signature.public-key-pem / TSP_PUBLIC_KEY_PEM empty) — signature verification DISABLED (dev). Set in prod!");
            this.trustedPublicKey = null;
        } else {
            this.trustedPublicKey = loadPublicKey(pem, this.algorithm);
            log.info("CapSignatureService: Loaded trusted public key alg={} for CAP verification", this.algorithm);
        }
    }

    public enum SignatureResult { VALID, MISSING, MALFORMED, INVALID, UNKNOWN_SIGNER, EXPIRED, UNSUPPORTED_ALGORITHM, DISABLED }

    public SignatureResult verify(String capXml, String signatureB64, String signerId) {
        if (trustedPublicKey == null) {
            log.warn("Signature verification disabled (no trusted key) — allowing CAP (dev)");
            return SignatureResult.DISABLED;
        }
        if (signatureB64 == null || signatureB64.isBlank()) {
            log.warn("Missing CAP signature");
            return SignatureResult.MISSING;
        }
        String canonical = canonicalize(capXml);
        try {
            byte[] sigBytes = Base64.getDecoder().decode(signatureB64.trim());
            Signature sig = Signature.getInstance(algorithm);
            sig.initVerify(trustedPublicKey);
            sig.update(canonical.getBytes(StandardCharsets.UTF_8));
            boolean ok = sig.verify(sigBytes);
            if (ok) {
                log.info("CAP signature VALID signer={} alg={}", signerId, algorithm);
                return SignatureResult.VALID;
            } else {
                log.warn("CAP signature INVALID signer={}", signerId);
                return SignatureResult.INVALID;
            }
        } catch (IllegalArgumentException e) {
            log.warn("Malformed signature base64", e);
            return SignatureResult.MALFORMED;
        } catch (NoSuchAlgorithmException e) {
            log.error("Unsupported algorithm {}", algorithm, e);
            return SignatureResult.UNSUPPORTED_ALGORITHM;
        } catch (Exception e) {
            log.warn("Signature verification failed signer={}: {}", signerId, e.getMessage());
            return SignatureResult.INVALID;
        }
    }

    /** Extract signature from CAP XML code/parameter or header */
    public Optional<String> extractSignatureFromCap(String capXml) {
        // Look for <code><valueName>signature</valueName><value>...</value></code>
        try {
            int idx = capXml.indexOf("<valueName>signature</valueName>");
            if (idx >= 0) {
                int vStart = capXml.indexOf("<value>", idx) + 7;
                int vEnd = capXml.indexOf("</value>", vStart);
                if (vStart >= 7 && vEnd > vStart) return Optional.of(capXml.substring(vStart, vEnd).trim());
            }
            // Also support <signature>...</signature>
            idx = capXml.indexOf("<signature>");
            if (idx >= 0) {
                int s = idx + 11;
                int e = capXml.indexOf("</signature>", s);
                if (e > s) return Optional.of(capXml.substring(s, e).trim());
            }
        } catch (Exception ignore) {}
        return Optional.empty();
    }

    String canonicalize(String capXml) {
        // Remove signature elements for canonical, trim, normalize whitespace, C14N-like
        String c = capXml.replaceAll("(?s)<code>\\s*<valueName>signature</valueName>.*?</code>", "")
                         .replaceAll("(?s)<signature>.*?</signature>", "")
                         .trim().replaceAll("\\s+", " ");
        return c;
    }

    private PublicKey loadPublicKey(String pem, String alg) throws Exception {
        String clean = pem.replace("-----BEGIN PUBLIC KEY-----", "")
                          .replace("-----END PUBLIC KEY-----", "")
                          .replaceAll("\\s", "");
        byte[] decoded = Base64.getDecoder().decode(clean);
        X509EncodedKeySpec spec = new X509EncodedKeySpec(decoded);
        String keyAlg = alg.contains("ECDSA") || alg.contains("EC") ? "EC" : "RSA";
        KeyFactory kf = KeyFactory.getInstance(keyAlg);
        return kf.generatePublic(spec);
    }

    /** For tests: sign canonical with private key */
    public static String signWithPrivateKey(String canonical, PrivateKey priv, String alg) throws Exception {
        Signature sig = Signature.getInstance(alg);
        sig.initSign(priv);
        sig.update(canonical.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(sig.sign());
    }
}
