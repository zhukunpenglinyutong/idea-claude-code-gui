# WeChat QR Login + CC GUI 当前 Tab 连接 UX

**Status**: Implemented and verified

---

## 1. 产品模型（当前范围）

一个微信账号 → 一个 Adapter 服务进程 → 一个 Gateway runtime → 一个现有 projectId → 一个现有 tabId → 该 Tab 当前的 CC GUI session/provider。当前验证范围为 Claude provider；其他 provider（包括 Codex）未纳入本次验证。不实现 Queue/多 Gateway/多 PyCharm/远程建 Tab/企业微信/图片文件。

## 2. 运行时架构（已实现）

```text
PyCharm IDE JVM
├─ AdapterProcessService（APP）     懒启动/健康/崩溃退避/关闭（无自动无限重启）
├─ WechatControlClient              127.0.0.1 Bearer（内存 token）
├─ WechatConnectionService（APP）   净化状态缓存 + per-tab 视图 + 轮询推送
├─ WechatHandler（每窗口）          wechat_* 意图桥（窗口身份由 Java 解析）
└─ ClaudeChatWindow / Webview       header 微信图标 + WechatDialog

Adapter Service（单 Node 进程，bundle 单文件）
├─ Control HTTP Server（127.0.0.1 随机端口）
├─ WechatLoginService（复用 src/ilink/qr.ts，唯一 iLink 登录实现）
├─ CredentialStore / InboxJournal
├─ WeixinTransport（可动态启停）
├─ TargetBinding（权威）+ Gateway Client + SSE
```

## 3. Control API 契约（已实现，`/control/v1`）

| 端点 | 行为 |
|---|---|
| GET /health | `{status:ok, version:1}` |
| GET /status | 净化状态：authState / transportRunning / login / binding（无凭据） |
| POST /login/start | 单例登录会话；重复调用返回现有会话 |
| GET /login/{id}/status | 会话状态 + expiresAt + verifyCodeRequired |
| GET /login/{id}/qr | image/png（≤128KiB，内存态） |
| POST /login/{id}/verify | 提交配对码 |
| POST /login/{id}/cancel | 显式取消（停止轮询） |
| PUT /binding | 原子替换 TargetBinding（Adapter 校验目标存在） |
| DELETE /binding | 解绑（保持登录） |
| POST /logout | 停止 transport + 清凭据 + 清绑定 |
| POST /shutdown | 优雅退出 |

安全：仅 loopback（Host + Origin 校验）、Bearer 常数时间比较、body ≤64KiB、结构化 JSON 错误、无 token/凭据/QR 原文入日志。

## 4. 进程引导与关闭

- Java 生成独立 256-bit control token → **环境变量**传给子进程（非命令行）+ 父 PID；
- Adapter 监听随机端口后输出一行 `CCGUI_ADAPTER_READY {"version":1,"port":...,"pid":...}`（无 token）；Java 20s 超时解析；
- Adapter 监控父 PID，父进程消失即退出；
- 关闭顺序：POST /shutdown → 等 5s → destroy → destroyForcibly 兜底；
- 崩溃：置 ADAPTER_OFFLINE + 手动 Retry（指数退避，无自动无限重启）。

## 5. 登录生命周期

LOGGED_OUT → QR_PENDING → SCANNED → VERIFY_CODE_REQUIRED → CONFIRMED → CONNECTED_UNBOUND；EXPIRED（自动刷新 ≤3）/ REAUTH_REQUIRED（-14）/ ERROR。QR 活动期关闭弹窗（X/Esc/遮罩）会取消本次登录并停止轮询；已连接状态关闭弹窗仅隐藏，不退出登录。显式「退出登录」才清除凭据与绑定。登录确认后**同进程**启动 WeixinTransport。

## 6. 绑定/rebind

- Adapter 权威；Java 从所属 ClaudeChatWindow 解析 projectId/tabId；webview 只发 `wechat_bind_current` 意图；
- rebind：`PUT /binding` 原子替换 → runtime 检测 target 变化**重开 SSE** → 旧交互失效（stale 回复返回明确提示）→ **不 abort 旧 Agent**；
- 准入捕获：入站消息在准入时捕获 target，rebind 不影响在途消息的目标；
- 绑定不持久化：Adapter/IDE 重启后 CONNECTED_UNBOUND，无自动回绑；
- 登录发起时记录 pending target；确认后校验目标仍存在再自动绑定，否则 CONNECTED_UNBOUND；其他 tab 的 Connect 不替换 pending target。

## 7. Node 策略

- 复用 `NodeDetector` 已验证路径（`claude.code.node.path` 属性）；
- `adapter/package.json engines.node` 为权威要求（>=22）；Java 解析并比较主版本，门槛与 engines.node 一致；
- 不满足时**不启动 Adapter**，弹窗显示要求/当前版本/当前路径，并提供「重新检测」操作；
- 开发覆盖 `CCGUI_ADAPTER_NODE` / `CCGUI_ADAPTER_DIR` 仅从 JVM 属性/IDE 进程环境读取，不读项目文件；生产路径为 NodeDetector + 打包解包；开发环境的 Node 路径（例如 `<node22-path>`）只存在于开发环境。

