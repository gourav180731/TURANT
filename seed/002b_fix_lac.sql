-- SEED 002b: fix lac/cisac to strict 4-hex (009 CHECK compliance)
UPDATE seed_cell_plan SET
  lac = lpad(
          to_hex(
            (1024 + (
              abs(
                (('x' || substr(md5('lac' || cell_id || op), 1, 8))::bit(32)::int)
              ) % 1024
            ))::int
          ),
          4, '0'),
  cisac = lpad(
            to_hex(
              ((
                abs(
                  (('x' || substr(md5('cis' || cell_id || op), 1, 8))::bit(32)::int)
                )
              ) % 65536)::int
            ),
            4, '0');
SELECT COUNT(*) AS bad_lac FROM seed_cell_plan WHERE lac !~ '^[0-9A-Fa-f]{4}$';
SELECT COUNT(*) AS bad_cis FROM seed_cell_plan WHERE cisac !~ '^[0-9A-Fa-f]{4}$';
SELECT lac, cisac FROM seed_cell_plan LIMIT 3;
