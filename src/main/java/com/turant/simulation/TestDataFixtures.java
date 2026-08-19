package com.turant.simulation;

import com.turant.types.cap.*;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

/**
 * Test data fixtures for integration testing.
 * 
 * Provides realistic sample data for:
 * - CAP alerts (earthquake, flood, cyclone)
 * - Geographic zones (Delhi, Mumbai, Kolkata)
 * - Cell towers
 * - Subscribers
 * 
 * All data is deterministic and can be used across test suites.
 */
public class TestDataFixtures {
    
    // ========== CAP Alert Fixtures ==========
    
    /**
     * Sample CAP alert: Earthquake in Delhi.
     */
    public static CapAlert createEarthquakeAlert() {
        CapInfo info = createEarthquakeInfo();
        String sent = Instant.now().minus(2, ChronoUnit.MINUTES).toString();
        
        return new CapAlert(
            "earthquake-delhi-001",              // identifier
            "india.ews@gov.in",                  // sender
            sent,                                // sent
            CapStatus.Actual,                    // status (not ACTUAL)
            CapMsgType.Alert,                    // msgType (not ALERT)
            null,                                // source
            CapScope.Public,                     // scope (not PUBLIC)
            null,                                // restriction
            null,                                // addresses
            List.of(),                           // code
            null,                                // note
            null,                                // references
            null,                                // incidents
            List.of(info),                       // infos
            info,                                // info
            null                                 // rawXml
        );
    }
    
    /**
     * Sample CAP alert: Flood warning in Mumbai.
     */
    public static CapAlert createFloodAlert() {
        CapInfo info = createFloodInfo();
        String sent = Instant.now().minus(5, ChronoUnit.MINUTES).toString();
        
        return new CapAlert(
            "flood-mumbai-001",                  // identifier
            "india.ews@gov.in",                  // sender
            sent,                                // sent
            CapStatus.Actual,                    // status (not ACTUAL)
            CapMsgType.Alert,                    // msgType (not ALERT)
            null,                                // source
            CapScope.Public,                     // scope (not PUBLIC)
            null,                                // restriction
            null,                                // addresses
            List.of(),                           // code
            null,                                // note
            null,                                // references
            null,                                // incidents
            List.of(info),                       // infos
            info,                                // info
            null                                 // rawXml
        );
    }
    
    /**
     * Sample CAP alert: Cyclone warning for coastal area.
     */
    public static CapAlert createCycloneAlert() {
        CapInfo info = createCycloneInfo();
        String sent = Instant.now().minus(10, ChronoUnit.MINUTES).toString();
        
        return new CapAlert(
            "cyclone-coast-001",                 // identifier
            "india.ews@gov.in",                  // sender
            sent,                                // sent
            CapStatus.Actual,                    // status (not ACTUAL)
            CapMsgType.Alert,                    // msgType (not ALERT)
            null,                                // source
            CapScope.Public,                     // scope (not PUBLIC)
            null,                                // restriction
            null,                                // addresses
            List.of(),                           // code
            null,                                // note
            null,                                // references
            null,                                // incidents
            List.of(info),                       // infos
            info,                                // info
            null                                 // rawXml
        );
    }
    
    /**
     * Create earthquake info block.
     */
    private static CapInfo createEarthquakeInfo() {
        List<CapArea> areas = List.of(createDelhiArea());
        String expires = Instant.now().plus(2, ChronoUnit.HOURS).toString();
        
        return new CapInfo(
            "en-IN",                             // language
            List.of("Geo"),                      // category
            "Earthquake",                        // event
            List.of("Shelter"),                  // responseType
            CapUrgency.Immediate,                // urgency (not IMMEDIATE)
            CapSeverity.Extreme,                 // severity (not EXTREME)
            CapCertainty.Observed,               // certainty (not OBSERVED)
            null,                                // audience
            List.of(),                           // eventCode
            null,                                // effective
            null,                                // onset
            expires,                             // expires
            "National Disaster Management Authority", // senderName
            "Earthquake Alert",                  // headline
            "Moderate earthquake detected in Delhi region. Magnitude 5.2. No tsunami threat.", // description
            "Take shelter immediately. Stay away from windows.", // instruction
            "+91-11-26701728",                   // contact
            areas                                // areas
        );
    }
    
