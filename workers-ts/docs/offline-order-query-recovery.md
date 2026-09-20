# 线下收款查单证据与恢复候选

2026-09-19，本地候选已将[原身份查单适配器](offline-order-payment-query.md)接入现有恢复服务；没有公开支付发起路由、生产迁移或部署。承接[验签回调与独立线下结算](offline-order-external-payment.md)，不代表整个线下收银流程或迁移目标完成。

## 已接通的恢复链路

1. 恢复任务领取案件后先查独立的 `offline_order_query_evidence`。已有证据时重新校验原案件、冻结支付选择、摘要和金额，不再读取当前商户配置或向渠道查单。
2. 没有查单证据但有可信回调时，继续走已有回调恢复。二者都没有时必须有已登记的付款意图，才允许按冻结应用/商户/渠道/必要付款人发起查询。
3. 网络查询在所有预检事务提交之后进行。可信 SUCCESS 由 `persistOfflineQueryEvidence` 保存独立证据并提交，然后 `settleOfflineOrderQueryPayment` 才开始财务事务。
4. 查单与回调共用一个财务写入函数：已付状态、原交易号、积分、会员节省、推广资格、结算凭据及状态日志一并提交。外部支付不扣余额、不写现金支出、不延长会员。
5. 收尾使用租约条件更新；已经出现的 CONFLICT/CLOSED 不得被旧任务覆盖。重试重新核验原结算凭据，不重复赠分或重算历史政策。

“已有付款意图”是内部恢复前提，不是完整派发协议；持久派发、外部请求不确定性及旧凭据选择仍未完成。本入口不会发起新扣款。

## 证据和信任边界

查询证据使用自己的随机ID及重放键，关联恢复案件ID与冻结选择UUID；保存版本、渠道、交易号、归一化成功状态、金额/CNY、渠道支付时间、数据库创建时间、证据摘要及原身份核对摘要。不生成假通知ID，不新增 callback/outbox，也不复制原响应、签名、密钥或应用/商户/付款人明文。队列消息仍只带案件引用，不能携带内部身份投影。

- WeChat 来源为 `wechat-signed-query`，身份由同一验签查询响应核对。
- Alipay 来源为 `alipay-direct-request-scope`，应用/商户来自匹配冻结身份的受信直连请求范围；响应不包含签名保护的 app_id/seller_id，不能把来源写成响应商户证明。
- 持久化函数是受信适配器的验证记录，不是验签器；无密钥的SHA摘要不是MAC，不能防御任意调用受信入口或有权停用触发器的数据库所有者。

不可变财务凭据通过 CHECK 要求 `event_id` 与 `query_id` **恰有一个**非空。后到的另一来源只能验证和重放，不能改写首次来源、原支付时间或资金效果。

## 并发与失败语义

交易号 advisory lock → 回调事件行（仅回调）→ provider/订单恢复锁及案件行 → 订单 → 账户 → 固定政策锁。查单证据写入和两种结算入口采用相同的交易号锁；登记恢复案件时也检查其他订单已声明的相同交易号。订单级恢复冲突、一单多交易、跨来源同交易多订单均拒绝结算。

所有线下查询预检、证据写入和结算保持 READ COMMITTED、语句5秒/锁1秒预算，provider/KV/Queue I/O不在这些事务内。证据与财务故意分两次提交：财务权限或写入故障时保留已验证收款事实，后续重放无需使用新商户凭据重新查询。

本轮真实SQL回归发现：证据已提交后，失败收尾曾用领取任务时的空交易号覆盖数据库中刚保存的交易号，造成后续重试一直UNKNOWN。现无新交易信息时保留数据库原字段，不使用过时任务快照；测试同时检查原交易号不变及重试仅入账一次。

NOT_FOUND、CLOSED、REFUND或其他未知结果不写成功证据，不推断NO_PAYMENT，不释放支付路径；PENDING进入WAITING，其余UNKNOWN，达到既有尝试上限后DEAD。缺表/权限、缺付款意图、原身份不匹配均拒绝自动结算，仍无运行时建表、授权或修复。人工关闭案件期间返回的成功查询可以保留证据，但不自动结算或覆盖CLOSED。

## DDL、权限与上线缺口

候选 `OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL` 新增独立查询表/索引及不可改删截断触发器，扩展外部结算凭据为两种互斥来源；引用约束和触发器复核冻结选择、案件及实际资金效果。固定search_path的SECURITY DEFINER函数撤销PUBLIC EXECUTE，业务角色只能SELECT/INSERT查询证据，没有UPDATE/DELETE/TRUNCATE、现金列UPDATE或现金流水INSERT。

