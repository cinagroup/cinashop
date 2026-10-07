# 本机完整单元回归门禁

本机验证不替代不可变 Linux CI、生产 Hyperdrive、真实商户或完整权限/负载验收。线下收银 type=3 保持 PHP 范围，不新增退款，最低应付 0.01 元。

## 明确入口与隔离

在 `workers-ts` 运行以下两个命令，每个命令创建自己的全新 PostgreSQL 16 集群：

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance <trusted-pg16-bin-dir> audit:unit-shard-1
node scripts/run-local-finance-postgres.mjs --schema-maintenance <trusted-pg16-bin-dir> audit:unit-shard-2
```

仅接受这两个精确别名，不可混入文件过滤、名称过滤或任意命令；普通定向测试入口和其十分钟期限不变。全量分片的进程期限为四十分钟，测试自身期限、隔离和断言不变，每片最多两个测试进程。它沿用仓库 CI 的原生 `BaseSequencer` 两分片规则及 `audit-unit-shards.mjs` 实际结果校验，不用忽略分片参数的文件列表代替覆盖证明。

按照 PostgreSQL 最小权限指导，维护身份只在新建的、监听回环地址的自有测试集群内供应，绝不提升已有数据库身份。运行器验证服务版本、数据目录、端口和身份，随机口令不落入报告；移除初始化口令文件。完整测试子进程仅继承必要 OS 环境和显式 workerd 路径，不继承生产 URL、云令牌、任意 `TEST_*` 或 `NODE_OPTIONS`。测试库与角色必须清理，随后停止自有集群；保留受限诊断目录，不递归删除。

## 通过条件和证据边界

- 两片使用一致的原生文件清单，完整且互不重叠。
- JSON 实际执行文件精确匹配所选分片，每个文件至少执行一个断言；失败、跳过、todo 或漏文件均拒绝。
- 子进程正常退出 0；超时、信号或启动失败不能凭 JSON 结果冒充通过。
- 每片运行前后，约定输入范围的 SHA-256 相同；增加、删除和修改均被核对。
- 清理和停机单独核验，不能把测试通过等同资源已清理。

每个私有诊断目录保留 `unit-gate-inputs.json`、原生 `unit-shard-results.json`、`unit-gate-result.json` 和 PostgreSQL 日志。输入范围包括 Worker 源码、测试、脚本、迁移、根配置/锁文件，以及前端源码、CI 配置和根 checklist/Git 策略。明确排除秘密环境文件、依赖安装、缓存/构建目录、外部 PHP checkout 和 Worker docs/audit。前后摘要一致只是约定范围的端点核验，不是整机、依赖或全过程不可变证明。

## 2026-09-27 显式生成器子进程诊断候选

新增诊断只覆盖十份测试中十二个显式 Drizzle/PGlite `spawnSync` 调用点：CHECK 状态、列默认值、真实 CLI 生成、NOT VALID、索引顺序、sequence、外部重复索引、外键命名、客服 sequence、缺失约束。CJS/ESM 或 CLI generate/export 可能在同一调用点执行多次，不能把十二个调用点说成十二次实际执行。Vitest 内部 fork、依赖内部进程、进程内 PGlite 实例及其它数据库维护 CLI 尚未纳入本收据。

父级 helper 原样委派 executable、argv、env、options、stdio、原有 30/45/90/150/180 秒期限和返回对象/异常；原业务断言、文件/fd3 报告验证、并发和版本不变。唯一 start JSON 在调用前同步持久化，返回时原子替换；异常退出后未返回的 start 只证明已进入该父级阶段，不能凭它断言内部 SQL 阶段、child RSS 或已获得原生回溯。记录退出 PID/status/signal/固定白名单 errorCode、单调耗时、既有期限和输出字节数，不记录 argv、环境值、SQL/payload、stdout/stderr 内容或完整 Error。未知错误码/信号只记固定 `UNKNOWN`，不把正则形状当脱敏。

资源字段明确分为 parent 和 host；child 资源固定为 `null`。parent 的 memoryUsage/resourceUsage 不是子进程观测，maxRSS 使用 Node API 的 KiB 单位，其它内存字节数以字段名区分。没有子进程 RSS、原生 heap 诊断或内部执行阶段的观测，不能使用父级/主机值替代。

直接本机目标运行可在 `workers-ts` 使用以下工序。每次必须先创建新的 run，旧收据不计入新运行预算，也不作为新结果的证明：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/audit-native-child-diagnostics.ts --begin
node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/native-child-diagnostics.test.ts test/drizzle-audit-report.test.ts --maxWorkers=2 --reporter=verbose --reporter=json --outputFile.json=unit-shard-results.json 2>&1 | Tee-Object unit-shard.log
node node_modules/tsx/dist/cli.mjs scripts/audit-native-child-diagnostics.ts
```