    /**
     * Create flood info block.
     */
    private static CapInfo createFloodInfo() {
        List<CapArea> areas = List.of(createMumbaiArea());
        String expires = Instant.now().plus(6, ChronoUnit.HOURS).toString();
        
        return new CapInfo(
            "en-IN",                             // language
            List.of("Met"),                      // category
            "Flood",                             // event
            List.of("Evacuate"),                 // responseType
            CapUrgency.Expected,                 // urgency (not EXPECTED)
            CapSeverity.Severe,                  // severity (not SEVERE)
            CapCertainty.Likely,                 // certainty (not LIKELY)
            null,                                // audience
            List.of(),                           // eventCode
            null,                                // effective
            null,                                // onset
            expires,                             // expires
            "India Meteorological Department",   // senderName
            "Flood Warning",                     // headline
            "Heavy rainfall warning. Low-lying areas may experience flooding. Avoid travel.", // description
            "Evacuate low-lying areas immediately.", // instruction
            "+91-22-22172323",                   // contact
            areas                                // areas
        );
    }
    
    /**
     * Create cyclone info block.
     */
    private static CapInfo createCycloneInfo() {
        List<CapArea> areas = List.of(createCoastalArea());
        String expires = Instant.now().plus(12, ChronoUnit.HOURS).toString();
        
        return new CapInfo(
            "en-IN",                             // language
            List.of("Met"),                      // category
            "Storm",                             // event
            List.of("Shelter"),                  // responseType
            CapUrgency.Expected,                 // urgency (not EXPECTED)
            CapSeverity.Extreme,                 // severity (not EXTREME)
            CapCertainty.Likely,                 // certainty (not LIKELY)
            null,                                // audience
            List.of(),                           // eventCode
            null,                                // effective
            null,                                // onset
            expires,                             // expires
            "India Meteorological Department",   // senderName
            "Cyclone Warning",                   // headline
            "Cyclone Biparjoy approaching. Wind speeds up to 120 km/h expected. Stay indoors.", // description
            "Stay indoors. Secure loose objects.", // instruction
            "+91-22-22172323",                   // contact
            areas                                // areas
        );
    }
    
    // ========== Geographic Area Fixtures ==========
    
    /**
     * Delhi metropolitan area (circle).
     */
    private static CapArea createDelhiArea() {
        CapCoordinate center = new CapCoordinate(28.6139, 77.2090); // lat, lng
        CapGeometry circleGeom = CapGeometry.circle(center, 15000.0);
        
        return new CapArea(
            "Delhi Metropolitan Area",           // areaDesc
            List.of(),                           // polygons
            List.of(),                           // circles (empty, using geometries)
            List.of(circleGeom),                 // geometries
            List.of()                            // geocodes
        );
    }
    
    /**
     * Mumbai metropolitan area (circle).
     */
    private static CapArea createMumbaiArea() {
        CapCoordinate center = new CapCoordinate(19.0760, 72.8777); // lat, lng
        CapGeometry circleGeom = CapGeometry.circle(center, 20000.0);
        
        return new CapArea(
            "Mumbai Metropolitan Area",          // areaDesc
            List.of(),                           // polygons
            List.of(),                           // circles (empty, using geometries)
            List.of(circleGeom),                 // geometries
            List.of()                            // geocodes
        );
    }
    
    /**
     * Coastal area (polygon).
     */
    private static CapArea createCoastalArea() {
        List<List<CapCoordinate>> polygonCoords = List.of(
            List.of(
                new CapCoordinate(18.0, 72.0),   // lat, lng
                new CapCoordinate(18.0, 73.0),
                new CapCoordinate(19.0, 73.0),
                new CapCoordinate(19.0, 72.0),
                new CapCoordinate(18.0, 72.0)    // Close the ring
            )
        );
        
        CapGeometry polygonGeom = CapGeometry.polygon(polygonCoords);
        
        return new CapArea(
            "Coastal Region",                    // areaDesc
            List.of(),                           // polygons (empty, using geometries)
            List.of(),                           // circles
            List.of(polygonGeom),                // geometries
            List.of()                            // geocodes
        );
    }
    
    // ========== GeoZone Fixtures ==========
    
    /**
     * Delhi zone for testing.
     */
    public static GeoZone createDelhiZone() {
        GeoZone.ZoneCenter center = new GeoZone.ZoneCenter(28.6139, 77.2090); // lat, lng
        GeoZone.ZoneGeometry geometry = new GeoZone.ZoneGeometry(
            "Circle",
            null,
            center,
            15000.0 // 15 km radius
        );
        
        return new GeoZone(List.of(geometry), 4326);
    }
    