## 8. 打包

- `packageAdapter`：esbuild 单文件 `adapter-bundle.cjs`（约 230KB）+ package.json + LICENSE → `adapter.zip` + SHA-256 `adapter.hash`；
- `buildPlugin` 与 `prepareSandbox` 按 ai-bridge 模式注入插件根目录；运行期 Java 通过插件目录定位器（`AdapterArchiveLocator`）读取 `adapter.zip`/`adapter.hash`，解包到 `~/.codemoss/ccgui-adapter/runtime`，以临时文件 + SHA-256 门禁 + 原子替换校验 bundle；
- 开发覆盖：`-Dccgui.adapter.dir=<adapter-dir>` 或 `CCGUI_ADAPTER_DIR`（生产默认不含绝对路径）；
- 保留 `node dist/cli.js qr` 与 `node dist/main.js <projectId> <tabId>` 兼容。

## 9. 实现索引（稳定模块级）

| 功能 | 模块/文件 | 职责 |
|---|---|---|
| 结构化登录会话 | `adapter/src/ilink/loginService.ts` | 驱动 QR 登录，暴露会话状态 |
| 控制 API | `adapter/src/control/server.ts` | loopback 控制端点 |
| 单进程服务 | `adapter/src/service.ts` | 登录/登出/绑定/Transport 组合 |
| 入口握手 | `adapter/src/main.ts` | READY 行 + argv 绑定兼容 |
| 运行期组合 | `adapter/src/runtime.ts` | SSE 生命周期、stale 交互失效、准入目标捕获 |
| 发送与绑定 | `adapter/src/app.ts` | 绑定校验、sendMessage |
| 微信命令 | `adapter/src/weixin/commands.ts` | 权限/停止/计划/问题命令解析 |
| 交互注册表 | `adapter/src/weixin/interactions.ts` | 待决交互登记与失效 |
| 许可 | `adapter/LICENSE` | 许可证 |
| Adapter 进程/连接服务 | `src/main/java/.../wechat/` | 进程管理、连接状态、控制客户端 |
| Webview 意图桥 | `src/main/java/.../handler/WechatHandler.java` | wechat_* 意图转发 |
| 窗口委托 | `src/main/java/.../ui/ChatWindowDelegate.java` | WechatHandler 注册、窗口身份 |
| 窗口 JS 边界 | `src/main/java/.../ui/toolwindow/ClaudeChatWindow.java` | callJavaScript 契约 |
| 服务注册 | `src/main/resources/META-INF/plugin.xml` | APP 级服务注册 |
| 状态 hook | `webview/src/hooks/useWechatRemote.ts` | 微信状态订阅与意图发送 |
| 连接弹窗 | `webview/src/components/WechatDialog/` | QR/配对/绑定/退出 UI 与样式 |
| 入口图标 | `webview/src/components/ChatHeader/` | 微信入口 + 状态点 |
| 全局类型/样式 | `webview/src/global.d.ts`、`styles/header.less` | onWechatStatus 声明、入口样式 |
| 打包集成 | `build.gradle` | packageAdapter 与插件注入 |

## 10. 测试与构建门禁

- Adapter 测试：`adapter/test`（vitest，含登录/控制/服务/绑定/竞态/生命周期）；
- Webview 测试：`webview/src` 对应 `*.test.tsx`；
- Java 测试：`src/test/java/com/github/claudecodegui/wechat/**` 及全量 Java 测试；
- 门禁：checkstyleMain、webview build、buildPlugin、`git diff --check`；插件 ZIP 含 adapter.zip/hash，内嵌 ZIP 无 node_modules/无绝对路径。

## 11. Known Limitations

- 当前 busy 请求不自动排队：Adapter 对 `409 TAB_BUSY` 返回「当前会话忙，请稍后再试。」并标记 SKIPPED；队列不属于当前 MVP。
- 绑定 Tab 被关闭后不会立即通过轮询失效：下一次发送会检测 stale target 并提示重新绑定；不会自动改绑其他 Tab。
- Adapter 包资源初始化失败（bundle 缺失/hash 不匹配等）后，UI「重试」不会重新解析 Bundle；修复环境后需要重启 IDE。
- 当前一个微信连接只绑定一个目标 Tab，不支持多目标广播。

## 12. 故障排查

- 微信弹窗提示 Node.js 22 或更高版本：安装/切换 Node ≥22 后点击「重新检测」；或通过 `CCGUI_ADAPTER_NODE` 环境变量显式指定 Node 可执行文件。
- 绑定无反应：确认 Remote Gateway 已启用（`CCGUI_REMOTE_ENABLED=true`）且 `~/.codemoss/remote-gateway.json` 存在；查看 idea.log 中 `[wechat] bind failed` 的具体原因。
- 提示 Adapter bundle not found/unverified：检查插件包内 `adapter.zip`/`adapter.hash` 是否存在；修复后重启 IDE。
- 微信凭据失效（-14）：Adapter 会进入 REAUTH_REQUIRED，重新扫码登录即可。
