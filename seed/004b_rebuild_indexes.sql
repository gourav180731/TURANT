-- =====================================================================
-- SEED 004b: rebuild indexes dropped in 004a + validate + analyze
-- =====================================================================
-- Run AFTER all 74 batches are loaded. Rebuilds EXACTLY the migration-owned
-- indexes (008/009) — no new indexes. Then VALIDATEs the FK (008 phase-3
-- step), rebuilds derived aggregates (010 tables + turant_agg), ANALYZEs.
-- NOTE: CREATE UNIQUE INDEX will FAIL LOUDLY on any duplicate — that is the
-- uniqueness proof for imsi/msisdn.
-- =====================================================================
SET maintenance_work_mem = '1GB';
SET work_mem = '512MB';

-- 009 uniques (proof of 0 dup IMSI/MSISDN)
CREATE UNIQUE INDEX IF NOT EXISTS uq_subdump_imsi
  ON public.subscriber_dump(imsi);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subdump_msisdn
  ON public.subscriber_dump(msisdn);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name='subscriber_dump' AND constraint_name='ux_subscriber_dump_imsi') THEN
    ALTER TABLE public.subscriber_dump ADD CONSTRAINT ux_subscriber_dump_imsi UNIQUE USING INDEX uq_subdump_imsi;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name='subscriber_dump' AND constraint_name='ux_subscriber_dump_msisdn') THEN
    ALTER TABLE public.subscriber_dump ADD CONSTRAINT ux_subscriber_dump_msisdn UNIQUE USING INDEX uq_subdump_msisdn;
  END IF;
END $$;

-- 008 matcher/reporting indexes
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_serving_cell
  ON public.subscriber_dump(serving_cell_id);
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_state
  ON public.subscriber_dump(state);
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_operator
  ON public.subscriber_dump(operator);
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_technology
  ON public.subscriber_dump(technology);
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_state_operator
  ON public.subscriber_dump(state, operator);

-- 008 phase-3: validate FK (scans, no exclusive lock)
ALTER TABLE public.subscriber_dump VALIDATE CONSTRAINT fk_subdump_serving_cell;

-- 010 derived access path: rebuild FROM the dump (never invented)
TRUNCATE public.subscriber_cell_index;
INSERT INTO public.subscriber_cell_index (serving_cell_id, subscriber_id)
  SELECT serving_cell_id, id FROM public.subscriber_dump
  WHERE serving_cell_id IS NOT NULL;
TRUNCATE public.cell_subscriber_stats;
INSERT INTO public.cell_subscriber_stats (cell_id, subscriber_count, unique_subscriber_count)
  SELECT serving_cell_id, COUNT(*), COUNT(DISTINCT msisdn)
  FROM public.subscriber_dump
  WHERE serving_cell_id IS NOT NULL
  GROUP BY serving_cell_id;
TRUNCATE public.cell_postings;
INSERT INTO public.cell_postings (cell_id, subscriber_ids)
  SELECT serving_cell_id, array_agg(id)
  FROM public.subscriber_dump
  WHERE serving_cell_id IS NOT NULL
  GROUP BY serving_cell_id;

-- turant_agg PRIMARY O(cells) path (code comment: built as
-- (serving_cell_id, sub_count, distinct_count) FROM subscriber_dump)
TRUNCATE turant_agg.cell_subscriber_agg;
INSERT INTO turant_agg.cell_subscriber_agg (serving_cell_id, sub_count, distinct_count)
  SELECT serving_cell_id, COUNT(*), COUNT(DISTINCT msisdn)
  FROM public.subscriber_dump
  WHERE serving_cell_id IS NOT NULL
  GROUP BY serving_cell_id;

ANALYZE public.subscriber_dump;
ANALYZE public.subscriber_cell_index;
ANALYZE public.cell_subscriber_stats;
ANALYZE public.cell_postings;
ANALYZE turant_agg.cell_subscriber_agg;
ANALYZE public.sim_cell_towers;
