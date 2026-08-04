import type { ParsedEnvConfig } from '../../config/env.js';

/**
 * DDL builders for the telecom simulation's Postgres tables.
 *
 * The sim OWNS these tables (it is a stand-in for the C-DOT subscriber
 * database), so the seeder creates them rather than relying on a migration to
 * have been run. Migration 002 ships the same schema for ops who prefer to
 * manage DDL out-of-band.
 *
 * Subscriber partitioning is config-driven: SUBSCRIBER_PARTITIONS > 0 creates
 * a HASH(imsi) partitioned table (the 10M–300M path); 0 creates a plain table
 * (dev). Nothing else in the seeder changes.
 */

/** Full sim subscribers schema, as a CREATE TABLE body (no trailing `;`). */
export function subscriberColumnsDdl(): string {
  return `
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
    updated_at        TIMESTAMPTZ`;
}

/** Subscriber indexes (run on the parent table; PG fans them out to partitions). */
export function subscriberIndexesDdl(): string {
  return `
    CREATE INDEX IF NOT EXISTS idx_subscribers_cell_id  ON subscribers (cell_id);
    CREATE INDEX IF NOT EXISTS idx_subscribers_msisdn   ON subscribers (msisdn);
    CREATE INDEX IF NOT EXISTS idx_subscribers_last_seen ON subscribers (last_seen);
    CREATE INDEX IF NOT EXISTS idx_subscribers_status   ON subscribers (status);`;
}

/** Full DDL for the subscribers table given the partition modulus. */
export function buildSubscribersDdl(cfg: Pick<ParsedEnvConfig, 'SUBSCRIBER_PARTITIONS'>): string {
  const parts = cfg.SUBSCRIBER_PARTITIONS;
  if (parts > 0) {
    const partitionSql = Array.from(
      { length: parts },
      (_, i) =>
        `CREATE TABLE IF NOT EXISTS subscribers_p${i} PARTITION OF subscribers FOR VALUES WITH (MODULUS ${parts}, REMAINDER ${i});`,
    ).join('\n');
    return `
      CREATE TABLE IF NOT EXISTS subscribers (
        ${subscriberColumnsDdl()}
      ) PARTITION BY HASH (imsi);
      ${subscriberIndexesDdl()}
      ${partitionSql}`;
  }
  return `
    CREATE TABLE IF NOT EXISTS subscribers (
      ${subscriberColumnsDdl()}
    );
    ${subscriberIndexesDdl()}`;
}

/** Full sim tower table (the C-DOT-facing `cell_towers` subset stays in 001). */
export function buildSimCellTowersDdl(): string {
  return `
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
    CREATE INDEX IF NOT EXISTS idx_sim_cell_towers_ll ON sim_cell_towers USING GIST (geometry);`;
}

/** Resume checkpoint table (idempotent, deterministic re-seeding). */
export function buildCheckpointsDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS sim_seeder_checkpoints (
      dataset            TEXT PRIMARY KEY,
      completed_batches  BIGINT NOT NULL DEFAULT 0,
      total_rows         BIGINT NOT NULL DEFAULT 0,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );`;
}
