# Streaming Event Logs And Replay Fixtures

## Purpose

Streaming rendering bugs are hard to diagnose from screenshots or final messages. Provider integrations should be able to capture the exact event stream that produced a bad UI state, then turn that capture into a replayable test fixture.

This should be part of the opencode preparation work and should apply to existing providers as well as new ones.

## Goals

- Capture raw provider events before normalization.
- Capture normalized `chat_event` records after provider mapping.
- Capture legacy markers while the compatibility path still exists.
- Preserve event order with a monotonically increasing sequence number.
- Redact secrets and volatile machine-specific data by default.
- Make captured logs easy to promote into fixture tests.
- Support both live-stream reproduction and restored-history reproduction.

## Non-Goals

- Do not log API keys, auth tokens, request headers, or raw environment variables.
- Do not always persist logs; event capture should be opt-in or scoped to debug mode.
- Do not make logs the primary storage format for user history.
- Do not require every provider to expose identical raw event payloads.

## Capture Points

Each provider should support these capture stages where practical:

| Stage | Meaning | Examples |
| --- | --- | --- |
| `native_in` | Raw provider event received by the bridge | opencode `/event`, Codex `item.completed`, Claude SDK event |
| `normalized_out` | Provider event after mapping to `chat_event` | `kind: tool`, `phase: completed` |
| `legacy_out` | Compatibility marker emitted for current handlers | `[CONTENT_DELTA]`, `[MESSAGE]` |
| `handler_in` | Java handler receives marker or event | callback line or parsed message |
| `render_in` | Webview accumulator receives event | optional frontend fixture capture |

For the first infrastructure pass, `native_in`, `normalized_out`, and `legacy_out` provide the highest value.

## Log Format

Use newline-delimited JSON so logs can be streamed, sliced, redacted, and replayed without loading a large array.

Each line should be one envelope:

```json
{
  "schemaVersion": 1,
  "captureId": "cap_2026_06_14_001",
  "sequence": 42,
  "timestamp": "2026-06-14T12:00:00.000Z",
  "provider": "opencode",
  "sessionId": "ses_123",
  "turnId": "turn_1",
  "stage": "normalized_out",
  "eventType": "chat_event",
  "payload": {
    "type": "chat_event",
    "kind": "tool",
    "phase": "completed",
    "toolCallId": "call_abc"
  },
  "redactions": []
}
```

Recommended envelope fields:

- `schemaVersion`: log format version.
- `captureId`: stable ID shared by all lines from one captured run.
- `sequence`: monotonic integer assigned by the bridge capture utility.
- `timestamp`: ISO timestamp for diagnostics only; replay should use `sequence`.
- `provider`: provider ID such as `claude`, `codex`, or `opencode`.
- `sessionId`: provider session/thread ID when known.
- `turnId`: normalized turn ID when known.
- `stage`: capture stage.
- `eventType`: native event type, marker name, or `chat_event`.
- `payload`: captured event payload after redaction.
- `redactions`: list of fields or patterns that were redacted.

Optional fields:

- `model`
- `agent`
- `permissionMode`
- `cwdHash`
- `projectHash`
- `source`: file/module/function that emitted the capture line
- `notes`: short diagnostic hint added by the capture utility

## Redaction Rules

Default redaction should remove or normalize:

- API keys, auth tokens, cookies, passwords, and request headers.
- Full environment maps.
- Absolute home-directory paths, replaced with stable placeholders such as `<HOME>`.
- Project root paths, replaced with `<PROJECT>`.
- Temporary directory paths, replaced with `<TMP>`.
- Large binary attachment payloads, replaced with metadata.
- Very large tool outputs, truncated with original length preserved.

Text content should not be blindly removed because rendering bugs often depend on exact text, whitespace, or ordering. Instead, fixture promotion should allow an explicit sanitization step when logs contain private content.

## Replay Modes

Captured logs should support at least two replay modes:

1. `native_in` replay: feed raw provider events into the provider normalizer and assert produced `chat_event` records.
2. `normalized_out` replay: feed `chat_event` records into the frontend accumulator and assert render groups.

Legacy marker replay can remain useful during migration:

3. `legacy_out` replay: feed compatibility markers into current Java/webview handlers and assert no regression.

## Fixture Promotion

A captured log should be convertible into a test fixture by removing volatile fields and keeping ordered payloads.

Suggested workflow:

1. Enable streaming event capture for a provider run.
2. Reproduce the rendering issue.
3. Save the captured JSONL file.
4. Run a fixture sanitizer that removes timestamps, machine paths, capture IDs, and private text when needed.
5. Check in the minimized fixture under provider-specific tests.
6. Add a regression test that replays the fixture into the normalizer or accumulator.

Example fixture shape:

```json
{
  "name": "opencode-tool-result-before-text-boundary",
  "provider": "opencode",
  "source": "streaming-log",
  "events": [
    {
      "sequence": 1,
      "stage": "native_in",
      "eventType": "message.part.delta",
      "payload": { "field": "text", "text": "Running" }
    },
    {
      "sequence": 2,
      "stage": "normalized_out",
      "eventType": "chat_event",
      "payload": { "kind": "text", "phase": "delta", "text": "Running" }
    }
  ]
}
```

## Provider Requirements

Existing and new providers should use the same capture utility rather than ad hoc `console.log` debugging.

Minimum requirement for each provider:

- Capture raw incoming stream events at `native_in`.
- Capture emitted `chat_event` records at `normalized_out`.
- Capture emitted compatibility markers at `legacy_out` while those markers exist.
- Share the same redaction utility.
- Include capture tests that prove logs can be replayed or promoted into fixtures.

## Opencode-Specific Notes

For opencode, capture should start before session creation or prompt submission because `/event` is shared and the bridge subscribes before sending prompts.

Useful raw events to capture:

- `message.part.delta`
- `message.part.updated`
- `message.updated`
- `permission.asked`
- `permission.replied`
- `question.asked`
- `session.diff`
- `session.error`

Useful metadata to preserve:

- opencode `sessionID`
- message ID
- part ID
- tool call ID when available
- permission/question request ID
- child session ID for task/subagent runs

## Acceptance Checks

- A shared capture envelope schema is documented and versioned.
- Capture can be enabled for Claude, Codex, and opencode without changing provider logic.
- Captured logs contain raw provider events, normalized `chat_event` records, and legacy markers during migration.
- Captured logs are redacted by default.
- A captured log can be sanitized into a deterministic fixture.
- At least one regression test replays a captured fixture into the normalizer or frontend accumulator.