原有本机完整 PostgreSQL runner 的输出仍位于它自己的私有任务目录；本增量没有修改 runner 或把其旧完整门禁称作已包含新诊断审计。上述目标不替代完整 Linux CI/原生目录/真实业务验收。

忽略的 `.cache/native-child-diagnostics` 中每次有独立 run UUID、manifest、start/terminal 收据。单收据最多 16 KiB；当前 run 审计最多 256 次调用、总 8 MiB，预算不包含其它 run。目录/文件不接受 symlink、junction 或硬链接别名；记录、输入和发布文件均有名称/路径/读取大小边界。诊断写入异常保留原子进程返回/异常，并发出仅含固定字段的 unavailable 事件；不能因另一份好收据就把缺失的调用记录算完整。

审计以最终 Vitest JSON 的实际执行文件推导应有的操作；缺模式、缺/过大/损坏记录、尚未返回的 start、写入异常事件、陈旧 run 或输入都拒绝完整证明。即使最终 JSON/log 缺失，也保留可验证的 manifest/已知记录和 `complete=false` 摘要，明确标记预期范围/log 未知，继续退出非零。只有经严格白名单验证的 JSON 可进入 published 目录；未知字段、错误详情或原生 dump 不复制。诊断完整只表示捕获完整，不表示原子进程或原测试通过；原退出/测试/零跳过门禁继续独立生效。

Linux workflow 保留原 unit 命令、两分片、90 分钟帽和完整覆盖门禁，只添加 fresh run、失败时仍执行的诊断审计和 published JSON 的 always 保留。unit artifact 的 `include-hidden-files: true` 仅作用于现有三条显式路径：unit JSON、unit log 和 `.cache/native-child-diagnostics/published-*/*.json`；隐藏目录中只有经过上述严格验证并发布的白名单 JSON 纳入诊断上传。最终 CI 还需实际检查两份 shard ZIP 中的 audit、manifest 和各条记录，配置本身不作为留存成功的证明。平台强制取消、机器终止或文件系统不可用时，`always()` 仍可能没有机会执行；不能保证一定上传，也不能凭 start 当作已拿到 native backtrace。

