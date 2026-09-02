# 消息队列操作增强计划

**日期**: 2026-08-26  
**状态**: 阶段 A/C 已实现；阶段 B 待执行
**范围**: `webview/src/hooks/useMessageQueue.ts`、`webview/src/components/ChatInputBox/*`、`webview/src/components/ChatScreen.tsx`、`webview/src/App.tsx`  
**目标**: 在保持现有前端队列机制和后端消息协议不变的前提下，增强消息队列项的排序、置顶/置尾、编辑、插入、打断和删除能力。

---

## 背景与现状

当前消息队列已经存在，但能力较轻：

- 队列逻辑位于 `webview/src/hooks/useMessageQueue.ts`。
- 忙碌时发送消息会进入队列。
- 当前 AI 任务结束后，自动取 `queue[0]` 继续执行。
- `MessageQueue.tsx` 当前只展示消息预览和删除按钮。
- 消息预览已通过 `title={item.content}` 支持悬浮查看全文。
- `App.tsx → ChatScreen.tsx → ChatInputBox.tsx → ChatInputBoxHeader.tsx → MessageQueue.tsx` 存在实际的 props 透传链路；不能只修改 `App.tsx` 和输入框组件。

需要特别注意：当前 UI 是**倒序队列展示**。

- 数据结构中 `queue[0]` 是下一条执行，也就是逻辑队首。
- UI 使用 `[...queue].reverse()` 展示，因此逻辑队首位于视觉底部、靠近输入框。
- 逻辑队尾位于视觉顶部、最后执行。
- 所有按钮的文字提示必须以“下一条执行 / 最后执行”说明实际效果，不能只写“顶部 / 底部”。

---

## 已确认的技术决策

### 1. 不改后端协议

本次只增强前端队列操作，不新增 Java 或 ai-bridge 消息协议。

- 当前队列本身是前端状态。
- “插入”定义为移动到逻辑队首，等待当前轮自然结束后执行。
- “打断”复用现有 `interrupt_session` 事件，不新增后端能力。
- 打断后不立即发送 `send_message`，而是等待后端实际触发 `onStreamEnd` 后，再由 hook 消费逻辑队首；不能把前端本地 `loading` 从 `true` 变为 `false` 当作中断完成信号。

### 2. 保持局部改动

- 排序、置顶、置尾、编辑都只操作 hook 内的 `queue` 数组。
- UI 和交互集中在 `MessageQueue.tsx`。
- `ChatInputBoxHeader`、`ChatInputBox` 与 `ChatScreen` 仅透传回调。
- `App.tsx` 注入 `executeMessage` 与 `interruptSession`，不承载队列数组操作。

### 3. 队首 / 队尾采用 Lucide 图标，不用 CSS 拼图标

项目 `webview/package.json` 已含 `lucide-react`，无需新增依赖。

| 操作 | 使用组件 | 视觉含义 | 逻辑含义 | 必须的 title / aria-label |
| --- | --- | --- | --- | --- |
| 移到队首 | `ArrowDownToLine` | 下箭头指向底线 | 移动到 `queue[0]`，下一条执行 | 移动到队首（下一条执行） |
| 移到队尾 | `ArrowUpToLine` | 上箭头指向顶线 | 移动到 `queue[queue.length - 1]`，最后执行 | 移动到队尾（最后执行） |

说明：

- 不使用 `codicon-arrow-up` / `codicon-arrow-down`，因为它们没有“移动到边界”的横线语义。
- 不使用 `codicon-fold-up` / `codicon-fold-down`，因为其含义是折叠，不是队列移动。
- 不再定义 `.message-queue-jump-front-icon` 与 `.message-queue-jump-back-icon` 这类 CSS 绘制图标 class。
- 两个 Lucide 图标统一设置与 Codicon 相近的 `size={14}`、`strokeWidth={2}`，并通过现有按钮颜色继承 `currentColor`。

### 4. 保持倒序展示不变

- 逻辑队首：`queue[0]`，视觉底部，下一条执行。
- 逻辑队尾：`queue[queue.length - 1]`，视觉顶部，最后执行。
- 队列序号沿用当前逻辑序号：`1` 表示下一条执行，而不是视觉上的第一行。

---

## 最终队列项 UI

