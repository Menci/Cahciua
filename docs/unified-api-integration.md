# Unified API 集成设计（工作文档）

> 本文档记录将 `src/unified-api/` 集成进整个 Cahciua 仓库的调研发现、
> 已决策事项、待定事项。每轮讨论后由 Claude 更新，用于跨 compact 续工。
> `src/unified-api/` 本身**禁止**修改。

## 1. 背景与总体边界

### 架构边界

```
┌──────────────────────────────────────────────────────┐
│ LLM API Client 层（仅 HTTP/SSE，provider-native wire）│
│   streaming.ts            (OpenAI Chat Completions)  │
│   streaming-responses.ts  (OpenAI Responses)         │
│   streaming-messages.ts   (Anthropic Messages, 新增) │
└────────────┬─────────────────────────────┬───────────┘
             │ from*Output                 │ to*Input
             ▼                             ▲
┌──────────────────────────────────────────────────────┐
│ 业务层（仅操作 ConversationEntry[]，IR）              │
│   runner · context · merge · compaction              │
│   send-message-human-likeness · probe 分析           │
│   DB 存取                                             │
└──────────────────────────────────────────────────────┘
```

**硬性规则**：
- 出 streaming client 立即转 IR；业务代码不许见到任何
  wire 格式的 LLM 数据（assistant message、function_call、
  tool_use、reasoning 等）。
- tool call 循环内，assistant 输出先转 IR，工具结果以
  `ToolResult` IR entry 形式拼接。
- 发下一步 API 调用前才 `to*Input` 回 wire。

### 涉及文件（需要改/新增）

| 文件 | 动作 |
|---|---|
| `src/db/schema.ts` | 新增 `turn_responses_v2` / `probe_responses_v2` 表 |
| `drizzle/XXXX_create_v2_tables.sql` | 建表 SQL |
| `src/db/persistence.ts` | 改 persist/load 签名返回 IR，加启动迁移函数 |
| `src/db/migrate-v2.ts`（新）| v1→v2 回填逻辑 |
| `src/rendering/types.ts` | `RenderedContentPiece` image 改用 Sharp |
| `src/rendering/*` | 下游生成方改用 Sharp |
| `src/telegram/*` | 图片下载产出 Sharp 而非 base64 data URL |
| `src/driver/types.ts` | 删除 `TRDataEntry`/`ResponsesTRDataItem`/`ExtendedMessage` 等，重建类型 |
| `src/driver/context.ts` | `composeContext` 返回 `ConversationEntry[]` |
| `src/driver/merge.ts` | 操作 IR |
| `src/driver/convert.ts` | **整个删除**（功能归 unified-api） |
| `src/driver/runner.ts` | 转 IR、统一循环 |
| `src/driver/compaction.ts` | 改 IR |
| `src/driver/send-message-human-likeness.ts` | 重写，扫 IR |
| `src/driver/streaming-messages.ts`（新）| Anthropic 原生 SSE |
| `src/driver/index.ts` | 入口与分发 |
| 各 `*.test.ts` | 测试迁移 |

## 2. 已决策事项

### D1. 图片：全流程 Sharp
- RC 层 `RenderedContentPiece` 的 image 变体从 `{url:string}`
  改成 `{image: Sharp}`。
- telegram 下载产出 Buffer 立即 `sharp(buf)` 包起来。
- 只在**序列化边界**（存 DB、发 LLM API）通过 codec/Sharp
  管道转成 base64 或送入请求体。
- codec 注册 Sharp：
  - serialize（async）：`await sharp.toBuffer()` + `metadata()` 取 format → `{base64, format}`。
  - deserialize（async）：`sharp(Buffer.from(base64, 'base64'))`（codec handler 是 async 的，OK）。

### D2. reasoning 门禁：用 model name 代替 compat 字符串
- v2 表有列 `model_name TEXT NOT NULL DEFAULT ''`。
- 写入 TR 时记这次调用实际用的模型名
  （例 `'gpt-5'`、`'claude-sonnet-4-5-20250929'`）。
- 读出时与**当前 chat 配的 primary model name**字符串比较。
  不等 → 对该 TR 的 `entries` 跑 `stripReasoning`。
- 删除 config 里原来的 `reasoningSignatureCompat` 字段。

### D3. 趁 IR 化简化 trim
- `trimImages` / `trimToolResults`（image detail 降级）
  在 `InputPart[]` 层面统一写一次，
  不再在 chat/responses 两条 wire 路径各写一份。
- `trimContext` 的 assistant↔tool 对齐用 `callId` 关联，
  不再靠消息数组位置。
- `sanitizeToolCallIdsForMessagesApi`（Anthropic id 正则）
  归 `toMessagesInput` 处理（如果 unified-api 没做，停下来商量）。

