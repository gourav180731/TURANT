import fs from 'node:fs';
import { loadConfig } from '../src/config/env.js';
import { getPool, closePool } from '../src/persistence/pg-pool.js';

/**
 * Builds / ingests the `cell_network_mapping` layer (Phase 5/6) — Cell ->
 * (lac, cisac) → the composite key the real 100M-row subscriber_dump carries.
 *
 * Mode 1 — `derive`  (synthetic test network mapping)
 *   Deterministically binds every target cell to the REAL (lac, cisac) of the
 *   K nearest subscriber_dump rows (GiST-accelerated LATERAL `ORDER BY <->`,
 *   default K=5). Because a single (lac,cisac) scatters nationwide (00000-style
 *   dump is keyed by that pair, not by geography), centroid aggregation —
 *   which previously collapsed 50,000 cells onto ~2 areas — is NOT used.
 *   Storing the cell's own latitude/longitude gives the mapping a spatial
 *   anchor. The (lac, cisac) values are 100% real dump values; nothing is
 *   invented, but the *selection* of which cell serves which real area is a
 *   deterministic test mapping (source='synthetic_test_mapping') because no
 *   authoritative Cell→LAC/CISAC master was available.
 *
 * Mode 2 — `import` (production ingestion path)
 *   Loads a real C-DOT master dataset file given by --file (one mapping per
 *   line: cell_id,lac,cisac[,technology[,service_provider]]), source='import'.
 *   TURANT reports mapping completeness, so an incomplete production set is
 *   surfaced as mappingIncomplete / unresolvedCellCount rather than hidden.
 *
 * Usage:
 *   npx tsx scripts/ingest-cell-mapping.ts derive --cells 50000 --k 5
 *   npx tsx scripts/ingest-cell-mapping.ts import --file ./mapping.csv
 */

interface Args {
  mode: 'derive' | 'import';
  cells: number;
  k: number;
  file?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: 'derive', cells: 50000, k: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === 'derive' || arg === 'import') a.mode = arg;
    else if (arg === '--cells') a.cells = Number(argv[++i]!);
    else if (arg === '--k') a.k = Number(argv[++i]!);
    else if (arg === '--file') a.file = argv[++i]!;
  }
  return a;
}

async function ensureSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS cell_network_mapping (
      cell_id          VARCHAR(20)  NOT NULL,
      lac              VARCHAR(10)  NOT NULL,
      cisac            VARCHAR(10)  NOT NULL,
      technology       TEXT,
      service_provider TEXT,
      latitude         DOUBLE PRECISION,
      longitude        DOUBLE PRECISION,
      geom             geometry(Point, 4326),
      source           VARCHAR(40)  NOT NULL DEFAULT 'synthetic_test_mapping',
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT cell_network_mapping_pkey PRIMARY KEY (cell_id, lac, cisac)
    );
    CREATE INDEX IF NOT EXISTS idx_cell_network_mapping_cell
      ON cell_network_mapping (cell_id);
    CREATE INDEX IF NOT EXISTS idx_cell_network_mapping_area
      ON cell_network_mapping (lac, cisac);
    CREATE INDEX IF NOT EXISTS idx_subscriber_dump_lac_cisac
      ON subscriber_dump (lac, cisac);
  `);
}

/**
 * Derive the synthetic test mapping: K nearest REAL dump subscribers per cell.
 * Pure SQL, no fabricated lac/cisac, no per-cell client round-trips.
 * Destructive: first removes the existing synthetic_test_mapping rows (imported
 * production mappings are left untouched), then inserts the freshly-derived ones.
 */
async function deriveMapping(cells: number, k: number): Promise<number> {
  const pool = getPool();

  await pool.query(`DELETE FROM cell_network_mapping WHERE source = 'synthetic_test_mapping'`);
  const started = Date.now();
  const bound = await pool.query<{ bound: string }>(
    `
    WITH target(cell_id, latitude, longitude, geom) AS (
      SELECT cell_id, latitude, longitude,
             ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
      FROM cell_towers
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY cell_id LIMIT $1
    ),
    ins AS (
      INSERT INTO cell_network_mapping
        (cell_id, lac, cisac, latitude, longitude, geom, source)
      SELECT t.cell_id, d.lac, d.cisac,
             t.latitude, t.longitude, t.geom,
             'synthetic_test_mapping'
      FROM target t
      CROSS JOIN LATERAL (
        SELECT d.lac, d.cisac
        FROM subscriber_dump d
        WHERE d.geom IS NOT NULL AND d.lac IS NOT NULL AND d.cisac IS NOT NULL
        ORDER BY d.geom <-> t.geom
        LIMIT $2
      ) d
      ON CONFLICT (cell_id, lac, cisac)
        DO UPDATE SET latitude = EXCLUDED.latitude,
                      longitude = EXCLUDED.longitude,
                      geom = EXCLUDED.geom,
                      source = 'synthetic_test_mapping',
                      updated_at = now()
      RETURNING 1
    )
    SELECT COUNT(*)::text AS bound FROM ins
    `,
    [cells, k],
  );
  const inserted = Number(bound.rows[0]?.bound ?? 0);
  console.log(`Bound ${inserted} cell→(lac,cisac) rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
      `INSERT INTO cell_network_mapping
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
            COUNT(DISTINCT source) AS sources,
            (SELECT COUNT(*) :: int FROM target_cells) AS target_cells,
            (SELECT COUNT(*) FROM target_cells t
              WHERE EXISTS (SELECT 1 FROM cell_network_mapping m
                             WHERE m.cell_id = t.cell_id)) AS target_cells_covered,
            (SELECT COUNT(DISTINCT lac) FROM cell_network_mapping) AS distinct_lacs
     FROM cell_network_mapping`,
  );
  console.log('\n--- mapping completeness ---');
  console.table(rows[0]);
  const invalid = await pool.query(
    `SELECT COUNT(*) AS n
     FROM cell_network_mapping m
     WHERE NOT EXISTS (SELECT 1 FROM subscriber_dump d
                        WHERE d.lac = m.lac AND d.cisac = m.cisac)`,
  );
  console.log(`Areas with zero subscriber_dump rows: ${invalid.rows[0]?.n ?? 0}`);
}

const args = parseArgs(process.argv.slice(2));
loadConfig();
await getPool().connect().then((c) => c.release());

try {
  await ensureSchema();
  if (args.mode === 'derive') {
    const n = await deriveMapping(args.cells, args.k);
    console.log(`Derived ${n} cell→(lac,cisac) mapping rows (K=${args.k}).`);
  } else if (args.mode === 'import') {
    if (!args.file) throw new Error('import requires --file <path>');
    const n = await importMapping(args.file);
    console.log(`Imported ${n} mapping rows.`);
  }
  await reportCompleteness();
} finally {
  await closePool();
}