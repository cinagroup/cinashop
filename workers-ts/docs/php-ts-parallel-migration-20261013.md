# PHP → TypeScript 并行迁移：只读接口增量（2026-10-13）

本轮并行承接工作区已有的后台操作日志、公开逆地址解析和 Supplier 选品目录三个未提交增量，对照相邻只读 PHP 仓库核对合同并补齐本地验证。它们新增六个 TS 注册，覆盖五条旧 PHP 声明；默认品牌入口是 optional type 合同的额外显式注册。当前为本地候选，整体迁移目标继续进行。

本文件是聊天 `01a1332d…` 的补充复核与独立原生执行报告。跨聊天整合的[主报告](parallel-php-ts-migration-20261013.md)及[主账本](../audit/parallel-php-ts-migration-20261013.json)由聊天 `01a13321…` 维护；主报告的 265 普通／41 原生、267 不同案例属于其明确选定范围，不包含本聊天额外的 8 项旧 Admin 权限回归。不同范围的总数不能直接相加。

| 独立模块 | 旧接口 | 实现和边界 |
| --- | --- | --- |
| Admin 操作日志 | `GET /adminapi/system/log`、`GET /adminapi/system/log/search_admin` | 旧 `list/count` 和 `info` 字段、包含文本筛选、真实管理员层级、日志读权限、单一只读快照；保留 PHP 有效时间边界，查询不触发旧构造函数的历史删除。 |
| 公开逆地址解析 | `GET /api/geoLbscoder` | StationOpen、匿名读、纬度在前、旧成功/失败信封；固定腾讯 HTTPS 服务、服务端配置、来源和全局 DO 预算、5 秒/32 KiB 边界、受控错误和私有不可缓存响应。 |
| Supplier 选品目录 | `GET /supplierapi/product/product_label`、`GET /supplierapi/product/brand/cascader_list/[:type]` | 标签组/叶和品牌树、默认/1 两级与 2 完整树、旧排序和命名时区；真实 Supplier 身份和权限、同 owner 关系、平台品牌及只读快照。 |

Admin 时间核对修复了迁移草稿中的差异：双端午夜或相等结束端先加一天，再保留 `BETWEEN` 的包含末秒；仅结束端始终加一天后严格小于；`quarter` 结束为季度末日零点，包含该秒。epoch 零值沿用 PHP 的假值语义。逆序、畸形、重复及超限参数明确拒绝；身份泄漏、GET 删除和任意 provider 字段透传不进入兼容合同。详见 [日志合同](admin-legacy-system-log-20261013.md)、[定位合同](public-geocoding-contract-20261013.md)和[供应商合同](supplier-product-selection-catalogs.md)。

针对性补充覆盖午夜/季度/单端范围、等排序次键、历史中国夏令时、manage 读取权限、非法 UTF-8、超时后迟到响应取消和畸形 DO 决定。原生 PostgreSQL runner 只新增三个具体测试文件到隔离集群维护白名单，并保留参数准入回归；没有开放任意脚本或现有数据库。

## 实际验证

最终原生与类型复验已完成。实际执行的结果如下；源码存在、测试定义、准备过程和条件跳过均不算通过。

| 完整运行范围 | 实际结果 | 范围说明 |
| --- | --- | --- |
| 最终定位服务 `0d754cdb…` | 58／58，exit 0 | 合成配置、DO 决定和 fetch；没有真实腾讯调用。 |
| Supplier 目录 | 23／23，exit 0 | PGlite、真实路由/JWT/账号关系/权限及实际 SQL。 |
| 最终日志服务 `54a4043c…`、普通测试 `d8d11664…` 与新日志权限 | 19／19，exit 0 | 两个完整普通文件；包含历史时区新增断言，不借用 `c0f21c34…` 或 `0fe9fa58…` 旧版成功。 |
| Admin、旧数字权限与 Supplier RBAC 回归 | 42／42，exit 0 | 三个完整文件；按原 5000 ms 用例期限串行复验。 |
| 本机 PG runner 准入回归 | 126／126，exit 0 | 参数/路径/具体维护文件白名单；完整文件复验。 |
| 独立 PostgreSQL 16.15 三文件 | 41／41，exit 0 | 最终原生测试 `ba36cd5d…`；独立 LOGIN、只读拒绝写入、并发快照和 PostgreSQL 时区端点独立比对。集群残余夹具为 0 且已停止。 |
| 完整 Worker unit/runtime 类型 | unit=0、runtime=0，两个原始诊断日志均 0 字节 | 由整合聊天在最终来源上执行；3896 个输入前后摘要相同，不能用时区修正前结果替代。 |

