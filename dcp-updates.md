# DCP RFC 实施更新

以下是 Cahciua 实现过程中，相对于原始 RFC 所做的设计变更和细化。

---

## 1. 新增：双时间戳排序

RFC 原文假设各事件携带服务端 `date` 字段即可确定顺序。实现中发现仅靠服务端时间戳不足以保证**确定性重放**——不同服务器的时钟偏差和网络乱序会导致冷启动重放的事件顺序与在线处理时不一致。

现在每个 `CanonicalIMEvent` 携带两个时间戳：

| 字段 | 精度 | 来源 | 用途 |
|------|------|------|------|
| `receivedAtMs` | 毫秒 | 适配时 `Date.now()` | 排序的唯一来源，DB 按 `(received_at, id)` 排序 |
| `timestampSec` | 秒 | 服务端 `date` | 展示给 LLM 的消息时间 |

Delete 事件无服务端时间，`timestampSec` 由 `Math.floor(receivedAtMs / 1000)` 派生。

## 2. 变更：事件类型精简

RFC 提出了多种独立事件类型（`StickerEvent`、`UserUpdateEvent`、`MemberJoinEvent` / `MemberLeaveEvent`）。实现中做了精简：

- **Sticker** 不单独立事件类型，作为 `CanonicalMessageEvent` 的 `attachments` 中 `type: 'sticker'` 处理。这与 Telegram API 的实际结构一致——sticker 就是一条消息的附件。
- **UserUpdateEvent / MemberJoinEvent / MemberLeaveEvent** 暂不作为独立的 CanonicalIMEvent 类型。用户状态变更通过 **MetaReducer 模式**从普通消息中检测（见下文第 4 点），不依赖平台专有事件。入群退群事件留到需要时再加。

当前 `CanonicalIMEvent = CanonicalMessageEvent | CanonicalEditEvent | CanonicalDeleteEvent`。

## 3. 变更：Projection 不拆分 Reducer

RFC 提出 ContentReducer 和 MetaReducer 作为独立的代码抽象。实现中决定**暂不拆分**：

- 当前只有一个 `reduce(ic, event)` 函数，MetaReducer 的逻辑（用户状态变更检测）作为其中一个步骤执行
- 拆分的时机是出现真正独立的元事件类型（`UserUpdateEvent`、`MemberJoinEvent` 等）时

避免了过早抽象——在只有 message/edit/delete 三种事件时，ContentReducer 和 MetaReducer 的边界并不清晰。

## 4. 新增：MetaReducer 模式（用户状态变更检测）

这是 RFC 中 MetaReducer 概念的具体化，但实现方式不同——不通过平台专有事件，而是**从普通消息事件推断**：

Reducer 处理每条消息时，将 `event.sender` 与 `ic.users` Map 中的记录比对。若 `displayName` 或 `username` 发生变化，在 IC 当前位置插入一个 `ICSystemEvent` 节点，让 LLM 知道「用户 A 改名为 B」。

这不需要 Telegram 提供 `UserUpdateEvent`（Bot API 本身也不推送此类事件），从已有数据中提取出了等价的信息。

## 5. 变更：IC 不含 CompactSummaryNode

RFC 的 IC 包含三种节点：`MessageNode`、`SystemEventNode`、`CompactSummaryNode`。实现中去掉了 `CompactSummaryNode`：

- 压缩摘要由 Driver 提供给 Rendering（作为 `RenderParams` 的一部分），Rendering 在序列化时插入
- IC 始终持有未压缩的工作集，不混入压缩产物
- 这保持了 IC 的纯粹性——它只是事件流的结构化投影，不含渲染层或 Driver 层的产物

当前 `ICNode = ICMessage | ICSystemEvent`。

## 6. 新增：Edit/Delete 的就地标记语义

RFC 未详细说明 Projection 如何处理 edit/delete。实现中确定了具体语义：

- **Edit**：找到 IC 中对应 `messageId` 的 `ICMessage`，原地更新 `content`/`attachments` 并设置 `editedAtSec`
- **Delete**：找到对应节点，设置 `deleted: true`（不移除节点，不追加新节点）
- 若目标消息不在当前 IC 中（已被 GC），静默忽略

这模拟了 IM 的真实行为——编辑和删除修改原始消息位置，不产生新的时间线条目。

Edit/delete 事件完全来自 userbot（gramjs / MTProto）。Bot API 不推送编辑或删除通知——没有 userbot 客户端的话，系统不需要处理这两类事件。

