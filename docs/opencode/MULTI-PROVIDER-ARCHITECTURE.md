# Opencode Multi-Provider Architecture

## Purpose

This document updates the older Codex-era multi-provider architecture for opencode and other structured providers.

The Codex-era architecture was good at adding providers that could be projected into a small set of message markers. Opencode needs the same explicit provider boundaries, but it also needs a richer shared event plane so provider adapters do not each reinvent streaming merge, tool lifecycle, permission, diff, and history logic.

## Design Principles

1. Keep provider boundaries explicit.
2. Keep provider-specific runtime ownership in provider adapters.
3. Normalize structured runtime events into a shared `chat_event` stream.
4. Capture streaming events in a replayable log format for debugging and test generation.
5. Keep `ClaudeMessage` compatibility during migration.
6. Make live streaming and restored history use the same logical event model.

## Architecture Overview

```text
Java Layer
  ClaudeSDKBridge
    provider: claude
    session identity: sessionId
    runtime: Claude Agent SDK / Claude Code

  CodexSDKBridge
    provider: codex
    session identity: thread/session id
    runtime: Codex bridge

  OpenCodeSDKBridge
    provider: opencode
    session identity: opencode sessionID
    runtime: @opencode-ai/sdk + opencode serve

        |
        | stdin JSON / process output / callback protocol
        v

Node ai-bridge
  channel-manager.js
    routes by provider: claude | codex | opencode

  channels/
    claude-channel.js
    codex-channel.js
    opencode-channel.js

  services/
    claude/
    codex/
    opencode/

        |
        | legacy markers + chat_event records
        v

Java message handlers
  legacy marker handling for existing UI paths
  chat_event forwarding for structured render path

        |
        v

Webview
  legacy ClaudeMessage renderer during migration
  chat_event accumulator and structured renderer
```

## Provider Responsibilities

Each provider adapter owns provider-specific details:

- SDK or CLI resolution
- runtime process lifecycle
- provider-specific auth/config discovery
- session creation, resume, abort, delete, and history lookup
- model and agent discovery where supported
- permission request/reply transport
- conversion from native provider events to normalized `chat_event` records

Provider adapters should not own shared UI merge policy. Once native events are normalized, ordering and grouping should be handled by the shared event accumulator.

The failed [opencode support experiment](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/1239) showed the cost of violating this boundary: provider code, Java handlers, and webview streaming hooks all accumulated special-case merge and recovery logic for the same turn.

## Shared Event Plane

The shared event plane uses `chat_event` records with stable identity fields.

Core fields:

- `provider`
- `sessionId`
- `turnId`
- `runId`
- `messageId`
- `stepId`
- `partId`
- `blockId`
- `toolCallId`
- `sequence`
- `parentId`
- `phase`
- `kind`

Core phases:

- `started`
- `delta`
- `updated`
- `completed`
- `failed`

Core kinds:

- `text`
- `thinking`
- `tool`
- `diff`
- `status`
- `permission`
- `question`
- `plan`
- `terminal`
- `task`
- `todo`
- `usage`
- `mode`

The important change from the older marker-only architecture is that provider events keep their identity and lifecycle. The frontend should not infer ordering by merging assistant messages after the fact.

Minimum invariants for the shared event plane:

- assign `sequence` once at the adapter boundary and replay by `sequence`, not timestamp
- keep `turnId`, `stepId`, `partId`, `blockId`, and `toolCallId` stable across deltas, snapshots, and restored history
- use `parentId` to connect nested permissions, questions, diffs, terminals, and task/subagent sessions to the event that caused them
- treat lifecycle `phase` as state for the same identity, not as permission to rebuild unrelated blocks
- make legacy marker output derivable from `chat_event` during migration instead of making markers the only source of truth

The event kinds above are intentionally broader than the first opencode slice. [Provider Compatibility Matrix](./PROVIDER-COMPATIBILITY-MATRIX.md) maps the same additions to ACP, Cursor, opencode, and Codex so the shared contract can be reviewed as provider-neutral infrastructure.

## Compatibility Layer

`chat_event` records use the same stdout transport as the existing markers: one `[CHAT_EVENT] <json>` line per event, forwarded by Java to the webview without reshaping (see the Transport section in [PREPARATION.md](./PREPARATION.md)).

The current UI still depends on Claude-compatible messages and markers such as:

- `[MESSAGE_START]`
- `[CONTENT_DELTA]`
- `[THINKING_DELTA]`
- `[MESSAGE]`
- `[STREAM_END]`
- `[MESSAGE_END]`

During migration, providers may emit both:

- legacy markers for existing handlers
- `chat_event` records for the structured path

The long-term target is for rich provider output to be represented internally as `chat_event` first, with legacy messages derived only where compatibility requires them.

## Streaming Event Capture

Every provider should be able to write replayable streaming event logs. These logs should capture enough information to reproduce rendering bugs without attaching a debugger to a live provider run.

Recommended capture stages:

- `native_in`: raw provider event received by the bridge
- `normalized_out`: emitted `chat_event`
- `legacy_out`: emitted compatibility marker while migration is in progress
- `handler_in`: optional Java handler input
- `render_in`: optional frontend accumulator input

The capture utility should write newline-delimited JSON envelopes with stable sequence numbers, provider/session metadata, event type, redacted payload, and redaction metadata. Replay should use `sequence`, not timestamps.

