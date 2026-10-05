-- =====================================================================
-- TURANT 015: RECONSTRUCTED compat view (office-laptop rebuild)
-- =====================================================================
-- CLASSIFICATION: RECONSTRUCTED helper — NOT original DDL.
-- The legacy TelecomSubscriberMatcher path reads table `subscribers`
-- (PostgresSubscriberRepository: imsi, msisdn, serving_cell_id, tower_id,
-- technology, status, last_seen). The authoritative store is
-- subscriber_dump, so this VIEW exposes the dump in that shape with ZERO
-- data duplication. tower_id has no dump equivalent -> NULL; status has
-- no dump equivalent -> 'ACTIVE'; last_seen -> generation_timestamp.
-- Apply AFTER 008 (needs generation_timestamp). Idempotent.
-- =====================================================================

CREATE OR REPLACE VIEW public.subscribers AS
SELECT
  id,
  imsi,
  msisdn,
  serving_cell_id,
  NULL::text        AS tower_id,
  technology,
  'ACTIVE'::text    AS status,
  generation_timestamp AS last_seen,
  operator,
  state,
  district,
  city
FROM public.subscriber_dump;

COMMENT ON VIEW public.subscribers IS
  'RECONSTRUCTED compat view (015). Zero-copy projection of subscriber_dump for the legacy SubscriberRepository path.';
