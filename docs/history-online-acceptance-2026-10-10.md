> **历史验收记录，已被只读源库实现取代。** 此文记录曾采用源库同步日志的候选版本；该候选已作废。资源实验仍是当时的测量结果，不代表重构后扫描性能。当前所有权见 `history-input.md`，验收见 [只读来源记录](history-readonly-acceptance-2026-10-10.md)。

# 独立在线历史构建：Docker 集成验收

本轮基于 `71b488b76384a1f36d1ba5cd55caf04ab22d7dfc`，接通独立 writer、原库事务内变更日志、S0/S1 reconciliation、持续消费、shared rendering hint 和 startup/shutdown。查询进程、授权 SQL guard、search/thread/context/sql SDK、CodeAct、memory 和向量检索仍未实现。

## 隔离与来源

生产容器 `cahciua-local` 保持运行，ID `114f2026575ef5dc021c73b947f60ddbea1ba1739bb8b930bfe9142c33d54902`，StartedAt `2026-10-09T10:45:59.597827417Z`。未重启服务，未修改 compose、Dockerfile、env、bot YAML 或生产数据库 schema。验收容器使用相同 Node 22 镜像 `cahciua-local:tdlib-1.8.67-node22`，无网络、0.5 CPU、1.5 GiB 内存，代码和生产 data volume 均只读挂载。

验收脚本通过 SQLite online backup 复制正在使用的原库，迁移仅运行于容器私有 `/tmp` 副本。原库 schema 与 migration 表的前后摘要相同；生产消息可以继续增加，因此不以归档总文件哈希判断其静止。配置文件 SHA-256 前后保持 `6893e75c53ef673cc961ac3de7ec83287caf639966dcd5e56c8046f8ad36fc8f`。

机器证据 [real-online.json](history-online-evidence/real-online.json) 只保存匿名聊天覆盖、计数、cursor、资源状态和一致性结果，不含消息正文、工具参数/结果或凭据。验收副本和临时容器在证据导出后删除。

## 工程检查

最终结果见 [check-summary.txt](history-online-evidence/check-summary.txt)。检查按顺序执行，避免 0.5 CPU 环境下多个验收进程互相争抢资源：

```sh
pnpm lint:fix
pnpm typecheck
pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000
pnpm build
```

四项 exit code 均为 0；52 个测试文件、519 个测试通过（65.07 秒），build 8.525 秒。原库与 history schema 的 fresh migration snapshot 检查均无额外变更。

完整测试包含现有离线 bootstrap 的逐行重启、事务内真实进程退出和 300→3,000 消息/用户规模夹具。在线新增覆盖：

| 场景 | 验证内容 |
| --- | --- |
| 原库事务 rollback | 来源写入与 log 同时撤销，无独立 best-effort 通知 |
| S0/S1、旧行修订和回填 | backdated insert、老 edit/delete、echo、archive-only/nonresident/new chat、summary-only chat 不遗漏 |
| history 事务失败 | items、FTS、关系、状态/完整 revision chain 与任务 checkpoint 同时回滚，consume prefix 不跳过 |
| 预算失败恢复 | 大行/依赖超限保留 pending cursor，提高预算后同 generation 恢复 |
| 附件与 shared cache | animationHash 后补、共享 description 更新、custom emoji 更新后正文和 FTS 刷新，不调用媒体模型 |
| 任务身份 | completion 先到、TR 后到，以及旧 TR/runtime 的身份修订、唯一/歧义变换均重新校验 |
| rendering reuse | digest 匹配直接复用完整结果；缺失/失效回到公共 formatter，输出相同 |
| 有界通知 | 1,000 次 hint 插入仍受 count/byte 限制；pipe 满、离线、重启不保留无界父进程队列 |
| 独立实际进程 | producer 持续提交，child bootstrap 中途 SIGKILL，自动重启恢复；实际 hint reuse 至少一次 |
| 有 backlog 的停机 | 100 条 pending 来源仍能在 2 秒内停止，不同步 drain；保存进度小于来源最新 seq |
| 迟到 producer | shutdown 期间的 ingress transform、下载、动画描述和 emoji 回填不会再提交/回放 |
| 唯一 writer | OS 锁阻止第二 writer 和符号链接别名，拒绝硬链接，read-only reader 可并发 |

