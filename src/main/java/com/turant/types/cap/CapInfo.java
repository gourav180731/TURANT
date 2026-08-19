package com.turant.types.cap;

import java.util.List;

/**
 * One CAP <info> element.
 * Preserves TypeScript interface exactly.
 */
public record CapInfo(
    String language,
    List<String> category,
    String event,
    List<String> responseType,
    CapUrgency urgency,
    CapSeverity severity,
    CapCertainty certainty,
    String audience,
    List<CapGeocode> eventCode,
    String effective,
    String onset,
    String expires,
    String senderName,
    String headline,
    String description,
    String instruction,
    String contact,
    List<CapArea> areas
) {}
