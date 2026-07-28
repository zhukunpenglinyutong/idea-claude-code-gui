##### **2026年7月19日（v0.4.7-fix2）**

English:

✨ Features
- Add a **Detailed output in message footer** setting: users can choose whether per-message footers show expanded metadata such as model, duration and working directory, while token/cost essentials stay easy to scan (by @EzioX1459)

🐛 Fixes
- Restore **IntelliJ 2026.2 plugin loading** by registering tool-window/editor actions with the platform-compatible extension points (by @zkpaiminmin)
- Fix **Codex resumed-session replay leaking historical tool calls**: JSONL replay now captures a pre-turn baseline and waits for the current turn's `turn_context`, so old commands/results are not re-emitted as if they belonged to the new turn (by @MrHuapen)
- Fix **multi-tab and streaming transcript merge edge cases**: empty assistant placeholders are filled in place, final snapshots are pushed to the right tab/session, and current-turn metadata is reconstructed more reliably after reloads (by @gadfly3173, @vitas13)
- Fix **message rendering regressions** across collapsed text, normalized content blocks, Read/Bash/generic tool output, ANSI stripping, copied text, and image-bearing tool results (by @vitas13)
- Fix **usage and cost display drift**: Claude/Codex costs now come from shared pricing tables, Codex cached-token aliases are accepted, cache hits and per-turn USD cost are preserved in frontend transport, and custom/unpriced models avoid bogus costs (by @EzioX1459, @zkpaiminmin)
- Fix the **Codex quota popup being clipped** by the provider dropdown container (by @elexiang)
- Fix **Keep All** using stale file-change state and resurrecting old changes after the user accepted the current set (by @hebulin)

中文：

✨ 新功能
- 新增**消息底部详细输出**设置：用户可选择是否在每条消息底部显示模型、耗时、工作目录等扩展元数据，同时保留 token / 费用等核心信息的可读性（by @EzioX1459）

🐛 修复
- 恢复 **IntelliJ 2026.2 插件加载**：将工具窗口 / 编辑器 action 注册到兼容新版平台的扩展点（by @zkpaiminmin）
- 修复 **Codex 恢复会话时历史工具调用被重新回放**：JSONL replay 现在会记录当前轮次开始前的基线，并等待本轮 `turn_context` 后才回放，避免旧命令 / 旧结果被当成本轮内容再次下发（by @MrHuapen）
- 修复**多标签页与流式转录合并边界问题**：空的助手占位块会原地填充，最终快照会推送到正确 tab / session，reload 后也能更可靠地重建当前轮次元数据（by @gadfly3173、@vitas13）
- 修复**消息渲染回归**，覆盖折叠文本、标准化 content block、Read / Bash / 通用工具输出、ANSI 清理、复制文本以及带图片的工具结果（by @vitas13）
- 修复**用量与费用显示不一致**：Claude / Codex 费用统一走共享定价表，Codex 兼容 cached-token 别名，cache hit 与单轮美元费用会保留到前端传输，自定义 / 未定价模型不会显示虚假费用（by @EzioX1459、@zkpaiminmin）
- 修复 **Codex 配额弹窗被 provider 下拉容器裁剪**（by @elexiang）
- 修复 **Keep All** 使用过期文件变更状态，导致接受当前变更后旧变更又被带回来的问题（by @hebulin）

---

##### **2026年7月9日（v0.4.7-fix1）**

English:

✨ Features
- Add the **GPT-5.6 model family** (Sol / Terra / Luna) as built-in Codex models: 1.05M context windows, usage pricing for cost estimation, `gpt-5.6` prefix/alias matching resolving to Sol, and localized labels and descriptions across all 10 languages (by @zkpaiminmin)

🔧 Improvements
- Trim the built-in Codex model dropdown to the current lineup — GPT-5.6 Sol / Terra / Luna, GPT-5.5 and GPT-5.4 — removing the retired `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2` and `gpt-5.1-codex-mini` entries (by @zkpaiminmin)

中文：

✨ 新功能
- 新增 **GPT-5.6 系列模型**（Sol / Terra / Luna）为 Codex 内置模型：1.05M 上下文窗口、用于费用估算的用量计价、`gpt-5.6` 前缀/别名匹配解析到 Sol，以及覆盖全部 10 种语言的本地化标签与描述（by @zkpaiminmin）

🔧 优化
- Codex 内置模型下拉列表精简为当前阵容——GPT-5.6 Sol / Terra / Luna、GPT-5.5 与 GPT-5.4，移除已下线的 `gpt-5.2-codex`、`gpt-5.1-codex-max`、`gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.3-codex-spark`、`gpt-5.2` 和 `gpt-5.1-codex-mini`（by @zkpaiminmin）

---

##### **2026年7月9日（v0.4.7）**

English:

✨ Features
- Add an **MCP Marketplace**: a new "Add from MCP market" entry in the MCP add menu, with switchable sources (built-in presets, the official MCP Registry, the GitHub MCP Registry, the official GitHub org). The selected source is persisted and restored on reopen, responses are disk-cached with stale fallback, and registry entries now render their real package / runtime arguments, environment variables and transport type instead of a bare `uvx <package>` — previously every registry entry mapped to a null name and was silently dropped (by @Miguel0888)
- Add **Import from GitHub Copilot** for MCP servers: paste a Copilot MCP config, preview it, and save through the same path as a manual add — `requestInit.headers` merged with `headers`, transport type inferred (command → stdio, `/sse` URL → sse, else http), conflicting ids renamed instead of overwritten (by @Miguel0888)
- Add **custom pricing for custom models**: configure input / output / cache rates for Claude and Codex custom models, persisted to the plugin config and used by usage aggregation. Routed Claude model ids such as `ppio/pa/gpt-5.5` now match history usage recorded under the routed id (`pa/gpt-5.5`), preserving exact-match precedence rather than guessing between candidates (by @EzioX1459)
- Add an **"Ask User Question notification" toggle** to Basic Settings → Behavior: when enabled, an opt-in system toast (same slide-in style as the task-completion notification) fires whenever Claude triggers an AskUserQuestion, so you won't miss a pending question. Defaults to off; localized for all 10 languages (by @adminkk)

🔒 Security Hardening
- Default permission mode no longer yields every tool to the SDK. Read-only tools (now including `NotebookRead` and `BashOutput`) still yield, so `settings.json` deny-rules such as `Read(./.env)` keep applying, while side-effect tools (`Bash` / `Write` / `Agent`) return `ask`, which takes precedence over allow-rules. Since `settingSources` includes the project and local scopes, a malicious repository's `.claude/settings.json` could otherwise silently auto-approve `Bash` (by @zkpaiminmin)

