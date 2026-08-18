import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

loadConfig();

async function section(title: string) {
  console.log('\n' + '='.repeat(100));
  console.log('  ' + title);
  console.log('='.repeat(100));
}

async function runQuery(pool: any, label: string, sql: string, params: any[] = []) {
  console.log(`\n--- ${label} ---`);
  const start = performance.now();
  const res = await pool.query(sql, params);
  const elapsed = (performance.now() - start).toFixed(1);
  console.log(`[${elapsed} ms] rows: ${res.rowCount}`);
  if (res.rows.length > 0) {
    const cols = Object.keys(res.rows[0]);
    const colWidths: Record<string, number> = {};
    for (const c of cols) colWidths[c] = Math.max(c.length, 8);
    for (const row of res.rows) {
      for (const c of cols) {
        const v = String(row[c] ?? 'NULL');
        colWidths[c] = Math.max(colWidths[c], Math.min(v.length, 50));
      }
    }
    const header = cols.map((c) => c.padEnd(colWidths[c])).join(' | ');
    console.log('-'.repeat(header.length));
    console.log(header);
    console.log('-'.repeat(header.length));
    const displayRows = res.rows.slice(0, 20);
    for (const row of displayRows) {
      const line = cols.map((c) => {
        let v = String(row[c] ?? 'NULL');
        if (v.length > 50) v = v.slice(0, 47) + '...';
        return v.padEnd(colWidths[c]);
      }).join(' | ');
      console.log(line);
    }
    if (res.rows.length > 20) console.log(`... (${res.rows.length - 20} more rows)`);
  }
  return res;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  await client.query("SET statement_timeout = '60000ms'");

  // ========================================================================
  // SECTION 1: subscriber_dump cardinality & distribution
  // ========================================================================
  await section('SECTION 1: subscriber_dump — BASIC CARDINALITY');

  await runQuery(client, 'Total subscriber_dump rows (relies on visibility, no full scan)',
    `SELECT c.reltuples::BIGINT AS approx_rows, c.relpages
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'subscriber_dump'`);

  await runQuery(client, 'Delhi vs non-Delhi counts — small tables only, sampling',
    `WITH sample AS (
       SELECT state, city, district, operator, technology, lac, cisac, msisdn, imsi, cell_id
       FROM subscriber_dump TABLESAMPLE SYSTEM (1)
     )
     SELECT
       COUNT(*) AS sample_rows,
       COUNT(*) FILTER (WHERE state ILIKE '%Delhi%') AS delhi_in_sample,
       COUNT(*) FILTER (WHERE state NOT ILIKE '%Delhi%') AS non_delhi_in_sample,
       ROUND(100.0 * COUNT(*) FILTER (WHERE state ILIKE '%Delhi%') / COUNT(*), 2) AS delhi_pct_sample,
       COUNT(DISTINCT state) AS distinct_states_sample,
       COUNT(DISTINCT city) AS distinct_cities_sample
     FROM sample`);

  await runQuery(client, 'Operator distribution in 1% sample',
    `SELECT operator, COUNT(*) AS n, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
     FROM (SELECT operator FROM subscriber_dump TABLESAMPLE SYSTEM (1)) s
     GROUP BY operator ORDER BY n DESC`);

  await runQuery(client, 'Technology distribution in 1% sample',
    `SELECT technology, COUNT(*) AS n, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
     FROM (SELECT technology FROM subscriber_dump TABLESAMPLE SYSTEM (1)) s
     GROUP BY technology ORDER BY n DESC`);

  // ========================================================================
  // SECTION 2: LAC/CISAC COLLISION ANALYSIS — THE CORE ROOT CAUSE PROOF
  // ========================================================================
  await section('SECTION 2: LAC/CISAC COLLISION ANALYSIS — ROOT CAUSE');

  await runQuery(client, 'Distinct (lac,cisac) pairs vs distinct states/cities — 1% sample',
    `SELECT
       COUNT(DISTINCT (lac, cisac)) AS distinct_area_pairs,
       COUNT(DISTINCT state) AS distinct_states,
       COUNT(DISTINCT city) AS distinct_cities
     FROM subscriber_dump TABLESAMPLE SYSTEM (1)
     WHERE lac IS NOT NULL AND cisac IS NOT NULL`);

  await runQuery(client, 'COLLISION: (lac,cisac) pairs existing in MULTIPLE STATES — 1% sample',
    `SELECT
       lac, cisac,
       COUNT(DISTINCT state) AS state_count,
       COUNT(DISTINCT city) AS city_count,
       ARRAY_AGG(DISTINCT state ORDER BY state) AS states,
       ARRAY_AGG(DISTINCT city ORDER BY city) AS cities,
       COUNT(*) AS total_rows
     FROM subscriber_dump TABLESAMPLE SYSTEM (1)
     WHERE lac IS NOT NULL AND cisac IS NOT NULL
     GROUP BY lac, cisac
     HAVING COUNT(DISTINCT state) > 1 OR COUNT(DISTINCT city) > 1
     ORDER BY state_count DESC, city_count DESC, total_rows DESC
     LIMIT 30`);

  await runQuery(client, 'HOW MANY (lac,cisac) pairs are CROSS-STATE? — 1% sample',
    `WITH pair_stats AS (
       SELECT lac, cisac, COUNT(DISTINCT state) AS states
       FROM subscriber_dump TABLESAMPLE SYSTEM (1)
       WHERE lac IS NOT NULL AND cisac IS NOT NULL
       GROUP BY lac, cisac
     )
     SELECT
       COUNT(*) AS total_pairs,
       COUNT(*) FILTER (WHERE states = 1) AS single_state_pairs,
       COUNT(*) FILTER (WHERE states > 1) AS multi_state_pairs,
       ROUND(100.0 * COUNT(*) FILTER (WHERE states > 1) / COUNT(*), 2) AS pct_multi_state_pairs
     FROM pair_stats`);

  // ========================================================================
  // SECTION 3: CONCRETE EXAMPLE — Pick a Delhi cell, show leakage path
  // ========================================================================
  await section('SECTION 3: CONCRETE LEAKAGE EXAMPLE');

  // Find Delhi cells in cell_network_mapping (or cell_towers)
  const delhiCells = await runQuery(client, 'Delhi/Delhi-NCR cells from cell_towers (first 10 cells)',
    `SELECT id, cell_id, latitude, longitude, coverage_radius_m
     FROM cell_towers
     WHERE latitude BETWEEN 28.4 AND 28.9
       AND longitude BETWEEN 76.9 AND 77.6
     ORDER BY cell_id
     LIMIT 10`);

  if (delhiCells.rows.length > 0) {
    const sampleCellIds = delhiCells.rows.slice(0, 5).map((r: any) => r.cell_id);
    console.log('\n>>> Now simulating: what subscribers would the CELL-NETWORK-MAPPING BRIDGE',
      '\n>>> return for a Delhi alert selecting these cell_ids:', sampleCellIds);

    await runQuery(client, 'Stage 1: Find the (lac,cisac) these Delhi cells are MAPPED to',
      `SELECT m.cell_id, m.lac, m.cisac, m.source, m.latitude, m.longitude
       FROM cell_network_mapping m
       WHERE m.cell_id = ANY($1::text[])
       ORDER BY m.cell_id, m.lac, m.cisac`,
      [sampleCellIds]);

    await runQuery(client,
      'STAGE 2: The BRIDGE JOIN — subscribers reached by the SAME (lac,cisac) pairs (LIMIT sample)',
      `WITH delhi_cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       )
       SELECT DISTINCT
         s.state, s.city, s.district,
         s.lac, s.cisac, s.operator, s.technology,
         s.msisdn, s.imsi, s.cell_id AS subscriber_cell
       FROM delhi_cell_areas a
       JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
       WHERE s.state IS NOT NULL
       ORDER BY s.state, s.city
       LIMIT 60`,
      [sampleCellIds]);

    await runQuery(client,
      'STAGE 3: CROSS-STATE LEAKAGE COUNT per (lac,cisac) pair — EXACT PROOF',
      `WITH delhi_cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       ), area_state_counts AS (
         SELECT
           a.lac, a.cisac,
           COUNT(DISTINCT s.state) AS distinct_states,
           COUNT(DISTINCT s.city) AS distinct_cities,
           ARRAY_AGG(DISTINCT s.state ORDER BY s.state) AS states_in_area,
           COUNT(*) AS total_subs_in_area
         FROM delhi_cell_areas a
         JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
         WHERE s.state IS NOT NULL
         GROUP BY a.lac, a.cisac
       )
       SELECT * FROM area_state_counts
       ORDER BY distinct_states DESC, distinct_cities DESC
       LIMIT 20`,
      [sampleCellIds]);
  }

  // ========================================================================
  // SECTION 4: cell_network_mapping provenance analysis
  // ========================================================================
  await section('SECTION 4: cell_network_mapping provenance');

  await runQuery(client, 'Mapping rows by source + distinct cells + distinct areas',
    `SELECT
       source,
       COUNT(*) AS mapping_rows,
       COUNT(DISTINCT cell_id) AS distinct_cells,
       COUNT(DISTINCT (lac, cisac)) AS distinct_areas
     FROM cell_network_mapping
     GROUP BY source
     ORDER BY mapping_rows DESC`);

  await runQuery(client, 'Geographic spread of the mapping rows (lat/lng ranges)',
    `SELECT
       source,
       MIN(latitude) AS min_lat, MAX(latitude) AS max_lat,
       MIN(longitude) AS min_lng, MAX(longitude) AS max_lng,
       COUNT(*) FILTER (WHERE latitude BETWEEN 28.4 AND 28.9
                        AND longitude BETWEEN 76.9 AND 77.6) AS inside_delhi_bbox,
       COUNT(*) FILTER (WHERE latitude NOT BETWEEN 28.4 AND 28.9
                         OR longitude NOT BETWEEN 76.9 OR longitude < 76.9) AS outside_delhi_bbox
     FROM cell_network_mapping
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     GROUP BY source`);

  // ========================================================================
  // SECTION 5: subscriber_dump cell_id column (if any) — 005 backfill quality
  // ========================================================================
  await section('SECTION 5: subscriber_dump.cell_id BACKFILL QUALITY');

  await runQuery(client, 'How many subscriber_dump rows have cell_id filled?',
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE cell_id IS NOT NULL) AS with_cell_id,
       COUNT(*) FILTER (WHERE cell_id IS NULL) AS without_cell_id,
       ROUND(100.0 * COUNT(*) FILTER (WHERE cell_id IS NOT NULL) / COUNT(*), 2) AS pct_with_cell
     FROM (SELECT * FROM subscriber_dump TABLESAMPLE SYSTEM (1)) s`);

  await runQuery(client, 'Do dump cell_ids actually REFERENCE existing tower cell_ids? — 1% sample',
    `WITH sample AS (SELECT cell_id FROM subscriber_dump TABLESAMPLE SYSTEM (1) WHERE cell_id IS NOT NULL)
     SELECT
       COUNT(DISTINCT s.cell_id) AS distinct_dump_cell_ids,
       COUNT(DISTINCT s.cell_id) FILTER (WHERE EXISTS (SELECT 1 FROM cell_towers t WHERE t.cell_id = s.cell_id))
         AS dump_cells_in_cell_towers,
       COUNT(DISTINCT s.cell_id) FILTER (WHERE EXISTS (SELECT 1 FROM sim_cell_towers t WHERE t.cell_id = s.cell_id))
         AS dump_cells_in_sim_cell_towers,
       COUNT(DISTINCT s.cell_id) FILTER (WHERE EXISTS (SELECT 1 FROM telecom_master t WHERE t.cell_id = s.cell_id))
         AS dump_cells_in_telecom_master
     FROM sample s`);

  // ========================================================================
  // SECTION 6: GEOGRAPHIC CONSISTENCY CHECK — subscriber_dump cell_id vs location
  // ========================================================================
  await section('SECTION 6: GEOGRAPHIC CONSISTENCY — sub cell_id geography vs state');

  await runQuery(client,
    'For 1% of dump rows, does the nearest-neighbor-cell_id STATE match subscriber STATE?',
    `WITH sample AS (
       SELECT s.cell_id AS dump_cell_id, s.state AS dump_state, s.city AS dump_city,
              s.latitude AS dump_lat, s.longitude AS dump_lng
       FROM subscriber_dump TABLESAMPLE SYSTEM (1) s
       WHERE s.cell_id IS NOT NULL AND s.state IS NOT NULL
       LIMIT 5000
     )
     SELECT
       COUNT(*) AS sample_size,
       COUNT(*) FILTER (
         EXISTS (
           SELECT 1 FROM cell_towers t
           WHERE t.cell_id = s.dump_cell_id
             AND t.latitude BETWEEN 28.4 AND 28.9
             AND t.longitude BETWEEN 76.9 AND 77.6
         ) AND s.dump_state NOT ILIKE '%Delhi%'
         AND s.dump_state NOT ILIKE '%Haryana%'
         AND s.dump_state NOT ILIKE '%Uttar Pradesh%'
       ) AS mismatch_cases_delhi_cell_non_delhi_state,
       COUNT(*) FILTER (
         NOT EXISTS (SELECT 1 FROM cell_towers t WHERE t.cell_id = s.dump_cell_id)
       ) AS cells_not_in_cell_towers
     FROM sample s`);

  // ========================================================================
  // SECTION 7: TOWER-LEVEL DATA — geographic integrity
  // ========================================================================
  await section('SECTION 7: TOWER DATA INTEGRITY');

  await runQuery(client, 'cell_towers — state/distribution by geometry bounds',
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE latitude BETWEEN 28.4 AND 28.9
                        AND longitude BETWEEN 76.9 AND 77.6) AS delhi_ncr_bbox_count,
       COUNT(*) FILTER (WHERE latitude NOT BETWEEN 28.4 AND 28.9
                         OR longitude NOT BETWEEN 76.9 OR longitude < 76.9) AS outside_count
     FROM cell_towers`);

  await runQuery(client, 'sim_cell_towers — state distribution',
    `SELECT state, district, city, COUNT(*) AS n
     FROM sim_cell_towers
     GROUP BY state, district, city
     ORDER BY state, n DESC
     LIMIT 30`);

  await runQuery(client, 'telecom_master — state/distribution',
    `SELECT state, district, city_town, technology, operator, COUNT(*) AS n
     FROM telecom_master
     GROUP BY state, district, city_town, technology, operator
     ORDER BY state, n DESC`);

  await client.query("RESET statement_timeout");
  client.release();
  await closePool();

  console.log('\n>>> Phase 1 root-cause analysis complete.');
  console.log('>>> Key finding expected: (lac,cisac) pairs are NOT geographically unique;');
  console.log('>>> joining on them pulls subscribers from ANY state sharing that pair.');
}

main().catch((e) => {
  console.error('Diagnostic FAILED:', e);
  process.exit(1);
});
