package com.turant.simulation;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Simulation data REST controller for frontend.
 * Endpoint: GET /api/v1/sim/clusters
 * 
 * Provides city cluster hints for map visualization.
 */
@RestController
@RequestMapping("/api/v1/sim")
public class SimulationController {
    
    /**
     * GET /api/v1/sim/clusters
     * 
     * Get city clusters for frontend map visualization.
     * Returns simulated clusters around major Indian cities.
     * 
     * Response: {
     *   region: string,
     *   count: number,
     *   clusters: Array<{
     *     id: string,
     *     name: string,
     *     region: string,
     *     latitude: number,
     *     longitude: number,
     *     radiusKm: number,
     *     weight: number
     *   }>
     * }
     */
    @GetMapping(value = "/clusters", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getClusters() {
        // Simulated clusters around major Indian cities
        // These represent areas where the simulation has tower data
        List<Map<String, Object>> clusters = new ArrayList<>();
        
        // Delhi NCR - main simulation area
        clusters.add(Map.of(
            "id", "delhi-ncr",
            "name", "Delhi NCR",
            "region", "India",
            "latitude", 28.6139,
            "longitude", 77.2090,
            "radiusKm", 50,
            "weight", 1.0
        ));
        
        // Mumbai
        clusters.add(Map.of(
            "id", "mumbai",
            "name", "Mumbai",
            "region", "India",
            "latitude", 19.0760,
            "longitude", 72.8777,
            "radiusKm", 40,
            "weight", 0.9
        ));
        
        // Bangalore
        clusters.add(Map.of(
            "id", "bangalore",
            "name", "Bangalore",
            "region", "India",
            "latitude", 12.9716,
            "longitude", 77.5946,
            "radiusKm", 35,
            "weight", 0.8
        ));
        
        // Chennai
        clusters.add(Map.of(
            "id", "chennai",
            "name", "Chennai",
            "region", "India",
            "latitude", 13.0827,
            "longitude", 80.2707,
            "radiusKm", 30,
            "weight", 0.7
        ));
        
        // Kolkata
        clusters.add(Map.of(
            "id", "kolkata",
            "name", "Kolkata",
            "region", "India",
            "latitude", 22.5726,
            "longitude", 88.3639,
            "radiusKm", 30,
            "weight", 0.7
        ));
        
        // Hyderabad
        clusters.add(Map.of(
            "id", "hyderabad",
            "name", "Hyderabad",
            "region", "India",
            "latitude", 17.3850,
            "longitude", 78.4867,
            "radiusKm", 35,
            "weight", 0.7
        ));
        
        // Pune
        clusters.add(Map.of(
            "id", "pune",
            "name", "Pune",
            "region", "India",
            "latitude", 18.5204,
            "longitude", 73.8567,
            "radiusKm", 25,
            "weight", 0.6
        ));
        
        // Ahmedabad
        clusters.add(Map.of(
            "id", "ahmedabad",
            "name", "Ahmedabad",
            "region", "India",
            "latitude", 23.0225,
            "longitude", 72.5714,
            "radiusKm", 25,
            "weight", 0.6
        ));
        
        return ResponseEntity.ok(Map.of(
            "region", "India",
            "count", clusters.size(),
            "clusters", clusters
        ));
    }
}
