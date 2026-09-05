# Claude 中转厂商用量查询扩展（多厂商接入）

- 日期：2026-09-02
- 分支：`feature/v0.5.6`
- 状态：阶段一、阶段三已完成（阶段二火山 Ark 跳过）；单测全绿（Java / webview 用例数见下）

## 1. 背景与目标

`ClaudePlanUsageService` 目前只识别 z.ai / bigmodel.cn 一种中转后端，命中后探测
`{origin}/api/monitor/usage/quota/limit`；其余后端回落到 SDK `rate_limit_event` 缓存。

目标：把"识别后端 → 探测厂商 API → 解析为 capacity payload"抽象为可插拔的
`RelayUsageVendor` SPI，按 `ANTHROPIC_BASE_URL` host 匹配分发，分阶段接入国内厂商。
输出契约（`capacity_pct` + `windows[]{id, used_pct, reset_at, period_type}`，见
`webview/src/utils/planUsagePace.ts` 的 `parseCapacityPayload`）保持不变，webview 零改动。

## 2. 厂商能力矩阵

| 厂商 | 用量 API | 认证 | 数据形态 | 阶段 |
|---|---|---|---|---|
| 智谱 GLM（z.ai / bigmodel.cn） | `{origin}/api/monitor/usage/quota/limit` | 现有 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` | 5h/7d/月 百分比 | 已有 → 迁入 SPI |
| MiniMax Coding Plan（minimaxi.com / minimax.io） | `{origin}/v1/api/openplatform/coding_plan/remains` | 同上（Bearer） | 5h/7d/月 剩余% | **一** |
| Kimi For Coding（api.kimi.com/coding） | `{origin}/coding/v1/usages` | 同上（Bearer） | 5h/7d limit/remaining | **一** |
| 火山引擎 Ark（volces.com） | `open.volcengineapi.com` `GetAFPUsage` → `GetCodingPlanUsage` 回落 | AccessKey/Secret（新增 env），HMAC-SHA256 V4 签名 | 5h/7d/月 百分比 | 二 |
| DeepSeek / 硅基流动 / StepFun / Moonshot / OpenRouter / Novita | 各自余额接口 | Bearer | ¥/USD 余额，无百分比分母 | 三（需 webview 余额渲染） |
| 小米 MiMo | `platform.xiaomimimo.com/api/v1/tokenPlan/usage` | 浏览器 Cookie | 月度百分比 | **不做**（Cookie 为完整会话凭证，敏感且易过期） |
| 百度千帆 / 腾讯混元 / 讯飞星辰 | 无公开 API | — | — | 不做 |

## 3. 架构

新增 `com.github.claudecodegui.provider.claude.usage` 包：

```
provider/claude/usage/
├── RelayUsageVendor.java     # SPI：id() / matches(host, path) / probe(env)
├── RelayUsageEnv.java        # 从 settings.env 提取 baseUrl/token/model 的值对象
├── RelayUsageRegistry.java   # 有序厂商表 + host 匹配 + 缓存/stale 编排
├── RelayUsageCache.java      # 由 ZaiCache 泛化：key=vendor+baseUrl+token，TTL 115s，stale 兜底 30min
├── RelayUsageHttp.java       # 共享 GET（HttpClient、超时、UA、TLS-only 规则）+ 测试 transport 缝
├── RelayUsageJson.java       # 共享 JSON 取值/clamp/窗口与 capacity payload 构造
├── ZaiUsageVendor.java       # 现有 z.ai 逻辑原样迁入（含窗口合并取最差、level、TIME_LIMIT→monthly）
├── MiniMaxUsageVendor.java   # 剩余%→已用%；模型回退链；weekly_status 门控
└── KimiCodingUsageVendor.java # window.duration 判别 5h/7d；remaining/used 双兼容
```

要点：

- `ClaudePlanUsageService` 保持门面不变（`resolvePlanUsagePayload` 签名、
  `cacheRateLimitInfo`、`ClaudePlanUsageHandler` 全不动），内部改为委托
  `RelayUsageRegistry.resolve(settings, nowMs)`，未命中/探测失败回落 rate_limit 缓存。
- 厂商注册顺序语义：`kimi-coding` 必须先于（未来阶段的）`kimi`/`moonshot`，
  因为 api.kimi.com 同时承载两类入口（path 含 `/coding` 才是 Coding Plan）。
- host 匹配用 `URI.getHost()` 等于/后缀比较，避免全 URL 子串匹配
  （`url.includes('glm')` 之类会被 path 误触发）。
- 安全规则沿用 `monitorUrl` 先例：远端必须 HTTPS，明文 HTTP 仅放行 loopback；
  缓存 key 含 token，账号切换不会串台。

## 4. 阶段一（本次）范围

1. SPI + 注册表 + 缓存/HTTP/JSON 基建（上述 6 个基础文件）。
2. z.ai 逻辑迁移（行为等价，现有测试随之迁移）。
3. 新增 MiniMax、Kimi For Coding 两个 vendor。
4. 测试：每 vendor 解析 fixture、host 识别、
   缓存 TTL/stale、凭证回退链；`gradlew test` 全绿。

## 5. 阶段二（下一个 PR）：火山 Ark

- `VolcengineUsageVendor`：JDK 自带 `javax.crypto.Mac`（HmacSHA256）+ `MessageDigest`
  实现 V4 签名，无新依赖；`GetAFPUsage` 失败回落 `GetCodingPlanUsage`。
- AK/SK 从 settings env 读，变量名兼容 `VOLCENGINE_ACCESS_KEY`/`VOLCENGINE_SECRET_KEY`
  与官方 SDK 的 `VOLCENGINE_ACCESSKEY`/`VOLCENGINE_SECRETKEY`；未配置时静默跳过。
- host 匹配 `volces.com`；返回 5h/7d/月百分比窗口，仍无需 webview 改动。

## 6. 阶段三（已完成）：余额型厂商

- webview `PlanUsageSnapshot` 增加可选 `balance{remaining, total?, used?, unit}`，
  `parseCapacityPayload` 接受 balance-only payload；`PlanUsageIndicator` 有余额且无
  windows 时显示金额（`formatBalance`：CNY→`¥42.50`、USD→`$12.34`）替代百分比条，
  tooltip 放明细（余额/总额/已用，OpenRouter 有总额），余额 ≤0 时红色。
- Java 侧：`RelayUsageJson.balancePayload()` + `Balance` record；`BalanceUsageVendor`
  模板基类（secureOrigin → Bearer GET → parseBalance）。
- 接入 4 个 vendor：
  - DeepSeek `{origin}/user/balance`：`balance_infos[0].total_balance`，币种读响应 `currency`。
  - Moonshot `{origin}/v1/users/me/balance`：`data.available_balance`（兼容 `balance`/
    `total_balance` 变体），CNY。
  - OpenRouter `{origin}/api/v1/credits`：remaining = `total_credits − total_usage`，
    唯一带 total/used 的厂商，USD。
  - （SiliconFlow / StepFun / Novita / 阿里 DashScope 曾实现，后按要求移除，见第 7 节。）

## 7. 厂商清单与 host 匹配

本项目按 `ANTHROPIC_BASE_URL` 自动识别厂商，`matches()` 对齐各厂商
**Claude Code 兼容端点**的 host。只做两类查询：「coding plan 订阅限额」
（百分比窗口）与「余额」（金额）。

| vendor | 形态 | 匹配 host | 查询端点 |
|---|---|---|---|
| zai | 订阅限额 | `z.ai`（含子域）、`open.bigmodel.cn`（含子域） | `{origin}/api/monitor/usage/quota/limit` |
| minimax | 订阅限额 | `minimaxi.com`（含子域）、`minimax.io`（含子域） | `{origin}/v1/api/openplatform/coding_plan/remains` |
| kimi-coding | 订阅限额 | `api.kimi.com` + path `/coding` | `{origin}/coding/v1/usages` |
| opencode | 订阅限额 | `opencode.ai` | `{origin}/zen/go/v1/usage`（rolling→5h / weekly→7d / monthly；`percent` 为已用%） |
| moonshot | 余额 | `api.moonshot.cn`、`api.moonshot.ai` | `{origin}/v1/users/me/balance` |
| deepseek | 余额 | `api.deepseek.com` | `{origin}/user/balance` |
| openrouter | 余额 | `openrouter.ai` | `{origin}/api/v1/credits`（remaining = total_credits − total_usage） |


## 8. 风险

1. MiniMax / Kimi Coding 的接口无官方公开文档，解析基于其线上实际响应格式实现；
   字段变更时探测失败 → stale 缓存兜底 → 静默回落 rate_limit，不影响主流程。
2. 国内/国际双端点按 base URL 域名区分，自建反代域名识别不到（与 z.ai 现状一致）。
3. MiniMax `model_remains` 多模型条目按"当前模型 → general → 第一条"选取，
   展示的是所选模型的配额，用户切模型后最多 115s 内刷新。
