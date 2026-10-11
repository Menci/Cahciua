# History 媒体描述刷新验收

`8145eb4` 复用已物化节点时保留之前 hydration 得到的描述。共用 hydrator 将非空描述视为输入权威，因而缩略图描述晚于动画描述完成时，在线 History 仍保存旧描述；消费与 pending 清理成功，正文和 FTS 却不能与完整参考构造收敛。隔离测试复现 pending=0、旧描述搜索命中、新描述不命中。

## 修复职责

- 普通编辑继续复用物化前缀；媒体缓存变化则定向恢复有效原始事件以及回复发生时的依赖，再用共用 hydrator 选择当前描述。
- 原消息、有效 edit/delete/echo 正文提供权威内容；中间 edit 仍仅流式处理指纹。缓存派生描述不会压过当前来源选择，也不盲目清空来源自带描述或贴纸元数据。
- 直接缓存通知即使没有 pending 也核对缓存事实并触发变化。Pending 记录缺失职责，不能充当是否接收通知的条件。
- 新 `0005_refresh_media_descriptions` 是只作用于 history.db 的数据迁移，不新增字段或修改 schema。它为在线 generations 的既有媒体依赖 key 追加持久 source-change，让既有有界消费事务修复消息/FTS，包括 pending 已被清除的旧输出；generation 和来源/消费游标不重置，迁移执行一次。
- 原库仍只读，不增加周期性 pending 轮询或全归档正文重扫，不提高默认预算。

## 回归与检查

新增 6 项回归覆盖：动画先完成、缩略图先完成、已有缓存替换、嵌套 emoji 与历史回复快照刷新、来源描述/贴纸信息保留，以及无 pending 的旧错误输出迁移修复。三项在修复前失败。迁移回归模拟已提交旧输出和已清空 pending，验证追加修复责任、重启消费、FTS 收敛、消费前缀不回退和再次 migrate 不重复入队。

最终 `pnpm typecheck`、`pnpm lint:fix`、`pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000`、`pnpm build` 全部通过：54 个文件 / 540 项测试。前后 History schema snapshot（除身份字段）相同，原库 schema/migrations 无变动。见 [检查日志](history-media-evidence/checks.txt) 和 [修复前回归](history-media-evidence/regression-before.txt)。

本轮不重复上轮已通过的百万 token 基准；编辑预算、历史依赖恢复、真实磁盘 SQLite、接收/输出失败及 worker SIGKILL/restart 回归全部包含在完整测试中。正式升级需保留现有 config / 会话 / history.db，验证迁移定向修复队列完成及当前参考输出/SQLite/FTS，部署证据另存本地 runtime。
