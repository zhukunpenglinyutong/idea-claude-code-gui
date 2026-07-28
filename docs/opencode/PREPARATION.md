# Opencode Preparation: Provider-Neutral Chat Events

## Summary

Add a provider-neutral streaming and render event contract before treating opencode as a first-class provider in the JetBrains chat UI.

This is not an argument that the existing architecture was wrong. The current Claude-compatible message model and stdout marker protocol made it practical to add providers quickly when their output could be projected into assistant/user messages, text deltas, `tool_use`, and `tool_result` blocks. That was useful for the original Claude-first UI and for the first Codex integration.

The argument is narrower: opencode is not just another simple text provider. It exposes structured session, message, part, tool, permission, question, diff, and task/subagent events. Forcing those events into the existing Claude-shaped render contract may make the first demo faster, but it moves complexity into provider-specific merge, dedupe, history, permission, and diff-recovery code. A normalized `chat_event` layer should make the complete and maintainable opencode integration easier, not necessarily the first prototype smaller.

The existing `ClaudeMessage` compatibility path should remain. The proposed work adds a richer event path alongside it so opencode, Codex, ACP-backed agents, Cursor, and simpler future providers can share one structured render foundation.

## Decision

Do not make opencode only another adapter that emits the existing Claude/Codex-compatible message markers.

Instead:

- keep explicit provider adapters and provider routing
- keep centralized permission-mode mapping where it is still useful
- introduce a provider-neutral `chat_event` stream for structured runtime events
- add a shared streaming event capture log that can be promoted into replay fixtures
- let existing providers continue emitting current markers while the new path is introduced
- use opencode as the main design target, but prove the contract with fixtures and at least one existing provider surface such as Codex

## Why This Is Not A Contradiction

The old multi-provider architecture optimized for easy onboarding of providers that fit a simple shape:

```text
prompt -> assistant text -> done
```

That is why the previous Gemini example in `docs/codex/MULTI-PROVIDER-ARCHITECTURE.md` can be so small: create `GeminiSDKBridge`, create `ai-bridge/services/gemini/message-service.js`, add a permission mapper, route through `channel-manager.js`, and emit `[MESSAGE_START]`, `[CONTENT]`, and `[MESSAGE_END]`.

Opencode has a different shape:

```text
session -> turn -> message -> part -> tool lifecycle -> permission/question -> diff -> task/subagent -> restored history
```

For this shape, the easy path is deceptive. A compatibility-only bridge would still need to answer hard questions later:

- which text part belongs to which render block
- whether progress narration and final answer text should merge
- how pending, running, completed, and failed tool states are represented
- how permission and question requests stay tied to provider request IDs
- how diffs are scoped to the current turn
- how task/subagent activity links to child sessions
- how live streaming and restored history produce the same UI

The proposal changes the shared render contract so those questions are answered once, not separately in every structured provider adapter.

## Existing Architecture To Preserve

The old docs still identify useful architectural boundaries:

- Java has provider-specific bridges such as `ClaudeSDKBridge` and `CodexSDKBridge`.
- Node has provider-specific services under `ai-bridge/services/`.
- `channel-manager.js` routes by provider.
- Permission modes are translated into provider-specific settings.
- Session identity differences are hidden behind bridge-level mapping.

Those are good extension points and should remain. The proposed change is about the rendering and streaming contract, not about removing provider adapters.

## Existing Architecture To Change

The current render contract mostly assumes:

- one assistant turn becomes one renderable assistant message
- text, thinking, and tool ordering can be recovered by frontend merge logic
- tool calls can be flattened into `tool_use` plus `tool_result`
- restored history can be loaded as raw user/assistant messages and then merged
- `__turnId` can be used for both streaming isolation and merge behavior

Those assumptions do not map cleanly to opencode, Codex, ACP agents, or Cursor.

They are also only a partial fit for Claude itself. Claude Code / Claude Agent SDK output can include stream events such as message starts, content block deltas, thinking deltas, message deltas, usage updates, assistant content blocks, tool use blocks, user tool result blocks, permission hooks, and result messages. The current model works where those events can be projected into message/content blocks, but later streaming and multi-provider support has required additional merge, replay, and boundary logic around that projection.

