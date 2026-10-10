# History 增量同步验收（2026-10-10）

本报告保留此前增量 v3 的实测记录。媒体轮询/hint 已被后续实现替换，当前通知与恢复验收见 [异步同步验收](history-async-acceptance-2026-10-10.md)。

当前实现替换循环全量巡检，采用持久 ID 增量发现与已知缺失媒体定向补齐。来源连接只读；新增 `0003_incremental_media` 仅迁移 history.db，移除旧巡检的 seen_cycle 并新增 pending-media 队列。Projection version 为 3，默认 generation 使用 incremental-v3 前缀；不兼容的显式 generation 不能继续恢复。

## 同步范围与恢复

- 初建分页建立 history 自有定位索引，再按固定成员上界物化。持续发现只读取 events、TR、compactions 中高于持久 ID 水位的行，游标不归零。正常 edit/delete/runtime 是新事件。
- 已有动画回填会给旧事件补入缺失 hash。只记录这些 event ID，以及缺失描述的 cache key；公平调度定向重试，不扫描完整缓存表。目标补齐后，刷新入队与 pending 移除在同一事务提交。
- ID 游标、观察指纹、定位索引、待补齐目标和观察队列只在 history.db 中持久化。媒体刷新和消费前缀均可在异常退出后恢复，不依赖通知或 producer ACK。
- 空闲 100 步的回归断言确认旧来源正文读取为 0；在 50 条已完成消息后新增 ID 51，所有事件正文读取均为 ID 51。更新已有消息时仍按私有索引定向恢复它的 canonical 修订及直接父消息。
- 回归覆盖 observation/queue/ID checkpoint 回滚、媒体 completion/queue/removal 回滚、缺失 hash 先补而描述后补、离线补齐、跨群共享描述、新群、较早时间戳插入、task 关联、子进程 SIGKILL 恢复和有积压的有限 shutdown。删除了没有实际生产依据的旧 TR/runtime 原地修改测试。

缺失媒体若未被生产者补齐，会保持 pending，不阻塞追加归档或 baselineComplete。任意旧正文/TR/摘要修订及已存在描述覆写不属于持续同步契约，手工修改或显示策略变化应显式重建；没有通用旧行变化检测器。完整边界见 [history-input.md](history-input.md)。

## 真实归档副本

使用既有一致 SQLite 备份，其源库为现有 0032 schema、33 条迁移记录，1,057 个 events 和 196 个 TR。Worker 在初建中 SIGKILL，离线期间只向测试副本追加较早时间戳消息和摘要，再用编译后的 worker 恢复。

4 个群共 1,529 条结果与完整 Projection/rendering/IR oracle 逐项一致，差异为 0；SQLite 和 FTS integrity 通过。来源 schema/迁移 hash 一致，控制性 fixture 写入完成后全部源表数据的 worker 启停前后 hash 一致。稳定状态的高水位为 events=1058、TR=196、compactions=1，队列积压为 0。副本仍有 123 个未补齐媒体目标；测试不启动媒体生产者，不把 baselineComplete 宣称为媒体完整。

见 [真实归档证据](history-incremental-evidence/real-online.json)。原线上容器 ID、镜像、StartedAt、restart count=0 均保持原状，配置 SHA-256 仍为 `6893e75c53ef673cc961ac3de7ec83287caf639966dcd5e56c8046f8ad36fc8f`。没有生产迁移、实例替换、commit 或 push。此前 full-scan 镜像候选已标记过期，不能用它部署当前实现。

## 默认限制与 token 规模

隔离容器沿用现有 Node 22 原生依赖，network none、0.5 CPU、1536 MiB 内存。五个用例均使用默认 64 MiB 来源/128 MiB 编码工作集及 100 rows/sec 调度限制，没有提高预算、裁切正文或用 16 倍系数估算内存。编码工作集不等于 RSS。

Token 由 tiktoken 0.14.0 / o200k_base 实测，仅计正文。重启用例在初建中 SIGKILL，离线追加一个真实 canonical edit，恢复后再追加一条消息；因此归档正文累计为 1,002,000 token，最终消息条目为 1,001。单 TR 为 500k 输出加 500k 工具结果。所有正文、回复和搜索文本均以完整 hash 校验，差异为 0，SQLite/FTS 校验全部通过。

| 用例 | 正文 token | Saved items | 秒 | 峰值 RSS MiB | 峰值编码工作集 MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| reply-chain-1M | 1,002,000 | 1,001 | 48.00 | 113.33 | 0.077 |
| archive-1M-restart | 1,002,000 | 1,001 | 31.64 | 107.12 | 0.036 |
| archive-10M | 10,000,000 | 10,000 | 276.83 | 115.40 | 0.036 |
| single-message-1M | 1,000,000 | 1 | 3.42 | 267.66 | 30.009 |
| single-TR-1M | 1,000,000 | 3 | 2.62 | 127.52 | 8.146 |

长回复链验证 1,001 条消息和 1,000 条回复。单大 TR 保存完整输出、调用与结果，4 条工具关系一致。RSS 按 worker `/proc/<pid>/status` 每 10 ms 采样；实际采样受调度影响。耗时含独立 worker 初建、恢复、追赶及退出，不是生产性能承诺。见 [规模证据](history-incremental-evidence/million.json)。复现脚本是 `history-online-evidence/acceptance.mjs` 和 `million.mjs`，输出目录必须为新的隔离路径。

## 完整检查

`pnpm typecheck`、`pnpm lint:fix`、`pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000`、`pnpm build` 全部通过：52 个测试文件、522 项测试。源库 schema 生成无变化；独立 history schema 与其 0003 迁移一致。

见 [检查摘要](history-incremental-evidence/check-summary.txt)、[源库 schema](history-incremental-evidence/schema-source.txt) 和 [history schema](history-incremental-evidence/schema-history.txt)。查询 SDK/API、SQL guard 与 memory 仍在后续范围，现有 read_old_messages 不受 history.enabled 影响。
