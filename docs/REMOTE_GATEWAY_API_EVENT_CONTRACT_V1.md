# Remote Gateway API / Event Contract v1

**Scope**: CCGUI local Remote Gateway Core v1
**Consumers**: local transport adapter (WeChat iLink transport integration)

---

## 1. 边界与基本约束

- Gateway 默认关闭；仅当 `CCGUI_REMOTE_ENABLED=true`（truthy）时启动。
- 每个 IDE 进程只有一个 Gateway，绑定 `127.0.0.1` 随机端口。
- Gateway 是本机私有 API，不监听 LAN，不提供 CORS。
- 所有接口（包括 health）都必须携带 Bearer token。
- `Host` 必须是当前绑定端口的 loopback literal；`Origin` 若存在，也必须是
  loopback origin，以阻止 DNS rebinding/browser 跨域滥用。
- 客户端不能在 `/chat` 指定 provider/model/session；这些值始终取目标 CCGUI Tab
  的当前真实状态。
- `projectId` 是 32 位小写十六进制；`tabId`、`taskId`、`interactionId` 是运行期
  opaque identity。客户端不得从显示名称推导这些 ID。
- Tab ID 与端口在 IDE 重启后可能变化；Transport 必须重新 discovery。

---

## 2. Discovery 与认证

默认 discovery 文件：

```text
%USERPROFILE%\.codemoss\remote-gateway.json
```

结构：

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": <port>,
  "tokenFile": "<token-file>",
  "pid": <pid>
}
```

`remote-gateway.json` 不包含 token。Transport 从 `tokenFile` 读取 token，并在每个
请求中发送：

```http
Authorization: Bearer <token>
```

Gateway 启动时生成 256-bit token。Discovery 在 Gateway dispose 时删除；token
文件保留，但客户端仍应以最新 discovery 指向的文件为准。

---

## 3. HTTP 通用契约

Base URL：

```text
http://{host}:{port}/api/v1
```

JSON 请求必须使用：

```http
Content-Type: application/json
```

JSON 错误统一为：

```json
{
  "error": {
    "code": "TAB_BUSY",
    "message": "Tab is busy"
  }
}
```

响应不会包含 Java stack trace、token、API key、base URL 或内部异常细节。

---

## 4. Endpoint 一览

| Method | Path | 成功状态 | 用途 |
|---|---|---:|---|
| GET | `/health` | 200 | Gateway/IDE/bridge 健康状态 |
| GET | `/status` | 200 | Gateway runtime 状态 |
| GET | `/projects` | 200 | 列出打开的项目 |
| GET | `/projects/{projectId}/tabs` | 200 | 列出项目的 CCGUI Tabs |
| GET | `/projects/{projectId}/tabs/{tabId}` | 200 | 读取一个 Tab 快照 |
| POST | `/projects/{projectId}/tabs/{tabId}/chat` | 202 | 向真实 Tab/Session 发送消息 |
| GET | `/projects/{projectId}/tabs/{tabId}/events` | 200 SSE | 订阅该 Tab 的 Remote turn 事件 |
| GET | `/projects/{projectId}/tabs/{tabId}/mode` | 200 | 读取 permission mode |
| PUT | `/projects/{projectId}/tabs/{tabId}/mode` | 200 | 修改 permission mode |
| POST | `/projects/{projectId}/tabs/{tabId}/permissions/{interactionId}/decision` | 200 | 解决 Permission |
| POST | `/projects/{projectId}/tabs/{tabId}/questions/{interactionId}/answer` | 200 | 回答 AskUserQuestion |
| POST | `/projects/{projectId}/tabs/{tabId}/plans/{interactionId}/decision` | 200 | 决定 Plan Approval |
| POST | `/projects/{projectId}/tabs/{tabId}/tasks/{taskId}/abort` | 202 | 中止 active Remote task |

未知路径返回 404；已知路径的错误 method 返回 405。

---

## 5. Discovery/Tab API

### 5.1 GET `/health`

```json
{
  "status": "ok",
  "gatewayVersion": 1,
  "pluginVersion": "<plugin-version>",
  "ide": "PyCharm Community Edition",
  "ideBuild": "<ide-build>",
  "bridgeReady": true
}
```

### 5.2 GET `/status`

```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": <port>,
  "openProjectCount": 1,
  "bridgeReady": true
}
```

### 5.3 GET `/projects`

```json
{
  "projects": [
    {
      "projectId": "<projectId>",
      "name": "<project-name>",
      "basePath": "<project-base-path>"
    }
  ]
}
```

### 5.4 GET `/projects/{projectId}/tabs`

```json
{
  "projectId": "<projectId>",
  "tabs": [
    {
      "tabId": "<tabId>",
      "index": 0,
      "selected": true,
      "sessionId": "<sessionId>",
      "provider": "claude",
      "model": "<model>",
      "cwd": "<workspace>",
      "busy": false
    }
  ]
}
```

单 Tab endpoint 返回数组元素本身。新 Tab 尚未建立 session 时，`sessionId` 可省略；
`provider`、`model`、`cwd` 为空时也可省略。

---

## 6. Chat 契约

### 6.1 请求

```http
POST /api/v1/projects/{projectId}/tabs/{tabId}/chat
Content-Type: application/json
```

```json
{
  "message": "用户消息"
}
```

- `message` 必须是非空字符串；两端空白会被 trim。
- 单条 message 最长 32,000 chars。
- 原始 body 上限 1 MiB。
- 其他字段会被忽略，不能覆盖 Tab 的 session/provider/model。

### 6.2 202 Accepted

```json
{
  "taskId": "<taskId>",
  "projectId": "<projectId>",
  "tabId": "<tabId>",
  "sessionId": "<sessionId>",
  "status": "accepted"
}
```

新 Tab 第一轮尚无 session ID 时，`sessionId` 可省略。202 仅表示任务已进入真实
CCGUI send lifecycle；最终结果必须从 SSE terminal event 判断。

同一 Session/Tab 同时只允许一个 turn：Desktop 和 Remote 共用一个
`SessionTurnGate`。忙时返回 `409 TAB_BUSY`，客户端不得用 busy snapshot 代替 409
作为并发权威。

---

## 7. SSE 契约

### 7.1 连接

```http
GET /api/v1/projects/{projectId}/tabs/{tabId}/events
Accept: text/event-stream
Authorization: Bearer <token>
```

响应：

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
```

