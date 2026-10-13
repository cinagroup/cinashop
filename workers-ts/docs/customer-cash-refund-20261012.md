# 普通 customer 现金、线下与游客退款（2026-10-12）

本批本地候选已完成当前范围验证，尚未发布。最终冻结 **68f3017b61dc37347698a69fdfba7af4f6b3acb67c3a281c1cde00d4a49003dc**，3532 个 Worker 输入与当前仓库逐字节匹配；独立 PG16 **32 个完整文件／939 项通过、0 跳过**的证据覆盖本批。其中 351 项在最终冻结实际执行，588 项保留原985b执行、以严格不变的执行输入证明适用性。双完整类型退出 0，18 个完整普通文件 **414 通过／268 原生条件跳过**在最终冻结实际执行；这些跳过不由其他原生文件抵扣。完整执行、原日志、源码清单、权限与清理凭据见[实际报告](../audit/customer-cash-refund-20261012.json)。

## 业务合同

普通 UserJWT、当前 global customer 资格的七项财务操作框架接入会员和 UID0 游客的正金额人工现金／线下及零金额退款；可用操作仍由实际订单状态与来源证据决定。另一位当前合格 customer 可管理原经营人创建的订单；原操作凭据恢复仍只属于原操作人。正金额要求 decision.cash_returned:true，零金额禁止该字段。游客不创建 user0、不增加余额、不伪造渠道成功。成熟核心在同一事务中处理数量预占、拒绝后重新申请、库存、积分、三代实体拆单和未开票归属。

人工返还证明只可追加，绑定原 UUID、完整意图摘要、退款／原支付／买家／实体身份及实际事务。现金为 CASH_SUCCESS／cash-settled，零金额为 ZERO_SUCCESS／zero-settled。未知或临时失败保留原 UUID 和完整正文；已经返还现金不能耐久放弃或换编号，任何非现金完成回执也不能关闭本机记录。原操作人仍需有效 UserJWT，经营资格撤销后的原凭据恢复不授新写权限。

实际 TS 付款原事务审计与已完成 paid outbox consumer 分别按其真实时间核对，新写要求实际 COMPLETED 与唯一规范消费审计。完整原 PHP productInfo/attrInfo 只作财务投影，不改原 cart_info，不读取今天的 SKU 价格；原 write_times 使用 max(write_times ?? 1,1)。原 PHP 审计允许规范异步任务迟到／重投，但已冻结行的编辑、删除及矛盾追加拒绝恢复。新促销 absence 检查仅对完整核对的 PHP 来源执行只读 SELECT；标记退款子代须先证明实际受保护拆单凭据，现代订单保留原权限合同。已核验写路径共享实际 root/source/cart 行锁；空行 FOR UPDATE 从未提供 gap 锁，不能扩为任意 owner 维护 SQL 防篡改保证。

游客拒绝通知绑定实际退款、实体和不可变五字段事件；可在合法新申请及后续退款代次后消费，旧金额不按当前剩余订单重解释。UID0 跳过微信／站内／账户消息；短信配置关闭不入队，缺目标或模板可 SKIPPED，真实配置及号码生成幂等 PENDING 任务。测试未发送外部短信，PENDING 不记为 DELIVERED。原游客配送消费分支也完整回归。

## 范围与数据库候选

本批新增人工退款付款来源限 customer_cashier_paid、cw_financial_confirm_offline 与完整原 PHP 现金／线下事实；成熟余额／微信／支付宝合同继续保留。原 PHP 零促销 absence 仍要求完整生命周期及权益证据；缺历史促销分配或不可证明权益的来源继续拒绝。admin_order_offline、manager_order_offline 的现代来源仍开放，[下一来源分析](../audit/customer-cash-refund-20261012-evidence/next-offline-origins.json)为只读建议。后台游客发票搜索／详情／已开票重放及红冲仍开放，本批只验退款时未开票申请归属；普通买家 JWT 的原账户和模板权限保持。

src/migrations/maintenance/0180_customer_manual_refund.sql（83145 字节，SHA256 bf8931e928d54ad4009cfda2ac01c0ae5ebb7b7753ec8699c6a0fd2b61b2280e）为显式维护候选，已从通用 external SQL 扫描目录移出，未注册到历史迁移，请求不自动安装。四个实体 buyer-positive CHECK 仅受检升级为 buyer-nonnegative，保留旧发布正文与保护函数。完整八组件必须同为旧或新 profile，混合拒绝。人工／财务及四个 guest catalog 固定指纹分别是：

- manual: 2c7dbb48559779989d08382e71a65c6038d449d2a8f601e01fddddba36f1d5a6
- financial: b0c11112ff4f5fd8e86def727164324cfb7228549d4cdf4f8d59f8bf22095da6
- historyGuest: f0aac4be250c1e1800b50e4b274d629be0156048ca8383d25a2c90d41cb9f71c
- allocationGuest: aba9ff86c3f88283979765a86e0d39e8df53dde31926a1585c95e6e7c6a66395
- splitGuest: 6d8d309a74d565d2389ce69d0573c3992589c9ff2ee8b15d72b0982ca90f5667
- branchGuest: ed0a0a41327ab4ac75ffd73ef8939e90548acc80a836ccc0d8ac8f349e09321d

人工／收银运行角色拥有实际所需 SELECT／INSERT 与受原保护函数约束的 UPDATE(id)，不获得促销 DELETE；既有财务角色仍为促销 SELECT-only，无任何 mutation 或任意列 UPDATE 权限。受限 NOLOGIN／NOINHERIT 所有者仅六表 SELECT 与促销 DELETE。固定函数验证同一事务人工证明、真实支付根和冻结原促销行后执行材料化删除；逐项撤权、实际并发与提交回复丢失均已验证。