常规态（视觉上从顶部的队尾到下方的队首倒序显示）：

```text
[⠿ 拖柄] [↑][↓] [↓─][─↑]   消息预览（悬浮全文） …………  [✎ 编辑] [■ 打断] [▶ 插入] [× 删除]
```

编辑态：

```text
[⠿ 拖柄] [↑][↓] [↓─][─↑]   [textarea：预填原文] …………  [✓ 保存] [× 取消]
```

### 图标与操作约定

#### 左侧调序区

| 操作 | 图标 / 组件 | 行为 | 禁用规则 | title / aria-label |
| --- | --- | --- | --- | --- |
| 拖动 | `codicon-gripper` | 拖放重排 | 无 | 拖动调整顺序 |
| 上移一步 | `codicon-arrow-up` | 在视觉列表中上移一位，即在逻辑执行顺序中后移一位 | 已是 `queue[queue.length - 1]`（视觉顶部）时禁用 | 上移一位（更晚执行） |
| 下移一步 | `codicon-arrow-down` | 在视觉列表中下移一位，即在逻辑执行顺序中前移一位 | 已是 `queue[0]`（视觉底部）时禁用 | 下移一位（更早执行） |
| 移到队首 | `ArrowDownToLine`（Lucide） | 移动到 `queue[0]`，成为下一条执行 | 已在 `queue[0]` 时禁用 | 移动到队首（下一条执行） |
| 移到队尾 | `ArrowUpToLine`（Lucide） | 移动到 `queue[queue.length - 1]`，最后执行 | 已在 `queue[queue.length - 1]` 时禁用 | 移动到队尾（最后执行） |

> 倒序展示中，逻辑队首在视觉底部、逻辑队尾在视觉顶部。因此边界移动图标按**视觉位置**表达：`ArrowDownToLine` 表示移到底部的下一条执行，`ArrowUpToLine` 表示移到顶部的最后执行。

#### 右侧操作区

| 操作 | 图标 | 可用状态 | 行为 | 悬浮反馈 | title / aria-label |
| --- | --- | --- | --- | --- | --- |
| 编辑 | `codicon-edit` | 常规态 | 进入本条内联编辑 | 中性 | 编辑本条消息 |
| 打断 | `codicon-stop` | 常规态 | 打断当前任务并安排本条优先执行 | 红色弱警示 | 打断当前任务并优先执行本条 |
| 插入 | `codicon-play` | 常规态 | 将本条移到下一次执行，不打断当前任务 | 蓝色 | 插入到下一次执行 |
| 删除 | `codicon-close` | 常规态 | 从队列移除本条 | 中性 / 弱警示 | 从队列移除 |
| 保存 | `codicon-check` | 编辑态，且 `draft.trim()` 非空 | 保存编辑内容 | 中性 | 保存修改 |
| 取消 | `codicon-close` | 编辑态 | 放弃草稿并恢复常规态 | 中性 | 取消编辑 |

交互约束：

- 所有 `<button>` 显式设置 `type="button"`，避免未来被放入表单时触发表单提交。
- 所有仅图标按钮同时具备 `title` 和 `aria-label`；两者文案相同。
- 编辑时隐藏“编辑 / 打断 / 插入 / 删除”，只显示“保存 / 取消”。排序按钮和拖柄仍保留，以便在编辑中调整顺序。
- 编辑中的 `textarea` 只修改 `content`，保留原始 `attachments` 与 `queuedAt`。
- 空白内容（`trim()` 后为空）禁用保存；取消不写入队列。
- 一个时刻只允许一个队列项处于编辑态；点击另一项编辑时，直接切换编辑目标且不保存前一项草稿。

---

## 操作定义与边界规则

### 单步调序

- `moveUp(id)`：使该项在**逻辑执行顺序**中前移一位，即数组索引减一。
- `moveDown(id)`：使该项在**逻辑执行顺序**中后移一位，即数组索引加一。
- UI 是倒序展示，因此视觉 `↑` 必须调用 `moveDown(id)`：该项向视觉顶部移动一位，同时更晚执行；已是 `queue[queue.length - 1]`（视觉顶部）时禁用。
- 视觉 `↓` 必须调用 `moveUp(id)`：该项向视觉底部移动一位，同时更早执行；已是 `queue[0]`（视觉底部）时禁用。
- 两个单步按钮的 `title` / `aria-label` 分别为“上移一位（更晚执行）”和“下移一位（更早执行）”，避免将视觉方向误解为执行顺序。

