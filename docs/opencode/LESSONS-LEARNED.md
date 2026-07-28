# Lessons From The Opencode Support Experiment

## Summary

The opencode support experiment was valuable even though it should not be used as the long-term implementation shape.

Public reference: [PR #1239](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/1239).

It proved that opencode can be wired into the plugin through a Java bridge, Node bridge, `@opencode-ai/sdk`, and `opencode serve`. It also showed that adapting a structured provider into the existing Claude/Codex-compatible marker stream creates too many local fixes: stream recovery, role buffering, block resets, diff dedupe, history conversion, task/subagent reconstruction, and UI-specific replay work.

The main lesson is not that opencode is unsuitable. The lesson is that opencode should be integrated after the shared event, capture, replay, and rendering contracts are stronger.

## What Worked

The experiment confirmed several useful design choices:

- opencode should be a first-class provider with explicit provider routing.
- the CLI should remain user-managed.
- managed-server mode can mean starting the user's installed `opencode serve`.
- `@opencode-ai/sdk` is a reasonable bridge dependency.
- model, provider, agent, history, and usage surfaces can be handled separately from streaming.
- slash command and MCP display surfaces should not be bundled into the first event-contract slice.
- permission and question requests can route through existing Java/webview dialogs if request IDs are preserved.
- streaming event capture and replay fixtures are essential for debugging rendering bugs.

## What Failed

The failed part was the amount of compatibility glue needed to preserve opencode semantics through the old render contract.

The experiment repeatedly fixed symptoms caused by flattening structured events into message markers:

- streamed text and reasoning needed buffering until the message role was known
- user-role text echoes had to be dropped after the fact
- tool updates had to wait for preceding text parts to close
- post-tool text needed explicit block-reset behavior
- text part boundaries needed synthetic spaces to avoid fused sentences
- stream completion needed idle-state polling instead of relying on connection close
- `session.diff` events needed baseline seeding and path dedupe
- live streaming and restored history needed separate normalization fixes
- task/subagent output needed provider-aware history loading
- context-window failures needed special recovery UX

Those are exactly the problems a provider-neutral event model should make explicit.

## Streaming Lessons

Opencode streaming is not a simple sequence of text deltas.

Observed lessons:

- Subscribe to the event stream before creating or prompting a session.
- Filter all events by `sessionID`; shared event streams include unrelated sessions.
- Do not complete a turn just because the event stream closes.
- Treat `session.status` or equivalent idle signals as the authoritative completion signal.
- Keep a fallback for missing status events, but gate it on observed live activity.
- Maintain an explicit event coverage matrix with each event marked `handled` or `ignored` and a reason for ignored events.
- Buffer text and reasoning deltas when the message role is unknown.
- Drop user-role text parts from assistant rendering.
- Preserve part IDs so late snapshots can be reconciled with earlier deltas.

Concrete experiment evidence:

- The experiment covered final text recovery, post-tool ordering, role-gated text, idle completion, missing status, session filtering, reasoning fields, and diff behavior.
- It introduced an explicit matrix for handled and intentionally ignored upstream events.
- It captured a real class of bugs: user echo suppression, assistant role buffering, tool block reset, and post-tool text ordering.

## Rendering Lessons

Compatibility markers were not enough to express the UI state cleanly.

Observed lessons:

- The UI needs stable block identity, not only appended assistant text.
- Tool calls need lifecycle state, not only final `tool_use` and `tool_result` blocks.
- Text after a tool must be a distinct block, not merged into pre-tool prose.
- Thinking blocks after tools need the same boundary logic as text blocks.
- Backend snapshots can be stale, shorter, or structurally different from frontend streaming buffers.
- Reconciliation must never move tool cards below later text just because a cumulative text buffer grows.

The experiment added webview replay tests because bridge-level output passing was not enough. Rendering failures could still appear after Java/webview marker reconciliation.

Preparation implication:

- `chat_event` fixtures should test both provider normalizers and the frontend accumulator.

## Replay And Logging Lessons

The experiment's most useful debugging tool was capturing actual streams and turning them into fixtures.

Observed lessons:

- Logs need stable sequence numbers.
- Logs should capture raw provider events, normalized output, and compatibility markers.
- Fixture extraction should filter by session ID.
- Fixtures should minimize unrelated status, heartbeat, and duplicate tool events.
- A fixture should encode expected bridge output and final webview invariants.

The experiment used stream capture and fixture extraction to turn live rendering bugs into repeatable tests. That approach should be generalized rather than kept as opencode-only debugging work.

Preparation implication:

- The streaming event log utility should be shared across Claude, Codex, and opencode.
- Captured logs should be promotable into deterministic regression tests.

## Diff Lessons

Opencode diffs are session-level enough that naive rendering can show stale changes.

Observed lessons:

- Seed a baseline before emitting current-turn diffs.
- Deduplicate equivalent relative and absolute paths.
- Preserve patch metadata so restored history can rebuild edit blocks.
- Include source metadata so UI can distinguish `session.diff` from tool metadata diffs.

Preparation implication:

- `chat_event` diff events need explicit scope, source, file identity, and sequence.
- Diff fixtures should include baseline/no-op cases, path dedupe, and restored-history reconstruction.

## History Lessons

History was a separate integration, not a free consequence of live streaming.

Observed lessons:

- Root sessions and child task sessions must be distinguished.
- Child task sessions should not pollute the root history sidebar.
- Restored assistant steps need stable IDs and must not merge into unrelated turns.
- Negative synthetic turn IDs were a workaround; the better answer is explicit event identity.
- Usage/cost stats may need message-level aggregation for long-lived sessions.
- Restored tool parts, images, apply-patch metadata, and task results need the same normalized structure as live events.

Preparation implication:

- Live and restored event paths should converge at `chat_event`, not at provider-specific message converters.

## Discovery Lessons

Provider/model/agent discovery is its own problem and should not be mixed with streaming.

Observed lessons:

- Keep an `opencode default` placeholder and do not parse it as a concrete model.
- When `opencode default` is selected, omit the explicit model in prompts and let opencode resolve it.
- Provider defaults should respect opencode provider-list order, not alphabetical order.
- Stale configured default labels should not override provider defaults.
- Connected provider catalogs should be merged carefully; disconnected providers should not appear as usable models.
- `enabled_providers` and `disabled_providers` need explicit filtering rules.
- Last-used project model can be useful, but it must be labeled as such.
- Agent discovery needs a CLI default placeholder plus visible primary/all agents and built-in fallbacks.
- Plan mode should map to opencode's native planning agent when possible.

Preparation implication:

- Model/agent discovery should have separate fixtures and should not be required to prove the event contract.

## Permission And Question Lessons

Permission and question handling worked best when treated as request/reply protocols.

Observed lessons:

- Preserve opencode request IDs exactly.
- Deduplicate request IDs so the same question or permission is not answered twice.
- Mode-aware auto behavior is necessary but should stay small and tested.
- Java-side permission memory may still reply `once` to opencode while enforcing "always" in the plugin.
- Question requests should use the existing AskUserQuestion UI rather than being rejected by default.
- Cancellation should explicitly reject provider requests.

Preparation implication:

- `chat_event` needs `permission` and `question` kinds with request IDs, choices, and reply state.

## Runtime Lifecycle Lessons

The managed server path is useful but fragile.

Observed lessons:

- User-managed CLI path discovery must include opencode's own install directory.
- Path discovery must avoid duplicate PATH entries.
- Transport failures such as `fetch failed` or `ECONNRESET` should discard persistent runtimes.
- Context-window errors are not transport failures and should not discard the runtime.
- Post-stream daemon cleanup can race with successful completion and should not create false send errors.
- Discovery endpoints need timeouts and retries.
- Prompt execution may need much longer timeouts than discovery calls.

Preparation implication:

- Server lifecycle tests should distinguish setup errors, transport errors, context errors, and successful turns with cleanup noise.

## Context Recovery Lessons

Context-window failure is not an edge case for opencode; it needs product handling.

Observed lessons:

- Detect context-window errors separately from generic failures.
- Offer recovery options: compact current session, start a new session with a summary handoff, or start empty.
- Preserve the failed prompt so recovery can retry it automatically.
- Keep recovery summaries bounded; a recovery prompt can itself exceed context.

Preparation implication:

- Context recovery should be a follow-up feature, but the event/error contract should leave room for structured recovery actions.

## What To Do Differently Next Time

1. Build `chat_event` and replayable event capture before the full opencode provider.
2. Add event coverage fixtures before broad UI integration.
3. Implement opencode send/stream/history as the first proving adapter, but keep model, agent, slash command, MCP, usage, and context recovery as separate slices.
4. Treat live stream and restored history parity as a required acceptance check from the beginning.
5. Avoid adding provider-specific frontend merge hacks; add missing concepts to the event model instead.
6. Keep the opencode runtime user-managed and report setup failures clearly.
7. Use the failed experiment's fixture approach (generate fixtures from logs as issues show up), but generalize it across providers.

## Documentation Impact

These lessons strengthen the existing draft docs:

- [PREPARATION.md](./PREPARATION.md) should require replayable event capture and live/history parity.
- [STREAMING-EVENT-LOGS.md](./STREAMING-EVENT-LOGS.md) should be treated as a core deliverable, not optional debugging polish.
- [MULTI-PROVIDER-ARCHITECTURE.md](./MULTI-PROVIDER-ARCHITECTURE.md) should keep provider routing but move render semantics into `chat_event`.
- [OPENCODE-INTEGRATION-QUICKSTART.md](./OPENCODE-INTEGRATION-QUICKSTART.md) should stay scoped to the first integration slice and avoid bundling every discovery/UI feature into the initial event infrastructure PR.