## 真实归档与构建产物

`acceptance.mjs` 从真实只读归档复制后，启动源文件 child。在至少一条 event checkpoint 提交后 SIGKILL；child 离线时，在副本提交一条 backdated message 和一条 summary。随后直接用 **构建产物 `dist/history-worker.mjs`，无 tsx loader** 恢复同 generation，等到固定 baselineComplete、consume seq 达到最新 log、lag=0 后 SIGTERM。

最终每个聊天的所有 saved item JSON 与独立 `buildHistoryInput` + 公共 reducer/rendering 重建结果逐项比较；检查条目数量、完整内容、来源 revision、回复、工具关系和所有摘要，而不是只看 scanComplete。执行 SQLite integrity 和 FTS external-content integrity，并确认新增 summary 可搜索。实际计数和资源峰值以 JSON 证据为准。

此次真实快照为 1,057 条 events、196 条 TR、0 条 compaction，覆盖 4 个聊天；副本注入两条来源后，保存 1,529 个条目（850 message、196 model-output、241 tool-execution、241 tool-result、1 summary），全量比较 **0 mismatch**。367 条 reply、241 组 call/output/result/tool-member 关系保留。S0=0、固定 S1=2、consumeSeq=2、pendingSeq=null、baselineComplete=true、lag=0；12 个 per-chat/source scan flag 全部完成。

恢复范围修正后再次完整验收，Online backup 用时 121.03 ms。最大真实 TR 编码为 2,224,857 bytes，已超过此前 2 MiB 默认 source 限额；本次全部默认配置完成处理。最终 built worker 状态采样为 RSS 122,654,720 bytes，重启后 peak encoded workspace 106,976 bytes、peak state entries 4，平均 57.47 row/task steps/s、最后 batch 1.00 ms，source WAL 309,032 bytes、history WAL 4,194,192 bytes；这些是此规模验收的样本，不代表大规模持续生产的峰值，也不包含重启前 child 的峰值。实际 hint reuse 由独立进程夹具证明；真实验收中的 hintsReused=0，因为它没有 Pipeline 主进程。

真实快照没有 compaction，故 summary 的真实进程流程由副本注入验证；shared media cache、老附件回填、可读 assistant 输出和复杂任务身份等不足场景由 SQLite/进程夹具补齐，未声称生产归档天然包含所有这些场景。

## 复现

从仓库根目录运行，依赖和 generated TDLib types 使用对应镜像已有版本。`WORKTREE` 指向本 PR checkout；容器名、output 目录均须选新的。容器只读挂载原 volume，代码复制到容器本地后才执行 lint/build：

```sh
docker run -d --name cahciua-history-online-verify \
  --network none --cpus 0.5 --memory 1536m \
  --mount type=bind,src="$WORKTREE",dst=/source,readonly \
  --mount type=volume,src=cahciua-local-data,dst=/archive,readonly \
  --entrypoint sleep cahciua-local:tdlib-1.8.67-node22 infinity
docker exec cahciua-history-online-verify sh -c '
  mkdir -p /verify/code
  cd /source
  tar --exclude=node_modules --exclude=types --exclude=.git -cf - . | tar -xf - -C /verify/code
  ln -s /app/node_modules /verify/code/node_modules
  ln -s /app/types /verify/code/types
  cd /verify/code
  pnpm lint:fix
  pnpm typecheck
  pnpm test:run --maxWorkers=1 --no-file-parallelism --testTimeout=60000
  pnpm build
  node --import tsx docs/history-online-evidence/acceptance.mjs \
    --archive /archive/cahciua.db --out /tmp/history-online-final
'
docker cp cahciua-history-online-verify:/tmp/history-online-final/real-online.json ./real-online.json
docker rm -f cahciua-history-online-verify
```