## Expected Opencode Pressure Points

Opencode exposes structured session, message, and part events. If those events are immediately mapped into Claude/Codex-compatible markers, several rough edges are likely:

- live ordering may require synthetic block-reset style heuristics after tool or diff results
- restored history may contain multiple assistant step messages for one logical turn
- frontend merge logic may accidentally combine assistant progress text into one giant answer block
- accumulated session-level diffs may require baseline filtering to identify current-turn edits
- progress narration and final answer text may not be explicitly distinguished
- tool lifecycle state may be flattened too early into `tool_use` and `tool_result`
- live streaming and restored history may diverge

These are not opencode-specific UI problems. They are signs that the bridge and frontend need a richer provider-neutral event model.

The failed [opencode support experiment](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/1239) confirmed these pressure points in practice. It required repeated fixes for role-gated text, stream-end recovery, post-tool text ordering, diff baseline filtering, restored-history normalization, task/subagent reconstruction, context-window recovery, and streaming debug capture. See [Lessons From The Opencode Support Experiment](./LESSONS-LEARNED.md) for the detailed findings.

## Codex Evidence

Codex already emits structured lifecycle events through `runStreamed()` and `--json`/JSONL output:

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.started`
- `item.updated`
- `item.completed`
- `error`

Codex item types include:

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `mcp_tool_call`
- `web_search`
- `todo_list`

Today the Codex bridge flattens these into Claude-compatible message/tool blocks. It also has special recovery paths that read the local JSONL session file during live streaming to recover missing function calls and patch details.

Historical context suggests this was a deliberate symmetry choice, not an accident. The first Codex bridge work introduced a shared `ai-bridge/channel-manager.js` and provider-specific adapters for Claude and Codex. The later Codex SDK adaptation documented the goal as using the "same elegant architecture as Claude", with "Symmetrical Design", a "Unified JSON Protocol", and provider services emitting unified console markers such as `[MESSAGE_START]`, `[CONTENT_DELTA]`, and `[MESSAGE_END]`. That was a practical way to add Codex quickly while reusing the existing UI and Java callback model.

The cost is visible in later fixes: Codex `thinking`, `tool_use`, and `tool_result` blocks had to be preserved through Claude-compatible JSON messages, and history replay needed separate field-mapping fixes for raw Codex JSONL because the live path and restored-history path normalized different shapes. No PR discussion or review comments were found for the original Codex SDK adaptation, so the strongest evidence is the committed docs, code comments, and follow-up fixes.

A provider-neutral turn/item model would let Codex preserve more native structure instead of reconstructing it through adapter-specific logic.

Relevant current code:

- `ai-bridge/services/codex/message-service.js`
- `ai-bridge/services/codex/codex-event-handler.js`
- `src/main/java/com/github/claudecodegui/session/CodexMessageHandler.java`
- `src/main/java/com/github/claudecodegui/handler/CodexMessageConverter.java`
- `src/main/java/com/github/claudecodegui/handler/history/HistoryMessageInjector.java`

## Prior Gemini Planning Docs

The existing docs contain Gemini as a future-provider example, not as an implemented integration plan. `docs/codex/MULTI-PROVIDER-ARCHITECTURE.md` describes adding Gemini by creating `ai-bridge/services/gemini/message-service.js`, adding a `GeminiPermissionMapper`, updating `channel-manager.js`, and adding `GeminiSDKBridge`. `docs/codex/CODEX-INTEGRATION-QUICKSTART.md` similarly frames Gemini as a future symmetrical provider and says it would follow the same pattern.

That prior plan is useful, but it also shows the limitation this proposal is trying to address. The old extension point was provider-oriented: Java bridge, Node service, permission mapper, and unified stdout markers. The example Gemini service emits only `[MESSAGE_START]`, `[CONTENT]`, and `[MESSAGE_END]`. That is enough for simple text providers, but not enough for providers or protocols with explicit turns, steps, tool lifecycles, permissions, diffs, plans, terminal output, usage updates, and subagent activity.

No ACP integration plan was found under `docs/`. The ACP section below is therefore a new protocol-driven design input, not a continuation of an existing project doc.

## Generic ACP Compatibility

This foundation would also make it practical to support ACP-backed agents without building a new provider-specific merger for each one.

ACP is explicitly structured around the same concepts this proposal needs to represent:

- `session/prompt` starts a prompt turn
- `session/update` streams progress and output
- `agent_message_chunk` carries assistant text chunks with optional message identity
- `tool_call` creates a tool call with a stable `toolCallId`
- `tool_call_update` reports tool status and result content
- tool statuses include `pending`, `in_progress`, `completed`, and `failed`
- tool content can include regular content blocks, diffs, and terminal references
- `session/request_permission` asks the client to choose from explicit permission options
- permission options include `allow_once`, `allow_always`, `reject_once`, and `reject_always`
- plan updates, session mode changes, usage updates, file-system requests, and terminal requests are first-class protocol concepts

Junie is a concrete example of why this matters. Junie CLI supports ACP mode through `junie --acp true`, and Junie in JetBrains IDEs exposes agent behavior that includes planning, ask/code modes, approval-gated execution, diffs, terminal commands, MCP tool execution, and action allowlists.

If this plugin can render ACP-shaped turns, chunks, tool calls, permissions, plans, diffs, and terminals through a normalized event contract, then Junie support can be implemented as an ACP adapter instead of a Junie-specific frontend model. The same work would also help any other ACP-capable agent.

## Future Cursor Integration

This would also strongly benefit a potential Cursor provider.

Cursor exposes several integration surfaces that are already structured around runs, steps, deltas, tool lifecycle, and permissions.

Cursor TypeScript SDK:

- `Agent.create()` creates a durable agent
- `agent.send()` starts a `Run`
- `run.stream()` yields normalized `SDKMessage` events
- events include `assistant`, `thinking`, `tool_call`, `status`, `task`, and `request`
- tool calls have stable lifecycle fields like `call_id`, `name`, and `status`
- `onDelta` exposes lower-level updates such as `text-delta`, `thinking-delta`, `tool-call-started`, `partial-tool-call`, `tool-call-completed`, `step-started`, `step-completed`, `turn-ended`, and `shell-output-delta`
- `run.conversation()` returns structured turns with steps such as `assistantMessage`, `thinkingMessage`, and `toolCall`

Cursor CLI:

- `--output-format stream-json` emits structured NDJSON
- events include `system`, `user`, `assistant`, `tool_call`, and `result`
- `tool_call` events have `started` and `completed` subtypes
- `--stream-partial-output` adds character-level text streaming
- assistant messages are emitted between tool calls, which directly maps to a step/block model

Cursor ACP:

- `agent acp` exposes JSON-RPC over stdio
- clients receive `session/update` notifications
- clients handle `session/request_permission`
- Cursor extensions include `cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/task`, and `cursor/generate_image`

A provider-neutral event model would let a future Cursor integration map these surfaces directly instead of forcing Cursor into Claude-shaped raw messages.

See [Provider Compatibility Matrix](./PROVIDER-COMPATIBILITY-MATRIX.md) for a cross-provider view of which proposed event kinds and interface fields are useful for ACP, Cursor, opencode, and Codex.

## Proposed Event Contract

Introduce a provider-neutral streaming/render event contract.

Suggested normalized concepts:

- `turn`
- `step`
- `part`
- `block`
- `tool_call`
- `tool_result`
- `diff`
- `permission`
- `question`
- `plan`
- `status`
- `terminal`
- `task`
- `todo_update`
- `usage_update`
- `mode_change`

Suggested event fields:

- `type`: `chat_event`
- `schemaVersion`
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
- `phase`: `started | delta | updated | completed | failed`
- `kind`: `text | thinking | tool | diff | status | permission | question | plan | terminal | task | todo | usage | mode`

The frontend should render from stable event and block identity instead of relying on post-hoc assistant-message merging.

### Transport

`chat_event` records travel over the existing bridge stdout protocol as a new marker line beside the current markers:

```text
[CHAT_EVENT] {"type":"chat_event","provider":"opencode","sessionId":"ses_123",...}
```

Rules:

- one event per marker line, JSON-encoded without embedded newlines
- Java forwards `[CHAT_EVENT]` payloads to the webview without reshaping them; Java may additionally parse specific kinds (such as `permission`) where native dialogs need them
- the schema carries an explicit `schemaVersion` field so replay fixtures and the accumulator can reject or adapt incompatible events

### Contract Invariants

The first implementation should treat these as acceptance rules, not later cleanup items:

- `sequence` is assigned at the adapter boundary, is monotonic within one provider session stream, and is the only ordering value used for replay.
- `turnId` identifies one user prompt or restored prompt turn; it must not also encode UI merge policy.
- `stepId` identifies a provider lifecycle unit such as an opencode message/part group, Codex item, ACP update group, or synthesized equivalent.
- `blockId` identifies one renderable text, thinking, diff, status, terminal, plan, or todo block and remains stable across deltas and snapshots.
- `toolCallId` identifies one tool lifecycle and correlates tool start, input updates, permission requests, result updates, diffs, and terminal output when the provider exposes that relationship.
- `partId` and `messageId` preserve native provider identity when available, but frontend grouping should not depend on provider-specific names.
- `parentId` links nested entities such as task/subagent sessions, terminal streams, permission requests, or diffs back to the block, tool, step, or turn that created them.
- A `completed` or `failed` event can close a block/tool/turn, but it must not reorder earlier deltas or rewrite unrelated blocks.
- Restored history should emit completed `chat_event` records that use the same identity hierarchy as live streaming wherever the provider exposes enough information.

### Accumulator Rules

The shared frontend accumulator should be intentionally boring:

- Ingest ordered `chat_event` records and group by `sessionId`, `turnId`, `stepId`, `blockId`, and `toolCallId`.
- Append text and thinking deltas only to the block identified by `blockId`.
- Apply snapshots only to the matching identity and never use a cumulative provider snapshot to move older tool cards below later text.
- Render tools from lifecycle state (`started`, `updated`, `completed`, `failed`) rather than from a pair of finished `tool_use` / `tool_result` messages.
- Render diffs, terminal streams, permissions, questions, tasks, plans, todos, usage, and mode updates as first-class blocks or side-channel records with explicit parent links.
- Derive legacy `ClaudeMessage`-compatible blocks from accumulated events only where migration requires compatibility.

## Streaming Event Capture

The preparation work should also add a shared streaming event capture utility for existing and new providers. This was useful during opencode implementation work because rendering issues could be diagnosed from the actual provider stream instead of from screenshots or final UI state.

The capture format should be replay-oriented, not just debug text. Prefer newline-delimited JSON envelopes with a version, provider, session ID, sequence number, capture stage, event type, redacted payload, and redaction metadata. Capture should include raw provider events, normalized `chat_event` records, and legacy markers while the compatibility path exists.

Required capture stages:

- `native_in`: raw provider event received by the bridge
- `normalized_out`: emitted `chat_event`
- `legacy_out`: emitted compatibility marker such as `[CONTENT_DELTA]` or `[MESSAGE]`

The logs should be safe to persist in debug mode and easy to convert into test fixtures. A captured rendering bug should be reducible into a fixture that replays either raw provider events through the normalizer or normalized `chat_event` records through the frontend accumulator.

See [Streaming Event Logs And Replay Fixtures](./STREAMING-EVENT-LOGS.md) for the proposed log envelope and replay workflow.

## Opencode Mapping Sketch

The exact mapping should be finalized against opencode's current HTTP event payloads, but the intended direction is:

> Event names below come from opencode's newer API generation. Opencode is mid-migration between two API generations with different event vocabularies; see the API surface caveat in [OPENCODE-INTEGRATION-QUICKSTART.md](./OPENCODE-INTEGRATION-QUICKSTART.md) and re-verify names against the pinned SDK version at implementation start.

- `message.part.delta` with text fields maps to `kind: text`, `phase: delta`.
- `message.part.delta` with reasoning fields maps to `kind: thinking`, `phase: delta`.
- `message.updated` maps to message or turn-level `phase: updated` snapshots.
- `message.part.updated` for tool parts maps to `kind: tool`, with `phase` derived from the provider part state.
- completed tool results map to `kind: tool`, `phase: completed`, preserving `toolCallId`.
- `permission.asked` maps to `kind: permission`, `phase: started`, preserving the opencode request ID and available actions.
- `permission.replied` maps to `kind: permission`, `phase: completed`.
- `question.asked` maps to `kind: question`, `phase: started`, preserving the opencode request ID.
- `session.diff` maps to `kind: diff`, preserving file paths, hunks, and turn/session scope.
- task or subagent tool metadata maps to `kind: task`, preserving child session IDs when available.
- restored `session.messages` output maps to completed `chat_event` records using the same identity fields as the live stream wherever possible.

The adapter may still synthesize existing `ClaudeMessage`-compatible blocks during migration. That compatibility output should be derived from the structured events, not the only internal representation.

## Possible Event Shape

Text delta example:

```json
{
  "type": "chat_event",
  "provider": "opencode",
  "sessionId": "ses_123",
  "turnId": "turn_4",
  "stepId": "step_2",
  "blockId": "block_7",
  "sequence": 42,
  "phase": "delta",
  "kind": "text",
  "text": "I found the issue."
}
```

Tool lifecycle start example:

```json
{
  "type": "chat_event",
  "provider": "codex",
  "sessionId": "thread_123",
  "turnId": "turn_1",
  "stepId": "item_3",
  "toolCallId": "call_abc",
  "sequence": 17,
  "phase": "started",
  "kind": "tool",
  "tool": {
    "name": "command_execution",
    "input": {
      "command": "npm test"
    }
  }
}
```

Tool lifecycle completion example:

```json
{
  "type": "chat_event",
  "provider": "cursor",
  "sessionId": "agent_123",
  "runId": "run_456",
  "toolCallId": "call_abc",
  "sequence": 18,
  "phase": "completed",
  "kind": "tool",
  "tool": {
    "name": "read_file",
    "result": {
      "path": "README.md",
      "totalLines": 54
    }
  }
}
```

Permission example:

```json
{
  "type": "chat_event",
  "provider": "opencode",
  "sessionId": "ses_123",
  "turnId": "turn_4",
  "sequence": 51,
  "phase": "started",
  "kind": "permission",
  "permission": {
    "requestId": "perm_abc",
    "tool": "bash",
    "action": "run",
    "choices": ["allow_once", "allow_always", "reject"]
  }
}
```

## Implementation Direction

Keep the existing `ClaudeMessage` path for compatibility, but add a richer normalized event path alongside it.

Suggested phases:

1. Contract slice:
   - Add a documented `chat_event` bridge marker, schema, and TypeScript type.
   - Add identity, sequencing, phase, and parent-link invariants to the schema tests.
   - Add a frontend accumulator/store that groups events by `turnId`, `stepId`, `blockId`, and `toolCallId`.
   - Add shared streaming event capture for raw provider events, normalized `chat_event` records, and legacy markers.
2. Fixture slice:
   - Add hand-authored fixtures for text, thinking, tool lifecycle, permission, question, diff, terminal, task, and restored-history events.
   - Add at least one captured-log fixture path that can replay either raw provider events through a normalizer or normalized events through the accumulator.
   - Prove live-stream and restored-history parity with the same accumulator.
3. Existing-provider proving slice:
   - Keep existing provider adapters emitting current markers while the new path is introduced.
   - Prove the new path with at least one existing provider surface, preferably Codex, because Codex already has structured `thread`, `turn`, and `item` lifecycle events in the current codebase.
   - Keep Claude behavior unchanged initially; optionally wrap Claude stream events into the same model later.
4. Opencode proving slice:
   - Implement the minimal opencode send/stream/history path on top of `chat_event`.
   - Cover opencode session/message/part identity, tool lifecycle, permission/question request IDs, diffs, and live/restored parity.
   - Keep model discovery, agent discovery, slash commands, MCP display, usage statistics, and context recovery out of this slice unless explicitly required.
5. Provider expansion slice:
   - Add opencode model/agent discovery and optional UX surfaces after the event contract is proven.
   - Use ACP and Cursor as design inputs for this preparatory work, not as required provider implementations in the infrastructure PR.
   - Build later ACP-backed providers, such as Junie, as adapters onto this contract instead of adding a separate ACP-specific render model.

Implementation slices should stay narrow. The failed opencode support experiment bundled core streaming, model discovery, agent discovery, slash commands, MCP display, usage statistics, context recovery, and multiple UI menu changes into one broad effort. The next attempt should prove the event contract first, then add discovery and UX surfaces as separate slices.

## UX Goals

- preserve text, thinking, and tool ordering without synthetic block-reset heuristics
- render live streaming and restored history using the same structure
- avoid provider-specific frontend merge hacks
- represent tool calls as lifecycle events, not only as finished blocks
- show pending, running, completed, and error tool states consistently
- represent diffs as first-class events with clear scope
- represent questions, permissions, plans, todos, usage updates, mode changes, terminal output, and subagent/task updates as structured UI events
- avoid using `__turnId` for multiple unrelated concerns

## Acceptance Criteria

- A documented `chat_event` contract exists with required and optional fields, identity rules, sequencing rules, lifecycle phases, and supported event kinds.
- Shared TypeScript types exist for the normalized event model and are covered by typecheck or schema tests.
- A frontend accumulator/store can ingest ordered `chat_event` fixtures and produce stable render groups by `turnId`, `stepId`, `blockId`, and `toolCallId`.
- Fixture tests cover text deltas, thinking deltas, interleaved tool lifecycle events, tool completion, diff/file-change events, permission/question events, plan updates, todo updates, terminal output references, usage updates, mode changes, and task/status updates.
- Fixture tests prove that block ordering is preserved by explicit identity and `sequence`, not by assistant-message merge guesses.
- Fixture tests prove that a live-style event stream and a restored-history-style event list can produce the same logical render groups.
- A shared streaming event capture format exists and records raw provider events, normalized `chat_event` records, and legacy markers with stable sequence numbers.
- Captured event logs are redacted by default and can be sanitized into deterministic replay fixtures.
- At least one captured-log fixture can be replayed through a provider normalizer or frontend accumulator to reproduce a rendering issue.
- Codex structured events can be mapped into `chat_event` fixtures or an adapter-level test without losing `thread`, `turn`, `item`, and tool lifecycle identity.
- Opencode session/message/part events are mapped in documentation or adapter-level fixtures without losing part identity, tool lifecycle state, permission/question request IDs, diff scope, task metadata, or restored-history parity.
- ACP `session/update` and `session/request_permission` examples can be mapped into `chat_event` fixtures or adapter-level tests without losing message chunk identity, `toolCallId`, tool status, diff content, terminal references, plan updates, mode changes, usage updates, or permission options.
- The provider compatibility matrix identifies which event kinds and interface fields are needed by ACP, Cursor, opencode, and Codex, so additions are justified by concrete provider surfaces rather than opencode alone.
- Existing Claude and Codex rendering behavior remains compatible while the new event path is introduced alongside the current `ClaudeMessage` path.
- The infrastructure PR does not need to implement the full opencode provider, a generic ACP provider, Junie provider support, or Cursor provider support.
- The implementation notes explain which opencode support experiment learnings are intentionally deferred, such as context recovery, MCP display, slash commands, and usage statistics.

## Non-Goals

- Do not implement Cursor provider support in this work.
- Do not rewrite the entire chat UI at once.
- Do not remove the existing `ClaudeMessage` compatibility path immediately.
- Do not change provider authentication or model-selection behavior.
- Do not require full opencode provider support in the same PR as the event infrastructure.
- Do not implement a generic ACP provider or Junie provider support in this work.

## Risks And Tradeoffs

- This adds upfront infrastructure work before opencode's first complete integration.
- During migration, adapters may emit both legacy markers and `chat_event` records.
- The event model needs clear identity and sequencing rules or it will recreate the same merge problems in a new shape.
- Simple providers will have slightly more structure than they strictly need, but they can emit a small subset of `chat_event` events.
- Pulling every opencode support experiment feature into the first retry would repeat the failed experiment's scope problem.

## Conclusion

The previous architecture should be preserved where it helped: explicit provider adapters, provider routing, and permission translation. The render contract should change because opencode and other structured agents expose more than assistant text.

The goal is lower long-term integration cost and higher correctness: one shared event model for live streaming, restored history, tools, permissions, questions, diffs, tasks, and future structured providers.

The next opencode attempt should be treated as an event-contract proving slice first, not as a full provider-feature parity effort.
