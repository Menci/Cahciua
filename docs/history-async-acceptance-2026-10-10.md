# History 异步同步实现验收

对应 [同步架构](history-sync-design.md)。本轮在隔离 worktree 和无网络 Docker 中完成代码修改与验收，沿用现有 Node 22 原生依赖，限制 1 CPU / 1536 MiB。没有修改正在运行的 bot、部署配置或已有生产数据，没有提交或推送。

## 已实现

- Pipeline 与 rendering 不再发送或保存可丢弃 hint。History 用持久来源/任务自行调度共用 rendering。
- 既有媒体缓存和附件写入成功后，由 DI composition root 发布 compact 完成事实。生产者立即返回，不等待 IPC、持久接收 ACK 或构建。
- 后台交付保留有界待交付 keys，重试一个 outstanding receipt frame；同一时刻只有一个 transport write。饱和保留恢复请求，重连无条件请求恢复。
- `history_build_inputs` 保存接收的定向检查/恢复任务。ACK 只表示已持久接收；依赖检查、Projection/rendering 和 FTS 后续独立执行。
- 完成检查进入既有 History 观察/fanout 任务链路，pending 的调度和对应观察原子提交；pending 清理与已完成物化原子提交。
- 正常运行不定时轮询 pending。首次登记后做一次可靠核对，启动/重连/溢出才做有限 pending 恢复，游标与上界保存在 history.db。
- 慢构建或持续失败时，在 256 条待消费观察处暂停新增来源发现；尚未读取的归档继续作为恢复依据，压力不传回主流程。
- 新增 `0004_async_media_delivery` 只迁移 history.db，保留旧 pending 目标及 generation 身份。原库 schema/写入职责不变。

## 故障与职责验证

| 场景 | 验证结果 |
| --- | --- |
| History options 解析失败、未就绪、IPC 抛错或无接收确认 | Producer 调用同步返回；后台保留并重试；核心归档继续 |
| 接收事务被 SQLite trigger 拒绝 | 不 ACK，发送端保留输入；解除失败后恢复并生成可搜索描述 |
| 已 ACK 后输出事务失败，再 SIGKILL | 发送端已释放通知；History 的持久任务独立恢复，不漏输出 |
| 媒体已提交但最后一次通知未发送，创建全新主运行时 | 从持久 pending 恢复，无旧内存通知也能补齐 |
| 通知内存容量不足与 transport callback 停滞 | keys/bytes 有界，保留恢复请求；不积累并发 Node transport writes |
| 新事实到达时旧 ACK 返回 | 旧确认不会清除较新的同目标事实或恢复请求 |
| 来源读取与 pending 登记之间完成媒体写入 | 登记核对覆盖竞争，最终正文/FTS 与归档恢复一致 |
| Pending 恢复半途重建 builder | 保留有限 upper/after 游标，恢复未完成职责 |
| 无新通知的正常 idle，仍有缺失媒体 | 不读取旧 event 正文；没有正常 pending 轮询 |
| 调度事务失败、构建持续失败 | 输入、观察及进度不跳过；来源发现停在积压上限，解除后覆盖全部新增行 |
| 接入关闭与既有 read_old_messages | 关闭时无 worker/通知；既有工具继续独立可用 |
| 升级旧 History pending schema | 两类原有缺失目标完整保留，无 runtime legacy fallback |

回归测试包含真实磁盘 SQLite、独立只读来源连接、真正 fork/SIGKILL 的 worker 和实际迁移，不以模拟队列代替持久性验证。

## 百万 token 与真实归档

仍使用默认 64 MiB 来源 / 128 MiB 编码工作集和 100 rows/sec，没有提高限额或裁切正文。Token fixture 来自 tiktoken 0.14.0 / o200k_base，仅计正文；验证编译后的独立 worker。重启用例在初建中 SIGKILL，离线追加 edit，恢复后再追加消息。

| 用例 | 正文 token | 条目 | 耗时秒 | 峰值 RSS MiB | 峰值编码工作集 MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 长回复链 + 重启 | 1,002,000 | 1,001 | 48.96 | 110.39 | 0.077 |
| 普通归档 + 重启 | 1,002,000 | 1,001 | 30.21 | 107.91 | 0.036 |
| 单条大消息 | 1,000,000 | 1 | 2.74 | 268.67 | 30.009 |
| 单条大 TR | 1,000,000 | 3 | 2.42 | 128.09 | 8.146 |

完整正文、1,000 条回复快照和搜索文本 hash 均无差异；大 TR 的输出、调用、结果及关系完整。RSS 是真实采样，不是编码工作集或估算倍率。见 [规模证据](history-async-evidence/million.json)。

真实归档使用已有一致快照的隔离副本，初始 1,057 events、196 TR。初建中杀死 worker，向副本追加新消息/摘要后恢复，最终 4 群、1,529 条目与归档参考构造一致，差异为 0，SQLite/FTS 校验通过，全部来源行、schema 和 migration 指纹保持不变。见 [归档证据](history-async-evidence/real-online.json)。它证明只读构建与恢复，不代替专门的媒体通知故障测试。

## 必需检查与边界

`pnpm typecheck`、`pnpm lint:fix`、`pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000`、`pnpm build` 全部通过：54 个测试文件、531 项测试。源库与 History 的 Drizzle schema generation 均无新增差异。见 [检查记录](history-async-evidence/check-summary.txt) 、[完整回归日志](history-async-evidence/test-run.txt) 和 [构建日志](history-async-evidence/build.txt)。

同步能力仍由顶层 `history.enabled` 控制，默认 false；查询 SDK、SQL guard、CodeAct 和 memory 保持后续范围。核心归档未保存的显式 reply quote 仍不能恢复。观察日志与旧 generations 暂不自动清理，磁盘容量需要监控；独立进程仍共享 CPU/磁盘资源。

生产容器保持原 image、启动时间和 restart count 0；配置 SHA-256 仍为 `6893e75c53ef673cc961ac3de7ec83287caf639966dcd5e56c8046f8ad36fc8f`。没有部署本轮代码。
