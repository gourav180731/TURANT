package com.turant.cap;

import com.turant.simulation.TestDataFixtures;
import com.turant.types.cap.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for CapParser (Module 01).
 * 
 * Tests:
 * - Valid CAP XML parsing
 * - Invalid XML handling
 * - Missing required fields
 * - Multiple areas and geometries
 */
class CapParserTest {
    
    private CapParser parser;
    
    @BeforeEach
    void setUp() {
        parser = new CapParser();
    }
    
    @Test
    void testParseValidEarthquakeAlert() throws Exception {
        // Given: Valid earthquake CAP XML
        String xml = TestDataFixtures.createEarthquakeCapXml();
        
        // When: Parsing
        CapAlert alert = parser.parseCapXml(xml, "en-IN");
        
        // Then: Should parse successfully
        assertNotNull(alert);
        assertEquals("earthquake-delhi-001", alert.identifier());
        assertEquals(CapMsgType.Alert, alert.msgType());
        assertEquals(CapStatus.Actual, alert.status());
        assertEquals(CapScope.Public, alert.scope());
        
        // Verify info block
        assertNotNull(alert.info());
        assertEquals("en-IN", alert.info().language());
        assertTrue(alert.info().category().contains("Geo"));
        assertEquals("Earthquake", alert.info().event());
        assertEquals(CapSeverity.Extreme, alert.info().severity());
        assertEquals(CapUrgency.Immediate, alert.info().urgency());
        assertEquals(CapCertainty.Observed, alert.info().certainty());
        
        // Verify areas
        assertNotNull(alert.info().areas());
        assertFalse(alert.info().areas().isEmpty());
    }
    
    @Test
    void testParseValidFloodAlert() throws Exception {
        // Given: Valid flood CAP XML
        String xml = TestDataFixtures.createFloodCapXml();
        
        // When: Parsing
        CapAlert alert = parser.parseCapXml(xml, "en-IN");
        
        // Then: Should parse successfully
        assertNotNull(alert);
        assertEquals("flood-mumbai-001", alert.identifier());
        assertTrue(alert.info().category().contains("Met"));
        assertEquals("Flood", alert.info().event());
        assertEquals(CapSeverity.Severe, alert.info().severity());
    }
    
    @Test
    void testParseInvalidXml() {
        // Given: Invalid XML
        String invalidXml = "<alert>not valid xml";
        
        // When/Then: Should throw CapParseException
        assertThrows(CapParseException.class, () -> {
            parser.parseCapXml(invalidXml, null);
        });
    }
    
    @Test
    void testParseEmptyXml() {
        // Given: Empty string
        String emptyXml = "";
        
        // When/Then: Should throw exception
        assertThrows(CapParseException.class, () -> {
            parser.parseCapXml(emptyXml, null);
        });
    }
    
    @Test
    void testParseNullXml() {
        // Given: Null input
        String nullXml = null;
        
        // When/Then: Should throw exception
        assertThrows(Exception.class, () -> {
            parser.parseCapXml(nullXml, null);
        });
    }
    
    @Test
    void testParseMissingRequiredField() {
        // Given: XML missing required 'identifier' field
        String incompleteXml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
                <sender>test@example.com</sender>
                <sent>2024-01-01T00:00:00Z</sent>
                <status>Actual</status>
                <msgType>Alert</msgType>
                <scope>Public</scope>
            </alert>
            """;
        
        // When/Then: Should throw exception for missing required field
        assertThrows(CapParseException.class, () -> {
            parser.parseCapXml(incompleteXml, null);
        });
    }
    
    @Test
    void testParseCircleGeometry() throws Exception {
        // Given: CAP with circle geometry
        String xml = TestDataFixtures.createEarthquakeCapXml();
        
        // When: Parsing
        CapAlert alert = parser.parseCapXml(xml, null);
        
        // Then: Should parse circle geometry
        assertNotNull(alert.info().areas());
        assertFalse(alert.info().areas().isEmpty());
        
        var area = alert.info().areas().get(0);
        assertNotNull(area.geometries());
        assertFalse(area.geometries().isEmpty());
        
        var geometry = area.geometries().get(0);
        assertEquals("Circle", geometry.getType());
    }
    
    @Test
    void testParseWithExpiry() throws Exception {
        // Given: CAP with expiry time
        String xml = TestDataFixtures.createEarthquakeCapXml();
        
        // When: Parsing
        CapAlert alert = parser.parseCapXml(xml, null);
        
        // Then: Should parse expiry as String
        assertNotNull(alert.info().expires());
        assertTrue(alert.info().expires().contains("T")); // ISO 8601 format
    }
    
    @Test
    void testParsePreservesAllFields() throws Exception {
        // Given: Complete CAP XML
        String xml = TestDataFixtures.createEarthquakeCapXml();
        
        // When: Parsing
        CapAlert alert = parser.parseCapXml(xml, null);
        
        // Then: All fields should be preserved
        assertNotNull(alert.identifier());
        assertNotNull(alert.msgType());
        assertNotNull(alert.status());
        assertNotNull(alert.scope());
        assertNotNull(alert.info());
        assertTrue(alert.info().category() != null && !alert.info().category().isEmpty());
        assertNotNull(alert.info().event());
        assertNotNull(alert.info().headline());
        assertNotNull(alert.info().description());
        assertNotNull(alert.info().instruction());
        assertNotNull(alert.info().urgency());
        assertNotNull(alert.info().severity());
        assertNotNull(alert.info().certainty());
        assertNotNull(alert.info().areas());
    }
}
