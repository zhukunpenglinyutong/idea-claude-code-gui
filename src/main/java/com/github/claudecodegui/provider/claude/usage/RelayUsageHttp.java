package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Shared HTTP transport for relay usage probes: one pooled {@link HttpClient},
 * one timeout policy, one User-Agent, and a test seam.
 *
 * <p>Also owns the credential-safety rule for URL derivation: probe URLs are
 * built from the anthropic base URL's origin, and the Bearer token must never
 * travel over plaintext to a remote host — plain HTTP is only allowed for
 * loopback targets (local dev proxies), see {@link #secureOrigin(String)}.
 */
public final class RelayUsageHttp {

    private static final long HTTP_TIMEOUT_MS = 15_000L;
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    /** Test-only seam replacing the real HTTP transport. */
    private static volatile Transport transportOverride;

    private RelayUsageHttp() {
    }

    /** Transport seam — production hits HTTP, tests substitute. */
    public interface Transport {
        JsonObject get(String url, Map<String, String> headers) throws Exception;
    }

    /** GET {@code url} with a Bearer Authorization header. */
    public static JsonObject getJson(String url, String bearerToken) throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", "Bearer " + bearerToken);
        return getJson(url, headers);
    }

    /** GET {@code url} with the given headers (Accept/UA added here). */
    public static JsonObject getJson(String url, Map<String, String> headers) throws Exception {
        Transport override = transportOverride;
        if (override != null) {
            return override.get(url, headers);
        }
        HttpRequest.Builder req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofMillis(HTTP_TIMEOUT_MS))
                .header("Accept", "application/json")
                .header("User-Agent", "jetbrains-cc-gui-relay-usage")
                .GET();
        for (Map.Entry<String, String> h : headers.entrySet()) {
            req.header(h.getKey(), h.getValue());
        }
        HttpResponse<String> resp = HTTP.send(req.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("relay usage HTTP " + resp.statusCode());
        }
        return JsonParser.parseString(resp.body()).getAsJsonObject();
    }

    /**
     * Origin ({@code scheme://host[:port]}) of the anthropic base URL when it is
     * safe to send credentials there — TLS, or plain HTTP for loopback targets
     * only; any custom port is kept. Null when the URL is malformed or unsafe.
     */
    public static String secureOrigin(String baseUrl) {
        try {
            URI u = URI.create(baseUrl);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null) {
                return null;
            }
            boolean loopback = host.equalsIgnoreCase("localhost")
                    || host.equals("127.0.0.1")
                    || host.equals("::1")
                    || host.equals("[::1]");
            if (!"https".equalsIgnoreCase(scheme)
                    && !("http".equalsIgnoreCase(scheme) && loopback)) {
                return null;
            }
            int port = u.getPort();
            String originHost = host.contains(":") && !host.startsWith("[")
                    ? "[" + host + "]"
                    : host;
            return port == -1
                    ? scheme + "://" + originHost
                    : scheme + "://" + originHost + ":" + port;
        } catch (Exception e) {
            return null;
        }
    }

    /** Test-only: replace the HTTP transport. Pass null to restore the real one. */
    public static void setTransportForTests(Transport transport) {
        transportOverride = transport;
    }
}
