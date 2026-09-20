# 线下消费余额结算候选

2026-09-19；本地内部候选，未注册迁移、未开放接口、未部署。依赖[不可变建单准入](offline-order-admission.md)。这是正金额余额支付核心，不代表整个收银域已完成，也不是生产验收。

后续已接入[不可变支付路径互斥](offline-order-payment-selection.md)：余额与外部支付必须竞争同一订单路径；余额选择随真实扣款凭据原子提交，外部已选但交易号未知时也禁止改扣余额。下文46项为前一阶段历史结果，当前新增依赖与验证见该文档。

后续[外部结算候选](offline-order-external-payment.md)提取共用赠分/节省策略；余额仍检查余额开关并写现金支出，外部结算不依赖余额开关、没有余额写权限。提取后余额47项和选择35项真实PG回归通过；并未把外部款项当成余额扣款。

## 旧 PHP 合同与修正

核对 `YuePayServices::yueOrderPay`、`OtherOrderServices::paySuccess`、`OtherOrderJob`、`common.php::is_brokerage_statu`：

- type=3 不延长会员期限。旧余额支付因存在 `member_type` 字段进入 `pay_member` 分支，扣余额却没有写 `UserMoneyServices` 流水。新版补写 `user_money.type=offline_scan`，不把线下消费标成会员购买，也不使用会关联商城退款的 `pay_product`。
- 现有新版余额读取以 `user_money` 为权威，不另写一份 `user_bill.now_money` 支出。`V2UserCompatibilityService` 增加“线下消费”类型名称；积分仍进入现有 `user_bill.integral/gain`。
- 旧赠分实际为 `trunc(order_give_integral × pay_price) + 当前有效会员 integral 权益值`，不是注释中的“乘倍数”。新版保留加法，使用整数计算，冻结每次实际使用的比例、加赠值和积分前后余额。积分事件使用 `offline_order_give_integral` 和完整 `xx…` 订单号，不与商城的数字订单 ID 冲突。
- 旧队列读取可变配置、分别吞掉副作用错误且没有幂等保护。新版扣款、账单、积分、节省、推广资格、支付状态和支付凭据处于同一个事务；任何一步失败整笔回滚。
- 节省金额采用**建单时冻结**的原价、实付与适用折扣，不受付款前关闭权益影响。适用折扣大于零时写 `store_order_economize.order_type=2`；100%价格可产生零节省记录，普通非会员不伪造优惠。
- 推广资格保持旧实现的已付 `other_order` 累计口径（包含会员订单），只在启用、模式3且达到门槛时把0改1。旧方法没有实际增加 `pay_count`，新版也不增加。不降低已有推广资格。
- 不照搬旧代码对负积分使用 `abs` 的隐式修复；负余额、负积分和非法推广状态拒绝支付，需单独核查数据。

## 写入与重放

`payOfflineOrderBalance(container, { uid, orderNo })` 仅接受已准入的 type=3 订单号；金额不由调用方提供。UID须由未来经过鉴权的适配层传入，当前没有公开路由。

1. 事务上限不放宽会话已有设置：语句5秒、锁等待1秒。按订单→顾客→固定配置/权益表顺序加锁；无网络、KV、provider、队列或支付外部调用。
2. 拒绝订单号歧义、他人订单、非线下域、缺失或矛盾的准入证据，核对顾客正常且未被两种删除标志禁用。
3. 已有结算凭据则检查原yue支付选择与 paid/yue/time/amount 及关联资金、积分、节省账本，返回历史结果。后来的充值、积分变化、会员过期、支付关闭及订单隐藏不触发重复扣款或重算奖励；`balance_after` 是当次结算后的历史余额，不是当前余额。
4. 无凭据时只处理干净未付订单；已付无凭据、取消、含 provider 交易标识或未绑定历史副作用均拒绝，不自动补造历史。
5. 只扣准入冻结实付。账户金额按 NUMERIC(12,2) 处理，订单按 NUMERIC(10,2) 处理，全程 BigInt 整数分，更新另带余额足额条件。积分计算与累计不得溢出 PostgreSQL integer。
6. 从锁后的 SQL 读取当前余额开关和赠分/推广策略，不使用缓存。全局配置按 sort DESC/id DESC，忽略门店配置；当前会员到期以数据库语句时间判断，积分权益选最小 ID（不跳过禁用首条）。
7. 写一笔可见余额支出、必要积分和节省账本、type=3 paid/yue/time、不可变结算凭据及 `pay_success` 状态。重试以原订单唯一结算凭据实现幂等，不生成新支付订单。

配置读取最多七个键，每个值最多128字节，支持 PHP JSON 字符串标量。赠分比例支持非负至多8位整数/6位小数；超精度不截断迁就。开关仅0/1，会员总开关沿用整数1启用语义；推广模式支持1/2/3，阈值按非负 NUMERIC(12,2)。异常配置及积分溢出拒绝，不静默按零计。