脚本拒绝复用已存在的 output 目录，不覆盖旧证据；脚本自身不输出真实正文。单独运行进程夹具：`pnpm exec vitest run src/history/worker.integration.test.ts --maxWorkers=1 --testTimeout=60000`。

## 运行限制与剩余工作

默认 source/encoded-workspace 限额现为 64 MiB/128 MiB，直接计量来源、恢复依赖和提交计划的序列化字节，没有展开倍率。真实归档验收使用全部默认 limits，不再添加 3 MiB/96 MiB override；未修改生产配置。真正超出单个工作单元内容限额时会暴露 error 并保留 cursor，需停止 owner、调整 operational limits 或工作策略后恢复同 generation，不能跳过失败来源或并行启动第二 writer。

原库 log、event locator index、旧 generation、message state/revision 和 fanout tasks 需要磁盘空间；本轮不做 log pruning 或 generation promotion/cleanup。单个当前来源的 fanout 可以部分物化，pendingSeq 明确表示其未完成，只有全部任务完成才推进 continuous seq。原库 physical DELETE 不是受支持的清理方式；缺失 event/TR/summary 证据阻塞 prefix。代码处理 Telegram 的 canonical delete，不推断 source 删除后的替代证据。

限额约束的是一个工作单元的 encoded content，不估算或保证 V8/native RSS。source preflight 在读取/解码之前检查已知大行，最终 plan 检查在构造后进行，不覆盖所有瞬时字符串分配。worker 一次只持有一个来源和有限依赖，history 分批写；状态报告 encoded workspace、实际 RSS/heap/external/array buffers、处理速率、延迟和 WAL 大小。后续仍需查询授权/SQL guard、独立 query worker 与 SDK、长期 memory，以及 generation/log 生命周期管理。

## 资源控制重新评估

此前沿用 bootstrap 的 `bytes * 16` 和 `workspace / 16`，没有实测支持。它把累计序列化 bytes 当作内存预测，使正常来源被一个推测系数阻塞。已移除全部此类算式，并将“编码内容计量”和“进程内存测量”明确分开。历史读取还通过公共 codec 跳过 Sharp custom value 的恢复，保留图片位置而不创建 Buffer/Sharp；Driver 的完整 IR 恢复不受影响。

[resources.mjs](history-online-evidence/resources.mjs) 在相同 0.5 CPU/1.5 GiB、无网络 Docker 中生成纯夹具，每个 case 用独立实际 child 和默认 limits。父进程每 10 ms 从 `/proc/<pid>/status` 采样 child RSS，避免把夹具创建的内存混进 worker。完整结果见 [resources.json](history-online-evidence/resources.json)：

| 来源 | peak encoded workspace bytes | 实测 child peak RSS bytes | 结果 |
| --- | ---: | ---: | --- |
| 3 MiB assistant 正文 | 6,293,443 | 170,954,752 | 全文及 FTS 尾部保留 |
| 8 MiB tool result | 16,779,164 | 242,794,496 | 全文及 FTS 尾部保留 |
| 32 MiB tool result | 67,110,812 | 567,873,536 | 全文及 FTS 尾部保留 |
| 约 16 MiB 编码的有效 PNG | 16,809,021 | 179,032,064 | 只存原位置，不做媒体解码 |
| 连续 8 条 8 MiB result | 16,779,192 | 268,058,624 | 8 条完整，单工作单元 encoded peak 不累加历史 |
| 1 MiB `&` 正文 | 15,731,426 | 257,409,024 | 实际 XML 转义后的内容全部保留 |
| 64 MiB result 加封装/metadata，超过 source 限额 | 0 | 141,254,656 | 在读取解码前明确失败，0 items、bootstrap cursor 未推进 |

