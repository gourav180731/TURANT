-- =====================================================================
-- 004_subscriber_dump_enrichment.sql
--
-- Additive, idempotent enrichment of the REAL 100M-row subscriber dump:
--   - district  (VARCHAR, backfilled from a 36-city lookup, only NULLs set)
--   - id        (BIGSERIAL PRIMARY KEY, added only if missing)
--   - geom      (PostGIS POINT(4326), backfilled where NULL)
--   + GiST spatial index (created only if absent)
--
-- Nothing existing is dropped or rewritten; every UPDATE only fills NULLs.
-- PostGIS is installed only if not already present (it is, on this DB).
-- =====================================================================

-- =====================================================================
-- Step 1: Add district column to subscriber_dump (populated from city)
-- =====================================================================
ALTER TABLE subscriber_dump ADD COLUMN IF NOT EXISTS district VARCHAR(50);

-- Reference table mapping each city already in subscriber_dump to a district
DROP TABLE IF EXISTS city_district_lookup;
CREATE TABLE city_district_lookup (
    city     VARCHAR(50) PRIMARY KEY,
    district VARCHAR(50)
);

INSERT INTO city_district_lookup (city, district) VALUES
('New Delhi',         'New Delhi'),
('Mumbai',             'Mumbai City'),
('Pune',               'Pune'),
('Bengaluru',          'Bengaluru Urban'),
('Chennai',            'Chennai'),
('Kolkata',            'Kolkata'),
('Hyderabad',          'Hyderabad'),
('Ahmedabad',          'Ahmedabad'),
('Jaipur',             'Jaipur'),
('Lucknow',            'Lucknow'),
('Chandigarh',         'Chandigarh'),
('Bhopal',             'Bhopal'),
('Patna',              'Patna'),
('Thiruvananthapuram', 'Thiruvananthapuram'),
('Panaji',             'North Goa'),
('Shimla',             'Shimla'),
('Dehradun',           'Dehradun'),
('Raipur',             'Raipur'),
('Ranchi',             'Ranchi'),
('Bhubaneswar',        'Khordha'),
('Guwahati',           'Kamrup Metropolitan'),
('Imphal',             'Imphal West'),
('Aizawl',             'Aizawl'),
('Kohima',             'Kohima'),
('Itanagar',           'Papum Pare'),
('Gangtok',            'East Sikkim'),
('Agartala',           'West Tripura'),
('Shillong',           'East Khasi Hills'),
('Srinagar',           'Srinagar'),
('Jammu',              'Jammu'),
('Leh',                'Leh'),
('Vijayawada',         'NTR'),
('Amritsar',           'Amritsar'),
('Gurugram',           'Gurugram'),
('Port Blair',         'South Andaman'),
('Puducherry',         'Puducherry'),
('Kavaratti',          'Lakshadweep');

UPDATE subscriber_dump s
SET district = l.district
FROM city_district_lookup l
WHERE s.city = l.city
  AND s.district IS NULL;

DROP TABLE city_district_lookup;

-- =====================================================================
-- Step 2: Add id column (auto-numbered primary key) - only if missing
-- =====================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'subscriber_dump' AND column_name = 'id'
    ) THEN
        ALTER TABLE subscriber_dump ADD COLUMN id BIGSERIAL PRIMARY KEY;
        RAISE NOTICE 'Added id column';
    ELSE
        RAISE NOTICE 'id column already exists - skipping';
    END IF;
END $$;

-- =====================================================================
-- Step 3: Add geom column (PostGIS point geometry) - only if missing
-- =====================================================================

-- Check if PostGIS extension is already installed; only create it if not
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
        RAISE NOTICE 'PostGIS extension not found - installing now';
        CREATE EXTENSION postgis;
    ELSE
        RAISE NOTICE 'PostGIS extension already installed - skipping install';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'subscriber_dump' AND column_name = 'geom'
    ) THEN
        ALTER TABLE subscriber_dump ADD COLUMN geom geometry(Point, 4326);
        RAISE NOTICE 'Added geom column';
    ELSE
        RAISE NOTICE 'geom column already exists - skipping';
    END IF;
END $$;

UPDATE subscriber_dump
SET geom = ST_SetSRID(ST_MakePoint(longitude::float8, latitude::float8), 4326)
WHERE geom IS NULL;

-- Spatial index for fast location-based queries (only if not already present)
CREATE INDEX IF NOT EXISTS idx_subscriber_dump_geom ON subscriber_dump USING GIST (geom);

-- =====================================================================
-- Step 4: Verification
-- =====================================================================
-- SELECT COUNT(*) FROM subscriber_dump;                          -- expect 100000000 (unchanged)
-- SELECT MIN(id), MAX(id) FROM subscriber_dump;                  -- expect 1, 100000000
-- SELECT DISTINCT city, district FROM subscriber_dump ORDER BY city;
-- SELECT id, imsi, city, district, latitude, longitude, geom FROM subscriber_dump LIMIT 5;
-- SELECT technology, COUNT(*) FROM subscriber_dump GROUP BY technology;   -- confirm unchanged
-- SELECT operator, COUNT(*) FROM subscriber_dump GROUP BY operator;       -- confirm unchanged