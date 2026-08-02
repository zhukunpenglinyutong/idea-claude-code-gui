# REMOTE GATEWAY CORE BASELINE

**Status**: Implemented

---

## 1. Current Architecture

```
External Client (Transport Adapter)
    ↓ HTTP + SSE (127.0.0.1 only, Bearer auth)
RemoteApiRouter
    ↓
RemoteChatDispatcher  ←── RemoteControlHandler ──→ Permission/Question/Plan
    ↓
SessionTurnGate ──→ ClaudeSession.send() ──→ ClaudeSDKBridge ──→ DaemonBridge ──→ ai-bridge
    ↓
RemoteEventTap ──→ RemoteEventBus ──→ SSE subscribers
```

**One Gateway per IDE process** (`@Service(Service.Level.APP)`). Routes to multiple Projects within same JVM via `projectId` + `tabId`.

---

## 2. Ownership Hierarchy

```
IDE Process (JVM)
 └─ RemoteGatewayService (APP singleton)
     └─ HttpServer (one port, one token)
         └─ RemoteApiRouter
             ├─ RemoteChatDispatcher
             └─ RemoteControlHandler
     └─ RemoteEventBus (singleton)
     └─ RemoteTaskRegistry (singleton)
     └─ RemoteTabRegistry (singleton, WeakHashMap)
     └─ SessionTurnGateRegistry (singleton, WeakHashMap)

Project (per open project)
 └─ ClaudeSDKToolWindow (one per project)
     └─ ClaudeChatWindow (one per main tab + multi-tab)
         └─ ClaudeSession (one per window)
             └─ TurnIdentity (per active turn)
```

**Key rules:**
- ClaudeChatWindow.project is `final` — immutable ownership
- ClaudeSession.project is `final` — immutable ownership
- RemoteTabResolver scopes to `getAllChatWindowsForProject(project)` — never crosses projects
- SessionTurnGateRegistry keys on `ClaudeSession` identity — per-session gates are independent

---

## 3. Project/Tab/Session Identity

| Identity | Definition | Source |
|----------|-----------|--------|
| `projectId` | SHA-256(basePath, 128 bits hex) | `RemoteProjectId.of(basePath)` |
| `tabId` | Random UUID per ClaudeChatWindow instance | `RemoteTabRegistry.tabIdFor(window)` |
| `sessionId` (D) | Daemon-assigned session UUID | DaemonBridge `session_updated` event |
| `permissionServiceKey` (P) | Random UUID per PermissionService | `ChatWindowDelegate.setupPermissionService()` |

**P ≠ D** (confirmed). P used internally for source mapping P→tab→active task; D used for all external API identity.

---

## 4. TurnIdentity

```java
public final class TurnIdentity {
    private final String provider;    // "claude" | "codex"
    private final String channelId;   // UUID
}
```

- **Established**: `establishTurnIdentity()` — sync allocation/reuse before any async work
- **Published**: `activeTurnIdentity.set(turnId)` — before `supplyAsync` scheduling
- **Used by**: launch, send, interrupt, Desktop Stop, Remote Abort, Gateway dispose, clearAbort, terminal cleanup
- **Cleared**: `activeTurnIdentity.compareAndSet(turnId, null)` at terminal — CAS prevents old turn clearing new turn

---

## 5. SessionTurnGate

```java
public final class SessionTurnGate {
    AtomicReference<Object> owner;   // CAS-based single-turn mutex

    Lease acquire()  → owner.compareAndSet(null, token) ? new Lease(token) : null
    release(Lease)   → owner.compareAndSet(lease.token, null)
}
```

- **One gate per ClaudeSession** — keyed by session identity in `WeakHashMap`
- **CAS-based** — no TOCTOU window (unlike busy flag reads)
- **Lease.token** — stale lease cannot release new owner's gate
- **Acquired by** `RemoteChatDispatcher.dispatch()` before start boundary
- **Released by** `finalizeTask()` in send `whenComplete`

---

## 6. RemoteTask Lifecycle

```
dispatch()
 ├─ acquire gate (CAS)
 ├─ create task (RemoteTask)
 ├─ gen.tryStartTurn()
 │   ├─ register task in registry
 │   ├─ emit task.accepted
 │   ├─ emit task.started
 │   ├─ session.send(message)
 │   └─ whenComplete → finalizeTask(task, success)
 │       ├─ classify outcome (COMPLETED/FAILED/ABORTED)
 │       ├─ emit terminal event (publishForGeneration)
 │       ├─ release gate (Lease.release)
 │       └─ unregister task
 └─ return 202 ACCEPTED
```

**State machine**: ACCEPTED → STARTED → RUNNING → terminal (COMPLETED/FAILED/ABORTED), with intermediate waiting states (WAITING_PERMISSION, WAITING_USER_INPUT, WAITING_PLAN_APPROVAL).

---

## 7. Events / SSE

- **publishForGeneration(expectedGen, event)**: filters delivery by immutable subscriber `generation` tag. Cross-gen delivery impossible.
- **subscribe(tabId, gatewayGeneration)**: under `lifecycleLock`. If generation mismatches, returns null (no subscriber created).
- **close()**: under `lifecycleLock`. Closes all subscribers → clears map → rotates generation counter. No subscribe/close race.
- **SSE heartbeat**: 20s interval. Client disconnect detected.

---

## 8. Permission / Question / Plan

