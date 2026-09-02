package com.turant.security;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Item #2 Layer 8 — IP / Network Restrictions (CIDR allowlist, not trusting X-Forwarded-For blindly)
 */
@Service
public class IpRestrictionService {

    private static final Logger log = LoggerFactory.getLogger(IpRestrictionService.class);
    private final Set<String> globalAllowedCidrs;
    private final boolean enabled;

    public IpRestrictionService(@Value("${turant.security.ip-allowlist:}") String allowlist,
                                @Value("${turant.security.ip-enforce:false}") boolean enforce) {
        this.enabled = enforce;
        this.globalAllowedCidrs = Arrays.stream(allowlist.split(","))
                .map(String::trim).filter(s -> !s.isBlank()).collect(Collectors.toSet());
        log.info("IpRestrictionService enabled={} allowlist={}", enabled, globalAllowedCidrs);
    }

    public boolean isAllowed(HttpServletRequest req, String clientAllowedIps) {
        if (!enabled) return true;
        // Use remoteAddr, not X-Forwarded-For blindly; if behind proxy, configure trusted proxy check in MtlsIdentityService
        String remoteIp = req.getRemoteAddr();
        Set<String> cidrs = clientAllowedIps != null && !clientAllowedIps.isBlank()
                ? Arrays.stream(clientAllowedIps.split(",")).map(String::trim).filter(s->!s.isBlank()).collect(Collectors.toSet())
                : globalAllowedCidrs;
        if (cidrs.isEmpty()) return true; // no restriction
        for (String cidr : cidrs) {
            if (isInCidr(remoteIp, cidr)) {
                log.info("IP allowed {} in {}", remoteIp, cidr);
                return true;
            }
        }
        log.warn("IP rejected {} not in {}", remoteIp, cidrs);
        return false;
    }

    private boolean isInCidr(String ip, String cidr) {
        try {
            if (!cidr.contains("/")) return ip.equals(cidr);
            String[] parts = cidr.split("/");
            InetAddress addr = InetAddress.getByName(ip);
            InetAddress net = InetAddress.getByName(parts[0]);
            int prefix = Integer.parseInt(parts[1]);
            byte[] addrBytes = addr.getAddress();
            byte[] netBytes = net.getAddress();
            int mask = ~((1 << (32 - prefix)) - 1);
            int ipInt = ((addrBytes[0] & 0xFF) << 24) | ((addrBytes[1] & 0xFF) << 16) | ((addrBytes[2] & 0xFF) << 8) | (addrBytes[3] & 0xFF);
            int netInt = ((netBytes[0] & 0xFF) << 24) | ((netBytes[1] & 0xFF) << 16) | ((netBytes[2] & 0xFF) << 8) | (netBytes[3] & 0xFF);
            return (ipInt & mask) == (netInt & mask);
        } catch (Exception e) { return false; }
    }
}