## 6a. 新增：IC 变更的两种语义与 KV Cache 影响

IC 的变更分为两类，KV cache 特性不同：

- **就地变更**（edit、delete）：修改 IC 中已有节点的原始位置，带标记（`editedAtSec`、`deleted: true`）。Rendering 渲染节点的当前状态。这会导致从变更点往后的 KV cache 失效。可接受——编辑不频繁（~5-10%），且通常针对近期消息（cache 失效范围小）；已被 compaction 覆盖的消息不在 IC 中，对它们的 edit/delete 静默忽略。
- **追加式变更**（用户改名，未来：入群/退群）：在 IC 末尾插入系统事件节点，不修改旧消息。旧消息保留原始 `sender` 字段，Rendering 使用 `node.sender`（消息发送时的名字），不查 `ic.users`。天然 KV-cache 友好。

设计规则：**实体元数据变更（用户、群组设置）→ 追加式；特定消息的内容变更 → 就地修改 + 标记。**

## 7. 重大变更：新增 Driver 层

RFC 的三层管道（Adaptation → Projection → Rendering）在实现中扩展为**四层**。原因：

各 LLM API（OpenAI Chat Completions、OpenAI Responses）的 tool call 格式和必须回传的元数据（ID、签名）各不相同。这些元数据是服务端生成的，无法从 IC 推导，也无法用 provider-agnostic 的方式表达在 Rendering 输出中。两种 API 格式均已实现，通过 `apiFormat` 配置切换。

现在的架构：

```
Adaptation → Projection → Rendering → Driver
                            (纯函数)     (有状态)
```

| 层 | 职责 | 纯度 |
|---|---|---|
| **Rendering** | `render(IC, RenderParams) → RC`：序列化 IC 为 provider-agnostic 的 RC | 纯函数 |
| **Driver** | 持有 TRs（对话历史），合并 RC + TRs，管理 tool call 循环 | 有状态 |

RC（Rendered Context）不是最终 LLM 请求——它是 Driver 合并的输入之一。Driver 按时间戳（`receivedAtMs`/`requestedAtMs`）将 RC 和 TRs 交错合并为最终 API 请求。

## 8. 新增：Conversation History 的原始 Provider 格式存储

RFC 未涉及 bot 自身回复和 tool call 历史的存储。现在的设计：

- **存储单位**：Turn Response / TR（一次 LLM 交互的输出），存原始 provider 格式
- **同 provider 读取**：零转换，保证无损
- **跨 provider 切换**：显式 A→B 转换函数，直接结构映射，独立可测
- 切换 provider 不改变数据库中的已有数据，只改变读取时的翻译逻辑

设计原则：直接存储比中间格式更简单，避免归一化导致的信息丢失。N*(N-1) 个转换器，N=2-3 → 2-6 个函数，按需实现。

**已实现的 Provider 格式**：
- `openai-chat`：OpenAI Chat Completions 兼容格式（`TRDataEntry[]`：assistant + tool role entries）
- `responses`：OpenAI Responses API 格式（output items：`message`、`function_call`、`reasoning`、`function_call_output`）

**转换架构**：`composeContext` 始终输出 openai-chat 格式的 `Message[]` 作为 lingua franca。Responses 格式的 TR 数据在 compose 时通过 `responsesOutputToMessages` 转为 openai-chat 消息。如果目标 API 是 Responses，runner 在发送前通过 `messagesToResponsesInput` 做最终转换。Reasoning 在转换中保留（`encrypted_content` ↔ `reasoning_opaque`，`summary` ↔ `reasoning_text`），跨 provider 的 reasoning 签名由 `sanitizeReasoningForTR` 统一处理。

## 9. 变更：Compaction 归属从 Orchestrator 移到 Driver

RFC 将压缩描述为「外部 Orchestrator 驱动」。实现中将 compaction 的所有权明确交给 **Driver 层**：

- Driver 掌握 token 预算和缓存策略，知道最优的压缩边界（不同 provider 的缓存机制差异很大）
- tool call 循环可以被 Driver 更激进地压缩（它了解 tool call 的结构）
- 某些 provider 有原生压缩支持（如 OpenAI Responses API）
- 压缩后 Driver 更新 compact cursor，Rendering 据此做视口过滤

App 层可以提供重要性标注（如 pinned 消息不应被压缩）作为 hint，但不拥有压缩机制本身。

