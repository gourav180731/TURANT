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
  // 1. EXACT SCHEMA: subscribers, subscriber_dump, cell_towers, target_cells
  // ============================================================
  await section('1. EXACT TABLE SCHEMAS');

  for (const tbl of ['subscribers', 'subscriber_dump', 'cell_towers', 'target_cells', 'telecom_master', 'sim_cell_towers']) {
    console.log(`\n>>>>>> TABLE: ${tbl} <<<<<<`);
    const exists = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS e`,
      [tbl],
    );
    if (!exists.rows[0].e) {
      console.log('  *** TABLE DOES NOT EXIST ***');
      continue;
    }
    await runQuery(
      pool,
      `Columns of ${tbl}`,
      `SELECT ordinal_position, column_name, data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [tbl],
    );
  }

  // ============================================================
  // 2. PRIMARY KEYS, PARTITION KEY, ALL INDEXES
  // ============================================================
  await section('2. PRIMARY KEYS, PARTITION KEYS, INDEXES');

  for (const tbl of ['subscribers', 'subscriber_dump', 'cell_towers', 'target_cells', 'telecom_master']) {
    console.log(`\n>>>>>> TABLE: ${tbl} <<<<<<`);
    const exists = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS e`,
      [tbl],
    );
    if (!exists.rows[0].e) {
      console.log('  *** TABLE DOES NOT EXIST ***');
      continue;
    }

    await runQuery(
      pool,
      `Primary keys on ${tbl}`,
      `SELECT kcu.column_name, tc.constraint_type, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
      [tbl],
    );

    // Check partition
    await runQuery(
      pool,
      `Partition strategy for ${tbl}`,
      `SELECT pt.partstrat AS partition_strategy,
              pg_get_expr(pt.partexprs, pt.partrelid) AS partition_expr,
              pc.relkind, pc.relispartition
       FROM pg_class pc
       JOIN pg_namespace pn ON pc.relnamespace = pn.oid
       LEFT JOIN pg_partitioned_table pt ON pt.partrelid = pc.oid
       WHERE pn.nspname='public' AND pc.relname=$1`,
      [tbl],
    );

    // List partitions if any
    if (tbl === 'subscribers') {
      await runQuery(
        pool,
        `Partition list for subscribers`,
        `SELECT nmsp_parent.nspname AS parent_schema,
                parent.relname      AS parent,
                nmsp_child.nspname  AS child_schema,
                child.relname       AS child,
                pg_get_expr(child.relpartbound, child.oid) AS bound
         FROM pg_inherits
         JOIN pg_class parent            ON pg_inherits.inhparent = parent.oid
         JOIN pg_class child             ON pg_inherits.inhrelid   = child.oid
         JOIN pg_namespace nmsp_parent   ON nmsp_parent.oid  = parent.relnamespace
         JOIN pg_namespace nmsp_child    ON nmsp_child.oid   = child.relnamespace
         WHERE parent.relname=$1
         ORDER BY child.relname`,
        [tbl],
      );
    }

    await runQuery(
      pool,
      `All indexes on ${tbl}`,
      `SELECT
         i.relname AS index_name,
         am.amname AS index_type,
         idx.indisunique AS is_unique,
         idx.indisprimary AS is_primary,
         array_agg(a.attname ORDER BY k.n) AS columns,
         pg_get_indexdef(idx.indexrelid) AS index_def
       FROM pg_index idx
       JOIN pg_class i ON i.oid = idx.indexrelid
       JOIN pg_am am ON i.relam = am.oid
       JOIN pg_class t ON t.oid = idx.indrelid
       JOIN pg_namespace ns ON t.relnamespace = ns.oid
       LEFT JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS k(attnum, n) ON TRUE
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE ns.nspname = 'public' AND t.relname = $1
       GROUP BY i.relname, am.amname, idx.indisunique, idx.indisprimary, idx.indexrelid
       ORDER BY idx.indisprimary DESC, i.relname`,
      [tbl],
    );
  }

  // ============================================================
  // 5. VERIFY LAC + CISAC -> CELL_ID MAPPING FROM DATA
  // ============================================================
  await section('5. LAC + CISAC / CELL_ID MAPPING VERIFICATION');

  // Check if subscriber_dump has LAC and CISAC-like columns
  const sdCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subscriber_dump'`,
  );
  console.log('\nsubscriber_dump columns:');
  for (const r of sdCols.rows) console.log('  -', r.column_name);

  // Also check subscribers table lac/ci fields
  await runQuery(
    pool,
    'Sample subscribers: cell_id, lac, and related identity columns',
    `SELECT imsi, msisdn, cell_id, tower_id, lac, tac, rnc_id, enb_id, gnb_id, sector_id, technology
     FROM subscribers LIMIT 10`,
  );

  await runQuery(
    pool,
    'Sample subscriber_dump rows (check for LAC/CISAC/CI fields)',
    `SELECT * FROM subscriber_dump LIMIT 10`,
  );

  // Check if subscriber_dump.cell_id column exists at all
  const cellIdCol = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='subscriber_dump' AND column_name='cell_id') AS e`,
  );
  console.log(`\nsubscriber_dump has cell_id column? ${cellIdCol.rows[0].e}`);

  if (cellIdCol.rows[0].e) {
    await runQuery(
      pool,
      'subscriber_dump: cell_id fill rate + sample',
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE cell_id IS NOT NULL) AS with_cell_id,
         ROUND(100.0 * COUNT(*) FILTER (WHERE cell_id IS NOT NULL) / COUNT(*), 2) AS pct_filled,
         COUNT(DISTINCT cell_id) AS distinct_cell_ids
       FROM subscriber_dump`,
    );
  }

  await runQuery(
    pool,
    'subscriber_dump LAC/CISAC distinct count and sample values',
    `SELECT
       COUNT(*) FILTER (WHERE lac IS NOT NULL) AS has_lac,
       COUNT(DISTINCT lac) AS distinct_lac,
       COUNT(*) FILTER (WHERE cisac IS NOT NULL) AS has_cisac,
       COUNT(DISTINCT cisac) AS distinct_cisac,
       COUNT(DISTINCT (lac, cisac)) AS distinct_lac_cisac_pairs
     FROM subscriber_dump`,
  );

  await runQuery(
    pool,
    'Top 20 subscriber_dump LAC values by count',
    `SELECT lac, COUNT(*) AS n
     FROM subscriber_dump WHERE lac IS NOT NULL
     GROUP BY lac ORDER BY n DESC LIMIT 20`,
  );

  await runQuery(
    pool,
    'Top 20 subscriber_dump CISAC values by count',
    `SELECT cisac, COUNT(*) AS n
     FROM subscriber_dump WHERE cisac IS NOT NULL
     GROUP BY cisac ORDER BY n DESC LIMIT 20`,
  );

  await runQuery(
    pool,
    'Sample LAC+CISAC pairs from subscriber_dump (with counts)',
    `SELECT lac, cisac, COUNT(*) AS n
     FROM subscriber_dump
     WHERE lac IS NOT NULL AND cisac IS NOT NULL
     GROUP BY lac, cisac
     ORDER BY n DESC LIMIT 20`,
  );

  // Can LAC+CISAC from dump be mapped to telecom_master or sim_cell_towers?
  await runQuery(
    pool,
    'sim_cell_towers sample LAC columns vs cell_id',
    `SELECT site_id, cell_id, bts_id, lac, tac, cgi, ecgi, mcc, mnc, plmn
     FROM sim_cell_towers LIMIT 20`,
  );

  // Check mapping: do telecom_master or sim_cell_towers carry LAC+CI info?
  const hasLacInMaster = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='telecom_master' AND column_name='lac') AS e`,
  );
  console.log(`\ntelecom_master has lac column? ${hasLacInMaster.rows[0].e}`);

  // Check if subscribers has LAC and whether it matches tower LAC
  await runQuery(
    pool,
    'subscribers: LAC distribution',
    `SELECT lac, COUNT(*) AS n, COUNT(DISTINCT cell_id) AS cells
     FROM subscribers WHERE lac IS NOT NULL
     GROUP BY lac ORDER BY n DESC LIMIT 20`,
  );

  // Check LAC+CISAC in subscriber_dump vs (LAC in tower tables + cell_id pattern)
  // Try to parse LAC+CISAC -> CGI form, vs cell_id pattern
  await runQuery(
    pool,
    'Pattern analysis: subscriber_dump.cell_id (if filled) vs LAC/CISAC concat',
    `SELECT
       d.cell_id, d.lac, d.cisac,
       d.lac || '-' || d.cisac AS lac_concat_cisac,
       d.lac || d.cisac AS lac_cisac_plain
     FROM subscriber_dump d
     WHERE d.cell_id IS NOT NULL
     LIMIT 20`,
  ).catch(() => console.log('  (no cell_id on subscriber_dump yet)'));

  await runQuery(
    pool,
    'Sample telecom_master (BTS reference): cell_id + location identifiers',
    `SELECT id, cell_id, bts_id, latitude, longitude, technology, rnc_id, tsp_name, state, district, city_town
     FROM telecom_master LIMIT 20`,
  );

  await runQuery(
    pool,
    'target_cells: count and sample values',
    `SELECT COUNT(*) AS total_target_cells FROM target_cells`,
  );

  await runQuery(
    pool,
    'target_cells sample (first 30)',
    `SELECT cell_id FROM target_cells ORDER BY cell_id LIMIT 30`,
  );

  // Mapping: target_cells.cell_id → subscribers.cell_id
  await runQuery(
    pool,
    'target_cells present in subscribers.cell_id?',
    `SELECT
       (SELECT COUNT(*) FROM target_cells) AS total_target_cells,
       (SELECT COUNT(DISTINCT t.cell_id)
          FROM target_cells t JOIN subscribers s ON s.cell_id = t.cell_id) AS matched_in_subscribers,
       (SELECT COUNT(DISTINCT t.cell_id)
          FROM target_cells t
          WHERE NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.cell_id = t.cell_id)) AS unmatched_in_subscribers`,
  );

  // Mapping: target_cells → subscriber_dump
  await runQuery(
    pool,
    'target_cells present in subscriber_dump.cell_id?',
    `SELECT
       (SELECT COUNT(DISTINCT t.cell_id)
          FROM target_cells t JOIN subscriber_dump d ON d.cell_id = t.cell_id) AS matched_in_dump,
       (SELECT COUNT(DISTINCT t.cell_id)
          FROM target_cells t
          WHERE EXISTS (SELECT 1 FROM subscriber_dump d WHERE d.cell_id = t.cell_id)) AS dump_has_any
     LIMIT 1`,
  ).catch(() => console.log('  (no cell_id on subscriber_dump yet)'));

  // Also try mapping target_cells.cell_id via LAC+CISAC split
  await runQuery(
    pool,
    'Can target_cells.cell_id be split into LAC+CISAC? (sample matching attempts)',
    `SELECT t.cell_id,
            regexp_match(t.cell_id, '^([^-]+)-(.+)$') AS split_dash,
            split_part(t.cell_id, '-', 1) AS part1,
            split_part(t.cell_id, '-', 2) AS part2
     FROM target_cells t
     LIMIT 30`,
  );

  // Try to find target_cells in subscriber_dump via LAC+CISAC
  await runQuery(
    pool,
    'Join target_cells → subscriber_dump via LAC/CISAC match (split cell_id by -)',
    `SELECT
       COUNT(DISTINCT t.cell_id) AS target_cells_matched_via_lac_cisac,
       (SELECT COUNT(*) FROM target_cells) AS total_target_cells
     FROM target_cells t
     WHERE EXISTS (
       SELECT 1 FROM subscriber_dump d
       WHERE d.lac = split_part(t.cell_id, '-', 1)
         AND d.cisac = split_part(t.cell_id, '-', 2)
     )`,
  );

  // ============================================================
  // 6. EVERY REQUIRED CELL ID EXISTS IN SUBSCRIBERS?
  // (We first need to see if target_cells exists)
  // ============================================================
  await section('6. CELL ID COVERAGE');

  const targetCellsExist = (await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='target_cells') AS e`,
  )).rows[0].e;

  console.log(`\ntarget_cells table exists: ${targetCellsExist}`);

  if (targetCellsExist) {
    await runQuery(pool, 'target_cells sample', `SELECT * FROM target_cells LIMIT 20`);
    await runQuery(
      pool,
      'Target cell coverage: how many target cell_ids match subscribers.cell_id?',
      `SELECT
         (SELECT COUNT(*) FROM target_cells) AS total_target_cells,
         (SELECT COUNT(*) FROM target_cells t
           WHERE EXISTS (SELECT 1 FROM subscribers s WHERE s.cell_id = t.cell_id)) AS matched_in_subscribers,
         (SELECT COUNT(*) FROM target_cells t
           WHERE EXISTS (SELECT 1 FROM subscriber_dump d WHERE d.cell_id = t.cell_id)) AS matched_in_dump`,
    );
  } else {
    console.log('  (no target_cells table — skipping coverage check against that)');
  }

  // Also: telecom_master cell_id vs subscribers cell_id
  await runQuery(
    pool,
    'telecom_master cell_ids present in subscribers?',
    `SELECT
       (SELECT COUNT(*) FROM telecom_master) AS total_master_cells,
       (SELECT COUNT(DISTINCT cell_id) FROM telecom_master) AS distinct_master_cells,
       (SELECT COUNT(DISTINCT s.cell_id)
          FROM telecom_master tm JOIN subscribers s ON s.cell_id = tm.cell_id) AS master_cell_ids_in_subscribers,
       (SELECT COUNT(DISTINCT d.cell_id)
          FROM telecom_master tm JOIN subscriber_dump d ON d.cell_id = tm.cell_id) AS master_cell_ids_in_dump`,
  );

  // ============================================================
  // 7. READ-ONLY STATISTICS
  // ============================================================
  await section('7. STATISTICS');

  await runQuery(
    pool,
    'Total subscribers + distinct cell_ids',
    `SELECT
       'subscribers' AS tbl,
       COUNT(*) AS total,
       COUNT(DISTINCT cell_id) AS distinct_cell_ids,
       COUNT(DISTINCT msisdn) AS distinct_msisdns
     FROM subscribers
     UNION ALL
     SELECT
       'subscriber_dump' AS tbl,
       COUNT(*) AS total,
       COUNT(DISTINCT cell_id) AS distinct_cell_ids,
       COUNT(DISTINCT msisdn) AS distinct_msisdns
     FROM subscriber_dump`,
  );

  await runQuery(
    pool,
    'Subscriber count per cell (top 30, subscribers table)',
    `SELECT cell_id, COUNT(*) AS n, COUNT(DISTINCT msisdn) AS msisdn_n
     FROM subscribers
     GROUP BY cell_id
     ORDER BY n DESC
     LIMIT 30`,
  );

  await runQuery(
    pool,
    'Subscriber count per cell (top 30, subscriber_dump table)',
    `SELECT cell_id, COUNT(*) AS n, COUNT(DISTINCT msisdn) AS msisdn_n
     FROM subscriber_dump
     GROUP BY cell_id
     ORDER BY n DESC
     LIMIT 30`,
  );

  await runQuery(
    pool,
    'Per-cell count distribution (subscribers)',
    `SELECT
       width_bucket(n, 1, 500, 10) AS bucket,
       COUNT(*) AS cells_in_bucket
     FROM (SELECT cell_id, COUNT(*) AS n FROM subscribers GROUP BY cell_id) x
     GROUP BY 1
     ORDER BY 1`,
  );

  // ============================================================
  // 8-9. BENCHMARKS: 3-cell, 100-cell, 1K, 5K, 10K cell lookups
  // ============================================================
  await section('8 & 9. BENCHMARK: CELL-ID INDEXED LOOKUP SCALING');

  // Pick real cell_ids from subscribers
  const cellListRes = await pool.query(
    `SELECT DISTINCT cell_id FROM subscribers WHERE cell_id IS NOT NULL ORDER BY cell_id LIMIT 10000`,
  );
  const cells = cellListRes.rows.map((r: any) => r.cell_id);
  console.log(`\nPicked ${cells.length} distinct cell_ids from subscribers for benchmarks.`);

  async function benchSubscribersAny(count: number) {
    if (cells.length < count) { console.log(`  (only ${cells.length} cells available, skipping ${count})`); return; }
    const subset = cells.slice(0, count);
    const label = `subscribers: ${count} cells (cell_id = ANY)`;
    const start = performance.now();
    const res = await pool.query({
      text: `SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      values: [subset],
    });
    const elapsed = performance.now() - start;
    console.log(`  ${label.padEnd(45)} -> ${elapsed.toFixed(1)} ms, ${res.rowCount} msisdns`);
    return elapsed;
  }

  async function benchDumpAny(count: number) {
    if (cells.length < count) { console.log(`  (only ${cells.length} cells available, skipping ${count})`); return; }
    const subset = cells.slice(0, count);
    const label = `subscriber_dump: ${count} cells (cell_id = ANY)`;
    const start = performance.now();
    const res = await pool.query({
      text: `SELECT DISTINCT msisdn FROM subscriber_dump WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
      values: [subset],
    });
    const elapsed = performance.now() - start;
    console.log(`  ${label.padEnd(45)} -> ${elapsed.toFixed(1)} ms, ${res.rowCount} msisdns`);
    return elapsed;
  }

  console.log('\n-- subscribers table (SIM, 16 partitions) --');
  await benchSubscribersAny(3);
  await benchSubscribersAny(100);
  await benchSubscribersAny(1000);
  await benchSubscribersAny(5000);
  await benchSubscribersAny(10000);

  console.log('\n-- subscriber_dump table (100M?) --');
  await benchDumpAny(3);
  await benchDumpAny(100);
  await benchDumpAny(1000);
  await benchDumpAny(5000);
  await benchDumpAny(10000);

  // Also check: subscribers cell_id JOIN via VALUES (simulates target_cells JOIN shape)
  async function benchJoinShape(count: number) {
    if (cells.length < count) return;
    const subset = cells.slice(0, count);
    // Build a VALUES clause as in "join target_cells"
    const valuesSql = subset.map((_, i) => `($${i + 1}::text)`).join(',');
    const label = `subscribers: ${count} cells JOIN (VALUES ...) shape`;
    const start = performance.now();
    const res = await pool.query({
      text: `SELECT DISTINCT s.msisdn
             FROM subscribers s
             JOIN (VALUES ${valuesSql}) AS t(cell_id) ON t.cell_id = s.cell_id
             LIMIT 100000`,
      values: subset,
    });
    const elapsed = performance.now() - start;
    console.log(`  ${label.padEnd(45)} -> ${elapsed.toFixed(1)} ms, ${res.rowCount} msisdns`);
    return elapsed;
  }

  console.log('\n-- subscribers JOIN VALUES shape (simulates target_cells JOIN) --');
  await benchJoinShape(3);
  await benchJoinShape(100);

  // ============================================================
  // 10. EXPLAIN (ANALYZE, BUFFERS)
  // ============================================================
  await section('10. EXPLAIN (ANALYZE, BUFFERS)');

  const cell3 = cells.slice(0, 3);
  const cell100 = cells.slice(0, 100);

  console.log('\n--- subscribers: 3 cells (cell_id = ANY) ---');
  const exp3 = await pool.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cell3],
  });
  console.log(exp3.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n--- subscribers: 100 cells (cell_id = ANY) ---');
  const exp100 = await pool.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscribers WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cell100],
  });
  console.log(exp100.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n--- subscriber_dump: 3 cells (cell_id = ANY) ---');
  const expD3 = await pool.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscriber_dump WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cell3],
  }).catch((e: Error) => console.log('ERROR:', e.message));
  if (expD3 && expD3.rows) console.log(expD3.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n--- subscriber_dump: 100 cells (cell_id = ANY) ---');
  const expD100 = await pool.query({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
           SELECT DISTINCT msisdn FROM subscriber_dump WHERE cell_id = ANY($1::text[]) LIMIT 100000`,
    values: [cell100],
  }).catch((e: Error) => console.log('ERROR:', e.message));
  if (expD100 && expD100.rows) console.log(expD100.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  // JOIN shape explain
  if (cell100.length >= 100) {
    const valuesSql = cell100.map((_, i) => `($${i + 1}::text)`).join(',');
    console.log('\n--- subscribers: 100 cells JOIN VALUES shape ---');
    const expJ100 = await pool.query({
      text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
             SELECT DISTINCT s.msisdn
             FROM subscribers s
             JOIN (VALUES ${valuesSql}) AS t(cell_id) ON t.cell_id = s.cell_id
             LIMIT 100000`,
      values: cell100,
    });
    console.log(expJ100.rows.map((r: any) => r['QUERY PLAN']).join('\n'));
  }

  // ============================================================
  // EXTRA: Check if there's a composite (cell_id, msisdn) index opportunity
  // by seeing the DISTINCT cost
  // ============================================================
  await section('EXTRA: INDEX / STATS INSIGHTS');

  await runQuery(
    pool,
    'Statistics: approximate n_distinct for cell_id (subscribers)',
    `SELECT attname, n_distinct, correlation, most_common_vals::text, most_common_freqs::text, histogram_bounds::text
     FROM pg_stats
     WHERE schemaname='public' AND tablename='subscribers' AND attname IN ('cell_id','msisdn','imsi')`,
  );

  await runQuery(
    pool,
    'Statistics: approximate n_distinct for cell_id (subscriber_dump)',
    `SELECT attname, n_distinct, correlation, most_common_vals::text, most_common_freqs::text
     FROM pg_stats
     WHERE schemaname='public' AND tablename='subscriber_dump' AND attname IN ('cell_id','msisdn')`,
  );

  await closePool();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Diagnostic failed:', e);
  process.exit(1);
});
