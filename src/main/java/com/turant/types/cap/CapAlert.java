package com.turant.types.cap;

import java.util.List;

/**
 * Fully parsed CAP alert ready for downstream modules.
 * Preserves TypeScript interface exactly.
 */
public record CapAlert(
    String identifier,
    String sender,
    String sent,
    CapStatus status,
    CapMsgType msgType,
    String source,
    CapScope scope,
    String restriction,
    String addresses,
    List<String> code,
    String note,
    String references,
    String incidents,
    List<CapInfo> infos,
    CapInfo info,
    String rawXml
) {}
