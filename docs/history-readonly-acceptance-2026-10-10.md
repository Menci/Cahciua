# History 只读同步验收（2026-10-10）

> 此报告记录已被替换的全量巡检实现。当前增量同步验收见 [增量同步验收](history-incremental-acceptance-2026-10-10.md)；下列历史测量不代表当前代码。

本次验收取代此前原库同步日志方案。History 对核心 `cahciua.db` 只读；来源指纹、排序/目标索引、扫描进度、观察队列、物化状态和 FTS 均由 `history.db` 拥有。移除了此前候选的原库 0033/0034 扩展；部署源库 schema 和迁移序列保持原状。没有执行生产迁移、部署、commit 或 push。

## 原库边界与真实归档

在隔离 Docker 容器中使用已有 SQLite 一致备份 `source-before.db`，其源库迁移记录为 33 条、包含 1,057 个 events 和 196 个 TR。Worker 以 `readonly: true` 连接归档。复现 SIGKILL 后恢复，并在离线期间只向测试副本加入一个较早时间戳消息和一条摘要，再通过编译后的独立 worker 对账。

- 4 个群共 1,529 条结果，与独立完整 Projection/rendering/IR 输入构建逐项一致，差异为 0。
- SQLite integrity 和 FTS external-content integrity 均通过；摘要可由 FTS 找到。
- 原始备份 schema/迁移记录 hash 前后一致；Worker 使用副本的 schema hash 同样一致。
- 控制性测试写入结束后，比对 worker 启停前的全部源表数据 hash，完全一致。History 没有修改任何源表记录。
- 候选镜像另外在数据库副本上运行正常核心启动迁移及配置解析预检：迁移数 33 → 33，迁移记录和 schema 完全一致，10 张原有业务表逐行 hash 一致，没有 history 表或新增 quote 字段。
- 现有只读生产配置解析通过，history 默认 false；不启动 worker、不创建 history.db。原线上容器仍使用原镜像且 restart count 为 0，配置 SHA-256 保持不变。

匿名化计数、状态及 hash 见 [真实归档证据](history-readonly-evidence/real-online.json)。隔离候选预检和替换步骤保存在部署目录的 `history-readonly-release-20261010`，旧 `history-release-20261010` 已明确作废。

## 默认限制与 token 规模

环境为现有 Node 22 原生依赖，容器 `--network none --cpus 0.5 --memory 1536m`。全部用例使用默认 64 MiB 编码来源限制、128 MiB 编码工作集限制和最高 100 rows/sec 调度率，没有扩大预算或截断正文。RSS 由 `/proc/<worker pid>/status` 每 10 ms 采样，仅采 worker；实际采样间隔可能受调度延迟影响。编码工作集和 RSS 是两个独立指标，没有 16 倍展开估算。

Token 由 tiktoken 0.14.0 / o200k_base 实测，仅计文本正文，不计 wire/角色开销。1000-token 短文组成 1M 和 10M 归档；单条消息为 1M token；单 TR 为 500k 输出正文加 500k 工具结果。重启用例在初建中 SIGKILL、离线修改旧来源，恢复后再新增 1000-token 消息，所以最终计数为 1,001,000。每条全文、可搜索文本和回复正文用完整 hash 校验；所有 SQLite/FTS 检查通过，差异为 0。

| 用例 | 正文 token | Saved items | 耗时秒 | 峰值 RSS MiB | 峰值编码工作集 MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| reply-chain-1M | 1,001,000 | 1,001 | 76.44 | 114.81 | 0.077 |
| archive-1M-restart | 1,001,000 | 1,001 | 79.93 | 108.90 | 0.036 |
| archive-10M | 10,000,000 | 10,000 | 418.89 | 109.54 | 0.036 |
| single-message-1M | 1,000,000 | 1 | 6.07 | 253.57 | 30.009 |
| single-TR-1M | 1,000,000 | 3 | 5.02 | 134.89 | 8.146 |

长回复链完整验证 1,001 条消息和 1,000 条回复关系，恢复只读取直接父消息，不递归遍历祖先链。单大 TR 保存 3 条记录，完整工具配对及 4 条关系通过验证。10M 用例不是生产性能承诺；约 7 分钟包含初始来源定位扫描、物化与完整对账。完整指标见 [规模证据](history-readonly-evidence/million.json)。

重复运行使用 `history-online-evidence/acceptance.mjs` 和 `million.mjs`；这些脚本已改为检查 history 自有观察队列与完整扫描轮次，真实来源验收不执行源库迁移。Token fixture 生成器仍为 `million-fixtures.py`。验收输出目录必须是新的独立路径，禁止用生产路径作测试副本。

## 检查与实际限制

`pnpm typecheck`、`pnpm lint:fix`、`pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000` 和 `pnpm build` 均通过：52 个测试文件、520 项测试。新增/调整的回归覆盖源库只读与 schema 不变、观察/队列/扫描 checkpoint 事务回滚、重启恢复、旧附件和共享缓存回填、旧 TR/runtime 修订、新群、较早时间戳插入、有限 shutdown 和长回复链。

源库 schema 生成确认无差异；history schema 生成确认其专属 0002 迁移一致。记录见 [完整检查摘要](history-readonly-evidence/check-summary.txt)、[原库 schema](history-readonly-evidence/schema-source.txt) 和 [history schema](history-readonly-evidence/schema-history.txt)。

只读同步通过完整扫描最终发现变化。局部观察 seq 不是源库提交序号，`logLag=0` 仅表示已观察队列处理完毕；状态同时提供 completedScanCycle 和 lastSourceScanAtMs。两个观察点之间的多次可变行更新只恢复最新可见值，Canonical edit/delete 行各自保留。源库证据物理删除或 chat/order 身份改变需要显式新 generation。原库未保存的显式引用片段不能补造。查询 SDK/API、SQL guard 和 memory 仍待后续实现；现有 read_old_messages 不受 history.enabled 影响。