TEST-005 保持开放：旧 `corrupted size vs. prev_size` 根因和原生回溯仍未取得，本增量不声称修复它、不人工制造 abort、不加 soak 碰绿、不循环重跑或升级 Node/PGlite/Drizzle。后续受控 Linux 诊断应先只读核对 core_pattern、core 限制、磁盘界限和已有 debugger；不能更改全局 sysctl 或调用未知 pipe helper。只有现有 policy 允许时才对自然出现的 core 做私有本地保留与离线分析。Node fatal report 可作为单独审阅的模式配置环境排除，但不能保证捕获 glibc allocator abort，也不能原样上传含参数/身份/内存的数据。raw core/report/env 不自动上传，导出前仅投影已审阅的信号/frame/module/工具版本/hash/大小，缺失或截断如实记 unavailable。[Node24 report API](https://nodejs.org/docs/latest-v24.x/api/process.html#processreportreportonfatalerror)、[环境排除](https://nodejs.org/docs/latest-v24.x/api/process.html#processreportexcludeenv)、[Linux core_pattern](https://docs.kernel.org/admin-guide/sysctl/kernel.html#core-pattern) 提供对应机制说明；本轮没有启用这些采集模式。

## 2026-09-21 报告传输与中断诊断增量（历史）

外键 CJS/ESM 审计现通过独立 fd 3 同步回传有界 JSON，不再依赖退出时仍存在的临时目录；旧文件通道保留供其它审计使用。接收端严格核对子进程退出、PID、单一完整报告、字段形状及网络阻断证据，缺报、截断、重复、超限或子进程失败均拒绝。测试在自有临时目录中复现旧通道的 ENOENT，并证明管道通道不受该目录删除影响。历史目录的实际删除者仍未确定，不把结构性修复说成已找到删除原因。

本机完整单元入口增加逐模块同步刷盘的哈希链日志 `unit-progress.ndjson`，记录开始、结束、耗时、失败详情及尚未完成文件，并遮盖测试连接凭据。它只用于诊断；验收仍必须取得完整原生 Vitest JSON，实际文件/断言计数须与日志一致，且原有零跳过、输入摘要和退出码约束全部保留。真实 Vitest 两分片测试确认开始事件接收分片前的完整清单，实际执行事件才核对所选分片；初次错误假设导致的红测已修正，未放宽执行覆盖条件。CI 工作流未更改。

最终定向验证为六文件 171 项：报告/日志/运行器四文件 162 项（6.29 秒），完整外键审计 5 项（202.18 秒），旧文件报告通道的 Drizzle 审计 4 项（94.27 秒）。两套 Worker 类型检查通过。新清单为 533 文件，原生分片 267/266，清单 SHA-256 为 `11883982df98c0c03448752ff9f93024665adf5aff20f10bc9e74685cd38c7a3`；**尚未执行修正后完整 533 文件回归**，本机容量及不可变 CI 验收仍开放。未延长测试时限、改变业务服务或访问生产。下节保留上一轮失败历史，不能被上述定向结果覆盖。

## 2026-09-20 运行记录

本轮两个分片均在四十分钟期限以 `ETIMEDOUT` / `SIGTERM` 结束，运行器退出 1，**全量门禁不通过、实际覆盖未完成**。开始时共 531 文件，分片 266/265；2,378 个选定输入的运行前后摘要均为 `aa684f280316d6d4b31083f650fff7f901c870718ba5e890130facc9378e5f22`，无端点变化。两片均未生成完整 Vitest JSON，运行器正确拒绝验收；不能把完整的待运行清单说成完整的实际执行覆盖。控制台摘要只是部分观察，其中一个大量迁移 NOTICE 的片段被截断，不能据此推断完整通过/失败总数。

已观察到四组、至少十一项失败：外键命名 CJS 和缺失约束 ESM 子进程各一项在约 180 秒处失败；Drizzle API 的 CJS/ESM 两项快速失败；拼团取消授权七项失败。随后独立复现确认后两类是过时夹具：前者还断言旧 264 表，而当前版本化完整目录为 277 表；后者遗漏商品行 `uid=11`，真实退款数量预占正确拒绝错误归属。仅修改测试夹具：引用现有共享的精确表数合同、补正确用户归属，新增 uid=0/22 拒绝、数量预占与幂等断言；不修改业务服务、放宽权限/资金校验或新增线下消费退款。拼团原生 PG16 最终 58 项通过，真实退款执行仍为该授权套件原有的 mock，不能冒充退款结算验收。

三个生成器审计按单测试进程、原 90/180 秒子进程期限重跑：三文件 14 项中 13 通过、1 失败，523.34 秒。Drizzle 四项和缺失约束五项通过，不能据此抹掉前轮超时；外键 CJS 与静态检查通过，但 ESM 在约 99 秒后报退出码 1。它已输出全部 141 漂移拒绝、12 个原始提案危险及外键身份/行/回滚断言通过，实际失败为退出时 `drizzleCliAudit.cjs` 写临时 `audit.json` 的 `ENOENT`。临时目录消失原因未定；不忽略错误、不补造报告、不将只完成业务断言的子进程算成功。当前仍有审计产物生命周期失败及本机全量容量问题，尚未证明原生稳定性或修正后全量通过。

运行器边界测试 104 项和最终两套 Worker 类型检查通过；首次新增脚本缺声明的类型失败已补声明后复验。上述夹具修正发生在两片终态之后，因此运行前后相同的摘要不覆盖修正后的完整回归，当前代码仍需全量复验。

两片自动清理未完成：期限中断留下三个 `cinashop_kefu_runner_*` 合成库，第一片另有一个无依赖测试角色；自动停止集群成功。独立确认无监听/自有进程后，以无网络的单用户模式核对精确数据目录、库所有者和角色依赖，再删除三个明确命名的测试库与该角色，复核各片剩余夹具库/角色均为零。没有重启网络服务、改认证配置或清理其它服务；诊断目录保留。原始自动清理失败记录不改写为自动成功。

本机 Windows、Node 24.19.0、PostgreSQL 16.15，CI 为 Ubuntu 24.04、Node 24.14.1、PostgreSQL 16.14-alpine，且本机显式限制每片两个测试进程，因此不得称为 CI 环境等价或使用本机时长保证 CI 容量。workerd 使用此前已验证的本机运行库副本，二进制 SHA-256 再次核对与锁定安装完全一致，未修改系统安装。

另外只读路由审计观察到 PHP 1,904 条、已匹配可执行 866 条、登记但不可用 21 条、缺失 1,017 条（其中已退役 17 条）；静态结果不是业务完成率。可观测性合同校验通过，但生产告警仍为 `pending`，旧生产基线记录六个发布阻碍；本轮未重新访问生产核实这些历史阻碍的状态。

最终四个自建 PG 集群独立核验均 `pg_ctl status=3`，无 PID/临时口令/对应监听、可信测试 PostgreSQL 或工作区 workerd 进程。原九暂存保持，无生产访问、提交、推送或部署，Checklist 240 完成/164 开放/404 总项不变。PostgreSQL 技能用于限定新集群维护权和清理所有权；未执行真实支付或新增线下消费退款。运行句柄、原始失败与选定文件终态摘要见[本轮证据](../audit/local-full-unit-gate-20260920.json)。
