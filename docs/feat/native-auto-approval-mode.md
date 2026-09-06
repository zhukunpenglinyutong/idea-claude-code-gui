# Native Auto-Approval Modes

## Goal

Expose the native automatic approval modes added by Claude Code and Codex while preserving the existing unrestricted `bypassPermissions` behavior as a separate **Full Auto** option.

## Investigation findings

### Claude

- Native mode value: `auto`.
- Agent SDK option: `permissionMode: 'auto'`.
- Runtime updates use the existing `query.setPermissionMode('auto')` control path.
- The SDK delegates approval decisions to Claude's classifier instead of bypassing permission checks.
- `@anthropic-ai/claude-agent-sdk` `0.3.182`, the plugin's current minimum version, already includes `auto` in its `PermissionMode` type.
- Reference: <https://code.claude.com/docs/en/permission-modes>

### Codex

- CLI convenience option observed in some Codex releases: `--approve-for-me` (alias `--not-so-yolo`).
- The plugin does not invoke that alias; it uses the SDK's generic `CodexOptions.config` path below, so the SDK floor is based on `approvals_reviewer` config support rather than the presence of a CLI flag.
- Equivalent configuration:
  - `approvals_reviewer = "auto_review"`
  - `approval_policy = "on-request"`
  - `sandbox_mode = "workspace-write"`
- The TypeScript SDK accepts `approvals_reviewer` through `CodexOptions.config`; thread options continue to carry `approvalPolicy` and `sandboxMode`.
- The verified SDK floor for the plugin's config-based path is `@openai/codex-sdk` / Codex CLI `0.146.0+`.
- The CLI alias is version-specific and is not the mechanism used by this plugin.
- Reference: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs>

## SDK invocation contract

### Claude Agent SDK

The AI Bridge builds the initial query with the normalized mode as a direct SDK option:

```js
const query = queryFn({
  prompt: runtime.inputStream,
  options: {
    cwd,
    permissionMode: 'auto',
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
    settingSources: ['user', 'project', 'local'],
  },
});
```

`permissionMode: 'auto'` is forwarded unchanged by `buildQueryOptions()`. The
`PreToolUse` hook returns `{ continue: true }` for this mode, so it does not make a
second approval decision; Claude Code's native mode flow invokes the classifier,
then sends only unresolved requests to `canUseTool`. A live mode change uses the
existing `query.setPermissionMode('auto')` control request and updates the reactive
mode state read by the hook.

Full Auto is intentionally different: only
`permissionMode: 'bypassPermissions'` adds
`allowDangerouslySkipPermissions: true` to the initial SDK options. That option is a
spawn-time flag, so entering or leaving Full Auto changes the runtime signature and
rebuilds the subprocess. Native `auto` does not add that flag and therefore shares
the live-switch signature with `default`, `plan`, and `acceptEdits`. If Full Auto is
selected while a turn is already running, the current subprocess remains bounded
by its original launch flag; the selected mode is persisted and takes effect when
the next send rebuilds the runtime.

### Codex TypeScript SDK

The reviewer must be placed in `CodexOptions.config` before constructing `Codex`;
`ThreadOptions` has no reviewer field. The effective native Auto call is:

```js
const codex = new Codex({
  config: {
    model_supports_reasoning_summaries: true,
    approvals_reviewer: 'auto_review',
  },
  env: sanitizedCliEnvironment,
});

const thread = codex.startThread({
  skipGitRepoCheck: true,
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  workingDirectory: cwd,
});

const { events } = await thread.runStreamed(input, { signal });
```

`@openai/codex-sdk` serializes these values into the child CLI invocation as:

```text
--config approvals_reviewer="auto_review"
--sandbox workspace-write
--cd <cwd>
--skip-git-repo-check
--config approval_policy="on-request"
```

Codex resolves `approval_policy` and `approvals_reviewer` before it emits the
`item.started` event for a command, and `file_change` can represent a patch that
has already been applied. Consequently, the event handler does not call the
Java approval bridge for native Auto and does not attempt a post-application
rollback; the Codex-native reviewer owns those approval decisions in the
non-interactive SDK stream.

