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

  // ALWAYS set a short statement_timeout to avoid scans on 68M dump rows
  await client.query("SET statement_timeout = '8000ms'");

  // ============================================================
  // MAPPING VERIFICATION (sampling approach, not full EXISTS)
  // ============================================================
  await section('MAPPING VERIFICATION (LIGHTWEIGHT SAMPLING)');

  // 1. Pick 5 random LAC+CISAC pairs from dump (via limit, not random to be fast)
  await runQuery(
    client,
    'Sample 10 distinct (LAC,CISAC) pairs from subscriber_dump',
    `SELECT DISTINCT ON (lac, cisac) lac, cisac, COUNT(*) OVER (PARTITION BY lac, cisac) AS pair_count
     FROM subscriber_dump
     LIMIT 10`,
  );

  // 2. All distinct LAC values in dump (per pg_stats only 17 values - cheap)
  await runQuery(
    client,
    'All distinct LAC values in subscriber_dump',
    `SELECT DISTINCT lac FROM subscriber_dump ORDER BY lac`,
  );

  // 3. target_cells values
  await runQuery(
    client,
    'ALL 100 target_cells',
    `SELECT cell_id, 'x' || to_hex(cell_id::bigint) AS cell_as_hex_num
     FROM target_cells
     ORDER BY cell_id`,
  );

  // 4. Check: is target_cells.cell_id actually numeric disguised as text?
  await runQuery(
    client,
    'target_cells: can cell_id be cast to numeric? pattern analysis',
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE cell_id ~ '^[0-9]+$') AS all_digits,
       COUNT(*) FILTER (WHERE cell_id ~ '^[0-9A-F]+$') AS all_hex,
       MIN(cell_id::bigint) AS min_numeric,
       MAX(cell_id::bigint) AS max_numeric
     FROM target_cells`,
  );

  // 5. Subscribers: sample cell_id and LAC
  await runQuery(
    client,
    'Subscribers: 30 distinct cell_id values (their format)',
    `SELECT DISTINCT cell_id, lac
     FROM subscribers
     ORDER BY cell_id
     LIMIT 30`,
  );

  // 6. Check if target_cells.cell_id overlaps with subscribers.cell_id (direct)
  // Subscribers only 2000 rows, cheap join
  await runQuery(
    client,
    'target_cells ⋂ subscribers.cell_id (direct match)',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT t.cell_id) AS direct_match,
       array_agg(DISTINCT t.cell_id ORDER BY t.cell_id) FILTER (WHERE s.cell_id IS NOT NULL) AS matched_cells
     FROM target_cells t
     LEFT JOIN subscribers s ON s.cell_id = t.cell_id`,
  );

  // ============================================================
  // KEY: subscriber_dump — use a single pass sample to check
  // if there's overlap with target_cells via different mapping strategies
  // ============================================================
  await section('MAPPING: target_cells vs subscriber_dump (SINGLE PASS SAMPLE)');

  // Take the first 20,000 dump rows (LIMIT scan only) and check 4 mapping strategies
  // This avoids a full table scan
  await runQuery(
    client,
    'Dump sample (first 20K rows): test 4 mapping strategies vs target_cells',
    `WITH dump_sample AS (
       SELECT lac, cisac, msisdn
       FROM subscriber_dump LIMIT 20000
     ), strategies AS (
       SELECT
         -- Strategy A: LAC || '-' || CISAC = target_cells.cell_id
         (SELECT COUNT(*) FROM target_cells t WHERE t.cell_id = d.lac || '-' || d.cisac) AS strat_a,
         -- Strategy B: CISAC only == target_cells.cell_id (hex as text)
         (SELECT COUNT(*) FROM target_cells t WHERE t.cell_id = d.cisac) AS strat_b,
         -- Strategy C: LAC only == target_cells.cell_id
         (SELECT COUNT(*) FROM target_cells t WHERE t.cell_id = d.lac) AS strat_c,
         -- Strategy D: LAC || CISAC concatenated
         (SELECT COUNT(*) FROM target_cells t WHERE t.cell_id = d.lac || d.cisac) AS strat_d
       FROM dump_sample d
     )
     SELECT
       COUNT(*) FILTER (WHERE strat_a > 0) AS strat_a_hits,
       COUNT(*) FILTER (WHERE strat_b > 0) AS strat_b_hits,
       COUNT(*) FILTER (WHERE strat_c > 0) AS strat_c_hits,
       COUNT(*) FILTER (WHERE strat_d > 0) AS strat_d_hits,
       COUNT(*) AS total_sample
     FROM strategies`,
  );

  // Also test a direct overlap: what if target_cells.cell_id is actually CISAC from dump?
  // Check via distinct CISAC only sample
  await runQuery(
    client,
    'Distinct CISAC in sample 20K dump vs target_cells overlap',
    `WITH dump_cisacs AS (SELECT DISTINCT cisac FROM subscriber_dump LIMIT 50000)
     SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target,
       COUNT(DISTINCT d.cisac) AS sample_cisacs,
       COUNT(DISTINCT t.cell_id) FILTER (WHERE t.cell_id = d.cisac) AS cisac_eq_cellid_matches,
       array_agg(DISTINCT t.cell_id ORDER BY t.cell_id) FILTER (WHERE t.cell_id = d.cisac) AS matched
     FROM target_cells t
     LEFT JOIN dump_cisacs d ON d.cisac = t.cell_id`,
  );

  // Same for LAC
  await runQuery(
    client,
    'Distinct LAC in dump vs target_cells overlap',
    `WITH dump_lacs AS (SELECT DISTINCT lac FROM subscriber_dump)
     SELECT
       COUNT(DISTINCT d.lac) AS dump_lacs,
       COUNT(DISTINCT t.cell_id) FILTER (WHERE t.cell_id = d.lac) AS lac_eq_cellid_matches
     FROM target_cells t
     LEFT JOIN dump_lacs d ON d.lac = t.cell_id`,
  );

  // ============================================================
  // SUBSCRIBERS BENCHMARKS (SIM TABLE 2000 ROWS)
  // ============================================================
  await section('BENCHMARKS: SIM subscribers TABLE (2000 rows, 16 partitions)');

  const cellListRes = await client.query(
    `SELECT DISTINCT cell_id FROM subscribers WHERE cell_id IS NOT NULL ORDER BY cell_id LIMIT 10000`,
  );
  const cells = cellListRes.rows.map((r: any) => r.cell_id);
  console.log(`\nDistinct cell_ids in subscribers: ${cells.length}`);

  async function bench(label: string, fn: () => Promise<any>) {
    // warmup
    await fn();
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const s = performance.now();
      const r = await fn();
      const e = performance.now() - s;
      if (e < best) best = e;
    }
    console.log(`  ${label.padEnd(60)} best: ${best.toFixed(1)} ms`);
  }

  for (const n of [3, 10, 100, 200, 500, 1000]) {
    if (cells.length < n) break;
    const subset = cells.slice(0, n);
    await bench(`${n} cells · ANY($1) · DISTINCT msisdn`, async () =>
      client.query({
        text: `SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
        values: [subset],
      }),
    );
  }

  // VALUES join shape
  for (const n of [3, 100, 500]) {
    if (cells.length < n) break;
    const subset = cells.slice(0, n);
    const vsql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    await bench(`${n} cells · JOIN(VALUES) · DISTINCT`, async () =>
      client.query({
        text: `SELECT DISTINCT s.msisdn
               FROM subscribers s
               JOIN (VALUES ${vsql}) AS t(cell_id) ON t.cell_id = s.cell_id
               LIMIT 100000`,
        values: subset,
      }),
    );
  }

  // target_cells join shape (100 target cells actual)
  const actualTargetCells = (await client.query(`SELECT cell_id FROM target_cells`)).rows.map((r: any) => r.cell_id);
  console.log(`\nActual target_cells count: ${actualTargetCells.length}`);

  await bench(`${actualTargetCells.length} target_cells · CTE JOIN sim subscribers (eq on cell_id)`, async () =>
    client.query(`
      WITH t AS (SELECT cell_id FROM target_cells)
      SELECT DISTINCT s.msisdn
      FROM subscribers s JOIN t ON t.cell_id = s.cell_id
      LIMIT 100000`),
  );

  // ============================================================
  // EXPLAIN ANALYZE (SUBSCRIBERS TABLE)
  // ============================================================
  await section('EXPLAIN ANALYZE — scaling: 3 vs 100 vs 1000 cells');

  for (const n of [3, 100, 1000]) {
    if (cells.length < n) break;
    const subset = cells.slice(0, n);
    console.log(`\n--- ANY(${n} cells) SELECT DISTINCT msisdn ---`);
    const r = await client.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
             SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      values: [subset],
    });
    console.log(r.rows.map((x: any) => x['QUERY PLAN']).join('\n'));
  }

  // VALUES shape EXPLAIN 100
  if (cells.length >= 100) {
    const subset = cells.slice(0, 100);
    const vsql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    console.log(`\n--- JOIN(VALUES 100) SELECT DISTINCT msisdn ---`);
    const r = await client.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
             SELECT DISTINCT s.msisdn
             FROM subscribers s
             JOIN (VALUES ${vsql}) AS t(cell_id) ON t.cell_id = s.cell_id
             LIMIT 100000`,
      values: subset,
    });
    console.log(r.rows.map((x: any) => x['QUERY PLAN']).join('\n'));
  }

  // ============================================================
  // DEDUP ANALYTICS
  // ============================================================
  await section('DEDUP ANALYTICS');

  await runQuery(
    client,
    'subscribers: total vs distinct MSISDNs',
    `SELECT COUNT(*) AS total, COUNT(DISTINCT msisdn) AS uniq_msisdn,
            1.0 * COUNT(*) / NULLIF(COUNT(DISTINCT msisdn),0) AS ratio
     FROM subscribers`,
  );

  // Subscriber dump row counts per city (fast, city should have low cardinality)
  await runQuery(
    client,
    'subscriber_dump rows per city (LIMIT scan with LIMIT 1M sample approx)',
    `SELECT city, COUNT(*) AS approx_n
     FROM (SELECT city FROM subscriber_dump LIMIT 1000000) x
     GROUP BY city ORDER BY approx_n DESC`,
  );

  // ============================================================
  // FINAL: Can we build cell_id column from LAC+CISAC inside dump?
  // ============================================================
  await section('BRIDGE: subscriber_dump → cell_id construction options');

  // Test: does (LAC,CISAC) tuple map 1:1 to something we can join with towers?
  // Show sample pair vs tower cell_id formats
  await runQuery(
    client,
    'Cross-compare formats: dump LAC,CISAC vs sim_cell_towers LAC,cell_id vs target_cells',
    `SELECT
       'dump' AS src,
       (SELECT lac FROM subscriber_dump LIMIT 1) AS lac_val,
       (SELECT cisac FROM subscriber_dump LIMIT 1) AS ci_val,
       NULL AS tower_cell,
       NULL AS target_cell
     UNION ALL
     SELECT
       'sim_cell_towers' AS src,
       lac, cell_id, NULL, NULL
     FROM sim_cell_towers LIMIT 1
     UNION ALL
     SELECT
       'target_cells' AS src,
       NULL, NULL, NULL, cell_id
     FROM target_cells LIMIT 1`,
  );

  // Check sim_cell_towers LAC vs subscriber_dump LAC
  await runQuery(
    client,
    'sim_cell_towers LAC values (sample)',
    `SELECT DISTINCT lac FROM sim_cell_towers ORDER BY lac LIMIT 30`,
  );

  // Check if sim_cell_towers LAC + CISAC? Or sim_cell_towers cell_id matches dump CISAC?
  await runQuery(
    client,
    'sim_cell_towers: cell_id format sample 20',
    `SELECT site_id, cell_id, bts_id, lac, cgi, ecgi, technology
     FROM sim_cell_towers LIMIT 20`,
  );

  await client.query("RESET statement_timeout");
  client.release();
  await closePool();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Diagnostic failed:', e);
  process.exit(1);
});