64 MiB source/128 MiB encoded workspace 是经这些支持场景及真实归档验证的有限内容上限，提供大条目的处理空间，不是声称进程只用 128 MiB RAM，也不是从 RSS 乘除一个系数得来。32 MiB result 已实测约 542 MiB RSS；接近上限的其他对象布局、更多依赖或多层转义仍可能需要更多内存，不宣称所有 64 MiB 来源都能在任意容器内存下处理。结构化分段解码和巨型单元分段物化仍是进一步降低此类峰值的工作。

复现资源实验（新的 output 目录，容器内仓库根目录）：

```sh
node --expose-gc --import tsx docs/history-online-evidence/resources.mjs --out /tmp/history-resources
```

`--expose-gc` 只用于夹具父进程在创建来源后释放生成数据；被测 child 不使用它。默认真实归档验收脚本不传任何 limits。正整数覆盖仍可用于部署资源约束和错误恢复，正常验收不依赖手动提高限额。

## 百万 token 压力验收与长回复链修正

现有真实归档通过不代表所有峰值可通过。本轮进一步用 `tiktoken 0.14.0 / o200k_base` 实际编码计数，生成包含中文、英文、SQL/JS、JSON、emoji 和 XML 转义字符的纯合成文本。每条短正文恰好 1,000 tokens；长正文恰好 1,000,000 tokens（4,296,322 UTF-8 bytes）；TR 含 500,000-token assistant 正文和 500,000-token 工具结果。计数范围是正文，不包含 role、XML/JSON 包装和回复快照；没有调用模型，也没有修改 Driver 上下文/compaction 限额。

可复现生成器为 [million-fixtures.py](history-online-evidence/million-fixtures.py)，验收为 [million.mjs](history-online-evidence/million.mjs)。tokenizer 只安装在临时 Python 目录，不增加项目依赖。被测 child 使用 `dist/history-worker.mjs`、无 loader、全部默认 limits、0.5 CPU/1.5 GiB 无网络容器；父进程每 10 ms 独立采样 RSS。每条保存正文用 SHA-256 与原始 fixture 比较，完整 reply snapshot 单独比较，检查 `search_text`、工具关系及 SQLite/FTS integrity。相同正文不会合并消息：消息身份和条目数分别检查。

首次增量压力验收实际失败，证据保存在 [million-chain-before.json](history-online-evidence/million-chain-before.json)：1,000 条首尾连续回复、总正文 1M tokens，bootstrap 完成后，离线修订第 500 条导致 seq=1001 卡在 pending。恢复函数递归读取所有回复祖先，触发 `maxStateEntries=256`。这与总文本 token 数无直接关系，而且初次 bootstrap 使用持久化直接父消息，因此只测首次扫描无法发现。

修正保持 256 依赖上限。恢复目标的完整 canonical 修订，并仅恢复直接父消息在目标创建前的修订；公共 reducer 只复制该父消息的作者和正文，不复制父消息自己的 reply snapshot。新增 300 层回复链回归测试：旧实现稳定失败；修正后目标节点与完整公共 reducer 回放结果相同，只计量 4 个状态/来源项。没有增加递归层数预算、切掉回复正文或跳过来源。

最终重跑长回复链时，等 event checkpoint 至少达到 600 后 SIGKILL，在 child 离线期间修订第 500 条来源，再通过最新构建恢复同 generation；追平后新增第 1,001 条回复。普通 1M 累计归档也验证 SIGKILL、已构建旧来源修订和恢复后新增消息。其余场景分别验证 10M 累计归档、单条 1M 消息和单条 1M TR。

最新构建的完整结果见 [million.json](history-online-evidence/million.json)，五项均 `fullContentVerified=true`、`mismatches=[]`、`error=null`、`logLag=0`：

