package com.github.claudecodegui.remote;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Routes authenticated Remote Gateway HTTP requests to the Phase-1/2A/2B endpoints.
 *
 * <p>Every request passes through a common guard before dispatch:
 * <ol>
 *   <li>Host header must be a loopback literal on the bound port (anti DNS-rebinding).</li>
 *   <li>Origin header, if present, must be a loopback origin.</li>
 *   <li>Authorization must be a valid bearer token matching the gateway token.</li>
 * </ol>
 * Implemented endpoints:
 * <ul>
 *   <li>{@code GET  /api/v1/health}</li>
 *   <li>{@code GET  /api/v1/projects}</li>
 *   <li>{@code GET  /api/v1/status}</li>
 *   <li>{@code GET  /api/v1/projects/{projectId}/tabs}</li>
 *   <li>{@code GET  /api/v1/projects/{projectId}/tabs/{tabId}}</li>
 *   <li>{@code POST /api/v1/projects/{projectId}/tabs/{tabId}/chat}</li>
 * </ul>
 * Anything else returns a canonical JSON error. Method enforcement is per-route:
 * the tab routes are GET-only, the chat sub-resource is POST-only.
 */
final class RemoteApiRouter implements HttpHandler {

    private static final Logger LOG = Logger.getInstance(RemoteApiRouter.class);

    private static final String CONTENT_TYPE_JSON = "application/json; charset=utf-8";

    private static final String TABS_PREFIX = "/api/v1/projects/";
    private static final String TABS_SUFFIX = "/tabs";
    private static final String CHAT_SUFFIX = "chat";
    private static final String EVENTS_SUFFIX = "events";
    private static final String MODE_SUFFIX = "mode";
    private static final String PERMISSIONS_SUFFIX = "permissions";
    private static final String QUESTIONS_SUFFIX = "questions";
    private static final String PLANS_SUFFIX = "plans";
    private static final String TASKS_SUFFIX = "tasks";
    private static final String ACTION_DECISION = "decision";
    private static final String ACTION_ANSWER = "answer";
    private static final String ACTION_ABORT = "abort";

    private final RemoteGatewayService service;
    private final String expectedToken;
    /**
     * The immutable gateway-generation context this router's handlers belong to (Phase
     * 2C-C.1 generation-ownership + turn-start/dispose closure). Captured once at
     * gateway start and carried by every handler; its generation token is bound into
     * tasks/subscribers, and its start/closing boundary serializes turn-start with
     * gateway dispose. Ownership is the handler's, never a late
     * {@code bus.currentGeneration()} snapshot.
     */
    private final RemoteGatewayGeneration generation;
    private final RemoteChatDispatcher dispatcher = new RemoteChatDispatcher();
    private final RemoteSseHandler sseHandler = new RemoteSseHandler();
    private final RemoteControlHandler controlHandler = new RemoteControlHandler();

    RemoteApiRouter(RemoteGatewayService service, String expectedToken, RemoteGatewayGeneration generation) {
        this.service = service;
        this.expectedToken = expectedToken;
        this.generation = generation;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        try {
            handleInternal(exchange);
        } catch (Exception e) {
            // Never leak internals to the client; log full detail server-side.
            LOG.warn("[RemoteGateway] Unhandled error in request handling: " + e.getClass().getSimpleName(), e);
            if (exchange.getResponseCode() < 0) {
                writeJson(exchange, 500, RemoteErrors.body(RemoteErrors.Code.INTERNAL_ERROR));
            }
        } finally {
            exchange.close();
        }
    }

