package com.github.claudecodegui.handler.core;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Message dispatcher.
 * Routes messages to the appropriate handler for processing.
 *
 * <p>The handler list is a {@link CopyOnWriteArrayList} so {@link #dispatch} (which runs on the
 * JCEF UI thread from {@code handleJavaScriptMessage}) never races {@link #clear()} (which runs on
 * the EDT during {@code dispose}). This removes the last reason to hold the host window monitor
 * while dispatching, keeping the JCEF UI thread free to render and process mouse selection.</p>
 */
public class MessageDispatcher {

    private final List<MessageHandler> handlers = new CopyOnWriteArrayList<>();

    /**
     * Register a message handler.
     */
    public void registerHandler(MessageHandler handler) {
        handlers.add(handler);
    }

    /**
     * Dispatch a message to the appropriate handler.
     * @param type the message type
     * @param content the message content
     * @return true if the message was handled, false if no handler could process it
     */
    public boolean dispatch(String type, String content) {
        for (MessageHandler handler : handlers) {
            if (handler.handle(type, content)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check whether any handler supports the given message type.
     */
    public boolean hasHandlerFor(String type) {
        for (MessageHandler handler : handlers) {
            for (String supported : handler.getSupportedTypes()) {
                if (supported.equals(type)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Get the number of registered handlers.
     */
    public int getHandlerCount() {
        return handlers.size();
    }

    /**
     * Clear all registered handlers.
     */
    public void clear() {
        handlers.clear();
    }
}
