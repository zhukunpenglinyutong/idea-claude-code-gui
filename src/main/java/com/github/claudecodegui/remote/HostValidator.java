package com.github.claudecodegui.remote;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Localhost-only request validation for the Remote Gateway.
 *
 * <p>Even though the server binds solely to {@code 127.0.0.1}, a browser tab
 * pointed at a malicious page can still issue fetch requests to localhost
 * (DNS rebinding / drive-by). Two checks mitigate this:
 *
 * <ol>
 *   <li>{@code Host} header must be {@code 127.0.0.1:<port>}, {@code localhost:<port>},
 *       or {@code [::1]:<port>} matching the bound port. Mismatched hosts are
 *       rejected (403).</li>
 *   <li>If an {@code Origin} header is present (browsers always send one on
 *       cross-origin fetches; curl/Python do not), its host must be a
 *       localhost literal. Any other origin is rejected (403). Requests with
 *       no Origin are allowed — the Remote Client is a non-browser program.</li>
 * </ol>
 *
 * <p>CORS is disabled: no {@code Access-Control-Allow-Origin} is ever emitted.
 */
public final class HostValidator {

    private static final String HOST_LOOPBACK = "127.0.0.1";
    private static final String HOST_LOCALHOST = "localhost";
    private static final String HOST_IPV6_LOOPBACK = "[::1]";

    private HostValidator() {
    }

    /**
     * Validate the Host header against the actual bound port.
     *
     * @param hostHeader raw Host header value, possibly null
     * @param boundPort  the port the server is actually listening on
     * @return true if the host is a loopback literal on the bound port
     */
    public static boolean isHostAllowed(String hostHeader, int boundPort) {
        if (hostHeader == null) {
            return false;
        }
        String host = hostHeader.trim();
        if (host.isEmpty()) {
            return false;
        }
        // Split off the port. IPv6 literal form is [::1]:port.
        String name;
        String portPart;
        if (host.startsWith("[")) {
            int close = host.indexOf(']');
            if (close < 0) {
                return false;
            }
            name = host.substring(0, close + 1);
            portPart = close + 1 < host.length() ? host.substring(close + 1) : "";
        } else {
            // In a Host header an IPv6 literal MUST be bracketed; an unbracketed
            // value containing ':' (e.g. "::1:8080") is ambiguous/malformed.
            int colon = host.lastIndexOf(':');
            if (colon < 0) {
                return isLoopbackName(host) && boundPort <= 0;
            }
            name = host.substring(0, colon);
            if (name.indexOf(':') >= 0) {
                return false;
            }
            portPart = host.substring(colon);
        }
        if (!isLoopbackName(name)) {
            return false;
        }
        int port = parsePort(portPart);
        return port == boundPort;
    }

    /**
     * Validate an Origin header. Absent origin (curl/Python) is allowed.
     *
     * @param originHeader raw Origin header value, possibly null
     * @return true if absent, or if it points at a loopback host
     */
    public static boolean isOriginAllowed(String originHeader) {
        if (originHeader == null || originHeader.trim().isEmpty()) {
            return true;
        }
        try {
            URI uri = new URI(originHeader.trim());
            String host = uri.getHost();
            if (host == null) {
                // Origin like chrome-extension://<id> has no host -> reject.
                return false;
            }
            return isLoopbackName(host);
        } catch (URISyntaxException e) {
            return false;
        }
    }

    private static boolean isLoopbackName(String name) {
        if (name == null) {
            return false;
        }
        String n = name.trim();
        if (n.isEmpty()) {
            return false;
        }
        // Accept bracketed "[::1]" (Host header) and bare "::1" (URI.getHost
        // from an Origin), plus the IPv4/hostname loopback literals.
        if (n.startsWith("[") && n.endsWith("]")) {
            return HOST_IPV6_LOOPBACK.equalsIgnoreCase(n);
        }
        return HOST_LOOPBACK.equalsIgnoreCase(n)
                || HOST_LOCALHOST.equalsIgnoreCase(n)
                || "::1".equalsIgnoreCase(n);
    }

    private static int parsePort(String portPart) {
        if (portPart == null || portPart.isEmpty()) {
            return -1;
        }
        // portPart begins with ':' from the split above, or is empty.
        String digits = portPart.startsWith(":") ? portPart.substring(1) : portPart;
        if (digits.isEmpty()) {
            return -1;
        }
        try {
            return Integer.parseInt(digits);
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}
