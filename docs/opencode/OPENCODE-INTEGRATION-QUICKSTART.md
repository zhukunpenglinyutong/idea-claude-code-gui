# Opencode Integration Quickstart

> Draft integration guide. This document describes the intended opencode provider shape and the checks that should pass when the integration lands.

## What This Adds

Opencode should become a first-class provider beside Claude and Codex, with an explicit provider boundary instead of a Claude fallback path.

The integration should use the user's installed opencode CLI and existing opencode configuration. The plugin should discover or start `opencode serve`, talk to it through `@opencode-ai/sdk` and HTTP APIs, and map opencode runtime events into the plugin's shared chat UI.

The important difference from the first Codex integration is that opencode should not be treated as only another text-message provider. The first complete implementation should preserve structured session, message, part, tool, permission, question, diff, and task/subagent events through the provider-neutral `chat_event` path described in [PREPARATION.md](./PREPARATION.md).

The same event/interface additions also map to ACP, Cursor, and Codex. See [Provider Compatibility Matrix](./PROVIDER-COMPATIBILITY-MATRIX.md) for the cross-provider compatibility view.

The failed [opencode support experiment](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/1239) showed that the integration should be sliced carefully. Core send/stream/history and event replay should land before optional discovery surfaces such as slash commands, MCP display, usage dashboards, and context recovery UX.

## Architecture Highlights

```text
Claude:   Java -> ClaudeSDKBridge   -> ai-bridge -> @anthropic-ai/claude-agent-sdk
Codex:    Java -> CodexSDKBridge    -> ai-bridge -> Codex CLI/SDK integration
Opencode: Java -> OpenCodeSDKBridge -> ai-bridge -> @opencode-ai/sdk -> opencode serve
```

Key boundaries:

- Java provider bridge: `OpenCodeSDKBridge`
- Node provider channel: `ai-bridge/channels/opencode-channel.js`
- Node provider services: `ai-bridge/services/opencode/`
- Shared provider router: `ai-bridge/channel-manager.js`
- Shared render foundation: `chat_event` plus existing compatibility markers during migration

## Runtime Ownership

The plugin should not install or configure opencode for the user.

Expected ownership model:

- User installs the `opencode` CLI.
- User configures opencode auth, providers, and model defaults through opencode.
- Plugin resolves the installed CLI or connects to a configured external server.
- Plugin may start the user's installed CLI with `opencode serve` in managed-server mode.
- Plugin should not write opencode auth or provider configuration unless a future UI action explicitly says it will.

## Dependencies

Expected plugin-managed dependency:

```json
{
  "opencode-sdk": "@opencode-ai/sdk"
}
```

Expected user-managed dependency:

```text
opencode CLI executable
```

The bridge should fail with a user-facing setup error when the SDK or CLI cannot be resolved.

## Configuration

Supported runtime modes:

| Mode | Behavior |
| --- | --- |
| Managed server | Plugin starts the user's installed CLI with `opencode serve`. |
| External server | User provides `OPENCODE_BASE_URL`; plugin connects without owning the process. |

Optional settings can be added later for host, port, server password, and inline server config. They should not replace opencode's own provider/auth configuration.

## Message Flow

```text
1. User selects opencode in the provider selector.
2. Java dispatches to OpenCodeSDKBridge.
3. Java invokes ai-bridge channel-manager.js with provider "opencode".
4. opencode-channel.js starts or connects to an opencode server.
5. Bridge subscribes to /event before sending the prompt.
6. Bridge creates or resumes a session through the current /session API.
7. Bridge sends user input as text/file parts.
8. Bridge maps opencode events to chat_event records and compatibility markers.
9. Optional streaming event capture records raw events, normalized events, and compatibility markers.
10. Frontend renders live stream, tools, diffs, permissions, questions, and tasks from stable event identity.
11. Session restore reads through opencode session APIs and produces the same logical render groups as live streaming.
```