2026-09-20 用户明确要求应付至少0.01元。当前报价／准入拒绝截断到 `0.00` 的新消费；历史零元记录仍可读，但拒绝结算、固定会员积分及其他财务副作用，不通过免费会员路径绕过，不擅自补价。见[最低应付政策与验证](offline-order-http.md#最低应付政策2026-09-20-最新决定本地未部署)。

## 数据库保护与边界

候选模型 `models/candidates/offline_order_balance.ts` 不进入生产 schema 入口。`OFFLINE_ORDER_BALANCE_SQL` 只在测试拥有的事务内安装；现需按 admission → payment selection → balance 的顺序安装。当前尚无受控安装器，不可把裸 ORM 或候选 SQL 当作安全生产升级。

- 一单一份凭据，外键关联准入、资金流水和可选赠分/节省记录，关联记录不能复用。CHECK校验有限正实付、有限非负余额、余额守恒、积分公式、版本与身份；显式排除 PostgreSQL numeric 的 NaN，不能只依赖大于零和加减等式。
- 插入触发器锁住并核对订单、顾客和各关联效果；它不信任“已付”一个标志。凭据改删截断、关联账本改删及已结算订单支付字段回退被拒绝。未来退款须另记反向效果，不能修改原支付事实。
- 独立唯一索引约束 `offline_scan` 资金事件和 `offline_order_give_integral` 积分事件；既有节省表本身按订单号/顾客唯一。发现历史冲突须审计，候选不去重、不覆盖。
- 无参数 `ooa_lock_pricing()` 只在 READ COMMITTED 对固定两张表取得 SHARE NOWAIT；业务账号没有配置写权限。触发器函数撤销 PUBLIC EXECUTE、固定 search_path并使用显式 public 表。
- 测试业务角色是非所有者 LOGIN，限指定表SELECT/INSERT、指定用户/订单列UPDATE及指定序列USAGE。维护角色只负责本机夹具安装/故障注入；不是业务身份。该角色仍能写授予列，数据库约束不代替受信应用的鉴权，也不声称能防御拥有维护权限的任意造账。
- 生产目录指纹、所有权、ACL、RLS、触发器完整性、全量 ORM/迁移一致性、表锁争用和其他资金写入方的共同锁序仍未验收。状态日志没有在本候选中改成独立不可变表；资金事实以绑定凭据及账本为准。

## 验证

每项原生 PG16 用例创建随机独立数据库：完整当前 ORM表结构＋两个显式候选 SQL；不是生产注册迁移。独立 LOGIN 执行真实建单→余额支付→重放；并发使用不同后端及 `pg_blocking_pids` 作为确切阻塞屏障。

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-balance.test.ts test/offline-order-admission.test.ts test/offline-order-quote.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/response-cache.test.ts test/route-parity-audit.test.ts test/order-member-savings.test.ts
node node_modules/vitest/vitest.mjs run test/v2-user-compatibility-migration.test.ts test/user-center-compatibility.test.ts test/user-center-compatibility-scenario.test.ts test/user-finance-read-scenario.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

本轮首批三文件 **132项** 全过（当时余额39、建单26、报价67），扩展余额 **44项** 全过；补充NaN限制后，最终余额 **46项** 全过、零跳过，耗时236.84秒。五文件 **109项** 相关回归、四文件 **48项** 账单/用户兼容回归及主/运行时类型检查、运行器语法和作用域空白检查通过。批次有重叠，不相加为独立测试总数。

故障覆盖五个写入位置的INSERT权限撤销、三类故意错误账本、缺表/缺凭据/未绑定旧效果、非法或超精度配置、账户异常与溢出、零价拒绝，以及独立后端同单竞争/同余额竞争、用户锁后会员状态重验和配置编辑阻塞。NaN测试既验证应用拒绝账户异常，也由维护夹具暂时关闭不可变更新触发器，独立证明CHECK本身返回23514且整笔不变。

三个隔离集群 `finance-postgres-ovVZhF:63128`、`finance-postgres-1v20MK:59892`、`finance-postgres-67Jk3J:56000` 均已清理随机测试库/角色并停止；独立获准的只读主机检查确认无PID/启动口令、三个测试监听端口和可信PG进程残留，诊断目录保留。原九个暂存路径未变。

## 仍然开放

后续衔接审计发现现有主动查单/人工接受会将已付type=3误认会员证据，已在本地收紧为type=0/1并保留同号歧义拒绝，33项真实PG验证通过；见[会员对账类型修复](payment-reconciliation-membership.md)。该修复不把收银接入会员结算，也不表示外部支付意图已经与余额结算互斥。

正金额余额核心之外，仍缺零元/支付期限政策、公开鉴权DTO与客户端持久化、provider意图/回调/主动恢复的独立type=3域、退款及各端完整历史、受控DDL注册、真实角色/Hyperdrive/provider/浏览器/CI和协调发布。没有把SUP-001或FE-003F整项勾选；Checklist仍240/404。

Workers/PostgreSQL技能指导了短事务、外部I/O隔离、精确金额、锁后权威SQL和非所有者最小权限验证。用户“新图已经可读”的结果保留；本增量未访问生产、修改图片/缓存或暂存、提交、推送、部署。