The same thread options are passed to `resumeThread(threadId, options)` for every
turn. For resumed threads the plugin intentionally omits `workingDirectory` so
Codex can locate the persisted session; `approvalPolicy`, `sandboxMode`,
`skipGitRepoCheck`, and the `CodexOptions.config` reviewer override are still
applied. Non-auto modes explicitly set `approvals_reviewer="user"` to clear any
reviewer persisted in the resumed thread. Full Auto also uses the user reviewer
value, but its `approvalPolicy: 'never'` means no approval request is routed.
This keeps Full Auto separate from native Auto without relying on omission to
reset historical configuration.

Java also writes `CODEX_SANDBOX_MODE`, `CODEX_SANDBOX`, and
`CODEX_APPROVAL_POLICY` into the Node process environment to override inherited
Codex settings; the Node service removes those variables from the child environment,
reads them as controlled overrides, and re-enforces the exact
`workspace-write`/`on-request` pair for native Auto. It also rejects
`auto` before constructing `Codex` when the installed `@openai/codex-sdk` is below
`0.146.0`, while the Webview hides the option when dependency status explicitly
reports the same incompatibility.

## Mode model

| Plugin mode | Claude | Codex | Meaning |
|---|---|---|---|
| `default` | `permissionMode: 'default'` | `on-request` | User handles approval requests. |
| `acceptEdits` | `permissionMode: 'acceptEdits'` | Existing balanced mapping | File edits are less interruptive, but approval can still be requested. |
| `auto` | `permissionMode: 'auto'` | `auto_review` + `on-request` + `workspace-write` | Provider-native reviewer handles eligible approval requests. |
| `bypassPermissions` | `permissionMode: 'bypassPermissions'` | `never` with the existing sandbox mapping | Full Auto; ordinary approval checks are bypassed. |

`auto` is exposed only for Claude and Codex. Other CLI providers retain their existing mode list and behavior; in particular, Grok's internal `auto` alias for its existing `/always-approve` control path is not repurposed by this feature.

## Known limitations

### Claude auto mode requires a claude-sonnet model upstream

Claude's native auto mode delegates each tool call to a **server-side safety
classifier that runs on a claude-sonnet model** (currently `claude-sonnet-5`). It is
therefore only available when the upstream API actually serves a claude-sonnet
model. When the classifier model is not available — for example on third-party
relay/proxy endpoints that do not provide sonnet — tool calls that require
classification fail with a retryable error, while read-only operations keep
working:

> `claude-sonnet-5[1m] is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again... reading files, searching code, and other read-only operations do not require the classifier and can still be used.`

Users on endpoints without a claude-sonnet model should pick another permission
mode. Codex's `auto_review` runs locally inside the CLI and does not have this
dependency.

### Claude auto mode honors repository-level allow rules

In `default` mode the plugin's PreToolUse hook answers `ask` for tools with side
effects, so a malicious repository's `.claude/settings.json` allow-rule cannot
silently auto-approve them. In `auto` mode the hook yields to the SDK's native
flow, where matching allow rules are applied **before** the classifier runs —
the same semantics as the Claude Code CLI. Explicit `deny` rules still apply in
every mode. Users opening untrusted repositories should stay in `default` mode.

## Implementation

1. **Canonical mode and persistence**
   - Add `auto` to the Java and TypeScript permission-mode allowlists.
   - Preserve the existing per-provider Webview persistence and backend session/property persistence.
   - Keep `bypassPermissions` unchanged so existing saved Full Auto selections remain valid.
   - Migrate the legacy `autoEdit` alias to canonical `acceptEdits` for providers that support it (`default` for OMP); unsupported CLI provider `auto` values fall back to `default` without changing Grok's internal alias.

