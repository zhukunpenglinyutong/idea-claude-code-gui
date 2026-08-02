package com.github.claudecodegui.remote;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * Generates high-entropy bearer tokens for the Remote Gateway.
 *
 * <p>Tokens are produced with {@link SecureRandom} and encoded as Base64URL
 * without padding. A token carries at least 256 bits of entropy (32 random
 * bytes), which yields a ~43-character string. Tokens never appear in source,
 * logs, or API responses.
 */
public final class RemoteToken {

    /** Minimum entropy in bits. */
    public static final int MIN_ENTROPY_BITS = 256;

    private static final int TOKEN_BYTES = MIN_ENTROPY_BITS / Byte.SIZE;
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    private RemoteToken() {
    }

    /**
     * Generate a fresh random token.
     *
     * @return a Base64URL (unpadded) token string with at least 256 bits of entropy
     */
    public static String generate() {
        return generate(new SecureRandom());
    }

    /**
     * Generate a token using the supplied randomness source. Exposed for
     * deterministic testing.
     */
    public static String generate(SecureRandom random) {
        byte[] bytes = new byte[TOKEN_BYTES];
        random.nextBytes(bytes);
        return ENCODER.encodeToString(bytes);
    }

    /**
     * Constant-time comparison of two token strings. Returns false when either
     * argument is null rather than throwing, so callers can short-circuit on a
     * missing header without extra branches.
     *
     * @return true iff both tokens are non-null and equal
     */
    public static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        byte[] ba = a.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] bb = b.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return java.security.MessageDigest.isEqual(ba, bb);
    }

    /**
     * Lightweight structural check that a candidate token decodes as Base64URL
     * and meets the minimum length. Used to reject malformed stored values.
     */
    public static boolean isWellFormed(String token) {
        if (token == null || token.length() < TOKEN_BYTES) {
            return false;
        }
        try {
            byte[] decoded = DECODER.decode(token);
            return decoded.length >= TOKEN_BYTES;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
