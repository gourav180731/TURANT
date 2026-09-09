-- 012 Replay Protection — Item #2 Layer 6
-- CAP identifier must be unique per sender; prevents replay within window (e.g., 24h)
CREATE TABLE IF NOT EXISTS cap_replay (
    cap_identifier TEXT NOT NULL,
    sender TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    cap_hash TEXT NOT NULL, -- SHA256 of canonical CAP
    source_ip TEXT,
    client_id TEXT,
    PRIMARY KEY (cap_identifier, sender)
);
CREATE INDEX IF NOT EXISTS idx_cap_replay_first_seen ON cap_replay(first_seen);
-- For concurrent duplicate: INSERT will fail with unique violation → only one accepted
COMMENT ON TABLE cap_replay IS 'Replay protection: PK cap_identifier+sender ensures exactly-once. Use first_seen for window expiry.';