本聊天普通通过合计 268 项。原生文件重复运行了其中的日志与 Supplier 案例，不能再把全部原生通过数加到唯一测试数量中。整合聊天另有包含现代日志前端的最终相关回归，见主报告，不在本聊天重复累加。最初的 PGlite 到期观察器失败、并行 CPU 争用导致的四项超时、runner 子进程一次瞬态入口读取失败、原生错误包装断言失败均保留；通过只采用对应最终来源的完整复验。

本聊天执行收据、首轮失败、工具与锁版本、来源 manifest 和最终共享源码核对见[完整验证记录](../audit/parallel-validation-01a1332d-20261013/validation-summary.json)。当前本机副本基础 manifest 为 4076 个输入；最终三处时区/原生修正及其他 14 个共享输入另作精确核对。报告正文后续变化单独记录，不声称全仓文档始终未漂移。原生完整输出保留 `FINANCE_LOCAL_FIXTURES remaining=0`、`FINANCE_LOCAL_STOPPED`，集群数据和失败日志保留。

双类型的实际[退出码](../audit/parallel-zone-typecheck-exits-20261013.json)与[执行前输入](../audit/parallel-migration-named-zone-before-20261013.json)、[执行后输入](../audit/parallel-migration-named-zone-after-20261013.json)属于整合聊天：3896 个输入、零副本差异、摘要 `70113864d3905ea6e8a009d75c98445a6bf58d4c73095f7f6f3f5f593a923aa4` 前后相同。它与本聊天 4076 输入 manifest 的选择范围不同；只在重叠来源和最终三处 SHA 经核对后引用。

完整 PHP 来源路由审计实际 exit 0：[冻结前基线](../audit/route-parity-parallel-baseline-20261013.json)为 PHP 1904／TS 2397、旧可执行 904、可行动缺口 962；[本批后续](../audit/route-parity-parallel-followup-20261013.json)为 TS 2403、旧可执行 909、可行动缺口 957、有效可执行覆盖 48.2%。原始缺口仍为 974，其中 17 项有旧源证据退役；21 条已注册但受控不可用保持不变。静态净减少五条旧合同，不等于完整行为、数据或部署验收。

初始 UNC 测试入口曾因 Vite 无法解析包入口而退出，未执行测试；该失败保留，不作为业务失败或成功。验证副本使用本任务明确可写的本机目录，并以源码和 lock 哈希核对。未复制 `.env`、`.dev.vars` 或部署私有缓存。

## 剩余范围

本轮不关闭 Checklist 的 404 项／249 完成／155 开放，或 Audit 的 88 项／50 完成／38 开放父项。旧完整页面接入、生产真实角色和历史数据、规模与索引表现、腾讯真实 key/授权/配额与位置精度、Worker/DO/Hyperdrive 真实运行时、设备和发布仍需各自验收。Supplier `all_label` 的旧 controller/service 参数不符，保持独立开放。

冻结后只读发现的历史时区差异已由整合聊天修复并通过最终普通与原生复验：[原独立证据](../audit/parallel-validation-01a1332d-20261013/historical-timezone-gap.json)记录原固定 UTC+8 对 `1990/07/01 00:00:00` 得到 `646761600`，相比 PHP `Asia/Shanghai` 的 `646758000` 相差一小时。最终服务 `54a4043c…` 使用命名上海时区和完整唯一往返匹配，日历与滚动日期也按该时区计算；PHP 显式结束端的 `+86400` 仍按实际秒数保留。不存在或重复的历史时钟明确拒绝并记录为收紧，范围保持 1970–2038 整数时间戳。新增普通断言覆盖夏令时、23/25 小时日、日历/滚动窗口及不唯一时间；原生用 PostgreSQL `AT TIME ZONE 'Asia/Shanghai'` 独立核对三组端点。原差异证据与旧执行结果保留，不借给新实现。

本轮没有生产读取、数据库 DDL/DML、真实腾讯请求、提交、推送或部署。原生测试 DDL/DML 只在本机新建的独立测试集群及随机夹具数据库中执行。公开定位使用既有配置读取器，可能回填普通 KV 配置缓存；没有新增位置结果缓存。
