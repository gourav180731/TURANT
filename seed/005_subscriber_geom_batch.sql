-- =====================================================================
-- SEED 005: subscriber geom backfill, one batch per call (:BATCH)
-- =====================================================================
-- CLASSIFICATION: REGENERATED EQUIVALENT DATA completion.
-- Sets subscriber_dump.geom = Point(longitude, latitude) 4326 for all rows
-- of one load batch. Run for BATCH 0..73 AFTER all 003 batches complete.
-- Idempotent (WHERE geom IS NULL). Run: psql -v BATCH=<n> -f this file.
-- Envelope check (docs/sql/09): towers lie within 76.5,28.2,77.5,29.0 and
-- jitter is +/-0.0005 deg, so all points stay inside Delhi envelope.
-- =====================================================================
SET synchronous_commit = off;
SET client_min_messages = warning;

UPDATE public.subscriber_dump sd
SET geom = ST_SetSRID(ST_MakePoint(sd.longitude::float8, sd.latitude::float8), 4326)
WHERE sd.geom IS NULL
  AND sd.data_source = 'synthetic_delhi_expansion_v1'
  AND sd.serving_cell_id IN (SELECT cell_id FROM seed_cell_plan WHERE batch_id = :BATCH);

SELECT :BATCH AS batch_id,
       COUNT(*) FILTER (WHERE geom IS NOT NULL) AS with_geom,
       COUNT(*) FILTER (WHERE geom IS NULL) AS missing_geom
FROM public.subscriber_dump sd
WHERE sd.data_source = 'synthetic_delhi_expansion_v1'
  AND sd.serving_cell_id IN (SELECT cell_id FROM seed_cell_plan WHERE batch_id = :BATCH);