Captured logs should support two important test paths:

- raw native events replayed through a provider normalizer
- normalized `chat_event` records replayed through the frontend accumulator

See [Streaming Event Logs And Replay Fixtures](./STREAMING-EVENT-LOGS.md) for the envelope format and fixture-promotion workflow.

## Permission Architecture

Permission mode mapping remains provider-specific, but the UI event shape should be shared.

```text
Plugin mode
  -> provider permission mapper
  -> native provider request/reply transport
  -> chat_event kind: permission
  -> shared permission UI
  -> reply correlated by provider request ID
```

Opencode-specific guidance:

- `plan`: use opencode's planning agent or equivalent; deny or ask for edits, shell, external-directory, and network-like operations.
- `default`: ask for edits, shell, external-directory, and network-like operations.
- `acceptEdits`: allow workspace edits; keep shell and external actions on ask.
- `autoEdit`: allow reads and workspace edits needed for autonomous changes; keep dangerous shell and external actions on ask.
- `bypassPermissions`: allow broad workspace actions only when explicitly selected.

The normalized permission event must preserve the provider request ID, requested tool/action, and available choices.

## Session And History Architecture

Each provider should use its own source of truth for history:

- Claude uses Claude session/history APIs or readers.
- Codex uses Codex session files and current Codex history normalization.
- Opencode should use opencode session APIs.

The shared target is that live and restored paths produce equivalent render groups:

```text
live provider events -> chat_event stream -> accumulator -> render groups
restored history     -> chat_event list   -> accumulator -> render groups
```

Restored history is allowed to emit fewer intermediate deltas, but it should preserve the same logical identities for turns, blocks, tools, diffs, permissions, questions, and task links. Tests should compare accumulated render groups, not raw event counts.

This avoids the Codex failure mode where live streaming and history replay each need separate field mappings for the same logical tool call.

## Opencode Service Layout

Expected Node service layout:

```text
ai-bridge/services/opencode/
  sdk-loader.js
  server-manager.js
  message-service.js
  event-normalizer.js
  permission-mapper.js
  model-service.js
  agent-service.js
  history-service.js
  error-normalizer.js
  event-capture.js
```

Expected channel commands:

- `send`
- `abort`
- `deleteSession`
- `getSessionMessages`
- `listSessions`
- `listModels`
- `listAgents`

## Opencode Message Flow

```text
1. User sends a prompt with provider opencode.
2. Java OpenCodeSDKBridge serializes message, session ID, cwd, mode, model, agent, and attachments.
3. channel-manager.js routes to opencode-channel.js.
4. opencode-channel.js starts or connects to opencode serve.
5. message-service subscribes to /event before prompt submission.
6. message-service creates or resumes an opencode session.
7. message-service sends text/file parts to the session message endpoint.
8. event-normalizer filters events by sessionID.
9. event-normalizer emits chat_event records and migration compatibility markers.
10. Java/webview render from stable event identity.
```

## Adding Future Providers

Future providers should follow the same split:

1. Add a Java bridge only for provider runtime dispatch.
2. Add a Node channel and service folder for provider-specific runtime logic.
3. Normalize native events to `chat_event` records.
4. Add fixtures for live stream and restored history parity.
5. Add compatibility markers only when existing UI paths still require them.

Simple providers can emit a tiny subset:

```json
{
  "type": "chat_event",
  "provider": "example",
  "sessionId": "session_1",
  "turnId": "turn_1",
  "blockId": "text_1",
  "sequence": 1,
  "phase": "delta",
  "kind": "text",
  "text": "Hello"
}
```

Structured providers should preserve richer identity instead of flattening into one assistant message.

Broad provider feature surfaces should be added as separate slices. The opencode support experiment mixed streaming, history, model discovery, agent discovery, slash commands, MCP display, usage statistics, context recovery, and menu UX changes. That made failures harder to isolate.

Recommended slice order:

1. Shared `chat_event` schema, accumulator, and capture utility.
2. Replay fixtures for provider-normalizer and frontend-accumulator paths.
3. Codex or another existing-provider proving adapter that keeps current behavior compatible.
4. Minimal opencode send/stream/history adapter using the structured event path.
5. Opencode model/agent discovery and optional provider-specific UX surfaces.

## Testing Strategy

Tests should prove behavior at the contract boundary:

- captured streaming logs can be sanitized and replayed as fixtures
- provider event fixtures map to `chat_event` without losing identity
- interleaved text, thinking, and tool events preserve order
- tool lifecycle states render as pending/running/completed/failed
- permission and question requests preserve provider request IDs
- diffs preserve file scope and current-turn scope
- task/subagent events preserve child session links when available
- restored history fixtures produce the same render groups as live fixtures
- legacy Claude/Codex rendering remains compatible during migration

## Related Docs

- [Preparation: Provider-Neutral Chat Events](./PREPARATION.md)
- [Opencode Integration Quickstart](./OPENCODE-INTEGRATION-QUICKSTART.md)
- [Provider Compatibility Matrix](./PROVIDER-COMPATIBILITY-MATRIX.md)
- [Streaming Event Logs And Replay Fixtures](./STREAMING-EVENT-LOGS.md)
- [Lessons From The Opencode Support Experiment](./LESSONS-LEARNED.md)
- [Codex Multi-Provider Architecture](../codex/MULTI-PROVIDER-ARCHITECTURE.md)