这些模型未加入schema总入口，SQL未注册MigrationService。新候选脚本适用于受控安装的新夹具，**不是已有旧候选数据库的升级脚本**。旧版非空event_id、既有函数/索引及数据必须有显式受控升级和回滚方案；不要直接重跑本文件或依靠IF NOT EXISTS冒充升级。新增全局交易号查询索引也必须纳入真实目录/权限核验。

## 验证范围

新增 `offline-order-query-recovery.test.ts` 使用PG16.15随机数据库、真正独立的非所有者LOGIN与最小授权；真实查询签名、验签和SQL，不连接生产。配置KV和provider传输为本地替身；混合并发中的回调是受信解码夹具，实际签名HTTP入口由另一个callback-pipeline套件验证，不能把两者描述为一次真实provider端到端验收。

覆盖两渠道无回调恢复、证据先提交、失败重试/配置轮换、财务提交后中断、回调/查询和查询/查询独立后端竞争、先后来源保留、交易号冲突、迟到冲突、人工关闭、缺意图/权限、错误引用/来源/摘要以及数据库来源CHECK。并发屏障观察实际 `pg_blocking_pids`；网络时独立连接观察业务后端没有开放事务。

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-query-recovery.test.ts test/offline-order-payment-query.test.ts test/payment-reconciliation-membership.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-callback-pipeline.test.ts test/offline-order-external-payment.test.ts
node node_modules/vitest/vitest.mjs run test/payment-query-identity.test.ts test/alipay.test.ts test/wechat-crypto.test.ts test/payment-reconciliation.test.ts test/payment-callback-event.test.ts test/payment-callback-route.test.ts test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/route-parity-audit.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run test/third-party-refund.test.ts test/payment-readiness.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

首批三文件93项中89过/4失败，实际复现上文的原交易号被失败收尾覆盖，修复后四个原失败均通过。扩展批次101项中99过/2失败：两项来源CHECK故障注入已被数据库拒绝，但断言错误地在Drizzle包装消息里查找约束名；现检查底层PostgreSQL `23514` 与 `ooep_source_ck`，不放宽约束。初次主类型检查发现新测试多余导入，已删除并重新通过。回调32项与原结算核心31项在两个联合批次均通过。

最终当前代码的两批原生数据库验证全部通过：三文件 **90项**（新增恢复38、原身份查询预检19、会员对账33），239.84秒；另两文件 **63项**（签名回调链路32、结算核心31），219.57秒。共五个不重叠文件153项，零失败/跳过。此前适配器84项和回调96项是历史批次，不作为本次新增恢复代码的通过证明。九文件 **195项** 相关回归及另两文件 **8项** 退款/配置回归通过，主/运行时双类型、运行器语法与作用域空白检查通过；这些批次不是全仓覆盖数，也不是真实provider、workerd、Hyperdrive或生产验收。

四个专属PG16.15集群 `finance-postgres-zAGWpD:58078`、`finance-postgres-6L48oh:49636`、`finance-postgres-9dO79s:61550`、`finance-postgres-cHkwTN:49413` 均由运行器清理测试数据库/角色至0并停止。独立提升权限的只读主机核验确认四者pg_ctl=3、无postmaster.pid/启动口令、对应端口监听0；可信测试运行时及无法识别路径的PostgreSQL进程均0。首次普通沙箱读取首个集群目录被拒绝，不以当时的false路径探测当作清理证明；后续独立核验才确认证据。诊断目录保留，原九暂存路径不变。

## 仍开放

2026-09-20 后续已通过7项实际 workerd→本地 Hyperdrive→PG 发起／查单／结算验证及47项运行时合同，见[运行时证据](offline-order-workerd-verification.md)。这补充本页原有 Node/PG 测试，不代表真实通知 HTTP、Queue、远端 Hyperdrive 或商户验收。

后续已补[首次持久支付发起与未知结果恢复](offline-order-payment-dispatch.md)，与本页查询/结算组成内部候选链路，未开放收银入口。仍需安全刷新/新尝试生命周期、旧商户凭据及密钥版本选择、关闭/退款/补偿政策、跨表订单号并发唯一性、公开鉴权DTO及页面恢复、受控DDL/目录/ACL升级、真实provider/Hyperdrive/workerd/浏览器/CI与协调发布。已有跨表同号检查不等于全域并发互斥，单元/本机SQL通过不等于生产可用。

SUP-001、FE-003F及整体验收不关闭；240项完成/164项开放/404项总数不变。沿用用户新图可读确认，没有生产、图片或缓存写，也没有暂存、提交、推送或部署。Workers/PostgreSQL技能约束了事务外I/O、持久证据与最小权限验证。
