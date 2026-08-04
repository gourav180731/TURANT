import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { loadConfig, type ParsedEnvConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import { getLogger } from '../../utils/logger.js';
import type { TelecomCellTower } from '../entities/cell-tower.js';
import type { TelecomSubscriber } from '../entities/telecom-subscriber.js';
import { generateSubscribers, HOME_OPERATOR, subscriberBatchSeed } from '../generators/subscriber-generator.js';
import { mulberry32 } from '../generators/prng.js';
import {
  buildCopyFromSubscribersSql,
  buildUpsertSubscribersSql,
  serializeSubscriberCsv,
} from '../repositories/sql-builders.js';
import { buildCheckpointsDdl, buildSimCellTowersDdl, buildSubscribersDdl } from './ddl.js';

const log = getLogger();

/**
 * Postgres seeder for the telecom simulation (the 1K → 300M path).
 *
 * Seeding is:
 *   - deterministic — every batch derives from (SIM_SEED, batch index), so a
 *     regenerated batch is identical to the one it replaces;
 *   - idempotent    — inserts are `ON CONFLICT (imsi) DO UPDATE`, and a batch
 *     is skipped when its IMSI range already exists (resume is exact after any
 *     crash, verified against the table itself);
 *   - scalable      — SUBSCRIBER_PARTITIONS HASH(imsi)-partitions the table,
 *     SEED_WORKERS slices run concurrently, SEED_USE_COPY streams via COPY.
 */
export class PostgresSimSeeder {
  constructor(private readonly cfg: ParsedEnvConfig = loadConfig()) {}

  /** Create (or, when SIM_SEED_RESET, recreate) the sim tables. */
  async ensureSchema(): Promise<void> {
    const pool = getPool();
    if (this.cfg.SIM_SEED_RESET) {
      await pool.query('DROP TABLE IF EXISTS sim_seeder_checkpoints CASCADE');
      await pool.query('DROP TABLE IF EXISTS sim_cell_towers CASCADE');
      await pool.query('DROP TABLE IF EXISTS subscribers CASCADE');
    }
    await pool.query(buildSubscribersDdl(this.cfg));
    await pool.query(buildSimCellTowersDdl());
    await pool.query(buildCheckpointsDdl());
  }

  /** Upsert towers into `sim_cell_towers` (full) and `cell_towers` (module 02 subset). */
  async seedTowers(towers: readonly TelecomCellTower[]): Promise<void> {
    const pool = getPool();
    const chunkSize = 2000;
    for (let i = 0; i < towers.length; i += chunkSize) {
      const chunk = towers.slice(i, i + chunkSize);
      await this.upsertSimTowers(pool, chunk);
      await this.upsertCellTowersSubset(pool, chunk);
    }
  }

  private async upsertSimTowers(pool: ReturnType<typeof getPool>, towers: readonly TelecomCellTower[]): Promise<void> {
    const cols = [
      'site_id', 'cell_id', 'ecgi', 'cgi', 'enb_id', 'gnb_id', 'sector_id', 'pci', 'earfcn', 'uarfcn', 'arfcn',
      'tac', 'lac', 'mcc', 'mnc', 'plmn', 'operator', 'operator_short_name', 'vendor', 'controller', 'rnc', 'bsc',
      'rnc_id', 'rnc_ip', 'latitude', 'longitude', 'antenna_height_m', 'azimuth_deg', 'beam_width_deg',
      'frequency_band', 'technology', 'max_users', 'current_load_pct', 'coverage_radius_m', 'power_status',
      'backhaul_type', 'ip_address', 'state', 'district', 'city', 'zone', 'pin_code', 'created_at', 'properties',
    ];
    const values: unknown[] = [];
    const groups: string[] = [];
    let p = 1;
    for (const t of towers) {
      groups.push(`(${Array.from({ length: cols.length }, () => `$${p++}`).join(', ')})`);
      values.push(
        t.siteId, t.cellId, t.ecgi ?? null, t.cgi ?? null, t.enbId ?? null, t.gnbId ?? null,
        t.sectorId ?? null, t.pci ?? null, t.earfcn ?? null, t.uarfcn ?? null, t.arfcn ?? null,
        t.tac ?? null, t.lac ?? null, t.mcc, t.mnc, t.plmn ?? null, t.operator,
        t.operatorShortName ?? null, t.vendor, t.controller ?? null, t.rnc ?? null, t.bsc ?? null,
        t.rncId ?? null, t.rncIp ?? null, t.latitude, t.longitude, t.antennaHeightM ?? null,
        t.azimuthDeg ?? null, t.beamWidthDeg ?? null, t.frequencyBand ?? null, t.technology,
        t.maxUsers, t.currentLoadPct, t.coverageRadiusM, t.powerStatus, t.backhaulType,
        t.ipAddress ?? null, t.state, t.district, t.city, t.zone ?? null, t.pinCode,
        t.createdAt.toISOString(), JSON.stringify(t),
      );
    }
    const updateCols = cols.filter((c) => c !== 'site_id');
    const updates = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    await pool.query(
      `
      INSERT INTO sim_cell_towers (${cols.join(', ')}, geometry)
      SELECT c.*, ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326)
      FROM (VALUES ${groups.join(', ')}) AS c(${cols.join(', ')})
      ON CONFLICT (site_id) DO UPDATE SET ${updates};
      `,
      values,
    );
  }

  private async upsertCellTowersSubset(pool: ReturnType<typeof getPool>, towers: readonly TelecomCellTower[]): Promise<void> {
    const values: unknown[] = [];
    const groups: string[] = [];
    let p = 1;
    for (const t of towers) {
      groups.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NULL, $${p++})`);
      values.push(t.siteId, t.cellId, t.latitude, t.longitude, t.coverageRadiusM, JSON.stringify(t));
    }
    await pool.query(
      `
      INSERT INTO cell_towers (id, cell_id, latitude, longitude, coverage_radius_m, coverage_geom, properties)
      VALUES ${groups.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        cell_id = EXCLUDED.cell_id, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        coverage_radius_m = EXCLUDED.coverage_radius_m, properties = EXCLUDED.properties;
      `,
      values,
    );
  }
  /**
   * Seed `targetCount` subscribers. Returns { generated, skipped, existing }.
   * See class doc for determinism/idempotency/resume semantics.
   */
  async seedSubscribers(opts: { towers: readonly TelecomCellTower[]; targetCount: number }): Promise<{
    generated: number;
    skipped: number;
    existing: number;
  }> {
    const { towers, targetCount } = opts;
    const pool = getPool();
    const existing = await this.countSubscribers(pool);
    if (existing >= targetCount) {
      log.info({ existing, targetCount }, 'seed.subscribers.already_seeded');
      return { generated: 0, skipped: 0, existing };
    }

    const batchSize = this.cfg.SEED_BATCH_SIZE;
    const totalBatches = Math.ceil(targetCount / batchSize);
    const workers = Math.max(1, Math.min(this.cfg.SEED_WORKERS, totalBatches));

    const results = await Promise.all(
      Array.from({ length: workers }, (_, slice) =>
        this.seedSlice({ slice, workers, towers, targetCount, batchSize }),
      ),
    );

    const generated = results.reduce((a, r) => a + r.generated, 0);
    const skipped = results.reduce((a, r) => a + r.skipped, 0);
    return { generated, skipped, existing };
  }

  private async seedSlice(opts: {
    slice: number;
    workers: number;
    towers: readonly TelecomCellTower[];
    targetCount: number;
    batchSize: number;
  }): Promise<{ generated: number; skipped: number }> {
    const { slice, workers, towers, targetCount, batchSize } = opts;
    const pool = getPool();
    let generated = 0;
    let skipped = 0;

    for (let batchIndex = slice; batchIndex * batchSize < targetCount; batchIndex += workers) {
      const start = batchIndex * batchSize;
      const len = Math.min(batchSize, targetCount - start);
      if (await this.batchComplete(pool, start, len)) {
        skipped += len;
        continue;
      }

      const rand = mulberry32(subscriberBatchSeed(this.cfg.SIM_SEED, batchIndex));
      const rows = generateSubscribers({
        count: len,
        towers,
        activePct: this.cfg.ACTIVE_SUBSCRIBER_PCT,
        minPerTower: this.cfg.MIN_USERS_PER_TOWER,
        maxPerTower: this.cfg.MAX_USERS_PER_TOWER,
        rand,
        offset: start,
      });
      await this.insertBatch(pool, rows);
      generated += len;
      log.info({ batchIndex, rows: len }, 'seed.subscribers.batch');
    }
    return { generated, skipped };
  }

  /** True when every IMSI in [offset, offset+len) already exists (resume check). */
  private async batchComplete(pool: ReturnType<typeof getPool>, offset: number, len: number): Promise<boolean> {
    const { lo, hi } = this.imsiRange(offset, offset + len);
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${this.cfg.SUBSCRIBER_TABLE} WHERE imsi >= $1 AND imsi < $2`,
      [lo, hi],
    );
    return Number(result.rows[0]?.n ?? 0) >= len;
  }

  private imsiRange(from: number, to: number): { lo: string; hi: string } {
    const pad = (n: number) => String(n).padStart(10, '0').slice(-10);
    const prefix = `${HOME_OPERATOR.mcc}${HOME_OPERATOR.mnc}`;
    return { lo: `${prefix}${pad(from)}`, hi: `${prefix}${pad(to)}` };
  }

  private batchSeed(batchIndex: number): number {
    return subscriberBatchSeed(this.cfg.SIM_SEED, batchIndex);
  }

  private async insertBatch(pool: ReturnType<typeof getPool>, rows: readonly TelecomSubscriber[]): Promise<void> {
    if (rows.length === 0) return;
    if (this.cfg.SEED_USE_COPY) {
      const client = await pool.connect();
      try {
        const ingest = client.query(copyFrom(buildCopyFromSubscribersSql(this.cfg.SUBSCRIBER_TABLE)));
        const csv = `${rows.map((r) => serializeSubscriberCsv(r)).join('\n')}\n`;
        await pipeline(Readable.from([csv]), ingest);
      } finally {
        client.release();
      }
      return;
    }
    const { text, values } = buildUpsertSubscribersSql(this.cfg.SUBSCRIBER_TABLE, rows);
    await pool.query(text, values);
  }

  private async countSubscribers(pool: ReturnType<typeof getPool>): Promise<number> {
    const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${this.cfg.SUBSCRIBER_TABLE}`);
    return Number(result.rows[0]?.n ?? 0);
  }
}
