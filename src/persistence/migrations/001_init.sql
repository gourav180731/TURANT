-- ===========================================================================
-- TURANT — initial schema
--
-- This migration defines:
--   1. Operational tables TURANT owns (alerts, reports).
--   2. A *reference* shape for the cell-tower source table. The real tower
--      table lives in the C-DOT database and is reached via configurable
--      column mapping (TOWER_COL_*) in the PostGIS tower adapter — no code
--      change needed if the real schema differs, only .env column names.
--      When C-DOT provides their own schema, this block is informational.
--
-- No sample/fake rows are ever inserted — schema only.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- CAP alerts as ingested (audit + expiry control source of truth)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cap_identifier    TEXT NOT NULL,
    sender            TEXT NOT NULL,
    sent_at           TIMESTAMPTZ,
    status            TEXT,
    msg_type          TEXT,
    scope             TEXT,
    expires_at        TIMESTAMPTZ,          -- real CAP expires timestamp (Req 6/8)
    effective_at      TIMESTAMPTZ,
    severity          TEXT,
    urgency           TEXT,
    headline          TEXT,
    description       TEXT,
    instruction       TEXT,
    raw_xml           TEXT NOT NULL,        -- full CAP document for the audit trail
    payload           JSONB NOT NULL,       -- full parsed CapAlert
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cap_identifier, sender)
);

CREATE INDEX IF NOT EXISTS idx_alerts_expires_at ON alerts (expires_at);
CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts (received_at);

-- ---------------------------------------------------------------------------
-- Reference shape for the C-DOT cell-tower source table (PostGIS adapter).
-- Column names below match the .env defaults and can be overridden there.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell_towers (
    id                TEXT PRIMARY KEY,
    cell_id           TEXT NOT NULL,
    latitude          DOUBLE PRECISION NOT NULL,
    longitude         DOUBLE PRECISION NOT NULL,
    coverage_radius_m DOUBLE PRECISION,          -- radius coverage model
    coverage_geom     GEOMETRY(Polygon, 4326),   -- polygon coverage model
    properties        JSONB
);

-- Spatial index — the keystone for requirement #2 ("seconds, not minutes").
CREATE INDEX IF NOT EXISTS idx_cell_towers_geom
    ON cell_towers USING GIST (coverage_geom);
CREATE INDEX IF NOT EXISTS idx_cell_towers_ll
    ON cell_towers USING GIST (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326));

-- ---------------------------------------------------------------------------
-- Per-alert processing reports (module 11/12 audit + EWS feedback replay)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_reports (
    alert_id               UUID PRIMARY KEY REFERENCES alerts(id) ON DELETE CASCADE,
    cap_identifier         TEXT NOT NULL,
    processing_started_at  TIMESTAMPTZ,
    processing_ended_at    TIMESTAMPTZ,
    targeted_subscribers   BIGINT,
    sms_submitted          BIGINT,
    sms_accepted           BIGINT,
    delivered              BIGINT,
    failed                 BIGINT,
    expired                BIGINT,
    successful_push        BIGINT,
    tower_count            BIGINT,
    completed              BOOLEAN NOT NULL DEFAULT FALSE,
    report_json            JSONB
);

CREATE INDEX IF NOT EXISTS idx_alert_reports_cap ON alert_reports (cap_identifier);