## 实际验证

| 原生组 | 完整文件 | 通过项 | 执行来源 |
| --- | ---: | ---: | --- |
| B | 5 | 119/119 | 原985b执行，输入等价保留 |
| C | 4 | 202/202 | 原985b执行，输入等价保留 |
| D | 1 | 4/4 | 原985b执行，输入等价保留 |
| E | 1 | 4/4 | 原985b执行，输入等价保留 |
| F | 4 | 72/72 | 原985b执行，输入等价保留 |
| G | 1 | 48/48 | 原985b执行，输入等价保留 |
| A1 | 1 | 37/37 | 原985b执行，输入等价保留 |
| A2 | 2 | 102/102 | 原985b执行，输入等价保留 |
| H | 3 | 103/103 | 最终冻结实际执行 |
| I | 3 | 84/84 | 最终冻结实际执行 |
| J | 2 | 70/70 | 最终冻结实际执行 |
| K | 3 | 34/34 | 最终冻结实际执行 |
| L | 1 | 27/27 | 最终冻结实际执行 |
| M | 1 | 33/33 | 最终冻结实际执行 |

A2／A1／G／B／C／D／E／F 的19个完整文件、588项通过仍引用原985b日志和原始源码清单。最终差异仅为四个测试、安装 inventory helper 及同正文维护 SQL 移位；684个唯一 import 文件和明确 filesystem 输入逐条 SHA 不变，未执行的全目录扫描支路也已核对。只保留这些原执行，不改旧 receipt、不称全32文件均在最终 raw manifest 重跑。H／I／J／K／L／M、双类型、普通18文件及两条原始静态 CLI 均在最终冻结实际完成。详见[严格范围证明](../audit/customer-cash-refund-20261012-evidence/native-scope-equivalence-after-h-final-20261012/scope-qualification.json)。

各原生组均为原 runner 完整文件，无用例名过滤，原十分钟上限不变；独立集群夹具 0、STOPPED 及独立 pg_ctl 退出 3。Uni 六完整运行文件 284/284，完整类型与 H5／微信／App 构建退出 0；编译 H5 桌面会员／手机游客现金／零金额共 66 检查、38 截图。前端 475 输入当前匹配，相关错误 0、四条主动故障 503 原件保留，浏览器／服务已关闭。浏览器 API 与原生部分 R2／provider transport 为合成，真机及 Worker／Hyperdrive／R2 端到端仍未验收。

两条原始静态 CLI 退出 0：PHP1904／TS2333，旧可执行890／可行动缺口976／有效覆盖47.2%；Uni151→128、28直连／116兼容／7缺口。3532 stage／UNC 输入、3564 外部输入和原106审计输入前后 SHA 相同。Checklist404／246完成／158开放与 Audit88／50完成／38开放的原复选行保留；这些完整迁移父项继续开放。通用 SQL 比较工具仍拼接顶层 TS 迁移文件作为比较来源，其权限及 schema 完整等价审计未由本批两条静态 CLI 代替。

## 失败历史与归档

首次真实新现金 33 项为 6通过／27失败，原 PHP 37 项为22通过／15失败。后来48b6来源现金36/37、PHP45/45；bb6来源现金37/37、PHP46/48且完整测试类型有3个TS2345。后两失败为 system_config SHARE NOWAIT 的55P03（holder未测）与短信夹具缺实际唯一索引42P10；修复用既有 withTx、真实通知 arbiter及仅登记 owned PG16 表的维护隔离，未改生产锁／超时。9555来源A2为64通过／38失败，根因为 broad !promotionVersioned 对原现代订单错误要求促销FORUPDATE权限；收窄严格来源、保留原权限，增加真实最小权限断言后，在当前冻结来源全部回归通过。

原985b H完整103项为95通过／8失败：维护 SQL 被通用安装误扫是实际安装管线缺陷，旧176迁移／281表／末尾0169断言则是过期基线。维护 SQL 同正文移到 src/migrations/maintenance，按各真实 construction path 严格列出 external286／embedded282／ORM285 表及178历史迁移 ID，保护／权限／负例均保留。中间138bc H103通过，但全类型有2条 tuple 推断错误；补唯一 as const 的9字节后，双完整类型及H103均在最终冻结实际重跑通过。所有原失败独立保留，未抹去或把测量当通过。

第一次终态汇总未识别项目目录内 tsc --noEmit 的默认 tsconfig.json，因汇总器参数匹配错误拒绝主类型凭据；原双类型日志实际退出0、source／tools前后匹配。保留原拒绝汇总，仅修结果识别的严格完整命令匹配后生成独立新汇总，未修改测试原件或应用源码。

早期类型、SQL生成、catalog测量前的跳过、普通配置错误和前端中间失败亦完整保留。首次发票错误的旧FK分类与后续实际CHECK更正各留独立证据，不覆盖旧原件；测量及跳过无业务通过信用。全部证据在[网盘归档](../audit/customer-cash-refund-20261012-evidence/)，当前归档 1065 文件／162240767 字节均原件前后及目标 SHA 一致。普通下载／构建缓存可指定网盘；原生依赖、临时目录和 PostgreSQL 数据继续本机。

本批未执行生产 DDL、提交、推送或部署；整个 PHP→TS 迁移仍在推进。
