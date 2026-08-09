import { getPool, closePool } from '../src/persistence/pg-pool.js';

async function section(title: string) {
  console.log('\n' + '='.repeat(90));
  console.log('  ' + title);
  console.log('='.repeat(90));
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
        colWidths[c] = Math.max(colWidths[c], Math.min(v.length, 60));
      }
    }
    const header = cols.map((c) => c.padEnd(colWidths[c])).join(' | ');
    console.log('-'.repeat(header.length));
    console.log(header);
    console.log('-'.repeat(header.length));
    const displayRows = res.rows.slice(0, 30);
    for (const row of displayRows) {
      const line = cols.map((c) => {
        let v = String(row[c] ?? 'NULL');
        if (v.length > 60) v = v.slice(0, 57) + '...';
        return v.padEnd(colWidths[c]);
      }).join(' | ');
      console.log(line);
    }
    if (res.rows.length > 30) console.log(`... (${res.rows.length - 30} more rows)`);
  }
  return res;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  await client.query("SET statement_timeout = '8000ms'");

  // ============================================================
  // FIRST: All small tables (no scans on dump)
  // ============================================================
  await section('TARGET CELLS ANALYSIS');

  await runQuery(client, 'ALL 100 target_cells',
    `SELECT cell_id, length(cell_id) AS len FROM target_cells ORDER BY cell_id`);

  await runQuery(client, 'target_cells numeric range analysis',
    `SELECT
       COUNT(*) AS total,
       MIN(cell_id) AS min_text,
       MAX(cell_id) AS max_text,
       CASE WHEN every(cell_id ~ '^[0-9]+$') THEN 'ALL_NUMERIC_TEXT'
            WHEN every(cell_id ~ '^[0-9A-F]+$') THEN 'ALL_HEX_TEXT'
            ELSE 'MIXED' END AS pattern
     FROM target_cells`);

  await section('SUBSCRIBERS SIM TABLE');

  await runQuery(client, 'COUNT subscribers', `SELECT COUNT(*) FROM subscribers`);

  await runQuery(client, 'ALL DISTINCT subscribers.cell_id values',
    `SELECT DISTINCT cell_id, lac FROM subscribers ORDER BY cell_id`);

  await runQuery(client, 'target_cells direct match with subscribers.cell_id',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT t.cell_id) AS matched,
       array_remove(array_agg(DISTINCT t.cell_id ORDER BY t.cell_id), NULL) AS matched_ids
     FROM target_cells t
     LEFT JOIN subscribers s ON s.cell_id = t.cell_id`);

  await section('SIM_CELL_TOWERS ANALYSIS');

  await runQuery(client, 'sim_cell_towers cell_id format sample 30',
    `SELECT site_id, cell_id, lac, bts_id, cgi, ecgi, technology, operator
     FROM sim_cell_towers ORDER BY site_id LIMIT 30`);

  await runQuery(client, 'sim_cell_towers: distinct LAC values',
    `SELECT DISTINCT lac FROM sim_cell_towers ORDER BY lac LIMIT 30`);

  await runQuery(client, 'sim_cell_towers: distinct cell_id vs target_cells overlap',
    `SELECT
       COUNT(DISTINCT sct.cell_id) AS sim_tower_cell_ids_total,
       COUNT(DISTINCT t.cell_id) FILTER (WHERE t.cell_id = sct.cell_id) AS overlap_target_cells
     FROM sim_cell_towers sct
     CROSS JOIN target_cells t`);

  // NOTE: this cross join is 50000*100=5M checks but 50K sim table only, should be fast
  // Actually better to do a proper JOIN

  await runQuery(client, 'target_cells vs sim_cell_towers.cell_id JOIN',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT t.cell_id) AS direct_match_in_sim_towers
     FROM target_cells t
     JOIN sim_cell_towers s ON s.cell_id = t.cell_id`);

  await runQuery(client, 'target_cells vs sim_cell_towers.bts_id JOIN',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT t.cell_id) AS bts_match_in_sim_towers
     FROM target_cells t
     JOIN sim_cell_towers s ON s.bts_id = t.cell_id`);

  await section('CELL_TOWERS TABLE');

  await runQuery(client, 'cell_towers sample 20',
    `SELECT id, cell_id, latitude, longitude, coverage_radius_m
     FROM cell_towers ORDER BY id LIMIT 20`);

  await runQuery(client, 'target_cells vs cell_towers.cell_id JOIN',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT t.cell_id) AS direct_match_in_cell_towers
     FROM target_cells t
     JOIN cell_towers ct ON ct.cell_id = t.cell_id`);

  await runQuery(client, 'target_cells vs cell_towers.id JOIN',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT t.cell_id) AS match_cell_towers_id
     FROM target_cells t
     JOIN cell_towers ct ON ct.id = t.cell_id`);

  await section('TELECOM_MASTER TABLE');

  await runQuery(client, 'telecom_master contents (all rows)',
    `SELECT * FROM telecom_master`);

  // ============================================================
  // subscriber_dump ONLY: indexed lookups or LIMIT only
  // NO GROUP BY, NO DISTINCT on unindexed columns
  // ============================================================
  await section('SUBSCRIBER_DUMP — LIMIT SAMPLE ONLY (no full scans)');

  await runQuery(client, 'dump first 20 rows ONLY (LIMIT scan, no sorting)',
    `SELECT imsi, msisdn, lac, cisac, technology, city, state, operator, district, id
     FROM subscriber_dump LIMIT 20`);

  await runQuery(client, 'dump sample 20: LAC CISAC values first pass',
    `SELECT lac, cisac,
            lac || '-' || cisac AS pair_dash,
            lac || cisac AS pair_plain,
            upper(lac) || '-' || upper(cisac) AS pair_upcase
     FROM (SELECT * FROM subscriber_dump LIMIT 100) x
     LIMIT 20`);

  // Use target_cells and dump LIMIT sample to check mapping strategies
  await runQuery(client,
    'Dump first 5000 rows — test 4 mapping strategies vs target_cells (NO full scan!)',
    `WITH dump_sample AS (SELECT lac, cisac FROM subscriber_dump LIMIT 5000)
     SELECT
       COUNT(*) FILTER (
         EXISTS (SELECT 1 FROM target_cells t WHERE t.cell_id = d.lac || '-' || d.cisac)
       ) AS strat_a_dash_concat,
       COUNT(*) FILTER (
         EXISTS (SELECT 1 FROM target_cells t WHERE t.cell_id = d.lac || d.cisac)
       ) AS strat_b_plain_concat,
       COUNT(*) FILTER (
         EXISTS (SELECT 1 FROM target_cells t WHERE t.cell_id = d.cisac)
       ) AS strat_c_cisac_only,
       COUNT(*) FILTER (
         EXISTS (SELECT 1 FROM target_cells t WHERE t.cell_id = d.lac)
       ) AS strat_d_lac_only,
       COUNT(*) FILTER (
         EXISTS (SELECT 1 FROM target_cells t WHERE t.cell_id = upper(d.cisac))
       ) AS strat_e_cisac_upper,
       COUNT(*) AS sample_rows
     FROM dump_sample d`);

  // Also check direct overlap: distinct CISAC in first 50K vs target
  await runQuery(client,
    'Distinct CISAC in first 50K dump vs target_cells',
    `WITH dump_cisacs AS (SELECT DISTINCT cisac FROM (SELECT cisac FROM subscriber_dump LIMIT 50000) x)
     SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT d.cisac) AS dump_distinct_cisacs_in_sample,
       COUNT(DISTINCT t.cell_id) FILTER (WHERE t.cell_id = d.cisac) AS cisac_eq_target_cellid,
       COUNT(DISTINCT t.cell_id) FILTER (WHERE upper(t.cell_id) = upper(d.cisac)) AS cisac_case_insensitive_match
     FROM target_cells t
     LEFT JOIN dump_cisacs d ON d.cisac = t.cell_id OR upper(d.cisac) = upper(t.cell_id)`);

  // LAC check
  await runQuery(client,
    'Distinct LAC in first 50K dump vs target_cells',
    `WITH dump_lacs AS (SELECT DISTINCT lac FROM (SELECT lac FROM subscriber_dump LIMIT 50000) x)
     SELECT
       COUNT(DISTINCT d.lac) AS dump_lacs_sample,
       COUNT(DISTINCT t.cell_id) FILTER (WHERE t.cell_id = d.lac OR upper(t.cell_id)=upper(d.lac)) AS matches
     FROM target_cells t
     LEFT JOIN dump_lacs d ON TRUE`);

  // Check: dump sample LAC values distribution
  await runQuery(client, 'Dump sample LAC values (first 100 distinct in LIMIT 50K)',
    `SELECT DISTINCT lac FROM (SELECT lac FROM subscriber_dump LIMIT 50000) x ORDER BY lac`);

  // ============================================================
  // GEOMETRY PATH CHECK (spatial index works)
  // ============================================================
  await section('GEOMETRY INDEXED PATH (subscriber_dump GiST geom)');

  // Test a point-in-polygon using the spatial index - small polygon near Delhi
  // Coords roughly central Delhi — should return a small result fast
  const smallDelhiPoly = {
    type: 'Polygon' as const,
    coordinates: [[[77.20, 28.60], [77.22, 28.60], [77.22, 28.62], [77.20, 28.62], [77.20, 28.60]]]
  };

  await runQuery(client,
    'Point-in-polygon lookup on dump (1km² Delhi) — uses GiST geom idx',
    `SELECT COUNT(*) AS n, COUNT(DISTINCT msisdn) AS uniq_msisdn
     FROM subscriber_dump d
     WHERE ST_Intersects(d.geom,
       ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))`,
    [JSON.stringify(smallDelhiPoly)]);

  // ============================================================
  // SUBSCRIBERS BENCHMARKS (sim table only)
  // ============================================================
  await section('BENCHMARKS — SUBSCRIBERS sim table (2000 rows, 16 partitions)');

  const cellListRes = await client.query(
    `SELECT DISTINCT cell_id FROM subscribers WHERE cell_id IS NOT NULL ORDER BY cell_id`);
  const cells = cellListRes.rows.map((r: any) => r.cell_id);
  console.log(`\nDistinct cell_ids in subscribers: ${cells.length}`);

  async function bench(label: string, text: string, values: any[] = []) {
    // warmup
    await client.query({ text, values }).catch(() => {});
    let best = Infinity;
    let lastRowCount = 0;
    for (let i = 0; i < 3; i++) {
      const s = performance.now();
      const r = await client.query({ text, values });
      const e = performance.now() - s;
      if (e < best) best = e;
      lastRowCount = r.rowCount;
    }
    console.log(`  ${label.padEnd(60)} | rows:${String(lastRowCount).padStart(5)} | best:${best.toFixed(1).padStart(8)} ms`);
  }

  for (const n of [3, 10, 100, 500, 1000, cells.length]) {
    if (cells.length < n) continue;
    const subset = cells.slice(0, n);
    await bench(
      `ANY(${n}) DISTINCT msisdn`,
      `SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      [subset]
    );
  }

  for (const n of [3, 10, 100, 500]) {
    if (cells.length < n) continue;
    const subset = cells.slice(0, n);
    const vsql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    await bench(
      `JOIN VALUES(${n}) DISTINCT msisdn`,
      `SELECT DISTINCT s.msisdn FROM subscribers s
       JOIN (VALUES ${vsql}) AS t(cell_id) ON t.cell_id = s.cell_id LIMIT 100000`,
      subset
    );
  }

  // target_cells actual JOIN
  await bench(
    `target_cells(100) JOIN subscribers DISTINCT msisdn`,
    `WITH t AS (SELECT cell_id FROM target_cells)
     SELECT DISTINCT s.msisdn FROM subscribers s JOIN t ON t.cell_id = s.cell_id LIMIT 100000`
  );

  // WITHOUT DISTINCT (check dedup cost)
  for (const n of [3, 100, 1000]) {
    if (cells.length < n) continue;
    const subset = cells.slice(0, n);
    await bench(
      `ANY(${n}) NO DISTINCT msisdn`,
      `SELECT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      [subset]
    );
  }

  // ============================================================
  // EXPLAIN ANALYZE on subscribers (sim table)
  // ============================================================
  await section('EXPLAIN ANALYZE — subscribers');

  for (const n of [3, 100]) {
    if (cells.length < n) continue;
    const subset = cells.slice(0, n);
    console.log(`\n--- ANY(${n}) + DISTINCT msisdn ---`);
    const r = await client.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
             SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      values: [subset],
    });
    console.log(r.rows.map((x: any) => x['QUERY PLAN']).join('\n'));
  }

  for (const n of [3, 100]) {
    if (cells.length < n) continue;
    const subset = cells.slice(0, n);
    const vsql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    console.log(`\n--- JOIN VALUES(${n}) + DISTINCT ---`);
    const r = await client.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
             SELECT DISTINCT s.msisdn FROM subscribers s
             JOIN (VALUES ${vsql}) AS t(cell_id) ON t.cell_id = s.cell_id LIMIT 100000`,
      values: subset,
    });
    console.log(r.rows.map((x: any) => x['QUERY PLAN']).join('\n'));
  }

  // Check: 16-partition ANY(100) fanout — see Append node with 16 children
  console.log(`\n--- ANY(100) + DISTINCT — VERBOSE format (partition fanout) ---`);
  const rFan = await client.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cells.slice(0, Math.min(100, cells.length))],
  });
  for (const line of rFan.rows.map((x: any) => x['QUERY PLAN'])) {
    if (line.includes('Append') || line.includes('Bitmap') || line.includes('Index Scan') ||
        line.includes('subscribers_p') || line.includes('HashAggregate') ||
        line.includes('Unique') || line.includes('Planning') || line.includes('Execution')) {
      console.log(line);
    }
  }

  await client.query("RESET statement_timeout");
  client.release();
  await closePool();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Diagnostic failed:', e);
  process.exit(1);
});
