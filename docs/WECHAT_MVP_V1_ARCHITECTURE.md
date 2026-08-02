# WeChat MVP v1 Architecture Baseline

**Status**: MVP v1 scope

---

## 1. Product Goal

Enable a WeChat conversation to interact with an existing CC GUI tab/session
through the WeChat iLink transport integration and the Remote Gateway HTTP +
SSE API.

**MVP v1**: one WeChat conversation → one existing CC GUI tab/session in one
PyCharm Project; the provider is the target tab's current provider.

---

## 2. Exact MVP Topology

```
WeChat
  ↓
WeChat iLink transport
  ↓
Local WeChat transport adapter
  ↓ (127.0.0.1 HTTP + SSE, Bearer auth)
Remote Gateway
  ↓
ONE projectId → ONE tabId → ONE ClaudeChatWindow → ONE ClaudeSession
  ↓
Verified scope: Claude provider
```

### Current design decisions

| Decision | Status |
|----------|--------|
| One WeChat connection → one target binding | Current |
| Target = existing projectId + existing tabId | Current |
| Adapter does NOT own Agent session | Current |
| Verified scope: Claude provider | Current |
| No remote tab creation | Current |
| Single Gateway (one PyCharm process) | Current |

### DEFERRED decisions

| Decision | Status |
|----------|--------|
| Multi-Gateway discovery | DEFERRED |
| Remote new tab creation | DEFERRED |
| Queue | Not part of MVP v1 (future capability) |
| Other providers, including Codex | Outside the current verified support scope |
| Multi-PyCharm process routing | DEFERRED |

### Related documentation

WeChat authentication/credential management, message formatting, reconnection,
backoff, and message deduplication behavior are documented in
`docs/wechat-qr-login-ccgui-ux-architecture.md`.

---

## 3. One-WeChat / One-Target Rule

The binding is:

```
WeChat session → Adapter → TargetBinding → Gateway → (projectId, tabId)
```

**Exactly one active target at a time.** Rebinding replaces the target. No fan-out. No broadcast.

---

## 4. Target Identity

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 49321,
    "token": "<bearer token>"
  },
  "projectId": "<32-char hex SHA-256 of basePath>",
  "tabId": "<UUID assigned by RemoteTabRegistry>"
}
```

- `projectId`: deterministic hash of project basePath (`RemoteProjectId.of(basePath)`)
- `tabId`: stable per-ClaudeChatWindow UUID (`RemoteTabRegistry.tabIdFor(window)`)

---

## 5. Bind / Rebind Semantics

### Current

| Action | Semantics |
|--------|-----------|
| **Bind** | Connect WeChat to `(projectId, tabId)`. Target must exist (validated by GET /tabs) |
| **Rebind** | Binding to `(B, B1)` replaces prior binding to `(A, A1)`. No automatic abort of prior target's running turn |
| **Tab close** | The binding may not flip immediately; the next send detects the missing target, reports the target invalid, and requires rebind. Never auto-binds another tab |
| **Project close** | Binding becomes INVALID. Same rule as tab close |
| **Gateway down** | Binding becomes OFFLINE. Adapter retry/reconnect with backoff |
| **WeChat disconnect** | DO NOT abort ClaudeSession. The Agent belongs to CC GUI — it continues running |
| **WeChat logout** | Unbind target. DO NOT abort running Agent unless user explicitly requests Stop |
| **Explicit Stop** | Adapter calls `POST /tasks/{taskId}/abort` → `ClaudeSession.interrupt()` — same as Remote Abort |

---

## 6. Same ClaudeSession Continuation

### Current

WeChat and Desktop share the SAME `ClaudeSession.send()` path:

```
Desktop:
  SessionHandler.handleSendMessage()
    → ClaudeSession.send()
    → sendMessageToProvider(turnProvider, channelId, ...)
    → DaemonBridge.sendCommandChecked(...)

Remote:
  POST /chat
    → RemoteChatDispatcher.dispatch(project, tabId, message, gen)
    → SessionTurnGate.acquire(session)
    → session.send(message)
    → Same sendMessageToProvider path as Desktop
