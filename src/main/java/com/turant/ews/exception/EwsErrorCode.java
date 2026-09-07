package com.turant.ews.exception;

/**
 * EWS error taxonomy per spec — must be clearly distinguished in API responses.
 */
public enum EwsErrorCode {
    SUCCESS,
    REMOTE_REJECTED,
    AUTHENTICATION_FAILURE,
    TIMEOUT,
    CONNECTION_FAILURE,
    INVALID_REQUEST,
    SERVER_ERROR,
    UNSUPPORTED_MODE,
    NOT_CONFIGURED
}
