# Provider Compatibility Matrix

## Purpose

The proposed `chat_event` contract is not only an opencode requirement. ACP, Cursor, opencode, and Codex all expose structured runtime concepts that are awkward to preserve through a message-only render path.

This matrix shows which proposed event kinds and interface additions are useful for each integration. It is intended to justify the shared event layer before implementing any single provider completely.

Cells are intentionally conservative. If a concept exists only in one provider surface, an optional capability, an experimental API, or requires adapter synthesis, the cell is marked partial or optional rather than direct.

## Legend

| Icon | Value | Meaning |
| --- | --- | --- |
| ✓ | Direct | The provider or protocol has a native concept that maps directly for the base integration path. |
| ◐ | Partial | The provider exposes related data, but at least one common path needs adapter mapping, synthesis, or fallback handling. |
| ◇ | Optional | The concept is useful for some agents or modes, but not required for the base integration. |
| × | Not core | The concept is not expected from the base integration. |

## Provider Surface Summary

| Integration | Structured surface | Why `chat_event` helps |
| --- | --- | --- |
| Generic ACP | `session/prompt`, `session/update`, `agent_message_chunk`, `tool_call`, `tool_call_update`, `session/request_permission` | ACP is already event-oriented. A shared event contract can map ACP without a provider-specific frontend renderer. |
| Cursor | SDK `run.stream()` and `onDelta`, CLI `stream-json`, Cursor ACP and its `cursor/*` extension methods | Cursor exposes structured data across multiple surfaces, but the surfaces are not equivalent. For example, CLI `stream-json` suppresses thinking while the SDK exposes thinking deltas. |
| Opencode | HTTP `/event`, `message.*`, `message.part.*`, `permission.*`, `question.*`, `todo.updated`, `session.diff`, session APIs | Opencode has session/message/part identity and shared event streams that should not be flattened too early. Its newer event surfaces also expose typed shell, step, text, reasoning, and tool lifecycle events. |
| Codex | `codex exec --json` / SDK JSONL with `thread.*`, `turn.*`, `item.*`, `error`; app-server JSON-RPC for richer clients | Codex JSONL directly covers thread, turn, item, reasoning, command, file-change summary, MCP, web-search, todo, and usage concepts. Richer approvals, full diffs, plan deltas, user-input requests, and child-thread surfaces are app-server-specific or experimental. |

## Event Kind Compatibility

