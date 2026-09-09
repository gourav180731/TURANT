-- 011 Security Audit Trail — Item #2 Layer 10 Immutable/Tamper-Evident
CREATE TABLE IF NOT EXISTS security_audit (
    seq BIGSERIAL,
    id UUID PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id TEXT NOT NULL,
    client_id TEXT,
    cert_subject TEXT,
    source_ip TEXT,
    endpoint TEXT,
    method TEXT,
    cap_id TEXT,
    event TEXT NOT NULL,
    result TEXT,
    reason TEXT,
    previous_hash TEXT,
    current_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_audit_request ON security_audit(request_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_cap ON security_audit(cap_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_event ON security_audit(event);
CREATE INDEX IF NOT EXISTS idx_security_audit_timestamp ON security_audit(timestamp);
-- Tamper-evident: revoke update/delete for app user (turant) — only INSERT+SELECT
-- Applied manually: REVOKE UPDATE, DELETE ON security_audit FROM turant;
COMMENT ON TABLE security_audit IS 'Immutable audit trail with hash chain previous_hash→current_hash';
