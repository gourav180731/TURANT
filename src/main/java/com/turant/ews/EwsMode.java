package com.turant.ews;

/**
 * Activity 7: EWS integration mode.
 * LOCAL  -> local/mock endpoint for dev/test, no real EWS needed.
 * REMOTE -> actual C-DOT EWS/VB endpoint, credentials from env.
 */
public enum EwsMode {
    LOCAL,
    REMOTE;

    public static EwsMode from(String value) {
        if (value == null) throw new IllegalArgumentException("EWS mode must not be null");
        String v = value.trim().toLowerCase();
        return switch (v) {
            case "local" -> LOCAL;
            case "remote" -> REMOTE;
            default -> throw new IllegalStateException("Unsupported EWS mode: " + value + " (allowed: local, remote)");
        };
    }
}