### D4. 含图 tool result 抬 user message
- 归 `toChatCompletionsInput` 处理，业务层不管。
- 实现时若发现 unified-api 没做，停下来商量
  （当前决策：不动 unified-api）。

### D5. probe_responses 也 v2
- 原因：schema 统一、便于查询/分析，
  启动迁移逻辑复用 TR v2 的。
- probe 只写不读，除了 `turn_responses` 被
  `send-message-human-likeness.ts` 扫用于 late-binding prompt
  外，`probe_responses` 没有读取方。

### D6. 启动时一次性回填（不是 SQL migration 做）
- 建表由 drizzle SQL 负责（只有 CREATE TABLE + 索引）。
- 数据搬运由 TS 启动钩子做：
  ```
  if (SELECT COUNT(*) FROM turn_responses_v2 == 0
      AND SELECT COUNT(*) FROM turn_responses > 0) {
    BEGIN TRANSACTION;
      scan v1 → migrateChatEntries/migrateResponsesEntries
            → encode via codec → INSERT v2
    COMMIT;
  }
  ```
- **单事务**包住全部回填（SQLite 单库事务，行数可控）。
- probe v2 同逻辑。
- v1 表**保留不 drop**，留档备查/回滚。

### D7. v2 表 shape

```sql
CREATE TABLE turn_responses_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  entries TEXT NOT NULL,            -- codec JSON: ConversationEntry[]
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  model_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX turn_responses_v2_chat_requested_idx
  ON turn_responses_v2 (chat_id, requested_at);

CREATE TABLE probe_responses_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  entries TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  model_name TEXT NOT NULL DEFAULT '',
  is_activated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX probe_responses_v2_chat_idx
  ON probe_responses_v2 (chat_id);
```

**列变化**（相对 v1）：
- 去 `provider`（IR provider-agnostic）
- 去 `session_meta`（v1 从未写入非 null）
- 去 `data` → 改 `entries`（codec 包装的 JSON）
- `reasoning_signature_compat` → `model_name`
- 从 v1 回填的行 `model_name = ''`（空串视作 mismatch，
  读时一律 strip reasoning）。
- probe v2 也保留 `model_name`（方便查询）。

### D8. 业务层强制 IR
- 边界如「架构边界」图所示。
- `send-message-human-likeness.ts` 重写：扫 `ConversationEntry[]`，
  找 `OutputMessage.parts` 里 `kind:'toolCall' && name:'send_message'`，
  配对后续 `ToolResult(callId)` 的 `payload` 看 `ok:true`，
  提取 `args` JSON 里的 `text`。

### D9. Anthropic 原生路径本次一起做
- 新增 `src/driver/streaming-messages.ts`。
- config 增加 `apiFormat: 'anthropic-messages'`。
- HTTP 客户端不关心 provider 差异，header/URL 按 provider
  透传到 fetch，不做封装抽象。
- **重要**：`ProviderFormat` 不进 DB，只在 config 和 runner 分发处。

### D10. Sharp async handler
codec handler 允许 async，`sharp(Buffer.from(base64))` 用 `async v => sharp(...)` 形式。sharp 构造同步 + lazy decode，`await` 无实际开销。

### D11. 删除 reasoningSignatureCompat
从 config schema、`LlmEndpoint` 类型、`config.yaml` 等处全部删除此字段。读取时改为比较 model_name。

### D12. tool 产出的图片也用 Sharp
`src/driver/tools.ts` 里 `read_image` / `download_file` 等产出 `ToolResult.payload` 时,图片直接用 Sharp 实例,不再 data URL。这样 IR 里所有图片都是 Sharp。

### D13. RC 产出方改 Sharp
`src/rendering/index.ts:164` 的 thumbnailWebp 拼 data URL 改成 `sharp(Buffer.from(att.thumbnailWebp, 'base64'))`。DB 里 thumbnailWebp 字段不动。测试同步更新。

### D14. 启动时一次性迁移(时机 A)
drizzle migrator 跑完后、driver/pipeline 启动之前,在 `src/index.ts` 启动流程中执行 v1→v2 回填。

### D15. 回填错误处理
若任一行迁移抛异常,整个事务 rollback 并崩溃整个程序,要求人工介入。不吞错、不跳行。

### D16. 测试策略 B
先了解原 `convert.test.ts` / `merge.test.ts` / `context.test.ts` 覆盖的行为要点,然后朝这些行为目标在 IR 上重写测试。老测试删除。

## 4. 需要验证但当前未验证的假设

- [ ] `toChatCompletionsInput` 处理含图 `ToolResult`
      （抬到下一条 user message）—— 实现时查证。
- [ ] `toMessagesInput` 做 Anthropic tool id 正则 sanitize ——
      实现时查证。
- [ ] `toMessagesInput` parse `ToolCallPart.args` 并 fallback `{}` ——
      已在 `unified-api/types.ts` IR 注释中确认存在。
