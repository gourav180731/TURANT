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
        colWidths[c] = Math.max(colWidths[c], Math.min(v.length, 52));
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
        if (v.length > 52) v = v.slice(0, 49) + '...';
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
  await client.query("SET statement_timeout = '60000ms'");

  // =====================================================================
  // SECTION 1: Exact counts (already confirmed, fast)
  // =====================================================================
  await section('SECTION 1: EXACT CARDINALITY');

  await runQuery(client, 'Exact row counts',
    `SELECT 'subscriber_dump' AS tbl, COUNT(*)::BIGINT AS n FROM subscriber_dump
     UNION ALL SELECT 'cell_network_mapping', COUNT(*) FROM cell_network_mapping
     UNION ALL SELECT 'cell_subscriber_mapping', COUNT(*) FROM cell_subscriber_mapping
     UNION ALL SELECT 'cell_towers', COUNT(*) FROM cell_towers
     UNION ALL SELECT 'sim_cell_towers', COUNT(*) FROM sim_cell_towers
     UNION ALL SELECT 'telecom_master', COUNT(*) FROM telecom_master
     ORDER BY n DESC`);

  // =====================================================================
  // SECTION 2: 0.5% SAMPLE BASED DISTRIBUTION (fast, ~500K rows)
  // =====================================================================
  await section('SECTION 2: 0.5% SAMPLE — STATE/OPERATOR/TECH DISTRIBUTION');

  await runQuery(client, 'State distribution (0.5% sample)',
    `SELECT state,
            COUNT(*) AS sample_rows,
            ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 3) AS pct_of_sample,
            COUNT(DISTINCT city) AS cities
     FROM subscriber_dump TABLESAMPLE SYSTEM (0.5)
     WHERE state IS NOT NULL
     GROUP BY state
     ORDER BY sample_rows DESC
     LIMIT 30`);

  await runQuery(client, 'Delhi sample count — 0.5%',
    `SELECT
       COUNT(*) AS sample_size,
       COUNT(*) FILTER (WHERE state ILIKE '%Delhi%') AS delhi_rows,
       ROUND(100.0 * COUNT(*) FILTER (WHERE state ILIKE '%Delhi%') / COUNT(*), 3) AS delhi_pct_sample,
       COUNT(DISTINCT state) AS distinct_states,
       COUNT(DISTINCT city) AS distinct_cities
     FROM subscriber_dump TABLESAMPLE SYSTEM (0.5)
     WHERE state IS NOT NULL`);

  await runQuery(client, 'Operator distribution — 0.5% sample',
    `SELECT operator, COUNT(*) AS n, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
     FROM subscriber_dump TABLESAMPLE SYSTEM (0.5)
     WHERE operator IS NOT NULL
     GROUP BY operator ORDER BY n DESC`);

  await runQuery(client, 'Technology distribution — 0.5% sample',
    `SELECT technology, COUNT(*) AS n, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
     FROM subscriber_dump TABLESAMPLE SYSTEM (0.5)
     WHERE technology IS NOT NULL
     GROUP BY technology ORDER BY n DESC`);

  // =====================================================================
  // SECTION 3: ROOT CAUSE — (lac,cisac) CROSS-STATE COLLISIONS on 5% sample
  // =====================================================================
  await section('SECTION 3: ROOT CAUSE — (lac,cisac) ARE NOT GEOGRAPHICALLY UNIQUE');

  await runQuery(client, 'Distinct (lac,cisac) pairs vs states/cities — 5% sample',
    `SELECT
       COUNT(DISTINCT (lac, cisac)) AS distinct_pairs,
       COUNT(DISTINCT state) AS distinct_states,
       COUNT(DISTINCT city) AS distinct_cities
     FROM subscriber_dump TABLESAMPLE SYSTEM (5)
     WHERE lac IS NOT NULL AND cisac IS NOT NULL AND state IS NOT NULL`);

  await runQuery(client,
    'TOP 30 COLLISIONS — pairs in MOST states (5% sample)',
    `SELECT
       lac, cisac,
       COUNT(DISTINCT state) AS num_states,
       COUNT(DISTINCT city) AS num_cities,
       COUNT(*) AS sample_rows,
       ARRAY_AGG(DISTINCT state ORDER BY state) AS states,
       ROUND(100.0 * COUNT(*) FILTER (WHERE state ILIKE '%Delhi%') / COUNT(*), 2) AS pct_delhi
     FROM subscriber_dump TABLESAMPLE SYSTEM (5)
     WHERE lac IS NOT NULL AND cisac IS NOT NULL AND state IS NOT NULL
     GROUP BY lac, cisac
     HAVING COUNT(DISTINCT state) > 1
     ORDER BY num_states DESC, num_cities DESC, sample_rows DESC
     LIMIT 30`);

  await runQuery(client,
    'HOW MANY pairs are cross-state? — 5% sample pair stats',
    `WITH pair_stats AS (
       SELECT lac, cisac,
              COUNT(DISTINCT state) AS states_in_pair,
              COUNT(DISTINCT city) AS cities_in_pair,
              COUNT(*) AS rows_in_pair
       FROM subscriber_dump TABLESAMPLE SYSTEM (5)
       WHERE lac IS NOT NULL AND cisac IS NOT NULL AND state IS NOT NULL
       GROUP BY lac, cisac
     )
     SELECT
       COUNT(*) AS total_pairs_in_sample,
       COUNT(*) FILTER (WHERE states_in_pair = 1) AS pairs_1_state,
       COUNT(*) FILTER (WHERE states_in_pair = 2) AS pairs_2_states,
       COUNT(*) FILTER (WHERE states_in_pair BETWEEN 3 AND 5) AS pairs_3_to_5_states,
       COUNT(*) FILTER (WHERE states_in_pair > 5) AS pairs_over_5_states,
       ROUND(100.0 * COUNT(*) FILTER (WHERE states_in_pair > 1) / COUNT(*), 2) AS pct_cross_state_pairs,
       ROUND(AVG(rows_in_pair), 1) AS avg_sample_rows_per_pair,
       MAX(rows_in_pair) AS max_sample_rows_in_pair
     FROM pair_stats`);

  // =====================================================================
  // SECTION 4: Concrete leakage proof — pick 5 sample Delhi cells
  // =====================================================================
  await section('SECTION 4: LEAKAGE PROOF — 5 Delhi cells → (lac,cisac) → CROSS-STATE subs');

  const fiveCells = await runQuery(client,
    '5 Delhi-area cells from cell_network_mapping (lat/lng in Delhi NCR bbox)',
    `SELECT DISTINCT cell_id, latitude, longitude
     FROM cell_network_mapping
     WHERE source = 'synthetic_test_mapping'
       AND latitude BETWEEN 28.4 AND 28.9
       AND longitude BETWEEN 76.9 AND 77.6
     ORDER BY cell_id
     LIMIT 5`);

  if (fiveCells.rows.length > 0) {
    const cellIds = fiveCells.rows.map((r: any) => r.cell_id);
    console.log('Testing 5 Delhi cell_ids:', cellIds);

    await runQuery(client, 'These Delhi cells → which (lac,cisac) pairs?',
      `SELECT cell_id, lac, cisac, source
       FROM cell_network_mapping
       WHERE cell_id = ANY($1::text[])
       ORDER BY cell_id, lac, cisac`,
      [cellIds]);

    // Get the unique (lac,cisac) pairs from these 5 cells, then JOIN the dump
    // and show what states come back (LIMIT to avoid big results; state group by)
    await runQuery(client,
      'JOIN RESULT: state distribution for subscribers reached via these 5 cells',
      `WITH cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       )
       SELECT
         s.state,
         COUNT(DISTINCT s.city) AS cities,
         COUNT(*) AS subs,
         ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct,
         ARRAY_AGG(DISTINCT s.city ORDER BY s.city LIMIT 8) AS city_samples
       FROM cell_areas a
       JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
       WHERE s.state IS NOT NULL
       GROUP BY s.state
       ORDER BY subs DESC
       LIMIT 25`,
      [cellIds]);

    await runQuery(client,
      'CROSS-STATE LEAKAGE: 20 example subscribers from unrelated states',
      `WITH cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       ), matched AS (
         SELECT s.state, s.city, s.district, s.lac, s.cisac,
                s.msisdn, s.imsi, s.operator, s.technology,
                s.latitude, s.longitude
         FROM cell_areas a
         JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
         WHERE s.state IS NOT NULL
           AND s.state NOT ILIKE '%Delhi%'
           AND s.state NOT ILIKE '%Haryana%'
           AND s.state NOT ILIKE '%Uttar Pradesh%'
       )
       SELECT * FROM matched ORDER BY state, city LIMIT 20`,
      [cellIds]);

    await runQuery(client,
      'SUMMARY: 5 Delhi cells → HOW MANY states/cities/subs returned?',
      `WITH cell_areas AS (
         SELECT DISTINCT m.lac, m.cisac
         FROM cell_network_mapping m
         WHERE m.cell_id = ANY($1::text[])
       ), agg AS (
         SELECT
           (SELECT COUNT(*) FROM cell_areas) AS area_pairs_used,
           (SELECT COUNT(DISTINCT state) FROM cell_areas a
              JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
              WHERE s.state IS NOT NULL) AS distinct_states,
           (SELECT COUNT(DISTINCT city) FROM cell_areas a
              JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
              WHERE s.city IS NOT NULL) AS distinct_cities,
           (SELECT COUNT(*) FROM cell_areas a
              JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac) AS total_subs,
           (SELECT COUNT(*) FROM cell_areas a
              JOIN subscriber_dump s ON s.lac = a.lac AND s.cisac = a.cisac
              WHERE s.state ILIKE '%Delhi%') AS delhi_subs
       )
       SELECT *,
         ROUND(100.0 * delhi_subs / NULLIF(total_subs, 0), 2) AS pct_delhi_of_total,
         (total_subs - delhi_subs) AS cross_state_leakage_subs
       FROM agg`,
      [cellIds]);
  }

  // =====================================================================
  // SECTION 5: Mapping provenance
  // =====================================================================
  await section('SECTION 5: cell_network_mapping PROVENANCE');

  await runQuery(client, 'Mapping stats by source',
    `SELECT
       source,
       COUNT(*) AS mapping_rows,
       COUNT(DISTINCT cell_id) AS cells,
       COUNT(DISTINCT (lac, cisac)) AS distinct_areas,
       ROUND(COUNT(*)::numeric / COUNT(DISTINCT cell_id), 2) AS areas_per_cell
     FROM cell_network_mapping
     GROUP BY source`);

  await runQuery(client, 'Mapping geographic spread',
    `SELECT
       source,
       ROUND(AVG(latitude)::numeric, 4) avg_lat,
       ROUND(MIN(latitude)::numeric, 4) min_lat, ROUND(MAX(latitude)::numeric, 4) max_lat,
       ROUND(AVG(longitude)::numeric, 4) avg_lng,
       ROUND(MIN(longitude)::numeric, 4) min_lng, ROUND(MAX(longitude)::numeric, 4) max_lng
     FROM cell_network_mapping
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     GROUP BY source`);

  // =====================================================================
  // SECTION 6: Identity integrity
  // =====================================================================
  await section('SECTION 6: IDENTITY INTEGRITY (5% sample dedup check)');

  await runQuery(client, 'IMSI duplicates in 5% sample',
    `SELECT imsi, COUNT(*) AS occurrences
     FROM subscriber_dump TABLESAMPLE SYSTEM (5)
     GROUP BY imsi
     HAVING COUNT(*) > 1
     ORDER BY occurrences DESC
     LIMIT 20`);

  await runQuery(client, 'MSISDN duplicates in 5% sample',
    `SELECT msisdn, COUNT(*) AS occurrences
     FROM subscriber_dump TABLESAMPLE SYSTEM (5)
     GROUP BY msisdn
     HAVING COUNT(*) > 1
     ORDER BY occurrences DESC
     LIMIT 20`);

  // =====================================================================
  // SECTION 7: Delhi-state specific operator/tech distribution
  // =====================================================================
  await section('SECTION 7: DELHI-SPECIFIC DISTRIBUTION (5% sample)');

  await runQuery(client, 'Delhi operator + tech — 5% sample',
    `SELECT operator, technology,
            COUNT(*) AS n,
            ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
     FROM subscriber_dump TABLESAMPLE SYSTEM (5)
     WHERE state ILIKE '%Delhi%' AND operator IS NOT NULL AND technology IS NOT NULL
     GROUP BY operator, technology
     ORDER BY n DESC
     LIMIT 20`);

  await client.query("RESET statement_timeout");
  client.release();
  await closePool();

  console.log('\n\n' + '='.repeat(110));
  console.log('  ROOT CAUSE HYPOTHESIS (to be validated from results above):');
  console.log('  1. (lac, cisac) pairs are NOT geographically unique — shared across states.');
  console.log('  2. cell_network_mapping binds Delhi cells to K-nearest (lac,cisac) pairs via geometry.');
  console.log('  3. Bridge JOIN picks ALL subscribers nationwide sharing each (lac,cisac) — LEAKAGE.');
  console.log('  4. subscriber_dump has NO cell_id column — nearest-neighbor backfill (005) never ran.');
  console.log('='.repeat(110));
}

main().catch((e) => {
  console.error('Diagnostic FAILED:', e);
  process.exit(1);
});
