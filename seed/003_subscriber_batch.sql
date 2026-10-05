-- =====================================================================
-- SEED 003: subscriber batch insert — REGENERATED EQUIVALENT (v1)
-- =====================================================================
-- CLASSIFICATION: REGENERATED EQUIVALENT DATA — NOT original rows.
-- Inserts ONE batch (:BATCH, 500 cells, ~1.36M rows) into subscriber_dump.
-- Run: psql -v BATCH=<n> -f seed/003_subscriber_batch.sql  (74 batches: 0-73)
-- Idempotent per batch: deletes this batch's prior rows first, stamps a
-- fresh generation_batch_id, records seed_checkpoints.
-- Satisfies migration 009 CHECKs (imsi/msisdn/lac/cisac/tech/op/lat/lng).
-- FK fk_subdump_serving_cell is NOT VALID during load; VALIDATE at the end.
-- \timing recommended to measure throughput for the Stage-A estimate.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- bulk-load session tuning (batches are idempotent + re-runnable, so the
-- relaxed durability is safe; each batch is a single atomic statement)
SET synchronous_commit = off;
SET client_min_messages = warning;

-- idempotency: remove a previous partial attempt of this batch
DELETE FROM public.subscriber_dump
WHERE data_source = 'synthetic_delhi_expansion_v1'
  AND serving_cell_id IN (SELECT cell_id FROM seed_cell_plan WHERE batch_id = :BATCH);

INSERT INTO seed_checkpoints (batch_id, batch_uuid, rows_added)
VALUES (:BATCH, gen_random_uuid(), 0)
ON CONFLICT (batch_id) DO UPDATE SET started_at = now(), done_at = NULL;

INSERT INTO public.subscriber_dump (
  imsi, msisdn, lac, cisac, technology, lact_date, last_time,
  city, state, latitude, longitude, operator, district,
  serving_cell_id, data_source, generation_batch_id, generation_timestamp
)
SELECT
  p.mcc || p.mnc || lpad(((seq - 1) % 10000000000)::text, 10, '0') AS imsi,
  '91' || ((6 + (seq % 4))::text) || lpad(seq::text, 9, '0')        AS msisdn,
  p.lac,
  p.cisac,
  CASE WHEN h_tech < 68 THEN '5G' WHEN h_tech < 93 THEN '4G' ELSE 'UMTS' END AS technology,
  to_char(clock_timestamp(), 'MM-DD')                              AS lact_date,
  lpad((h_time % 24)::text, 2, '0') || ':' || lpad((h_time % 60)::text, 2, '0') AS last_time,
  p.city,
  'Delhi'                                                          AS state,
  to_char(p.base_lat + ((h_jit % 1000) - 500) / 1000000.0, 'FM99.000000') AS latitude,
  to_char(p.base_lng + ((h_jit2 % 1000) - 500) / 1000000.0, 'FM999.000000') AS longitude,
  p.op                                                             AS operator,
  p.district,
  p.cell_id                                                        AS serving_cell_id,
  'synthetic_delhi_expansion_v1'                                   AS data_source,
  (SELECT batch_uuid FROM seed_checkpoints WHERE batch_id = :BATCH) AS generation_batch_id,
  clock_timestamp()                                                AS generation_timestamp
FROM seed_cell_plan p
CROSS JOIN LATERAL generate_series(1, p.n_rows) AS i
CROSS JOIN LATERAL (SELECT p.start_seq + i - 1 AS seq) s
CROSS JOIN LATERAL (
  SELECT
    abs(((('x' || substr(md5('t' || seq::text), 1, 8)))::bit(32)::int) % 100) AS h_tech,
    abs(((('x' || substr(md5('tm' || seq::text), 1, 8)))::bit(32)::int))      AS h_time,
    abs(((('x' || substr(md5('j1' || seq::text), 1, 8)))::bit(32)::int))      AS h_jit,
    abs(((('x' || substr(md5('j2' || seq::text), 1, 8)))::bit(32)::int))      AS h_jit2
) h
WHERE p.batch_id = :BATCH;

-- checkpoint: rows_added comes from the deterministic plan (the INSERT above
-- is one atomic statement, so inserted == planned on success; global
-- reconciliation runs at the end via docs/sql/02 breakdown)
UPDATE seed_checkpoints sc SET
  rows_added = (SELECT SUM(n_rows)::bigint FROM seed_cell_plan WHERE batch_id = :BATCH),
  done_at = now()
WHERE sc.batch_id = :BATCH;

SELECT batch_id, rows_added, done_at FROM seed_checkpoints WHERE batch_id = :BATCH;
