# 线下消费支付路径互斥候选

2026-09-19；本地未接公开接口、未注册生产迁移、未部署。承接[建单准入](offline-order-admission.md)、[余额结算](offline-order-balance.md)及[会员对账类型修复](payment-reconciliation-membership.md)。这是完整外部支付链路的一部分，不是已接通微信/支付宝收款。

2026-09-20当前状态：后续已补[验签回调接线](offline-order-external-payment.md)、[独立查单证据与恢复](offline-order-query-recovery.md)、[首次持久派发](offline-order-payment-dispatch.md)。下文“未来dispatcher/尚未查单”等保留本选择阶段的历史边界，不能作为当前总进度；selection函数自身仍不执行provider请求，完整收银生命周期和发布仍开放。

## 不允许两条支付路径同时生效

此前余额结算只检查订单是否已付、是否有支付方式和交易号。外部下单可能已经发出但尚无交易号，不能因此认为余额仍可扣款。新增 `offline_order_payment_selection`：每个已准入订单只有一条不可变路径，取值为 `yue / wechat / alipay`，与原订单号、顾客、准入金额、币种、选择时间和随机UUID绑定。

- 余额与外部选择共用订单→顾客锁序，强制 READ COMMITTED，保留不放宽已有设置的语句5秒/锁1秒预算。
- 外部选择先持久化；即使 `other_order.paid=0`、交易号为空，余额支付也必须拒绝。重试相同身份只读原选择，不改变金额、UUID或付款身份；不同渠道/商户/应用/profile 返回业务409。
- 余额选择与扣款、积分、节省、支付状态及凭据一起提交；迟后失败连选择记录也回滚。延迟约束触发器禁止只提交一条孤立的余额选择，再于另一事务扣款。
- 余额凭据的外键改为关联支付选择（再关联准入），触发器核对选择为yue、身份/金额/时间一致。重放检查原选择和原资金凭据，不补造丢失记录。
- 已选外部路径不会因超时、取消页面、当前配置改变或余额充足而自动释放。这里只提供原身份恢复前提，尚未实现渠道查单、可信关闭后的取消策略或新的支付尝试生命周期。

## 冻结什么，不证明什么

内部 `selectOfflineOrderExternalPayment` 的商户身份必须来自受信服务端配置，不是顾客请求DTO。它冻结 provider、profile、交易类型、应用ID和商户ID；微信JSAPI还从当前顾客唯一、有效且profile匹配的 `wechat_user` 行读取并锁住 OpenID。h5/支付宝WAP不伪造OpenID。原渠道与微信profile/交易类型必须相符。

JSAPI的 `payer_id` 是为后续原请求和恢复保留的必要、最大100字符的内部身份快照；不存访问令牌、私钥或原始支付回调。不在日志、队列或当前公开接口返回该字段。未来HTTP适配层必须投影公开字段，不能原样序列化内部返回对象。账号后续解绑/换绑不改写原支付身份。

当前函数**不验证商户密钥是否可用、不验证provider对应用/OpenID的实际归属、不执行支付开关/渠道能力检查、不调用外部接口**；这些必须在接线前由受信支付适配器实现。`replayed=true` 只允许进入原支付的查询/恢复，不表示已付款，也不授权重新发起扣款。不能把选择成功当成预支付成功。

现有回调和主动对账表的金额列为32位整数分，因此外部选择只接受正金额且不超过 **21,474,836.47 元**；该边界由应用和CHECK共同执行。余额仍接受原 NUMERIC(10,2) 订单范围，未被错误缩小。2026-09-20 用户已明确禁止零元结算，应付至少0.01元；零元既不准入新单，也不走外部支付选择／派发，历史只读。见[当前政策](offline-order-http.md#最低应付政策2026-09-20-最新决定本地未部署)。

## 数据库候选与权限

安装顺序为 admission → payment selection → balance，必须处于显式拥有的测试事务中；没有运行时建表、自动修复、历史回填、`IF NOT EXISTS` 或替换旧对象。候选尚未进入 `MigrationService`、schema总入口或公开路由。对已存在上一版候选表的升级策略和受控目录/ACL校验尚未完成，不能直接把这些SQL用于生产升级。

选择表的主键/唯一键保留单订单身份，CHECK限制UUID、版本、金额非NaN、币种及各路径字段组合。触发器核验未付准入订单、有效顾客和JSAPI身份；拒绝选择记录的修改、删除、截断，以及把已选路径的订单写成另一种支付方式。函数固定search_path、显式public表、撤销PUBLIC EXECUTE。

这不代替可信收款证据或防止维护账号造账：持有维护权限者能禁用触发器。后续已补[外部回调绑定与原子结算候选](offline-order-external-payment.md)，包含原身份核对、不可变外部凭据及支付终态；真实验签/解密适配器和正式回调/查单接线仍未完成。新的写入方必须使用同一订单锁和原路径；不能绕过选择表沿用会员支付。

测试维护账号仅创建随机本机数据库/角色、安装DDL和注入故障。业务代码使用独立非所有者LOGIN，无SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS；按表/列授权，另证明外部路径选择仅需用户/订单行锁权限，不需余额列写权限。

## 可复验结果

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-payment-selection.test.ts test/offline-order-balance.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-payment-selection.test.ts test/payment-reconciliation-membership.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/payment-reconciliation.test.ts test/payment-callback-event.test.ts test/http-cache-policy.test.ts test/route-parity-audit.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

首轮真实PG16.15两文件 **79项通过**（当时选择32、余额47；271.78秒），五文件 **90项** 回归通过。补充缺表、REPEATABLE READ和独立NaN CHECK验证后，最终两文件 **68项全过**（选择35、会员对账33；185.94秒），零失败/跳过。主/运行时双类型、运行器语法及作用域空白检查通过。初次新测试类型检查发现两条不同服务返回值的泛型推断不兼容，改为两者真实共有的 `replayed` 接口，没有强转或放宽生产类型。批次有重叠，不相加为独立用例数。

四种独立连接竞争以 `pg_blocking_pids` 作为阻塞屏障：余额先行、外部先行、不同provider竞争、同provider重试；只保留一次选择及必要的一次扣款。另覆盖身份变更、错误/重复/删除绑定、不同用户、范围上限、错误授权、原选择受损、迟后写入失败全回滚。全局外部fetch被禁止，没有模拟一次provider扣款来冒充真实渠道收款。

两个独立集群 `finance-postgres-DLeW4w:64965`、`finance-postgres-gRmFMb:50722` 已清理测试数据库/角色并停止；独立只读主机检查确认 `pg_ctl status=3`、无PID和启动口令文件、两个测试端口无监听、可信目录的PostgreSQL进程为0。诊断目录保留；原九个暂存路径未变。

## 剩余完整链路

外部支付成功的积分/节省/终态原子结算及内部身份绑定已进入后续候选（见上述文档），尚未公开接线。仍需独立type=3的回调/主动查单域、真实验签及商户/付款人适配器、原身份下的持久派发与UNKNOWN恢复、统一跨表订单号解析、零元/期限/关闭政策、公开鉴权DTO与页面持久恢复、受控DDL/ACL和真实provider/Hyperdrive/浏览器/CI发布验收。SUP-001、FE-003F保持开放，不以内部选择记录关闭整项收银功能。

Workers/PostgreSQL技能指导短事务、无外部I/O、共同锁序、延迟原子约束和最小权限验证。本轮已只读核对最新Workers类型5.20260919.1，未升级依赖或绑定。未改生产、图片、缓存，未暂存、提交、推送或部署。
