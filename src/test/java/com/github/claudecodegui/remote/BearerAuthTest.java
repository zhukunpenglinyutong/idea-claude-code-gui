package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class BearerAuthTest {

    private static final String TOKEN = "abcdefghijklmnopqrstuv1234567890-_ABC";

    @Test
    public void extractsBearerToken() {
        assertEquals(TOKEN, BearerAuth.extractToken("Bearer " + TOKEN));
        assertEquals(TOKEN, BearerAuth.extractToken("bearer " + TOKEN));
        assertEquals(TOKEN, BearerAuth.extractToken("Bearer   " + TOKEN + "  "));
    }

    @Test
    public void rejectsNonBearerScheme() {
        assertNull(BearerAuth.extractToken("Basic " + TOKEN));
        assertNull(BearerAuth.extractToken(TOKEN));
        assertNull(BearerAuth.extractToken(""));
        assertNull(BearerAuth.extractToken(null));
        assertNull(BearerAuth.extractToken("Bearer "));
        assertNull(BearerAuth.extractToken("Bearer"));
    }

    @Test
    public void authorizesCorrectToken() {
        assertTrue(BearerAuth.isAuthorized("Bearer " + TOKEN, TOKEN));
    }

    @Test
    public void rejectsWrongToken() {
        assertFalse(BearerAuth.isAuthorized("Bearer wrong-token-value-here-long", TOKEN));
    }

    @Test
    public void rejectsMissingOrMalformedHeader() {
        assertFalse(BearerAuth.isAuthorized(null, TOKEN));
        assertFalse(BearerAuth.isAuthorized("", TOKEN));
        assertFalse(BearerAuth.isAuthorized(TOKEN, TOKEN));
        assertFalse(BearerAuth.isAuthorized("Bearer ", TOKEN));
    }

    @Test
    public void rejectsWhenNoExpectedTokenConfigured() {
        assertFalse(BearerAuth.isAuthorized("Bearer " + TOKEN, null));
        assertFalse(BearerAuth.isAuthorized("Bearer " + TOKEN, ""));
    }
}