Transport 应先建立 SSE，再调用 `/chat`，否则早期事件不会重放。v1 不提供
`Last-Event-ID` replay。

### 7.2 Frame

```text
id: 42
event: assistant.content
data: {"eventId":42,"event":"assistant.content","timestamp":...,
       "projectId":"...","tabId":"...","taskId":"...",
       "sessionId":"...","payload":{"text":"..."}}

```

Envelope 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `eventId` | integer | 当前 Gateway generation 内单调递增 |
| `event` | string | 事件名 |
| `timestamp` | integer | epoch milliseconds |
| `projectId` | string | 项目标识 |
| `tabId` | string | Tab 标识 |
| `taskId` | string, optional | Remote task 标识 |
| `sessionId` | string, optional | 当前真实 session 标识 |
| `payload` | object | 事件专用数据 |

无事件时每 20 秒发送：

```text
: keepalive

```

每 subscriber 最多缓冲 1024 个事件。慢消费者溢出时发送：

```text
event: stream.overflow
data: {"reason":"client too slow"}

```

随后关闭流。`stream.overflow` 是特殊 frame，不使用标准 envelope。

### 7.3 事件表

| 事件 | payload | 说明 |
|---|---|---|
| `task.accepted` | `{"state":"ACCEPTED"}` | gate 获得且 task 注册成功 |
| `task.started` | `{"state":"STARTED"}` | 即将进入真实 session send |
| `stream.started` | `{}` | provider stream start（provider/path 可能不产生） |
| `stream.ended` | `{}` | provider stream end（provider/path 可能不产生） |
| `assistant.content` | `{"text":"..."}` | 可见 assistant 正文 chunk，不含 thinking |
| `assistant.thinking_status` | `{"active":true/false}` | thinking 开始/结束状态 |
| `usage.updated` | `{"usedTokens":n,"maxTokens":n}` | token usage 快照 |
| `tool.started` | `{"toolUseId":"...","tool":"Write"}` | tool_use 首次出现 |
| `tool.completed` | `{"toolUseId":"...","tool":"Write"}` | 对应 tool_result 成功 |
| `tool.failed` | `{"toolUseId":"...","tool":"Write"}` | 对应 tool_result 失败 |
| `permission.requested` | 见下文 | Permission 等待 Remote/Desktop 决策 |
| `permission.resolved` | 见下文 | Permission 已 first-wins 解决 |
| `question.requested` | 见下文 | AskUserQuestion 等待答案 |
| `question.resolved` | 见下文 | AskUserQuestion 已解决 |
| `plan.requested` | 见下文 | Plan Approval 等待决策 |
| `plan.resolved` | 见下文 | Plan Approval 已解决 |
| `task.abort_requested` | `{"state":"aborting"}` | Remote Abort 或 Desktop Stop 已请求 |
| `task.completed` | `{"state":"COMPLETED"}` | 成功终态 |
| `task.failed` | `{"state":"FAILED",...}` | 失败终态；可能含 `unresolvedInteractions:true` |
| `task.aborted` | `{"state":"ABORTED"}` | 中止终态 |
| `task_event` | `{"raw":"..."}` | capped provider task raw event；Transport 不应依赖其内部格式 |

只有 Remote-origin turn 绑定 taskId 并进入此事件流；普通 Desktop turn 不会被伪装成
Remote task。Desktop Stop 若中止 active Remote turn，则会产生 Remote abort events。

`assistant.content` 由 snapshot/delta 统一跟踪并 coalesce：单 chunk 最多 1000 chars，
最长约 600 ms flush。chunk 边界不是语义边界，Transport 必须按 taskId 顺序拼接。

Thinking 正文永不通过 SSE 输出；只有 `assistant.thinking_status`。

---

## 8. Interaction 契约

### 8.1 Permission

Requested：

```json
{
  "interactionId": "...",
  "requestId": "...",
  "toolName": "Write",
  "inputs": {}
}
```