    /**
     * Mumbai zone for testing.
     */
    public static GeoZone createMumbaiZone() {
        GeoZone.ZoneCenter center = new GeoZone.ZoneCenter(19.0760, 72.8777); // lat, lng
        GeoZone.ZoneGeometry geometry = new GeoZone.ZoneGeometry(
            "Circle",
            null,
            center,
            20000.0 // 20 km radius
        );
        
        return new GeoZone(List.of(geometry), 4326);
    }
    
    /**
     * Small zone for performance testing.
     */
    public static GeoZone createSmallZone() {
        GeoZone.ZoneCenter center = new GeoZone.ZoneCenter(28.5, 77.0); // lat, lng
        GeoZone.ZoneGeometry geometry = new GeoZone.ZoneGeometry(
            "Circle",
            null,
            center,
            5000.0 // 5 km radius (small)
        );
        
        return new GeoZone(List.of(geometry), 4326);
    }
    
    // ========== Cell Tower Fixtures ==========
    
    /**
     * Sample cell towers in Delhi.
     */
    public static List<CellTower> createDelhiTowers() {
        List<CellTower> towers = new ArrayList<>();
        
        towers.add(new CellTower(
            "tower-delhi-001",                   // id
            "404-45-1001-2001",                  // cellId
            28.6139,                             // latitude
            77.2090,                             // longitude
            500.0,                               // coverageRadiusM
            null                                 // coverageGeoJson
        ));
        
        towers.add(new CellTower(
            "tower-delhi-002",                   // id
            "404-45-1001-2002",                  // cellId
            28.6239,                             // latitude
            77.2190,                             // longitude
            500.0,                               // coverageRadiusM
            null                                 // coverageGeoJson
        ));
        
        towers.add(new CellTower(
            "tower-delhi-003",                   // id
            "404-45-1001-2003",                  // cellId
            28.6039,                             // latitude
            77.1990,                             // longitude
            500.0,                               // coverageRadiusM
            null                                 // coverageGeoJson
        ));
        
        return towers;
    }
    
    /**
     * Sample cell towers in Mumbai.
     */
    public static List<CellTower> createMumbaiTowers() {
        List<CellTower> towers = new ArrayList<>();
        
        towers.add(new CellTower(
            "tower-mumbai-001",                  // id
            "404-30-2001-3001",                  // cellId
            19.0760,                             // latitude
            72.8777,                             // longitude
            600.0,                               // coverageRadiusM
            null                                 // coverageGeoJson
        ));
        
        towers.add(new CellTower(
            "tower-mumbai-002",                  // id
            "404-30-2001-3002",                  // cellId
            19.0860,                             // latitude
            72.8877,                             // longitude
            600.0,                               // coverageRadiusM
            null                                 // coverageGeoJson
        ));
        
        return towers;
    }
    
    // ========== MSISDN Fixtures ==========
    
    /**
     * Sample Indian mobile numbers.
     */
    public static List<String> createSampleMsisdns(int count) {
        List<String> msisdns = new ArrayList<>();
        
        for (int i = 0; i < count; i++) {
            long number = 9000000000L + i;
            msisdns.add("+91" + number);
        }
        
        return msisdns;
    }
    
    /**
     * Sample MSISDNs with duplicates (for dedup testing).
     */
    public static List<String> createMsisdnsWithDuplicates() {
        List<String> msisdns = new ArrayList<>();
        
        msisdns.add("+919000000001");
        msisdns.add("+919000000002");
        msisdns.add("+919000000001"); // Duplicate
        msisdns.add("+919000000003");
        msisdns.add("+919000000002"); // Duplicate
        msisdns.add("+919000000004");
        
        return msisdns;
    }
    
    // ========== SMS Message Fixtures ==========
    
    /**
     * Create a sample SMS message for testing.
     */
    public static com.turant.types.sms.SmsMessage createSampleSmsMessage(
            String msisdn, 
            String content) {
        
        return new com.turant.types.sms.SmsMessage(
            java.util.UUID.randomUUID().toString(), // messageId
            "test-alert-001",                       // alertId
            msisdn,                                 // msisdn
            content,                                // content
            com.turant.types.sms.SmsDataCoding.SEVEN_BIT, // dataCoding
            java.time.Instant.now().plus(2, ChronoUnit.HOURS), // validityPeriod
            (byte) 1,                               // priorityFlag (high priority)
            1                                       // registeredDelivery (request DLR)
        );
    }
    
