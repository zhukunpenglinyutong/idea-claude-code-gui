# Claude 中转厂商用量查询扩展（多厂商接入）

- 日期：2026-09-02
- 分支：`feature/v0.5.6`
- 状态：阶段一已完成（单测全绿；`CliStatusDetectorLoginShellTest` 为预存的环境相关失败，与本特性无关）

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
| 阿里 DashScope | 阿里云 BSS `QueryAccountBalance` | AK/SK + HMAC-SHA1 RPC 签名 | ¥ 余额 | 三 |
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

## 6. 阶段三（独立 PR）：余额型厂商

- webview `PlanUsageSnapshot` 增加可选 `balance{remaining, total?, unit}`，
  `PlanUsageIndicator` 有余额时显示金额（如 `¥42.50`）替代百分比条，tooltip 放明细。
- 接入 DeepSeek / SiliconFlow（国内外双端点，CNY/USD）/ StepFun / Moonshot /
  OpenRouter / Novita（金额 ÷10000）/ 阿里 BSS（AK/SK + HMAC-SHA1）。

## 7. 风险

1. MiniMax / Kimi Coding 的接口无官方公开文档，解析基于其线上实际响应格式实现；
   字段变更时探测失败 → stale 缓存兜底 → 静默回落 rate_limit，不影响主流程。
2. 国内/国际双端点按 base URL 域名区分，自建反代域名识别不到（与 z.ai 现状一致）。
3. MiniMax `model_remains` 多模型条目按"当前模型 → general → 第一条"选取，
   展示的是所选模型的配额，用户切模型后最多 115s 内刷新。