    private void handleInternal(HttpExchange exchange) throws IOException {
        int port = service.getBoundPort();
        if (!HostValidator.isHostAllowed(exchange.getRequestHeaders().getFirst("Host"), port)) {
            writeJson(exchange, 403, RemoteErrors.body(RemoteErrors.Code.FORBIDDEN, "Forbidden host"));
            return;
        }
        if (!HostValidator.isOriginAllowed(exchange.getRequestHeaders().getFirst("Origin"))) {
            writeJson(exchange, 403, RemoteErrors.body(RemoteErrors.Code.FORBIDDEN, "Forbidden origin"));
            return;
        }
        if (!BearerAuth.isAuthorized(exchange.getRequestHeaders().getFirst("Authorization"), expectedToken)) {
            writeJson(exchange, 401, RemoteErrors.body(RemoteErrors.Code.UNAUTHORIZED));
            return;
        }

        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();

        if ("/api/v1/health".equals(path)) {
            requireGet(exchange, method, this::buildHealth);
            return;
        }
        if ("/api/v1/projects".equals(path)) {
            requireGet(exchange, method, this::buildProjects);
            return;
        }
        if ("/api/v1/status".equals(path)) {
            requireGet(exchange, method, this::buildStatus);
            return;
        }

        TabRouteMatch match = matchTabRoute(path);
        if (match == null) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND));
            return;
        }
        if (!match.shapeValid) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid projectId"));
            return;
        }

        if (CHAT_SUFFIX.equals(match.suffix)) {
            if (!"POST".equalsIgnoreCase(method)) {
                writeJson(exchange, 405, RemoteErrors.body(RemoteErrors.Code.METHOD_NOT_ALLOWED));
                return;
            }
            handleChatRoute(exchange, match);
            return;
        }

        if (EVENTS_SUFFIX.equals(match.suffix)) {
            if (!"GET".equalsIgnoreCase(method)) {
                writeJson(exchange, 405, RemoteErrors.body(RemoteErrors.Code.METHOD_NOT_ALLOWED));
                return;
            }
            handleEventsRoute(exchange, match);
            return;
        }

        if (MODE_SUFFIX.equals(match.suffix)) {
            handleModeRoute(exchange, match, method);
            return;
        }

        if (PERMISSIONS_SUFFIX.equals(match.suffix)
                || QUESTIONS_SUFFIX.equals(match.suffix)
                || PLANS_SUFFIX.equals(match.suffix)
                || TASKS_SUFFIX.equals(match.suffix)) {
            if (!"POST".equalsIgnoreCase(method)) {
                writeJson(exchange, 405, RemoteErrors.body(RemoteErrors.Code.METHOD_NOT_ALLOWED));
                return;
            }
            handleControlRoute(exchange, match);
            return;
        }

        // Tab list / single-tab routes are GET-only.
        if (!"GET".equalsIgnoreCase(method)) {
            writeJson(exchange, 405, RemoteErrors.body(RemoteErrors.Code.METHOD_NOT_ALLOWED));
            return;
        }
        handleTabRoute(exchange, match);
    }

    /** Send 405 unless the method is GET; otherwise write the GET response body. */
    @FunctionalInterface
    private interface BodySupplier {
        String build() throws IOException;
    }

    private void requireGet(HttpExchange exchange, String method, BodySupplier supplier) throws IOException {
        if (!"GET".equalsIgnoreCase(method)) {
            writeJson(exchange, 405, RemoteErrors.body(RemoteErrors.Code.METHOD_NOT_ALLOWED));
            return;
        }
        writeJson(exchange, 200, supplier.build());
    }

    /**
     * Parse the tab-route shapes:
     * <ul>
     *   <li>{@code /api/v1/projects/{projectId}/tabs}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/chat}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/events}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/mode}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/permissions/{interactionId}/decision}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/questions/{interactionId}/answer}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/plans/{interactionId}/decision}</li>
     *   <li>{@code /api/v1/projects/{projectId}/tabs/{tabId}/tasks/{taskId}/abort}</li>
     * </ul>
     * Returns null if the path does not match any known shape.
     */
    static TabRouteMatch matchTabRoute(String path) {
        if (path == null || !path.startsWith(TABS_PREFIX) || path.length() <= TABS_PREFIX.length()) {
            return null;
        }
        String rest = path.substring(TABS_PREFIX.length());
        int slash = rest.indexOf('/');
        if (slash < 0) {
            // /api/v1/projects/{projectId} with no /tabs suffix -> not a tab route.
            return null;
        }
        String projectId = rest.substring(0, slash);
        String after = rest.substring(slash);
        if (!after.startsWith(TABS_SUFFIX)) {
            return null;
        }
        // Reject projectIds that cannot be a valid RemoteProjectId (32 lowercase hex).
        if (!isValidProjectId(projectId)) {
            return new TabRouteMatch(projectId, null, false, null, null, null);
        }
        if (after.length() == TABS_SUFFIX.length()) {
            return new TabRouteMatch(projectId, null, true, null, null, null);
        }
        // /tabs/{tabId} or /tabs/{tabId}/{sub-resource...}
        if (after.charAt(TABS_SUFFIX.length()) == '/') {
            String rest2 = after.substring(TABS_SUFFIX.length() + 1);
            int slash2 = rest2.indexOf('/');
            if (slash2 < 0) {
                // /tabs/{tabId}
                return new TabRouteMatch(projectId, rest2, true, null, null, null);
            }
            String tabId = rest2.substring(0, slash2);
            String suffix = rest2.substring(slash2 + 1);
            return parseSuffix(projectId, tabId, suffix);
        }
        return null;
    }

    /**
     * Parse the sub-resource trail after {@code /tabs/{tabId}/}. Returns null
     * for any unrecognized shape (caller returns 404).
     */
    private static TabRouteMatch parseSuffix(String projectId, String tabId, String suffix) {
        // Simple single-segment sub-resources.
        if (CHAT_SUFFIX.equals(suffix)) {
            return new TabRouteMatch(projectId, tabId, true, CHAT_SUFFIX, null, null);
        }
        if (EVENTS_SUFFIX.equals(suffix)) {
            return new TabRouteMatch(projectId, tabId, true, EVENTS_SUFFIX, null, null);
        }
        if (MODE_SUFFIX.equals(suffix)) {
            return new TabRouteMatch(projectId, tabId, true, MODE_SUFFIX, null, null);
        }
        // {resource}/{id}/{action} sub-resources.
        int firstSlash = suffix.indexOf('/');
        if (firstSlash <= 0) {
            return null;
        }
        String resource = suffix.substring(0, firstSlash);
        String afterResource = suffix.substring(firstSlash + 1);
        int secondSlash = afterResource.indexOf('/');
        if (secondSlash <= 0 || secondSlash == afterResource.length() - 1) {
            return null;
        }
        String resourceId = afterResource.substring(0, secondSlash);
        String action = afterResource.substring(secondSlash + 1);
        // No further trailing segment allowed.
        if (action.indexOf('/') >= 0) {
            return null;
        }
        if (PERMISSIONS_SUFFIX.equals(resource) && ACTION_DECISION.equals(action)) {
            return new TabRouteMatch(projectId, tabId, true, PERMISSIONS_SUFFIX, resourceId, ACTION_DECISION);
        }
        if (QUESTIONS_SUFFIX.equals(resource) && ACTION_ANSWER.equals(action)) {
            return new TabRouteMatch(projectId, tabId, true, QUESTIONS_SUFFIX, resourceId, ACTION_ANSWER);
        }
        if (PLANS_SUFFIX.equals(resource) && ACTION_DECISION.equals(action)) {
            return new TabRouteMatch(projectId, tabId, true, PLANS_SUFFIX, resourceId, ACTION_DECISION);
        }
        if (TASKS_SUFFIX.equals(resource) && ACTION_ABORT.equals(action)) {
            return new TabRouteMatch(projectId, tabId, true, TASKS_SUFFIX, resourceId, ACTION_ABORT);
        }
        return null;
    }

    private static boolean isValidProjectId(String projectId) {
        return projectId != null && projectId.matches("[0-9a-f]{32}");
    }

    /** tabId is a UUID assigned by RemoteTabRegistry. Package-private for tests. */
    static boolean isValidTabId(String tabId) {
        return tabId != null
                && tabId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    }

    private void handleTabRoute(HttpExchange exchange, TabRouteMatch match) throws IOException {
        if (match.tabId != null && !isValidTabId(match.tabId)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid tabId"));
            return;
        }
        Project project = service.findProjectById(match.projectId);
        if (project == null) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Project not found"));
            return;
        }
        List<RemoteTabSnapshot> tabs = service.collectTabs(project);
        if (match.tabId == null) {
            writeJson(exchange, 200, buildTabsEnvelope(match.projectId, tabs));
        } else {
            RemoteTabSnapshot found = null;
            for (RemoteTabSnapshot t : tabs) {
                if (match.tabId.equals(t.getTabId())) {
                    found = t;
                    break;
                }
            }
            if (found == null) {
                writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Tab not found"));
            } else {
                writeJson(exchange, 200, found.toJson().toString());
            }
        }
    }

    private void handleChatRoute(HttpExchange exchange, TabRouteMatch match) throws IOException {
        if (!isValidTabId(match.tabId)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid tabId"));
            return;
        }
        Project project = service.findProjectById(match.projectId);
        if (project == null) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Project not found"));
            return;
        }

        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (!isJsonContentType(contentType)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Unsupported content type"));
            return;
        }

        byte[] body;
        try {
            body = BoundedBodyReader.read(exchange.getRequestBody());
        } catch (PayloadTooLargeException e) {
            writeJson(exchange, 413, RemoteErrors.body(RemoteErrors.Code.PAYLOAD_TOO_LARGE));
            return;
        } catch (IOException e) {
            LOG.warn("[RemoteGateway] Chat body read error: " + e.getMessage());
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid body"));
            return;
        }

        RemoteChatRequest.Result parsed = RemoteChatRequest.parse(body);
        if (!parsed.isValid()) {
            // parsed error message is generic; never echoes the body.
            writeJson(exchange, 400, RemoteErrors.body(parsed.getErrorCode(), parsed.getErrorMessage()));
            return;
        }

        RemoteChatResult result = dispatcher.dispatch(project, match.tabId, parsed.getMessage(),
                generation);
        switch (result.status) {
            case ACCEPTED:
                writeJson(exchange, 202, result.toAcceptedJson(match.projectId, match.tabId));
                return;
            case NOT_FOUND:
                writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Tab not found"));
                return;
            case BUSY:
                writeJson(exchange, 409, RemoteErrors.body(RemoteErrors.Code.TAB_BUSY));
                return;
            case TIMEOUT:
                writeJson(exchange, 500, RemoteErrors.body(RemoteErrors.Code.INTERNAL_ERROR, "Tab resolution timed out"));
                return;
            case UNAVAILABLE:
                writeJson(exchange, 503, RemoteErrors.body(RemoteErrors.Code.GATEWAY_UNAVAILABLE));
                return;
            case INTERNAL_ERROR:
            default:
                writeJson(exchange, 500, RemoteErrors.body(RemoteErrors.Code.INTERNAL_ERROR));
                return;
        }
    }

    private void handleEventsRoute(HttpExchange exchange, TabRouteMatch match) throws IOException {
        if (!isValidTabId(match.tabId)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid tabId"));
            return;
        }
        Project project = service.findProjectById(match.projectId);
        if (project == null) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Project not found"));
            return;
        }
        RemoteTabResolver.ResolveResult resolved = RemoteTabResolver.resolve(project, match.tabId);
        switch (resolved.status) {
            case FOUND:
                break;
            case TIMEOUT:
                writeJson(exchange, 500, RemoteErrors.body(RemoteErrors.Code.INTERNAL_ERROR, "Tab resolution timed out"));
                return;
            case NOT_FOUND:
            default:
                writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Tab not found"));
                return;
        }
        // Long-lived SSE: blocks until disconnect/overflow/close. Subscribed under this
        // gateway's generation token; a stale (disposed-generation) handler is rejected.
        sseHandler.stream(exchange, match.tabId, generation.generation());
    }

    /**
     * Handle {@code GET/PUT .../tabs/{tabId}/mode} (Phase 2C-C §23, §24).
     */
    private void handleModeRoute(HttpExchange exchange, TabRouteMatch match, String method) throws IOException {
        if (!isValidTabId(match.tabId)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid tabId"));
            return;
        }
        Project project = service.findProjectById(match.projectId);
        if (project == null) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Project not found"));
            return;
        }
        if ("GET".equalsIgnoreCase(method)) {
            writeOutcome(exchange, controlHandler.getMode(project, match.projectId, match.tabId));
            return;
        }
        if ("PUT".equalsIgnoreCase(method)) {
            byte[] body = readControlBody(exchange);
            if (body == null) {
                return; // readControlBody already wrote the error response
            }
            writeOutcome(exchange, controlHandler.setMode(project, match.projectId, match.tabId, body));
            return;
        }
        writeJson(exchange, 405, RemoteErrors.body(RemoteErrors.Code.METHOD_NOT_ALLOWED));
    }

    /**
     * Handle the POST control sub-resources: permission/ask/plan decision and
     * task abort (Phase 2C-C §6, §17).
     */
    private void handleControlRoute(HttpExchange exchange, TabRouteMatch match) throws IOException {
        if (!isValidTabId(match.tabId)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid tabId"));
            return;
        }
        Project project = service.findProjectById(match.projectId);
        if (project == null) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, "Project not found"));
            return;
        }
        if (match.resourceId == null || match.resourceId.isEmpty()) {
            writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND));
            return;
        }

        if (TASKS_SUFFIX.equals(match.suffix)) {
            // Abort takes no body; resourceId is the taskId.
            writeOutcome(exchange, controlHandler.abortTask(project, match.projectId, match.tabId, match.resourceId));
            return;
        }

        byte[] body = readControlBody(exchange);
        if (body == null) {
            return; // readControlBody already wrote the error response
        }
        RemoteControlHandler.Outcome outcome;
        switch (match.suffix) {
            case PERMISSIONS_SUFFIX:
                outcome = controlHandler.decidePermission(project, match.projectId, match.tabId,
                        match.resourceId, body);
                break;
            case QUESTIONS_SUFFIX:
                outcome = controlHandler.answerQuestion(project, match.projectId, match.tabId,
                        match.resourceId, body);
                break;
            case PLANS_SUFFIX:
                outcome = controlHandler.decidePlan(project, match.projectId, match.tabId,
                        match.resourceId, body);
                break;
            default:
                writeJson(exchange, 404, RemoteErrors.body(RemoteErrors.Code.NOT_FOUND));
                return;
        }
        writeOutcome(exchange, outcome);
    }

    /**
     * Read a bounded control-endpoint body. Returns null (after writing a 400/413
     * response) on error so the caller knows not to proceed.
     */
    private byte[] readControlBody(HttpExchange exchange) throws IOException {
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        // Body optional for some control endpoints; allow missing content-type only
        // when the body is empty. POST/PUT with a JSON body must declare JSON.
        byte[] body;
        try {
            body = BoundedBodyReader.read(exchange.getRequestBody(), RemoteGatewayLimits.MAX_CONTROL_BODY_BYTES);
        } catch (PayloadTooLargeException e) {
            writeJson(exchange, 413, RemoteErrors.body(RemoteErrors.Code.PAYLOAD_TOO_LARGE));
            return null;
        } catch (IOException e) {
            LOG.warn("[RemoteGateway] control body read error: " + e.getMessage());
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Invalid body"));
            return null;
        }
        if (body.length == 0) {
            return body;
        }
        if (!isJsonContentType(contentType)) {
            writeJson(exchange, 400, RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "Unsupported content type"));
            return null;
        }
        return body;
    }

    private static void writeOutcome(HttpExchange exchange, RemoteControlHandler.Outcome outcome) throws IOException {
        writeJson(exchange, outcome.status, outcome.body);
    }

    private static boolean isJsonContentType(String contentType) {
        if (contentType == null) {
            return false;
        }
        String ct = contentType.trim().toLowerCase();
        if (ct.isEmpty()) {
            return false;
        }
        int semi = ct.indexOf(';');
        String mime = (semi >= 0) ? ct.substring(0, semi).trim() : ct;
        return "application/json".equals(mime);
    }

    private static String buildTabsEnvelope(String projectId, List<RemoteTabSnapshot> tabs) {
        JsonArray arr = new JsonArray();
        for (RemoteTabSnapshot t : tabs) {
            arr.add(t.toJson());
        }
        JsonObject envelope = new JsonObject();
        envelope.addProperty("projectId", projectId);
        envelope.add("tabs", arr);
        return envelope.toString();
    }

    /** Parsed tab-route path. {@code shapeValid=false} means the projectId was malformed. */
    static final class TabRouteMatch {
        final String projectId;
        final String tabId;   // null for the list endpoint
        final boolean shapeValid;
        final String suffix;  // null, "chat", "events", "mode", "permissions", "questions", "plans", "tasks"
        final String resourceId;  // interactionId (perm/ask/plan) or taskId (abort); null otherwise
        final String action;      // "decision"/"answer"/"abort" for the deep sub-resources; null otherwise

        TabRouteMatch(String projectId, String tabId, boolean shapeValid, String suffix,
                      String resourceId, String action) {
            this.projectId = projectId;
            this.tabId = tabId;
            this.shapeValid = shapeValid;
            this.suffix = suffix;
            this.resourceId = resourceId;
            this.action = action;
        }
    }

    private String buildHealth() {
        JsonObject obj = new JsonObject();
        obj.addProperty("status", "ok");
        obj.addProperty("gatewayVersion", 1);
        obj.addProperty("pluginVersion", service.getPluginVersion());
        obj.addProperty("ide", service.getIdeName());
        obj.addProperty("ideBuild", service.getIdeBuild());
        obj.addProperty("bridgeReady", service.isBridgeReady());
        return obj.toString();
    }

    private String buildProjects() {
        List<RemoteProjectSnapshot> projects = service.listProjects();
        JsonArray arr = new JsonArray();
        for (RemoteProjectSnapshot p : projects) {
            arr.add(p.toJson());
        }
        JsonObject envelope = new JsonObject();
        envelope.add("projects", arr);
        return envelope.toString();
    }

    private String buildStatus() {
        JsonObject obj = new JsonObject();
        obj.addProperty("enabled", service.isEnabled());
        obj.addProperty("host", RemoteGatewayService.HOST);
        obj.addProperty("port", service.getBoundPort());
        obj.addProperty("openProjectCount", service.listProjects().size());
        obj.addProperty("bridgeReady", service.isBridgeReady());
        return obj.toString();
    }

    private static void writeJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", CONTENT_TYPE_JSON);
        // No CORS header is ever set; the gateway is non-browser only.
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
