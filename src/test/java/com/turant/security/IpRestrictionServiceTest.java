package com.turant.security;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Layer 8 — IP / Network Restrictions tests.
 * CIDR subnet and single host matching, allow/deny enforcement.
 */
class IpRestrictionServiceTest {

    @Test
    void disabledMode_allowsAllIps() {
        IpRestrictionService disabled = new IpRestrictionService("", false);
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("198.51.100.10");
        assertTrue(disabled.isAllowed(req, null));
    }

    @Test
    void enabledMode_allowsMatchingCidr() {
        IpRestrictionService service = new IpRestrictionService("10.0.0.0/8, 192.168.1.0/24", true);

        MockHttpServletRequest req1 = new MockHttpServletRequest();
        req1.setRemoteAddr("10.5.2.1");
        assertTrue(service.isAllowed(req1, null));

        MockHttpServletRequest req2 = new MockHttpServletRequest();
        req2.setRemoteAddr("192.168.1.42");
        assertTrue(service.isAllowed(req2, null));
    }

    @Test
    void enabledMode_rejectsNonMatchingIp() {
        IpRestrictionService service = new IpRestrictionService("10.0.0.0/8", true);

        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("203.0.113.5");
        assertFalse(service.isAllowed(req, null));
    }

    @Test
    void perClientAllowedIps_overridesGlobal() {
        IpRestrictionService service = new IpRestrictionService("10.0.0.0/8", true);

        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("203.0.113.99");

        // Client has explicit allowlist for 203.0.113.0/24
        assertTrue(service.isAllowed(req, "203.0.113.0/24"));

        // Another client does not
        assertFalse(service.isAllowed(req, "192.168.0.0/16"));
    }
}