## Event Mapping

> **API surface caveat (verify before implementation).** Opencode currently ships two parallel API generations, and event names differ between them. The names in the table below come from the newer (v2) SDK event surface (`message.part.delta`, `permission.asked`, `question.asked`). The older generated SDK types instead expose `message.part.updated`, `permission.updated`, and `permission.replied`, with no part-delta or question-asked events. As of the July 2026 source checkout, the v2 session `prompt` operation is implemented, while `wait`, `compact`, `shell`, and `skill` still return `Session.OperationUnavailableError`. At implementation start: pin the `@opencode-ai/sdk` version (npm was at 1.17.13 when this was written), decide which API generation the bridge targets, and regenerate this mapping table against that version. Do not treat this table as authoritative without that check.

The bridge should subscribe before prompt submission and filter by `sessionID` because opencode events are shared over the server event stream.

Expected mapping:

| Opencode event | Normalized output |
| --- | --- |
| `message.part.delta` text fields | `chat_event` with `kind: text`, `phase: delta` |
| `message.part.delta` reasoning fields | `chat_event` with `kind: thinking`, `phase: delta` |
| `message.updated` | message or turn snapshot with `phase: updated` |
| `message.part.updated` tool part | tool lifecycle update with stable `toolCallId` |
| completed tool result | `kind: tool`, `phase: completed` |
| `permission.asked` | `kind: permission`, preserving request ID and choices |
| `permission.replied` | `kind: permission`, `phase: completed` |
| `question.asked` | `kind: question`, preserving request ID |
| `session.diff` | `kind: diff`, preserving file scope and hunks |
| task/subagent metadata | `kind: task`, preserving child session IDs when available |

During migration, the adapter may also emit existing markers such as `[MESSAGE_START]`, `[CONTENT_DELTA]`, `[THINKING_DELTA]`, `[MESSAGE]`, `[STREAM_END]`, and `[MESSAGE_END]` so current UI paths remain compatible.

## Streaming Event Logs

The opencode bridge should support replayable event capture from the start. This is useful for diagnosing rendering issues and for turning real provider streams into regression tests.

Capture should include:

- raw opencode events from `/event`
- normalized `chat_event` records
- legacy compatibility markers while they exist

Captured logs should use the shared JSONL envelope described in [Streaming Event Logs And Replay Fixtures](./STREAMING-EVENT-LOGS.md). Logs must be redacted by default and should be easy to sanitize into fixture tests.

## Permission Mapping

Permission behavior should be explicit and mode-aware.

| Plugin mode | Intended opencode behavior |
| --- | --- |
| `plan` | Use opencode's planning agent or equivalent. Deny or ask for edits, shell, network-like tools, and external directories. |
| `default` | Ask for edits, shell, network-like tools, and external-directory access. |
| `acceptEdits` | Allow workspace edits; keep shell and external actions on ask. |
| `autoEdit` | Allow reads and workspace edits needed for autonomous changes; keep dangerous shell and external actions on ask. |
| `bypassPermissions` | Allow broad workspace actions only when explicitly selected by the user. |

Permission request and reply IDs from opencode must be preserved so UI decisions are applied to the right provider request.

## Attachments

Attachments should be converted to opencode file parts, not Codex-style prompt text.

Expected file part fields:

- MIME type
- filename
- `file://` URL
- source metadata when available

Attachment paths should be validated before sending.

## Session History

History should use opencode APIs, not Claude or Codex transcript readers.

Expected behavior:

- list project sessions through opencode's project-scoped session API
- restore a session through opencode session messages
- normalize restored messages through the same event model as live streaming
- preserve completed tool parts, file-change metadata, diffs, and task/subagent links when available

## Implementation Checklist

Foundation before opencode parity:

