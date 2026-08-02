package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.ClaudeSession;

import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tracks visible assistant text emitted for one Remote task.
 *
 * <p>Claude providers can expose assistant output through either incremental
 * {@code content_delta} callbacks or full {@code onMessageUpdate} snapshots.
 * Some daemon/model combinations only produce the snapshot path. This tracker
 * merges both sources into one append-only stream so Remote SSE receives the
 * text exactly once without replaying history from earlier turns.
 *
 * <p>Replay shapes covered (Core Freeze Amendment 2026-08-01 and the
 * X + suffix-of-X variant): a provider may re-send the same message content
 * ({@code X -> X+X}), a prefix of it ({@code X -> X + prefix-of-X}), or a
 * suffix of it ({@code X -> X + suffix-of-X}). None of these may be emitted a
 * second time, while genuine continuations still flow.
 */
final class RemoteAssistantContentTracker {

    private int baselineMessageCount;
    private final StringBuilder observedDeltaText = new StringBuilder();
    private final Map<ClaudeSession.Message, String> lastSnapshotByMessage = new IdentityHashMap<>();
    private String emittedText = "";

    /**
     * Mark all messages currently in the session as pre-task history.
     */
    synchronized void markBaseline(List<ClaudeSession.Message> messages) {
        baselineMessageCount = messages != null ? messages.size() : 0;
        observedDeltaText.setLength(0);
        lastSnapshotByMessage.clear();
        emittedText = "";
    }

    /**
     * Consume a provider delta and return only text not already emitted by a
     * preceding full-message snapshot.
     */
    synchronized String consumeDelta(String delta) {
        if (delta == null || delta.isEmpty()) {
            return "";
        }
        observedDeltaText.append(delta);
        String observed = observedDeltaText.toString();
        if (emittedText.startsWith(observed)) {
            return "";
        }
        if (!observed.startsWith(emittedText)) {
            // Not a continuation of the emitted stream: drop the observation
            // and reset the buffer so a later continuation delta is accepted.
            resetObservedToEmitted();
            return "";
        }
        String novel = observed.substring(emittedText.length());
        if (!novel.isEmpty() && (emittedText.startsWith(novel) || emittedText.endsWith(novel))) {
            // Protocol replay: the provider re-sent a prefix (X + prefix-of-X)
            // or a suffix (X + suffix-of-X) of already-emitted text. Drop it
            // and reset (Core Freeze Amendment 2026-08-01: assistant.content
            // must be append-only per task).
            resetObservedToEmitted();
            return "";
        }
        emittedText = observed;
        return novel;
    }

    /**
     * Consume a full message-list snapshot and return the newly visible
     * assistant suffix belonging to this task. Thinking content is excluded
     * because {@link ClaudeSession.Message#content} contains visible text only.
     */
    synchronized String consumeSnapshot(List<ClaudeSession.Message> messages) {
        if (messages == null || messages.size() <= baselineMessageCount) {
            return "";
        }
        StringBuilder current = new StringBuilder();
        for (int i = baselineMessageCount; i < messages.size(); i++) {
            ClaudeSession.Message message = messages.get(i);
            if (message != null
                    && message.type == ClaudeSession.Message.Type.ASSISTANT
                    && message.content != null) {
                String content = message.content;
                String previous = lastSnapshotByMessage.get(message);
                if (previous != null && !previous.isEmpty()) {
                    if (content.equals(previous + previous)) {
                        // Non-streaming Claude emits a complete [MESSAGE] snapshot
                        // and then repeats the same full block as [CONTENT]. The
                        // session handler temporarily appends both to the same
                        // Message object. Collapse this exact same-object X -> X+X
                        // protocol replay.
                        content = previous;
                    } else if (content.startsWith(previous)) {
                        String extension = content.substring(previous.length());
                        if (!extension.isEmpty()
                                && (previous.startsWith(extension) || previous.endsWith(extension))) {
                            // Partial replay: the message grew by a prefix
                            // (X + prefix-of-X) or a suffix (X + suffix-of-X)
                            // of its own previous text. Keep the original
                            // content and do not move the per-message baseline,
                            // so a genuine later extension is still emitted
                            // (Core Freeze Amendment 2026-08-01).
                            content = previous;
                        } else {
                            lastSnapshotByMessage.put(message, content);
                        }
                    } else {
                        lastSnapshotByMessage.put(message, content);
                    }
                } else {
                    lastSnapshotByMessage.put(message, content);
                }
                current.append(content);
            }
        }
        String snapshotText = current.toString();
        if (emittedText.startsWith(snapshotText)) {
            return "";
        }
        if (!snapshotText.startsWith(emittedText)) {
            return "";
        }
        String novel = snapshotText.substring(emittedText.length());
        if (!novel.isEmpty()
                && (emittedText.startsWith(novel) || emittedText.endsWith(novel))) {
            // Safety net: the candidate extension overlaps already-emitted text
            // as a prefix or suffix (message identity may change across
            // updates, so the per-message collapse above cannot always catch
            // the replay).
            return "";
        }
        emittedText = snapshotText;
        return novel;
    }

    private void resetObservedToEmitted() {
        observedDeltaText.setLength(0);
        observedDeltaText.append(emittedText);
    }

}
