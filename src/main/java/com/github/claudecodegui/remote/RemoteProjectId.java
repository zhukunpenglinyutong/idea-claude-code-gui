package com.github.claudecodegui.remote;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Derives a stable, opaque identifier for an IntelliJ {@code Project} from its
 * {@code basePath}.
 *
 * <p>The raw filesystem path is never used as an identifier: Windows paths
 * contain drive letters and backslashes, change when a project is moved, and
 * leak implementation details into URLs. Instead the absolute basePath is
 * normalized and SHA-256 hashed, then rendered as 32 lowercase hex characters
 * (128 bits). The same path always yields the same id within and across runs,
 * so a Remote Client can address a project deterministically.
 *
 * <p>A project without a basePath (e.g. the default project) returns null and
 * is intentionally not exposed to Remote Clients — there is no stable
 * filesystem handle to anchor an id to.
 */
public final class RemoteProjectId {

    /** Number of hex characters retained (128 bits of the SHA-256 digest). */
    public static final int ID_HEX_LENGTH = 32;

    private RemoteProjectId() {
    }

    /**
     * @param basePath the project base path, possibly null
     * @return a 32-char lowercase hex id, or null if basePath is null/blank
     */
    public static String of(String basePath) {
        if (basePath == null) {
            return null;
        }
        String normalized = normalize(basePath);
        if (normalized.isEmpty()) {
            return null;
        }
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(normalized.getBytes(StandardCharsets.UTF_8));
            // ID_HEX_LENGTH hex chars == ID_HEX_LENGTH/2 bytes (128 bits for 32 chars).
            StringBuilder sb = new StringBuilder(ID_HEX_LENGTH);
            int bytesNeeded = ID_HEX_LENGTH / 2;
            for (int i = 0; i < bytesNeeded; i++) {
                int b = digest[i] & 0xff;
                sb.append(Character.forDigit(b >>> 4, 16));
                sb.append(Character.forDigit(b & 0x0f, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated by the JLS; unreachable.
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /**
     * Normalize a path before hashing: trim, resolve {@code ~} is intentionally
     * NOT expanded (we hash the literal as given), collapse trailing
     * separators, and lowercase drive letters on Windows so {@code C:\x} and
     * {@code c:\x} collide.
     */
    private static String normalize(String basePath) {
        String p = basePath.trim();
        // Collapse trailing slashes/backslashes.
        while (p.length() > 1 && (p.endsWith("/") || p.endsWith("\\"))) {
            p = p.substring(0, p.length() - 1);
        }
        // A lone root (e.g. "/" or "\") is not a real project path.
        if (p.length() == 1 && (p.charAt(0) == '/' || p.charAt(0) == '\\')) {
            return "";
        }
        if (p.isEmpty()) {
            return p;
        }
        // Normalize Windows drive letter casing (C:\ -> c:\) without touching
        // the rest of the path, which may be case-significant on Unix.
        if (p.length() >= 2 && p.charAt(1) == ':' && isAsciiLetter(p.charAt(0))) {
            p = Character.toLowerCase(p.charAt(0)) + p.substring(1);
        }
        return p;
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}
