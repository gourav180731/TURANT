SET work_mem = '1GB';
\timing on
-- Q1: single 500-cell chunk (app's unit of work; x16 parallel in prod path)
SELECT COUNT(*) AS c, COUNT(DISTINCT msisdn) AS d FROM subscriber_dump
WHERE serving_cell_id IN (SELECT cell_id FROM sim_cell_towers ORDER BY cell_id LIMIT 500);
-- Q2: full 50k COUNT(*) (no distinct)
SELECT COUNT(*) AS c50k FROM subscriber_dump
WHERE serving_cell_id IN (SELECT cell_id FROM sim_cell_towers ORDER BY cell_id LIMIT 50000);
