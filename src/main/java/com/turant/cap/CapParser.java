package com.turant.cap;

import com.turant.types.cap.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.w3c.dom.*;
import javax.xml.parsers.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.*;

/**
 * CAP XML parser - migrated from TypeScript fast-xml-parser.
 * 
 * Parses CAP 1.2 (ITU-T X.1303 / OASIS CAP v1.2) XML documents into CapAlert.
 * Preserves exact validation and normalization behavior from the TypeScript implementation.
 */
@Component
public class CapParser {
    
    private static final Logger logger = LoggerFactory.getLogger(CapParser.class);
    
    private final DocumentBuilderFactory documentBuilderFactory;
    
    public CapParser() {
        this.documentBuilderFactory = DocumentBuilderFactory.newInstance();
        this.documentBuilderFactory.setNamespaceAware(true);
    }
    
    /**
     * Parse CAP XML document into CapAlert.
     * 
     * @param xml Raw CAP XML string
     * @param preferredLanguage Preferred info language (e.g. "en-IN"), null to use first
     * @return Parsed and validated CAP alert
     * @throws CapParseException if XML is malformed or invalid
     */
    public CapAlert parseCapXml(String xml, String preferredLanguage) throws CapParseException {
        String trimmed = xml.trim();
        if (trimmed.isEmpty()) {
            throw new CapParseException("Empty CAP XML document");
        }
        
        try {
            DocumentBuilder builder = documentBuilderFactory.newDocumentBuilder();
            Document doc = builder.parse(new ByteArrayInputStream(trimmed.getBytes(StandardCharsets.UTF_8)));
            
            Element alertElement = extractAlertElement(doc);
            return normalizeAlert(alertElement, trimmed, preferredLanguage);
            
        } catch (CapParseException e) {
            throw e;
        } catch (Exception e) {
            throw new CapParseException("XML syntax error: " + e.getMessage(), e);
        }
    }
    
    /**
     * Extract the <alert> root element, handling namespace prefixes.
     */
    private Element extractAlertElement(Document doc) throws CapParseException {
        Element root = doc.getDocumentElement();
        String localName = root.getLocalName() != null ? root.getLocalName() : root.getTagName();
        
        if ("alert".equalsIgnoreCase(localName) || "Alert".equals(localName)) {
            return root;
        }
        
        // Try to find alert child
        NodeList children = root.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            if (child instanceof Element) {
                Element elem = (Element) child;
                String childLocalName = elem.getLocalName() != null ? elem.getLocalName() : elem.getTagName();
                if ("alert".equalsIgnoreCase(childLocalName)) {
                    return elem;
                }
            }
        }
        