### 移动到队首 / 队尾

- `moveToFront(id)`：移除原项后插入索引 `0`；已在队首时按钮禁用。
- `moveToBack(id)`：移除原项后追加到数组末尾；已在队尾时按钮禁用。
- 边界操作直接调用同名逻辑方法，不按单步按钮反向映射；目标语义由“下一条执行 / 最后执行”明确：
  - `ArrowDownToLine` → `moveToFront`，移到队首（视觉底部、下一条执行）。
  - `ArrowUpToLine` → `moveToBack`，移到队尾（视觉顶部、最后执行）。

### 拖动调序

使用 HTML5 原生 drag-and-drop，不引入新的拖拽依赖：

- 只有左侧 `codicon-gripper` 拖柄可拖动；拖柄设置 `draggable`，并保留 `cursor: grab / grabbing`。
- 每个队列项都是放置目标；`onDragOver` 必须 `preventDefault()`，否则不能触发 drop。
- `dragId` 用组件内部 ref 保存，`dragover` 时以 state 保存当前 `targetId`，用于添加放置高亮。
- `onDrop` 调用 `reorder(dragId, targetId)`；自身拖到自身为 no-op。
- `reorder(dragId, targetId)` 的确定语义：将拖动项插入到**目标项当前逻辑索引**，即拖动项最终位于目标项之前（更早执行）。先移除拖动项，再计算目标项在剩余数组中的索引，避免拖动方向不同导致 off-by-one。
- `dragend` 无论是否成功放下，都清理 `dragId` 和高亮状态。

> 该语义不会区分“目标项上半区 / 下半区”。如果后续需要拖放到目标项之后，再单独扩展 `before | after` 的插入位置；本次不增加复杂命中逻辑。

### 编辑消息

- 点击编辑后，预览区域替换为 `textarea`，初值为 `item.content`。
- 保存调用 `update(id, draft.trim())`；不修改附件、时间戳和队列位置。
- 取消恢复普通态，不调用 `update`。
- 编辑中的 Enter 仅输入换行；不触发 ChatInputBox 发送逻辑。

### 插入

- `insert(id)` 仅是 `moveToFront(id)` 的语义别名。
- 不发送中断事件，也不直接调用 `onExecute`。
- 若当前任务正在执行：本条在当前轮自然结束后成为下一条。
- 若当前任务已结束但项仍暂存在队列中：仅调整位置，仍由 hook 的队列消费逻辑处理；不在 UI 层直接发送。
- 按钮提示：`插入到下一次执行`。

### 打断

- `interruptAndSendNow(id)` 是 hook 对 UI 暴露的复合操作。
- 忙碌时：先 `moveToFront(id)`，再调用 `onInterrupt?.()`；`onInterrupt` 由 `App.tsx` 传入现有 `interruptSession`（其内部会发送 `interrupt_session`）。目标项仅在后端 `onStreamEnd` 回调抵达后才消费发送。
- 空闲时：从队列移除该项后，直接调用 `onExecute(content, attachments)`，不调用 `onInterrupt`。
- 忙碌判断必须读取 hook 当前 render 的 `isLoading`，不由 `MessageQueue` 自行推断；`interruptSession` 的本地 `loading=false` 不能提前放行消息发送。
- 按钮提示：`打断当前任务并优先执行本条`；hover 使用红色弱警示。

### 删除

- 调用 `dequeue(id)`。
- 不影响当前正在执行的任务。
- 如果删除的正是编辑项，组件应退出编辑态并清空草稿。

---

## Hook API 与实现要求

### `webview/src/hooks/useMessageQueue.ts`

扩展 `UseMessageQueueOptions`：

```ts
interface UseMessageQueueOptions {
  isLoading: boolean;
  onExecute: (content: string, attachments?: Attachment[]) => void;
  onInterrupt?: () => void;
}
```

扩展 `UseMessageQueueReturn`：