- **First-wins CAS**: `InteractionHandle.tryComplete()` uses `AtomicBoolean.compareAndSet` — exactly one decision wins.
- **Tombstones bounded at 256**: `pruneResolved()` called on every register + most resolve paths. Self-bounding.
- **Source validation**: Remote resolves validate `(projectId, tabId, taskId)` matches handle metadata.
- **Desktop/Remote share**: Both paths go through the same `InteractionHandle` — one interaction, one decision.

---

## 9. Abort

- **Desktop Stop**: `ClaudeSession.interrupt()` → `providerRouter.interruptChannel()` + observer
- **Remote Abort**: `POST /tasks/{taskId}/abort` → `RemoteControlHandler.abortTask()` → `ClaudeSession.interrupt()`
- **Gateway dispose**: `requestAbortAllActive()` → `session.interrupt()` for all active tasks
- **Provider abort**: DaemonBridge `sendAbort()` + ProcessManager `interruptChannel()` — full protocol per provider

**All three abort paths (Desktop Stop / Remote Abort / Gateway dispose) converge on `ClaudeSession.interrupt()` → shared abort lifecycle.**

---

## 10. Gateway Generation / Lifecycle

- **Generation token**: immutable `long` captured at `doStart()`
- **Bound into**: router, handlers, tasks, SSE subscribers
- **Closing boundary**: `gen.beginClosing()` under `startLock` BEFORE bus.close / requestAbortAllActive
- **Start boundary**: `gen.tryStartTurn(action)` under same `startLock` — closing wins → action never runs; start wins → closing's later abort finds live channel
- **Dispose order**: server.stop → gen.beginClosing → bus.close → requestAbortAllActive → observer uninstall → infra dispose

---

## 11. Security

| Layer | Enforcement |
|-------|------------|
| Binding | `127.0.0.1` only — random port (0) |
| Authentication | 256-bit SecureRandom Bearer token, constant-time comparison |
| Host | Must be loopback literal on bound port (anti DNS rebinding) |
| Origin | Loopback-only or absent (no CORS) |
| Body | 1 MiB chat, 64 KiB control, bounded streaming read with exact-cap-peek |
| SSE | 1024 max events per subscriber |
| Default | OFF — requires `CCGUI_REMOTE_ENABLED=1/true/yes` |

---

## 12. Provider Boundary

The gateway dispatches to the target tab's current provider. The verified scope
for this feature is the Claude provider; other providers are not part of the
verified support scope.

---

## 13. Verification

End-to-end scenarios (normal send, same-session continuation, permissions,
abort, restart, concurrency) are covered by the API contract in
`docs/REMOTE_GATEWAY_API_EVENT_CONTRACT_V1.md` and the automated test suites.

---

## 14. Rules Future Changes MUST Preserve

1. **Project→ClaudeChatWindow→ClaudeSession ownership** — never cross project boundaries
2. **SessionTurnGate CAS** — no bypass path for turn admission
3. **TurnIdentity immutable** — once established, no mutation
4. **Gateway generation immutable** — per-gateway-lifetime token
5. **publishForGeneration** — no direct `publish` on task-owned paths
6. **gen.startLock** — serializes turn start vs gateway closing
7. **CAS cleanup** — `activeTurnIdentity.compareAndSet(turnId, null)`
8. **SharedInteractionResolver first-wins CAS** — permission/question/plan resolution

---

## 15. Message Queue

Busy requests are not automatically queued: the gateway returns
`409 TAB_BUSY` and the adapter informs the user and marks the message SKIPPED.
An automatic queue is a future capability and is not part of MVP v1.

---

## 16. Deferred — Multi-Gateway

- Per-process discovery file naming (PID-based)
- External Gateway Registry
- Multi-PyCharm OS process routing
- Token per process isolation

---

## 17. Source Evidence Index

| Component | File |
|-----------|------|
| Gateway service | `remote/RemoteGatewayService.java` |
| Gateway generation | `remote/RemoteGatewayGeneration.java` |
| Chat dispatcher | `remote/RemoteChatDispatcher.java` |
| Event bus | `remote/RemoteEventBus.java` |
| Event infra | `remote/RemoteEventInfra.java` |
| Event tap | `remote/RemoteEventTap.java` |
| SSE handler | `remote/RemoteSseHandler.java` |
| Task | `remote/RemoteTask.java` |
| Task registry | `remote/RemoteTaskRegistry.java` |
| Tab registry | `remote/RemoteTabRegistry.java` |
| Tab resolver | `remote/RemoteTabResolver.java` |
| Project ID | `remote/RemoteProjectId.java` |
| Interaction registry | `remote/RemoteInteractionRegistry.java` |
| SharedInteractionResolver | `permission/SharedInteractionResolver.java` |
| TurnIdentity | `session/TurnIdentity.java` |
| SessionTurnGate | `session/SessionTurnGate.java` |
| SessionTurnGateRegistry | `session/SessionTurnGateRegistry.java` |
| ClaudeSession | `session/ClaudeSession.java` |
| SessionSendService | `session/SessionSendService.java` |
| SessionProviderRouter | `session/SessionProviderRouter.java` |
| DaemonBridge | `provider/common/DaemonBridge.java` |
| ClaudeSDKBridge | `provider/claude/ClaudeSDKBridge.java` |
| ProcessManager | `bridge/ProcessManager.java` |
| ClaudeProcessInvoker | `provider/claude/ClaudeProcessInvoker.java` |
| BearerAuth | `remote/BearerAuth.java` |
| HostValidator | `remote/HostValidator.java` |
| RemoteGatewayConfig | `remote/RemoteGatewayConfig.java` |
| RemoteToken | `remote/RemoteToken.java` |
| Gateway bootstrap | `remote/RemoteGatewayBootstrap.java` |
