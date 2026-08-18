-- =====================================================================
-- docs/sql/09_v_geometry_check.sql
-- Evidence: expansion entry points are real POINT geometries inside Delhi.
-- Measured 2026-08-13: 0 non-POINT / non-Delhi rows.
-- Use while a query window over the unindexed 100M geom is acceptable, or
-- with a WHERE clock filter; GiST idx_subscriber_dump_geom accelerates it.
-- =====================================================================
SELECT COUNT(*) AS bad_geometries
FROM subscriber_dump
WHERE data_source = 'synthetic_delhi_expansion_v1'
  AND (geom IS NULL
       OR GeometryType(geom) <> 'POINT'
       OR NOT ST_Within(geom::geometry,
                        ST_MakeEnvelope(76.5, 28.2, 77.5, 29.0, 4326)::geometry));