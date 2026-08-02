package com.github.claudecodegui.wechat;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Loopback-only authenticated client for the Adapter control API (M9 §5).
 * The token lives only in this JVM memory and is never sent to the webview.
 */
public final class WechatControlClient implements WechatControlApi {
    private final String baseUrl;
    private final String token;
    private final HttpClient http;
    private final Duration timeout;

    public WechatControlClient(String baseUrl, String token, Duration timeout) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    @Override
    public JsonObject status() throws WechatControlException {
        return request("GET", "/control/v1/status", null, null);
    }

    @Override
    public JsonObject loginStart() throws WechatControlException {
        return request("POST", "/control/v1/login/start", null, null);
    }

    @Override
    public JsonObject loginStatus(String loginId) throws WechatControlException {
        return request("GET", "/control/v1/login/" + loginId + "/status", null, null);
    }

    @Override
    public byte[] loginQr(String loginId) throws WechatControlException {
        try {
            HttpRequest request = build("GET", "/control/v1/login/" + loginId + "/qr", null);
            HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() == 200) {
                byte[] body = response.body();
                if (body.length > 128 * 1024) {
                    throw new WechatControlException(413, "QR_TOO_LARGE", "QR payload too large");
                }
                return body;
            }
            throw parseError(response.statusCode(), new String(response.body(), java.nio.charset.StandardCharsets.UTF_8));
        } catch (WechatControlException err) {
            throw err;
        } catch (Exception err) {
            throw new WechatControlException(0, "CONTROL_UNREACHABLE", err.getMessage());
        }
    }

    @Override
    public boolean loginVerify(String loginId, String code) throws WechatControlException {
        JsonObject body = new JsonObject();
        body.addProperty("code", code);
        request("POST", "/control/v1/login/" + loginId + "/verify", body, null);
        return true;
    }

    @Override
    public boolean loginCancel(String loginId) throws WechatControlException {
        request("POST", "/control/v1/login/" + loginId + "/cancel", null, null);
        return true;
    }

    @Override
    public void bind(String projectId, String tabId) throws WechatControlException {
        JsonObject body = new JsonObject();
        body.addProperty("projectId", projectId);
        body.addProperty("tabId", tabId);
        request("PUT", "/control/v1/binding", body, null);
    }

    @Override
    public void unbind() throws WechatControlException {
        request("DELETE", "/control/v1/binding", null, null);
    }

    @Override
    public void logout() throws WechatControlException {
        request("POST", "/control/v1/logout", null, null);
    }

    private JsonObject request(String method, String path, JsonObject body, Object unused)
            throws WechatControlException {
        try {
            HttpRequest request = build(method, path, body);
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            String text = response.body();
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                if (text == null || text.isEmpty()) {
                    return new JsonObject();
                }
                return JsonParser.parseString(text).getAsJsonObject();
            }
            throw parseError(response.statusCode(), text);
        } catch (WechatControlException err) {
            throw err;
        } catch (Exception err) {
            throw new WechatControlException(0, "CONTROL_UNREACHABLE", err.getMessage());
        }
    }

    private HttpRequest build(String method, String path, JsonObject body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .header("Authorization", "Bearer " + token)
                .timeout(timeout);
        if ("GET".equals(method)) {
            builder.GET();
        } else {
            builder.method(method, body == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(body.toString()));
        }
        return builder.build();
    }

    private static WechatControlException parseError(int status, String text) {
        try {
            JsonObject parsed = JsonParser.parseString(text).getAsJsonObject();
            JsonObject error = parsed.getAsJsonObject("error");
            if (error != null) {
                String code = error.has("code") ? error.get("code").getAsString() : "CONTROL_ERROR";
                String message = error.has("message") ? error.get("message").getAsString() : "Control error";
                return new WechatControlException(status, code, message);
            }
        } catch (RuntimeException ignored) {
            // Fall through to generic error.
        }
        return new WechatControlException(status, "CONTROL_ERROR", "HTTP " + status);
    }
}