- Add the shared `chat_event` bridge marker, schema, TypeScript types, and frontend accumulator.
- Add identity and sequencing tests for `turnId`, `stepId`, `partId`, `blockId`, `toolCallId`, `parentId`, `phase`, and `sequence`.
- Add shared streaming event capture for raw provider events, normalized `chat_event` records, and legacy markers.
- Add at least one replay fixture generated from or shaped like a captured streaming event log.
- Prove that live-style events and restored-history-style event lists produce equivalent accumulated render groups.
- Keep existing Claude and Codex behavior compatible while the new event path is introduced.

Minimal opencode proving slice:

- Register provider `opencode` in `ai-bridge/channel-manager.js`.
- Add `ai-bridge/channels/opencode-channel.js`.
- Add `ai-bridge/services/opencode/` for SDK resolution, server lifecycle, permissions, event normalization, capture, and history.
- Add dependency metadata for `opencode-sdk` / `@opencode-ai/sdk`.
- Add Java `OpenCodeSDKBridge` as a peer of Claude and Codex bridges.
- Route Java sends through explicit provider dispatch, not `not codex means claude` logic.
- Implement send, abort, and restore through opencode session APIs using the user-managed CLI/server model.
- Add event normalization tests for text, reasoning, tools, diffs, permissions, questions, errors, and task/subagent metadata.
- Add history restore tests for opencode session messages through the same accumulator used by live streaming.

Later provider UX slices:

- Add opencode model/provider discovery through opencode config/provider APIs.
- Add opencode agent discovery through opencode agent APIs.

Defer unless explicitly in scope:

- slash command picker integration
- MCP server/tool display
- usage dashboards
- context recovery UI
- broad selector/menu redesigns
- commit-message and prompt-enhancer provider routing

## Manual Smoke Test

After implementation, a minimal local smoke test should verify:

1. Install and configure opencode outside the plugin.
2. Start the IDE with no existing opencode server.
3. Select provider `opencode`.
4. Confirm managed-server mode starts the user's installed `opencode serve`.
5. Send a text prompt and observe streaming text.
6. Trigger a read/search tool and observe tool lifecycle UI.
7. Trigger a permission request and verify allow once, always allow, and reject behavior.
8. Trigger an edit and verify file-change UI and diff scope.
9. Abort an in-flight response.
10. Restore the session from history and confirm live/restored render parity.

## Troubleshooting Targets

Expected setup errors should be explicit:

| Symptom | Likely cause | Expected guidance |
| --- | --- | --- |
| SDK cannot be loaded | `@opencode-ai/sdk` dependency missing | Install or repair plugin dependencies. |
| CLI cannot be found | User has not installed `opencode` or it is not on PATH | Install opencode and ensure the IDE can resolve it. |
| Server connection fails | Managed server failed or `OPENCODE_BASE_URL` is wrong | Show base URL and server startup diagnostics without secrets. |
| No models found | User opencode provider config is incomplete | Ask user to verify opencode works outside the plugin. |
| Permission dialog does not resolve | Request ID was not preserved | Inspect `permission.asked` and reply correlation. |
| Restored history differs from live stream | Live and history paths use different normalization | Add or fix shared `chat_event` fixtures. |
| Rendering bug cannot be reproduced | Event capture was disabled or incomplete | Enable streaming event logs and promote the capture into a replay fixture. |

## Related Docs

- [Preparation: Provider-Neutral Chat Events](./PREPARATION.md)
- [Opencode Multi-Provider Architecture](./MULTI-PROVIDER-ARCHITECTURE.md)
- [Provider Compatibility Matrix](./PROVIDER-COMPATIBILITY-MATRIX.md)
- [Streaming Event Logs And Replay Fixtures](./STREAMING-EVENT-LOGS.md)
- [Lessons From The Opencode Support Experiment](./LESSONS-LEARNED.md)
- [Codex Integration Quickstart](../codex/CODEX-INTEGRATION-QUICKSTART.md)
- [Codex Multi-Provider Architecture](../codex/MULTI-PROVIDER-ARCHITECTURE.md)
