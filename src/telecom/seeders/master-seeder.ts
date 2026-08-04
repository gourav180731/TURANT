import type { ParsedEnvConfig } from '../../config/env.js';
import { getPool } from '../../persistence/pg-pool.js';
import { getLogger } from '../../utils/logger.js';
import type { TelecomCellTower } from '../entities/cell-tower.js';
import { buildMasterInsertSql, type MasterInsertOptions } from './master-sql.js';
import { PostgresSimSeeder } from './postgres-seeder.js';
import { buildTelecomMasterDdl } from './ddl.js';

const log = getLogger();

/**
 * Telecom Master Dataset seeder.
 *
 * Produces the production-like C-DOT BTS dataset (~5,000 cells over Delhi NCR
 * by default, `TELECOM_MASTER_TOWER_COUNT`), written into the reference-schema
 * `telecom_master` table AND kept in sync with the sim's own tables so the
 * whole pipeline (module 02 tower resolution, modules 03/04 subscriber
 * matching) works against it:
 *
 *   1. sim schema   → `sim_cell_towers` (full entity) + `cell_towers` subset
 *                     (module 02 PostGIS reads this via TOWER_TABLE mapping)
 *   2. master       → `telecom_master` (C-DOT BTS reference columns + POINT geom)
 *   3. subscribers  → the same cells module 03/04 matches against
 *
 * Deterministic (SIM_SEED), idempotent (`ON CONFLICT` in the parent seeder)
 * and resumable — re-running only fills what is missing.
 */
export class TelecomMasterSeeder extends PostgresSimSeeder {
  constructor(cfg?: ParsedEnvConfig) {
    super(cfg);
  }

  /** Create `telecom_master` (plus the parent sim schema). */
  override async ensureSchema(): Promise<void> {
    await super.ensureSchema();
    await getPool().query(buildTelecomMasterDdl());
  }

  /** Create only `telecom_master` (after the parent schema already exists). */
  async ensureMasterSchema(): Promise<void> {
    await getPool().query(buildTelecomMasterDdl());
  }

  /**
   * Insert towers into `telecom_master` in the C-DOT BTS reference shape.
   * `opts.geometry` selects the real PostGIS expression (default) or a raw
   * WKT write for PostGIS-free verification environments.
   */
  async seedMasterTowers(
    towers: readonly TelecomCellTower[],
    opts: MasterInsertOptions = {},
  ): Promise<number> {
    const pool = getPool();
    const chunkSize = 2000;
    let inserted = 0;
    for (let i = 0; i < towers.length; i += chunkSize) {
      const chunk = towers.slice(i, i + chunkSize);
      const { text, values } = buildMasterInsertSql(chunk, opts);
      await pool.query(text, values);
      inserted += chunk.length;
    }
    log.info({ inserted }, 'telecom-master.seeded');
    return inserted;
  }

  /**
   * One-call bootstrap for the master dataset + subscribers. Mirrors what
   * `npm run seed:telecom-master` runs.
   */
  async seedAll(opts: {
    towers: readonly TelecomCellTower[];
    subscriberCount: number;
    masterGeometry?: MasterInsertOptions['geometry'];
  }): Promise<{
    towers: number;
    masterRows: number;
    subscribers: { generated: number; skipped: number; existing: number };
  }> {
    const { towers, subscriberCount, masterGeometry = 'st_geomfromtext' } = opts;
    await this.ensureSchema();
    await this.seedTowers(towers); // sim_cell_towers + cell_towers (module 02)
    const masterRows = await this.seedMasterTowers(towers, { geometry: masterGeometry });
    const subscribers = await this.seedSubscribers({ towers, targetCount: subscriberCount });
    return { towers: towers.length, masterRows, subscribers };
  }
}
