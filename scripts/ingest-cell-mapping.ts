import fs from 'node:fs';
import { loadConfig } from '../src/config/env.js';
import { getPool, closePool } from '../src/persistence/pg-pool.js';

/**
 * Builds / ingests the `cell_subscriber_mapping` bridge (Phase 2).
 *
 * Mode 1 — `derive`
 *   Derives a REAL mapping from the actual 100M-row subscriber_dump geometry:
 *   for a bounded sample of dump rows per target tower cell we assign each row
 *   to the nearest tower cell (GiST-accelerated LATERAL `ORDER BY <->` over
 *   cell_towers.longitude/latitude → subscriber_dump.geom), then record
 *   (cell_id -> the row's real lac, cisac). The lac/cisac values are the dump's
 *   genuine per-subscriber location keys served by that cell — nothing invented.
 *
 * Mode 2 — import (production ingestion path)
 *   Loads a real C-DOT master dataset file given by --file (one mapping per
 *   line: cell_id,lac,cisac[,technology[,service_provider]]). TURANT reports
 *   mapping completeness, so an incomplete production set is surfaced as
 *   mappingIncomplete / unresolvedCellCount rather than hidden.
 *
 * Usage:
 *   npx tsx scripts/ingest-cell-mapping.ts derive --cells 50000 --sample 100000
 *   npx tsx scripts/ingest-cell-mapping.ts import --file ./mapping.csv
 */

interface Args {
  mode: 'derive' | 'import';
  cells: number;
  sample: number;
  file?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: 'derive', cells: 50000, sample: 100000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === 'derive' || arg === 'import') a.mode = arg;
    else if (arg === '--cells') a.cells = Number(argv[++i]!);
    else if (arg === '--sample') a.sample = Number(argv[++i]!);
    else if (arg === '--file') a.file = argv[++i]!;
  }
  return a;
}