```ts
update: (id: string, content: string) => void;
moveUp: (id: string) => void;
moveDown: (id: string) => void;
moveToFront: (id: string) => void;
moveToBack: (id: string) => void;
reorder: (dragId: string, targetId: string) => void;
insert: (id: string) => void;
interruptAndSendNow: (id: string) => void;
```

实现约束：

- 所有数组操作都使用 `setQueue(prev => ...)` 函数式更新，避免闭包中使用过期 queue。
- 未找到 `id`、边界移动、同一 `dragId/targetId` 均返回原数组引用，不产生无效更新。
- `update` 接收的内容由调用方完成 trim；hook 不擅自丢弃用户输入中的换行。
- `interruptAndSendNow` 在空闲直接执行时，必须先从队列移除，再调用 `onExecute`，防止被自动消费逻辑重复发送。
- 保留现有 `enqueue`、`dequeue`、`clearQueue`、`hasQueuedMessages` 以及 loading 完成后自动执行 `queue[0]` 的行为。
- 现有 `setTimeout(..., 50)` 与 `isExecutingFromQueueRef` 保留；打断路径增加后端 `onStreamEnd` 放行，避免本地状态切换造成的调度竞态。

---

## 文件改动计划

### `webview/src/hooks/useMessageQueue.ts`

- 按“Hook API 与实现要求”新增方法和可选 `onInterrupt`。
- 保持 `QueuedMessage` 的字段结构不变。

### `webview/src/hooks/useMessageQueue.test.ts`（新增）

采用现有 Vitest + React hook 测试方式，覆盖：

- `moveUp`：普通前移、队首不变、未知 id 不变。
- `moveDown`：普通后移、队尾不变、未知 id 不变。
- `moveToFront` / `moveToBack`：顺序正确、边界 no-op。
- `reorder`：从前向后和从后向前拖动、拖到自身、未知 id。
- `update`：仅更新文本，附件、时间戳和相对位置保持不变。
- `insert`：结果等价于 `moveToFront`。
- `interruptAndSendNow`：忙碌时置顶并调用 `onInterrupt`；空闲时移除后调用 `onExecute`，不调用 `onInterrupt`。
- loading 由 `true → false` 时仍只消费逻辑队首一次。

### `webview/src/components/ChatInputBox/MessageQueue.tsx`

- 导入 `ArrowDownToLine`、`ArrowUpToLine`（来自 `lucide-react`）。
- 扩展 props：`onUpdate`、`onMoveUp`、`onMoveDown`、`onMoveToFront`、`onMoveToBack`、`onReorder`、`onInterrupt`、`onInsert`，以及保留 `onRemove`。
- 保持 `[...queue].reverse()` 展示及现有序号计算。
- 实现拖柄、单步排序、边界移动、内联编辑、打断、插入、删除和拖放高亮。
- 将可复用的图标按钮统一使用同一 class，避免对每个按钮复制尺寸、焦点和禁用态样式。
- 不对队列项目整体设置 `draggable`，只在拖柄上设置，避免与 textarea 的文本选择冲突。

### `webview/src/components/ChatInputBox/MessageQueue.test.tsx`（新增）

覆盖最小 UI 合同：

- 倒序展示和“队列序号 1 是下一条执行”。
- `ArrowDownToLine` / `ArrowUpToLine` 按钮存在，且具有正确的 title / aria-label。
- 队首的上移与移到队首禁用；队尾的下移与移到队尾禁用。
- 编辑进入、保存、空内容禁用保存、取消。
- 打断 / 插入 / 删除分别调用对应回调。
- 拖拽事件最终调用 `onReorder(dragId, targetId)` 并在结束后清理高亮。

### `webview/src/components/ChatInputBox/ChatInputBoxHeader.tsx`

- 声明并透传全部新增队列回调到 `MessageQueue`。
- 不在 Header 中新增业务判断。

### `webview/src/components/ChatInputBox/ChatInputBox.tsx`

- 从 `ChatInputBoxProps` 解构新增队列回调。
- 原样透传给 `ChatInputBoxHeader`。

### `webview/src/components/ChatInputBox/types.ts`

为 `ChatInputBoxProps` 增加对应可选回调类型：

- `onUpdateQueue`
- `onMoveUpQueue`
- `onMoveDownQueue`
- `onMoveToFrontQueue`
- `onMoveToBackQueue`
- `onReorderQueue`
- `onInterruptQueue`
- `onInsertQueue`

