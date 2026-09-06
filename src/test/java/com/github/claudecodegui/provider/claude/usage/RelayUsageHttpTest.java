package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.util.Map;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class RelayUsageHttpTest {

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    @Test
    public void secureOrigin_httpsOriginKeptPortAndPathDropped() {
        assertEquals("https://api.z.ai", RelayUsageHttp.secureOrigin("https://api.z.ai/api/anthropic"));
        assertEquals("https://proxy.corp:8443", RelayUsageHttp.secureOrigin("https://proxy.corp:8443/anthropic"));
    }

    @Test
    public void secureOrigin_plainHttpOnlyForLoopback() {
        assertEquals("http://localhost:8080", RelayUsageHttp.secureOrigin("http://localhost:8080/api"));
        assertEquals("http://127.0.0.1:9000", RelayUsageHttp.secureOrigin("http://127.0.0.1:9000/api"));
        assertEquals("http://[::1]:8080", RelayUsageHttp.secureOrigin("http://[::1]:8080/api"));
        assertEquals("https://[::1]:8443", RelayUsageHttp.secureOrigin("https://[::1]:8443/api"));
        assertNull(RelayUsageHttp.secureOrigin("http://[2001:db8::1]:8080/api"));
        assertNull(RelayUsageHttp.secureOrigin("http://evil.com"));
    }

    @Test
    public void getJson_addsBearerAndPreservesHeaders() throws Exception {
        String[] seenUrl = {null};
        Map<String, String>[] seenHeaders = new Map[]{null};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seenUrl[0] = url;
            seenHeaders[0] = headers;
            return new JsonObject();
        });

        RelayUsageHttp.getJson("https://api.example.test/usage", "secret");
        assertEquals("https://api.example.test/usage", seenUrl[0]);
        assertEquals("Bearer secret", seenHeaders[0].get("Authorization"));
    }

    @Test
    public void secureOrigin_malformedYieldsNull() {
        assertNull(RelayUsageHttp.secureOrigin(null));
        assertNull(RelayUsageHttp.secureOrigin("not a url"));
        assertNull(RelayUsageHttp.secureOrigin("api.z.ai")); // no scheme
    }
}
