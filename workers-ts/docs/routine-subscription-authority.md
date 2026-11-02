# 原账号订阅通知批准与 token 基础

本轮从已推送的 `ab90aa8cd7429b78bc9ae265bc0c97d2d5e0e727` 继续。新增独立的 `subscription_send` 维护批准、AppID / 模板绑定及 access_token 获取能力，尚未接入 Outbox、DeliveryService 或 WechatNotificationProvider，没有开放原账号通知发送。

## 维护存储与权限

`routineSubscription.ts` 定义唯一新表 `public.routine_subscription_account_policy`：UUID record_id、account_id、revision、payload、created_at、signature 六列；主键及 account_id / revision 唯一约束、五个检查约束、两个索引。没有默认值、序列或外键。UPDATE / DELETE / TRUNCATE 由固定的 invoker 触发器拒绝。

维护 LOGIN 所有并负责追加，App 仅有不可转授的 SELECT；安装器不向 Admin、Manager、Financial、Cashier 或 PUBLIC 增加权限。精确检查列、类型、约束、索引、owner、触发器正文、函数元数据及 ACL、角色 OID 和成员关系。owner-only 只作为安装事务中的中间态，不能作为运行时 ready。表完全缺失可由实际来源证明的 App 读取为未安装；半安装或漂移报错，不能静默关闭或自动修复。

`runRoutineSubscriptionUpgrade` 是显式 PG16 维护入口，核对实际 superuser LOGIN / session、数据库和原有业务角色声明。`originalPaymentEvidence` 与 `identityOwnership` 必须同时提供一致的维护者 / App 身份与 OID；没有源目录则不安装。沿用原五角色及声明 peer 的完整前后权限审计，仅增加可选的精确 App / Admin 后继检查。

首次 await 前复制有界声明，按 731714 → 731716 → 731725 顺序取得 try-only advisory gate，再以 NOWAIT 锁定来源表及角色业务表。已有新表同样加锁复验。DDL / ACL 原子提交，可由调用者事务整体回滚；精确重复只读复验，不批准账号、不回填历史事实，也不接管漂移对象。运行时实际 App LOGIN 使用短事务；SQL / idle 上限 5 秒、lock 上限 1 秒，尾部另查 5 秒事务期限。RR / RO 只用于允许的历史读取，不提供 fresh 准入。

## 独立账号与模板合同

维护作者 `appendRoutineSubscriptionAccountPolicy` 只接受封闭纯数据 DTO。全局 UUID 操作键与 expectedRevision 做 CAS，同键同内容返回原记录；不同内容、跨账号复用、断链、倒退时间和超过 64 个版本均拒绝。记录绑定数据库名 / OID、维护者名 / OID，使用独立 `subscription-*` HMAC 域。每个 AppID 只有一个确定的账号主体，不能另造 account_id 绕过撤销。

策略仅允许 `purposes: ['subscription_send']`，包括 active / revoked、AppID、凭据 ref / version / commitment、有序且 mark 唯一的模板清单，以及正整数有效期。模板最多 16 项、有效窗最多 366 天；读取检查整个有界签名链。维护者必须自行提供经核实的 AppID / mark / templateId 归属，该 API 不发现归属或配置 AppSecret。

部署注册表为独立 `ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS`，封闭格式为 format=1 和 credentials 数组，每项包含 ref、version、appId、secret。最多 16 项、总 JSON 最多 128 KiB；ref / version 唯一，材料 commitment 包含全部 AppSecret 字节。它不读取当前 SQL 配置、全局 cfg 缓存、付款 / 发货凭据或任意路径 / URL，也不回落到这些来源。没有设置或修改生产环境值。

`prepareRoutineSubscriptionAccountTx` 要求实际 App RC / RW、调用者已持 shared 731725 gate，从最新 active 策略选择精确 mark / template。返回深冻结记录及模板，凭据保存在私有 WeakMap；spread / JSON 克隆不能制造能力。`assertPreparedRoutineSubscriptionAccount` 在新的短 App 事务内重查最新策略、窗口、模板、目录和材料，旧批准不能借用新 token 权限。维护撤销不需要继续持有旧 secret；精确维护重放也不改原行 / xmin。

`assertRoutineSubscriptionHistoricalAccountTx` 仅验证不可变策略确实留存，且给定时间位于该 active 行声明的窗口。它不证明该行在任意历史时刻仍为最新、不证明 fresh 准入或实际通知发送，不能替代未来发送 attempt / result 回执。后续撤销不会抹去旧策略元数据。

## Token 读取与资源边界

