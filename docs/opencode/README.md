# Opencode Draft Docs

This folder contains preparation notes for adding opencode as a first-class provider.

## Status

**Planning only. Nothing in this folder is implemented.**

- There is no opencode code in this repository: no `ai-bridge/channels/opencode-channel.js`, no `ai-bridge/services/opencode/`, no Java `OpenCodeSDKBridge`, and no `@opencode-ai/sdk` dependency.
- A previous marker-based integration experiment ([PR #1239](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/1239)) was fully reverted. Its findings are captured in [LESSONS-LEARNED.md](./LESSONS-LEARNED.md).
- The only remnant in the tree is a disabled provider entry in `webview/src/components/ChatInputBox/types.ts`.

Current documents:

- [Preparation: Provider-Neutral Chat Events](./PREPARATION.md)
- [Opencode Integration Quickstart](./OPENCODE-INTEGRATION-QUICKSTART.md)
- [Opencode Multi-Provider Architecture](./MULTI-PROVIDER-ARCHITECTURE.md)
- [Provider Compatibility Matrix](./PROVIDER-COMPATIBILITY-MATRIX.md)
- [Streaming Event Logs And Replay Fixtures](./STREAMING-EVENT-LOGS.md)
- [Lessons From The Opencode Support Experiment](./LESSONS-LEARNED.md)

## Purpose

The immediate goal is not to document a finished opencode integration. The goal is to define the shared streaming and render infrastructure that should exist before the full provider lands.

The main preparation question is whether opencode should be adapted directly into the existing Claude/Codex-compatible message markers, or whether the plugin should first add a provider-neutral `chat_event` layer for structured agent events.

Current recommendation: proceed with opencode only after the shared `chat_event` contract, replayable event capture, frontend accumulator, and live/restored-history parity fixtures are defined. The first implementation slice should prove that contract with narrow streaming/history behavior before adding optional discovery, slash-command, MCP, usage, or recovery surfaces.

## Open Questions

Decisions that should be made (or at least owned) before implementation starts:

1. **Opencode API surface**: target the current stable session/event API or the newer v2 API generation? Upstream is mid-migration; event names and route availability differ between generations (see the API surface caveat in [OPENCODE-INTEGRATION-QUICKSTART.md](./OPENCODE-INTEGRATION-QUICKSTART.md)). The SDK version must be pinned when this is decided.
2. **`chat_event` transport**: the proposed default is a `[CHAT_EVENT] <json>` stdout marker line beside the existing markers (see [PREPARATION.md](./PREPARATION.md)). Confirm this against Java handler throughput before building the accumulator.
3. **Accumulator ownership**: the accumulator lives in the webview; confirm whether Java stays a pass-through for `chat_event` lines or needs to parse them (e.g., for permission dialogs).
4. **Schema evolution**: `chat_event` needs a version field or explicit compatibility rule before the first fixture is checked in, or replay fixtures will rot.
5. **Existing-provider proving surface**: which Codex flow is wrapped first to prove the contract (live streaming, history restore, or both)?

## Draft Structure

This mirrors the useful shape of `docs/codex/` without copying upstream reference docs prematurely:

- `README.md`: folder purpose, history context, and document index
- `PREPARATION.md`: infrastructure proposal and acceptance criteria
- `OPENCODE-INTEGRATION-QUICKSTART.md`: intended provider shape, implementation checklist, and smoke test
- `MULTI-PROVIDER-ARCHITECTURE.md`: opencode-era provider architecture and shared event plane
- `PROVIDER-COMPATIBILITY-MATRIX.md`: ACP, Cursor, opencode, and Codex mapping for proposed event/interface additions
- `STREAMING-EVENT-LOGS.md`: replayable event logging format for debugging and fixture generation
- `LESSONS-LEARNED.md`: findings from the failed opencode support implementation experiment, publicly referenced by [PR #1239](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/pull/1239)

If opencode implementation proceeds, follow-up docs can be added in the same style as Codex:

- focused debugging or troubleshooting notes when real issues appear