## 10. 细化：RFC 讨论点的结论

RFC 尾部提出了两个待讨论的点，现有结论：

**讨论点 1「纯函数管道的边界应该画在哪里？」**：
DCP 三层（Adaptation / Projection / Rendering）保持纯函数。副作用（LLM 调用、tool 执行、压缩）由新增的 Driver 层承担。这就是「纯核心 + 副作用外壳」——复杂度可控，因为 Driver 是管道的最外层，不会污染内部数据流。

**讨论点 2「打破 1:1 响应范式」**：
方向不变——bot 通过 `send_message` tool call 自主决定是否回复。这个范式转变在 Driver 层吸收，不影响 DCP 管道内部。

## 11. 变更：富文本从偏移量格式改为内容节点树

RFC/gemini chat 讨论中提出 IC 应该是 "Context AST"，ContentReducer "负责解析富文本实体"。实现中进一步——将富文本解析提前到 **Adaptation 层**：

- `text + entities[]`（Telegram 的偏移量标注格式）是平台特有的编码方式，不应泄漏进 DCP
- Adaptation 将其解析为 `ContentNode[]` 树：叶子节点（text/code/pre）+ 容器节点（bold/italic/link/mention/...）
- 删除了 `CanonicalEntity` 类型，`CanonicalMessageEvent` 和 `CanonicalEditEvent` 改为 `content: ContentNode[]`
- ICMessage 同步改为 `content: ContentNode[]`
- Rendering 接收结构化的内容树，只做序列化（strategy 决定如何 emit 每种节点类型），不需要解析任何编码

职责边界：Adaptation 做格式解码（机械转换），Projection 做状态管理（不碰内容表示），Rendering 做序列化（strategy）。

## 12. 变更：Canonical 层 ID 类型从 number 改为 string

Telegram 使用数字 message ID，但其他 IM 平台（Discord snowflake、Slack timestamp）使用字符串。`messageId: number` 是 Telegram 的类型泄漏。

- `CanonicalMessageEvent.messageId`、`CanonicalEditEvent.messageId`：`number` → `string`
- `CanonicalDeleteEvent.messageIds`：`number[]` → `string[]`
- `CanonicalMessageEvent.replyToMessageId`：`number` → `string`
- Adaptation 在转换时执行 `String(msg.messageId)`
- ICMessage 的 messageId/replyToMessageId 已经是 string，不再需要 Projection 做类型转换
- events 表的 `message_id` 和 `reply_to_message_id` 列从 INTEGER 改为 TEXT
- messages 表不变——它存原始平台数据，Telegram messageId 就是 number

## 13. 新增：Debounce 归属 Driver 层

RFC/早期设计将 debounce/throttle 描述为「Projection 和 Rendering 之间」的未分配调度逻辑。现在明确归属 **Driver 层**：

- Driver 已经管理 tool call loop，它知道什么时候该重新 render IC——如果 debounce 在外部编排层，编排层需要和 Driver 协调「你在 loop 中吗？要不要插一次 re-render？」，增加不必要的耦合
- Driver 掌握 token 预算和 provider 缓存策略，这些直接影响 debounce 行为（如判断是否值得发起新请求）
- 具体的 debounce/throttle 参数仍然是 strategy，不是 architecture

## 14. 新增：Tool Call Loop 可被新消息打断

每次 LLM API 调用产生一个独立的 TR（而不是整个 tool call loop 合成一个 TR）。这使得 **tool 执行期间到达的新聊天消息可以被 LLM 看到**：

1. Projection 对每个新事件立即执行 `reduce`，IC 始终最新
2. Driver 在 tool call loop 的每次迭代前重新 `render(IC)`，拿到包含新消息的 RC
3. 新消息的 `receivedAtMs` 必然 > 触发 tool call 的 TR 的 `requestedAtMs`（因果律：消息在 API 调用发出之后才到达），merge 时自然排在 tool result 之后

TR 结构：每个 TR 存储「作为输入发送的 tool results + 收到的 assistant 响应」。TR₁ = `[assistant₁]`，TR₂ = `[tool_result₁, assistant₂]`。Append-only——每个 TR 在其 API call 返回时一次性写入。

Merge 规则：TR 中的 tool results 锚定在前一个 TR 之后（保持 tool_call → tool_result 的邻接性），新的 RC segments 排在 tool results 之后。


