package com.turant.cap;

/**
 * Raised for any malformed / non-conforming CAP input.
 * Preserves exact exception behavior from TypeScript version.
 */
public class CapParseException extends Exception {
    
    private final String context;
    
    public CapParseException(String message) {
        super(message);
        this.context = null;
    }
    
    public CapParseException(String message, String context) {
        super(context != null ? message + " (context: " + context + ")" : message);
        this.context = context;
    }
    
    public CapParseException(String message, Throwable cause) {
        super(message, cause);
        this.context = null;
    }
    
    public String getContext() {
        return context;
    }
}