### `webview/src/components/ChatScreen.tsx`

该文件是实际 props 中转层，必须加入范围：

- 扩展 `ChatScreenProps` 的队列回调定义。
- 从 props 解构新增回调。
- 原样传入 `ChatInputBox`。

### `webview/src/App.tsx`

- 调用 `useMessageQueue({ isLoading: loading, onExecute: executeMessage, onInterrupt: interruptSession })`。
- 解构新增的队列操作方法。
- 将方法传入 `ChatScreen`，由后续组件透传。
- 不直接调用 `sendBridgeEvent('interrupt_session')`：优先复用当前 `useMessageSender` 暴露的 `interruptSession`，以保持现有中断确认、状态更新和 bridge 行为一致。

### `webview/src/components/ChatInputBox/styles/banners.css`

新增或调整：

- 拖柄的 `grab / grabbing` 光标与适当的触控选择限制。
- 通用队列图标按钮的尺寸、布局、hover、focus-visible、disabled 样式。
- 打断按钮 hover 红色；插入按钮 hover 蓝色。
- 边界移动按钮与 Lucide SVG 的对齐样式；**不创建 CSS 拼接箭头图标**。
- 编辑态 textarea 的宽度、高度、颜色、边框、focus 样式。
- 拖放目标高亮和拖动中条目的弱透明状态。
- 适配已有浅色主题变量。

---

## 功能开关与渐进启用策略

### 目标

消息队列增强将按阶段逐步开发和启用。为避免在功能尚未充分验证时暴露入口，本次采用**前端静态功能开关常量**控制新增 UI 能力的显示；不新增设置页、不使用 localStorage、不增加 Java 或 bridge 配置协议。

### 开关实现方式

新增集中常量文件：`webview/src/constants/messageQueueFeatures.ts`。

```ts
export const MESSAGE_QUEUE_FEATURES = {
  edit: false,
  reorder: false,
  insert: false,
  dragReorder: false,
  interrupt: false,
} as const;
```

约束：

- 常量文件是唯一的功能启用入口；修改为 `true` 后重新构建 webview 即可启用对应功能。
- 开关只在 `MessageQueue.tsx` 控制相应按钮、编辑态和拖放交互是否渲染；**不**为开关额外增加 `App → ChatScreen → ChatInputBox → ChatInputBoxHeader` 的 props 透传。
- `useMessageQueue` 可以实现并对上层暴露完整操作方法；关闭开关时仅隐藏用户入口，不改变现有基础队列行为。
- 现有能力（忙碌时入队、倒序展示、全文悬浮提示、删除、任务结束后自动消费 `queue[0]`）不受该常量控制，始终保持启用。
- 新增能力的单元测试不依赖生产常量的当前值；测试直接验证对应 hook 方法和组件回调行为，必要时 mock 常量或在测试环境中单独渲染启用态。

### 开关粒度

| 开关 | 控制范围 | 默认值 | 启用条件 |
| --- | --- | ---: | --- |
| `edit` | 编辑按钮、内联 textarea、保存与取消 | `false` | 编辑功能实现完成并通过测试、手动验证后 |
| `reorder` | 上移、下移、移到队首、移到队尾；包含 `ArrowDownToLine` / `ArrowUpToLine` | `false` | 按钮排序、边界禁用态和倒序语义验证后 |
| `insert` | 插入到下一次执行按钮 | `false` | `moveToFront` 已稳定且自动消费顺序验证后 |
| `dragReorder` | 拖柄、HTML5 拖放和放置高亮 | `false` | 拖放重排、异常结束清理和桌面 webview 手动验证后 |
| `interrupt` | 打断并优先执行按钮 | `false` | 中断、loading 状态变化与自动消费队首的竞态测试通过后 |

不为删除按钮设置开关：删除是当前已存在的基础能力。

### 启用节奏

| 阶段 | `edit` | `reorder` | `insert` | `dragReorder` | `interrupt` | 说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 当前 / 未实现 | `false` | `false` | `false` | `false` | `false` | 新增能力全部隐藏，不影响已有队列 |
| 阶段 A 验证后 | `true` | `true` | `true` | `false` | `false` | 先开放编辑、按钮式排序和礼貌插入 |
| 阶段 B 验证后 | `true` | `true` | `true` | `true` | `false` | 再开放拖柄拖放重排 |
| 阶段 C 验证后 | `true` | `true` | `true` | `true` | `true` | 最后开放高风险的打断调度 |

