# History 大删除与媒体恢复验收

此前 `eb4bfb9` 有两处进度问题：257 个目标的删除事件被错误当作单步 256 条状态预算超限，阻塞全库来源游标；已完成媒体的缓存被后完成 resolver 覆盖，而通知在交付溢出时丢失后，pending-only 恢复无法重建旧正文/FTS。三个隔离回归在修复前失败，包含首次 bootstrap 的 300 目标删除。

## 实现

- 来源观察不限制事件目标总数，仍预检来源字节；在线 `targets` 任务按有限页展开消息/回复子任务，ordinal 推进与入队原子提交。单步默认预算不提高，也不截断删除目标。
- Bootstrap 每步只载入一个已有删除目标，以该事件的已提交消息修订作为完成标记。输出、FTS 与修订原子提交；全部目标完成后才推进事件 checkpoint。重启不重做已经提交的目标，未知目标不阻塞。
- Recovery 持久接收同时安排 pending-ID 与已登记 cache-key 两种核对任务，保存在一个事务里，随后才 ACK。已完成依赖继续参与 cache-key 恢复；指纹变化才产生重建任务，未变的 key 不重复物化。
- cache-key 核对保存有限 upper key 与 after key，断点继续；重连/溢出重新请求有限恢复。正常媒体完成仍靠通知，不增加周期性媒体轮询或全归档正文重扫。
- `0006_bounded_recovery` 仅给 history.db 的 `history_build_inputs` 增加两列恢复 cursor，并给已有在线 generations 安排一次依赖核对。原库 schema/migrations 不变；现有 generation、source cursor、pending 和输出保留。主进程完全异步边界不变。

## 验证

新增 7 项回归：257 目标删除后的其他群推进、真实 delivery 溢出丢失已完成 key 通知、300 目标 bootstrap、bootstrap 部分提交后输出失败与真正关闭/重开 store、已完成缓存有限 cursor 续跑与 FTS 收敛、两个恢复职责接收事务回滚、fanout 子任务插入失败与 ordinal 回滚。旧预算测试改为验证同一小预算分步完成删除，来源/状态字节超限仍保留 checkpoint。

`pnpm typecheck`、`pnpm lint:fix`、`pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000`、`pnpm build` 均通过：54 文件 / 547 项测试，包括真实 worker ACK、SIGKILL、SQLite 事务失败与恢复。见 [检查日志](history-fanout-evidence/checks.txt) 和 [修复前回归](history-fanout-evidence/regression-before.txt)。

四个实际计量百万 token 用例以默认预算通过：长回复链及强制中断续跑、普通归档及续跑、单条百万 token 消息、单条百万 token TR。正文/回复/搜索差异均为 0，worker 无错误；峰值 RSS 分别约 147 / 145 / 280 / 157 MiB，峰值编码工作空间均在默认限额内。见 [计量结果](history-fanout-evidence/million.json)。

正式升级保留 config、会话及现有 history.db，只运行上述 History 迁移。部署验证包括 generation/inode 保持、原库既有行/schema/migrations 指纹、当前全量参考输出比较、SQLite/FTS 完整性，以及独立 worker 持续 live 与追平。部署证据保存于本地 runtime，不提交生产数据。
