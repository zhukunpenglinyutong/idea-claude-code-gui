package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HostValidatorTest {

    @Test
    public void allowsLoopbackHostOnBoundPort() {
        assertTrue(HostValidator.isHostAllowed("127.0.0.1:8080", 8080));
        assertTrue(HostValidator.isHostAllowed("localhost:8080", 8080));
        assertTrue(HostValidator.isHostAllowed("[::1]:8080", 8080));
    }

    @Test
    public void rejectsWrongPort() {
        assertFalse(HostValidator.isHostAllowed("127.0.0.1:9090", 8080));
        assertFalse(HostValidator.isHostAllowed("localhost:9090", 8080));
    }

    @Test
    public void rejectsNonLoopbackHost() {
        assertFalse(HostValidator.isHostAllowed("192.168.1.5:8080", 8080));
        assertFalse(HostValidator.isHostAllowed("evil.com:8080", 8080));
        assertFalse(HostValidator.isHostAllowed("0.0.0.0:8080", 8080));
    }

    @Test
    public void rejectsNullOrBlankHost() {
        assertFalse(HostValidator.isHostAllowed(null, 8080));
        assertFalse(HostValidator.isHostAllowed("", 8080));
        assertFalse(HostValidator.isHostAllowed("   ", 8080));
    }

    @Test
    public void rejectsMalformedIpv6() {
        assertFalse(HostValidator.isHostAllowed("[::1", 8080));
        assertFalse(HostValidator.isHostAllowed("::1:8080", 8080));
    }

    @Test
    public void absentOriginIsAllowed() {
        assertTrue(HostValidator.isOriginAllowed(null));
        assertTrue(HostValidator.isOriginAllowed(""));
        assertTrue(HostValidator.isOriginAllowed("   "));
    }

    @Test
    public void loopbackOriginsAreAllowed() {
        assertTrue(HostValidator.isOriginAllowed("http://127.0.0.1:8080"));
        assertTrue(HostValidator.isOriginAllowed("http://localhost:8080"));
        assertTrue(HostValidator.isOriginAllowed("http://[::1]:8080"));
    }

    @Test
    public void nonLoopbackOriginsAreRejected() {
        assertFalse(HostValidator.isOriginAllowed("http://evil.com:8080"));
        assertFalse(HostValidator.isOriginAllowed("https://192.168.1.5"));
        assertFalse(HostValidator.isOriginAllowed("chrome-extension://abcdefghijklmnop"));
        assertFalse(HostValidator.isOriginAllowed("not-a-url"));
    }
}
