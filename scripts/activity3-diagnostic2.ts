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

  // ============================================================
  // Fast total counts using pg_class.reltuples (no scan)
  // ============================================================
  await section('FAST TOTAL COUNTS (pg_class.reltuples, no scans)');

  await runQuery(
    pool,
    'Approximate row counts',
    `SELECT
       relname AS table_name,
       reltuples::bigint AS approx_rows,
       relpages AS pages_8k
     FROM pg_class
     WHERE relname IN ('subscribers','subscriber_dump','cell_towers','target_cells','telecom_master','sim_cell_towers')
       AND relnamespace='public'::regnamespace
     ORDER BY relname`,
  );

  // Exact counts for smaller tables
  await runQuery(
    pool,
    'Exact COUNT: target_cells, cell_towers, telecom_master',
    `SELECT 'target_cells' AS t, COUNT(*) FROM target_cells
     UNION ALL SELECT 'cell_towers', COUNT(*) FROM cell_towers
     UNION ALL SELECT 'telecom_master', COUNT(*) FROM telecom_master
     UNION ALL SELECT 'sim_cell_towers', COUNT(*) FROM sim_cell_towers
     UNION ALL SELECT 'subscribers', COUNT(*) FROM subscribers`,
  );

  // ============================================================
  // PG_STATS approximate column stats (no full scan)
  // ============================================================
  await section('PG_STATS APPROXIMATE STATISTICS');

  await runQuery(
    pool,
    'subscribers: cell_id, msisdn stats approx',
    `SELECT attname, n_distinct, null_frac,
            CASE WHEN array_length(most_common_vals::text::text[], 1) <= 10
                 THEN most_common_vals::text ELSE '<truncated>' END AS top_vals
     FROM pg_stats
     WHERE schemaname='public' AND tablename='subscribers'
       AND attname IN ('cell_id','msisdn','imsi','lac')`,
  );

  await runQuery(
    pool,
    'subscriber_dump: lac, cisac, msisdn stats approx',
    `SELECT attname, n_distinct, null_frac,
            CASE WHEN array_length(most_common_vals::text::text[], 1) <= 10
                 THEN most_common_vals::text ELSE '<truncated>' END AS top_vals
     FROM pg_stats
     WHERE schemaname='public' AND tablename='subscriber_dump'
       AND attname IN ('lac','cisac','msisdn','imsi','geom')`,
  );

  // ============================================================
  // MAPPING: TARGET_CELLS content + shape
  // ============================================================
  await section('TARGET_CELLS ANALYSIS');

  await runQuery(
    pool,
    'target_cells: sample 50 (look for LAC-CISAC pattern)',
    `SELECT cell_id,
            length(cell_id) AS len,
            position('-' IN cell_id) AS dash_pos,
            CASE WHEN cell_id ~ '^[0-9A-Fa-f]+-[0-9A-Fa-f]+$' THEN 'HEX-HEX'
                 WHEN cell_id ~ '^[0-9A-Fa-f]+$' THEN 'HEX'
                 WHEN cell_id ~ '^[0-9]+-[0-9]+$' THEN 'NUM-NUM'
                 ELSE 'OTHER' END AS shape
     FROM target_cells
     LIMIT 50`,
  );

  await runQuery(
    pool,
    'target_cells: shape breakdown',
    `SELECT
       CASE WHEN cell_id ~ '^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$' THEN '4HEX-4HEX'
            WHEN cell_id ~ '^[0-9A-Fa-f]+-[0-9A-Fa-f]+$' THEN 'HEX-HEX'
            WHEN cell_id ~ '^[0-9A-Fa-f]+$' THEN 'HEX'
            ELSE 'OTHER' END AS shape,
       COUNT(*) AS n
     FROM target_cells
     GROUP BY 1
     ORDER BY n DESC`,
  );

  // ============================================================
  // CRITICAL: Can target_cells -> LAC/CISAC subscriber_dump match?
  // ============================================================
  await section('MAPPING VERIFICATION: target_cells → subscriber_dump');

  await runQuery(
    pool,
    'Split target_cells by dash, check overlap with subscriber_dump (LAC, CISAC) using EXISTS',
    `SELECT
       COUNT(DISTINCT t.cell_id) AS total_target_cells,
       COUNT(DISTINCT t.cell_id) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM subscriber_dump d
           WHERE d.lac = split_part(t.cell_id, '-', 1)
             AND d.cisac = split_part(t.cell_id, '-', 2)
         )
       ) AS matched_via_lac_cisac_split,
       ROUND(100.0 * COUNT(DISTINCT t.cell_id) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM subscriber_dump d
           WHERE d.lac = split_part(t.cell_id, '-', 1)
             AND d.cisac = split_part(t.cell_id, '-', 2)
         )
       )::numeric / NULLIF(COUNT(DISTINCT t.cell_id), 0), 2) AS pct_matched
     FROM target_cells t`,
  );

  // Sample matches
  await runQuery(
    pool,
    'Sample 20: target_cell = LAC-CISAC, verify subscriber_dump has (LAC,CISAC)',
    `SELECT t.cell_id,
            split_part(t.cell_id, '-', 1) AS expected_lac,
            split_part(t.cell_id, '-', 2) AS expected_cisac,
            (SELECT COUNT(*) FROM subscriber_dump d
              WHERE d.lac = split_part(t.cell_id, '-', 1)
                AND d.cisac = split_part(t.cell_id, '-', 2)) AS dump_rows
     FROM target_cells t
     LIMIT 20`,
  );

  // ============================================================
  // CRITICAL: Can target_cells -> subscribers.cell_id match?
  // ============================================================
  await section('MAPPING: target_cells → subscribers.cell_id');

  await runQuery(
    pool,
    'target_cells overlap with subscribers.cell_id (direct equality)',
    `SELECT
       COUNT(DISTINCT t.cell_id) AS total_target_cells,
       COUNT(DISTINCT t.cell_id) FILTER (
         WHERE EXISTS (SELECT 1 FROM subscribers s WHERE s.cell_id = t.cell_id)
       ) AS matched_direct,
       ROUND(100.0 * COUNT(DISTINCT t.cell_id) FILTER (
         WHERE EXISTS (SELECT 1 FROM subscribers s WHERE s.cell_id = t.cell_id)
       )::numeric / NULLIF(COUNT(DISTINCT t.cell_id), 0), 2) AS pct_matched
     FROM target_cells t`,
  );

  await runQuery(
    pool,
    'Sample 20: target_cell_id vs subscribers (direct or via split)',
    `SELECT t.cell_id,
            EXISTS(SELECT 1 FROM subscribers s WHERE s.cell_id = t.cell_id) AS direct_match,
            split_part(t.cell_id, '-', 1) AS part1,
            split_part(t.cell_id, '-', 2) AS part2,
            (SELECT COUNT(*) FROM subscribers s
              WHERE s.lac = split_part(t.cell_id, '-', 1)) AS subs_with_part1_as_lac
     FROM target_cells t
     LIMIT 20`,
  );

  // ============================================================
  // SUBSCRIBERS TABLE BENCHMARKS (small table, has cell_id idx)
  // ============================================================
  await section('BENCHMARK: subscribers SIM TABLE (cell_id indexed)');

  const cellListRes = await pool.query(
    `SELECT DISTINCT cell_id FROM subscribers WHERE cell_id IS NOT NULL ORDER BY cell_id LIMIT 10000`,
  );
  const cells = cellListRes.rows.map((r: any) => r.cell_id);
  console.log(`\nPicked ${cells.length} distinct cell_ids from subscribers for benchmarks.`);

  async function benchSubscribersAny(count: number, desc: string = '') {
    if (cells.length < count) { console.log(`  (only ${cells.length} cells available)`); return; }
    const subset = cells.slice(0, count);
    const label = `${desc}subscribers ${count} cells (cell_id = ANY + DISTINCT msisdn)`;
    const start = performance.now();
    const res = await pool.query({
      text: `SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      values: [subset],
    });
    const elapsed = performance.now() - start;
    console.log(`  ${label.padEnd(55)} -> ${elapsed.toFixed(1)} ms, ${res.rowCount} msisdns`);
    return { elapsed, rows: res.rowCount };
  }

  async function benchJoinShape(count: number) {
    if (cells.length < count) return;
    const subset = cells.slice(0, count);
    const valuesSql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    const label = `subscribers ${count} cells JOIN(VALUES)+DISTINCT`;
    const start = performance.now();
    const res = await pool.query({
      text: `SELECT DISTINCT s.msisdn
             FROM subscribers s
             JOIN (VALUES ${valuesSql}) AS t(cell_id) ON t.cell_id = s.cell_id
             LIMIT 100000`,
      values: subset,
    });
    const elapsed = performance.now() - start;
    console.log(`  ${label.padEnd(55)} -> ${elapsed.toFixed(1)} ms, ${res.rowCount} msisdns`);
    return { elapsed, rows: res.rowCount };
  }

  async function benchJoinTargetCellsShape(count: number) {
    // Simulates: JOIN target_cells ON target_cells.cell_id = subscribers.cell_id
    // but using a CTE of N rows
    if (cells.length < count) return;
    const subset = cells.slice(0, count);
    const valuesSql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    const label = `subscribers ${count} cells WITH target_cells CTE JOIN+DISTINCT`;
    const start = performance.now();
    const res = await pool.query({
      text: `WITH target_cells(cell_id) AS (VALUES ${valuesSql})
             SELECT DISTINCT s.msisdn
             FROM subscribers s
             JOIN target_cells t ON t.cell_id = s.cell_id
             LIMIT 100000`,
      values: subset,
    });
    const elapsed = performance.now() - start;
    console.log(`  ${label.padEnd(55)} -> ${elapsed.toFixed(1)} ms, ${res.rowCount} msisdns`);
    return { elapsed, rows: res.rowCount };
  }

  await benchSubscribersAny(3);
  await benchSubscribersAny(100);
  await benchSubscribersAny(1000);
  await benchSubscribersAny(5000);
  if (cells.length >= 10000) await benchSubscribersAny(10000);

  console.log('\n-- JOIN VALUES shape --');
  await benchJoinShape(3);
  await benchJoinShape(100);

  console.log('\n-- WITH target_cells CTE JOIN (worse case) --');
  await benchJoinTargetCellsShape(3);
  await benchJoinTargetCellsShape(100);

  // ============================================================
  // subscriber_dump benchmark: point-in-polygon via geom idx
  // (since subscriber_dump has NO cell_id idx yet - migration 005 not applied)
  // ============================================================
  await section('SUBSCRIBER_DUMP: cell_id INDEXED LOOKUP FEASIBILITY');

  await runQuery(
    pool,
    'Does idx_subscriber_dump_cell_id exist?',
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename='subscriber_dump'
     AND indexname LIKE '%cell%'`,
  );

  // Run 3-cell and 100-cell ANY lookups on subscriber_dump USING LAC+CISAC (no idx -> seq scan, timeout fast)
  // Instead: just benchmark geom indexed (point-in-polygon) for a small shape
  console.log('\n-- Bench: subscriber_dump cell_id = ANY without index --');
  const testCellsForDump = cells.slice(0, 3);
  const startDump3 = performance.now();
  try {
    // Use statement_timeout to avoid hanging
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const res = await client.query({
      text: `SELECT DISTINCT msisdn FROM subscriber_dump WHERE lac = ANY($1::text[]) LIMIT 100`,
      values: [['0453', '045F', '0451']],
    });
    await client.query('ROLLBACK');
    client.release();
    console.log(`  lac=ANY(3 values) on dump (no LAC idx?): ${(performance.now() - startDump3).toFixed(1)} ms, ${res.rowCount} rows`);
  } catch (e: any) {
    console.log(`  lac=ANY on dump: FAILED/TIMEOUT: ${e.message}`);
  }

  // ============================================================
  // EXPLAIN ANALYZE: subscribers 3 cells vs 100 cells
  // ============================================================
  await section('EXPLAIN (ANALYZE, BUFFERS): subscribers SIM');

  const cell3 = cells.slice(0, 3);
  const cell100 = cells.slice(0, 100);

  console.log('\n--- subscribers ANY(3 cells): ---');
  const e3 = await pool.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cell3],
  });
  console.log(e3.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n--- subscribers ANY(100 cells): ---');
  const e100 = await pool.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cell100],
  });
  console.log(e100.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  // VALUES JOIN shape explain
  if (cell100.length >= 100) {
    const vsql = cell100.map((_, i) => `($${i + 1}::text)`).join(',');
    console.log('\n--- subscribers JOIN VALUES (100 cells): ---');
    const ej = await pool.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
             SELECT DISTINCT s.msisdn
             FROM subscribers s
             JOIN (VALUES ${vsql}) AS t(cell_id) ON t.cell_id = s.cell_id
             LIMIT 100000`,
      values: cell100,
    });
    console.log(ej.rows.map((r: any) => r['QUERY PLAN']).join('\n'));
  }

  // ============================================================
  // INDEX COVERAGE INSPECTION
  // ============================================================
  await section('INDEX OPPORTUNITY ANALYSIS');

  await runQuery(
    pool,
    'subscriber_dump column list — do we need composite (lac, cisac) index?',
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subscriber_dump'
     ORDER BY ordinal_position`,
  );

  await runQuery(
    pool,
    'Check for existing (lac, cisac) or cell_id indexes on subscriber_dump',
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename='subscriber_dump'
     ORDER BY indexname`,
  );

  // ============================================================
  // DEDUP COST: unique msisdn vs total per cell
  // ============================================================
  await section('DEDUP ANALYTICS');

  await runQuery(
    pool,
    'subscribers: total rows vs distinct MSISDNs (duplicates per MSISDN approx)',
    `SELECT
       COUNT(*) AS total_subs,
       COUNT(DISTINCT msisdn) AS distinct_msisdns,
       ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT msisdn), 0), 3) AS subs_per_msisdn
     FROM subscribers`,
  );

  await runQuery(
    pool,
    'subscribers: msisdn duplication (top 10 repeated MSISDNs)',
    `SELECT msisdn, COUNT(*) AS n
     FROM subscribers
     GROUP BY msisdn HAVING COUNT(*) > 1
     ORDER BY n DESC LIMIT 10`,
  );

  await closePool();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Diagnostic failed:', e);
  process.exit(1);
});