        throw new CapParseException("No <alert> root element found in CAP document");
    }
    
    private CapAlert normalizeAlert(Element alert, String rawXml, String preferredLanguage) throws CapParseException {
        String identifier = requiredText(alert, "identifier");
        String sender = requiredText(alert, "sender");
        String sent = requiredText(alert, "sent");
        CapStatus status = requiredEnum(alert, "status", CapStatus.class);
        CapMsgType msgType = requiredEnum(alert, "msgType", CapMsgType.class);
        CapScope scope = optionalEnum(alert, "scope", CapScope.class, CapScope.Public);
        
        List<String> codes = getTextList(alert, "code");
        List<CapInfo> infos = getInfoList(alert);
        
        if (infos.isEmpty()) {
            throw new CapParseException("CAP <info> element is required", identifier);
        }
        
        CapInfo selectedInfo = selectInfo(infos, preferredLanguage);
        
        return new CapAlert(
            identifier,
            sender,
            sent,
            status,
            msgType,
            optionalText(alert, "source"),
            scope,
            optionalText(alert, "restriction"),
            optionalText(alert, "addresses"),
            codes,
            optionalText(alert, "note"),
            optionalText(alert, "references"),
            optionalText(alert, "incidents"),
            infos,
            selectedInfo,
            rawXml
        );
    }
    
    private List<CapInfo> getInfoList(Element alert) throws CapParseException {
        List<CapInfo> infos = new ArrayList<>();
        NodeList infoNodes = alert.getElementsByTagNameNS("*", "info");
        if (infoNodes.getLength() == 0) {
            infoNodes = alert.getElementsByTagName("info");
        }
        
        for (int i = 0; i < infoNodes.getLength(); i++) {
            Element infoElement = (Element) infoNodes.item(i);
            infos.add(normalizeInfo(infoElement));
        }
        
        return infos;
    }
    
    private CapInfo normalizeInfo(Element info) throws CapParseException {
        String language = optionalText(info, "language", "en-US");
        List<String> category = getTextList(info, "category");
        if (category.isEmpty()) {
            category = List.of("Unknown");
        }
        
        String event = requiredText(info, "event");
        CapUrgency urgency = optionalEnum(info, "urgency", CapUrgency.class, CapUrgency.Unknown);
        CapSeverity severity = optionalEnum(info, "severity", CapSeverity.class, CapSeverity.Unknown);
        CapCertainty certainty = optionalEnum(info, "certainty", CapCertainty.class, CapCertainty.Unknown);
        
        List<String> responseType = getTextList(info, "responseType");
        List<CapGeocode> eventCode = getGeocodeList(info, "eventCode");
        List<CapArea> areas = getAreaList(info);
        
        return new CapInfo(
            language,
            category,
            event,
            responseType.isEmpty() ? null : responseType,
            urgency,
            severity,
            certainty,
            optionalText(info, "audience"),
            eventCode,
            optionalText(info, "effective"),
            optionalText(info, "onset"),
            optionalText(info, "expires"),
            optionalText(info, "senderName"),
            optionalText(info, "headline"),
            optionalText(info, "description"),
            optionalText(info, "instruction"),
            optionalText(info, "contact"),
            areas
        );
    }
    
    private List<CapArea> getAreaList(Element info) throws CapParseException {
        List<CapArea> areas = new ArrayList<>();
        NodeList areaNodes = info.getElementsByTagNameNS("*", "area");
        if (areaNodes.getLength() == 0) {
            areaNodes = info.getElementsByTagName("area");
        }
        
        for (int i = 0; i < areaNodes.getLength(); i++) {
            Element areaElement = (Element) areaNodes.item(i);
            areas.add(normalizeArea(areaElement));
        }
        
        return areas;
    }
    
    private CapArea normalizeArea(Element area) throws CapParseException {
        String areaDesc = optionalText(area, "areaDesc", "");
        
        List<List<CapCoordinate>> polygons = new ArrayList<>();
        List<CapArea.CircleDefinition> circles = new ArrayList<>();
        List<CapGeometry> geometries = new ArrayList<>();
        
        // Parse polygons
        List<String> polygonTexts = getTextList(area, "polygon");
        for (String polygonText : polygonTexts) {
            List<CapCoordinate> ring = parsePolygon(polygonText);
            polygons.add(ring);
            geometries.add(CapGeometry.polygon(List.of(ring)));
        }
        
        // Parse circles
        List<String> circleTexts = getTextList(area, "circle");
        for (String circleText : circleTexts) {
            CapArea.CircleDefinition circle = parseCircle(circleText);
            circles.add(circle);
            geometries.add(CapGeometry.circle(circle.center(), circle.radiusMeters()));
        }
        
        List<CapGeocode> geocodes = getGeocodeList(area, "geocode");
        
        return new CapArea(areaDesc, polygons, circles, geometries, geocodes);
    }
    
    private List<CapGeocode> getGeocodeList(Element element, String tagName) {
        List<CapGeocode> geocodes = new ArrayList<>();
        NodeList nodes = element.getElementsByTagNameNS("*", tagName);
        if (nodes.getLength() == 0) {
            nodes = element.getElementsByTagName(tagName);
        }
        
        for (int i = 0; i < nodes.getLength(); i++) {
            Element geocodeElement = (Element) nodes.item(i);
            String valueName = optionalText(geocodeElement, "valueName", "");
            String value = optionalText(geocodeElement, "value", "");
            if (!valueName.isEmpty() || !value.isEmpty()) {
                geocodes.add(new CapGeocode(valueName, value));
            }
        }
        
        return geocodes;
    }
    
    /**
     * Select info block by language preference.
     */
    private CapInfo selectInfo(List<CapInfo> infos, String preferredLanguage) {
        if (preferredLanguage == null || preferredLanguage.isEmpty()) {
            return infos.get(0);
        }
        
        String lang = preferredLanguage.toLowerCase();
        String primary = lang.split("-")[0];
        
        // Exact match
        for (CapInfo info : infos) {
            if (info.language().toLowerCase().equals(lang)) {
                return info;
            }
        }
        
        // Primary language match
        for (CapInfo info : infos) {
            if (info.language().toLowerCase().startsWith(primary + "-")) {
                return info;
            }
        }
        
        logger.warn("CAP preferred language '{}' not present; using first info block", preferredLanguage);
        return infos.get(0);
    }
    
    /**
     * Parse CAP timing fields.
     */
    public CapTiming parseCapTiming(CapInfo info) {
        return new CapTiming(
            parseCapTimestamp(info.expires()),
            parseCapTimestamp(info.effective()),
            parseCapTimestamp(info.onset())
        );
    }
    
    /**
     * Parse CAP timestamp (ISO 8601).
     */
    private Instant parseCapTimestamp(String value) {
        if (value == null || value.isEmpty()) {
            return null;
        }
        
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException e) {
            logger.warn("Invalid CAP timestamp: {}", value);
            return null;
        }
    }
    
    // ---- Coordinate and geometry parsing ----
    
    private CapCoordinate parseCoordinate(String coordStr) throws CapParseException {
        String[] parts = coordStr.trim().split(",");
        if (parts.length != 2) {
            throw new CapParseException("Invalid coordinate format, expected 'lat,lng': " + coordStr);
        }
        
        try {
            double lat = Double.parseDouble(parts[0].trim());
            double lng = Double.parseDouble(parts[1].trim());
            return new CapCoordinate(lat, lng);
        } catch (NumberFormatException e) {
            throw new CapParseException("Invalid coordinate numbers: " + coordStr, e);
        }
    }
    
    private List<CapCoordinate> parsePolygon(String polygonStr) throws CapParseException {
        String[] coords = polygonStr.trim().split("\\s+");
        List<CapCoordinate> coordinates = new ArrayList<>();
        
        for (String coord : coords) {
            if (!coord.isEmpty()) {
                coordinates.add(parseCoordinate(coord));
            }
        }
        
        if (coordinates.size() < 4) {
            throw new CapParseException("Polygon must have at least 4 points");
        }
        
        CapCoordinate first = coordinates.get(0);
        CapCoordinate last = coordinates.get(coordinates.size() - 1);
        
        if (first.lat() != last.lat() || first.lng() != last.lng()) {
            throw new CapParseException("Polygon must be a closed ring (first point == last point)");
        }
        
        return coordinates;
    }
    
    private CapArea.CircleDefinition parseCircle(String circleStr) throws CapParseException {
        String[] parts = circleStr.trim().split("\\s+");
        if (parts.length != 2) {
            throw new CapParseException("Invalid circle format, expected 'lat,lng radius': " + circleStr);
        }
        
        CapCoordinate center = parseCoordinate(parts[0]);
        
        try {
            double radiusKm = Double.parseDouble(parts[1]);
            double radiusMeters = radiusKm * 1000;
            return new CapArea.CircleDefinition(center, radiusMeters);
        } catch (NumberFormatException e) {
            throw new CapParseException("Invalid circle radius: " + parts[1], e);
        }
    }
    
    // ---- XML element access helpers ----
    
    private String requiredText(Element element, String tagName) throws CapParseException {
        String value = getFirstElementText(element, tagName);
        if (value == null || value.isEmpty()) {
            throw new CapParseException("CAP field <" + tagName + "> is required");
        }
        return value;
    }
    
    private String optionalText(Element element, String tagName) {
        return optionalText(element, tagName, null);
    }
    
    private String optionalText(Element element, String tagName, String defaultValue) {
        String value = getFirstElementText(element, tagName);
        return (value != null && !value.isEmpty()) ? value : defaultValue;
    }
    
    private List<String> getTextList(Element element, String tagName) {
        List<String> result = new ArrayList<>();
        NodeList nodes = element.getElementsByTagNameNS("*", tagName);
        if (nodes.getLength() == 0) {
            nodes = element.getElementsByTagName(tagName);
        }
        
        for (int i = 0; i < nodes.getLength(); i++) {
            String text = nodes.item(i).getTextContent();
            if (text != null && !text.trim().isEmpty()) {
                result.add(text.trim());
            }
        }
        
        return result;
    }
    
    private String getFirstElementText(Element element, String tagName) {
        NodeList nodes = element.getElementsByTagNameNS("*", tagName);
        if (nodes.getLength() == 0) {
            nodes = element.getElementsByTagName(tagName);
        }
        
        if (nodes.getLength() > 0) {
            String text = nodes.item(0).getTextContent();
            return text != null ? text.trim() : null;
        }
        
        return null;
    }
    
    private <T extends Enum<T>> T requiredEnum(Element element, String tagName, Class<T> enumClass) 
            throws CapParseException {
        String value = requiredText(element, tagName);
        try {
            return Enum.valueOf(enumClass, value);
        } catch (IllegalArgumentException e) {
            throw new CapParseException("Invalid " + tagName + ": " + value);
        }
    }
    
    private <T extends Enum<T>> T optionalEnum(Element element, String tagName, Class<T> enumClass, T defaultValue) {
        String value = optionalText(element, tagName);
        if (value == null) {
            logger.warn("CAP field <{}> missing; using fallback '{}'", tagName, defaultValue);
            return defaultValue;
        }
        
        try {
            return Enum.valueOf(enumClass, value);
        } catch (IllegalArgumentException e) {
            logger.warn("CAP field <{}> has non-standard value '{}'; using fallback", tagName, value);
            return defaultValue;
        }
    }
}
