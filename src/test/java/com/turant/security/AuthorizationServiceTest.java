package com.turant.security;

import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Layer 4 — Authorization / Policy Engine tests.
 * Default-deny, role-based operation mapping, health endpoint exemption.
 */
class AuthorizationServiceTest {

    private final AuthorizationService authz = new AuthorizationService();

    @Test
    void defaultDeny_whenNoClientOrRoles() {
        assertFalse(authz.isAllowed(null, Set.of("SUBMIT_CAP"), AuthorizationService.Operation.SUBMIT_CAP, "/api/v1/pipeline/trigger-by-cap", "POST"));
        assertFalse(authz.isAllowed("tsp-a", null, AuthorizationService.Operation.SUBMIT_CAP, "/api/v1/pipeline/trigger-by-cap", "POST"));
        assertFalse(authz.isAllowed("tsp-a", Set.of(), AuthorizationService.Operation.SUBMIT_CAP, "/api/v1/pipeline/trigger-by-cap", "POST"));
    }

    @Test
    void submitCap_allowedForSubmitCapAndEwsSubmitRoles() {
        assertTrue(authz.isAllowed("tsp-a", Set.of("SUBMIT_CAP"), AuthorizationService.Operation.SUBMIT_CAP, "/api/v1/pipeline/trigger-by-cap", "POST"));
        assertTrue(authz.isAllowed("tsp-a", Set.of("EWS_SUBMIT"), AuthorizationService.Operation.SUBMIT_CAP, "/api/v1/pipeline/trigger-by-cap", "POST"));
    }

    @Test
    void submitCap_deniedForReadOnlyRole() {
        assertFalse(authz.isAllowed("tsp-b", Set.of("GET_STATUS"), AuthorizationService.Operation.SUBMIT_CAP, "/api/v1/pipeline/trigger-by-cap", "POST"));
    }

    @Test
    void deleteAlert_deniedForNormalClients() {
        assertFalse(authz.isAllowed("tsp-a", Set.of("SUBMIT_CAP", "GET_STATUS"), AuthorizationService.Operation.DELETE_ALERT, "/api/v1/pipeline/status/alert-1", "DELETE"));
    }

    @Test
    void deleteAlert_allowedForAdmin() {
        assertTrue(authz.isAllowed("admin", Set.of("ADMIN"), AuthorizationService.Operation.DELETE_ALERT, "/api/v1/pipeline/status/alert-1", "DELETE"));
        assertTrue(authz.isAllowed("admin", Set.of("DELETE_ALERT"), AuthorizationService.Operation.DELETE_ALERT, "/api/v1/pipeline/status/alert-1", "DELETE"));
    }

    @Test
    void health_alwaysAllowed() {
        assertTrue(authz.isAllowed("anonymous", Set.of(), AuthorizationService.Operation.HEALTH, "/healthz", "GET"));
    }

    @Test
    void operationFor_resolvesEndpointsCorrectly() {
        assertEquals(AuthorizationService.Operation.SUBMIT_CAP, authz.operationFor("/api/v1/pipeline/trigger-by-cap", "POST"));
        assertEquals(AuthorizationService.Operation.SUBMIT_CAP, authz.operationFor("/api/v1/pipeline/trigger", "POST"));
        assertEquals(AuthorizationService.Operation.SUBMIT_CAP, authz.operationFor("/api/v1/alerts/cap", "POST"));
        assertEquals(AuthorizationService.Operation.GET_STATUS, authz.operationFor("/api/v1/pipeline/status/123", "GET"));
        assertEquals(AuthorizationService.Operation.GET_TOWERS, authz.operationFor("/api/v1/pipeline/towers/123", "GET"));
        assertEquals(AuthorizationService.Operation.GET_REPORT, authz.operationFor("/api/v1/pipeline/report/123", "GET"));
        assertEquals(AuthorizationService.Operation.DELETE_ALERT, authz.operationFor("/api/v1/pipeline/status/123", "DELETE"));
        assertEquals(AuthorizationService.Operation.HEALTH, authz.operationFor("/healthz", "GET"));
    }

    @Test
    void rolesFor_parsesCommaSeparatedRolesWithTrimming() {
        var rec = new ClientCredentialsService.ClientRecord("c1", "Client 1", "hash", null, null, " SUBMIT_CAP , GET_STATUS ", 60, true, false);
        Set<String> roles = authz.rolesFor(rec);
        assertEquals(Set.of("SUBMIT_CAP", "GET_STATUS"), roles);
    }
}
