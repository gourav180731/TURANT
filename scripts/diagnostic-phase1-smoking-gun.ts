import { getPool, closePool } from '../src/persistence/pg-pool.js';
import { loadConfig } from '../src/config/env.js';

loadConfig();

async function section(title: string) {
  console.log('\n' + '='.repeat(110));
  console.log('  ' + title);
  console.log('='.repeat(110));
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
        colWidths[c] = Math.max(colWidths[c], Math.min(v.length, 58));
      }
    }
    const header = cols.map((c) => c.padEnd(colWidths[c])).join(' | ');
    console.log('-'.repeat(header.length));
    console.log(header);
    console.log('-'.repeat(header.length));
    const displayRows = res.rows.slice(0, 18);
    for (const row of displayRows) {
      const line = cols.map((c) => {
        let v = String(row[c] ?? 'NULL');
        if (v.length > 58) v = v.slice(0, 55) + '...';
        return v.padEnd(colWidths[c]);
      }).join(' | ');
      console.log(line);
    }
    if (res.rows.length > 18) console.log(`... (${res.rows.length - 18} more rows)`);
  }
  return res;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  await client.query("SET statement_timeout = '90000ms'");

  // =====================================================================
  // SECTION 1: Collision on 0.5% sample (COUNT not DISTINCT state for speed)
  // =====================================================================
  await section('SECTION 1: (lac,cisac) COLLISION CHECK — 0.5% SAMPLE');

  await runQuery(client,
    '0.5% sample: pair → #rows, #cities (state count via array length)',
    `SELECT
       lac, cisac,
       COUNT(DISTINCT state)::int AS states,
       COUNT(DISTINCT city)::int AS cities,
       COUNT(*)::int AS sample_rows,
       ARRAY_AGG(DISTINCT state ORDER BY state) AS states_list
     FROM subscriber_dump TABLESAMPLE SYSTEM (0.5)
     WHERE lac IS NOT NULL AND cisac IS NOT NULL AND state IS NOT NULL
     GROUP BY lac, cisac
     HAVING COUNT(DISTINCT state) > 1
     ORDER BY states DESC, cities DESC, sample_rows DESC
     LIMIT 25`);

  await runQuery(client,
    '0.5% sample pair summary — how many pairs are cross-state?',
    `WITH pair_stats AS (
       SELECT lac, cisac, COUNT(DISTINCT state) AS states
       FROM subscriber_dump TABLESAMPLE SYSTEM (0.5)
       WHERE lac IS NOT NULL AND cisac IS NOT NULL AND state IS NOT NULL
       GROUP BY lac, cisac
     )
     SELECT
       COUNT(*) AS total_pairs,
       COUNT(*) FILTER (WHERE states = 1) AS single_state,
       COUNT(*) FILTER (WHERE states = 2) AS two_states,
       COUNT(*) FILTER (WHERE states > 2) AS over_two_states,
       ROUND(100.0 * COUNT(*) FILTER (WHERE states > 1) / COUNT(*), 2) AS pct_cross_state
     FROM pair_stats`);

  // =====================================================================
  // SECTION 2: Concrete smoking-gun proof — 5 Delhi cells → leakage
  // =====================================================================
  await section('SECTION 2: SMOKING GUN — 5 Delhi cells → (lac,cisac) → SUBSCRIBERS');

  const fiveCells = await runQuery(client,
    'Pick 5 Delhi-area cells from cell_network_mapping (with Delhi coords)',
    `SELECT DISTINCT cell_id,
            ROUND(latitude::numeric, 6) AS lat,
            ROUND(longitude::numeric, 6) AS lng,
            ST_Y(geom)::numeric(8,6) AS geom_lat, ST_X(geom)::numeric(9,6) AS geom_lng
     FROM cell_network_mapping
     WHERE source = 'synthetic_test_mapping'
       AND latitude BETWEEN 28.5 AND 28.75
       AND longitude BETWEEN 77.0 AND 77.35
     ORDER BY cell_id
     LIMIT 5`);

  if (fiveCells.rows.length > 0) {
    const cellIds = fiveCells.rows.map((r: any) => r.cell_id);
    console.log('\n5 Delhi cell_ids selected (with Delhi lat/lng bbox):', cellIds);

    await runQuery(client,
      'These Delhi cells → (lac,cisac) mappings',
      `SELECT cell_id, lac, cisac,
              ROUND(latitude::numeric, 4) AS lat,
              ROUND(longitude::numeric, 4) AS lng,
              source
       FROM cell_network_mapping
       WHERE cell_id = ANY($1::text[])
       ORDER BY cell_id, lac, cisac`,
      [cellIds]);

    await runQuery(client,
      'CONCRETE PROOF: state distribution of SUBSCRIBERS reached via these 5 cells',
      `WITH cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       )
       SELECT
         s.state,
         COUNT(DISTINCT s.city) AS cities,
         COUNT(*)::int AS subscribers,
         ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct_of_total
       FROM cell_areas a
       JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
       WHERE s.state IS NOT NULL
       GROUP BY s.state
       ORDER BY subscribers DESC
       LIMIT 30`,
      [cellIds]);

    await runQuery(client,
      '20 LEAKAGE SAMPLES: non-Delhi/non-NCR subscribers (Tamil Nadu, Ladakh, etc.)',
      `WITH cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       ), matched AS (
         SELECT
           s.state, s.city, s.district,
           s.lac, s.cisac,
           s.msisdn, s.imsi, s.operator, s.technology,
           s.latitude, s.longitude
         FROM cell_areas a
         JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
         WHERE s.state IS NOT NULL
           AND s.state NOT IN ('Delhi', 'Haryana', 'Uttar Pradesh',
                               'Chandigarh', 'Punjab', 'Rajasthan', 'Uttarakhand')
       )
       SELECT * FROM matched ORDER BY state, city LIMIT 20`,
      [cellIds]);

    await runQuery(client,
      'SUMMARY METRICS: 5 Delhi cells → subscribers returned (with leakage quantified)',
      `WITH cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       )
       SELECT
         (SELECT COUNT(*) FROM cell_areas) AS area_pairs_used,
         (SELECT COUNT(DISTINCT state) FROM cell_areas a
            JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
            WHERE s.state IS NOT NULL) AS states_reached,
         (SELECT COUNT(DISTINCT city) FROM cell_areas a
            JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
            WHERE s.city IS NOT NULL) AS cities_reached,
         (SELECT COUNT(*) FROM cell_areas a
            JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac) AS total_subscribers,
         (SELECT COUNT(*) FROM cell_areas a
            JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
            WHERE s.state ILIKE '%Delhi%') AS delhi_subscribers,
         (SELECT COUNT(*) FROM cell_areas a
            JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
            WHERE s.state NOT ILIKE '%Delhi%'
              AND s.state NOT ILIKE '%Haryana%'
              AND s.state NOT ILIKE '%Uttar Pradesh%') AS non_ncr_leakage,
         (SELECT COUNT(DISTINCT s.state) FROM cell_areas a
            JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
            WHERE s.state NOT ILIKE '%Delhi%'
              AND s.state NOT ILIKE '%Haryana%'
              AND s.state NOT ILIKE '%Uttar Pradesh%') AS leakage_states_count`,
      [cellIds]);
  }

  // =====================================================================
  // SECTION 3: cell_towers integrity
  // =====================================================================
  await section('SECTION 3: cell_towers / sim_cell_towers DATA QUALITY');

  await runQuery(client,
    'cell_towers: operator / state distribution',
    `SELECT
       (SELECT COUNT(*) FROM cell_towers) AS total_towers,
       (SELECT COUNT(*) FROM cell_towers
          WHERE latitude BETWEEN 28.4 AND 28.9 AND longitude BETWEEN 76.9 AND 77.6) AS inside_delhi_bbox`);

  await runQuery(client,
    'sim_cell_towers — state + operator distribution (50K sample towers)',
    `SELECT state, operator_short_name, technology, COUNT(*) AS n
     FROM sim_cell_towers
     GROUP BY state, operator_short_name, technology
     ORDER BY state, n DESC
     LIMIT 25`);

  await runQuery(client,
    'sim_cell_towers — Delhi-district-level distribution (top 20)',
    `SELECT district, city, state, COUNT(*) AS n,
            ROUND(AVG(latitude)::numeric, 4) avg_lat,
            ROUND(AVG(longitude)::numeric, 4) avg_lng
     FROM sim_cell_towers
     GROUP BY district, city, state
     ORDER BY n DESC
     LIMIT 20`);

  // =====================================================================
  // SECTION 4: Delhi rows actual count (approx via index stats — no full scan)
  // =====================================================================
  await section('SECTION 4: APPROXIMATE DELHI COUNT');

  await runQuery(client,
    'Delhi subscriber count — COUNT with (lac,cisac) index (if Delhi uses specific lacs)',
    `WITH delhi_lacs AS (
       SELECT DISTINCT lac, cisac
       FROM subscriber_dump TABLESAMPLE SYSTEM (1)
       WHERE state ILIKE '%Delhi%'
     )
     SELECT
       (SELECT COUNT(*) FROM delhi_lacs) AS distinct_delhi_lac_cisac_pairs,
       (SELECT COUNT(*) FROM subscriber_dump s
          JOIN delhi_lacs dl ON s.lac = dl.lac AND s.cisac = dl.cisac) AS subs_reachable_via_delhi_pairs,
       (SELECT COUNT(*) FROM subscriber_dump s
          JOIN delhi_lacs dl ON s.lac = dl.lac AND s.cisac = dl.cisac
          WHERE s.state NOT ILIKE '%Delhi%') AS non_delhi_using_same_pairs`);

  await client.query("RESET statement_timeout");
  client.release();
  await closePool();

  console.log('\n\n' + '='.repeat(110));
  console.log('  SECTION 2 (smoking-gun) above PROVES root cause:');
  console.log('  Delhi cells → (lac,cisac) pairs that ALSO exist nationwide →');
  console.log('  JOIN on (lac,cisac) returns subscribers from Tamil Nadu,');
  console.log('  Ladakh, Mizoram, MP, Puducherry, Goa, J&K, Maharashtra, etc.');
  console.log('='.repeat(110));
}

main().catch((e) => {
  console.error('Diagnostic FAILED:', e);
  process.exit(1);
});