    // ========== CAP XML Fixtures ==========
    
    /**
     * Sample CAP XML for earthquake alert.
     */
    public static String createEarthquakeCapXml() {
        Instant sent = Instant.now().minus(2, ChronoUnit.MINUTES);
        Instant expires = Instant.now().plus(2, ChronoUnit.HOURS);
        
        return String.format("""
            <?xml version="1.0" encoding="UTF-8"?>
            <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
                <identifier>earthquake-delhi-001</identifier>
                <sender>india.ews@gov.in</sender>
                <sent>%s</sent>
                <status>Actual</status>
                <msgType>Alert</msgType>
                <scope>Public</scope>
                <info>
                    <language>en-IN</language>
                    <category>Geo</category>
                    <event>Earthquake</event>
                    <urgency>Immediate</urgency>
                    <severity>Extreme</severity>
                    <certainty>Observed</certainty>
                    <expires>%s</expires>
                    <headline>Earthquake Alert</headline>
                    <description>Moderate earthquake detected in Delhi region. Magnitude 5.2. No tsunami threat.</description>
                    <instruction>Shelter</instruction>
                    <area>
                        <areaDesc>Delhi Metropolitan Area</areaDesc>
                        <circle>28.6139,77.2090 15</circle>
                    </area>
                </info>
            </alert>
            """, sent, expires);
    }
    
    /**
     * Sample CAP XML for flood alert.
     */
    public static String createFloodCapXml() {
        Instant sent = Instant.now().minus(5, ChronoUnit.MINUTES);
        Instant expires = Instant.now().plus(6, ChronoUnit.HOURS);
        
        return String.format("""
            <?xml version="1.0" encoding="UTF-8"?>
            <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
                <identifier>flood-mumbai-001</identifier>
                <sender>india.ews@gov.in</sender>
                <sent>%s</sent>
                <status>Actual</status>
                <msgType>Alert</msgType>
                <scope>Public</scope>
                <info>
                    <language>en-IN</language>
                    <category>Met</category>
                    <event>Flood</event>
                    <urgency>Expected</urgency>
                    <severity>Severe</severity>
                    <certainty>Likely</certainty>
                    <expires>%s</expires>
                    <headline>Flood Warning</headline>
                    <description>Heavy rainfall warning. Low-lying areas may experience flooding. Avoid travel.</description>
                    <instruction>Evacuate</instruction>
                    <area>
                        <areaDesc>Mumbai Metropolitan Area</areaDesc>
                        <circle>19.0760,72.8777 20</circle>
                    </area>
                </info>
            </alert>
            """, sent, expires);
    }
    
    // ========== Additional Helper Methods for Testing ==========
    
    /**
     * Create a sample CAP alert with default values.
     */
    public static CapAlert createSampleCapAlert() {
        return createEarthquakeAlert();
    }
    
    /**
     * Create a sample CAP XML with default values.
     */
    public static String createSampleCapXml() {
        return createEarthquakeCapXml();
    }
    
    /**
     * Create a customized CAP alert.
     */
    public static CapAlert createCapAlert(String identifier, String sender, String headline) {
        String sent = Instant.now().minus(2, ChronoUnit.MINUTES).toString();
        String expires = Instant.now().plus(2, ChronoUnit.HOURS).toString();
        
        CapInfo info = new CapInfo(
            "en-IN",                             // language
            List.of("Geo"),                      // category
            "Test Event",                        // event
            List.of("Monitor"),                  // responseType
            CapUrgency.Immediate,                // urgency
            CapSeverity.Extreme,                 // severity
            CapCertainty.Observed,               // certainty
            null,                                // audience
            List.of(),                           // eventCode
            null,                                // effective
            null,                                // onset
            expires,                             // expires
            sender,                              // senderName
            headline,                            // headline
            "Test alert description",            // description
            "Test instructions",                 // instruction
            "+91-11-26701728",                   // contact
            List.of(createDelhiArea())           // areas
        );
        
        return new CapAlert(
            identifier,                          // identifier
            sender,                              // sender
            sent,                                // sent
            CapStatus.Actual,                    // status
            CapMsgType.Alert,                    // msgType
            null,                                // source
            CapScope.Public,                     // scope
            null,                                // restriction
            null,                                // addresses
            List.of(),                           // code
            null,                                // note
            null,                                // references
            null,                                // incidents
            List.of(info),                       // infos
            info,                                // info
            null                                 // rawXml
        );
    }
}