| `chat_event` kind | ACP | Cursor | Opencode | Codex | Interface value |
| --- | --- | --- | --- | --- | --- |
| `text` | ✓ `agent_message_chunk` | ✓ assistant events and text deltas | ✓ text parts and text deltas | ✓ agent message items | Replaces raw append-only text merging with block-scoped deltas. |
| `thinking` | ✓ `agent_thought_chunk` | ◐ SDK thinking messages and deltas are direct, but CLI `stream-json` suppresses thinking | ✓ reasoning parts and reasoning deltas | ✓ reasoning items | Keeps reasoning separate from final answer text. |
| `tool` | ✓ `tool_call`, `tool_call_update` | ✓ `tool_call`, partial tool-call deltas, completion events | ✓ tool parts, tool state, and newer tool lifecycle events | ✓ command, MCP, web-search, and other item lifecycle events | Adds stable `toolCallId`, lifecycle `phase`, and result state. |
| `diff` | ✓ tool content can include diff content | ◐ write/edit surfaces expose file edits, but full diff metadata depends on Cursor surface and mode | ✓ `session.diff`, patch parts, and edit metadata | ◐ JSONL file-change items are summaries; app-server has richer diff notifications | Makes file changes first-class instead of reconstructing them from tool text. |
| `terminal` | ◇ native only when the client advertises terminal capability | ◐ SDK exposes shell-output deltas, while CLI `stream-json` mainly reports shell/tool results | ◐ shell/PTY events exist, but current tool output may still need adapter mapping | ◐ command output is direct, but generic terminal stream/reference support is app-server-specific | Preserves terminal output as a stream/reference instead of a giant text block. |
| `permission` | ✓ `session/request_permission` | ◐ Cursor ACP maps directly; SDK and CLI approval surfaces differ | ✓ `permission.asked` / `permission.replied` and v2 permission events | ◐ app-server approvals are structured, but SDK/CLI JSONL has no approval request event | Preserves provider request IDs, choices, and reply state. |
| `question` | × no core question-request update | ◐ Cursor ACP has `cursor/ask_question`; other Cursor surfaces differ | ✓ `question.asked` / `question.replied` and v2 question events | ◇ app-server has experimental user-input request surfaces; JSONL has no core question item | Lets providers ask the user without faking a tool call. |
| `plan` | ✓ `plan` updates, with complete replacement semantics | ◐ Cursor ACP has `cursor/create_plan` and product plan mode, but SDK/CLI plan output is surface-specific | ◐ planning agent and plan-like tool output, not a single stable plan event | ◐ app-server has plan notifications; SDK JSONL primarily exposes todo-list items | Gives planning UI a shared structure across providers. |
| `todo` | × no core todo update separate from plan | ◐ Cursor ACP has `cursor/update_todos`; other surfaces are not equivalent | ✓ `todo.updated` | ✓ `todo_list` items | Avoids provider-specific todo rendering. |
| `task` | × no core task/subagent session event | ✓ SDK task messages and Cursor ACP `cursor/task` | ✓ subtask parts and task/tool metadata when emitted | ◇ app-server subagent and child-thread surfaces exist; SDK JSONL has no base child-task item | Preserves child session/task identity without polluting root history. |
| `usage` | ◇ native `usage_update`, but optional | ◐ token deltas, turn-ended usage, duration, and result metadata are surface-specific | ✓ step-finish tokens/cost and newer step-ended usage fields | ◐ `turn.completed.usage` and app-server token-usage notifications need normalization | Gives usage/cost UI one normalized source. |
| `mode` | ◇ `current_mode_update` and session modes are optional/configurable | ◐ SDK/CLI/ACP support modes, but mode changes are mostly configuration rather than stream events | ◐ agent/model switch and plan/default mapping need adapter semantics | ◐ sandbox, permission, collaboration-mode, and effort settings are configuration/app-server concepts | Makes mode changes explicit instead of hidden in provider config. |
| `status` | ◐ tool statuses are direct; prompt/session status is mostly inferred | ✓ run, step, and cloud status events | ✓ `session.status` and part/tool state | ✓ thread, turn, item lifecycle and error events | Provides one lifecycle model for running, idle, completed, and failed states. |

## Interface Additions

