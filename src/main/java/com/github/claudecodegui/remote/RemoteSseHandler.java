package com.github.claudecodegui.remote;

import com.intellij.openapi.diagnostic.Logger;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Long-lived SSE writer for {@code GET /events}.
 *
 * <p>One connection = one {@link RemoteEventSubscriber} on the
 * {@link RemoteEventBus} for the tab. The handler blocks on the subscriber's
 * bounded queue (draining events onto the socket) until the client disconnects,
 * the queue overflows, or the gateway stops.
 *
 * <p>Callback threads never touch the socket — they only
 * {@link RemoteEventSubscriber#offer} into the queue; this handler is the sole
 * socket writer (Phase 2C-B §21). A heartbeat comment is sent when no event
 * flows within {@link RemoteGatewayLimits#SSE_HEARTBEAT_MS}.
 */
final class RemoteSseHandler {

    private static final Logger LOG = Logger.getInstance(RemoteSseHandler.class);

    private final RemoteEventBus bus = RemoteEventBus.getInstance();

    /**
     * Stream events for {@code tabId} until disconnect/overflow/close. The
     * caller must have already validated auth/host/origin/project/tabId.
     *
     * @param gatewayGeneration the owning gateway's immutable generation token. The
     *     subscriber is registered under THIS generation (not a late
     *     {@code bus.currentGeneration()} read); if the bus has already rotated past
     *     it (the owning gateway was disposed), the subscribe is rejected and a 503 is
     *     returned — a Gateway-A SSE handler can never become a Gateway-B subscriber
     *     (Phase 2C-C.1 generation-ownership closure, §3).
     */
    void stream(HttpExchange exchange, String tabId, long gatewayGeneration) throws IOException {
        RemoteEventSubscriber subscriber = bus.subscribe(tabId, gatewayGeneration);
        if (subscriber == null) {
            // Owning generation already disposed — reject rather than re-owning as a
            // newer-generation subscriber.
            byte[] body = RemoteErrors.body(RemoteErrors.Code.GATEWAY_UNAVAILABLE)
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
            exchange.sendResponseHeaders(RemoteErrors.Code.GATEWAY_UNAVAILABLE.status(), body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
            return;
        }
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        exchange.getResponseHeaders().set("Connection", "keep-alive");
        // 0 length => chunked / unknown length: the stream is open-ended.
        exchange.sendResponseHeaders(200, 0);

        try (OutputStream os = exchange.getResponseBody()) {
            // Immediate heartbeat so the client knows the stream is live.
            os.write(RemoteSseEncoder.heartbeat().getBytes(StandardCharsets.UTF_8));
            os.flush();

            while (!subscriber.isClosed()) {
                RemoteEvent event;
                try {
                    event = subscriber.poll(RemoteGatewayLimits.SSE_HEARTBEAT_MS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
                if (event != null) {
                    os.write(RemoteSseEncoder.frame(event).getBytes(StandardCharsets.UTF_8));
                } else {
                    os.write(RemoteSseEncoder.heartbeat().getBytes(StandardCharsets.UTF_8));
                }
                os.flush();

                if (subscriber.isOverflowed()) {
                    os.write(RemoteSseEncoder.frameWithoutId(
                            "stream.overflow", "{\"reason\":\"client too slow\"}")
                            .getBytes(StandardCharsets.UTF_8));
                    os.flush();
                    break;
                }
            }
        } catch (IOException e) {
            // Client disconnected — expected for long-lived SSE.
            LOG.debug("[RemoteGateway] SSE client disconnected for tab " + tabId + ": " + e.getMessage());
        } finally {
            bus.unsubscribe(subscriber);
        }
    }
}