🐛 Fixes
- Fix **Auto (`bypassPermissions`) having no effect when switched mid-session**: `allowDangerouslySkipPermissions` is an argv flag frozen at process launch, so a live `set_permission_mode` control request could never add it to an already-running subprocess. Switching into or out of Auto now forces a runtime rebuild instead of endlessly re-prompting (by @toxeh)
- Fix the **permission mode resetting to Default after a plugin reinstall**: boot no longer pushes the wiped webview `localStorage` snapshot over Java's app-level `PropertiesComponent`, which survives reinstall and is the real source of truth (by @toxeh)
- Fix **background-turn answers never rendering live**: when the agent delegates a sub-agent to the background, its prompts and replies were persisted to the session JSONL but held back until the long foreground stream ended. The reload is now deferred to stream end and routed as a live update (by @toxeh)
- Fix the **1M-context toggle silently doing nothing on a live runtime**: the `[1m]` state is now part of the runtime signature, so toggling it rebuilds the runtime with a fresh env snapshot, and `setModel` receives the resolved model id rather than the SDK short name — so settings-side model remaps (`sonnet` → `"MiniMax-M2.5"`) also reach subprocesses whose env was frozen at spawn (by @toxeh)
- Fix three chat-transcript rendering glitches, each with a distinct root cause in the optimistic-add / streaming / snapshot-reconcile interaction: a user message not shown though the agent answered it, a duplicated assistant answer, and a hidden "API request failed" bubble (by @toxeh)
- Fix the same swallowed error bubble on Codex: `CodexMessageHandler.onError` pushed the error snapshot before signalling stream-end, so the webview's `onStreamEnd` rAF-cancel could drop it. Stream-end is now emitted first on streaming turns (by @zkpaiminmin)
- Fix an **empty History panel whenever the custom working directory is a relative path** such as `..`: the GUI keyed history on the IDE project base path while Claude/Codex key sessions on the normalized working directory they actually run in, and `..` was never collapsed. History now resolves against the canonical normalized directory (by @tc-imba)
- Fix **plugin skills and slash commands missing when the project, Node.js and `~/.claude` live in WSL** but the IDE runs on Windows: the Java-side `~/.claude` scan resolved the wrong paths across the `\\wsl.localhost\<distro>\...` UNC share and silently returned nothing, leaving only the built-in commands in the `/` menu (by @tikitaka721, closes #1400)
- Fix a **WSL-style `HOME` (`/mnt/c/Users/<user>`) leaking into the daemon on native Windows**, where it is inherited by every subprocess. The Bash tool there is Git Bash (MSYS), whose mount prefix is `/c/...` — most visibly `git` could not lock `<HOME>/.gitconfig` and kept reporting "credentials incorrect or have expired" on push (by @Mickyzh)
- Fix `HOME` / `CODEX_HOME` not being normalized against the selected Node runtime before bridge child processes launch: polluted `/mnt/<drive>/...` values are converted back to native Windows paths for native Windows Node/Codex processes, and WSL path conversion stays scoped to WSL runtimes (by @selfdcl)
- Fix **Codex custom models showing no reasoning**: the Codex SDK only enables reasoning for models on its hardcoded allowlist, so custom models sent a null thinking parameter. `model_supports_reasoning_summaries` is now forced on for all models (by @codexvn, closes #1375)
- Fix a **partial custom price wildly over-estimating cost**: dimensions the user left unset now fall back to that model's own built-in rate instead of 0, so custom pricing overrides only what was explicitly configured. Also fix an Escape-key listener leak in the MCP import dialog (by @zkpaiminmin, closes #1450)
- Fix **"Always allow" re-prompting every turn for Bash/Agent**: restore tool-level approval memory and honor user-configured `settings.json` allow-rules, reverting the parts of the v0.4.6 hardening that broke permissions for normal users. `acceptEdits` command confirmation is unchanged (by @zkpaiminmin)

🔧 Improvements
- `ServerToolsPanel` now shows the concrete `toolsInfo.error` text under "Load failed" instead of a generic message (by @Miguel0888)
- Complete the custom-model pricing translations for es / fr / hi / ja / ko / pt-BR / ru, and drop the dead `getCustomModelPricing` chain in `CodemossSettingsService` (by @zkpaiminmin)

中文：

✨ 新功能
- 新增 **MCP 应用市场**：MCP 添加菜单新增「Add from MCP market」入口，可在内置预设、官方 MCP Registry、GitHub MCP Registry 和官方 GitHub 组织之间切换数据源。选中的数据源会持久化并在重新打开时恢复，请求结果落盘缓存并支持过期回退；注册表条目现在会渲染真实的 package / runtime 参数、环境变量和传输类型，而不是一条干瘪的 `uvx <package>`——此前每个注册表条目都会映射出空名称并被静默丢弃（by @Miguel0888）
- MCP 新增**从 GitHub Copilot 导入**：粘贴 Copilot 的 MCP 配置，预览确认后走与手动添加相同的保存路径——合并 `requestInit.headers` 与 `headers`、推断传输类型（command → stdio、`/sse` URL → sse、其余 http）、id 冲突时重命名而非覆盖（by @Miguel0888）
- 新增**自定义模型的自定义计价**：可为 Claude 和 Codex 自定义模型配置输入 / 输出 / 缓存单价，持久化到插件配置并用于用量统计。形如 `ppio/pa/gpt-5.5` 的路由模型 id 现在能匹配到历史中按路由 id（`pa/gpt-5.5`）记录的用量，且保留精确匹配优先，不在多个候选间瞎猜（by @EzioX1459）
- 基础设置 → 行为设置新增 **「AskUserQuestion 提醒通知」开关**：开启后，Claude 每次触发 AskUserQuestion 都会弹出系统通知（与任务完成通知同样的滑入样式），不再错过待回答的问题。默认关闭，已覆盖全部 10 种语言（by @adminkk）

🔒 安全加固
- 默认权限模式不再把所有工具一律交给 SDK 评估。只读工具（新增 `NotebookRead` 和 `BashOutput`）仍然交由 SDK，以便 `settings.json` 中 `Read(./.env)` 这类 deny 规则继续生效；而有副作用的工具（`Bash` / `Write` / `Agent`）返回 `ask`，优先级高于 allow 规则。由于 `settingSources` 包含 project 与 local 作用域，否则一个恶意仓库的 `.claude/settings.json` 就能静默自动放行 `Bash`（by @zkpaiminmin）

🐛 修复
- 修复**会话中途切到 Auto（`bypassPermissions`）不生效**：`allowDangerouslySkipPermissions` 是进程启动时冻结的 argv 参数，运行时的 `set_permission_mode` 控制请求无法给已启动的子进程补上它。现在切入 / 切出 Auto 会强制重建 runtime，不再每一步都继续弹确认（by @toxeh）
- 修复**重装插件后权限模式被重置为 Default**：启动时不再用被清空的 webview `localStorage` 快照去覆盖 Java 应用级 `PropertiesComponent`——后者能在重装后存活，才是真正的事实来源（by @toxeh）
- 修复**后台轮次的回答不实时渲染**：agent 把子任务派发到后台运行时，其提问与回复虽已写入会话 JSONL，却要等前台长流结束才一次性刷出。现在把 reload 推迟到 stream end 并作为实时更新下发（by @toxeh）
- 修复 **1M 上下文开关在运行中的 runtime 上静默失效**：`[1m]` 状态现已纳入 runtime 签名，切换后会以新的环境快照重建 runtime；同时 `setModel` 接收解析后的完整模型 id 而非 SDK 短名，使设置侧的模型重映射（`sonnet` → `"MiniMax-M2.5"`）也能送达那些环境已在 spawn 时冻结的子进程（by @toxeh）
- 修复三个聊天记录渲染异常（根因各自独立，位于乐观插入 / 流式 / 快照对账的交互处）：用户消息未显示但 agent 已作答、助手回答重复、「API request failed」气泡被吞（by @toxeh）
- 修复 Codex 侧同样的错误气泡被吞：`CodexMessageHandler.onError` 先推错误快照再发 stream-end，导致 webview 的 `onStreamEnd` rAF 取消把它丢掉。流式轮次现在先发 stream-end（by @zkpaiminmin）
- 修复**自定义工作目录为 `..` 这类相对路径时历史面板恒为空**：GUI 按 IDE 项目根路径读取历史，而 Claude/Codex 按其实际运行的规范化工作目录存储会话，且 `..` 从未被折叠。历史现在按规范化后的目录解析（by @tc-imba）
- 修复 **IDE 跑在 Windows、而项目 / Node.js / `~/.claude` 都在 WSL 时插件技能与斜杠命令全部消失**：Java 侧扫描 `~/.claude` 时无法正确解析 `\\wsl.localhost\<distro>\...` UNC 路径，静默返回空，`/` 菜单里只剩内置命令（by @tikitaka721，关闭 #1400）
- 修复 **WSL 风格的 `HOME`（`/mnt/c/Users/<user>`）泄漏进原生 Windows 的 daemon**，并被所有子进程继承。这里的 Bash 工具是 Git Bash（MSYS），挂载前缀是 `/c/...`——最直观的表现是 `git` 无法锁定 `<HOME>/.gitconfig`，push 时反复报「credentials incorrect or have expired」（by @Mickyzh）
- 修复启动 bridge 子进程前未按所选 Node runtime 规范化 `HOME` / `CODEX_HOME`：被污染的 `/mnt/<drive>/...` 会为原生 Windows 的 Node/Codex 进程转回原生 Windows 路径，WSL 路径转换则限定在 WSL runtime 内（by @selfdcl）
- 修复 **Codex 自定义模型不显示思考过程**：Codex SDK 只对硬编码白名单中的模型启用 reasoning，自定义模型的 thinking 参数因此为 null。现在对所有模型强制开启 `model_supports_reasoning_summaries`（by @codexvn，关闭 #1375）
- 修复**只填了部分维度的自定义单价会把费用估算撑爆**：未填写的维度现在回退到该模型自身的内置单价而非 0，自定义计价只覆盖用户显式设置的部分。同时修复 MCP 导入对话框 Escape 监听器泄漏（by @zkpaiminmin，关闭 #1450）
- 修复 **Bash/Agent 的「始终允许」每轮都重新弹窗**：恢复工具级授权记忆，并重新尊重用户在 `settings.json` 中配置的 allow 规则，回退 v0.4.6 中影响正常用户的过度加固。`acceptEdits` 的命令确认保持不变（by @zkpaiminmin）

🔧 优化
- `ServerToolsPanel` 的「Load failed」下方改为展示具体的 `toolsInfo.error` 文案，不再只给一句通用提示（by @Miguel0888）
- 补齐 es / fr / hi / ja / ko / pt-BR / ru 七种语言的自定义模型定价文案，并删除 `CodemossSettingsService` 中无人调用的 `getCustomModelPricing` 死代码链（by @zkpaiminmin）

---

##### **2026年7月6日（v0.4.6-fix1）**

English:

🐛 Fixes
- Fix Claude CLI login being treated as a host-managed provider: when `access` is `cli_login`, the bridge now leaves `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` unset, avoiding the host-managed credential path for users already authenticated through the Claude CLI (by @zkpaiminmin)
- Fix Claude model metadata after the lineup update: replace the retired `claude-opus-4-7` built-in option with `claude-opus-4-8`, and add `claude-sonnet-5` with 200K / 1M context handling, max reasoning support, usage pricing, model mapping, and localized labels across all supported languages (by @zkpaiminmin)

中文：

🐛 修复
- 修复 Claude CLI 登录被误判为 host-managed provider：当认证状态为 `cli_login` 时，bridge 不再设置 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`，避免已通过 Claude CLI 登录的用户走错 host-managed 凭证路径（by @zkpaiminmin）
- 修复 Claude 模型清单与元数据滞后：内置模型移除已下线的 `claude-opus-4-7`，切换到 `claude-opus-4-8`，并新增 `claude-sonnet-5` 的 200K / 1M 上下文、max reasoning、用量计价、模型映射和全语言本地化标签（by @zkpaiminmin）

---

##### **2026年6月28日（v0.4.6）**

English:

✨ Features
- Add live permission-mode hot-swap: switching the permission mode mid-turn now takes effect immediately for the current turn's subsequent tool calls — no runtime restart, no waiting for the next message. Claude pushes the new mode straight to the live runtime; Codex rebuilds thread options per turn (by @gadfly3173, closes #1380)
- Add a GitHub Star button to the open-source promo banner: click to copy the repository URL for pasting into a browser; the main copy now reads "100% open-source and free", with full localization across 10 languages (by @zkpaiminmin)

🔒 Security Hardening
- Change the default permission mode from `bypassPermissions` to `default`, so tool calls are confirmed by default instead of auto-approved
- PreToolUse hook now returns `ask` for Bash/Agent, overriding permissive `settings.json` allow-rules
- Block `NODE_OPTIONS` / `LD_PRELOAD` / `DYLD_*` and similar environment variables from request-side injection
- Scope "Always allow" for Bash/Agent to the command level instead of the whole tool
- `acceptEdits` mode still requires explicit confirmation for command execution
- Refuse MCP stdio shell launches whose command/args contain shell metacharacters
- Add `--ignore-scripts` to `npm install` to prevent supply-chain RCE via install hooks
- Harden `settings.json` / `config.json` file permissions to `0600`
- Extend the dangerous-path check to Bash command strings and `~` expansion
- Change the Codex default sandbox from `danger-full-access` to `workspace-write`
- Restrict the prompt enhancer to the user settings source with a deny-all `canUseTool`
- (all by @zkpaiminmin)

🐛 Fixes
- Fix Bedrock/Vertex/Foundry returning 403 since v0.4.5: gate `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` on `shouldHostManageProvider()` so it is set only when no cloud-provider switch is active in `settings.json`, and drop any copy inherited from the daemon's own env (by @gadfly3173, closes #1328)
- Fix cloud-provider credentials (`AWS_PROFILE`, `AWS_REGION`, …) being absent when the IDE is launched from the macOS Dock / Windows Start Menu / Linux launcher: inject them at daemon startup so all child processes inherit the correct environment (by @sandeepyadav1478, closes #1310)
- Fix blank tool window on Android Studio 2026.x whose bundled JBR predates b1373 and lacks `JCefAppConfig.isRemoteEnabled()`: detect the platform/JBR mismatch via reflection, widen `create()` to catch `LinkageError`, and show a targeted "upgrade your Boot JBR to b1373+" panel (all 9 locales); fall back to a native confirm dialog when the JCEF permission dialog cannot be created (by @zkpaiminmin)
- Fix background rendering of CLI-initiated session updates: add a TurnSink channel and a perpetual reader so inter-turn results route as `session_updated` events and render without a manual reload (by @gadfly3173, closes #1305)
- Fix whole-turn assistant message / `tool_result` loss caused by React 18 automatic batching: merge the two `onStreamEnd` `setMessages` updaters into one, and add a `__turnId` fallback to the snapshot index guard (by @gadfly3173, closes #1315)
- Fix stale `updateMessages` writing into a freshly cleared session: advance an update-sequence barrier on `clearMessages`, cancel deferred rAF callbacks, and re-check the transition guard in the deferred path (by @gadfly3173, closes #1339)
- Fix new sessions reusing the previous session ID in `TabStateService` / `getSessionId()`: reset `sessionId` in `setupSessionCallbacks()` and split the PermissionService routing key from the exposed session ID (by @commingling, hardened by @zkpaiminmin, closes #1192)
- Fix cross-turn thinking deltas no longer streaming (and a new turn briefly overwriting the previous turn's thinking block): stop clearing the content/thinking buffers on `onBlockReset` and add a trailing-block guard to both the thinking and content sync paths (by @gadfly3173, closes #1369)
- Fix characters vanishing after a duplicated leading delta (e.g. "刚刚", "咕咕嘎嘎"): thread a `stream` / `snapshot` origin through `normalizeStreamDelta` so a zero-novel match no longer locks snapshot mode on the live streaming path (by @gadfly3173, closes #1371)
- Fix dialogs not reappearing after a safety-net timeout, the tab provider type swapping after an IDE restart, and a stale rAF snapshot on new-session clear; force-close now drains the entire pending dialog queue (by @gadfly3173, closes #1360 #1353)
- Fix background reload binding to the wrong session by binding it to the target session ID (by @gadfly3173)
- Fix N parallel `tool_use` (whose results arrive as N separate user messages) being falsely flagged interrupted with a red badge: sweep every consecutive trailing user message until a non-user message is reached (by @gadfly3173)
- Fix the AI working directory resolving to the bridge install dir when the daemon starts without a project, which hid all real project history under a sanitized bridge path (by @gadfly3173, closes #1343)
- Fix `.replace is not a function` crashes when non-string content (arrays, content blocks, numbers) reaches `MarkdownBlock` / `PermissionDialog`: normalize to readable text before rendering (by @gadfly3173)
- Fix tab actions forcing lazy tool-window content creation while the window is closed: use `getContentManagerIfCreated()` with null guards (by @gadfly3173)
- Fix action UI state updates not running on the EDT (by @gadfly3173)
- Fix inline code font-size not matching the surrounding text: use `inherit` instead of a hardcoded 12.5px and keep monospace on syntax-highlighted spans (by @gadfly3173, closes #1304)
- Fix selector dropdowns overflowing the viewport, the large model list growing unbounded, and the node-process submenu flip loop (by @moritzfl)

🔧 Improvements
- Rename the "Agent" terminology to "Prompt" across all locales (by @zkpaiminmin)
- Add a `SECURITY.md` security policy (by @zkpaiminmin)

中文：

✨ 新功能
- 新增权限模式实时热切换：对话进行中切换权限模式即时对当前轮次后续工具调用生效，无需重启 runtime、无需等待下一条消息。Claude 将新模式直接推送到运行中的 runtime；Codex 每轮重建 thread 选项（by @gadfly3173，关闭 #1380）
- 开源推广 banner 新增 GitHub Star 按钮：点击复制仓库地址，粘贴到浏览器即可访问；主文案更新为「本项目保证 100% 开源和免费」，补全全部 10 种语言（by @zkpaiminmin）

🔒 安全加固
- 默认权限模式从 `bypassPermissions` 改为 `default`，工具调用默认需确认而非自动放行
- PreToolUse hook 对 Bash/Agent 返回 `ask`，覆盖 `settings.json` 中过于宽松的 allow 规则
- 阻止 `NODE_OPTIONS` / `LD_PRELOAD` / `DYLD_*` 等环境变量经请求侧注入
- 「始终允许」对 Bash/Agent 限定到命令级，而非整个工具
- `acceptEdits` 模式下命令执行仍要求显式确认
- 拒绝 command/args 含 shell 元字符的 MCP stdio shell 启动
- `npm install` 增加 `--ignore-scripts`，防止经安装钩子的供应链 RCE
- 收紧 `settings.json` / `config.json` 文件权限到 `0600`
- 危险路径检查扩展到 Bash 命令字符串与 `~` 展开
- Codex 默认 sandbox 从 `danger-full-access` 改为 `workspace-write`
- prompt enhancer 限制到 user settings 源，并使用 deny-all `canUseTool`
- （以上均 by @zkpaiminmin）

🐛 修复
- 修复自 v0.4.5 起 Bedrock/Vertex/Foundry 返回 403：将 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` 收敛到 `shouldHostManageProvider()`，仅在 `settings.json` 未启用云 provider 开关时设置，并清除从 daemon 自身环境继承的副本（by @gadfly3173，关闭 #1328）
- 修复从 macOS Dock / Windows 开始菜单 / Linux 启动器打开 IDE 时云 provider 凭证（`AWS_PROFILE`、`AWS_REGION` 等）缺失：在 daemon 启动时注入，使所有子进程继承正确环境（by @sandeepyadav1478，关闭 #1310）
- 修复 Android Studio 2026.x 工具窗空白：其内置 JBR 早于 b1373、缺失 `JCefAppConfig.isRemoteEnabled()`，通过反射检测平台/JBR 不匹配，`create()` 捕获范围放宽到 `LinkageError`，并显示「请升级 Boot JBR 到 b1373+」专属面板（全部 9 种语言）；JCEF 权限弹窗无法创建时回退到原生确认对话框（by @zkpaiminmin）
- 修复 CLI 发起的会话更新不在后台渲染：新增 TurnSink 通道与持续 reader，将轮次间结果作为 `session_updated` 事件路由，无需手动重载即可渲染（by @gadfly3173，关闭 #1305）
- 修复 React 18 自动批处理导致整轮助手消息 / `tool_result` 丢失：将 `onStreamEnd` 的两次 `setMessages` 合并为单个 updater，并为快照索引守卫增加 `__turnId` 回退（by @gadfly3173，关闭 #1315）
- 修复新会话清空后陈旧 `updateMessages` 写入：在 `clearMessages` 时推进更新序列屏障、取消延迟的 rAF 回调，并在延迟路径重新校验切换守卫（by @gadfly3173，关闭 #1339）
- 修复新会话在 `TabStateService` / `getSessionId()` 中复用上一个 session ID：在 `setupSessionCallbacks()` 重置 `sessionId`，并将 PermissionService 路由 key 与对外暴露的 session ID 拆分（by @commingling，@zkpaiminmin 加固，关闭 #1192）
- 修复跨轮 thinking delta 不再流式（以及新一轮 thinking 短暂覆盖上一轮的 thinking 块）：`onBlockReset` 不再清空内容/thinking 缓冲，并为 thinking 与 content 同步路径都加上 trailing-block 守卫（by @gadfly3173，关闭 #1369）
- 修复重复的首个 delta 导致后续字符消失（如「刚刚」「咕咕嘎嘎」）：为 `normalizeStreamDelta` 串入 `stream` / `snapshot` 来源，使零新增匹配在实时流路径上不再锁定 snapshot 模式（by @gadfly3173，关闭 #1371）
- 修复安全网超时后对话框不再弹出、IDE 重启后 tab provider 类型互换、以及新会话清空时陈旧 rAF 快照；force-close 现会排空整个待处理对话框队列（by @gadfly3173，关闭 #1360 #1353）
- 修复后台 reload 绑定到错误会话，改为绑定到目标 session ID（by @gadfly3173）
- 修复 N 个并行 `tool_use`（其结果作为 N 条独立 user 消息到达）被误判为中断而显示红色 badge：扫描所有连续的 trailing user 消息直到遇到非 user 消息（by @gadfly3173）
- 修复 daemon 无项目上下文启动时 AI 工作目录被解析为 bridge 安装目录，导致所有真实项目历史被隐藏在 sanitized bridge 路径下（by @gadfly3173，关闭 #1343）
- 修复非字符串内容（数组、content block、数字）到达 `MarkdownBlock` / `PermissionDialog` 时触发 `.replace is not a function` 崩溃：渲染前归一化为可读文本（by @gadfly3173）
- 修复 tab action 在工具窗关闭时强制懒创建工具窗内容：改用带 null 守卫的 `getContentManagerIfCreated()`（by @gadfly3173）
- 修复 action UI 状态更新未在 EDT 线程执行（by @gadfly3173）
- 修复行内代码字号与周围文本不一致：用 `inherit` 替代硬编码 12.5px，并保持高亮 span 的等宽字体（by @gadfly3173，关闭 #1304）
- 修复选择器下拉菜单超出视口、大模型列表无限撑高、以及 node 进程子菜单翻转循环（by @moritzfl）

🔧 改进
- 将全部语言中的「Agent」术语改名为「Prompt」（by @zkpaiminmin）
- 新增 `SECURITY.md` 安全策略文档（by @zkpaiminmin）

---

##### **2026年6月11日（v0.4.5）**

English:

✨ Features
- Add Codex fast mode: new "Fast" speed mode in the model selector that maps to `service_tier=fast` for supported Codex models; normal mode preserves Codex defaults (by @llanc)
- Add Claude Code CLI path override: new "Claude CLI Path (override)" setting in Settings → Environment lets you point the plugin at a specific `claude` binary; daemon restarts automatically on save (by @senfix, co-authored with Claude)
- Add separate Code Font setting (Settings → Basic → Appearance), independent from the UI font: Markdown code and Bash command/output use the code font; chat text follows the IDEA UI font; both accept a custom `.ttf` / `.otf` file (by @Luna5ama, closes #1240)
- Add Codex subscription quota panel in the model selector: shows ChatGPT Plus/Pro quota status with dual-source fetching (session message + ChatGPT API), snapshot caching, and a dedicated message for API-key mode (by @Luna5ama)
- Add Shift+Esc shortcut to hide the CCG tool window panel (intercepted at JS level via JBCefJSQuery since JCEF consumes the key natively) (by @Cyber0xFE)
- Add Ctrl+Alt+K to always open the CCG panel regardless of editor selection; auto-focus the input field on activation (by @Cyber0xFE)
- Add per-message token consumption indicator at the bottom of each turn showing whole-turn aggregated input/output token count (by @suzhelan, refined by @zkpaiminmin)
- Add SDK session to CLI session conversion: sessions created via SDK (sdk-cli / claude-vscode entrypoint) can be converted to CLI sessions, making them visible in the `/resume` list; shown as entrypoint badges in history with a "Convert to CLI" action (by @gadfly3173)
- Add Claude Fable 5 model support with Mythos-class capabilities; add Fable 5 pricing ($10/$50 per 1M tokens) (by @zkpaiminmin)
- Integrate Claude Code Task tracking API (TaskCreate / TaskUpdate / TaskGet / TaskList): task management tools render as collapsible agent groups with absorbed nested tool calls and persisted expand/collapse state; task list in StatusPanel supports both legacy `todowrite` and new Task API tasks (by @gadfly3173, co-authored with @zhuzhihang)

🐛 Fixes
- Fix full WSL2 compatibility suite: install Claude SDK into WSL filesystem; handle raw/forward-slash UNC WSL paths; propagate permission env vars across Windows→WSL boundary via WSLENV; merge (not replace) probed login-shell PATH to preserve Homebrew/pyenv/sdkman; migrate path handling to `WslPathUtil`; resolve Claude home at call time in session conversion (by @Gazoon007)
- Fix tool spinner stuck permanently after stream end: preserve `tool_result` messages from the pending snapshot when the rAF-batched update is cancelled; decouple recovery from the assistant-patch branch so it fires even with no streaming assistant message (by @Cyber0xFE, hardened by @zkpaiminmin)
- Fix code snippet sent before frontend is ready: replace retry-based approach with `PendingCodeSnippetBuffer` (AtomicReference) that flushes on the frontend-ready signal, eliminating check-then-act race (by @Cyber0xFE, refactored by @zkpaiminmin)
- Fix usage cost overstatement: deduplicate JSONL records by `message.id` (Claude Code writes each content block as its own line, inflating counts ~2×); correct Opus 4.5/4.6/4.7/4.8 pricing from legacy $15/$75 to $5/$25 per 1M tokens (by @t7r5fz7848-lab, re-applied by @zkpaiminmin)
- Fix Bash output code font not applying: `.bash-output-text` leaf node was overridden by the global `*` selector; declare `font-family` directly on the leaf (by @zkpaiminmin)
- Fix settings.json env vars silently overriding webview-selected reasoning effort, `MAX_THINKING_TOKENS`, and 1M context toggle: strip controlled vars from daemon and CLI child-process env; inject inline `--settings` override so the SDK respects per-turn UI selections (by @gadfly3173)
- Fix selected reasoning effort not passed to SDK: include `reasoningEffort` in Claude send payloads; thread it through `SessionHandler` → `ClaudeSession` → `SessionSendService`; prefer requested value over session state (by @gadfly3173)
- Fix Codex history tool UI disappearing after restart: unwrap normalized history raw payloads during session restore so tool_use, tool_result, command details, and image-only messages survive frontend transport (by @Luna5ama)
- Fix node process submenu causing layout loop in the webview (by @gadfly3173)
- Fix Codex fast mode overriding service tier in standard (non-fast) mode (by @llanc)
- Fix Markdown links with spaces/special characters: decode percent-encoded and `file://` hrefs before opening in the IDE (by @moritzfl)
- Fix per-message token display inconsistency: stamp `turnUsage` whole-turn aggregate at turn completion; frontend reads only `turnUsage` with a breakdown tooltip (by @zkpaiminmin)
- Fix Codex quota cache not invalidating on account switch: call `invalidateCache()` on every `switchCodexProvider` path (by @zkpaiminmin)
- Fix Codex quota showing wrong account data in API-key mode: skip OAuth quota lookup and show a dedicated API-key-mode message (by @zkpaiminmin)
- Fix duplicate `tool_result` in stream-end snapshot recovery; align `[tool_result]` marker trimming (by @zkpaiminmin)
- Fix command messages leaking into display on normalized history envelopes: pass `rawMessage` to `shouldFilterCommandMessage` (by @zkpaiminmin)
- Fix Claude CLI path input blanked on validation failure: echo back the user's input instead of an empty string (by @zkpaiminmin)
- Fix agent group absorbing wrong children after history reload: replace streaming-count-based grouping with a purely structural rule; fix `extractAccumulatedTasks` single-pass with per-message ID trust guard for parallel TaskCreate (by @zkpaiminmin)
- Fix symlink escape in project-boundary check on native POSIX: restrict lexical WSL fallback to WSL paths only; native POSIX goes through `getCanonicalPath` (security) (by @zkpaiminmin)
- Fix XSS via control-character-obfuscated `href` schemes (e.g. `java&#9;script:`): reject hrefs containing C0 control characters before scheme checks in the DOMPurify hook (security) (by @zkpaiminmin)

🔧 Improvements
- Enhance Bash output rendering with dedicated CSS classes for improved syntax distinction (by @Luna5ama)
- Improve Codex quota fetching: dual-source (session message + ChatGPT API), snapshot caching with timeout, single shared `HttpClient`, unwrapped `CompletionException` for readable errors (by @Luna5ama, @zkpaiminmin)
- Split env var groups into `MODEL_ROUTING_ENV_VARS` and `REASONING_CONTROL_ENV_VARS` for explicit treatment, preventing the two sets from drifting independently (by @gadfly3173)
- Add Docker build support (`Dockerfile` + `.dockerignore`) for reproducible plugin distribution without a local Java/Node toolchain (by @senfix)
- Replace emoji blocked marker in StatusPanel TodoList with `codicon-circle-slash` for consistency with the codicon icon system (by @zkpaiminmin)

中文：

✨ 新功能
- 新增 Codex 快速模式：模型选择器新增「快速」速度模式，映射到 `service_tier=fast`；普通模式保持 Codex 默认行为（by @llanc）
- 新增 Claude Code CLI 路径覆盖：设置 → 环境新增「Claude CLI Path (override)」，允许指定自定义 `claude` 可执行文件；保存后自动重启 daemon（by @senfix，与 Claude 共同开发）
- 设置 → 基础 → 外观新增独立「代码字体」配置，与 UI 字体分离：Markdown 代码与 Bash 命令/输出使用代码字体，聊天文本跟随 IDEA UI 字体；两者均支持自定义 `.ttf` / `.otf` 文件（by @Luna5ama，关闭 #1240）
- 新增 Codex 订阅配额面板：在模型选择器中显示 ChatGPT Plus/Pro 配额，双来源拉取（会话消息 + ChatGPT API），快照缓存，API 密钥模式专属提示（by @Luna5ama）
- 新增 Shift+Esc 快捷键隐藏 CCG 工具窗口面板（通过 JBCefJSQuery 在 JS 层拦截，绕过 JCEF 原生键盘消费）（by @Cyber0xFE）
- Ctrl+Alt+K 无论是否有代码选择均可打开 CCG 面板，激活时自动聚焦输入框（by @Cyber0xFE）
- 每条消息底部新增 Token 消耗指示器，显示整轮聚合输入/输出 Token 数（by @suzhelan，@zkpaiminmin 优化）
- 新增 SDK 会话转换为 CLI 会话：通过 SDK 创建的会话（sdk-cli / claude-vscode 入口）可转换为 CLI 会话，出现在 `/resume` 列表；历史列表显示入口徽章和「转换为 CLI」操作（by @gadfly3173）
- 新增 Claude Fable 5 模型支持（Mythos 级），添加 Fable 5 定价（输入 $10/1M，输出 $50/1M）（by @zkpaiminmin）
- 集成 Claude Code Task tracking API（TaskCreate / TaskUpdate / TaskGet / TaskList）：任务管理工具渲染为可折叠 Agent 分组，内含嵌套工具调用，展开/折叠状态持久化；StatusPanel 任务列表同时支持旧版 `todowrite` 和新 Task API（by @gadfly3173，@zhuzhihang 共同开发）

🐛 修复
- 修复 WSL2 全套兼容性问题：Claude SDK 安装到 WSL 文件系统；处理原始路径和正斜杠 UNC WSL 路径；通过 WSLENV 跨 Windows→WSL 边界传播权限环境变量；合并（而非替换）登录 Shell PATH，保留 Homebrew/pyenv/sdkman；路径处理迁移到 `WslPathUtil`；会话转换时按需解析 Claude home（by @Gazoon007）
- 修复工具 spinner 在流结束后永久卡住：rAF 批量更新取消时保存待处理快照中的 `tool_result`；将恢复逻辑从 assistant-patch 分支解耦（by @Cyber0xFE，@zkpaiminmin 加固）
- 修复代码片段在前端未就绪时被发送：用 `PendingCodeSnippetBuffer`（AtomicReference）替代重试机制，消除竞态（by @Cyber0xFE，@zkpaiminmin 重构）
- 修复使用量统计高估：按 `message.id` 去重 JSONL 记录（每个内容块独立写行导致约 2× 膨胀）；将 Opus 4.5/4.6/4.7/4.8 定价从 $15/$75 修正为 $5/$25 /1M（by @t7r5fz7848-lab，@zkpaiminmin 重新适配）
- 修复 Bash 输出代码字体未生效：`.bash-output-text` 叶子节点被全局 `*` 选择器覆盖，直接在叶子声明 `font-family`（by @zkpaiminmin）
- 修复 settings.json 环境变量静默覆盖推理力度、`MAX_THINKING_TOKENS` 和 1M 上下文切换：从 daemon 和 CLI 子进程环境剥离相关变量；注入行内 `--settings` 覆盖（by @gadfly3173）
- 修复选择的推理力度未传递给 SDK：在 Claude 发送 payload 中携带 `reasoningEffort`；通过 `SessionHandler` → `ClaudeSession` → `SessionSendService` 串联（by @gadfly3173）
- 修复 Codex 历史工具 UI 重启后消失：恢复会话时解包归一化历史 raw payload（by @Luna5ama）
- 修复 Node 进程子菜单导致 webview 布局死循环（by @gadfly3173）
- 修复 Codex 快速模式在普通模式下错误覆盖 service_tier（by @llanc）
- 修复含空格/特殊字符的 Markdown 路径链接无法打开：打开前解码 percent-encoded 和 `file://` href（by @moritzfl）
- 修复每条消息 Token 显示语义不一致：对话轮次完成时填入 `turnUsage` 整轮聚合值，tooltip 分解全部四个值（by @zkpaiminmin）
- 修复切换 Codex 账户时订阅配额缓存未失效（by @zkpaiminmin）
- 修复 API 密钥模式下 Codex 配额显示错误账户数据，跳过 OAuth 配额查询（by @zkpaiminmin）
- 修复流结束快照恢复中 `tool_result` 重复；对齐 `[tool_result]` 标记 trim 处理（by @zkpaiminmin）
- 修复历史消息归一化封装时命令消息泄漏到显示（by @zkpaiminmin）
- 修复 Claude CLI 路径验证失败时输入框被清空（by @zkpaiminmin）
- 修复历史回放后 Agent 分组吸收错误子节点：改为纯结构化规则；`extractAccumulatedTasks` 单遍处理加并行 TaskCreate ID 冲突守卫（by @zkpaiminmin）
- 修复原生 POSIX 上项目边界检查未解析软链接的逃逸问题，限制词法回退仅用于 WSL（安全）（by @zkpaiminmin）
- 修复控制字符混淆 `href` XSS（如 `java&#9;script:`），在 DOMPurify hook 的 scheme 检查前拒绝含 C0 控制字符的 href（安全）（by @zkpaiminmin）

🔧 改进
- 为 Bash 输出渲染引入专用 CSS 类，改善语法区分度（by @Luna5ama）
- 改进 Codex 配额拉取：双来源、带超时快照缓存、复用单个 `HttpClient`、unwrap `CompletionException`（by @Luna5ama，@zkpaiminmin）
- 将环境变量拆分为 `MODEL_ROUTING_ENV_VARS` 和 `REASONING_CONTROL_ENV_VARS`，防止独立漂移（by @gadfly3173）
- 新增 Docker 构建支持（`Dockerfile` + `.dockerignore`），无需本地工具链可复现发布包（by @senfix）
- StatusPanel TodoList 中将 emoji 阻断标记替换为 `codicon-circle-slash`（by @zkpaiminmin）

---

##### **2026年5月29日（v0.4.4）**

English:

✨ Features
- Add Node Process Manager panel in the chat settings menu (under "Switch Current Provider"). Shows all Node.js child processes for the current project grouped into Daemon, Active Channels and Orphan, with PID, uptime, memory, and per-process Kill / Restart / Interrupt actions. Includes a one-click "Clean up all orphans" button to recover from process leak accumulation
- Add orphan process scanner that detects Node processes matching `daemon.js` / `channel-manager.js` in the OS process list but not in any of our registries. Orphans are surfaced in the panel with a red warning highlight so users can manually terminate processes the plugin failed to clean up
- Add live process count badge to the settings menu: shows the total active Node process count, switches to red with a ⚠ when orphan processes are detected
- Add in-conversation search panel (Cmd+F on macOS, Ctrl+F elsewhere): navigate matches with Prev/Next, Esc to close, hit count display; auto-expands collapsed folds when a hit lands inside; closes automatically when switching views to avoid clashing with HistoryFilters
- Add Match Case / Whole Word / Regex toggles to the conversation search panel with Alt+C / Alt+W / Alt+R shortcuts; toggle state persisted via localStorage; regex mode surfaces an "Invalid regex" hint on compile failure
- Add a "Don't ask again" checkbox to the new-session confirm dialog (preference persisted to localStorage); the matching switch is added to Settings → Basic → Behavior with two-way sync via CustomEvent. Interrupting a running AI still always confirms regardless of this preference
- Add Claude Opus 4.8 model support: register `claude-opus-4-8` and `claude-opus-4-8[1m]` context limits (200K / 1M tokens), reasoning-effort mapping, and mark it as the latest flagship (Opus 4.7 demoted to previous flagship)
- Add `spawn EBUSY` error pattern with two recommended fixes (check the Node.js version, reinstall the SDK from the official registry) across 11 locales
- Add 10-language localization (zh, zh-TW, en, ja, ko, es, fr, pt-BR, ru, hi) for Node Process Manager, conversation search, and the new-session preference switch

🐛 Fixes
- Fix Codex history sessions failing to load due to two coupled bugs: (1) `HistoryMessageInjector.handleLoadSession` used variable shadows so the Codex branch read the unresolved `currentProvider` / `sessionId` instead of the parsed payload values, causing wrong provider routing; (2) `CodexMessageConverter.convertFunctionCallToToolUse` did not map the Codex `cmd` field to the frontend `command` field, breaking timeline rendering when replaying `exec_command` history. Regression tests pinned for both paths
- Fix Claude daemon process leak on tab provider switch: previously the daemon stayed alive for the rest of the tab's lifetime even after switching to Codex. `ModelProviderHandler` now shuts down the lingering daemon on Claude → non-Claude transitions; the daemon is lazily restarted on the next Claude message if the user switches back
- Fix orphan process scanner falsely identifying daemons belonging to OTHER IDE instances as orphans. When running CC GUI in both IDEA and PyCharm side-by-side, each instance previously listed the other's daemons — "Kill all orphans" would have terminated live work in the foreign IDE. The scanner now checks `ProcessHandle.parent()` and only attributes a process to this JVM when its parent PID matches `ProcessHandle.current().pid()`
- Fix Node.js child process leaks across 11 short-lived subprocess paths (L1-L11): `PromptEnhancerHandler`, `ClaudeQueryExecutor.executeQueryStream` / `executeQuerySync`, `ClaudeSessionQueryService`, `ClaudeRewindService`, `InputHistoryHandler`, `NodeJsServiceCaller`, `BaseSDKBridge.executeStreamingCommand`, `CodexSDKBridge.getMcpServerTools`. None of these registered the child with `ProcessManager`, so a stalled SDK call would leak the Node process for the lifetime of the IDE instance and bypass shutdown cleanup. Each is now registered immediately after `pb.start()`, force-killed via `PlatformUtils.terminateProcess()` in `finally`, and symmetrically unregistered
- Fix `PromptEnhancerHandler` blocking on stalled SDK calls forever: `process.waitFor()` had no timeout and a synchronous `readLine()` on a stuck stream defeated cancellation. Output is now drained asynchronously and a 60s timeout is enforced
- Fix `CodexSDKBridge.getMcpServerTools` race where concurrent calls overwrote each other's process reference in `ProcessManager`'s registry under the shared constant key `__codex_mcp_tools__`; each call now generates a unique UUID-suffixed channelId
- Fix `daemon.js` parent-PID polling interval from 10s to 3s, tightening the worst-case orphan-daemon lifetime after a hard IDE crash
- Fix character loss and duplication in streaming deltas: the incremental `computeNovelDelta` stale-replay `endsWith` check caused false positives (e.g. "1500" rendered as "150"), and an interim assistant snapshot arriving before stream events populated a block emitted the block text twice. The stale-replay check is now restricted to cumulative-snapshot mode and the premature snapshot delta is suppressed (by @Cyber0xFE)
- Fix snapshot-path delta mis-slicing: snapshots were derived with a naive `substring(previousBlock.length)`, so a Claude-compatible provider emitting a mid-stream corrective rewrite (shared prefix, divergent middle) was mis-sliced or silently dropped. Snapshots now route through `resolveSnapshotDelta`, reusing the live `normalizeStreamDelta` novelty/correction engine so both paths share one source of truth
- Fix new assistant turns being overwritten when the frontend reloads mid-stream: Java now sends `onStreamStart("replay")` to reuse the existing assistant message, while genuine new turns append a fresh message instead of clobbering the previous completed response (by @gadfly3173)
- Fix cross-turn streaming state leak: per-block content/mode maps persisted across assistant turns within one request, so a normal turn-end locked the index-0 block into snapshot mode and leaked a stale accumulator into the next turn — fragmenting or vanishing thinking text and re-emitting whole blocks. Per-block state is now reset at each `message_start` (token usage still accumulates across turns)
- Fix `PreToolUseHook` returning the invalid `permissionDecision: 'continue'` (not in the `HookPermissionDecision` enum `allow | deny | ask | defer`), which tripped the SDK Zod validator and surfaced as intermittent `ZodError: invalid_value` on every tool call. Replaced with the top-level `continue: true` yield signal across all four non-deny call sites (by @devlimits)
- Fix JCEF render ghosting on macOS leaving stale pixels after session changes, and draft attachments drifting into a newly opened conversation. Added `forceWebviewRepaint` and a `useResetAttachmentsOnSessionChange` hook wired into clearMessages, session transitions, and changelog/banner dismissals
- Fix `killByPid` being able to terminate arbitrary process trees: a malformed or hostile frontend payload could request killing any PID on the host. An ownership check now restricts termination to PIDs present in this JVM's process snapshot (security)

🔧 Improvements
- Add project-scoped `NodeProcessRegistry` service that aggregates Node process state across all chat windows (including detached windows) for a unified inspection view
- Expose `ProcessManager.getActiveChannelSnapshot()`, `BaseSDKBridge.getProcessManager()`, `ClaudeSDKBridge.getCurrentDaemonBridgeForInspection()`, `DaemonBridge.getDaemonProcessForInspection()` for read-only process inspection from the UI layer
- Replace the daemon process label hard-coded as "claude" with the tab's current provider (claude/codex), so the panel matches what users see in the chat tab
- Add `ProcessManager.newChannelId(prefix)` helper and route 7 call sites through it (consolidated channel-id generation)
- Add an SDK hook output validator (`permission-mode-schema.js`) that runs on every hook return to guarantee the shape passes the SDK's Zod schema, guarding against the `permissionDecision` regression class; extract a frozen `YIELD_TO_SDK` constant to prevent the four yield branches from drifting apart
- Categorise reader-thread failures in `ClaudeRewindService` and `PromptEnhancerProcessRunner` (IOException = expected on kill, RuntimeException = real bug logged with stack); replace magic 60s/5s timeouts with named constants
- Replace the `boolean[1]` lambda-capture trick in `NodeProcessRegistry` with `AtomicBoolean` to satisfy Checkstyle (semantically equivalent, no behaviour change)

中文：

✨ 新功能
- 在聊天设置菜单中（"切换当前供应商"下方）新增「Node 进程管理」面板，集中展示本项目所有 Node.js 子进程。按守护进程 / 进行中对话 / 孤立进程三类分组，每个进程显示 PID、运行时长、内存占用，并提供终止 / 重启 / 中断按钮。底部一键"清理所有孤立进程"按钮，专治长时间使用后的 Node 进程堆积
- 新增孤立进程扫描器：扫描系统级 Node 进程，找出含 `daemon.js` / `channel-manager.js` 但不在我们注册表中的进程，在面板中以红色警告高亮显示，让用户能手动终止插件未能正确清理的失控进程
- 设置菜单实时显示进程总数徽章：正常时灰色显示总数，检测到孤立进程时变为红色 ⚠ 警告
- 新增会话内搜索面板：macOS 下 Cmd+F、其他平台 Ctrl+F 唤起；支持上一个/下一个匹配、Esc 关闭、命中计数显示；命中折叠区域时自动展开早期消息并提示展开数量；切换视图时自动关闭，避免与 HistoryFilters 冲突
- 会话内搜索新增 Match Case / Whole Word / Regex 三个模式开关，对应 Alt+C / Alt+W / Alt+R 快捷键；开关状态通过 localStorage 持久化；正则模式下编译失败时显示 Invalid regex 错误提示
- 新建会话确认弹窗新增"不再提示"复选框，偏好持久化到 localStorage；设置 → 基础 → 行为页同步增加对应开关，与对话框通过 CustomEvent 双向联动。中断运行中 AI 的危险操作始终强制确认，不受此偏好影响
- 新增 Claude Opus 4.8 模型支持：注册 `claude-opus-4-8` 与 `claude-opus-4-8[1m]` 上下文限制（200K / 1M tokens）、reasoning-effort 映射，并标记为最新旗舰（Opus 4.7 降为前代旗舰）
- 新增 `spawn EBUSY` 错误模式，提供两个推荐解决方案（检查 Node.js 版本、从官方源重装 SDK），覆盖 11 种语言
- Node 进程管理、会话内搜索、新建会话偏好开关支持 10 种语言（中简、中繁、英、日、韩、西、法、葡、俄、印地）

🐛 修复
- 修复 Codex 历史会话点不开的问题：根因是两个耦合 bug——(1) `HistoryMessageInjector.handleLoadSession` 内变量影子写错，Codex 分支读到了未解析的 `currentProvider` / `sessionId` 而不是 payload 解析后的值，导致 provider 路由错乱；(2) `CodexMessageConverter.convertFunctionCallToToolUse` 未把 Codex 协议的 `cmd` 字段映射为前端期望的 `command` 字段，导致 `exec_command` 历史回放时间线全空白。两条路径都补上了防回归测试
- 修复 Tab 从 Claude 切换到 Codex 后 Claude daemon 不关闭导致进程泄漏的问题：之前用户在 Tab 切换 provider 类型到 Codex 后，原 Claude daemon 会一直存活到 Tab 关闭。现在 `ModelProviderHandler` 会在 Claude → 非 Claude 切换时主动关闭 daemon；用户切回 Claude 时下条消息会自动重新启动新 daemon
- 修复多 IDE 实例下孤立进程误判的问题：之前同时打开 IDEA + PyCharm 跑 CC GUI 时，两个实例会把对方的 daemon 当成自己的孤立进程显示，「清理所有孤立进程」会误杀另一个 IDE 正在运行的对话。现在通过 `ProcessHandle.parent()` 比对当前 JVM PID，每个实例只认领自己 fork 出来的真正孤立进程
- 修复 11 处 Node.js 短生命周期子进程泄漏（L1-L11）：`PromptEnhancerHandler`、`ClaudeQueryExecutor.executeQueryStream` / `executeQuerySync`、`ClaudeSessionQueryService`、`ClaudeRewindService`、`InputHistoryHandler`、`NodeJsServiceCaller`、`BaseSDKBridge.executeStreamingCommand`、`CodexSDKBridge.getMcpServerTools`。这些路径以前都没有把 fork 出来的子进程注册到 `ProcessManager`，导致 SDK 卡死时子进程能存活到 IDE 退出，绕过关机清理。现在每处都在 `pb.start()` 后立即注册，`finally` 块中通过 `PlatformUtils.terminateProcess()` 强制终止，并对称取消注册
- 修复 `PromptEnhancerHandler` 在 SDK 卡死时永久阻塞调用线程的问题：`process.waitFor()` 没有超时，且同步 `readLine()` 读卡住的流根本无法被超时打断。改为异步消耗 stdout + 60 秒硬性超时
- 修复 `CodexSDKBridge.getMcpServerTools` 并发竞争：之前用常量 key `__codex_mcp_tools__` 注册到 `ProcessManager`，并发调用会互相覆盖 Process 引用，被覆盖的子进程无法再被取消注册。现在每次调用生成 UUID 后缀的唯一 channelId
- 修复 `daemon.js` 父进程心跳从 10s 缩短到 3s，IDE 硬崩溃后 daemon 最长存活时间从 10 秒收紧到 3 秒
- 修复流式增量中字符丢失和重复的问题：增量模式下 `computeNovelDelta` 的 `endsWith` 陈旧重放检测误判（例如 "1500" 被渲染成 "150"），且流事件尚未填充内容块时提前到达的助手快照会把整块文本重复输出一次。现在陈旧重放检测仅在累积快照模式下生效，并抑制过早的快照 delta（by @Cyber0xFE）
- 修复快照路径 delta 错误切片的问题：快照之前用朴素的 `substring(previousBlock.length)` 计算，导致 Claude 兼容 provider 发出的中途修正重写（共享前缀、中段分叉）被错误切片或静默丢弃。现在快照统一走 `resolveSnapshotDelta`，复用实时路径的 `normalizeStreamDelta` 新增/修正引擎，两条路径共享同一处真相来源
- 修复前端在流式过程中重载时新一轮回复被覆盖的问题：Java 现在发送 `onStreamStart("replay")` 复用现有助手消息，而真正的新一轮回复会追加一条全新消息，不再覆盖上一条已完成的回复（by @gadfly3173）
- 修复跨 turn 的流式状态泄漏：一次请求内的 per-block 内容/模式 map 会在多轮助手回复间残留，正常的一轮结束会把 index-0 块锁定为快照模式，并把陈旧累积器泄漏到下一轮——导致思考文本碎裂或消失、整块内容被重复输出。现在每次 `message_start` 都重置 per-block 状态（token 用量仍跨轮累积）
- 修复 `PreToolUseHook` 返回非法的 `permissionDecision: 'continue'`（不在 `HookPermissionDecision` 枚举 `allow | deny | ask | defer` 中）导致触发 SDK Zod 校验、每次工具调用都间歇性抛出 `ZodError: invalid_value` 的问题。改用 `SyncHookJSONOutput` 顶层的 `continue: true` 让行字段，覆盖全部四个非 deny 调用点（by @devlimits）
- 修复 macOS 上 JCEF 渲染残影（会话切换后残留旧像素）以及草稿附件漂移到新会话的问题。新增 `forceWebviewRepaint` 与 `useResetAttachmentsOnSessionChange` Hook，接入 clearMessages、会话切换、更新日志弹窗与横幅关闭等时机
- 修复 `killByPid` 可终止任意进程树的问题：格式错误或恶意的前端 payload 可请求杀死宿主机上任意 PID。现在加入所有权校验，仅终止当前 JVM 进程快照中存在的 PID（安全）

🔧 改进
- 新增项目级 `NodeProcessRegistry` 服务，跨所有聊天窗口（含游离窗口）聚合 Node 进程数据，实现统一管理视图
- 暴露 `ProcessManager.getActiveChannelSnapshot()`、`BaseSDKBridge.getProcessManager()`、`ClaudeSDKBridge.getCurrentDaemonBridgeForInspection()`、`DaemonBridge.getDaemonProcessForInspection()` 用于只读进程检视
- 进程面板的 daemon 标签从硬编码 "claude" 改为读取 Tab 当前 provider（claude/codex），与用户在聊天 Tab 看到的供应商完全一致
- 新增 `ProcessManager.newChannelId(prefix)` 统一生成 channelId，收编 7 个调用点
- 新增 SDK hook 返回值校验器（`permission-mode-schema.js`），在每次 hook 返回时运行，确保返回结构能通过 SDK 的 Zod 校验，防范 `permissionDecision` 类回归；并提取冻结常量 `YIELD_TO_SDK`，防止四个让行分支各自漂移
- `ClaudeRewindService` / `PromptEnhancerProcessRunner` 中区分 reader 线程异常分类（IOException = 终止时预期，RuntimeException = 真 bug，带堆栈记录）；用具名常量替换魔法数 60s / 5s
- `NodeProcessRegistry` 中用 `AtomicBoolean` 替换 `boolean[1]` 的 lambda 闭包绕过技巧，满足 Checkstyle 要求（行为等价无差异）

---

##### **2026年5月22日（v0.4.3）**

English:

✨ Features
- Add `/context` slash command for context usage visualization: shows a colored token-grid dialog with per-category breakdown and expandable detail tables for MCP tools, agents, memory files, and skills (by @gadfly3173)
- Add Codex custom environment variable configuration in Settings → Codex Provider, with protected key enforcement and 16 KB value cap (by @orwenxiang)
- Add project-level commit AI prompt configuration in Settings → Commit, independent of the global commit prompt (priority: built-in > global > project > diff)
- Restore locally attached images in history replay for both Claude and Codex sessions (by @GlMelon)
- Render `/compact` summary as a collapsible notification block matching CLI style, with expandable content and i18n support across 10 locales (by @gadfly3173)
- Add file path tooltip on hover for file links in tool blocks and markdown content, with project-relative display and fallback to absolute path (by @ywz626)
- Add configurable auto-cancel timeout for permission, plan-approval, and ask-user-question dialogs; default 30s, range 5–300s, configurable in Settings → Basic → Behavior (by @ywz626)
- Add WSL Node.js path support for Windows hosts: verify and invoke WSL-installed Node binaries without requiring a Windows-native install (by @Gazoon007)
- Add persistent user language preference with a "Follow IDE" option in Settings → Appearance; language selection now survives IDE restarts (by @gadfly3173)
- Add gpt-5.4-mini context limit (400K tokens) and model-specific pricing ($0.75/$4.50/$0.075 per 1M tokens) to avoid cost overestimation
- Add Codex expired-session-thread error pattern with bilingual i18n across 11 locales

🐛 Fixes
- Fix settings.json permission rules being bypassed by the PreToolUseHook: collapse all non-plan paths to return `continue` so the SDK evaluates Deny/Allow/Ask rules natively (by @devlimits)
- Fix settings.json permission rules not applying in plan mode; plan-mode-specific branches (ExitPlanMode, PLAN.md edit, Bash discourage) are preserved unchanged (by @devlimits)
- Fix AI-generated session titles exceeding the 50-char user-rename limit causing silent failures; AI titles now update the history list locally without going through the rename endpoint (by @devlimits)
- Fix streaming updates not rendering in deprioritized JCEF paint states (e.g. scheduled-wakeup workflows); replace `requestAnimationFrame` with `setTimeout(fn, 16)` for the streaming batching path (by @devlimits)
- Fix provider not being preserved when loading history sessions across different providers (by @GlMelon)
- Fix user-initiated request aborts being treated as errors and showing error toasts; aborts are now handled as graceful completion across the bridge, daemon, and stream adapter layers (by @GlMelon)
- Fix streaming content being overwritten by an earlier backend coalescer snapshot after stream-end; streaming content is now always preferred over the backend snapshot (by @GlMelon)
- Fix assistant messages containing command-name XML tags in code examples being incorrectly filtered or rendered as slash commands (by @gadfly3173)
- Fix Haiku model env variable mapping from incorrect `SMALL_FAST_MODEL` to `ANTHROPIC_DEFAULT_HAIKU_MODEL` (by @gadfly3173)
- Fix ContextUsageDialog autoCompactThreshold percentage calculation (by @gadfly3173)
- Fix SlashCommandJsonReader path normalization for IntelliJ VFS (by @gadfly3173)
- Fix Claude and Codex usage aggregation alignment: fix cache token double-counting and add model alias resolution (by @yadue)
- Fix UTF-8 BOM in config files causing parse failures; preserve ai-bridge cache directory during multi-instance startup (by @CoderDream)
- Fix plan-mode UI controls: `/plan` command sends as normal text in Codex mode instead of showing a warning toast; "(1M context)" suffix only shown for Claude provider (by @gadfly3173)
- Fix italic font-style causing poor readability on small screens by removing it from model/mode selectors, Mermaid placeholders, and tooltip text
- Fix Claude history fallback scan path assigning last-message timestamp to both firstTimestamp and lastTimestamp; now tracks them separately
- Fix Windows Codex taskkill parse noise after process completion (by @lrk1314)
- Fix webview package-lock.json containing a private npm mirror URL; pin registry to registry.npmjs.org
- Fix XSS bypass in MarkdownBlock catch fallback: escape raw content instead of passing to dangerouslySetInnerHTML (security)
- Fix API key and token leakage in error messages: redact Anthropic/OpenAI keys, Bearer tokens, Authorization headers, and GitHub PATs before surfacing in the UI and Java logs (security)
- Fix EnvironmentConfigurator shell invocation restricted to an allowlist of known shells to prevent tampered `$SHELL` from pointing at an arbitrary binary (security)

🔧 Improvements
- Extract `UserMessageSanitizer` utility for stripping system context tags and appended IDE context from user-facing history transcript during replay (by @GlMelon)
- Remove dead permission helpers (`shouldAutoApproveTool`, `shouldAcceptEditsTool`, `ACCEPT_EDITS_AUTO_APPROVE_TOOLS`) orphaned by the settings.json permission fix (by @devlimits)
- Improve file link tooltip implementation: extract logic into `useMarkdownFileLinkTooltip` hook, move styles to CSS, use DOM `getBoundingClientRect()` for precise positioning, and add an LRU cache (max 200 entries) to prevent memory growth in long sessions (by @ywz626)
- Add GitHub issue templates with structured required fields, bilingual (zh/en) labels, and auto-applied label rules to reduce duplicate issues
- Refactor `ContextUsageDialog`: extract a generic `DetailsTable` sub-component to consolidate four near-identical MCP/agents/memory/skills tables
- Consolidate WSL-aware node command construction across all bridge components using `NodeDetector.buildNodeScriptCommand()` helper
- Add `-PskipWebview=true` Gradle property to skip the webview build during backend-only development iterations

中文：

✨ Features
- 新增 `/context` 斜线命令，可视化上下文用量：弹出彩色 Token 网格对话框，按类别分类展示，并支持展开 MCP 工具、子代理、记忆文件和技能的详细表格（by @gadfly3173）
- 新增 Codex 自定义环境变量配置，在「设置 → Codex Provider」中管理，支持受保护 Key 校验和 16 KB 值长度上限（by @orwenxiang）
- 新增项目级提交 AI 提示词配置，可在「设置 → 提交」中独立于全局提示词进行配置（优先级：内置 > 全局 > 项目 > diff）
- 历史回放时恢复本地附件图片，Claude 和 Codex 会话均支持（by @GlMelon）
- 将 `/compact` 摘要渲染为可折叠通知块，风格与 CLI 保持一致，支持展开详细内容，并覆盖 10 种语言（by @gadfly3173）
- 在工具调用块和 Markdown 内容的文件链接上添加悬浮路径提示，显示项目相对路径，超出项目根目录时回退为绝对路径（by @ywz626）
- 新增权限对话框、计划审批对话框和「询问用户」对话框的可配置自动取消超时，默认 30 秒，范围 5–300 秒，可在「设置 → 基础 → 行为」中调整（by @ywz626）
- 新增 Windows 主机 WSL Node.js 路径支持：可使用 WSL 安装的 Node.js 二进制文件，无需安装 Windows 原生版本（by @Gazoon007）
- 新增持久化用户语言偏好设置，在「设置 → 外观」中提供「跟随 IDE」选项，语言选择在重启 IDE 后仍然生效（by @gadfly3173）
- 新增 gpt-5.4-mini 上下文限制（400K tokens）和模型专属定价（$0.75/$4.50/$0.075 per 1M tokens），避免成本高估
- 新增 Codex 会话线程过期错误模式，支持 11 种语言的双语提示

🐛 Fixes
- 修复 PreToolUseHook 绕过 settings.json 权限规则的问题：将所有非 Plan 模式路径统一返回 `continue`，由 SDK 原生评估 Deny/Allow/Ask 规则（by @devlimits）
- 修复 Plan 模式下 settings.json 权限规则不生效的问题；Plan 模式专属分支（ExitPlanMode、PLAN.md 编辑、Bash 限制）保持不变（by @devlimits）
- 修复 AI 自动生成的会话标题超过 50 字符导致重命名接口静默失败的问题；AI 标题现在直接更新本地历史列表，不再走重命名接口（by @devlimits）
- 修复 JCEF 降低优先级的绘制状态下（如定时唤醒工作流）流式更新无法渲染的问题；将流式批处理路径从 `requestAnimationFrame` 改为 `setTimeout(fn, 16)`（by @devlimits）
- 修复跨 Provider 加载历史会话时 Provider 信息丢失的问题（by @GlMelon）
- 修复用户主动中断请求被误判为错误并弹出错误 Toast 的问题；中断现在在 Bridge、Daemon 和流式适配器各层均作为正常完成处理（by @GlMelon）
- 修复流式传输结束后后端快照覆盖流式内容的问题；现在始终优先使用包含最新 delta 的流式内容（by @GlMelon）
- 修复助手消息中代码示例包含命令名 XML 标签时被错误过滤或渲染为斜线命令的问题（by @gadfly3173）
- 修复 Haiku 模型环境变量映射错误，从 `SMALL_FAST_MODEL` 改为正确的 `ANTHROPIC_DEFAULT_HAIKU_MODEL`（by @gadfly3173）
- 修复 ContextUsageDialog 中 autoCompactThreshold 百分比计算错误（by @gadfly3173）
- 修复 SlashCommandJsonReader 在 IntelliJ VFS 下路径规范化问题（by @gadfly3173）
- 修复 Claude 和 Codex 用量聚合不一致问题：修复缓存 Token 重复计算，并新增模型别名解析（by @yadue）
- 修复配置文件中 UTF-8 BOM 导致解析失败的问题；多实例启动时保留 ai-bridge 缓存目录（by @CoderDream）
- 修复 Plan 模式 UI 控件问题：Codex 模式下 `/plan` 命令改为以普通文本发送而非弹出警告 Toast；「(1M context)」后缀仅在 Claude Provider 下显示（by @gadfly3173）
- 修复在小屏幕上斜体字体影响可读性的问题，移除模型/模式选择器、Mermaid 占位符及提示文字的 italic 样式
- 修复 Claude 历史回退扫描路径将最后一条消息时间戳同时赋给 firstTimestamp 和 lastTimestamp 的问题，现在分别独立追踪
- 修复 Windows 上 Codex 完成后 taskkill 解析噪声输出问题（by @lrk1314）
- 修复 webview package-lock.json 包含私有 npm 镜像地址的问题，固定使用 registry.npmjs.org 官方源
- 修复 MarkdownBlock catch 回退路径中的 XSS 漏洞：对原始内容进行转义，而非直接传入 dangerouslySetInnerHTML（安全）
- 修复 API Key 和 Token 在错误消息中泄漏的问题：在显示到 UI 和 Java 日志前，脱敏 Anthropic/OpenAI 密钥、Bearer Token、Authorization 头及 GitHub PAT（安全）
- 修复 EnvironmentConfigurator 启动 shell 时未限制可执行文件范围的问题，现在通过白名单限制，防止被篡改的 `$SHELL` 指向任意二进制（安全）

🔧 Improvements
- 提取 `UserMessageSanitizer` 工具类，用于在历史回放时从用户消息中剥离系统上下文标签和追加的 IDE 上下文（by @GlMelon）
- 移除 settings.json 权限修复后遗留的废弃 helper（`shouldAutoApproveTool`、`shouldAcceptEditsTool`、`ACCEPT_EDITS_AUTO_APPROVE_TOOLS`）（by @devlimits）
- 改进文件链接提示实现：将逻辑提取到 `useMarkdownFileLinkTooltip` Hook，样式移至 CSS，使用 DOM `getBoundingClientRect()` 精确定位，并新增 LRU 缓存（最多 200 条），防止长会话内存增长（by @ywz626）
- 新增 GitHub Issue 模板，包含结构化必填字段、中英双语标签和自动标签规则，减少重复 Issue
- 重构 `ContextUsageDialog`：提取通用 `DetailsTable` 子组件，整合 MCP/子代理/记忆/技能四张近乎相同的表格
- 统一各 Bridge 组件中 WSL 感知的 Node 命令构建逻辑，统一使用 `NodeDetector.buildNodeScriptCommand()` helper
- 新增 `-PskipWebview=true` Gradle 属性，在纯后端迭代时跳过 Webview 构建

---

##### **2026年5月8日（v0.4.2）**

English:

✨ Features
- Add task completion toast notification, disabled by default and opt-in via Settings → Basic → Behavior; the toast shows the session title with the latest assistant answer preview (by @adminkk)
- Add "Copy AI Reference" action to the editor right-click menu for sending selected code with file path and line range context (by @JackCmd233)
- Add multi-project workspace context collection for IntelliJ workspace mode, giving AI providers awareness of subproject structure (by @gadfly3173)
- Add AI-powered session title generation using Claude Haiku after the first query completes, with a Settings → Basic → Behavior toggle (by @gadfly3173)
- Insert code snippet at the current caret position instead of always appending to the end when using "Copy AI Reference" or editor send actions
- Show execution results and permission-denial state in tool blocks for better observability
- Show the active provider name dynamically in the "AI provider connected" banner (e.g. "Codex connected" instead of always "Claude connected")

🐛 Fixes
- Fix Codex message handler causing duplicate assistant messages in new sessions and during history recovery (by @GlMelon)
- Fix batch deletion of session history causing SessionIndexManager index corruption (by @GlMelon)
- Fix Codex thinking process not being restored after provider switch (by @GlMelon)
- Fix historical record duplication and internal command message leakage (by @GlMelon)
- Fix deprecated API calls in OpenFileHandler (by @GlMelon)
- Fix editor popup action icons missing after icon refactoring (by @JackCmd233)
- Fix selection reference range formatting in the Copy AI Reference action (by @JackCmd233)
- Fix multi-instance startup causing two IDE processes to delete each other's ai-bridge extraction files (by @zxc1213)
- Fix MCP server config from ~/.claude.json not being passed to the Claude Agent SDK (by @RunfengLin815)
- Fix task completion toast showing pre-tool-call prose; now displays the final answer text from the last text block (by @gadfly3173)
- Fix drag-sort in JCEF: ensure drop event fires reliably and set correct dropEffect for move
- Fix session title listener to support multiple ChatWindow subscribers via CopyOnWriteArrayList, preventing silent event drops
- Fix sessionId input validation against path-traversal payloads in history deletion endpoints
- Fix event listener memory leaks in webview: properly clean up visibilitychange, focus, and pageshow listeners on unload
- Fix content-visibility placeholder size mismatch that caused tool-call cards to appear "stuck" mid-screen during streaming until manual scroll
- Fix streamed text being incorrectly repositioned when tool_use/tool_result blocks appeared mid-stream by switching from turn-based to boundary-based message patching
- Fix CLI Login mode mutating ~/.claude/settings.json by removing user API keys; CLI Login state is now read from plugin-owned config and the daemon is restarted on provider switch to apply the new auth mode reliably

🔧 Improvements
- Replace single-element array concurrency workaround with AtomicBoolean/AtomicReference throughout the SDK bridge layer
- Unify all editor action icons to use cc-gui-icon for a consistent visual identity
- Improve attachment handling and model resolution in ai-bridge with vision model detection
- Extract loadMcpServersConfigAsRecord helper to prevent empty MCP config from leaking into SDK options
- Remove brand icon from task completion toast for a simpler, lighter notification layout
- Improve drag-sort external drop detection to distinguish file drops from UI reorder drags; add pointer handling and touch-action CSS
- Memoize SubagentList, FileChangesList, and HistoryView list items to reduce re-renders by ~50%
- Optimize long-session rendering: switch to auto-sizing content-visibility with per-type size hints and 30-message pagination
- Eliminate 110+ unsafe `(window as any)` casts with proper TypeScript Window interface extensions and JSDoc annotations
- Extract repeated inline style objects to named module-level constants across multiple components
- Split the oversized App component into focused modules with dedicated context providers (DialogContext, SessionContext, UIStateContext, MessagesContext) and a new ChatScreen container
- Split the 400+ line useModelProviderState hook into four single-responsibility hooks (useClaudeProvider, useCodexProvider, useModelStatePersistence, useProviderSettings) for clearer state ownership
- Refactor Java bridge, webview, and ai-bridge: split oversized classes into focused single-responsibility components
- Enable Checkstyle NeedBraces rule and wrap 197 pre-existing single-line if/else bodies across 44 Java files in braces to guard against goto-fail-style edits
- Tighten Checkstyle configuration: enforce newline at end of file, line length limits, reorganize rule sections, and remove unused imports

中文：

✨ Features
- 新增任务完成 Toast 通知，默认关闭，可在「设置 → 基础 → 行为」中开启；Toast 展示会话标题与最新助手回答预览（by @adminkk）
- 在编辑器右键菜单新增「Copy AI Reference」操作，可将选中代码连同文件路径和行号范围一并发送给 AI（by @JackCmd233）
- 新增 IntelliJ 工作区（Workspace）模式下的多项目上下文收集，让 AI 感知子项目结构（by @gadfly3173）
- 新增 AI 会话标题自动生成功能，首次对话结束后使用 Claude Haiku 生成语义化标题，并在「设置 → 基础 → 行为」中提供开关（by @gadfly3173）
- 使用「Copy AI Reference」或编辑器发送操作时，代码片段插入到当前光标位置，不再始终追加到末尾
- 工具调用块新增执行结果展示，并跟踪权限拒绝状态，便于调试和观察
- AI 连接提示横幅改为动态显示当前 Provider 名称（例如切换至 Codex 时显示「Codex connected」）

🐛 Fixes
- 修复 Codex 消息处理器导致新建会话和历史恢复时出现重复助手消息的问题（by @GlMelon）
- 修复批量删除会话历史记录导致 SessionIndexManager 索引损坏的问题（by @GlMelon）
- 修复切换 Provider 后 Codex 思考过程无法恢复的问题（by @GlMelon）
- 修复历史记录重复和内部命令消息泄漏问题（by @GlMelon）
- 修复 OpenFileHandler 中废弃 API 的调用（by @GlMelon）
- 修复图标重构后编辑器弹出菜单操作图标丢失的问题（by @JackCmd233）
- 修复「Copy AI Reference」中选区引用的行号范围格式错误（by @JackCmd233）
- 修复两个 IDE 实例同时启动时互相删除对方 ai-bridge 解压文件的问题（by @zxc1213）
- 修复 ~/.claude.json 中的 MCP Server 配置未传递给 Claude Agent SDK 的问题（by @RunfengLin815）
- 修复任务完成 Toast 显示工具调用前的中间文案问题，改为显示最后一个文本块中的最终回答（by @gadfly3173）
- 修复 JCEF 中拖拽排序问题：确保 drop 事件可靠触发并为移动操作设置正确的 dropEffect
- 修复会话标题监听器，改用 CopyOnWriteArrayList 支持多个 ChatWindow 订阅，防止事件静默丢失
- 修复历史删除接口中 sessionId 输入未校验、存在路径穿越风险的安全问题
- 修复 Webview 中事件监听器内存泄漏：visibilitychange、focus、pageshow 监听器现在在页面卸载时正确清理
- 修复流式输出时 content-visibility 占位高度估算偏差导致工具调用卡片"卡"在屏幕中部、需手动滚动才能恢复的问题
- 将消息打补丁逻辑从基于 turn 改为基于边界（boundary），修复工具卡片中途出现时流式文本错位的问题
- 修复 CLI Login 模式会修改 ~/.claude/settings.json 删除用户 API Key 的问题；CLI Login 状态改由插件自有配置维护，并在切换 Provider 时重启守护进程以可靠应用新认证模式

🔧 Improvements
- 将 SDK Bridge 层中的单元素数组并发变通方案替换为 AtomicBoolean/AtomicReference
- 统一所有编辑器操作图标为 cc-gui-icon，提供一致的视觉标识
- 改进 ai-bridge 中的附件处理和模型解析逻辑，新增视觉模型检测
- 提取 loadMcpServersConfigAsRecord 工具函数，避免空 MCP 配置被错误传入 SDK 选项
- 移除任务完成 Toast 中的品牌图标，布局更简洁轻量
- 改进拖拽排序的外部文件检测逻辑，区分文件拖入与 UI 排序操作，并补充 pointer 事件处理和 touch-action CSS
- 对 SubagentList、FileChangesList、HistoryView 列表项进行记忆化优化，减少约 50% 的不必要重渲染
- 优化长会话渲染：content-visibility 改为自动尺寸估算，并按消息类型提供尺寸提示，配合 30 条消息分页
- 消除 110+ 处不安全的 `(window as any)` 类型断言，改用正确的 TypeScript Window 接口扩展和 JSDoc 注解
- 将多个组件中的重复内联样式对象提取为模块级命名常量
- 拆分过大的 App 组件为多个聚焦模块，新增 DialogContext / SessionContext / UIStateContext / MessagesContext 上下文以及 ChatScreen 容器组件
- 将 400+ 行的 useModelProviderState Hook 拆分为四个单一职责 Hook（useClaudeProvider、useCodexProvider、useModelStatePersistence、useProviderSettings），状态归属更清晰
- 重构 Java Bridge、Webview 及 ai-bridge：拆分过大的类为单一职责的聚焦组件
- 启用 Checkstyle NeedBraces 规则，并在 44 个 Java 文件中为 197 处单行 if/else 补全花括号，防止未来编辑出现 goto-fail 式漏洞
- 收紧 Checkstyle 配置：强制文件末尾换行、行长度限制，重新组织规则分组，移除无用 import

---

##### **2026年5月6日（v0.4.1）**

English:

✨ Features
- Add runtime provider switcher: switch between providers without restarting the session
- Add multi-provider support for prompt enhancer with dedicated settings UI
- Add commit AI provider configuration in settings
- Add clickable file path and class name links in markdown content for quick navigation
- Add Xiaomi MiMo model icon support and update provider presets
- Show Agent (subagent) process details in task blocks
- Restore persisted Codex session history on startup
- Surface sponsor support and community recommendations in the community settings page
- Keep SDK version updates reachable from JCEF-based settings UI
- Add lightweight reusable session templates for creating pre-configured sessions

🐛 Fixes
- Fix startup crash on IDEs that lack the reworked terminal menu
- Fix scroll position jump caused by context propagation in the message list
- Fix scroll jump triggered by subagent status updates via context re-rendering
- Prevent replayed stream chunks from duplicating synced assistant output
- Suppress redundant [MESSAGE] events for streaming text-only assistant messages in ai-bridge
- Serve custom UI fonts via JCEF resource handler instead of base64 embedding, fixing font rendering on certain platforms

⚡ Performance
- Reduce chat rendering bundle overhead for faster initial load
- Make history cleanup safer and faster with improved session lifecycle handling

🔧 Improvements
- Unify Codex history normalization via HistoryMessage utility, removing duplicated conversion logic
- Preserve in-flight chat state across delayed sync to prevent message loss during rapid interactions
- Keep history usable when stored sessions disappear from disk instead of showing empty state
- Keep tool headers collapsed by default while preserving individual expansion state

中文：

✨ Features
- 新增运行时 Provider 切换器：无需重启会话即可在不同 Provider 间切换
- 新增增强提示词的多 Provider 支持，附带专属设置界面
- 新增设置中的提交 AI Provider 配置
- 新增 Markdown 内容中的可点击文件路径和类名链接，支持快速导航
- 新增小米 MiMo 模型图标支持并更新 Provider 预设
- 展示 Agent（子代理）进程详情信息
- 启动时恢复 Codex 持久化会话历史
- 在社区设置页面展示赞助商支持和社区推荐
- JCEF 设置界面中保持 SDK 版本更新入口可达
- 新增轻量级可重用会话模板，用于创建预配置会话

🐛 Fixes
- 修复缺少重构终端菜单的 IDE 上启动崩溃问题
- 修复消息列表中上下文传播导致的滚动位置跳动
- 修复子代理状态更新通过上下文重渲染触发的滚动跳动
- 防止重放的流式 chunk 导致已同步的助手消息重复
- 抑制 ai-bridge 中流式纯文本助手消息的冗余 [MESSAGE] 事件
- 通过 JCEF 资源处理器提供自定义 UI 字体（替代 base64 嵌入），修复特定平台字体渲染问题

⚡ Performance
- 减少聊天渲染 bundle 体积，加快初始加载速度
- 改进会话生命周期处理，使历史清理更安全、更快速

🔧 Improvements
- 通过 HistoryMessage 工具统一 Codex 历史规范化，消除重复的转换逻辑
- 在延迟同步期间保留进行中的聊天状态，防止快速交互时消息丢失
- 当磁盘上的存储会话消失时保持历史可用，避免显示空白状态
- 工具头部默认折叠，同时保留各条目独立的展开状态

---

##### **2026年4月24日（v0.4）**

English:

✨ Features
- Add console and Terminal selection sending: send selected Run/Debug console text or Terminal text directly into the chat input, with IntelliJ 2024.3+ terminal compatibility and localized action labels
- Add editor tab file-path sending: quickly send the current editor tab path to CC GUI from tab actions
- Add UI font configuration: configure chat/webview font family and size from settings, with IDE font fallback and persisted appearance preferences
- Improve history browsing: add session ID copy controls, file size display, and lite-read / mtime-driven incremental scanning for faster Claude and Codex session loading
- Update model options: add GPT-5.5 support, restore GPT-5.2 as a selectable option, and refine search-style tool expansion affordances

🐛 Fixes
- Fix streaming message duplication, content loss, and stream-end race conditions by hardening raw-block consistency, always forwarding assistant deltas, and coordinating `onStreamEnd` with message updates
- Fix XML tag rendering to match CLI behavior and handle structured MCP output correctly in Codex tool results
- Fix custom Node.js executable validation so invalid saved paths are rejected before bridge startup
- Fix history lite-read edge cases including batch indexing, thread safety, UUID normalization, and session index schema handling
- Fix build cache invalidation by declaring ai-bridge files as Gradle task inputs
- Fix provider model mapping persistence by constraining saved mapping fields to supported values

⚡ Performance
- Speed up session list loading with shared lite readers, indexed metadata, file mtime checks, and incremental refresh paths for Claude and Codex histories

🔧 Improvements
- Add regression coverage for console/terminal selection sending, streaming callbacks, raw block consistency, lite readers, font settings, provider mapping, and Node path validation
- Extract shared helpers for Codex JSON string handling, selection text normalization, JCEF browser font injection, and UI font resolution
- Refresh related i18n strings across supported locales for new actions, settings, history labels, and model/provider UI copy

中文：

✨ Features
- 新增控制台与 Terminal 选中文本发送能力：可将 Run/Debug 控制台或 Terminal 中的选中文本直接发送到聊天输入框，并兼容 IntelliJ 2024.3+ 新版 Terminal，同时补齐本地化动作文案
- 新增编辑器标签页发送文件路径动作：可从标签页操作中快速把当前文件路径发送到 CC GUI
- 新增 UI 字体配置：支持在设置中配置聊天/webview 字体族与字号，自动回退 IDE 字体并持久化外观偏好
- 优化历史记录浏览：新增会话 ID 复制、文件大小展示，以及基于 lite-read 和 mtime 的增量扫描，加快 Claude 与 Codex 会话加载
- 更新模型选项：新增 GPT-5.5 支持，恢复 GPT-5.2 可选项，并优化搜索类工具的展开视觉表现

🐛 Fixes
- 修复流式消息重复、内容丢失和流结束竞态：强化 raw block 一致性，始终转发 assistant 增量，并协调 `onStreamEnd` 与消息更新时序
- 修复 XML 标签渲染与 CLI 行为不一致的问题，并正确处理 Codex 工具结果中的结构化 MCP 输出
- 修复自定义 Node.js 可执行文件校验，避免无效的已保存路径进入 bridge 启动流程
- 修复历史 lite-read 的批量索引、线程安全、UUID 规范化和会话索引 schema 边界问题
- 修复构建缓存失效问题，将 ai-bridge 文件声明为 Gradle 任务输入
- 修复 Provider 模型映射持久化，只保存受支持的映射字段值

⚡ Performance
- 通过共享 lite reader、索引元数据、文件 mtime 检查和增量刷新路径，加快 Claude 与 Codex 历史会话列表加载

🔧 Improvements
- 补充控制台/Terminal 选中文本发送、流式回调、raw block 一致性、lite reader、字体设置、Provider 映射和 Node 路径校验等回归测试
- 抽取 Codex JSON 字符串处理、选中文本规范化、JCEF 浏览器字体注入和 UI 字体解析等共享工具
- 更新新动作、设置项、历史标签以及模型/Provider UI 文案在多语言中的翻译

---

##### **2026年4月17日（v0.3.5）**

English:

✨ Features
- Simulate Claude CLI client identity in API requests: send CLI-style headers and environment to Claude SDK child processes, improve compatibility for local, managed, and direct Anthropic/Bedrock flows
- Upgrade Claude model catalog: add Claude Opus 4.7 and move Claude Sonnet 4.6 / Opus 4.6 / Opus 4.7 entries to 1M context windows, with backward-compatible legacy model ID normalization

🐛 Fixes
- Fix duplicated text and thinking blocks during streaming: stop forwarding deduplicated backend deltas, improve backend/frontend block merge logic, and add regression coverage for repeated-content cases
- Fix assistant messages from recently ended streams or restored history being merged into the wrong turn
- Fix model selection and provider state synchronization for legacy Claude model IDs, with updated tests around provider/model handling

🔧 Improvements
- Update build workflow and artifact handling for release packaging
- Refresh model labels, icons, and localized provider/model copy across all supported locales

中文：

✨ Features
- 新增 Claude CLI 客户端身份模拟：向 Claude SDK 子进程传递 CLI 风格的请求头和环境变量，提升本地配置、托管配置以及直连 Anthropic/Bedrock 场景下的兼容性
- 升级 Claude 模型目录：新增 Claude Opus 4.7，并将 Claude Sonnet 4.6 / Opus 4.6 / Opus 4.7 全部升级为 1M 上下文窗口，同时兼容旧版模型 ID

🐛 Fixes
- 修复流式输出时文本块和 thinking 块重复的问题：后端去重分支不再继续向前端转发重复增量，前后端同时加强 block 合并逻辑，并补充重复内容回归测试
- 修复刚结束的流式消息或恢复历史后的助手消息被错误合并到其他轮次的问题
- 修复旧版 Claude 模型 ID 下的模型选择与 Provider 状态同步问题，并补充相关测试

🔧 Improvements
- 升级构建工作流与产物处理流程，改进发布打包稳定性
- 更新所有支持语言中的模型名称、图标和 Provider/Model 相关文案

---

##### **2026年4月9日（v0.3.4）**

English:

✨ Features
- Add bundled Claude CLI slash commands to the registry (`/batch`, `/claude-api`, `/debug`, `/loop`, `/simplify`, `/update-config`) and unify local command handling across new-session, resume, and plan flows
- Add Brazilian Portuguese (`pt-BR`) locale and update related translations
- Show response duration beneath completed assistant messages, with updated localized labels across all supported locales

🐛 Fixes
- Fix WebView freezing on `Ctrl+C` by moving clipboard read/write off the CEF browser thread
- Align permission mode hooks and tool approval behavior with Claude CLI: enforce plan-mode approvals correctly, auto-approve Agent/Task in plan mode, allow `PLAN.md` edits, and tighten MultiEdit/path validation
- Fix duplicate text and thinking blocks during streaming merge by deduplicating cumulative snapshots on both backend and frontend, with added unit tests
- Fix chat text size inconsistency by reusing the editor font size variable
- Fix copy button visibility for tool-only assistant messages and merge assistant messages correctly across `tool_result`-only boundaries

🔧 Improvements
- Make the response duration label more conversational across all locales

中文：

✨ Features
- 新增 Claude CLI 内置斜杠命令注册：支持 `/batch`、`/claude-api`、`/debug`、`/loop`、`/simplify`、`/update-config`，并统一新会话、恢复会话与计划模式下的本地命令处理逻辑
- 新增巴西葡萄牙语（`pt-BR`）界面语言，并补充相关翻译
- 在已完成的助手消息下方显示响应耗时，并同步更新所有支持语言中的本地化文案

🐛 Fixes
- 修复 `Ctrl+C` 复制时 WebView 卡顿的问题：将剪贴板读写移出 CEF 浏览器线程
- 修复权限模式和工具审批行为与 Claude CLI 不一致的问题：正确执行计划模式审批、在计划模式下自动批准 Agent/Task、允许编辑 `PLAN.md`，并加强 MultiEdit 与路径校验
- 修复流式合并过程中重复出现文本块和 thinking 块的问题：在前后端同时对累积快照做去重，并补充单元测试
- 修复聊天文本字号与编辑器不一致的问题，改为复用编辑器字体大小变量
- 修复仅包含工具调用的助手消息仍显示复制按钮的问题，并正确跨 `tool_result` 边界合并连续的助手消息

🔧 Improvements
- 优化所有语言中的响应耗时文案，使表达更自然、更口语化

---

##### **2026年4月1日（v0.3.3）**

English:

✨ Features
- Add SDK version selector with remote/fallback version lists, version comparison, and rollback warnings; add unit tests for versioning and provider management
- Add Codex CLI Login virtual provider: reads ~/.codex/config.toml and auth.json with explicit user authorization; gate Codex MCP server access behind local config authorization; add i18n translations for all 9 locales
- Add EditToolBlock with LCS-based diff display, line number navigation, and click-to-jump; add EditToolGroupBlock for batch edit display with scrollable list; integrate IDEA file open/refresh/diff actions
- Add diff theme system with 4 modes (follow IDE / editor / light / soft-dark) and compact dropdown selector
- Add MCP tool name and input normalization for edit_file/write_file tools
- Add streaming heartbeat (10s) to prevent false stall detection during tool execution; add sequence numbers to discard stale updateMessages snapshots
- Add settings toggles for AI commit message generation and status bar widget visibility, persisted with restart-required toast
- Enhance Codex mode task plan and sub-agent display; fix duplicate tool call rendering
- Add pre-React callback buffering for early window bridge messages; persist tab session state across IDE restarts
- Add preserveLatestMessagesOnShrink for Codex conversation compaction

🐛 Fixes
- Fix stream reliability for long sessions: adaptive JCEF throttling (500ms–5s interval based on payload size), 45s stream stall watchdog that auto-fires onStreamEnd when JCEF silently drops the signal, debounce scroll-to-bottom with rAF
- Fix watchdog incorrectly reloading webview during active streaming: extend heartbeat timeout to 3 minutes during streaming; replay onStreamStart to frontend after reload; add 15s safety timeout for session transition guard
- Fix stale rAF updateMessages overwriting final state after stream ends: add cancellation mechanism and strip __turnId from streaming messages
- Fix assistant messages from different streaming turns being incorrectly merged: reorder merge/filter pipeline to keep turns separated by hidden boundary messages
- Fix Codex session ID mismatch: use UUID from session_meta.id as canonical ID; fix filename matching from startsWith to contains for UUID-embedded filenames; strip system XML tags from user messages before title extraction
- Fix Codex history file too large causing messages not to display in real time after restoring history #kyon777
- Fix ChatInputBox dropdown crashing when icon values are not strings; safely handle inline SVG icons for @ file/folder completions #gadfly3173 (#820)
- Fix tool window and detached session cleanup: ensure tabs own ClaudeChatWindow disposal; route tool-window UI through ToolWindowManager; add project-scoped cleanup for detached sessions #gadfly3173 (#795)
- Fix hardcoded diff colors in EditToolGroupBlock to use CSS variables
- Hide transient internal tool names after streaming completes

⚡ Performance
- Coalesce updateMessages via rAF in frontend to avoid parsing large JSON payloads on every 50ms push, eliminating the "fake freeze" symptom for long sessions
- Adaptive JCEF throttling in StreamMessageCoalescer: scale update interval based on payload size to prevent IPC saturation

🔧 Improvements
- Extract tool name/input normalization and invocation tracking from codex-event-handler into dedicated codex-tool-normalization.js module
- Refactor diff theme selector from card-style buttons to compact dropdown; move section after editor font for better layout flow; fix diff row background not filling full width
- Replace Swing JFileChooser with IntelliJ FileChooser API for skill file selection, with project base path as initial directory
- Extract shared normalizeTodoStatus/RawTodoItem into todoShared.ts; tighten codex-event-handler isError detection to avoid false positives
- Security: add semver pattern validation in DependencyManager to prevent npm install argument injection; strip exception details from user-facing error messages; use injected settingsService in ProjectConfigHandler to avoid resource leaks; add Javadoc security note to CodexSettingsManager clarifying JWT payload is decoded without signature verification

中文：

✨ Features
- 新增 SDK 版本选择器：支持远程/本地回退版本列表、版本对比和回滚警告，新增版本管理和 Provider 单元测试
- 新增 Codex CLI Login 虚拟 Provider：读取 ~/.codex/config.toml 和 auth.json，需用户明确授权；Codex MCP 服务器访问受本地配置授权限制；更新 9 种语言国际化翻译
- 新增 EditToolBlock：基于 LCS 算法展示差异、支持行号显示和点击跳转；新增 EditToolGroupBlock 批量编辑展示（可滚动列表）；集成 IDEA 文件打开/刷新/差异对比功能
- 新增 Diff 主题系统：4 种模式（跟随 IDE / 编辑器 / 浅色 / 柔和深色），选择器改为紧凑下拉框
- 新增 MCP 工具名称和输入规范化（支持 edit_file/write_file）
- 新增流式心跳（10s）防止工具执行期间误判流卡死；新增序列号机制丢弃过期的 updateMessages 快照
- 新增 AI 提交消息生成和状态栏 Widget 显示的设置开关，重启后生效
- 增强 Codex 模式任务计划与子代理展示，修复工具调用重复渲染
- 新增 React 初始化前的回调缓冲机制，防止早期窗口桥接消息丢失；跨 IDE 重启持久化 Tab 会话状态
- 新增 Codex 对话压缩时保留最新消息（preserveLatestMessagesOnShrink）

🐛 Fixes
- 修复长会话流式可靠性及 UI 卡顿：StreamMessageCoalescer 自适应 JCEF 节流（500ms–5s 动态调整），新增 45s Stream Watchdog（JCEF 静默丢失信号时自动触发 onStreamEnd），使用 rAF 防抖 scroll-to-bottom
- 修复流式传输期间看门狗误判并重载 WebView：流式过程中心跳超时延长至 3 分钟；WebView 重载后重放 onStreamStart 恢复状态；会话切换守卫添加 15s 安全超时防止永久阻塞
- 修复流结束后 rAF updateMessages 过期快照覆盖最终状态：新增取消机制，从流式消息中去除 __turnId
- 修复不同流式轮次的助手消息被错误合并：重排合并/过滤管道，以隐藏边界消息正确隔离轮次
- 修复 Codex 会话 ID 不匹配：使用 session_meta.id 的 UUID 作为标准会话 ID；文件名匹配从 startsWith 改为 contains 以支持 UUID 内嵌文件名；标题提取前去除系统 XML 标签
- 修复 Codex 历史文件过大导致恢复历史后继续对话时消息不实时显示 #kyon777
- 修复 ChatInputBox 下拉列表在图标值非字符串时崩溃，安全处理 @ 文件/文件夹补全的 SVG 图标 #gadfly3173 (#820)
- 修复工具窗口和分离会话资源泄漏：确保 Tab 持有 ClaudeChatWindow 销毁权，通过 ToolWindowManager 路由 UI 操作，项目关闭时清理分离会话 #gadfly3173 (#795)
- 修复 EditToolGroupBlock 中硬编码差异颜色，改为 CSS 变量
- 流式传输结束后隐藏内部工具名称

⚡ Performance
- 前端通过 rAF 合并 updateMessages 调用，避免每 50ms 解析大型 JSON 负载，消除长会话"假卡死"现象
- StreamMessageCoalescer 自适应 JCEF 节流：根据负载大小动态调整更新间隔，防止 IPC 饱和

🔧 Improvements
- 从 codex-event-handler 提取工具名称/输入规范化及调用跟踪到独立的 codex-tool-normalization.js 模块
- 重构 Diff 主题选择器：卡片式按钮改为紧凑下拉框；调整布局位置至编辑器字体选项之后；修复差异行背景不充满全宽的问题
- 技能文件选择改用 IntelliJ FileChooser API，以项目根目录为初始路径，替换 Swing JFileChooser
- 提取共享的 normalizeTodoStatus/RawTodoItem 到 todoShared.ts；收紧 codex-event-handler isError 检测，避免误报
- 安全加固：DependencyManager 新增 semver 格式校验防止 npm install 参数注入；用户侧错误消息去除异常堆栈详情；ProjectConfigHandler 改用注入的 settingsService 避免资源泄漏；为 CodexSettingsManager 添加 Javadoc 安全说明（JWT payload 仅解码不验签，不可用于授权决策）

---

##### **2026年3月25日（v0.3.2）**

English:

✨ Features
- Add provider runtime state detection: introduce getClaudeRuntimeState() to determine access mode (managed/local/cli_login/inactive); limit proxy/TLS env injection to local and cli_login modes only; track and clear injected env vars on each setupApiKey() call to prevent stale value leaks
- Rename ANTHROPIC_DEFAULT_HAIKU_MODEL → ANTHROPIC_SMALL_FAST_MODEL across provider presets, ProviderDialog, types and model state hooks; keep legacy key in CLAUDE_MODEL_MAPPING_ENV_KEYS for backward compatibility

🐛 Fixes
- Fix provider model mapping section always hidden: set showModelMappingSection to always true; return CUSTOM_PROXY_PRESET_ID for unrecognized proxy endpoints to keep model mapping enabled for third-party configurations
- Fix terminal monitor EDT threading and lifecycle leaks: avoid blocking widget discovery on EDT, bind monitor listeners to project and widget lifecycles to prevent leaks across disposal and multi-project usage #gadfly3173 (#774)
- Fix scrollbar cursor showing I-beam instead of arrow: move cursor:text from .messages-container to .markdown-content; retain I-beam on code content via targeted rules on pre/code #jhaan83 (#767)
- Fix session index corruption from invalid Unicode titles: prevent malformed session index writes when title contains invalid Unicode characters #gadfly3173 (#769)
- Fix permission watcher thread not stopping promptly on disposal: interrupt watcher thread on stop and handle InterruptedException for clean shutdown (#781)

⚡ Performance
- Optimize streaming and UUID sync: add StreamDeltaThrottler to batch rapid stream deltas before forwarding to webview; replace full session history load with getLatestUserMessage for UUID sync; add patchMessageUuid webview callback for targeted UUID patching; add active request tracking in DaemonBridge with extended heartbeat timeout

🔧 Improvements
- Add unit tests for StreamDeltaThrottler, DaemonBridge, and MessageJsonConverter
- Remove unused CursorHandler
- Update action icons with unified cc-gui-icon.svg for SendSelection, QuickFix, and SendFilePath actions; redesign cc-gui-icon.svg with new visual style
- Rename "Send to CCG" to "Send File Path to CC GUI" across all 9 languages; rename CCG → CC GUI in all i18n message strings

中文：

✨ Features
- 新增 Provider 运行时状态检测：引入 getClaudeRuntimeState() 判断访问模式（managed/local/cli_login/inactive），仅在 local 和 cli_login 模式下注入代理/TLS 环境变量，每次 setupApiKey() 调用时清除已注入变量防止旧值泄漏
- 重命名 ANTHROPIC_DEFAULT_HAIKU_MODEL → ANTHROPIC_SMALL_FAST_MODEL，覆盖 Provider 预设、ProviderDialog、类型和模型状态 hooks；在 CLAUDE_MODEL_MAPPING_ENV_KEYS 中保留旧 key 以兼容旧版

🐛 Fixes
- 修复 Provider 模型映射区域始终隐藏：强制 showModelMappingSection 为 true；对无法识别的代理端点返回 CUSTOM_PROXY_PRESET_ID，确保第三方代理配置下模型映射保持启用
- 修复终端监控器 EDT 线程问题及生命周期泄漏：避免在 EDT 上阻塞 Widget 发现，将监控器监听器绑定至项目和 Widget 生命周期，防止多项目场景下的内存泄漏 #gadfly3173 (#774)
- 修复滚动条光标显示为输入光标而非箭头：将 cursor:text 从 .messages-container 移至 .markdown-content，仅通过 pre/code 选择器在代码内容上保留输入光标 #jhaan83 (#767)
- 修复会话索引因无效 Unicode 标题导致写入损坏：防止标题含无效 Unicode 字符时产生格式错误的会话索引写入 #gadfly3173 (#769)
- 修复权限监视器线程在销毁时无法及时停止：停止时中断监视器线程并处理 InterruptedException，确保干净关闭 (#781)

⚡ Performance
- 优化流式传输和 UUID 同步：新增 StreamDeltaThrottler 批处理快速流增量后再转发至 webview；使用 getLatestUserMessage 替代全量历史加载进行 UUID 同步；新增 patchMessageUuid webview 回调实现精确 UUID 修补；DaemonBridge 新增活跃请求跟踪并延长心跳超时

🔧 Improvements
- 新增 StreamDeltaThrottler、DaemonBridge、MessageJsonConverter 单元测试
- 移除未使用的 CursorHandler
- 统一使用新版 cc-gui-icon.svg 更新 SendSelection、QuickFix、SendFilePath 操作图标；重新设计 cc-gui-icon.svg 视觉风格
- 将"Send to CCG"重命名为"Send File Path to CC GUI"，9 种语言全部更新；将 i18n 消息字符串中 CCG 统一重命名为 CC GUI

---

##### **2026年3月23日（v0.3.1）**

English:

✨ Features
- Add CLI Login provider: delegate authentication to Claude SDK's native OAuth flow, with account info display and authorize/revoke dialogs in ProviderList; update i18n across 9 languages
- Add provider deactivation support: deactivateClaudeProvider() sets current provider to empty string, add confirmation dialogs for switching to/from local provider, simplify settings UI by integrating provider info into ProviderList
- Add Korean language support #KimTibber

🐛 Fixes
- Fix UI stuck in responding/thinking state: resolve multiple race conditions in DaemonBridge, ClaudeMessageHandler, StreamMessageCoalescer, and streamingCallbacks.ts that left the frontend permanently stuck after stream completion or error
- Fix race condition where last streaming assistant message is lost: move ref cleanup into setMessages updater body in onStreamEnd, add fallback recovery path via message-level markers #gadfly3173
- Fix JCEF WebView showing incorrect cursor types on macOS: add CefDisplayHandler to map Chromium cursor changes to Swing cursors (#753) #yogendrasinghx
- Fix Codex history initial load returning fewer sessions than refresh: replace unreliable root-dir timestamp check with file-count comparison #gadfly3173
- Fix MSYS2/Git Bash path conversion: handle ~, /home/\<user\>, /tmp, /dev/null mappings; consolidate temp directory resolution into PlatformUtils.getTempDirectory() #gadfly3173
- Fix node path validation regression: reject invalid saved node paths and keep bridge state in sync #gadfly3173
- Fix plugin installation and UI interaction reliability: support versioned plugin directories, prevent thinking block expansion state being overridden, enqueue dialog requests to avoid losing follow-ups #hpstream
- Rename "Auto Open File" label to "Send Opened File Path" across all 8 locales to accurately describe behavior (#693) #gadfly3173

🔧 Improvements
- Large-scale backend refactoring: split ClaudeSDKBridge (1600+ lines) into 12 focused classes, DiffHandler into 7 modules, ClaudeSession into SessionContextService/SessionProviderRouter/SessionSendService/SessionCallbackFacade/SessionMessageOrchestrator, PermissionService into dedicated modules, SlashCommandRegistry into 6 focused classes with unit tests, PersistentQueryService and ChatInputBox hooks into focused modules, CodexHistoryReader into 4 focused modules
- Reorganize Java package structure by domain: action/dev, action/editor, action/tab, action/vcs, ui/detached, ui/toolwindow, i18n, permission, session, settings, skill
- Reorganize handler classes into domain subpackages: handler/core, handler/file, handler/history, handler/provider
- Normalize model resolution and env config handling: keep canonical model ID in Java session state, add normalizeProviderEnvForSave/sanitizeProviderJsonConfig helpers, add unit tests
- Extract CursorHandler and throttle mousemove listener with requestAnimationFrame
- Translate Chinese comments and JSDoc to English across 14 files for international collaboration
- Rename plugin ID and project name to idea-claude-code-gui; update build.gradle, plugin.xml, and settings.gradle

中文：

✨ Features
- 新增 CLI Login Provider：通过 Claude SDK 原生 OAuth 流程完成认证，ProviderList 显示账户信息及授权/撤销对话框，更新 9 种语言 i18n
- 新增 Provider 停用支持：deactivateClaudeProvider() 将当前 Provider 置为空字符串，切换本地 Provider 时显示确认对话框，将 Provider 信息集成至 ProviderList 简化设置界面
- 新增韩语支持 #KimTibber

🐛 Fixes
- 修复 UI 卡在"响应中/思考中"状态：修复 DaemonBridge、ClaudeMessageHandler、StreamMessageCoalescer 及 streamingCallbacks.ts 中多处竞态条件，防止流结束或报错后前端永久卡死
- 修复流结束时最后一条助手消息丢失的竞态问题：将 ref 清理移至 setMessages updater 内，添加基于消息级别标记的兜底恢复路径 #gadfly3173
- 修复 JCEF WebView 在 macOS 上光标类型不正确：新增 CefDisplayHandler 将 Chromium 光标变化映射为 Swing 光标 (#753) #yogendrasinghx
- 修复 Codex 历史记录首次加载比刷新少会话：将不可靠的根目录时间戳检查改为文件数量比较 #gadfly3173
- 修复 MSYS2/Git Bash 路径转换：处理 ~、/home/\<user\>、/tmp、/dev/null 映射；将临时目录解析统一至 PlatformUtils.getTempDirectory() #gadfly3173
- 修复 Node 路径验证回归：拒绝保存无效路径并同步 Bridge 状态 #gadfly3173
- 修复插件安装和 UI 交互可靠性：支持带版本号的插件目录、防止 thinking block 展开状态被覆盖、将对话框请求入队避免丢失 #hpstream
- 将"Auto Open File"标签重命名为"Send Opened File Path"，8 种语言全部更新，准确描述功能行为 (#693) #gadfly3173

🔧 Improvements
- 大规模后端重构：ClaudeSDKBridge（1600+ 行）拆分为 12 个聚焦类、DiffHandler 拆分为 7 个模块、ClaudeSession 拆分为 SessionContextService/SessionProviderRouter/SessionSendService/SessionCallbackFacade/SessionMessageOrchestrator、PermissionService 拆分为独立模块、SlashCommandRegistry 拆分为 6 个聚焦类并附单元测试、PersistentQueryService 和 ChatInputBox 拆分为聚焦 hooks、CodexHistoryReader 拆分为 4 个聚焦模块
- 按领域重组 Java 包结构：action/dev、action/editor、action/tab、action/vcs、ui/detached、ui/toolwindow、i18n、permission、session、settings、skill
- 将 handler 类重组为领域子包：handler/core、handler/file、handler/history、handler/provider
- 规范化模型解析和环境变量配置：Java 侧保留规范 model ID，新增 normalizeProviderEnvForSave/sanitizeProviderJsonConfig 辅助函数，补充单元测试
- 提取 CursorHandler，并使用 requestAnimationFrame 节流 mousemove 监听
- 将 14 个文件中的中文注释和 JSDoc 统一翻译为英文，提升国际协作体验
- 重命名插件 ID 和项目名称为 idea-claude-code-gui，同步更新 build.gradle、plugin.xml 和 settings.gradle

---

##### **2026年3月16日（v0.3）**

English:

✨ Features
- Add file context placeholder with enable confirmation popover in ContextBar: when autoOpenFile is disabled, show a dashed placeholder button; clicking it displays a confirmation popover to re-enable file context tracking, with i18n support for 8 locales
- Replace raw error with friendly provider-not-configured card: show an amber-toned warning card with settings icon and "Go to Provider Settings" button when no API key is set, improving first-run experience

🐛 Fixes
- Fix active sessions being interrupted when a single request exceeds 30 minutes: add activeTurnCount tracking, runtime absolute lifetime cap (6 hours), and improved turn lifecycle safety (#672) #JackCmd233
- Fix token usage tracking in streaming multi-turn conversations: properly accumulate usage across turns instead of resetting, remove conflicting emission logic (#686)
- Fix CRLF/LF line ending mismatch in diff review on Windows: try LF↔CRLF conversion when exact match fails, extend dialogShower registration wait timeout (#687) #gadfly3173
- Fix session title data loss from race conditions: use atomic write (tmp + rename) for session titles, add ReentrantLock to serialize concurrent operations, preserve existing titles during full scan
- Fix Codex session transition guard on history restore: clear transition state when restoring session to unblock subsequent history message calls

🔧 Improvements
- Extract shared ProviderModelIcon component and modelIconMapping utility: support 19 model vendors (Qwen, DeepSeek, Kimi, Mistral, Meta, etc.) with pattern-based model ID to vendor icon resolution, replace duplicated ProviderIcon switch statements across 5 files
- Extract line-ending normalization helper findLineEndingVariant() to eliminate duplicated CRLF/LF conversion logic, add no-op fast path, extract magic numbers to named constants

中文：

✨ Features
- 上下文栏新增文件上下文占位符及启用确认弹窗：autoOpenFile 关闭时显示虚线占位按钮，点击后弹出确认窗口重新启用文件上下文跟踪，支持 8 种语言国际化
- 未配置 Provider 时显示友好提示卡片：用琥珀色警告卡片替代默认红色错误信息，包含设置图标和「前往 Provider 设置」按钮，优化首次使用体验

🐛 Fixes
- 修复单次请求超过 30 分钟时程序打断正在运行的会话：添加 activeTurnCount 跟踪、运行时绝对生命周期上限（6 小时）及改进的 turn 生命周期安全管理 (#672) #JackCmd233
- 修复流式多轮对话中 Token 用量统计错误：正确累积各 turn 用量而非重置，移除冲突的发射逻辑 (#686)
- 修复 Windows 上 Diff Review 因 CRLF/LF 换行符不匹配无法打开：精确匹配失败时尝试 LF↔CRLF 转换，延长 dialogShower 注册等待超时 (#687) #gadfly3173
- 修复会话标题因竞态条件丢失：使用原子写入（tmp + rename）保存会话标题，添加 ReentrantLock 序列化并发操作，全量扫描时保留已有标题
- 修复 Codex 会话恢复时 transition guard 阻塞：恢复会话状态时清除 transition 状态以解除后续 history message 调用阻塞

🔧 Improvements
- 提取共享 ProviderModelIcon 组件及 modelIconMapping 工具：支持 19 家模型厂商（Qwen、DeepSeek、Kimi、Mistral、Meta 等）基于 pattern 的模型 ID 到厂商图标解析，替换 5 个文件中重复的 ProviderIcon switch 语句
- 提取换行符规范化辅助函数 findLineEndingVariant()，消除重复的 CRLF/LF 转换逻辑，添加无操作快速路径，将魔数提取为命名常量

---

##### **2026年3月15日（v0.2.9）**

English:

✨ Features
- Rename project to CC GUI (originally Claude Code GUI) to mitigate trademark risks, update plugin ID and icons
- Change default Codex sandbox mode to danger-full-access to reduce friction for commands requiring broader permissions (e.g. adb, docker)
- Add GitHub repository section to community settings page with copy-to-clipboard URL support
- Default autoOpenFile to disabled (previously enabled by default)

🐛 Fixes
- Fix daemon zombie node processes consuming 100% CPU: add force-exit timeout, parent-process monitoring, and session idle cleanup (#634) #3499623985
- Fix streaming assistant placeholder being lost during updateMessages: add turn ID tracking to isolate streaming messages across Java snapshot races (#650)
- Fix Codex stdio MCP server status that stays on pending (#653) #pwang1984
- Fix default provider for first-time users: normalize provider ID with robust fallback (#639) #JackCmd233
- Fix model switch not taking effect: include model in runtime signature to invalidate cache (#638) #hpstream
- Fix cwd fallback when active file is outside project root: use projectPath as cwd (#636) #jhaan83
- Fix READ_ONLY tools permission: require confirmation in default mode, auto-approve in acceptEdits mode

🔧 Improvements
- Refactor ProviderHandler into ClaudeProviderOperations, CodexProviderOperations, ModelProviderHandler, NodePathHandler, PermissionModeHandler, ProviderImportExportSupport, and ProviderOrderingService
- Refactor SettingsHandler into InputHistoryHandler, ProjectConfigHandler, SoundSettingsHandler, and UsagePushService
- Refactor useWindowCallbacks into registerCallbacks sub-modules; extract settings hooks into useSettingsBasicActions, useSettingsPageState, useSettingsThemeSync
- Refactor FileHandler (849→304 lines), HistoryHandler (810→120 lines), ClaudeHistoryReader (1200→350 lines), App.tsx (1951→640 lines) into focused modules
- Extract Claude model mapping logic to claudeModelMapping utility module with tests (#639) #JackCmd233

中文：

✨ Features
- 项目重命名为 CC GUI（原 Claude Code GUI），规避商标风险，更新插件 ID 和图标
- 将 Codex 默认沙箱模式改为 danger-full-access，减少需要广泛权限的命令（如 adb、docker）的使用阻力
- 社区设置页新增 GitHub 开源地址区域，支持一键复制仓库 URL
- autoOpenFile 默认值改为关闭（之前默认开启）

🐛 Fixes
- 修复 daemon 僵尸进程导致 100% CPU 占用：添加强制退出超时、父进程监控和会话空闲清理 (#634) #3499623985
- 修复流式助手消息占位符在 updateMessages 时丢失：添加 turn ID 跟踪以隔离 Java 快照竞态中的流式消息 (#650)
- 修复 Codex stdio MCP 服务器状态持续 pending 问题 (#653) #pwang1984
- 修复首次用户默认 Provider：使用健壮的回退机制规范化 Provider ID (#639) #JackCmd233
- 修复切换模型不生效：将 model 纳入运行时签名以使缓存失效 (#638) #hpstream
- 修复活动文件位于项目根目录外时 cwd 回退错误：使用 projectPath 作为 cwd (#636) #jhaan83
- 修复 READ_ONLY 工具权限：默认模式下需确认，acceptEdits 模式下自动批准

🔧 Improvements
- 重构 ProviderHandler 为 ClaudeProviderOperations、CodexProviderOperations、ModelProviderHandler、NodePathHandler、PermissionModeHandler、ProviderImportExportSupport 和 ProviderOrderingService
- 重构 SettingsHandler 为 InputHistoryHandler、ProjectConfigHandler、SoundSettingsHandler 和 UsagePushService
- 重构 useWindowCallbacks 为 registerCallbacks 子模块；提取设置 hooks 为 useSettingsBasicActions、useSettingsPageState、useSettingsThemeSync
- 重构 FileHandler（849→304 行）、HistoryHandler（810→120 行）、ClaudeHistoryReader（1200→350 行）、App.tsx（1951→640 行）为聚焦模块
- 提取 Claude 模型映射逻辑到 claudeModelMapping 工具模块并添加测试 (#639) #JackCmd233

---

##### **2026年3月12日（v0.2.8）**

English:

🐛 Fixes
- Change registrant. npmmirror. com to registry. npmjs. org
- Change the remote images used to join WeChat groups on the settings page to local images
- Fix network env vars injection timing: inject proxy and TLS settings (HTTP_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED) before any HTTPS connection to fix corporate SSL-inspection proxy issues, add URL validation for proxy settings and security warning for disabled TLS verification

🔧 Improvements
- Refactor Claude message-service into focused submodules: split 2000+ line monolith into message-utils, message-permission, message-session-registry, message-sender, message-sender-anthropic, and message-rewind
- Refactor Codex message-service into focused submodules: split 1800+ line monolith into codex-agents-loader, codex-command-utils, codex-event-handler, codex-patch-parser, and codex-utils
- Refactor permission-handler into focused modules: extract permission-ipc (IPC message handling) and permission-safety (safety checks)
- Refactor UsageStatisticsSection into tab components: extract UsageOverviewTab, UsageModelsTab, UsageSessionsTab, UsageTimelineTab, and useUsageStatistics hook
- Refactor useInputHistory: extract pure storage functions to inputHistoryStorage.ts (no React dependency)
- Refactor fileIcons: extract icon maps to dedicated fileIconMaps.ts module

中文：

🐛 Fixes
- 将registry.npmmirror.com 修改为 registry.npmjs.org
- 将设置页面用于加入微信群的远程图片，改为本地图片
- 修复网络环境变量注入时机：在任何 HTTPS 连接之前注入代理和 TLS 设置（HTTP_PROXY、HTTPS_PROXY、NODE_EXTRA_CA_CERTS、NODE_TLS_REJECT_UNAUTHORIZED），修复企业 SSL 检查代理问题，新增代理 URL 验证和 TLS 验证禁用安全警告

🔧 Improvements
- 重构 Claude message-service 为聚焦子模块：将 2000+ 行单体文件拆分为 message-utils、message-permission、message-session-registry、message-sender、message-sender-anthropic 和 message-rewind
- 重构 Codex message-service 为聚焦子模块：将 1800+ 行单体文件拆分为 codex-agents-loader、codex-command-utils、codex-event-handler、codex-patch-parser 和 codex-utils
- 重构 permission-handler 为聚焦模块：提取 permission-ipc（IPC 消息处理）和 permission-safety（安全检查）
- 重构 UsageStatisticsSection 为 Tab 组件：提取 UsageOverviewTab、UsageModelsTab、UsageSessionsTab、UsageTimelineTab 和 useUsageStatistics hook
- 重构 useInputHistory：将纯存储函数提取到 inputHistoryStorage.ts（无 React 依赖）
- 重构 fileIcons：将图标映射提取到独立的 fileIconMaps.ts 模块

---

##### **2026年3月10日（v0.2.7）**

English:

✨ Features
- Project-level prompt storage: dual-scope prompt management (global + project), store project prompts in within project root for team sharing via Git, separate UI sections for global and project prompts with complete CRUD operations, import/export support for both scopes, chat autocomplete displays both scopes with labels ([Global]/[Project]) (#598) #hpstream
- Codex mode enhancements: support suggest (approval) mode, isolate permission approval for each conversation, separate Codex and Claude Code configuration UI, open agent configuration in Codex mode, adapt diff editor panel for Codex mode, fix MCP configuration page state (#571) #tonyshengbo
- Improve Codex tool rendering with smart classification and file navigation (#607) #gadfly3173
- Add AUTO_ALLOW_TOOLS category and improve plan mode permissions: auto-allow safe tools without user prompt (#609) #gadfly3173
- Add Agent tool alias for Task in plan mode (#615) #gadfly3173
- Add provider sorting functionality: drag-and-drop reorder for providers (#617) #fanchenggang
- Add apiKeyHelper support for enterprise authentication: detect managed-settings.json for enterprise API key configuration (#623) #bdelamarre
- Update Codex model list: add gpt-5.4 and remove gpt-5.2/gpt-5.3

🐛 Fixes
- Fix Codex stdio MCP server status that stays on pending: add handshake request for stdio MCP server (#499) #pwang1984
- Fix Windows sound path issue for completion notification (#553) #z231485
- Prepend configured Node.js path to ensure version priority over system default (#587) #gadfly3173
- Resolve session transition races, streaming stability, and error deduplication (#600) #gadfly3173
- Enhance SDK update and version handling: add --include=optional flag to npm install (#602) #gadfly3173
- Add runtime session epoch isolation to prevent ghost messages (#611) #gadfly3173
- Fix context menu cut function and enhance file tag handling (#625) #JackCmd233
- Enforce UTF-8 charset for all file I/O operations
- Replace experimental IntelliJ APIs with stable alternatives
- Harden Codex path resolution and improve sandbox defaults: add path traversal guard

🔧 Improvements
- Refactor PromptManager to AbstractPromptManager base class with template methods, GlobalPromptManager, ProjectPromptManager, and PromptManagerFactory (#598) #hpstream
- Extract shared provider sorting logic to reduce duplication
- Extract shared command tool names and improve parsing robustness
- Extract apiKeyHelper detection and add missing i18n keys
- Replace hardcoded VSCode variables with design tokens in dialogs
- Improve code quality with thread safety, defensive copying, and log cleanup

中文：

✨ Features
- 项目级别提示词存储：双作用域提示词管理（全局 + 项目），项目提示词存储在项目根目录的 文件中可通过 Git 团队共享，全局和项目提示词分区展示并支持完整的增删改查操作，两个作用域均支持导入/导出功能，聊天自动补全同时显示两种作用域并带标签区分（[全局]/[项目]）(#598) #hpstream
- Codex 模式增强：支持 suggest（审批）模式、会话级独立权限审批、拆分 Codex 和 Claude Code 配置界面、开放 Codex 模式下的智能体配置、适配 Codex 模式 diff 编辑面板、修复 MCP 配置页面状态 (#571) #tonyshengbo
- 改进 Codex 工具渲染：智能分类和文件导航 (#607) #gadfly3173
- 新增 AUTO_ALLOW_TOOLS 类别并改进 Plan 模式权限：安全工具免确认自动允许 (#609) #gadfly3173
- Plan 模式支持 Agent 工具作为 Task 的别名 (#615) #gadfly3173
- 新增 Provider 排序功能：支持拖拽排序 (#617) #fanchenggang
- 新增 apiKeyHelper 企业认证支持：检测 managed-settings.json 中的企业 API Key 配置 (#623) #bdelamarre
- 更新 Codex 模型列表：新增 gpt-5.4，移除 gpt-5.2/gpt-5.3

🐛 Fixes
- 修复 Codex stdio MCP 服务器状态持续 pending 问题：为 stdio MCP 服务器添加握手请求 (#499) #pwang1984
- 修复 Windows 平台设置完成语音路径问题 (#553) #z231485
- 修复配置的 Node.js 路径优先级：将用户配置路径前置以覆盖系统默认版本 (#587) #gadfly3173
- 修复会话切换竞态、流式稳定性和错误去重 (#600) #gadfly3173
- 增强 SDK 更新和版本处理：npm install 添加 --include=optional 参数 (#602) #gadfly3173
- 新增运行时会话 epoch 隔离以防止幽灵消息 (#611) #gadfly3173
- 修复上下文菜单剪切功能并增强文件标签处理 (#625) #JackCmd233
- 强制所有文件 I/O 操作使用 UTF-8 编码
- 替换实验性 IntelliJ API 为稳定替代方案
- 加固 Codex 路径解析并改进沙箱默认值：添加路径遍历防护

🔧 Improvements
- 重构 PromptManager 为 AbstractPromptManager 抽象基类，提供模板方法、GlobalPromptManager、ProjectPromptManager 和 PromptManagerFactory (#598) #hpstream
- 提取共享的 Provider 排序逻辑以减少重复代码
- 提取共享命令工具名称并改进解析健壮性
- 提取 apiKeyHelper 检测逻辑并补充缺失的 i18n 键
- 将对话框中硬编码的 VSCode 变量替换为设计令牌
- 改进代码质量：线程安全、防御性拷贝和日志清理

---

##### **2026年3月5日（v0.2.6）**

English:

✨ Features
- Support pasting clipboard images in chat input: convert clipboard image data to base64 PNG on Java side, dispatch to webview via CustomEvent and add as attachment
- Add subscription tutorial dialog for Claude and Codex providers: tabbed step-by-step instructions with code block copy functionality, i18n translations for 8 languages
- Align slash command scanning with CLI behavior: rename PluginSkillPath to PluginPath with type field, add plugin namespace prefixing for commands, recursive directory scanning with SKILL.md leaf node detection, marketplace manifest fallback (#579) #gadfly3173
- Add configurable "play sound only when IDE unfocused" setting: toggle under sound notification settings, defaults to disabled (#583) #PaulGiletich

🐛 Fixes
- Gate Write tool with permission check in plan mode: add Write to Edit/Bash permission check branch, remove Write/Edit/Bash from PLAN_MODE_ALLOWED_TOOLS, add findProjectByPath fallback and retry logic in tryDiffReview (#580) #gadfly3173
- Align token usage display with CLI behavior: reset per-turn token accumulator on message_start, emit final accumulated usage before STREAM_END marker, add onUsageUpdate callback chain, show token info in IDEA status bar widget (#578) #gadfly3173
- Fix token usage display in streaming and non-streaming modes: fix EDT thread violation in status bar widget, avoid duplicate updates, add monotonic increase check, unify JS bridge methods
- Offload MCP server I/O to background threads: run MCP handler via CompletableFuture.runAsync, add 5-second timeout to command availability check
- Harden plugin command scanning with depth limit and path safety: MAX_COMMAND_SCAN_DEPTH to prevent stack overflow, strengthen path traversal defense, deduplicate extracted paths
- Address code review issues for security, quality and consistency: GSON encoding for base64 in JS injection prevention, fix i18n condition checks, replace hardcoded color with theme variable
- Normalize sound config response format: include full config fields in all sound setting handler responses, replace inline style with CSS Module class

🔧 Improvements
- Refactor tool block collapse UI: all tools with params are now collapsible with chevron icon and CSS accordion animation (grid-template-rows transition)
- Improve theme and responsive support: add CSS variables for notice-box colors with dark/light theme support, responsive layout for usage tabs on narrow viewports
- Fix CSS class naming collision in usage stats (detail-item -> model-detail-item), change default date range from 30d to 7d

中文：

✨ Features
- 支持在聊天输入框粘贴剪贴板图片：Java 端将剪贴板图片数据转换为 base64 PNG，通过 CustomEvent 分发到 webview 并作为附件添加
- 新增 Claude 和 Codex 订阅教程对话框：分标签页的逐步操作说明，支持代码块复制功能，8 种语言国际化
- 对齐斜杠命令扫描与 CLI 行为：PluginSkillPath 重命名为 PluginPath 并增加类型字段，添加插件命名空间前缀，递归目录扫描支持 SKILL.md 叶节点检测，市场清单回退 (#579) #gadfly3173
- 新增 "仅在 IDE 失焦时播放提示音" 配置项：声音通知设置下的开关选项，默认关闭 (#583) #PaulGiletich

🐛 Fixes
- 修复 Plan 模式下 Write 工具权限检查：将 Write 加入 Edit/Bash 权限检查分支，从 PLAN_MODE_ALLOWED_TOOLS 中移除 Write/Edit/Bash，添加 findProjectByPath 回退和 tryDiffReview 重试逻辑 (#580) #gadfly3173
- 修复 Token 用量显示对齐 CLI 行为：message_start 时重置每轮累计器，STREAM_END 前发送最终累计用量，添加 onUsageUpdate 回调链，IDEA 状态栏显示 Token 信息 (#578) #gadfly3173
- 修复流式和非流式模式下 Token 用量显示：修复状态栏 Widget EDT 线程违规，避免重复更新，添加单调递增检查，统一 JS 桥接方法
- 将 MCP 服务器 I/O 操作移至后台线程：通过 CompletableFuture.runAsync 运行 MCP 处理器，命令可用性检查添加 5 秒超时
- 加固插件命令扫描安全：添加 MAX_COMMAND_SCAN_DEPTH 防止栈溢出，增强路径遍历防护，提取路径去重
- 修复代码审查中的安全、质量和一致性问题：GSON 编码 base64 防止 JS 注入，修复 i18n 条件检查，硬编码颜色替换为主题变量
- 规范化声音配置响应格式：所有声音设置处理器响应包含完整配置字段，内联样式替换为 CSS Module 类

🔧 Improvements
- 重构工具块折叠 UI：所有含参数的工具现在均可折叠，带有箭头图标和 CSS 手风琴动画（grid-template-rows 过渡）
- 改进主题和响应式支持：为 notice-box 颜色添加 CSS 变量并支持深色/浅色主题，窄视口下 usage tabs 响应式布局
- 修复使用统计中 CSS 类名冲突（detail-item -> model-detail-item），默认日期范围从 30 天改为 7 天

---

##### **2026年3月4日（v0.2.5）**

English:

✨ Features
- Tab detach to floating window: detach chat tabs into independent floating JFrame windows for multi-window parallel conversations across screens, with theme sync, close/reattach dialog, and project dispose guards (#564) #hpstream
- Register IDEA keyboard shortcuts for chat tool window: Ctrl+C/X/V/Enter actions scoped to CCG window, right-click context menu with copy/cut/paste/newline, clipboard read/write handler via JS bridge (#541) #gadfly3173
- Persist chat input attachments across view switches: save/restore images via localStorage when switching to history or settings views, 2MB size limit with quota error handling (#542) #hpstream
- Support agent tool type and improve task block UI: recognize agent tool calls alongside task, display actual tool name in header, add chevron expand/collapse icon
- Add SDK update functionality with uninstall-reinstall strategy: update_dependency handler, dedicated UI state and progress feedback, i18n translations for 8 locales
- Increase Codex maxTurns from 20 to 200 for long-running tasks

🐛 Fixes
- Accumulate streaming token usage from message_start and message_delta events: follow CLI's mergeUsage logic, emit real-time token counts during streaming, extract shared usage utilities (#559) #gadfly3173
- Preserve Node.js version cache when new IDEA window opens: prevent DependencyHandler from clearing cachedDetectionResult on path re-verification, add resolveNodeVersion fallback in SessionHandler (#562) #gadfly3173
- Support Ctrl+C/X/V in native input and textarea elements: add setRangeText branch for INPUT/TEXTAREA in ChatPasteAction, use selectionStart/selectionEnd for copy/cut in form fields (#560) #gadfly3173
- Defer JCEF browser creation to avoid service initialization conflict: delay createUIComponents via invokeLater to prevent ProxyMigrationService clash during class init (#569) #gadfly3173
- Replace type assertions with runtime type checks to prevent crashes: use typeof checks across tool block components and utility functions to handle MCP tools passing objects instead of strings (#567) #gadfly3173
- Prevent UI freeze when opening settings on macOS in Codex mode: convert NodeDetector to singleton with shared cache, offload handleGetNodePath/handleSetNodePath to background threads, add in-flight dedup for concurrent detection (#543) #gadfly3173
- Restore Claude slash-command skill discovery for plugin skills: multi-directory upward traversal, read installed_plugins.json for manifest resolution, context-aware ConditionalSkillFilter, source metadata in command descriptions (#551) #gadfly3173
- Harden skill discovery against path traversal and resource exhaustion: plugin ID validation, traversal depth limits, toRealPath() over normalize(), disable YAML alias expansion, JSON file size and glob complexity limits
- Resolve race condition in Node.js path caching during manual configuration
- Improve async robustness and fix stale closure in DependencySection: 30s detection timeout, Node.js binary name validation, CompletableFuture lazy-init tracking, .exceptionally() handlers on all async chains
- Harden WebView bridge security and improve context menu accessibility: JS function name regex validation, extended string escaping (tab/backspace/form-feed/NEL/script breakout), clipboard read rate limiting (200ms) and write size cap (10MB), ARIA roles and keyboard navigation
- Fix detached window feature issues: use project basePath as map key to prevent memory leak, pass chatWindow from actionPerformed to fix race condition, add disposed flag guard to prevent double dispose (#564)

🔧 Improvements
- Optimize SVG icon with CSS classes and simplified paths
- Stabilize attachment persistence callbacks with useCallback to prevent unnecessary re-renders
- Replace remote banner image with local asset

中文：

✨ Features
- Tab 分离到浮动窗口：将聊天标签页分离为独立浮动 JFrame 窗口，支持多窗口跨屏幕并行对话，包含主题同步、关闭/重新附加对话框和项目销毁守卫 (#564) #hpstream
- 注册 IDEA 键盘快捷键到聊天工具窗口：Ctrl+C/X/V/Enter 限定在 CCG 窗口范围，右键上下文菜单支持复制/剪切/粘贴/换行，通过 JS 桥接实现剪贴板读写 (#541) #gadfly3173
- 切换页面后保留输入框图片附件：通过 localStorage 保存/恢复附件数据，支持 2MB 大小限制和配额超限处理 (#542) #hpstream
- 支持 agent 工具类型并改进任务块 UI：识别 agent 工具调用，在标题中显示实际工具名，添加展开/折叠箭头图标
- 新增 SDK 更新功能（卸载后重装策略）：update_dependency 处理器，独立的 UI 状态和进度反馈，支持 8 种语言国际化
- 将 Codex maxTurns 从 20 提升到 200，支持长时间运行的任务

🐛 Fixes
- 修复流式 Token 用量累计：从 message_start 和 message_delta 事件中正确累计 Token，遵循 CLI 的 mergeUsage 逻辑，提取共享用量工具 (#559) #gadfly3173
- 修复新 IDEA 窗口打开时 Node.js 版本缓存丢失：防止 DependencyHandler 在路径重新验证时清除 cachedDetectionResult，SessionHandler 添加 resolveNodeVersion 回退 (#562) #gadfly3173
- 修复原生 input 和 textarea 元素中 Ctrl+C/X/V 不工作：ChatPasteAction 添加 setRangeText 分支，复制/剪切使用 selectionStart/selectionEnd (#560) #gadfly3173
- 修复 JCEF 浏览器创建时服务初始化冲突：通过 invokeLater 延迟 createUIComponents，避免类初始化期间 ProxyMigrationService 冲突 (#569) #gadfly3173
- 修复类型断言导致的崩溃：在工具块组件和工具函数中使用 typeof 运行时检查替代类型断言，处理 MCP 工具传递对象而非字符串的情况 (#567) #gadfly3173
- 修复 macOS 下 Codex 模式打开设置时 UI 冻结：NodeDetector 改为单例共享缓存，handleGetNodePath/handleSetNodePath 异步化到后台线程，并发检测去重 (#543) #gadfly3173
- 恢复 Claude 斜杠命令对插件 Skills 的发现：多目录向上遍历，读取 installed_plugins.json 解析清单，上下文感知 ConditionalSkillFilter，命令描述中显示来源 (#551) #gadfly3173
- 加固 Skill 发现的路径遍历和资源耗尽防护：插件 ID 验证、遍历深度限制、使用 toRealPath() 替代 normalize()、禁用 YAML 别名展开、JSON 文件大小和 glob 复杂度限制
- 修复手动配置时 Node.js 路径缓存的竞态条件
- 改进异步健壮性并修复 DependencySection 闭包过期：30 秒检测超时、Node.js 二进制名验证、CompletableFuture 懒初始化追踪、所有异步链添加 .exceptionally() 处理
- 加固 WebView 桥接安全和上下文菜单无障碍：JS 函数名正则验证、扩展字符串转义（tab/backspace/form-feed/NEL/script 突破）、剪贴板读取限流(200ms)和写入大小上限(10MB)、ARIA 角色和键盘导航
- 修复浮动窗口功能问题：使用 project basePath 作为 map key 防止内存泄漏、修复 chatWindow 传递的竞态条件、添加 disposed 标志防止双重销毁 (#564)

🔧 Improvements
- 优化 SVG 图标：使用 CSS 类和简化路径
- 使用 useCallback 稳定附件持久化回调，避免不必要的重新渲染
- 用本地资源替换远程 Banner 图片

---

##### **2026年3月2日（v0.2.4）**

English:

✨ Features
- Replace remote SDK slash command fetching with fully local registry: parse SKILL.md frontmatter via SnakeYAML, scan personal and project skill directories, push commands on session creation and provider switch #gadfly3173
- Add Codex skills support with multi-level directory scanning, $ prefix invocation, config.toml enable/disable integration, and dual-mode SkillsSettingsSection UI #gadfly3173
- Improve process lifecycle and resource cleanup: tab disposal handler for daemon shutdown, forceful kill of unresponsive daemons, proper bridge cleanup in all callback and exception paths
- Add Qwen and OpenRouter as new provider presets with i18n translations for 8 languages
- Highlight auto mode selector in orange as visual permission warning cue
- Add security notice to provider dialog and estimate disclaimer to usage statistics section

🐛 Fixes
- Resolve real OS home directory to bypass IDEA's user.home override: read USERPROFILE/HOME env vars, replace all 35 direct System.getProperty calls across 22 files, add checkstyle enforcement #gadfly3173
- Prevent stale loading panel blocking error UI on Node.js detection failure: route all panel transitions through replaceMainContent() helper #gadfly3173
- Resolve permission mode state desync between frontend and backend: unified push/pull flow with priority rule (payload > session > default), volatile fields for cross-thread visibility #gadfly3173
- Apply date range filter on server side for usage statistics: filter sessions before aggregation for accurate Overview totals and Models tab (#534) #gadfly3173
- Fix tab title management: prevent manual rename from being overwritten by AI status indicators, fix double ellipsis on truncated titles #Olexandr1904
- Sync permission mode state in reused daemon runtime hooks via shared mutable state object
- Decouple status panel expanded state from content presence: expand/collapse now driven solely by user preference
- Remove model ID format regex restriction to support third-party provider formats
- Allow symbolic links in Codex skill directory scanning
- Remove changelog.ts auto-generation from build pipeline
- Harden input validation: skill name validation for path traversal prevention, directory whitelist checks, permission mode whitelist, thread interrupt handling, config dropdown scroll overflow

🔧 Improvements
- Extract token usage utilities from ClaudeMessageHandler into dedicated TokenUsageUtils class for provider-agnostic reuse #gadfly3173
- Unify permission mode validation across frontend and backend with shared constants and type guards
- Replace alert dialogs with toast notifications and inline feedback for better UX
- Remove useUsageStats hook (no-op after background polling removal) #gadfly3173
- Harden Codex skills security: YAML parser limits against billion laughs DoS, path traversal checks, LoadingState tracking for dollarCommandProvider
- Redesign app icon to simplified stroke-based SVG
- Move payment QR codes from README to SPONSORS.md
- Add shared notice-box styles (info/warning variants) with i18n translations

中文：

✨ Features
- 用本地注册表替代远程 SDK 斜杠命令获取：通过 SnakeYAML 解析 SKILL.md frontmatter，扫描个人和项目 skill 目录，在会话创建和供应商切换时主动推送命令 #gadfly3173
- 新增 Codex Skills 支持：多层级目录扫描、$ 前缀调用、config.toml 启用/禁用集成、SkillsSettingsSection 双模式 UI #gadfly3173
- 改进进程生命周期和资源清理：标签页关闭时销毁 daemon、强制终止无响应的 daemon 进程、所有回调和异常路径中正确清理 bridge 资源
- 新增通义千问（Qwen）和 OpenRouter 供应商预设，支持 8 种语言国际化翻译
- Auto 模式选择器以橙色高亮显示，作为权限放开的视觉警示
- 在供应商对话框中添加安全提示，在使用统计中添加估算免责声明

🐛 Fixes
- 修复 IDEA 覆盖 user.home 导致的主目录解析错误：读取 USERPROFILE/HOME 环境变量，替换全部 35 处直接调用（涉及 22 个 Java 文件），新增 checkstyle 规则强制约束 #gadfly3173
- 修复 Node.js 检测失败时加载面板阻塞错误 UI 的问题：所有面板切换统一通过 replaceMainContent() 辅助方法 #gadfly3173
- 修复前后端权限模式状态不同步：统一推/拉流程，明确优先级规则（payload > session > default），volatile 字段保证跨线程可见性 #gadfly3173
- 修复使用统计的日期范围过滤：在服务端聚合前过滤会话，确保概览总计和模型标签页数据准确 (#534) #gadfly3173
- 修复标签页标题管理：手动重命名不再被 AI 状态指示器覆盖，修复截断标题的双省略号问题 #Olexandr1904
- 修复复用的 daemon 运行时 hooks 中权限模式状态过期问题，使用共享可变状态对象
- 解耦状态面板展开状态与内容存在性：展开/折叠完全由用户偏好控制
- 移除模型 ID 格式正则限制，支持第三方供应商的模型 ID 格式
- 允许 Codex skill 目录扫描识别符号链接
- 移除构建流水线中 changelog.ts 的自动生成
- 加固输入验证：skill 名称校验防止路径遍历、目录白名单检查、权限模式白名单、线程中断处理、配置下拉框滚动溢出

🔧 Improvements
- 从 ClaudeMessageHandler 提取 Token 使用工具到独立的 TokenUsageUtils 类，支持多供应商复用 #gadfly3173
- 统一前后端权限模式验证，提取共享常量和类型守卫
- 用 toast 通知和内联反馈替代 alert 弹窗，改善用户体验
- 移除 useUsageStats hook（后台轮询移除后已成空操作） #gadfly3173
- 加固 Codex Skills 安全性：YAML 解析器限制防止十亿笑声 DoS 攻击、路径遍历检查、dollarCommandProvider 加载状态追踪
- 重新设计应用图标为简化的描边风格 SVG
- 将支付二维码从 README 移至 SPONSORS.md
- 新增共享 notice-box 样式（信息/警告变体），支持 8 种语言国际化翻译

##### **2026年2月27日（v0.2.3）**

English:

✨ Features
- Add daemon mode to eliminate per-request Node.js process spawning: persistent daemon with NDJSON protocol, heartbeat monitoring (15s interval, 45s timeout), auto-restart (max 3), and three-phase prewarm strategy for low-latency first messages
- Add abort/cancel support for daemon mode: interrupt active SDK query immediately instead of waiting for completion
- Split BasicConfigSection into tabbed layout (Appearance/Behavior/Environment) for improved settings navigation

🐛 Fixes
- Fix Windows sound notification not playing after AI task completion, switch to native Java audio playback for cross-platform stability #z231485
- Fix sound notification delay, trigger immediately after stream ends instead of waiting #z231485
- Fix sound notification reliability: add 30s MP3 playback timeout, prevent duplicate success+error notifications on stream end
- Fix: only show Windows path constraints on Windows platform #hpstream
- Fix: support filenames with spaces in file tag matching with smart longest-match path resolution #hpstream
- Fix: resolve model name from settings.json for third-party API proxy compatibility (prevents 400 errors on proxies that don't recognize internal model IDs)
- Fix: inject proxy env vars (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) from settings.json for IDE desktop launcher (#429)
- Fix model mapping fallback: only apply sonnet mapping when model ID contains 'sonnet', preventing non-Anthropic models from being incorrectly remapped
- Restrict isPathSafe to user home directory only, removing overly permissive path check
- Strengthen sound path URI parsing: require file:// prefix, use new URI() constructor
- Complete autoOpenFile i18n translations for es/fr/hi/ja/zh-TW

🔧 Improvements
- Optimize file tag matching performance: replace inner-loop substring() with startsWith(), extend boundary check to include tab and carriage return
- Add unit tests for file tag matching (filenames with spaces, longest-match selection, multiple mixed tags)
- Extract shared Windows path constraint into prompt-utils utility to eliminate duplication
- Deduplicate loadClaudeSettings() calls in sendMessage and sendMessageWithAttachments
- Simplify streamEndCallback from Consumer<Boolean> to Runnable
- Update autoOpenFile hint text to clarify that only file paths are sent to AI
- Extract BASIC_TABS to module-level constant
- Add process.env mutation note to setModelEnvironmentVariables

中文：

✨ Features
- 新增 Daemon 常驻进程模式：消除每次请求时 Node.js 进程启动开销（5-10 秒 SDK 加载），使用 NDJSON 协议通信，支持心跳监控（15 秒间隔/45 秒超时）、自动重启（最多 3 次）、三阶段预热策略
- 新增 Daemon 模式请求中断支持：中断通道时立即停止活跃的 SDK 查询，而非等待完成
- 重构基础设置页面为选项卡布局（外观/行为/环境），改善设置导航体验

🐛 Fixes
- 修复 Windows 下 AI 任务完成后提示音不播放的问题，改用原生 Java 音频库播放，保证跨平台稳定性 #z231485
- 修复提示音延迟问题，改为流结束后立即触发 #z231485
- 提升提示音可靠性：MP3 播放添加 30 秒超时防止线程阻塞，修复流结束时成功+错误通知冲突
- 修复 Windows 路径约束提示仅在 Windows 平台显示 #hpstream
- 修复文件标签匹配支持带空格的文件名，使用智能最长路径匹配算法 #hpstream
- 修复第三方 API 代理兼容性：从 settings.json 读取用户配置的模型映射名称发送给 API，防止代理不识别内部模型 ID 导致 400 错误
- 修复 IDE 桌面启动器不继承 Shell 代理配置的问题：从 settings.json 注入 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量 (#429)
- 修复模型映射回退逻辑：仅当模型 ID 包含 'sonnet' 时才应用映射，防止非 Anthropic 模型被错误重映射
- 收紧 isPathSafe 安全检查：限制为仅用户主目录
- 加固提示音路径 URI 解析：要求 file:// 前缀，使用 new URI() 构造器
- 补充 autoOpenFile 功能的 es/fr/hi/ja/zh-TW 国际化翻译

🔧 Improvements
- 优化文件标签匹配性能：用 startsWith() 替代内层循环 substring()，边界检查扩展到 tab 和回车符
- 新增文件标签匹配单元测试（带空格文件名、最长匹配选择、多种混合标签）
- 提取 Windows 路径约束提示到共享工具函数 prompt-utils，消除重复代码
- 合并 sendMessage 和 sendMessageWithAttachments 中的重复 loadClaudeSettings() 调用
- 简化 streamEndCallback 类型：从 Consumer<Boolean> 改为 Runnable
- 更新 autoOpenFile 提示文案，明确仅发送文件路径给 AI
- 提取 BASIC_TABS 为模块级常量
- 为 setModelEnvironmentVariables 添加 process.env 修改说明注释

##### **2026年2月25日（v0.2.2）**

English:

✨ Features
- Add task completion sound notification with 5 built-in sounds (default, chime, bell, ding, success) and custom sound file support #hpstream
- Add review-before-write diff preview with "Apply Always" button for file-modifying tools #gadfly3173
- Add editable session titles in chat header with inline edit mode and history sync #jhaan83
- Add auto-scroll pause when user scrolls up during streaming, resumes on scroll-to-bottom or new message #jhaan83
- Add import/export for agents and prompts with conflict resolution strategies (skip, overwrite, duplicate) #hpstream
- Add markdown rendering in permission and plan approval dialogs #dsudomoin
- Add collapsible earlier messages with show/hide toggle in MessageList #dsudomoin
- Add user message bubble color customization in settings (8 languages) #dsudomoin

🐛 Fixes
- Eliminate React re-renders during IME composition for JCEF CJK input using ref-only approach #Stackerr
- Fix contenteditable input: disable spellcheck, prevent character loss during fast typing, fix ArrowUp navigation with pasted text #jhaan83 #dsudomoin
- Fix enhance prompt output language to match source prompt language #Olexandr1904
- Fix session title persistence: migrate title on SDK session ID change, clear ID on new session, prevent focus stealing during title edit #jhaan83
- Fix custom model restoration in session state validation
- Cancel pending reject task and close diff view on Apply Always action
- Replace native select with upward-opening dropdown for sound selector (JCEF clipping fix)
- Harden security: command injection prevention in NodeJsServiceCaller (function name whitelist + env vars), path traversal protection in SoundNotificationService, permission mode whitelist, DOMPurify XSS sanitization for streaming markdown
- Fix stale closures in useSettingsWindowCallbacks via ref pattern
- Improve anchor rail sync with collapsed message count and skip hidden anchors

🔧 Improvements
- Scroll performance: IntersectionObserver in MessageAnchorRail, rAF throttle + passive listeners in ScrollControl #dsudomoin
- CSS performance: contain:layout on messages, border instead of box-shadow, remove will-change per char #dsudomoin
- Split large files into smaller focused modules: CSS (12 files), SettingsDialogs, icons (3 modules), CodexMessageConverter, NodeJsServiceCaller
- Extract shared useDialogResize hook from PermissionDialog and PlanApprovalDialog
- Use deepCopy for duplicate operations in AgentManager/PromptManager to prevent object mutation
- Translate PromptEnhancerHandler Chinese content to English
- Console forwarding only in devMode, remove excessive console.log statements

中文：

✨ Features
- 新增任务完成提示音功能：5 种内置提示音（默认、风铃、铃声、叮咚、成功）及自定义音频文件支持 #hpstream
- 新增写入前 Diff 预览功能，支持"始终应用"按钮，用于文件修改类工具 #gadfly3173
- 新增聊天标题栏内联编辑模式，支持自定义会话标题并同步到历史记录 #jhaan83
- 新增流式输出时鼠标滚轮上滑自动暂停滚动，滑到底部或发送新消息时恢复 #jhaan83
- 新增 Agent 和 Prompt 导入/导出功能，支持冲突解决策略（跳过、覆盖、复制） #hpstream
- 新增权限对话框和计划审批对话框的 Markdown 渲染 #dsudomoin
- 新增消息列表中历史消息的折叠/展开功能 #dsudomoin
- 新增用户消息气泡颜色自定义（支持 8 种语言） #dsudomoin

🐛 Fixes
- 修复 JCEF 环境下CJK输入法组合输入导致的 React 重渲染问题，改用 ref-only 方案 #Stackerr
- 修复 contenteditable 输入框：禁用拼写检查、防止快速打字丢字、修复粘贴文本后方向键导航 #jhaan83 #dsudomoin
- 修复增强提示词输出语言始终为中文的问题，现在匹配源语言 #Olexandr1904
- 修复会话标题持久化：SDK 会话 ID 变更时迁移标题、新建会话时清除 ID、防止编辑标题时焦点被抢 #jhaan83
- 修复自定义模型在会话状态恢复时的验证逻辑
- 修复"始终应用"操作后取消挂起的拒绝任务并关闭 Diff 视图
- 修复 JCEF 环境下原生 select 被裁剪问题，替换为向上展开的自定义下拉框
- 安全加固：NodeJsServiceCaller 命令注入防护（函数名白名单 + 环境变量传参）、SoundNotificationService 路径遍历防护、权限模式白名单验证、流式 Markdown DOMPurify XSS 防护
- 修复 useSettingsWindowCallbacks 中的闭包过期问题，改用 ref 模式
- 改进消息锚点导航栏与折叠消息的同步，跳过隐藏的锚点

🔧 Improvements
- 滚动性能优化：MessageAnchorRail 使用 IntersectionObserver、ScrollControl 使用 rAF 节流 + passive 监听器 #dsudomoin
- CSS 性能优化：消息元素使用 contain:layout、border 替代 box-shadow、移除逐字符 will-change #dsudomoin
- 拆分大文件为小型聚焦模块：CSS（12 个文件）、SettingsDialogs、icons（3 个模块）、CodexMessageConverter、NodeJsServiceCaller
- 提取 useDialogResize 共享 hook，消除 PermissionDialog 和 PlanApprovalDialog 的重复代码
- AgentManager/PromptManager 复制操作使用 deepCopy 防止对象变异
- 将 PromptEnhancerHandler 中的中文内容翻译为英文
- 控制台转发仅在开发模式启用，移除多余的 console.log 语句

##### **2026年2月21日（v0.2.1）**

English:

✨ Features
- Filter .gitignore'd files from editor context to prevent sensitive file leakage with cached IgnoreRuleMatcher (30s TTL)
- Add "Diff expanded by default" toggle in Settings → Basic with localStorage persistence #dsudomoin

🐛 Fixes
- Stabilize streaming and prevent content loss: atomic IPC output, consistent JSON encoding for deltas, flush final content before stream end #gadfly3173
- Harden security: path traversal protection in permission-handler, stop logging API key prefix, add Content-Security-Policy meta tag to webview
- Replace hardcoded Chinese/text with i18n translation functions and add missing translations across all locales #serega0005

🔧 Improvements
- Optimize React rendering with React.memo, useCallback, useMemo and lazy-load mermaid (~500KB deferred) #gadfly3173
- Decompose ClaudeSDKToolWindow (~2700 lines) into 11 single-responsibility classes (SessionLifecycleManager, StreamMessageCoalescer, WebviewInitializer, etc.)
- Improve Russian localization: natural first-person verb forms, session→chat terminology, translate settings.prompt section #dsudomoin
- Replace Chinese log/UI messages with English and normalize Unicode emoji escape sequences

中文：

✨ Features
- 过滤 .gitignore 规则匹配的文件，防止敏感文件泄漏到编辑器上下文，使用带 30 秒 TTL 缓存的 IgnoreRuleMatcher
- 新增"Diff 默认展开"开关（设置 → 基础），支持 localStorage 持久化 #dsudomoin

🐛 Fixes
- 稳定流式传输并防止内容丢失：原子化 IPC 输出、统一 delta JSON 编码、流结束前刷新最终内容 #gadfly3173
- 加固安全性：权限处理器路径遍历防护、停止记录 API Key 前缀、为 webview 添加 CSP meta 标签
- 将硬编码中文/文本替换为 i18n 翻译函数，补充所有语言环境的缺失翻译 #serega0005

🔧 Improvements
- 优化 React 渲染：使用 React.memo、useCallback、useMemo，懒加载 mermaid（延迟 ~500KB 解析） #gadfly3173
- 拆解 ClaudeSDKToolWindow（约 2700 行）为 11 个单一职责类（SessionLifecycleManager、StreamMessageCoalescer、WebviewInitializer 等）
- 改进俄语本地化：使用自然第一人称动词形式、session→chat 术语替换、翻译 settings.prompt 部分 #dsudomoin
- 将中文日志/UI 消息替换为英文，规范化 Unicode emoji 转义序列

##### **2026年2月20日（v0.2）**

English:

✨ Features
- Add message anchor navigation rail with quick-scroll dots for jumping between user messages
- Refactor custom model management to plugin-level with standalone CRUD dialog and cross-provider localStorage sync
- Add version history entry in community settings with link to changelog dialog
- Update open-source banner text with piracy warning across all 8 locales

🐛 Fixes
- Fix context window token calculation formula: include cache_read_input_tokens instead of output_tokens in all 5 code paths #gadfly3173
- Fix reserved padding-left layout shift when message anchor rail is hidden

🔧 Improvements
- Simplify token usage display by reusing extractUsedTokens with dynamic provider detection
- Add [USAGE] tag pipeline for accurate token data flow from ai-bridge to Java backend #gadfly3173
- Continue translating remaining Chinese comments to English across Java backend and React frontend
- Remove sponsor QR codes section from community settings

中文：

✨ Features
- 新增消息锚点导航栏，支持快速滚动定位到各条用户消息
- 重构自定义模型管理为插件级别，新增独立 CRUD 对话框，支持跨供应商 localStorage 同步
- 在社区设置中新增版本历史入口，链接到更新日志弹窗
- 更新开源横幅文案，增加盗版警告提示（覆盖全部 8 种语言）

🐛 Fixes
- 修复上下文窗口 Token 计算公式：在全部 5 个代码路径中使用 cache_read_input_tokens 替代 output_tokens #gadfly3173
- 修复消息锚点导航栏隐藏时多余的左侧内边距导致的布局偏移

🔧 Improvements
- 简化 Token 使用量显示，复用 extractUsedTokens 并支持动态供应商检测
- 新增 [USAGE] 标签管道，实现 ai-bridge 到 Java 后端的精确 Token 数据流 #gadfly3173
- 继续将 Java 后端和 React 前端中的剩余中文注释翻译为英文
- 移除社区设置中的赞助二维码部分

##### **2026年2月19日（v0.1.9-fix）**

English:

✨ Features
- New version record pop-up window
- Add custom model support for Claude providers with per-provider model editor and model selector integration

中文：

✨ Features
- 新增版本记录弹窗
- 新增 Claude 供应商自定义模型支持，支持按供应商编辑模型并集成到模型选择器

##### **2026年2月19日（v0.1.9）**

English:

✨ Features
- Add prompt template management system with backend CRUD, PromptDialog UI, and ">>" trigger detection in chat input #hpstream
- Add chat background color customization with theme-aware presets and color picker
- Add batch search grouping for consecutive grep/glob/find tool calls (SearchToolGroupBlock)
- Add collapsible accordion to TaskOutput tool block
- Add dismissible open-source banner above chat input
- Add Russian language support #dsudomoin
- Add timestamp display for history completion items with relative time formatting #hpstream
- Upgrade default models to Sonnet 4.6 and Opus 4.6, remove Opus 4.5
- Support multi-file drag and drop into chat input
- Extract hardcoded strings to resource bundles for full internationalization

🐛 Fixes
- Resolve paste-then-send race condition in chat input with debounce flush mechanism #gadfly3173
- Send full tool_result block and remove cwd file cleanup to prevent cross-session race condition #gadfly3173
- Fix markdown rendering error handling and dialog overlay click blocking
- Fix i18n pluralization for relative time display (e.g. "1 year ago" vs "1 years ago")
- Add input validation and harden prompt operations (null checks, ID format validation, hex color validation)
- Replace debounce non-null assertion with guard check to prevent runtime errors
- Batch timestamp writes to reduce N localStorage read/write cycles to 1

🔧 Improvements
- Translate all Chinese comments to English across codebase for improved accessibility
- Add truncateToolResultBlock() to limit IPC payload size (20k chars) matching Java-side threshold
- Replace per-session temp file cleanup with age-based stale cleanup (>24h) during IDE shutdown for safe concurrent sessions
- Refactor prompt template: use shared service instance, require whitespace before trigger, switch to debug log levels, remove dead code
- Simplify markdown rendering by removing redundant mountRetry and over-wrapped error fallback
- Add Russian plural forms (_one/_few/_many) for i18n

中文：

✨ Features
- 新增提示词模板管理系统：后端 CRUD、PromptDialog 界面、输入框 ">>" 触发检测 #hpstream
- 新增聊天背景颜色自定义，支持主题感知预设和颜色选择器
- 新增连续搜索工具调用（grep/glob/find）的批量分组显示（SearchToolGroupBlock）
- 新增 TaskOutput 工具块的可折叠手风琴组件
- 新增聊天输入框上方的可关闭开源横幅
- 新增俄语语言支持 #dsudomoin
- 新增历史补全项的时间戳显示，支持相对时间格式化 #hpstream
- 升级默认模型到 Sonnet 4.6 和 Opus 4.6，移除 Opus 4.5
- 支持多文件拖拽到聊天输入框
- 提取硬编码字符串到资源包，实现完整国际化

🐛 Fixes
- 修复粘贴后立即发送的竞态条件，添加防抖 flush 机制 #gadfly3173
- 发送完整 tool_result 块并移除 cwd 文件清理，防止跨会话竞态条件 #gadfly3173
- 修复 Markdown 渲染错误处理和对话框遮罩层点击阻塞问题
- 修复相对时间显示的国际化复数形式（如 "1 year ago" 而非 "1 years ago"）
- 添加输入验证并加固提示词操作（空值检查、ID 格式验证、十六进制颜色验证）
- 将防抖非空断言替换为守卫检查，防止运行时错误
- 批量写入时间戳，将 N 次 localStorage 读写减少为 1 次

🔧 Improvements
- 将代码库中所有中文注释翻译为英文，提升可访问性
- 添加 truncateToolResultBlock() 限制 IPC 负载大小（20k 字符），匹配 Java 端阈值
- 将每会话临时文件清理替换为基于时间的过期清理（>24h），在 IDE 关闭时执行，支持并发会话安全
- 重构提示词模板：使用共享服务实例、触发符前需空白字符、切换为 debug 日志级别、移除死代码
- 简化 Markdown 渲染，移除冗余的 mountRetry 和过度包装的错误回退
- 添加俄语复数形式（_one/_few/_many）国际化支持

##### **2026年2月12日（v0.1.8）**

English:

✨ Features
- Add Claude Opus 4.6 model support with 1M context window
- Add preset buttons for quick provider configuration with one-click setup
- Integrate Claude and Codex provider management with unified tab interface
- Enhance DevTools action with Chrome remote debugging support
- Change file click behavior in status panel and restore diff icon
- Update Codex SDK to latest version
- Add exception error notification for better user feedback

🐛 Fixes
- Fix MCP SSE transport verification and tools retrieval
- Fix MCP STDIO server verification and improve protocol compliance
- Fix SSE endpoint and error handling issues
- Truncate long error messages to prevent webview freezing
- Preserve cursor position after dropdown selection and file-tag rendering
- Exclude cache read tokens from context window usage calculation
- Disable immediate tab creation to fix tab loading stuck issue
- Improve mermaid rendering on history load
- Use #app rect as reference for fixed positioning in zoom container
- Retrieve user-selected changes via reflection for diff operations
- Fix compile encoding on Windows

🔧 Improvements
- Change license from AGPL-3.0 to MIT for broader compatibility
- Add i18n support for provider presets and optimize rendering
- Filter environment keys in local provider and optimize model mapping
- Refactor reflection to safely handle collections
- Fix ErrorBoundary timer cleanup to prevent memory leaks
- Extract sponsors list to SPONSORS.md and simplify README
- Add Trendshift badge to README files

中文：

✨ Features
- 新增 Claude Opus 4.6 模型支持，提供 1M 上下文窗口
- 新增供应商预设按钮，支持一键快速配置
- 整合 Claude 和 Codex 供应商管理，统一标签页界面
- 增强 DevTools 操作，支持 Chrome 远程调试
- 修改状态面板文件点击行为，恢复 Diff 图标
- 更新 Codex SDK 到最新版本
- 新增异常错误通知，提供更好的用户反馈

🐛 Fixes
- 修复 MCP SSE 传输验证和工具获取问题
- 修复 MCP STDIO 服务器验证，改进协议兼容性
- 修复 SSE 端点和错误处理问题
- 截断长错误消息，防止 webview 冻结
- 修复下拉选择和文件标签渲染后的光标位置保持
- 从上下文窗口使用量计算中排除缓存读取的 token
- 禁用立即创建标签页，修复标签页加载卡住问题
- 改进历史记录加载时的 mermaid 渲染
- 使用 #app rect 作为缩放容器中固定定位的参考
- 通过反射获取用户选择的更改用于 Diff 操作
- 修复 Windows 下的编译编码问题

🔧 Improvements
- 许可证从 AGPL-3.0 更改为 MIT，提升兼容性
- 为供应商预设添加国际化支持，优化渲染性能
- 过滤本地供应商中的环境变量键，优化模型映射
- 重构反射以安全处理集合类型
- 修复 ErrorBoundary 定时器清理，防止内存泄漏
- 提取赞助商列表到 SPONSORS.md，简化 README
- 在 README 中添加 Trendshift 徽章

##### **2026年2月5日（v0.1.7-beta5）**

English:

✨ Features
- Add message queue functionality: auto-queue messages when AI is processing, with queue UI above input box
- Add 5-minute timeout countdown to AskUserQuestionDialog and PlanApprovalDialog with 30-second warning banner
- Add collapse/expand functionality for permission dialogs
- Add history item editor with importance settings in OtherSettingsSection
- Add attachment block support for file chips display
- Add "Auto Open File" toggle to control ContextBar display and AI context collection
- Add history deep search feature: clears cache and reloads all session data from filesystem

🐛 Fixes
- Fix tool icon width and alignment in MCP settings
- Fix line separator handling in diff view to prevent "Wrong line separators" errors
- Fix token usage calculation for different providers (Codex/OpenAI vs Claude cache handling)
- Fix useEffect dependency issues in dialog components
- Fix potential timer memory leaks with improved cleanup logic
- Fix autoOpenFile setting to properly control AI editor context collection

🔧 Improvements
- Refactor: use centralized path utilities for homedir resolution (fix Windows symlink issues)
- Refactor: extract line separator handling to LineSeparatorUtil
- Refactor: replace CSS gap property with margin-right pattern for better browser compatibility
- Refactor: extract common LESS mixins to reduce code duplication (~254 lines reduced)
- Refactor: remove SlashCommandCache class, fetch slash commands directly from SDK
- Add Map cache size limit (100 entries) to prevent memory growth
- Add OpenAI/Codex model context limits (GPT-5.x, o3, o1 series)
- Add webfetch to collapsible tools list in GenericToolBlock
- Add frontend data validation for usage percentage
- Extract formatCountdown as shared utility function
- Add comprehensive i18n support for new dialog features

中文：

✨ Features
- 新增消息队列功能：AI 处理时自动排队新消息，队列 UI 显示在输入框上方
- 新增 AskUserQuestionDialog 和 PlanApprovalDialog 的 5 分钟超时倒计时，剩余 30 秒时显示警告横幅
- 新增权限对话框折叠/展开功能
- 新增历史项编辑器，支持重要性设置（在其他设置中）
- 新增附件块支持，用于文件标签显示
- 新增"自动打开文件"开关，控制 ContextBar 显示和 AI 上下文收集
- 新增历史深度搜索功能：清除缓存并从文件系统重新加载所有会话数据

🐛 Fixes
- 修复 MCP 设置中工具图标宽度和对齐问题
- 修复 Diff 视图中行分隔符处理问题，防止"Wrong line separators"错误
- 修复不同供应商的 token 使用量计算（Codex/OpenAI vs Claude 缓存处理）
- 修复对话框组件中的 useEffect 依赖问题
- 修复定时器内存泄漏问题，改进清理逻辑
- 修复 autoOpenFile 设置对 AI 编辑器上下文收集的控制

🔧 Improvements
- 重构：使用集中式路径工具函数解析 homedir（修复 Windows 符号链接问题）
- 重构：提取行分隔符处理到 LineSeparatorUtil
- 重构：用 margin-right 模式替换 CSS gap 属性，提升浏览器兼容性
- 重构：提取公共 LESS mixins 减少代码重复（约减少 254 行）
- 重构：移除 SlashCommandCache 类，直接从 SDK 获取斜杠命令
- 添加 Map 缓存大小限制（100 条）防止内存增长
- 添加 OpenAI/Codex 模型上下文限制（GPT-5.x、o3、o1 系列）
- 在 GenericToolBlock 添加 webfetch 到可折叠工具列表
- 添加前端使用百分比数据验证
- 提取 formatCountdown 为共享工具函数
- 为新对话框功能添加完整的国际化支持

##### **2026年1月31日（v0.1.7-beta4）**

English:

✨ Features
- Add input history recording with Tab key completion and configurable settings toggle
- Add persistent storage for input history in ~/.codemoss/inputHistory.json with management UI in settings
- Add interactive Diff view with Apply/Reject buttons and state persistence across sessions
- Add local handling for new session commands (/clear, /new, /reset) to bypass confirmation dialog
- Add disk cache for slash commands with 7-day TTL and preload on component mount

🐛 Fixes
- Fix placeholder text filtering when uploading images (avoid "已上传附件:" in content)
- Fix user message copy button position overlap issue
- Fix stale input values during submission by adding cancelPendingInput
- Fix stdin handling for parameter passing in node scripts
- Fix attachment placeholder i18n (replace hardcoded Chinese with standardized English format)
- Fix new file rejection in diff view: delete file instead of restoring empty content

🔧 Improvements
- Extract completion trigger detection to dedicated useCompletionTriggerDetection hook
- Improve history completion code quality: add MAX_COUNT_RECORDS limit, custom event sync, boundary checks
- Improve chat input hover and resize handle interactions with border glow effect
- Extract reusable CopyButton component from duplicate implementations
- Refactor diff utilities: extract DiffBrowserBridge and ContentRebuildUtil classes
- Add path security validation with isPathWithinProject method and improved traversal detection
- Increase input box min-height from 3 lines to 4 lines
- Add comprehensive i18n support for history management and diff operations

中文：

✨ Features
- 新增输入历史记录功能，支持 Tab 键补全，可在设置中自由开关
- 新增输入历史持久化存储（~/.codemoss/inputHistory.json），设置页面支持历史管理 UI
- 新增交互式 Diff 视图，支持 Apply/Reject 按钮和跨会话状态持久化
- 新增本地会话命令处理（/clear、/new、/reset），跳过确认对话框直接创建新会话
- 新增斜杠命令磁盘缓存（7天 TTL），组件挂载时预加载

🐛 Fixes
- 修复上传图片时占位符文本过滤问题（避免内容中出现"已上传附件:"）
- 修复用户消息复制按钮位置遮挡问题
- 修复输入提交时的过期值问题，添加 cancelPendingInput 机制
- 修复 node 脚本中 stdin 参数传递处理
- 修复附件占位符国际化问题（将硬编码中文替换为标准化英文格式）
- 修复 Diff 视图中新文件拒绝操作：删除文件而非恢复空内容

🔧 Improvements
- 重构补全触发检测到独立 hook（useCompletionTriggerDetection）
- 改进历史补全代码质量：添加 MAX_COUNT_RECORDS 限制、自定义事件同步、边界检查
- 改进输入框悬停和调整大小手柄交互，添加边框发光效果
- 提取可复用的 CopyButton 组件，消除重复实现
- 重构 Diff 工具类：提取 DiffBrowserBridge 和 ContentRebuildUtil 类
- 添加路径安全验证（isPathWithinProject 方法）和改进的路径遍历检测
- 输入框最小高度从 3 行增加到 4 行
- 为历史管理和 Diff 操作添加完整的国际化支持

##### **2026年1月30日（v0.1.7-beta3）**

English:

✨ Features
- Add tab answering status indicator with multi-state support (ANSWERING, COMPLETED, IDLE) and auto-reset
- Add copy server config button for MCP servers with clipboard integration and env/headers sanitization
- Improve MCP server discovery: expose disabled and invalid servers alongside enabled ones
- Merge global and project MCP server configurations for complete status display
- Enhance PATH with ~/.local/bin and ~/.cargo/bin for uvx/cargo tool resolution

🐛 Fixes
- Fix EDT thread safety in tab status auto-reset callback
- Fix loading state sync during streaming (check before sending event)
- Fix chat input box border-radius selector for resize handles
- Sanitize environment variables and headers when copying MCP server config
- Remove unused cacheKeys prop from ServerCard

🔧 Improvements
- Replace boolean loading state with TabAnswerStatus enum for richer status display
- Replace inline MCP log panel with dialog for cleaner UI
- Relax command whitelist to warn instead of block user-configured servers
- Add marker-based output parsing for Java-side process communication with early termination
- Replace refresh icon with sync icon and unify icon button styling across MCP components
- Reduce log verbosity (info → debug) for tab status events
- Use language-neutral "..." suffix for answering state
- Add mobile responsive styles for MCP header buttons
- Remove per-server refresh button for cleaner UI
- Add internationalization support for tab status messages

中文：

✨ Features
- 新增标签页回答状态指示器，支持多状态显示（回答中、已完成、空闲）并自动重置
- 新增 MCP 服务器配置复制按钮，支持剪贴板集成并自动清理敏感的环境变量和请求头
- 改进 MCP 服务器发现：展示已禁用和无效的服务器完整状态
- 合并全局和项目级 MCP 服务器配置，提供完整状态展示
- 增强 PATH 环境变量，添加 ~/.local/bin 和 ~/.cargo/bin 以支持 uvx/cargo 工具解析

🐛 Fixes
- 修复标签页状态自动重置回调中的 EDT 线程安全问题
- 修复流式传输期间加载状态同步问题（发送事件前先检查状态）
- 修复聊天输入框 border-radius 选择器对调整手柄的影响
- 复制 MCP 服务器配置时自动清理环境变量和请求头中的敏感信息
- 移除 ServerCard 中未使用的 cacheKeys 属性

🔧 Improvements
- 用 TabAnswerStatus 枚举替换布尔加载状态，支持更丰富的状态展示
- 用对话框替换内联 MCP 日志面板，界面更简洁
- 放宽命令白名单限制，对用户配置的服务器改为警告而非阻止
- Java 端进程通信添加基于标记的输出解析，支持提前终止
- 统一 MCP 组件图标按钮样式，用同步图标替换刷新图标
- 降低标签页状态事件日志级别（info → debug）
- 回答状态使用语言无关的 "..." 后缀
- 新增 MCP 头部按钮的移动端响应式样式
- 移除每个服务器的独立刷新按钮，简化界面
- 添加标签页状态消息的国际化支持

##### **2026年1月28日（v0.1.7-beta2）**

English:

✨ Features
- Add MCP server tools fetching and caching system with STDIO and HTTP/SSE support
- Add resizable chat input box with vertical resize handles and localStorage persistence
- Add copy button for user messages with performance optimization
- Add project-specific MCP configuration support

🐛 Fixes
- Fix chat input box horizontal resize bug that caused width collapse
- Fix loading panel removal causing close confirmation dialog race condition
- Fix XSS vulnerability in file tag rendering with proper text escaping
- Fix memory leak in copy button timeout cleanup
- Fix FileReader error handling for file operations

🔧 Improvements
- Refactor ChatInputBox into modular components (header, footer, resize handles)
- Optimize large text handling with array+join (6+ seconds → <100ms for 50KB text)
- Add performance instrumentation with configurable thresholds and timing marks
- Improve security with delegated event handlers to prevent listener leaks
- Add text length thresholds to skip expensive operations (10K/50K/5K chars)
- Limit max file tags per render to 50 to prevent UI freeze
- Create centralized performance constants module (constants/performance.ts)
- Improve accessibility for resize handles with ARIA roles and keyboard support
- Add tools cache manager with expiry configuration for MCP servers
- Create React hooks for MCP tools update and management (useToolsUpdate, useServerData, useServerManagement)
- Refactor MCP status service into modular architecture (13+ new modules)
- Add comprehensive TypeScript type definitions for MCP components
- Reduce native listener re-subscriptions in ChatInputBox hooks
- Replace string concatenation with array+join in file tags and text content extraction
- Use fast Range API for text insertion >5K chars instead of slow execCommand

中文：

✨ Features
- 新增 MCP 服务器工具获取和缓存系统，支持 STDIO 和 HTTP/SSE 协议
- 新增聊天输入框垂直调整大小功能，支持 localStorage 持久化
- 新增用户消息复制按钮，带性能优化
- 新增项目特定 MCP 配置支持

🐛 Fixes
- 修复聊天输入框水平调整导致宽度崩溃的问题
- 修复加载面板移除导致关闭确认对话框竞态条件的问题
- 修复文件标签渲染中的 XSS 漏洞，正确转义文本
- 修复复制按钮超时清理的内存泄漏问题
- 修复 FileReader 文件操作错误处理

🔧 Improvements
- 重构 ChatInputBox 为模块化组件（header、footer、resize handles）
- 优化大文本处理，使用数组+join（50KB 文本粘贴从 6+ 秒优化至 <100ms）
- 添加性能监控工具，支持可配置阈值和计时标记
- 改进安全性，使用委托事件处理器防止监听器泄漏
- 添加文本长度阈值跳过昂贵操作（10K/50K/5K 字符）
- 限制每次渲染最多 50 个文件标签，防止 UI 冻结
- 创建集中式性能常量模块（constants/performance.ts）
- 改进调整大小手柄的可访问性，支持 ARIA 角色和键盘操作
- 添加 MCP 服务器工具缓存管理器，支持过期配置
- 创建 MCP 工具更新和管理的 React hooks（useToolsUpdate、useServerData、useServerManagement）
- 重构 MCP 状态服务为模块化架构（新增 13+ 个模块）
- 添加 MCP 组件的完整 TypeScript 类型定义
- 减少 ChatInputBox hooks 中的原生监听器重新订阅
- 在文件标签和文本内容提取中用数组+join 替换字符串拼接
- 对超过 5K 字符的文本插入使用快速 Range API 替代缓慢的 execCommand

##### **2026年1月28日（v0.1.7-beta1）**

English:

✨ Features
- Add chat input history navigation with ArrowUp/ArrowDown keys
- Add tab rename and close confirmation features
- Add AI-powered commit message generation
- Add Codex SDK image attachment support

🐛 Fixes
- Fix MCP connection failure issue
- Fix MCP invocation issue on Windows

🔧 Improvements
- Refactor ChatInputBox into modular hooks
- Improve custom model input validation and security
- Improve Action classes thread safety

中文：

✨ Features
- 聊天输入框支持上下箭头键历史记录导航
- 支持标签页重命名和关闭确认
- AI 智能生成 Git 提交消息
- Codex SDK 支持图片附件

🐛 Fixes
- 修复 MCP 连接失败问题
- 修复 Windows 系统 MCP 无法调用的问题

🔧 Improvements
- 重构 ChatInputBox 组件，拆分为独立 hooks
- 改进自定义模型输入验证和安全性
- Action 类线程安全性优化

##### **2026年1月25日（v0.1.6）**

English:
- [x] Add custom "Other" option to AskUserQuestion dialog with textarea for custom input
- [x] Auto-detect fnm (Fast Node Manager) nodejs path (#265)
- [x] Fix npm package specs quoting to preserve semver operators (^~><) on Windows (#258)
- [x] Fix macOS JCEF zoom/layout recovery after resume (#248)
- [x] Fix MCP plugin connection and invocation issues (#266)
- [x] Extract shell execution logic to ShellExecutor utility class for better reusability
- [x] Use toast notifications for error messages with type-based duration (error: 5s, warning: 3s, default: 2s)
- [x] Improve MCP status service security: command whitelist validation, unified logging, reusable functions
- [x] Add ReDoS protection with line length limits in mcp-status-service
- [x] Replace regex-based JSON parsing with bracket matching algorithm for better security
- [x] Add input length limits in AskUserQuestionDialog
- [x] Improve NpmPermissionHelper with precompiled regex and quote escaping
- [x] Extract Toast duration constants for better maintainability
- [x] Add i18n translations for "Other" option (en, es, fr, hi, ja, zh, zh-TW)
- [x] Change cancel button text to "Auto" across all languages

中文:
- [x] 在 AskUserQuestion 对话框中添加自定义 "Other" 选项，支持文本输入
- [x] 自动检测 fnm（快速 Node 管理器）的 nodejs 路径 (#265)
- [x] 修复 Windows 上 npm 包规格引用问题，保留 semver 操作符（^~><）(#258)
- [x] 修复 macOS JCEF 休眠恢复后的缩放/布局问题 (#248)
- [x] 修复 MCP 插件无法正常连接调用的问题 (#266)
- [x] 提取 shell 执行逻辑到 ShellExecutor 工具类，提升代码复用性
- [x] 使用 toast 通知替代错误消息，根据类型设置显示时长（错误: 5秒，警告: 3秒，默认: 2秒）
- [x] 改进 MCP 状态服务安全性：命令白名单验证、统一日志系统、提取可复用函数
- [x] 在 mcp-status-service 中添加 ReDoS 防护，限制行长度
- [x] 用括号匹配算法替换基于正则的 JSON 解析，提升安全性
- [x] 在 AskUserQuestionDialog 中添加输入长度限制
- [x] 改进 NpmPermissionHelper，添加预编译正则和引号转义
- [x] 提取 Toast 显示时长常量，提升可维护性
- [x] 为 "Other" 选项添加多语言翻译（en、es、fr、hi、ja、zh、zh-TW）
- [x] 将取消按钮文本统一更改为 "Auto"

##### **2026年1月24日（v0.1.6-beta3）**

English:
- [x] Add StatusPanel with task tracking, subagent status, and file changes undo
- [x] Add session index cache system with in-memory caching (5min TTL) and disk persistence
- [x] Add BashToolGroupBlock for batch command display with timeline view
- [x] Extract and display command-message tag content from user input
- [x] Extract settings state management into custom hooks (useProviderManagement, useCodexProviderManagement, useAgentManagement)
- [x] Add useIsToolDenied shared hook to reduce code duplication
- [x] Add useFileChanges hook with single/batch undo support
- [x] Add useSubagents hook for background task status tracking
- [x] Fix cursor position preservation during input value sync and file tag rendering
- [x] Fix permission handling issues (JSON parse error handling, stale state cleanup, React safety)
- [x] Fix BashToolGroupBlock expanded item scrolling by increasing max-height
- [x] Fix BridgeDirectoryResolver filesystem sync race condition
- [x] Refactor: remove duplicate LOG.info/debugLog calls in permission services
- [x] Refactor: extract permission timeout as named constants with cross-reference comments
- [x] Clean up frontend console logs

中文:
- [x] 新增状态面板（StatusPanel）：支持任务跟踪、子代理状态显示和文件变更撤销
- [x] 新增会话索引缓存系统：内存缓存（5分钟 TTL）+ 磁盘持久化
- [x] 新增批量命令显示组件（BashToolGroupBlock）：支持时间线视图
- [x] 提取并显示用户输入中的 command-message 标签内容
- [x] 提取设置状态管理到自定义 hooks（useProviderManagement、useCodexProviderManagement、useAgentManagement）
- [x] 新增 useIsToolDenied 共享 hook，减少代码重复
- [x] 新增 useFileChanges hook，支持单个/批量撤销功能
- [x] 新增 useSubagents hook，用于后台任务状态跟踪
- [x] 修复输入框光标位置：输入值同步和文件标签渲染时保持光标位置
- [x] 修复权限处理问题（JSON 解析错误处理、过期状态清理、React 安全性）
- [x] 修复 BashToolGroupBlock 展开项滚动问题
- [x] 修复 BridgeDirectoryResolver 文件系统同步竞态条件
- [x] 重构：移除权限服务中的重复 LOG.info/debugLog 调用
- [x] 重构：提取权限超时为命名常量并添加交叉引用注释
- [x] 清理前端 console.log 语句

##### **2026年1月22日（v0.1.6-beta2）**

English:
- [x] Add terminal support and enhance terminal monitoring features
- [x] Add keyboard shortcuts for Quick Fix action
- [x] Add RunConfigMonitorService to monitor Run/Debug service output
- [x] Add dev mode detection and DevTools support
- [x] Add Follow IDE theme option with reliable theme detection
- [x] Add permission isolation per IDE session
- [x] Filter @ file search results with .gitignore rules
- [x] Add mermaid diagram rendering support
- [x] Add send file path to CCG from project tree context menu
- [x] Add sponsor section to settings with i18n support
- [x] Fix Codex usage updates from result messages
- [x] Fix: remove redundance in terminal output
- [x] Fix: inject IDE theme at HTML load time to prevent flash
- [x] Fix: downgrade Claude SDK to v0.2.3
- [x] Fix: defer run-config monitoring to EDT
- [x] Refactor: improve code quality, memory management, and security
- [x] Refactor: improve PermissionService code quality

中文:
- [x] 添加终端支持并增强终端监控功能
- [x] 添加 Quick Fix 操作的键盘快捷键
- [x] 添加 RunConfigMonitorService 监控 Run/Debug 服务输出
- [x] 添加开发模式检测和 DevTools 支持
- [x] 添加跟随 IDE 主题选项，支持可靠的主题检测
- [x] 实现每个 IDE 会话的权限隔离
- [x] 根据 .gitignore 规则过滤 @ 文件搜索结果
- [x] 添加 mermaid 图表渲染支持
- [x] 添加从项目树右键菜单发送文件路径到 CCG 功能
- [x] 在设置中添加赞助商部分（支持国际化）
- [x] 修复 Codex 使用量统计更新问题
- [x] 修复终端输出中的冗余内容
- [x] 修复 HTML 加载时注入 IDE 主题以防止闪烁
- [x] 修复：降级 Claude SDK 到 v0.2.3
- [x] 修复：将 run-config 监控推迟到 EDT
- [x] 重构：改进代码质量、内存管理和安全性
- [x] 重构：改进 PermissionService 代码质量

##### **2026年1月19日（v0.1.6-beta1）**

English:
- [x] Fix dialog appearing in wrong IDEA window when multiple instances are open
- [x] Enable streaming responses by default for smoother experience
- [x] Fix session state occasionally becoming abnormal
- [x] Use system native save dialog when exporting sessions
- [x] Fix settings tab losing input when switching tabs
- [x] Fix usage statistics accuracy
- [x] Fix custom Node.js path compatibility issue

中文:
- [x] 修复多开IDEA时，弹窗可能跑到其他IDEA窗口的问题
- [x] 默认开启流式回复，响应更流畅
- [x] 修复会话状态偶尔异常的问题
- [x] 导出会话时使用系统原生保存对话框
- [x] 修复切换设置页签时丢失已填写内容的问题
- [x] 修复使用统计不准确的问题
- [x] 修复自定义Node.js路径的兼容性问题

##### **2026年1月17日（v0.1.5）**

English:
- [x] Add batch grouping for consecutive Read and Edit tool blocks
- [x] Add status message notifications for reconnection and other status info
- [x] Add automatic retries mechanism
- [x] Add Codex MCP server management (CRUD operations)
- [x] Enhance Codex integration with file context injection (@ references)
- [x] Support active file content auto-injection for Codex
- [x] Add AGENTS.md instruction collection support for Codex
- [x] Filter Codex session history by current project path
- [x] Add acceptEdits permission mode for Codex auto-edit approval
- [x] Auto-expand latest thinking block during streaming
- [x] Enhance TodoPanel with current task title and stopped state display
- [x] Add WebSearch to collapsible tool blocks
- [x] Fix MCP popups display issue
- [x] Fix AskUserQuestion tool result handling
- [x] Fix UUID sync for user messages and filesystem I/O timing issue
- [x] Resolve race condition in bridge extraction and improve path handling
- [x] Improve Windows sandbox compatibility (use danger-full-access on Windows)
- [x] Handle JCEF remote mode NPE with dedicated error panel
- [x] Unify tool status indicator styles and layout adjustments
- [x] Support local.properties to specify JDK and Node paths
- [x] Decompose App.tsx into modular components and hooks (2652 → 306 lines)
- [x] Decompose ChatInputBox into modular hooks architecture (8 custom hooks)
- [x] Replace deprecated execCommand with modern Selection API
- [x] Optimize chat interface performance with smart object reuse
- [x] Add multi-level caching and content-visibility optimization
- [x] Add OpenCode provider option
- [x] Improve UI/UX and enhance i18n support

中文:
- [x] 新增连续Read和Edit工具块的批量分组显示
- [x] 新增状态消息通知（重连等状态信息）
- [x] 新增自动重试机制
- [x] 新增Codex MCP服务器管理（增删改查）
- [x] 增强Codex文件上下文注入（支持@引用）
- [x] 支持Codex自动注入当前活动文件内容
- [x] 支持Codex的AGENTS.md指令集合
- [x] 按当前项目路径过滤Codex会话历史
- [x] 新增Codex自动编辑审批的acceptEdits权限模式
- [x] 流式输出时自动展开最新的思考块
- [x] 增强TodoPanel显示当前任务标题和停止状态
- [x] WebSearch加入可折叠工具块
- [x] 修复MCP弹窗显示问题
- [x] 修复AskUserQuestion工具结果处理
- [x] 修复用户消息UUID同步和文件系统I/O时序问题
- [x] 解决bridge解压竞态条件并改进路径处理
- [x] 改进Windows沙箱兼容性（Windows使用danger-full-access模式）
- [x] 处理JCEF远程模式空指针，提供专用错误面板和引导
- [x] 统一工具状态指示器样式和布局调整
- [x] 支持local.properties指定JDK和Node路径
- [x] 重构App.tsx为模块化组件和hooks（2652行→306行）
- [x] 重构ChatInputBox为模块化hooks架构（8个自定义hooks）
- [x] 用现代Selection API替换已废弃的execCommand
- [x] 优化聊天界面性能（智能对象复用）
- [x] 添加多级缓存和content-visibility优化
- [x] 新增OpenCode供应商选项
- [x] 改进UI/UX并增强国际化支持

##### **2026年1月13日（v0.1.5-beta4）**

English:
- [x] Add experimental PyCharm support with Python semantic context collection #pycharm
- [x] Add Codex reasoning effort selector with responsive UI improvements #codex
- [x] Add configurable send shortcut for chat input (Ctrl+Enter / Cmd+Enter)
- [x] Add copy message button for assistant responses
- [x] Fix ai-bridge extraction waiting mechanism improvement
- [x] Fix ai-bridge localization issues
- [x] Adjust Codex button container query breakpoint for better responsiveness
- [x] Update Codex reasoning effort levels

中文:
- [x] 添加实验性 PyCharm 支持，支持 Python 语义上下文收集
- [x] 添加 Codex 推理努力程度选择器，优化响应式 UI
- [x] 添加可配置的发送快捷键（Ctrl+Enter / Cmd+Enter）
- [x] 添加助手回复的复制消息按钮
- [x] 修复 ai-bridge 解压等待机制
- [x] 修复 ai-bridge 国际化问题
- [x] 调整 Codex 按钮容器查询断点，提升响应式体验
- [x] 更新 Codex 推理努力程度级别

##### **2026年1月11日（v0.1.5-beta3）**
English:
- [x] Implement Quick Fix feature with Claude integration (right-click context menu)
- [x] Add npm permission issue detection and auto-fix mechanism with retry support
- [x] Add nvmd (Node Version Manager Desktop) support and custom Node.js path configuration
- [x] Improve tab management: rename tabs to sequential format (AI1, AI2, etc.), add "New Tab" button
- [x] Prevent closing the last tab in tool window
- [x] Pass agent prompt per-tab instead of using global setting
- [x] Add response size guard (1MB limit) to prevent regex issues
- [x] Fix Windows package aiBridge issue
- [x] Fix SDK process error display
- [x] Fix Quick Fix timing and Settings streaming state synchronization issues
- [x] Rename "Quick Fix with Claude" to "Ask Claude Code GUI" with i18n support (8 languages)

中文:
- [x] 实现标签页管理（多开AI功能），添加"新建标签页"按钮
- [x] 实现Quick Fix功能与Claude集成（右键上下文菜单）
- [x] 添加npm权限问题检测和自动修复机制，支持重试
- [x] 添加nvmd（Node版本管理器桌面版）支持和自定义Node.js路径配置
- [x] 防止关闭工具窗口中的最后一个标签页
- [x] 每个标签页独立使用各自选择的智能体，而非全局设置
- [x] 添加响应大小限制（1MB）以防止正则表达式问题
- [x] 修复Windows打包aiBridge问题
- [x] 修复SDK进程错误显示问题
- [x] 修复Quick Fix时序和Settings流式状态同步问题
- [x] 将"Quick Fix with Claude"重命名为"Ask Claude Code GUI"，支持8种语言国际化

##### **2026年1月10日（v0.1.5-beta2）**

English:
- [x] Add streaming transmission toggle switch (Claude Code)
- [x] Add local settings.json provider option with i18n support
- [x] Implement SDK lazy loading architecture with concurrency control
- [x] Add Claude getMcpServerStatus API
- [x] Add JCEF support check and improve input handling
- [x] Improve ai-bridge caching and cleanup mechanism
- [x] Improve IME input handling and UI feedback
- [x] Fix Unix permissions preservation during extraction
- [x] Replace native title tooltips with custom CSS tooltips
- [x] Move vConsole button to top-left corner
- [x] Add contributing guidelines (CONTRIBUTING.md)
- [x] Refactor README with dual AI engine features description
- [x] Improve security and performance optimizations

中文:
- [x] 增加流式传输开关（Claude Code）
- [x] 增加本地 settings.json Provider 选项及国际化支持
- [x] 实现 SDK 懒加载架构，增加并发控制和安全增强
- [x] 增加 Claude getMcpServerStatus API
- [x] 增加 JCEF 支持检测，改进输入处理
- [x] 优化 ai-bridge 缓存和清理机制
- [x] 改进中文输入法处理和 UI 反馈
- [x] 修复解压时 Unix 权限丢失问题
- [x] 工具按钮使用自定义 CSS 提示框替代原生 title
- [x] 将 vConsole 按钮移至左上角
- [x] 添加贡献指南（CONTRIBUTING.md）
- [x] 重构 README，突出双 AI 引擎特性描述
- [x] 提升安全性和性能优化

##### **2026年1月8日（v0.1.5-beta1）**

English:
- [x] Implement conversation rewind feature with message selection dialog and ESC shortcut support
- [x] Add JCEF availability check with user-friendly error panel
- [x] Optimize IME composition detection for better input accuracy
- [x] Add draft input state to preserve content during page navigation
- [x] Add getMcpServerStatus API for MCP server status query
- [x] Improve security: refactor PowerShell command construction to prevent injection
- [x] Improve performance: add caching and timeout safeguards for archive extraction
- [x] Preserve Unix file permissions during extraction
- [x] Add automatic cleanup of outdated ai-bridge cache on plugin version change
- [x] Fix bridge directory null check during extraction

中文:
- [x] 实现对话回退功能，支持消息选择对话框和 ESC 快捷键
- [x] 添加 JCEF 可用性检查，提供友好的错误提示面板
- [x] 优化输入法组合检测，提升输入准确性
- [x] 添加草稿输入状态，页面导航时保留内容
- [x] 添加 getMcpServerStatus API，支持查询 MCP 服务器状态
- [x] 安全改进：重构 PowerShell 命令构建以防止注入攻击
- [x] 性能改进：为压缩包解压添加缓存和超时保护
- [x] 解压时保留 Unix 文件权限
- [x] 插件版本更新时自动清理过期的 ai-bridge 缓存
- [x] 修复解压过程中桥接目录空指针检查

##### **2026年1月7日（v0.1.4）**

English:
- [x] Integrate Codex conversation functionality #codex
- [x] Implement Codex environment variable key reading
- [x] Implement Codex provider editing
- [x] Implement Codex agent support
- [x] Implement Codex usage statistics
- [x] Implement Codex enhanced prompts (actually powered by Claude)
- [x] Implement asynchronous extraction on first launch to prevent IDEA blocking
- [x] Disable slash command periodic update to resolve abnormal API request issues

中文:
- [x] 适配Codex对话功能
- [x] 实现Codex读取环境变量Key的功能
- [x] 实现Codex供应商编辑
- [x] 实现Codex智能体
- [x] 实现Codex使用统计
- [x] 实现Codex增强提示词（其实走的是Claude）
- [x] 实现首次异步解压，防止阻塞IDEA
- [x] 禁用斜杠指令定时更新功能，解决异常定时请求接口的问题

##### **2026年1月5日（v0.1.4-beta7）**

English:
- [x] P1 (fix) Fix permission dialog rejection issue in proxy mode
- [x] P1 (feat) Support official subscription-based login on macOS
- [x] P2 (fix) Resolve some error messages

中文:
- [x] P1 (fix) 修复代理模式下权限弹窗被拒绝的问题
- [x] P1 (feat) 适配Mac下官方订阅制登录的功能
- [x] P2 (fix) 解决某些报错提示

##### **2026年1月5日（v0.1.4-beta6）**

English:
- [x] P0 (bug) Fix permission dialog exception causing plugin black screen issue on Windows

中文:
- [x] P0（BUG）修复权限弹窗异常导致 Windows 下插件黑屏的问题

##### **2026年1月4日（v0.1.4-beta5）**

English:
- [x] P0 (feat) Support asking questions from CLI login state (initial) #LaCreArthur
- [x] P1 (feat) Auto-localization based on IDEA language settings
- [x] P1 (improve) Refine localization text details
- [x] P1 (feat) Add enable/disable toggle for MCP servers
- [x] P1 (feat) Add /init and /review built-in slash commands
- [x] P1 (perf) Optimize initial slash command loading logic
- [x] P1 (style) Polish UI details
- [x] P2 (feat) Support Ask User Question feature
- [x] P3 (improve) Fallback UI font to editor font #gadfly3173

中文:
- [x] P0（feat）支持从 CLI 登录状态下进行提问的功能（初版） #LaCreArthur
- [x] P1（feat）读取 IDEA 语言信息，自动本地化
- [x] P1（improve）完善本地化文案细节
- [x] P1（feat）MCP 服务器支持开启/关闭功能
- [x] P1（feat）新增 /init 和 /review 斜杠内置命令
- [x] P1（perf）优化首次加载斜杠指令逻辑
- [x] P1（style）优化部分 UI 细节
- [x] P2（feat）适配 Ask User Question 功能
- [x] P3（improve）UI 字体回落至编辑器字体 #gadfly3173

##### **2026年1月2日（v0.1.4-beta3）**

- [x] P0（feat）实现初版Agent智能体功能（提示词注入）
- [x] P1（fix）修复进入到历史记录再回来页面对话异常问题 #ｓｕ＇ｑｉａｎｇ
- [x] P2（fix）修复文件引用标签显示不存在文件夹的问题 #ｓｕ＇ｑｉａｎｇ
- [x] P2（feat）完善node版本检查 #gadfly3173

##### **2026年1月1日（v0.1.4-beta2）**

- [x] P0（feat）添加强化提示功能 #xiexiaofei
- [x] P1（feat）支持艾特多个文件的
- [x] P1（feat）优化选中文案提示词，解决AI识别不稳定的问题
- [x] P2（fix）修复删除会话后仍显示已删除会话的问题 #ｓｕ＇ｑｉａｎｇ
- [x] P2（feat）取消用户发送信息MD渲染，取消默认删除换行空格
- [x] P2（feat）增加当前字体信息展示功能
- [x] P2（feat）增加供应商设置JSON-格式化按钮
- [x] P3（fix）解决下拉列表点击不了的问题（PR#110产生的小问题）

##### **12月31日（v0.1.4-beta1）**

- [x] P1（feat）增加读取IDE字体设置
- [x] P2（feat）显示mcp服务连接状态 #gadfly3173e
- [x] P3（fix）增加用户提问问题上下折叠功能（在长度超过7行触发）
- [x] P3（UI）优化部分UI展示效果

##### **12月30日（v0.1.3）**

- [x] P1（fix）完善异常情况下的错误提醒

##### **12月26日（v0.1.2-beta7）**

- [x] P0（feat）默认增加CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC为"1"，降低遥测等问题
- [x] P1（fix）减少无法操作思考模式的问题
- [x] P1（fix）减少某些情况下一直重复编辑的问题
- [x] P3（UI）优化输入框更多功能弹窗UI触发区域

##### **12月25日（v0.1.2-beta6）**

- [x] P1（ui）将模式切换入口放到最外层
- [x] P1（feat）修复输入法组合输入渲染残留问题 #gadfly3173e
- [x] P2（BUG）修复主动思考按钮无法点击问题
- [x] P3（UX）优化三级菜单弹窗交互效果

##### **12月25日（v0.1.2-beta5）**

- [x] P0（fix）优化性能，解决输入框输入卡顿的问题（6000+对话也不卡）
- [x] P1（feat）增加主动思考配置入口
- [x] P1（fix）解决某些情况下cc-switch.db文件解析有问题
- [x] P2（fix）再次优化代码，降低window下出现无法编辑写入的BUG
- [x] P2（fix）再次优化代码，降低权限弹窗弹到其他窗口的概率
- [x] P2（fix）完善工具过程展示（之前默认全展示为成功，现在会有过程）#gadfly3173e

##### **12月25日（v0.1.2-beta4）**

- [x] P0（BUG）修复某些情况下，AI无法写入编辑的问题
- [x] P2（fix）优化提示词，解决#Lxxx-xxx 类型引入无法被AI准确理解的问题
- [x] P2（feat）实现模式切换持久化存储（不会随编辑器关闭而重置）
- [x] P3（feat）实现代码块区域复制功能

##### **12月24日（v0.1.2-beta3）**

- [x] P0（feat）实现Claude Code 模式切换功能（包括全自动权限模式）
- [x] P1（UI）优化了输入框底部按钮区域交互样式
- [x] P3（UI）优化了代码块展示样式

##### **12月23日（v0.1.2-beta2）**

- [x] P0（BUG）解决斜杠指令无法弹出的问题
- [x] P3（UI）增加90%字体的设置样式
- [x] P3（UI）优化历史对话记录样式间距过大问题（统一为对话过程中那种紧凑样式）
- [x] P3（UI）修复亮色模式下某些样式问题

##### **12月21日（v0.1.2）**

- [x] 增加字体缩放功能
- [x] 增加DIFF对比功能
- [x] 增加收藏功能
- [x] 增加修改标题功能
- [x] 增加根据标题搜索历史记录功能
- [x] 修复 alwaysThinkingEnabled 失效问题

##### **12月18日（v0.1.1-beta4）**

- [x] 解决 开启多个IDEA终端，权限弹窗 异常问题
- [x] 支持消息导出功能 #hpstream
- [x] 修复删除历史记录的某个小bug
- [x] 整体优化部分逻辑代码 #gadfly3173e

##### **12月11日（v0.1.1）**

- [x] P0（feat）实现当前打开的文件路径（将当前打开的文件信息默认发送给AI）
- [x] P0（feat）实现国际化功能
- [x] P0（feat）重构供应商管理列表，支持导入cc-switch配置
- [x] Pfeat）实现文件支持拖拽入输入框的功能（#gadfly3173 PR）
- [x] P1（feat）增加删除历史会话功能（由群友 PR）
- [x] P1（feat）增加Skills功能（由群友 PR）
- [x] P1（feat）增加右键选中代码，发送到插件的功能（#lxm1007 PR）
- [x] P1（fix）完善和重构 @文件功能，使@文件功能变得好用
- [x] P2（fix）解决输入框部分快捷操作失效的问题

##### **12月5日（v0.0.9）**

- [x] P0（feat）支持基础版本的MCP
- [x] P0（fix）解决window下，输入某些字符导致错误的问题
- [x] P0（fix）解决window下，使用node安装claude路径无法识别的问题
- [x] P0（fix）解决输入框光标无法快捷移动的问题
- [x] P0（fix）修改配置页面，之前只能展示两个字段，现在可以配置和展示多个字段
- [x] P1（feat）增加回到顶部，或者回到底部 按钮功能
- [x] P2（feat）支持文件信息点击跳转功能
- [x] P2（UI）优化权限弹窗样式
- [x] P2（fix）解决DIFF组件统计不精准的问题
- [x] P3（fix）打开历史会话自动定位到最底部
- [x] P3（fix）优化文件夹可点击效果
- [x] P3（fix）优化输入框工具切换icon
- [x] P3（fix）取消MD区域文件可点击功能
- [x] P3（UI）解决渠道删除按钮背景颜色问题
- [x] P3（fix）将点击供应商链接调跳转改为复制链接，以防止出现问题




##### **12月2日（v0.0.8）**

- [x] P0（feat）增加主动调整Node路径的功能，用以适配五花八门的Node路径
- [x] P1（feat）增加白色主题
- [x] P1（feat）将渠道配置功能与cc-switch解耦，防止规则改变导致渠道丢失
- [x] P1（feat）增加各种错误情况下的提示功能，减少空白展示情况
- [x] P1（feat）优化@文件功能（回车发送问题还未解决）
- [x] P2（fix）解决 运行命令 右侧小圆点总是展示置灰的问题
- [x] P2（fix）解决对话超时后，新建对话，原来的对话还在执行，点停止按钮也没反应
- [x] P2（UX）优化多处其他UI以及交互细节
- [x] P3（chore）插件兼容23.2版本IDEA版本




---

##### **12月1日（v0.0.7-beta2）**

- [x] P0: 重构代码 channel-manager.js 和 ClaudeSDKBridge.java 主代码
- [x] P1: 解决某些三方API兼容性问题

##### **11月30日（v0.0.7）**

- [x] P0: 支持选择 Opus4.5 进行提问
- [x] P0: 将权限弹窗由系统弹窗改为页面内弹窗，并且增加了允许且不再询问的功能
- [x] P1: 重构展示区域UI效果
- [x] P3: 优化顶部按钮展示问题
- [x] P3: 优化Loding样式
- [x] P5: 优化样式细节




##### **11月27日（v0.0.6）**

- [x] 重构 输入框UI交互
- [x] 输入框 支持发送图片
- [x] 输入框 支持模型容量统计
- [x] 优化 数据统计页面 UI样式
- [x] 优化 设置页面侧边栏展示样式
- [x] 重构 多平台兼容性问题
- [x] 解决某些特殊情况下响应无法中断的BUG




##### **11月26日（v0.0.5）**

- [x] 增加使用统计
- [x] 解决Window下新建问题按钮失效问题
- [x] 优化一些细节样式



##### **11月24日（v0.0.4）**

- [x] 实现简易版本cc-switch功能
- [x] 解决一些小的交互问题




##### **11月23日（v0.0.3）**

- [x] 解决一些核心交互阻塞流程
- [x] 重构交互页面UI展示



##### **11月22日**

- [x] 改进临时目录与权限逻辑
- [x] 拆分纯html，采用 Vite + React + TS 开发
- [x] 将前端资源CDN下载本地打包，加快首屏速度


##### **11月21日（v0.0.2）**

完成简易的，GUI对话 权限控制功能


文件写入功能展示



##### 11月20日

完成简易的，GUI对话基础页面


完成简易的，GUI对话页面，历史消息渲染功能


完成简易的，GUI页面，对话 + 回复 功能（**完成 claude-bridge 核心**）


##### 11月19日（v0.0.1） - 实现历史记录读取功能