`RoutineSubscriptionAccessToken.ts` 仅 GET 固定微信 token 地址，禁止 redirect；只使用 prepared 能力绑定的 AppID / AppSecret。独立缓存键为 `routine:subscription:v1:access_token:<credentialStamp>`，与付款、发货和当前配置隔离。失效操作也只删除该材料命名空间。

缓存读取、提供方返回和缓存写入后分别重新验证 fresh 批准，HTTP / Redis 等待期间不保持 SQL 事务或维护 gate。拒绝过期 / 损坏缓存、过大或非 UTF-8 响应、重定向、错误状态、错误 JSON / token / lifetime；错误统一脱敏。响应最大 32 KiB，fetch 与完整流共享硬 8 秒期限，忽略 abort 的 fetch、未结束流及迟到响应均结束等待并清理可取得的 body。缓存绝对到期时间基于请求开始时间，提供方 lifetime 上限 7200 秒。

响应检查是 HTTP / 字节 / JSON / 字段校验，没有提供方响应签名验证。此次 provider / Redis 均为明确本地受控传输，没有真实微信调用。

## 实际验证

全部重型检查使用单层共享串行锁，Vitest 单 worker / 不并行文件；Node24.14.1、npm11.11.0、自有 PG16.14，沿用每命令 600 秒、整组 1200 秒及既有内存限制。

| 批次 | 实际结果 | 整组耗时 |
| --- | --- | --- |
| native-02 | 新安装器 9 项、账号 / token 15 项通过 | 265.31 秒 |
| compat-04 | 既有身份升级 7 项、发货账号 8 项、通知来源 45 项通过 | 333.41 秒 |
| final-03 | 单元 139 通过 / 2 个既有 PG 条件用例跳过；Worker unit / runtime 两套类型检查通过 | 314.55 秒 |

三个完整批次各冻结 8554 份输入，运行期间及补文档前逐项摘要一致。五个成功原生阶段各自的自有 PG 实例均 remaining=0 并 STOPPED。新原生使用真实 PG16、独立 TCP LOGIN、实际目录 / 维护作者 / App 服务代码，传输为受控 fetch / Redis。账号业务正例经实际维护作者生成；目录约束与损坏链负例使用明确 SQL 结构标本，不能作为真实归属或批准业务正例。

139 个单元通过数已包含新增 3 个 8 秒超时 / 资源清理用例；这些用例明确 mock 准入，只证明 transport 边界，不作为 PG 批准证据。两个跳过项是既有 `routine-runtime-config.test.ts` 的 PG16 原子配置读取和 shared gate 条件用例，本单元批次没有继承 PG URL，不能算为通过。新 PG 原生批次另有实际维护撤销与 token I/O 交错验收，不能把这两类证据混称同一测试。

native-01 首次执行为 7 通过 / 2 失败，后续账号阶段未执行。测试错误地把 fixture-only pricingOwner 放入期望 peer target；只修正两处完整 DTO 比较的期望，生产代码未为此变更。失败日志和冻结清单保留，自有 PG 已停止，native-02 完整重跑通过；失败批次不计入通过结果。

实际日志、冻结摘要和验收汇总留在本机忽略目录 `.cache/php-ts-phase45-validation/`。独立只读复核不代表独立重跑或安全审计。文档在全部验证终态后补齐，提交文件另做秘密扫描及暂存 / 提交字节核对。

## 尚未接通的来源与发送

本轮能力只批准账号材料及模板，不能证明一笔旧单的原 AppID 或接收人。下一步仍须从原绑定的 SUCCESS 付款证据取得来源，并通过精确 AppID + UID 归属锚点验证目标；不能使用当前配置、跨 AppID 最新裸 openid 或付款人替代目标归属。现有 notification_template 的无 AppID 配置也不能直接当作旧账号模板授权。

未来 dispatch 必须在首次 attempt 前同时取得可信订单来源、目标归属及本批准，并在 token 后 / POST 前重新检查 fresh 条件；实际发送需要独立不可变 attempt / result。可能已发出的 UNKNOWN 不得换键重复发送，历史策略行本身不能恢复发送结论。非微信单、拆单和缺历史来源必须按明确合同处理，不能猜测。

没有改动 Outbox / DeliveryService / WechatNotificationProvider 的消费者，没有通知 POST、Admin 发送入口、完整维护 manifest、单次切换许可或原子 AppID 切换。保留用户 / UID / 权益 / 旧单 / 付款，未知不猜归属；跨 AppID 屏障与 runtime_ready=false 保持。无生产 DDL、部署、Browser、Workerd / Hyperdrive 或真实提供方验收；整体 PHP→TS 迁移尚未完成。
