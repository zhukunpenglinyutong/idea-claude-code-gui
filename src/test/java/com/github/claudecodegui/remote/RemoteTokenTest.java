package com.github.claudecodegui.remote;

import org.junit.Test;

import java.security.SecureRandom;
import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public class RemoteTokenTest {

    @Test
    public void generatesUrlSafeUnpaddedTokenWithSufficientEntropy() {
        String token = RemoteToken.generate();
        // No padding characters.
        assertFalse("token must not be padded", token.contains("="));
        // Only Base64URL alphabet.
        assertTrue(token.matches("[A-Za-z0-9_-]+"));
        // 32 bytes -> ~43 base64 chars.
        assertTrue("token too short: " + token.length(), token.length() >= 43);
        assertTrue(RemoteToken.isWellFormed(token));
    }

    @Test
    public void generatesDistinctTokens() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 1000; i++) {
            String t = RemoteToken.generate();
            assertTrue("collision at " + i, seen.add(t));
        }
    }

    @Test
    public void respectsMinimumEntropyByteLength() {
        // SecureRandom is not required to be deterministic across JVMs, so we
        // only assert the byte count we feed it (256 bits / 32 bytes).
        SecureRandom fixed = new SecureRandom(new byte[]{1, 2, 3});
        String token = RemoteToken.generate(fixed);
        assertTrue(RemoteToken.isWellFormed(token));
    }

    @Test
    public void twoEqualTokensCompareEqual() {
        String a = RemoteToken.generate();
        assertTrue(RemoteToken.constantTimeEquals(a, a));
    }

    @Test
    public void differentTokensCompareUnequal() {
        String a = RemoteToken.generate();
        String b = RemoteToken.generate();
        assertNotEquals(a, b);
        assertFalse(RemoteToken.constantTimeEquals(a, b));
    }

    @Test
    public void nullInputsAreSafe() {
        assertFalse(RemoteToken.constantTimeEquals(null, "x"));
        assertFalse(RemoteToken.constantTimeEquals("x", null));
        assertFalse(RemoteToken.constantTimeEquals(null, null));
    }

    @Test
    public void malformedTokensRejected() {
        assertFalse(RemoteToken.isWellFormed(null));
        assertFalse(RemoteToken.isWellFormed(""));
        assertFalse(RemoteToken.isWellFormed("short"));
        assertFalse(RemoteToken.isWellFormed("!!!not-base64!!!but-long-enough-to-pass-length"));
    }
}
