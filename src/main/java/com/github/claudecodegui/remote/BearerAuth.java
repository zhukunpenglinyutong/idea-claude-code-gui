package com.github.claudecodegui.remote;

/**
 * Parses and validates the {@code Authorization: Bearer <token>} header.
 *
 * <p>Only the Bearer scheme is accepted. The token itself is compared against
 * the expected value with a constant-time comparison. Query-parameter tokens
 * ({@code ?token=...}) are intentionally not supported because they leak into
 * access logs.
 */
public final class BearerAuth {

    public static final String SCHEME = "Bearer";

    private BearerAuth() {
    }

    /**
     * Extract the raw token from an Authorization header value.
     *
     * @param header the raw header value, possibly null
     * @return the token string, or null if the header is absent or malformed
     */
    public static String extractToken(String header) {
        if (header == null) {
            return null;
        }
        String trimmed = header.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        // Split into scheme + remainder on the first whitespace.
        int space = trimmed.indexOf(' ');
        if (space <= 0) {
            return null;
        }
        String scheme = trimmed.substring(0, space);
        if (!SCHEME.equalsIgnoreCase(scheme)) {
            return null;
        }
        String token = trimmed.substring(space + 1).trim();
        return token.isEmpty() ? null : token;
    }

    /**
     * @return true iff the header carries a Bearer token equal to the expected one
     */
    public static boolean isAuthorized(String header, String expectedToken) {
        if (expectedToken == null || expectedToken.isEmpty()) {
            return false;
        }
        String token = extractToken(header);
        return RemoteToken.constantTimeEquals(token, expectedToken);
    }
}