### 不采用的方案

- **设置页开关**：会额外引入设置 UI、状态管理、持久化、恢复和兼容测试；当前阶段不需要。
- **后端 / Java 配置开关**：队列增强是前端本地状态，不应为此扩大消息协议。
- **Vite 环境变量开关**：需要处理插件构建注入流程，复杂度高于 TypeScript 常量，当前没有必要。

---
## 分阶段需求清单（由简到难）

> 本节按实现复杂度排序，不等同于最终产品优先级；具体实施顺序待确认。
> 当前已有能力为：忙碌时入队、倒序展示、全文悬浮提示、删除队列项，以及任务结束后自动执行 `queue[0]`。因此不重复实现基础展示和删除能力。

| 顺序 | 需求点 | 用户可见效果 | 主要改动 | 前置依赖 | 实现难度 |
| ---: | --- | --- | --- | --- | --- |
| 1 | 队列操作按钮的图标与提示规范 | 明确显示拖柄、上下移动、移到队首/队尾、编辑、插入、打断、删除图标；边界移动使用 `ArrowDownToLine` / `ArrowUpToLine` | `MessageQueue.tsx`、样式 | 无 | 很低 |
| 2 | 回调接口与 props 透传 | 无直接新行为；为后续操作按钮建立完整接线 | `types.ts` → `ChatInputBox` → `ChatInputBoxHeader` → `ChatScreen` → `App` | 无 | 低 |
| 3 | 编辑队列消息 | 内联 textarea、保存、取消；附件保持不变 | `useMessageQueue.update`、`MessageQueue.tsx` | 2 | 低 |
| 4 | 单步调整顺序 | `↑` 向视觉顶部移动并更晚执行，`↓` 向视觉底部移动并更早执行；首尾按钮正确禁用 | `moveUp`、`moveDown` 与按钮状态 | 2 | 中低 |
| 5 | 移到队首 / 队尾 | 一键成为下一条执行或最后一条执行 | `moveToFront`、`moveToBack` 与边界图标按钮 | 2 | 中低 |
| 6 | 插入到下一次执行 | 本条成为下一条，但不打断正在执行的任务 | `insert`，复用 `moveToFront` | 5 | 低 |
| 7 | 拖柄拖放重排 | 通过 `codicon-gripper` 拖动调整顺序，并显示放置高亮 | `reorder`、HTML5 DnD 状态、样式 | 4 或 5 | 中高 |
| 8 | 打断并优先执行指定消息 | 中断当前任务后优先执行目标项；空闲时直接执行 | `interruptAndSendNow`、`interruptSession` 接线、loading 状态衔接 | 5 | 高 |
| 9 | 自动化测试 | 覆盖编辑、排序、插入、打断及队列自动消费，防止回归 | Hook 测试、`MessageQueue` 组件测试 | 对应功能完成后 | 中 |
| 10 | 手动回归与视觉细化 | 验证倒序语义、浅色主题、hover、拖放与无障碍体验 | CSS 与手动验证 | 1–8 | 中 |

### 候选交付阶段

| 阶段 | 包含需求 | 交付目标 | 状态 | 风险 |
| --- | --- | --- | --- | --- |
| 阶段 A：轻量队列管理 | 3、4、5、6、9（相关部分） | 支持编辑、单步排序、移到队首/尾和礼貌插入 | 已完成 | 低；不改变当前中断流程 |
| 阶段 B：操作体验增强 | 1、7、9（相关部分） | 完整图标、tooltip、禁用态、拖放重排与组件交互测试 | 待开始 | 中；主要是 HTML5 拖放兼容和交互细节 |
| 阶段 C：高风险调度 | 8、9（相关部分）、10 | 支持打断当前任务并优先安排目标队列项 | 已完成 | 高；与中断、loading 变化和自动消费队首的时机耦合 |

### 分阶段 TODO

#### 阶段 A：轻量队列管理（已完成）