| 场景 | 正文 tokens | 最终 items | peak encoded workspace bytes | 实测 child peak RSS bytes | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 连续 1,000 层回复、SIGKILL、旧来源修订、恢复后新增回复 | 1,001,000 | 1,001 | 80,343 | 122,544,128 | 39.32 s |
| 1,000 条消息、SIGKILL、旧来源修订、恢复后新增消息 | 1,001,000 | 1,001 | 37,173 | 119,144,448 | 19.91 s |
| 10,000 条累计消息 | 10,000,000 | 10,000 | 37,219 | 128,671,744 | 167.62 s |
| 单条大消息 | 1,000,000 | 1 | 31,466,378 | 269,201,408 | 3.12 s |
| 单条大 TR：assistant 正文 + 工具调用/结果 | 1,000,000 | 3 | 8,541,664 | 133,910,528 | 2.02 s |

两项恢复实验在启动时恰好 1M 正文 tokens，恢复后新增 1,000-token 消息。长回复链额外逐条校验 1,000 个完整父消息快照；TR 校验正文和结果完整哈希、matched pairing 和 4 条工具关系。计时从 child 启动开始，包含中断/恢复/追平及停止，不含 fixture 创建和最终校验。累计体量从 1M 增至 10M 时，encoded workspace 仍约 37 KiB，RSS 从约 114 MiB 至约 123 MiB；这是该数据布局的测量，不是用倍数推算的内存保证。

复现（宿主生成纯 fixture，复制到隔离容器；不要在受测 child 中计数或创建文本）：

```sh
python3 -m pip install --target /tmp/history-tokenizer tiktoken==0.14.0
PYTHONPATH=/tmp/history-tokenizer TIKTOKEN_CACHE_DIR=/tmp/history-tokenizer-cache \
  python3 docs/history-online-evidence/million-fixtures.py --out /tmp/million-fixtures.json
# 在包含依赖和最新 dist 的隔离容器仓库根目录：
node --expose-gc --import tsx docs/history-online-evidence/million.mjs \
  --fixtures /tmp/million-fixtures.json --out /tmp/million-final
```

生成文件和 output 目录必须是新的。`--expose-gc` 仅用于父进程；child 没有这个参数。正文 token 数不足以单独预测内存：编码、XML 转义、来源布局、直接父消息和单消息修订数量都会影响单工作单元开销。累计归档仍会增加数据库、日志和索引的磁盘体积；本轮没有把这些规模实验表述为任意数据布局、任意历史规模下的保证。


## 全局 YAML 回查开关

顶层 `history.enabled` 默认 false，省略/空 section 均关闭；显式 true 开启，字符串及非 object section 拒绝。修改后重启生效。示例配置、README、history-input、retrieval design 和 AGENTS.md 已统一记录。新规划的独立回查层共用 DI 的 `HISTORY_ACCESS`：worker/hint 检查 `enabled`，未来 query worker、SDK/API、tools 和 prompt 说明的构造/暴露必须检查同一 capability，后端读操作通过 `HistoryAccess.run()` 执行；查询 API 本身尚未实现。已有 `read_old_messages` 不属于这个层，始终按原方式注册和读取基础归档，不受开关影响。

本次在无网络、0.5 CPU/1.5 GiB 临时容器完成上述最终全套检查。新增覆盖 YAML defaults/strict booleans、关闭时 options/spawn/hint 全部不执行、不设置重启 timer、共享 capability 关闭时拒绝执行 callback、已有 `read_old_messages` 的 schema 保留及当前 chat 绑定、全局关闭时其归档后端仍可调用并保留屏蔽用户规则，以及普通 Driver compaction 不受回查开关影响。Driver 注册测试不提供 `HISTORY_ACCESS`，验证原工具没有引入对新层的依赖。实际 DI 容器测试配置关闭且 worker limits 环境变量为非法 JSON，仍可 start/stop 并确认没有创建 history.db；独立 producer/worker 进程测试显式开启，继续验证 SIGKILL 恢复、hints reuse 和完整保存条目一致性。

不修改生产 YAML、不重启生产 bot。基础消息归档、source-change locator triggers 和 Driver compaction 继续持久化；已有 history 进度保留，使重新开启能恢复停用期间的变更。手动 operator CLI/压力验收不属于 bot 的 agent 服务暴露，仍是明确单独调用。环境路径/预算覆盖不能开启 bot 的独立回查层。
