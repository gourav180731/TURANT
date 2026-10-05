-- =====================================================================
-- SEED 004a: drop bulk-load-blocking indexes (rebuild in 004b at the end)
-- =====================================================================
-- Bulk-load practice: maintain ONLY correctness guardrails during the
-- 100M insert (PK, CHECKs, FK), rebuild reporting/matcher indexes after.
-- Dropped here (all migration-owned, all rebuilt in 004b — nothing added):
--   008: idx_subscriber_dump_serving_cell, _state, _operator, _technology,
--        _state_operator
--   009: uq_subdump_imsi, uq_subdump_msisdn  (uniqueness is guaranteed by
--        the global-seq construction AND re-proven by the UNIQUE rebuild)
-- =====================================================================
DROP INDEX IF EXISTS public.idx_subscriber_dump_serving_cell;
DROP INDEX IF EXISTS public.idx_subscriber_dump_state;
DROP INDEX IF EXISTS public.idx_subscriber_dump_operator;
DROP INDEX IF EXISTS public.idx_subscriber_dump_technology;
DROP INDEX IF EXISTS public.idx_subscriber_dump_state_operator;
ALTER TABLE public.subscriber_dump DROP CONSTRAINT IF EXISTS uq_subdump_imsi;
ALTER TABLE public.subscriber_dump DROP CONSTRAINT IF EXISTS uq_subdump_msisdn;
