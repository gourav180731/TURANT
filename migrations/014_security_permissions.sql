-- 014 Security Permissions — Least Privilege DB Access & Audit Protection
-- Application user 'turant' receives append-only rights on security_audit
-- and standard DML on operational tables.

GRANT USAGE ON SCHEMA public TO turant;

-- Tamper-evident audit trail: INSERT and SELECT only
GRANT SELECT, INSERT ON security_audit TO turant;
REVOKE UPDATE, DELETE, TRUNCATE ON security_audit FROM turant;

-- Operational security tables
GRANT SELECT, INSERT, UPDATE, DELETE ON cap_replay TO turant;
GRANT SELECT, INSERT, UPDATE, DELETE ON client_credentials TO turant;
