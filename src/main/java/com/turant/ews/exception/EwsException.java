package com.turant.ews.exception;

public class EwsException extends RuntimeException {
    private final EwsErrorCode errorCode;
    private final Integer httpStatus;

    public EwsException(EwsErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
        this.httpStatus = null;
    }

    public EwsException(EwsErrorCode errorCode, String message, Integer httpStatus) {
        super(message);
        this.errorCode = errorCode;
        this.httpStatus = httpStatus;
    }

    public EwsException(EwsErrorCode errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
        this.httpStatus = null;
    }

    public EwsException(EwsErrorCode errorCode, String message, Integer httpStatus, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
        this.httpStatus = httpStatus;
    }

    public EwsErrorCode getErrorCode() { return errorCode; }
    public Integer getHttpStatus() { return httpStatus; }
}
