# TURANT Complete Production API Security Architecture

See the comprehensive 30-section security documentation in [docs/security/SECURITY_COMPLETE.md](docs/security/SECURITY_COMPLETE.md).

**Summary of Verified Layers:**
1. **Layer 1: TLS / HTTPS** — Modern TLS 1.3 / 1.2 with PFS cipher suites and HSTS.
2. **Layer 2: Mutual TLS (mTLS)** — Client X.509 certificate extraction, Subject DN validation, anti-spoofing.
3. **Layer 3: Digital CAP Signing** — RSA/ECDSA asymmetric signatures with C14N XML canonicalization.
4. **Layer 4: Authorization Engine** — Default-deny RBAC policy for operations and endpoints.
5. **Layer 5: CAP Validation & XXE Hardening** — Disallowed DTDs, entity size limits, semantic schema validation.
6. **Layer 6: Replay Protection** — PostgreSQL atomic composite primary key `(cap_identifier, sender)`.
7. **Layer 7: Client Credentials** — Per-client SHA-256 hashed API keys with in-memory caching and DB fallback.
8. **Layer 8: IP & Network Restrictions** — Global and per-client CIDR subnet allowlists.
9. **Layer 9: Rate Limiting** — Per-client, per-endpoint token bucket algorithm returning HTTP 429.
10. **Layer 10: Immutable Audit Trail** — Tamper-evident SHA-256 hash chaining with DB-level revoked UPDATE/DELETE permissions.

**Verification Status:**
- Automated Tests: 217 / 217 passing (`BUILD SUCCESS`).
- Postman Collection: `postman/TURANT_SECURITY_COLLECTION.json` (Tests S01 through S19).
- Postman Environment: `postman/TURANT_SECURITY_ENVIRONMENT.json`.