- [ ] codec handler 支持 async：`codec.ts:14-18` 的 `CustomType`
      serialize/deserialize 都返回 Promise，已确认。

## 5. 实现顺序建议

1. drizzle SQL：建 v2 两张表。
2. schema.ts 加 v2 定义。
3. rendering 层改 Sharp（RC `image` 变体）。
4. telegram 下载侧配合改 Sharp 产出。
5. codec Sharp 注册在 `src/db/codec.ts`（新）。
6. `src/db/migrate-v2.ts` 回填逻辑。
7. `persistence.ts` 增 v2 读写函数，启动钩子调迁移。
8. runner + streaming 客户端接 IR：在 runner 内 from*Output。
9. context.ts / merge.ts 改操作 IR。
10. send-message-human-likeness.ts 重写。
11. compaction.ts 改 IR。
12. driver/index.ts 粘合。
13. streaming-messages.ts（Anthropic）+ runner 分发。
14. 删除旧 `convert.ts`、旧 `types.ts` 中的废弃类型。
15. 测试迁移。

## 6. 关键参考位置

| 关注点 | 文件 | 行 |
|---|---|---|
| 现 TR schema | `src/db/schema.ts` | 95-107 |
| persist/load TR | `src/db/persistence.ts` | 306-354 |
| runner chat 循环 | `src/driver/runner.ts` | 69-124 |
| runner responses 循环 | `src/driver/runner.ts` | 126-186 |
| composeContext | `src/driver/context.ts` | 529-581 |
| mergeContext | `src/driver/merge.ts` | 20-75 |
| reasoning 门禁 | `src/driver/context.ts` | 119-156 |
| 含图 tool result 抬 user | `src/driver/convert.ts` | 51-114 |
| Anthropic tool id sanitize | `src/driver/context.ts` | 369-420 |
| trim suite | `src/driver/context.ts` | 58-101, 243-367 |
| IR invariants | `src/unified-api/types.ts` | 1-25 |
| 迁移 helper | `src/unified-api/migrations.ts` | 全 |
| codec（async handler）| `src/unified-api/codec.ts` | 14-18 |
| RC 类型 | `src/rendering/types.ts` | 9-40 |
| probe writer | `src/driver/index.ts` | 350-355 |
| send-message 评估入口 | `src/driver/index.ts` | 295 |

## 7. 讨论历史摘要

**轮 1**（整体调研）：识别 9 个摩擦点与开放问题。

**轮 2**（用户决策）：
- 图片全 Sharp。
- reasoning 用 model_name 替代 compat。
- trim 在 IR 上简化。
- 含图 tool result 归 unified-api。
- probe 也 v2。
- 一次性回填。
- v2 shape 确认，compat → model_name。
- 业务层禁见 wire。
- Anthropic 本次做，HTTP 透传 header。

**轮 3**（用户进一步决策）：
- codec Sharp 用 async handler。
- v1 不 drop,留档。
- 回填单事务。
- v2 回填行 model_name 留空。
- probe v2 也存 model_name。
- HTTP client 透传 header,不抽象。

**轮 4**（用户进一步决策）：
- 删除 config 里 reasoningSignatureCompat 字段。
- tool 产出的图片也用 Sharp。
- RC 产出方改 Sharp。
- 启动迁移时机选 A(drizzle 之后、driver 之前)。
- 回填错误 rollback + 崩溃。
- 测试先理解覆盖面,再 IR 上重写。

**轮 5**（用户进一步决策）：
- 不双写,只写 v2。
- drizzle migration 一个文件,两张表一起建。
- codec 实例放 `src/db/codec.ts`,通过 `createCodec` 建并注册 Sharp。
- 全量清理 compat:primaryModel / probeModel / compactionModel / sanitize*ForTR 全删。
- `loadTurnResponses` 新签名返回 `TurnResponseV2[]`(含 `entries`/`modelName`)。`composeContext` 收 `TurnResponseV2[]` + 当前 modelName,mismatch 时 `stripReasoning`。
- merge 逻辑不变,操作对象换成 IR。
- RC → IR:多段连续 RC 合并成一条 InputMessage(role:'user')。
- 启动迁移必须在所有其他模块初始化之前、drizzle migrate 之后。迁移失败不允许任何其他副作用。

**轮 6**（破例决策）：
- **允许修改 unified-api**。原因:
  (1) `toChatCompletionsInput` 当前把"含图 tool result 抬到 user 消息"甩给了外部(`driver/convert`),但 driver/convert 要删;
  (2) `toMessagesInput` 不做 Anthropic tool_use id 正则 sanitize。
- 两个能力**必须放进 unified-api**,业务层不见 wire 原则不打折扣。
- 修改范围最小化:只改 `to-chat-input.ts` 和 `to-messages-input.ts`。
