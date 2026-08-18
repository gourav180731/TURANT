#!/usr/bin/env tsx
/**
 * Build ONLY cell_postings from the already-populated subscriber_cell_index
 * (GROUP BY on ~4.1 GB narrow table instead of 37 GB dump re-scan).
 * cell_subscriber_stats already verified: 29,727 rows, SUM=97,457,009.
 */
import { loadConfig } from '../src/config/env.js';
import { getPool } from '../src/persistence/pg-pool.js';

const idxTable = 'subscriber_cell_index';
const postTable = 'cell_postings';
const statsTable = 'cell_subscriber_stats';

async function main(): Promise<void> {
  loadConfig();
  const pool = getPool();
  const t0 = Date.now();
  try {
    const src = await pool.query(`SELECT COUNT(*) c FROM ${idxTable}`);
    console.log(
      '[%s] source idx=%s rows=%s size_idx=%s MB size_pk=%s MB size_stats=%s MB',
      new Date().toISOString(),
      idxTable,
      src.rows[0].c,
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${idxTable}') s`)).rows[0].s) / 1024 / 1024),
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${idxTable}_pkey') s`)).rows[0].s) / 1024 / 1024),
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${statsTable}') s`)).rows[0].s) / 1024 / 1024),
    );

    console.log('[%s] start: truncate+insert postings (from idx GROUP BY)', new Date().toISOString());
    const t1 = Date.now();
    await pool.query(`TRUNCATE ${postTable}`);
    await pool.query(`
      INSERT INTO ${postTable} (cell_id, subscriber_ids)
      SELECT serving_cell_id, array_agg(subscriber_id ORDER BY subscriber_id)
      FROM ${idxTable}
      GROUP BY serving_cell_id
    `);
    const t2 = Date.now();
    const pc = await pool.query(`SELECT COUNT(*) c, COALESCE(SUM(array_length(subscriber_ids,1)),0) total_subs FROM ${postTable}`);
    console.log(
      '[%s] done: postings count=%s total_subs_in_arrays=%s elapsed=%s ms (build time=%s s)',
      new Date().toISOString(),
      pc.rows[0].c, pc.rows[0].total_subs,
      t2 - t1, Math.round((t2 - t1) / 1000),
    );

    console.log('[%s] start: ANALYZE all three tables', new Date().toISOString());
    const t3 = Date.now();
    await pool.query(`ANALYZE ${idxTable}`);
    await pool.query(`ANALYZE ${statsTable}`);
    await pool.query(`ANALYZE ${postTable}`);
    console.log('[%s] done: ANALYZE elapsed=%s ms', new Date().toISOString(), Date.now() - t3);

    console.log(
      '\n=== FINAL SIZES ===\n  idx     = %s MB\n  idx_pk  = %s MB\n  stats   = %s MB\n  posts   = %s MB\n  TOTAL   = %s MB',
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${idxTable}') s`)).rows[0].s) / 1048576),
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${idxTable}_pkey') s`)).rows[0].s) / 1048576),
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${statsTable}') s`)).rows[0].s) / 1048576),
      Math.round(Number((await pool.query(`SELECT pg_relation_size('${postTable}') s`)).rows[0].s) / 1048576),
      Math.round(
        (
          Number((await pool.query(`SELECT pg_relation_size('${idxTable}') s`)).rows[0].s) +
          Number((await pool.query(`SELECT pg_relation_size('${idxTable}_pkey') s`)).rows[0].s) +
          Number((await pool.query(`SELECT pg_relation_size('${statsTable}') s`)).rows[0].s) +
          Number((await pool.query(`SELECT pg_relation_size('${postTable}') s`)).rows[0].s)
        ) / 1048576,
      ),
    );
    console.log('\n=== FINAL COUNTS ===');
    const s1 = await pool.query(`SELECT COUNT(*) c FROM ${idxTable}`);
    const s2 = await pool.query(`SELECT COUNT(*) cells, SUM(subscriber_count) total_rows, SUM(unique_subscriber_count) total_unique FROM ${statsTable}`);
    const s3 = await pool.query(`SELECT COUNT(*) cells, COALESCE(SUM(array_length(subscriber_ids,1)),0) total_subs FROM ${postTable}`);
    console.log('  idx rows               = %s', s1.rows[0].c);
    console.log('  stats cells            = %s', s2.rows[0].cells);
    console.log('  stats sum(sub_count)   = %s', s2.rows[0].total_rows);
    console.log('  stats sum(unique_sub)  = %s', s2.rows[0].total_unique);
    console.log('  posts cells            = %s', s3.rows[0].cells);
    console.log('  posts sum(arr_len)     = %s', s3.rows[0].total_subs);
    console.log('  TOTAL ELAPSED          = %s s', Math.round((Date.now() - t0) / 1000));
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