Decision：

```json
{
  "taskId": "...",
  "decision": "ALLOW"
}
```

`decision` 只能是：`ALLOW`、`ALLOW_ALWAYS`、`DENY`。

成功：

```json
{"interactionId":"...","resolved":true}
```

Resolved event：

```json
{"interactionId":"...","decision":"ALLOW"}
```

Write/Edit 的 Diff Review 与普通 Permission 使用同一个 shared first-wins handle；
Remote 决策获胜时桌面 Diff 视图自动关闭。

### 8.2 AskUserQuestion

Requested：

```json
{
  "interactionId": "...",
  "requestId": "...",
  "allowCustomInput": true,
  "questions": {}
}
```

Answer：

```json
{
  "taskId": "...",
  "answers": {
    "原问题文本": "选择项或自定义文本"
  }
}
```

`answers` 必须是 object，并与原问题集合做语义校验；最多 64 个 key，自定义单项最多
2000 chars，总 answer chars 最多 65,536。

Resolved event：

```json
{"interactionId":"...","answers":{}}
```

### 8.3 Plan Approval

Requested：

```json
{
  "interactionId": "...",
  "requestId": "...",
  "plan": {}
}
```

Decision：

```json
{
  "taskId": "...",
  "approved": true,
  "targetMode": "default"
}
```

`targetMode` 可省略，默认 `default`；若提供，必须是有效 mode。

Resolved event：

```json
{
  "interactionId": "...",
  "approved": true,
  "targetMode": "default"
}
```

### 8.4 First-wins 与身份校验

- Desktop 与 Remote 竞争同一个 `InteractionHandle`；只有第一方成功。
- 控制请求必须同时匹配 `projectId + tabId + taskId + interactionId`。
- 已解决再次提交：`409 INTERACTION_ALREADY_RESOLVED`。
- 类型错误：`409 INTERACTION_TYPE_MISMATCH`。
- 跨 task/tab/project 或 stale 决策：`409 INTERACTION_MISMATCH`。
- 找不到：`404 INTERACTION_NOT_FOUND`。

事件中的 interaction inputs string value 会被 cap；Permission/Question 值最大约
2000 chars，Plan 值最大约 8000 chars。Transport 不应把 SSE payload 当作无界存储。

---

## 9. Abort 契约

```http
POST /api/v1/projects/{projectId}/tabs/{tabId}/tasks/{taskId}/abort
```

无请求 body。首次成功：

```json
{"taskId":"...","status":"aborting"}
```

HTTP 202。对仍 active 且已请求 abort 的同一 task 再次调用也是 202：

```json
{"taskId":"...","status":"abort_already_requested"}
```

最终必须等待 SSE `task.aborted`。Abort 会中断真实 session、取消 pending
interactions、关闭桌面交互视图；gate 只在真实 send future terminal 后释放。

未知/跨作用域 task：`404 TASK_NOT_FOUND`；非 active task：
`409 TASK_NOT_ACTIVE`。

---

## 10. Permission Mode

GET/PUT 使用统一响应：

```json
{
  "projectId": "...",
  "tabId": "...",
  "sessionId": "...",
  "mode": "default",
  "validModes": [
    "default",
    "plan",
    "acceptEdits",
    "autoEdit",
    "bypassPermissions"
  ]
}
```

PUT body：

```json
{"mode":"plan"}
```

不接受别名。Remote 修改成功后必须同步 Desktop Webview mode selector。

---

## 11. 错误码

| HTTP | code |
|---:|---|
| 400 | `BAD_REQUEST` |
| 400 | `INVALID_MODE` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 404 | `INTERACTION_NOT_FOUND` |
| 404 | `TASK_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `TAB_BUSY` |
| 409 | `INTERACTION_ALREADY_RESOLVED` |
| 409 | `INTERACTION_TYPE_MISMATCH` |
| 409 | `INTERACTION_MISMATCH` |
| 409 | `TASK_NOT_ACTIVE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` |
| 503 | `GATEWAY_UNAVAILABLE` |

Transport 对 409 必须按 code 区分；不能把所有 409 都转成“忙”。

---

## 12. Transport 最小正确流程

```text
1. 读取最新 discovery + token
2. GET /health
3. GET /projects → 选择绑定的 projectId
4. GET /projects/{projectId}/tabs → 选择绑定的 tabId
5. 先连接 /events
6. POST /chat，记录返回 taskId
7. 仅消费同 taskId 的事件并按序拼接 assistant.content.text
8. 收到 requested interaction 时，携带原 taskId 调对应 control endpoint
9. 以 task.completed / task.failed / task.aborted 作为唯一终态
10. SSE 断线或 overflow：重新 discovery/health/tabs，再重连；不得假设事件可 replay
```

Transport 不得：

- 直接读写 Claude Session JSONL 充当发送/事件后端；
- 建立第二个 Agent/Claude backend；
- 绕过 taskId/interactionId 身份校验；
- 将 thinking/raw provider event 当作用户可见正文；
- 客户端不得假设当前协议提供未在本契约中定义的消息编辑、交互按钮、
  文件附件或主动推送能力。