2. **Claude native routing**
   - Add `auto` to the AI Bridge Claude mode validator.
   - Let the PreToolUse hook yield to the SDK in `auto`, allowing the native classifier to decide.
   - Keep live switching through `setPermissionMode()`; unlike `bypassPermissions`, `auto` needs no runtime rebuild flag. Centralize failure handling so a rejected SDK control request leaves the local mode unchanged; Full Auto transitions mark a rebuild instead.
   - Update comments and tests that currently call `bypassPermissions` “Auto”, and reject stale runtime-epoch updates.

3. **Codex native routing**
   - Map plugin mode `auto` to `workspace-write`, `on-request`, and `approvalsReviewer: 'auto_review'`.
   - Copy that reviewer value into `CodexOptions.config.approvals_reviewer` before constructing `Codex`.
   - Force Java's permission environment override for `auto` to the native `workspace-write` / `on-request` pair rather than inheriting Full Auto or user sandbox overrides.
   - Reject `auto` before dispatch when the installed Codex SDK is below `0.146.0`, and hide the unsupported choice in the Webview when dependency status is known.
   - Raise Codex's full-feature minimum version to `0.146.0` and refresh fallback versions.

4. **User interface**
   - Add a dedicated `auto` item for Claude and Codex, including the execution-mode choice shown when a Claude plan is approved.
   - Rename the generic `bypassPermissions` display from “Auto” to “Full Auto”.
   - Use a shield/reviewer icon for native auto approval and retain the warning-colored lightning treatment for Full Auto.
   - Add provider-specific Codex wording (“Approve for me”) and update all shipped Webview locales.
   - Add the status-bar label for `auto` and update shipped Java resource bundles.

5. **Documentation and tests**
   - Update SDK permission documentation where the old mode naming is described.
   - Extend Java session validation tests.
   - Extend Claude bridge tests for request construction, live switching, plan-exit mode synchronization, and no-rebuild transitions involving `auto`.
   - Extend Codex mapper/config and event-handler tests for `approvals_reviewer = 'auto_review'`, explicit `user` reviewer resets, and no late Java approval after Codex has started an approved item.
   - Extend `ModeSelect` tests for provider-specific visibility and Full Auto distinction.

## Verification

- `node --check` on all modified AI Bridge JavaScript files.
- `node --test ai-bridge/services/codex/codex-event-handler.test.js ai-bridge/services/codex/codex-utils.test.js ai-bridge/utils/permission-mapper.test.js ai-bridge/services/claude/permission-mode.test.js ai-bridge/services/claude/runtime-lifecycle.test.js ai-bridge/services/claude/setPermissionModePersistent.test.mjs ai-bridge/services/claude/setPermissionModePersistent.bypass.test.js`
- `cd webview && npm run test`
- `cd webview && npx vitest run src/components/PlanApprovalDialog.test.tsx src/components/ChatInputBox/selectors/ModeSelect.test.tsx src/hooks/providers/cliProviders.test.ts`
- `cd webview && npx tsc -p tsconfig.test.json --noEmit`
- `./gradlew test --tests com.github.claudecodegui.session.SessionStateTest --tests com.github.claudecodegui.session.SessionSendServiceTest --tests com.github.claudecodegui.dependency.DependencyManagerVersioningTest -PskipWebview=true`
- `./gradlew checkstyleMain -PskipWebview=true`
- Locale JSON and Java resource-bundle key checks.
- `git diff --check`

No plugin build or `runIde` is required for this change.

## Implementation status

Completed on 2026-08-31.

- AI Bridge permission, runtime, Codex event, and mapper tests: 113 passed.
- All modified AI Bridge JavaScript files passed `node --check`.
- Webview unit tests: 1,473 passed across 168 files; `npm run test` also passed the TypeScript test configuration.
- Java permission state, provider-mode normalization, session routing, and SDK versioning tests passed.
- `checkstyleMain` passed.
- All Webview locale JSON files and Java mode resource keys validated successfully.
- The local Codex CLI `0.146.0` accepted the config-based reviewer invocation through authentication setup; no authenticated model turn was run.
- `git diff --check` passed.
- No `runIde` or `buildPlugin` was run; Gradle test dependencies did regenerate ignored `build/` artifacts only.
