-- 013 Per-Client Credentials — Item #2 Layer 7 & 4
CREATE TABLE IF NOT EXISTS client_credentials (
    client_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL, -- SHA256 hex of API key (not plaintext)
    cert_subject TEXT, -- expected mTLS subject DN for binding
    allowed_ips TEXT, -- comma-separated CIDR, e.g., 203.0.113.0/24,198.51.100.5/32
    roles TEXT NOT NULL DEFAULT 'EWS_SUBMIT', -- comma-separated: EWS_SUBMIT,GET_STATUS,ADMIN
    rate_limit_per_min INT NOT NULL DEFAULT 60,
    enabled BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_client_credentials_enabled ON client_credentials(enabled);
COMMENT ON TABLE client_credentials IS 'Per-TSP credentials: api_key_hash, cert_subject, allowed_ips, roles, rate_limit, enabled/revoked';
-- Seed test clients (dev only, disabled in prod via enabled=false or via env override)
INSERT INTO client_credentials (client_id, display_name, api_key_hash, roles, enabled)
VALUES ('tsp-a', 'TSP-A Test', '953a6f3acb148f7d0492a99ed5ce98dd442326f6438b39625fd5c85efa7f6f21', 'SUBMIT_CAP,GET_STATUS,GET_TOWERS,GET_REPORT', true)
ON CONFLICT (client_id) DO NOTHING;
INSERT INTO client_credentials (client_id, display_name, api_key_hash, roles, enabled)
VALUES ('tsp-b', 'TSP-B Limited', '3534c163fee49081cd4484c4894da4114f2c5093bbb0ceab406c24c59ebab5f9', 'GET_STATUS', true)
ON CONFLICT (client_id) DO NOTHING;