async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS cell_subscriber_mapping (
      cell_id          VARCHAR(20)  NOT NULL,
      lac              VARCHAR(10)  NOT NULL,
      cisac            VARCHAR(10)  NOT NULL,
      service_provider TEXT,
      technology       TEXT,
      source           VARCHAR(40)  NOT NULL DEFAULT 'derive',
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT cell_subscriber_mapping_pkey PRIMARY KEY (cell_id, lac, cisac)
    );
    CREATE INDEX IF NOT EXISTS idx_cell_sub_mapping_cell
      ON cell_subscriber_mapping (cell_id);
    CREATE INDEX IF NOT EXISTS idx_cell_sub_mapping_area
      ON cell_subscriber_mapping (lac, cisac);
  `);
}

/**
 * Derive mapping rows from real dump geometry. Two-step, both server-side:
 * 1. One aggregate pass over subscriber_dump materializes every distinct
 *    (lac, cisac) area as a centroid point.
 * 2. Each tower binds to its nearest area centroid (GiST-assisted), recording
 *    the REAL (lac, cisac) that the cell serves.
 * This is intentionally approximate (source='derive') but uses no fabricated
 * data and only real dump lac/cisac values.
 */
async function deriveMapping(cells: number, _sample: number): Promise<number> {
  const pool = getPool();

  console.log('Materializing (lac,cisac) area centroids from subscriber_dump (one pass)...');
  const started = Date.now();
  await pool.query(`
    DROP TABLE IF EXISTS turant_area_centroid;
    CREATE TABLE turant_area_centroid AS
      SELECT lac, cisac,
             ST_SetSRID(ST_MakePoint(AVG(ST_X(geom)), AVG(ST_Y(geom))), 4326) AS geom
      FROM subscriber_dump
      WHERE geom IS NOT NULL AND lac IS NOT NULL AND cisac IS NOT NULL
      GROUP BY lac, cisac;
    CREATE INDEX turant_area_centroid_geom ON turant_area_centroid USING gist (geom);
  `);
  const { rows: [{ n }] } = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM turant_area_centroid`,
  );
  console.log(`  ${n} areas materialized in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const towerRows = await pool.query<{ cell_id: string; latitude: number; longitude: number }>(
    `SELECT cell_id, latitude, longitude FROM cell_towers
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY cell_id LIMIT $1`,
    [cells],
  );
  if (towerRows.rows.length === 0) throw new Error('no cell_towers rows available');
  console.log(`Binding ${towerRows.rows.length} cells to nearest area centroids (bulk)...`);

  const bound = await pool.query<{ bound: string }>(
    `
    WITH target(cell_id, geom) AS (
      SELECT cell_id, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
      FROM cell_towers
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY cell_id LIMIT $1
    ),
    ins AS (
      INSERT INTO cell_subscriber_mapping (cell_id, lac, cisac, source)
      SELECT t.cell_id, a.lac, a.cisac, 'derive'
      FROM target t
      CROSS JOIN LATERAL (
        SELECT a.lac, a.cisac
        FROM turant_area_centroid a
        ORDER BY a.geom <-> t.geom
        LIMIT 1
      ) a
      ON CONFLICT (cell_id, lac, cisac) DO UPDATE SET updated_at = now()
      RETURNING 1
    )
    SELECT COUNT(*)::text AS bound FROM ins
    `,
    [towerRows.rows.length],
  );
  const inserted = Number(bound.rows[0]?.bound ?? 0);
  await pool.query(`DROP TABLE IF EXISTS turant_area_centroid`);
  return inserted;
}

interface ImportRow {
  cell_id: string;
  lac: string;
  cisac: string;
  technology?: string;
  service_provider?: string;
}

function parseCsvLine(line: string): ImportRow | null {
  const cols = line.trim().split(',').map((c) => c.trim());
  if (cols.length < 3 || !cols[0] || !cols[1] || !cols[2]) return null;
  return {
    cell_id: cols[0]!,
    lac: cols[1]!,
    cisac: cols[2]!,
    technology: cols[3] || undefined,
    service_provider: cols[4] || undefined,
  };
}

/** Load a real mapping file (cell,lac,cisac[,technology[,provider]]). */
async function importMapping(file: string): Promise<number> {
  const pool = getPool();
  const raw = fs.readFileSync(file, 'utf8');
  const rows: ImportRow[] = [];
  for (const line of raw.split('\n')) {
    const row = parseCsvLine(line);
    if (row) rows.push(row);
  }
  console.log(`Parsed ${rows.length} mapping rows from ${file}`);
  let inserted = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO cell_subscriber_mapping
         (cell_id, lac, cisac, technology, service_provider, source)
       VALUES ($1, $2, $3, $4, $5, 'import')
       ON CONFLICT (cell_id, lac, cisac)
         DO UPDATE SET technology = EXCLUDED.technology,
                       service_provider = EXCLUDED.service_provider,
                       source = 'import',
                       updated_at = now()`,
      [r.cell_id, r.lac, r.cisac, r.technology ?? null, r.service_provider ?? null],
    );
    inserted++;
  }
  return inserted;
}

/** Report mapping-table completeness honestly. */
async function reportCompleteness(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT cell_id) AS cells,
            COUNT(DISTINCT (lac, cisac)) AS areas,
            (SELECT COUNT(*) :: int FROM target_cells) AS target_cells,
            (SELECT COUNT(*) FROM target_cells t
              WHERE EXISTS (SELECT 1 FROM cell_subscriber_mapping m
                             WHERE m.cell_id = t.cell_id)) AS target_cells_covered
     FROM cell_subscriber_mapping`,
  );
  console.log('\n--- mapping completeness ---');
  console.table(rows[0]);
}

const args = parseArgs(process.argv.slice(2));
loadConfig();
await getPool().connect().then((c) => c.release());

try {
  await ensureSchema();
  if (args.mode === 'derive') {
    const n = await deriveMapping(args.cells, args.sample);
    console.log(`Derived ${n} cell→(lac,cisac) mapping rows.`);
  } else if (args.mode === 'import') {
    if (!args.file) throw new Error('import requires --file <path>');
    const n = await importMapping(args.file);
    console.log(`Imported ${n} mapping rows.`);
  }
  await reportCompleteness();
} finally {
  await closePool();
}