```

**They are the same ClaudeSession.** No second backend. No second AI. Conversation state is shared: Desktop sends → Remote sends follow-up → Desktop continues → all within same session.

| Source | Proof |
|--------|-------|
| `RemoteChatDispatcher` | `session.send(message)` — the same ClaudeSession from tab resolution |
| `RemoteTabResolver` | `ClaudeSession session = window.getSession()` — exact session from exact window |
| `ClaudeSession` | `providerRouter.clearAbort(...)` — same cleanup |

---

## 7. Permission Mapping

| Desktop | Remote | Shared Path |
|---------|--------|-------------|
| Dialog shown | `permission.requested` SSE event | `SharedInteractionResolver.register()` |
| User clicks Allow/Deny | `POST /permissions/{id}/decision` | `SharedInteractionResolver.resolvePermission()` |
| Decision applied | Decision applied | `InteractionHandle.tryComplete()` — first-wins CAS |

WeChat Adapter maps:
- SSE `permission.requested` → WeChat message asking user to approve/deny
- WeChat user response → `POST /permissions/{id}/decision { taskId, decision }`
  with `decision` = `ALLOW` | `ALLOW_ALWAYS` | `DENY`

---

## 8. Abort Mapping

| Action | Endpoint | Behind the scenes |
|--------|----------|-------------------|
| Desktop Stop button | N/A | `ClaudeSession.interrupt()` |
| Remote abort | `POST /tabs/{tid}/tasks/{taskId}/abort` | `RemoteControlHandler.abortTask()` → `session.interrupt()` |
| Gateway dispose | N/A | `requestAbortAllActive()` → `session.interrupt()` |

**All converge on `ClaudeSession.interrupt()`** — shared by Desktop, Remote, and Gateway dispose.

WeChat Adapter maps:
- WeChat user "stop" command → `POST /tabs/{tid}/tasks/{taskId}/abort`

---

## 9. Progress / Final / Error Event Mapping

| SSE Event | Maps to |
|-----------|---------|
| `task.accepted` | 任务已接受，进入实际发送启动流程 |
| `task.started` | Turn actively running — show "thinking" indicator |
| `assistant.content` (content delta) | Stream assistant response |
| `tool.started` / `tool.completed` / `tool.failed` | Tool execution notifications |
| `permission.requested` | Request user approval for tool |
| `question.requested` | Request user answer |
| `plan.requested` | Request plan approval |
| `task.completed` | Turn finished successfully — show final response |
| `task.failed` | Turn failed — show error |
| `task.aborted` | Turn aborted — show "cancelled" |
| `usage.updated` | Token usage summary |

---

## 10. Provider Boundary

The Remote Gateway infrastructure (gate, registry, events, interactions) is
provider-agnostic, and the gateway dispatches to the target tab's current
provider. The current verification scope is the Claude provider; other
providers are not part of the verified support scope for this feature.

---

## 11. Existing-Tab-Only Rule

### Current

- User MUST manually create/select a CC GUI tab before binding
- Adapter MUST NOT create tabs programmatically
- Adapter validates binding by calling `GET /projects/{pId}/tabs` and confirming target tabId exists

### Future extension

Remote tab creation requires EDT bridge + JCEF initialization + ContentManager manipulation. Feasibility classified as MEDIUM. Deferred to MVP v2.

---

## 12. What Adapter Owns

| Owned by Adapter | Details |
|------------------|---------|
| WeChat authentication/credential | Per-user WeChat session management |
| Message receive/send transport | WeChat iLink transport integration |
| Reconnection | Gateway discovery polling, backoff |
| Message deduplication | Idempotency keys |
| Formatting | WeChat message → CC GUI input conversion |
| Target binding | Map WeChat session → `(projectId, tabId)` |
| Action mapping | WeChat commands → Gateway endpoints |

---

## 13. What Adapter MUST NOT Own

| MUST NOT Own | Why |
|-------------|-----|
| API key / base URL | Configured in CC GUI provider settings |
| Model selection | Configured in CC GUI tab settings |
| Claude backend | CC GUI owns the Claude/Codex session |
| Permission resolution | Handled by SharedInteractionResolver |
| ClaudeSession state | CC GUI owns conversation history |
| Agent lifecycle | Claude/Codex session is CC GUI's |
| Second Claude backend | Would violate architecture constraint #2 |

---

## 14. Security Boundary

```
WeChat (internet, authenticated by platform)
  ↓
WeChat iLink transport (platform-authenticated)
  ↓
WeChat Adapter (local process, 127.0.0.1, Bearer token)
  ↓
Remote Gateway (127.0.0.1, Bearer token, host/origin validation)
  ↓
CC GUI Java backend (existing auth/permission model)
```

**Adapter is a trusted local process.** It runs on the same machine as CC GUI, connects via loopback, authenticates with the Gateway's Bearer token.

---

## 15. Lifecycle State Model

```
UNBOUND
  → bind(projectId, tabId) → verify via GET /tabs
  → BOUND
      → send message → POST /chat
      → receive events → GET /events (SSE)
      → abort → POST /tasks/{taskId}/abort
      → tab closed → INVALID
      → project closed → INVALID
      → gateway down → OFFLINE
      → unbind → UNBOUND
  → INVALID
      → user reopens tab → can rebind
      → rebind(projectId, tabId) → BOUND
  → OFFLINE
      → gateway restarts → can rebind
      → rebind(projectId, tabId) → BOUND
```

---

## 16. Explicit MVP Exclusions

| Exclusion | Rationale |
|-----------|-----------|
| Remote tab/session creation | EDT + JCEF complexity; user creates manually |
| Multi-Gateway discovery | Single PyCharm process for MVP |
| Queue | Busy requests are not queued; an automatic queue is a future capability |
| Multiple simultaneous WeChat sessions | One active target binding |
| Image/file attachments via WeChat | MVP is text-only Claude chat |
| Other providers, including Codex | Outside the current verified support scope |
| Internationalization (i18n) for WeChat-side messages | Deferred |

---

## 17. Future Extensions (Not MVP)

| Extension | Dependencies |
|-----------|-------------|
| Remote tab creation | EDT bridge, ContentManager API, persistence |
| Multi-Gateway discovery | PID-based discovery files, external Registry |
| Queue | Future capability; not part of MVP v1 |
| Other provider verification | Requires dedicated compatibility testing |
| Multi-project routing via one WeChat session | Target binding extension |
| Image/file attachments | Multipart upload, temp file management |

---

## 18. Related Documentation

Current behavior for login, message format, reconnection, rate limiting, and
long-running turns is documented in
`docs/wechat-qr-login-ccgui-ux-architecture.md` and the adapter source under
`adapter/src`.

---

## 19. Verification

Automated tests: `adapter/test`, `src/test/java/com/github/claudecodegui/wechat`,
and the Webview tests under `webview/src`. The API-level behavior is documented
in `docs/REMOTE_GATEWAY_API_EVENT_CONTRACT_V1.md`; setup, operation, and
troubleshooting are documented in
`docs/wechat-qr-login-ccgui-ux-architecture.md`.

---

## 20. References

| Document | Path |
|----------|------|
| Core Baseline | `docs/REMOTE_GATEWAY_CORE_BASELINE.md` |
| API / Event Contract | `docs/REMOTE_GATEWAY_API_EVENT_CONTRACT_V1.md` |
| Connection UX / Operation | `docs/wechat-qr-login-ccgui-ux-architecture.md` |
