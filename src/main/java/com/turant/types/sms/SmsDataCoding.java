package com.turant.types.sms;

public enum SmsDataCoding {
    SEVEN_BIT("7bit"),
    UCS2("ucs2");
    
    private final String value;
    
    SmsDataCoding(String value) {
        this.value = value;
    }
    
    public String getValue() {
        return value;
    }
    
    public static SmsDataCoding fromString(String value) {
        for (SmsDataCoding coding : values()) {
            if (coding.value.equals(value)) {
                return coding;
            }
        }
        throw new IllegalArgumentException("Unknown SMS data coding: " + value);
    }
}
