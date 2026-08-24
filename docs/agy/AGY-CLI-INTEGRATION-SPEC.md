# Antigravity CLI (agy) → plugin provider `gemini`

## Goal

First-class provider id **`gemini`** in jetbrains-cc-gui, backed by **Antigravity CLI** headless NDJSON (`agy -p … --output-format stream-json`), not Claude Agent SDK and not ACP.

## Minimum agy version

**1.1.11** — required for the plan-usage probe (read-only slash commands in print mode, see below). Older agy still works for chat turns.

## Transport

```
UI provider=gemini
  → SessionSendService.sendToGemini
  → GeminiSDKBridge.sendMessage (one-shot channel-manager)
  → node channel-manager.js gemini send  (stdin JSON, GEMINI_USE_STDIN=true)
  → services/gemini/message-service.js
  → agy-runner.js spawn: agy -p <msg> --output-format stream-json [--conversation id] …
  → agy-event-normalizer.js → Claude-compatible stdout tags
  → GeminiMessageHandler → webview
```

### Turn watchdog

15-min **idle** watchdog (re-armed on every stdout line / stderr chunk), not a total turn cap: legitimately long turns (builds, emulator sessions) keep streaming and survive; only turns that stop producing output entirely (auth prompt, stuck pipe) are reaped. `turnTimeoutMs: 0` disables it. One silent long-running tool call can still trip it — the timeout text tells the user to background such tasks (`nohup … &`).

## Multi-turn

`conversation_id` from agy `init` / `result` is stored as plugin `sessionId` and passed back as `--conversation` on later turns.

### Session reset

Clear `sessionId` (no `--conversation` on the next turn) when:

- the user starts a new chat tab session (`createNewSession` already sets id to null)
- Gemini **model** changes (including effort slug changes) — resume of a multi-model fat history is what produced ~2M context on a 128k model
- **provider** switches (Claude/Codex/Gemini ids are not interchangeable)

### cwd / workspaceDirs guard

agy uses process cwd as `workspaceDirs`. Never spawn with:

- JetBrains plugin / Application Support trees
- embedded or standalone `ai-bridge`
- `~/.gemini` / antigravity-cli home

Java `PathUtils.selectSafeWorkingDirectory` + Node `selectWorkingDirectory` / `isUnsafeWorkingDirectory` enforce this; `runAgyTurn` always resolves cwd through `selectWorkingDirectory`. An unsafe cwd is passed as `null` from Java onward (the bridge falls back to its own default) — never silently clamped to a different directory.

## Permissions

Headless has no Ask UI. Default: soft-deny. Plugin modes map via `mapPermissionMode`:

| Plugin mode | agy |
|-------------|-----|
| plan | `--mode plan` |
| acceptEdits | `--mode accept-edits` |
| bypass / yolo / dontAsk | `--dangerously-skip-permissions` |
| sandbox | `--sandbox` |

## Auth

User runs `agy` once in a terminal (Google Sign-In). Binary resolution below.

## Binary resolution

The Java availability probe (`CliStatusDetector`) and the JS resolver (`resolveAgyBinary`) must stay in lockstep — a key or dir one side probes and the other does not means "available" status with failing sends.

- **Env overrides (exact set):** `AGY_PATH`, `AGY_CLI_PATH` — nothing else.
  - `GEMINI_CLI_PATH` is deliberately NOT honored — it names Google's gemini CLI in pre-existing setups and would be spawned with agy-only flags. Setups that relied on it must move to `AGY_PATH` / `AGY_CLI_PATH` (send-failure hints say so).
  - `AGY_BIN` / `ANTIGRAVITY_BIN` were never read by the bridge; the detector does not list them either.
- **Home install dirs (probed by both sides):** `~/.gemini/antigravity-cli/bin`, `~/.antigravity/bin`, `~/.local/bin`, `~/bin` — then `PATH` plus the shared npm/package-manager dirs.
- **Windows names:** `agy.exe` preferred, then `agy.cmd`, then bare `agy`.
- `agy.real` (internal install artifact) is forbidden — an `AGY_PATH` pointing at it is ignored and discovery continues.

### Windows `.cmd` shims