| Addition | ACP | Cursor | Opencode | Codex | Why it matters |
| --- | --- | --- | --- | --- | --- |
| `provider` and session identity | ◐ `sessionId` is direct; `provider` is adapter-assigned | ◐ agent/run/session IDs are direct by surface; `provider` is adapter-assigned | ◐ `sessionID` is direct; `provider` is adapter-assigned | ◐ `thread_id` / thread IDs are direct; `provider` is adapter-assigned | Required for routing, history lookup, event filtering, and replay. |
| `turnId` and `runId` | ◐ prompt turns exist, but explicit turn/run IDs must be synthesized from JSON-RPC request context | ◐ SDK `run_id` is direct; CLI/ACP surfaces need mapping | ◐ synthesize from session and message flow | ◐ app-server has turn IDs, but exec JSONL does not expose a turn ID and has no run ID | Separates one user prompt from long-lived session history. |
| `messageId`, `stepId`, `partId`, `blockId` | ◐ message identity is optional, so adapters may assign stable step/block IDs | ◐ run and step IDs exist in some SDK paths; message/block identity still needs mapping | ◐ `messageID` and `partID` are direct; UI block IDs still need mapping | ◐ `item.id` is direct; message/step/part/block IDs need mapping or synthesis | Prevents post-hoc merging from reordering text, tools, and snapshots. |
| `toolCallId` | ✓ `toolCallId` on tool calls | ✓ `call_id` / `toolCallId` on tool events | ✓ `callID` on tool parts and permission-linked tools | ◐ command/MCP/web-search items have usable identity, but the adapter may need to synthesize one for item types without an explicit call ID | Correlates tool start, updates, result, permissions, and UI cards. |
| Monotonic `sequence` | ◐ assign at adapter boundary | ◐ assign at adapter boundary | ◐ event IDs/timestamps exist, but replay-safe monotonic sequence should be assigned by the adapter | ◐ assign from JSONL or notification order | Makes replay deterministic and avoids timestamp-dependent rendering. |
| Lifecycle `phase` | ◐ tool and plan statuses map directly; text and session phases need synthesis | ◐ SDK status and step updates map directly, but normalized phases still need adapter mapping | ◐ many part/tool states map directly, but snapshots and restored history may need phase synthesis | ✓ from turn and item lifecycle | Normalizes `started`, `delta`, `updated`, `completed`, and `failed`. |
| `parentId` | ◐ parent links are not a stable core ACP primitive and may need synthesis | ◐ task/subagent and run-step relationships depend on the selected surface | ◐ session `parentID`, subtask, and tool-child data may need adapter correlation | ◐ app-server has some parent-thread linkage; SDK JSONL generally needs inference | Preserves nesting without provider-specific frontend logic. |
| Permission request fields | ✓ `session/request_permission` carries session, tool call, and choices | ◐ Cursor ACP has request IDs and choices; SDK request surfaces may need adapter-specific correlation | ✓ permission events carry request/session/action and tool metadata | ◐ Codex approvals do not always expose the same request/choice shape | Standardizes request ID, action/tool, choices, and reply state. |
| Diff metadata | ◐ ACP diff content has path/oldText/newText, while scope/source/hunks need adapter metadata | ◐ edit/diff metadata depends on Cursor surface and mode | ✓ `session.diff` carries file diffs and patch/edit metadata carries changed paths | ◐ SDK file-change metadata is summary-level; app-server has richer diff metadata | Preserves file identity, scope, source, hunks, and restored-history reconstruction. |
| Task child session fields | × no core child-task session fields | ◐ Cursor task events include task and optional agent identity, but durable child-session identity depends on the selected surface | ◐ subtask/session metadata exists, but child session IDs are only present when emitted by the task surface | ◇ app-server subagent/child-thread surfaces exist; SDK JSONL has no base child-task session concept | Keeps child sessions linked without showing them as root history. |

## Compatibility Impact

The shared additions are not equally important for every provider, but they are reusable across enough structured providers to justify a common contract.

High-value cross-provider additions:

- stable identity fields: `sessionId`, `turnId`, `messageId`, `stepId`, `partId`, `blockId`, `toolCallId`
- lifecycle fields: `sequence`, `phase`, `kind`, `parentId`
- event kinds: `text`, `thinking`, `tool`, `diff`, `terminal`, `permission`, `plan`, `status`
- surface-dependent event kinds: `question`, `todo`, `task`, `usage`, `mode`
- replayable capture stages: `native_in`, `normalized_out`, `legacy_out`
- live/restored history parity through the same accumulator

Primary evidence checked:

- ACP protocol docs and TypeScript SDK `SessionUpdate` schema.
- Cursor TypeScript SDK docs, CLI `stream-json` docs, CLI parameters/usage docs, and Cursor ACP docs.
- Local opencode source and generated SDK types under `/Users/moritz/Desktop/git/opencode`.
- OpenAI Codex non-interactive docs, Codex TypeScript SDK event/item types, and Codex app-server README.

Provider-specific additions should stay in adapters:

- CLI or SDK process lifecycle
- auth and local config discovery
- model and agent discovery
- provider-specific permission mode mapping
- provider-native history lookup

## Acceptance Use

Preparatory work should be able to point at this matrix and show that each proposed `chat_event` field or event kind is needed by at least one target integration, and preferably by more than one.

For the first infrastructure PR, the matrix does not require full ACP, Cursor, opencode, or Codex provider parity. It only requires enough fixtures or mapping sketches to prove that the shared event contract can represent their core structured events without provider-specific frontend merge hacks.
