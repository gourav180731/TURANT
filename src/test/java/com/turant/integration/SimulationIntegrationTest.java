package com.turant.integration;

import com.turant.cellsite.TowerSource;
import com.turant.simulation.SimulatedSmppClient;
import com.turant.simulation.SimulatedSubscriberMatcher;
import com.turant.simulation.SimulatedTowerSource;
import com.turant.simulation.TestDataFixtures;
import com.turant.types.sms.SmsMessage;
import com.turant.types.sms.SubmissionResult;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Integration tests for simulation layer.
 * 
 * Tests the complete simulated infrastructure:
 * - Tower generation
 * - Subscriber matching
 * - SMPP submission
 * 
 * Runs without requiring real PostGIS, subscriber database, or SMSC.
 */
@SpringBootTest
@ActiveProfiles("test")
class SimulationIntegrationTest {
    
    @Autowired(required = false)
    private SimulatedTowerSource towerSource;
    
    @Autowired(required = false)
    private SimulatedSubscriberMatcher subscriberMatcher;
    
    @Autowired(required = false)
    private SimulatedSmppClient smppClient;
    
    @Test
    void testSimulatedComponentsAreAvailable() {
        assertNotNull(towerSource, "SimulatedTowerSource should be available in test profile");
        assertNotNull(subscriberMatcher, "SimulatedSubscriberMatcher should be available");
        assertNotNull(smppClient, "SimulatedSmppClient should be available");
    }
    
    @Test
    void testSimulatedTowerGeneration() throws Exception {
        // Given: A geographic zone (Delhi)
        GeoZone zone = TestDataFixtures.createDelhiZone();
        
        // When: Finding towers in the zone
        TowerSource.FindTowersOptions options = new TowerSource.FindTowersOptions()
            .setTraceKey("test-tower-gen")
            .setTimeoutMs(5000L);
        
        CompletableFuture<List<CellTower>> future = towerSource.findTowersInZone(zone, options);
        List<CellTower> towers = future.get();
        
        // Then: Should generate towers
        assertNotNull(towers);
        assertFalse(towers.isEmpty(), "Should generate at least one tower");
        assertTrue(towers.size() >= 5, "Should generate at least 5 towers");
        assertTrue(towers.size() <= 50, "Should not exceed 50 towers");
        
        // Verify tower properties
        CellTower firstTower = towers.get(0);
        assertNotNull(firstTower.cellId());
        assertTrue(firstTower.cellId().matches("\\d{3}-\\d{2}-\\d{4}-\\d{4}"), 
            "Cell ID should match Indian format");
        assertNotNull(firstTower.latitude());
        assertNotNull(firstTower.longitude());
    }
    
    @Test
    void testSimulatedSubscriberMatching() throws Exception {
        // Given: Sample towers
        List<CellTower> towers = TestDataFixtures.createDelhiTowers();
        
        // When: Matching subscribers
        var context = new com.turant.subscriber.SubscriberMatcher.MatchContext("test-alert-001", "earthquake-delhi-001");
        CompletableFuture<List<com.turant.subscriber.SubscriberMatcher.SubscriberMatch>> future = 
            subscriberMatcher.matchSubscribers(towers, context);
        
        var results = future.get();
        
        // Then: Should generate subscriber matches
        assertNotNull(results);
        assertEquals(towers.size(), results.size(), 
            "Should have one result per tower");
        
        // Verify each result
        for (var result : results) {
            assertNotNull(result.towerId());
            assertNotNull(result.msisdns());
            assertFalse(result.msisdns().isEmpty(), 
                "Each tower should have subscribers");
            assertTrue(result.msisdns().size() >= 50, 
                "Should have at least 50 subscribers per tower");
            assertTrue(result.msisdns().size() <= 500, 
                "Should not exceed 500 subscribers per tower");
            
            // Verify MSISDN format (Indian mobile numbers)
            String firstMsisdn = result.msisdns().get(0);
            assertTrue(firstMsisdn.startsWith("+91"), 
                "MSISDNs should be Indian numbers");
            assertEquals(13, firstMsisdn.length(), 
                "Indian MSISDNs should be 13 characters (+91XXXXXXXXXX)");
        }
    }
    
    @Test
    void testSimulatedSmppSubmission() throws Exception {
        // Given: Sample SMS messages
        List<SmsMessage> messages = List.of(
            TestDataFixtures.createSampleSmsMessage("+919000000001", "Test earthquake alert"),
            TestDataFixtures.createSampleSmsMessage("+919000000002", "Test flood warning")
        );
        
        // When: Submitting via simulated SMPP
        assertTrue(smppClient.isConfigured(), "Simulated SMPP should always be configured");
        
        CompletableFuture<Void> connectFuture = smppClient.connect();
        connectFuture.get();
        
        CompletableFuture<List<SubmissionResult>> submitFuture = 
            smppClient.submitBatch(messages, "test-submission");
        List<SubmissionResult> results = submitFuture.get();
        
        // Then: Should return submission results
        assertNotNull(results);
        assertEquals(messages.size(), results.size());
        
        // Verify results
        for (SubmissionResult result : results) {
            assertNotNull(result.messageId());
            assertNotNull(result.msisdn());
            assertNotNull(result.outcome());
            
            // Most should be accepted (95% success rate)
            // At least verify one is accepted
        }
        
        long acceptedCount = results.stream()
            .filter(r -> r.outcome().name().equals("accepted"))
            .count();
        
        assertTrue(acceptedCount > 0, "At least some messages should be accepted");
        
        // Cleanup
        smppClient.close();
    }
    
    @Test
    void testEndToEndSimulatedPipeline() throws Exception {
        // Given: Complete simulation infrastructure
        
        // 1. Tower matching
        GeoZone zone = TestDataFixtures.createDelhiZone();
        var towerOptions = new TowerSource.FindTowersOptions()
            .setTraceKey("e2e-test")
            .setTimeoutMs(5000L);
        
        List<CellTower> towers = towerSource.findTowersInZone(zone, towerOptions).get();
        assertFalse(towers.isEmpty());
        
        // 2. Subscriber matching
        var matchContext = new com.turant.subscriber.SubscriberMatcher.MatchContext("e2e-test-alert", "e2e-test-cap");
        var subscriberResults = subscriberMatcher.matchSubscribers(towers, matchContext).get();
        assertFalse(subscriberResults.isEmpty());
        
        // 3. Collect all MSISDNs
        List<String> allMsisdns = subscriberResults.stream()
            .flatMap(r -> r.msisdns().stream())
            .distinct()
            .limit(10) // Just test with 10 for speed
            .toList();
        
        assertFalse(allMsisdns.isEmpty());
        
        // 4. Create SMS messages
        List<SmsMessage> messages = allMsisdns.stream()
            .map(msisdn -> TestDataFixtures.createSampleSmsMessage(
                msisdn, 
                "Earthquake alert: Magnitude 5.2 detected in Delhi. Take shelter."
            ))
            .toList();
        
        // 5. Submit via SMPP
        smppClient.connect().get();
        List<SubmissionResult> results = smppClient.submitBatch(messages, "e2e-test").get();
        
        assertEquals(messages.size(), results.size());
        
        long accepted = results.stream()
            .filter(r -> r.outcome().name().equals("accepted"))
            .count();
        
        assertTrue(accepted > 0, "Pipeline should successfully submit messages");
        
        smppClient.close();
    }
}