- [x] 新增 `update`、`moveUp`、`moveDown`、`moveToFront`、`moveToBack` 和 `insert` 队列操作。
- [x] 完成回调接口及 `App → ChatScreen → ChatInputBox → ChatInputBoxHeader → MessageQueue` 的 props 透传。
- [x] 实现编辑、保存、取消、单步调序、移到队首/队尾及插入到下一次执行。
- [x] 按倒序视觉展示修正单步按钮映射：`↑` 更晚执行，`↓` 更早执行；队首/队尾仍以“下一条执行 / 最后执行”为准。
- [x] 修复编辑态 textarea 被相邻队列项遮挡的问题。
- [x] 增加 Hook 与 `MessageQueue` 组件测试，并完成 `npm test`、`npm run build` 验证。

#### 阶段 B：操作体验增强（待开始）

- [ ] 增加 `codicon-gripper` 拖柄和 HTML5 drag-and-drop 重排。
- [ ] 实现拖动目标高亮、拖动结束状态清理及异常场景处理。
- [ ] 补充拖放重排、按钮禁用态和无障碍交互的组件测试。
- [ ] 完成桌面 IDE webview 的拖放与浅色主题手动回归。
- [ ] 验证完成后开启 `dragReorder` 功能开关。

#### 阶段 C：高风险调度（已完成）

- [x] 实现 `interruptAndSendNow`，复用 `interruptSession` 并确保目标项成为逻辑队首。
- [x] 覆盖 loading 状态切换、自动消费与中断竞态的 Hook 测试。
- [x] 增加打断按钮的无障碍交互测试。
- [x] 完成中断流程与队列自动消费的自动化回归验证。
- [x] 验证完成后开启 `interrupt` 功能开关。

### 待确认的优先级

以下实施组合在开始编码前由需求方确认：

1. 先做阶段 A：编辑、排序、置顶/置尾、插入。
2. 只做 3、5、6：编辑、移到队首/尾、插入，暂不做单步和拖放。
3. 排序优先：先做 4、5、7。
4. 打断优先：先完成 5 的基础能力，再做 8，并优先补充中断场景测试。
5. 自定义编号组合，例如“先做 1、3、5，确认后再做 4、6”。

---
## 验证计划

### 自动验证

在 `webview` 目录执行：

```powershell
npm test
npm run build
```

至少确认：

- 新增 hook 与组件测试通过。
- `tsc` 无 props 透传遗漏或 Lucide 图标 import 错误。
- Vite 构建成功。

### 手动验证

- 忙碌时连续提交多条消息，确认仍按逻辑队首自动消费。
- 确认 UI 倒序不变：逻辑队首位于视觉底部、靠近输入框。
- 检查 `ArrowDownToLine` 点击后成为下一条执行，`ArrowUpToLine` 点击后成为最后执行。
- 检查两个边界移动图标的 title / aria-label 均明确“下一条执行 / 最后执行”。
- 验证 `↑` 将条目移向视觉顶部并更晚执行，`↓` 将条目移向视觉底部并更早执行；同时确认顶部 / 底部边界禁用态正确。
- 仅拖拽拖柄时可调整顺序；textarea 中可以正常选择和编辑文本。
- 验证编辑保存 / 取消、空内容禁用保存、附件未丢失。
- 验证插入不打断当前任务但会成为下一条。
- 验证打断会中断当前任务，且目标消息成为下一条。
- 验证打断按钮悬浮变红，插入按钮悬浮变蓝，浅色主题下仍可辨识。

---

## 风险与约束

- 真实“运行中注入到 agent loop 下一轮”目前没有独立协议；本计划的“插入”仅为前端队列置顶，不中断当前任务。
- “打断”依赖既有 `interruptSession` 的完成后 loading 状态变化；本次不新增确认或重试协议。
- HTML5 drag-and-drop 在触屏环境的体验有限；该 webview 当前优先保障桌面 IDE 场景，键盘可操作的排序按钮作为替代。
- 编辑只覆盖文本，不提供附件增删改，降低改动范围。
- 倒序展示仍有理解成本；边界按钮、单步排序按钮均必须借助明确 tooltip / aria-label 说明执行语义。
- 本计划不引入新的图标或拖拽依赖；`lucide-react` 已为项目现有依赖。
