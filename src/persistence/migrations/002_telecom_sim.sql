-- ===========================================================================
-- TURANT — telecom simulation schema (modules 03/04 drop-in)
--
-- This is the schema for the SIMULATED subscriber database that stands in for
-- C-DOT's real subscriber tables until they are connected. The seeder owns
-- these tables (it creates them itself on boot), so this migration is the
-- out-of-band / ops-managed reference — run it, or let the seeder create the
-- schema; both produce the same shape.
--
-- For the 10M–300M production path, HASH(imsi) partition the subscribers table
-- (SUBSCRIBER_PARTITIONS env) instead of the plain table below. If you use
-- partitions, either let the seeder create the schema with
-- SIM_SEED_RESET=true or recreate the table partitioned before seeding — the
-- seeder refuses to silently reshape an existing plain table.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Subscribers (plain, dev default). The partitioned variant replaces the
-- CREATE TABLE + PRIMARY KEY when SUBSCRIBER_PARTITIONS > 0:
--
--   CREATE TABLE subscribers ( ...same columns... ) PARTITION BY HASH (imsi);
--   CREATE TABLE subscribers_p0 PARTITION OF subscribers FOR VALUES WITH
--     (MODULUS 32, REMAINDER 0);
--   ... p1..p31 ...
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
    imsi              TEXT PRIMARY KEY,
    id                TEXT,
    msisdn            TEXT NOT NULL,
    imei              TEXT,
    tmsi              TEXT,
    cell_id           TEXT NOT NULL,
    tower_id          TEXT,
    previous_cell_id  TEXT,
    lac               TEXT,
    tac               TEXT,
    rnc_id            TEXT,
    enb_id            TEXT,
    gnb_id            TEXT,
    sector_id         TEXT,
    technology        TEXT NOT NULL,
    status            TEXT NOT NULL,
    attach_time       TIMESTAMPTZ,
    last_seen         TIMESTAMPTZ,
    signal_rssi       INTEGER,
    rsrp              INTEGER,
    rsrq              INTEGER,
    sinr              INTEGER,
    roaming_status    TEXT,
    emergency_capable BOOLEAN,
    volte_enabled     BOOLEAN,
    vonr_enabled      BOOLEAN,
    device_vendor     TEXT,
    device_model      TEXT,
    sim_operator      TEXT,
    home_plmn         TEXT,
    visited_plmn      TEXT,
    apn               TEXT,
    ipv4              TEXT,
    ipv6              TEXT,
    registration_state TEXT,
    paging_state      TEXT,
    mcc               TEXT,
    mnc               TEXT,
    operator          TEXT,
    created_at        TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_subscribers_cell_id  ON subscribers (cell_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_msisdn   ON subscribers (msisdn);
CREATE INDEX IF NOT EXISTS idx_subscribers_last_seen ON subscribers (last_seen);
CREATE INDEX IF NOT EXISTS idx_subscribers_status   ON subscribers (status);

-- ---------------------------------------------------------------------------
-- Full sim tower table (module 02's `cell_towers` subset stays in 001)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sim_cell_towers (
    site_id            TEXT PRIMARY KEY,
    cell_id            TEXT NOT NULL,
    ecgi               TEXT,
    cgi                TEXT,
    enb_id             TEXT,
    gnb_id             TEXT,
    sector_id          TEXT,
    pci                INTEGER,
    earfcn             INTEGER,
    uarfcn             INTEGER,
    arfcn              INTEGER,
    tac                TEXT,
    lac                TEXT,
    mcc                TEXT,
    mnc                TEXT,
    plmn               TEXT,
    operator           TEXT,
    operator_short_name TEXT,
    vendor             TEXT,
    controller         TEXT,
    rnc                TEXT,
    bsc                TEXT,
    rnc_id             TEXT,
    rnc_ip             TEXT,
    latitude           DOUBLE PRECISION NOT NULL,
    longitude          DOUBLE PRECISION NOT NULL,
    antenna_height_m   INTEGER,
    azimuth_deg        INTEGER,
    beam_width_deg     INTEGER,
    frequency_band     TEXT,
    technology         TEXT NOT NULL,
    max_users          INTEGER NOT NULL,
    current_load_pct   INTEGER NOT NULL,
    coverage_radius_m  DOUBLE PRECISION NOT NULL,
    power_status       TEXT NOT NULL,
    backhaul_type      TEXT NOT NULL,
    ip_address         TEXT,
    state              TEXT,
    district           TEXT,
    city               TEXT,
    zone               TEXT,
    pin_code           TEXT,
    geometry           GEOMETRY(Point, 4326),
    properties         JSONB,
    created_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_cell_id ON sim_cell_towers (cell_id);
CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_ll      ON sim_cell_towers USING GIST (geometry);

-- ---------------------------------------------------------------------------
-- Seeder resume checkpoint (deterministic, idempotent re-seeding)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sim_seeder_checkpoints (
    dataset            TEXT PRIMARY KEY,
    completed_batches  BIGINT NOT NULL DEFAULT 0,
    total_rows         BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