A discovered `agy.cmd` npm shim cannot be spawned directly (Node's CVE-2024-27980 patch throws EINVAL on `.cmd`/`.bat`). Both agy spawn sites — the turn runner (`agy-runner.js`) and the `agy models` catalog probe (`agy-utils.js`) — route through the shared `resolveCliSpawn` wrapper (`utils/cli-path.js`), which launches shims via `cmd.exe /d /s /c` by basename. On posix this is a passthrough (same file/args/options).

## Models & effort tiers

`agy models` prints one `id  Human Label (Effort)` line per model. The plugin groups ids into families (`gemini-3.6-flash`) with the effort tier baked into the slug (`gemini-3.6-flash-medium`).

- Effort is passed **only** via the full `--model` slug — never a separate `--effort` flag (bare slugs like `claude-sonnet-4-6` reject it; effort-required families are selected via the slug).
- A bare family id (legacy persisted state) is resolved against the families catalog: the tier the family actually offers (its default, e.g. `-medium`). **Without a warm catalog the spawn path guesses `-high`.**
- The catalog is warmed per process: the one-shot channel-manager pays one serial `agy models` probe per bare-id send; the long-lived daemon keeps the module cache until restart. **No TTL** — a zero-result probe keeps serving the last catalog until the process restarts (staleness is tracked as deferred work).

## Attachments

agy headless has no multimodal flag. Image attachments are materialized to temp files and injected as Read-tool references (same pattern as pi/omp; shared `utils/cli-image-input.js`).

- Images only, up to 2 MB each (shared `GROK_MAX_IMAGE_BYTES` constant — the user-facing note derives from it, so they cannot diverge).
- Non-image attachments, invalid data, and over-limit images are not silently dropped: a `[System note: … were not delivered …]` line is appended to the message so the user sees why an attachment chip did not reach the model.

## Plan usage (agy ≥ 1.1.11)

`GeminiPlanUsageService` runs a one-shot probe:

```
agy -p "/usage" --output-format json
```

agy answers read-only slash commands structurally **without an agent turn** — zero tokens, zero quota spend, no conversation left behind (`conversation_id` empty, `num_turns` 0). Payload: `command.data.groups[].buckets[]` with `window` (`5h`|`weekly`), `remaining_fraction`, `reset_time`. Java normalizes to the shared plan-usage shape (`capacity_pct` + `windows[]` + `families{gemini,third_party}`).

Detection of too-old agy: no `command` object in a `SUCCESS` payload means the text ran as a model prompt (pre-1.1.11 behavior) → report unavailable with an upgrade hint, never burn quota.

Cache TTL 90 s (webview polls every 120 s); spawn timeout 15 s in a temp cwd (never inherit plugin cwd as `workspaceDirs`).

## status:"ERROR" vs exit code (agy ≥ 1.1.11)

Interactive-only slash commands (`/clear`, …) now fail fast in print mode: the result payload carries `status:"ERROR"` + actionable `error` text, **but the process still exits 0**. The runner must trust the payload `status`, never the exit code; `message-service` throws `turn.error` to `[SEND_ERROR]` when there is no response text.

## `command_result` stream event (agy ≥ 1.1.11)

`--output-format stream-json` emits `{"event":"command_result","command":{name,data}}` for read-only slash commands, followed by the usual terminal `result` (whose `response` carries the human-readable text). The normalizer stores `commandResult` and emits no bridge tags for it — the text flows via `result` as with any other turn.

## Known limitations

- Families catalog has no TTL / no disk cache (see *Models & effort tiers*); a daemon serves the catalog it saw at its last successful probe until restart.
- Windows: NTFS junctions/reparse points inside an agy history dir are not followed by the `NOFOLLOW_LINKS` deletion walk.
- macOS case-insensitive volumes: the cwd-guard compare is lexical; a differently-cased real dir is rejected and falls back to the project dir (fail-safe, not fail-open).
- UNC workspace roots (`\\server\share`) are not supported by the cwd guards.
- A symlinked bridge install tree defeats the anchored install-dir check (the bridge realpaths its own dir at startup, which covers the common case).

## Out of scope (v1)

- On-disk history browser for agy conversations
- Interactive permission dialogs for agy tools
- Persistent daemon ACP session (one-shot per turn is enough)
