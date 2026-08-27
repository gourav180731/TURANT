package com.turant.simulation;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * City-cluster hints for the frontend map.
 * Endpoint: GET /api/v1/sim/clusters
 *
 * NOT hardcoded. The clusters are computed at request time from the real
 * {@code cell_towers} table: every tower carries a city/state/clusterKey in
 * its properties JSON. Towers are grouped by (city, state) and each cluster is
 * the weighted centroid of the real tower positions (AVG of latitude/
 * longitude), with the tower count as weight and the bounding-box half-span
 * (converted to km) as radiusKm. Empty when the database is unavailable.
 */
@RestController
@RequestMapping("/api/v1/sim")
public class SimulationController {

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    /**
     * GET /api/v1/sim/clusters
     *
     * Response: {
     *   region: string,
     *   count: number,
     *   clusters: Array<{
     *     id, name, region, latitude, longitude, radiusKm, weight
     *   }>
     * }
     */
    @GetMapping(value = "/clusters", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getClusters() {
        List<Map<String, Object>> clusters = new ArrayList<>();
        
        if (jdbcTemplate != null) {
            jdbcTemplate.query(
                """
                WITH base AS (
                    SELECT properties->>'city'            AS city,
                           properties->>'state'           AS state,
                           properties->>'clusterKey'      AS cluster_key,
                           latitude,
                           longitude
                    FROM cell_towers
                    WHERE properties IS NOT NULL
                      AND properties ? 'city'
                ),
                agg AS (
                    SELECT city,
                           state,
                           MIN(cluster_key)                                  AS cluster_key,
                           COUNT(*)                                          AS weight,
                           AVG(latitude)                                     AS lat,
                           AVG(longitude)                                    AS lng,
                           (MAX(latitude) - MIN(latitude)) / 2.0 / 111.32    AS lat_span_km,
                           (MAX(longitude) - MIN(longitude)) / 2.0 / 111.32  AS lng_span_km
                    FROM base
                    GROUP BY city, state
                )
                SELECT city, state, cluster_key, weight, lat, lng,
                       GREATEST(COALESCE(lat_span_km, 0), COALESCE(lng_span_km, 0)) AS radius_km
                FROM agg
                WHERE lat IS NOT NULL AND lng IS NOT NULL
                ORDER BY weight DESC
                """,
                rs -> {
                    String city = rs.getString("city");
                    String state = rs.getString("state");
                    String clusterKey = rs.getString("cluster_key");
                    double lat = rs.getDouble("lat");
                    double lng = rs.getDouble("lng");
                    long weight = rs.getLong("weight");
                    double radiusKm = rs.getDouble("radius_km");

                    String id = clusterKey != null ? clusterKey
                            : city.toLowerCase().replaceAll("\\s+", "-");

                    clusters.add(Map.of(
                        "id", id,
                        "name", city,
                        "region", state != null ? state : "India",
                        "latitude", lat,
                        "longitude", lng,
                        "radiusKm", radiusKm,
                        "weight", weight
                    ));
                }
            );
        }
        
        return ResponseEntity.ok(Map.of(
            "region", "India",
            "count", clusters.size(),
            "clusters", clusters
        ));
    }
}