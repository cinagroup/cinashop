# 赠券固定使用期合同（本地验收通过／未发布）

2026-09-27，本地验收通过、未发布。本批只修新人注册赠券与已付款商品赠券的使用期资格，不新增路由、页面候选、表或运行权限。原生业务与回归合计 **5个不同完整文件110例**，来自已接受的四文件91例与最终独立完整文件19例；不是单次110／110。[本批原生证据](../audit/coupon-gift-use-window-native-20260927.json)由主代理封存。前批[发行券验收](../audit/coupon-issue-acceptance-20260927.json)及其38／225／50／47／95口径保持独立，不累计成本批结果。

## 使用期规则

旧源为 [StoreCouponIssueDao.php](C:/cinagroup/cinashop-php/app/dao/activity/coupon/StoreCouponIssueDao.php:71)：`validSearch` 第71–87行在启用、未删除、库存与领取窗口条件之外，要求：

```text
coupon_time > 0
OR (coupon_time = 0 AND end_use_time >= time())
```

第372–374行 `getGiveCoupon` 复用该条件。[StoreCouponIssueServices.php](C:/cinagroup/cinashop-php/app/services/activity/coupon/StoreCouponIssueServices.php:214) 的新人赠券（214–237）、会员卡激活赠券（244–267）和订单商品赠券（288–295）均通过它取券；159–207行保存滚动或固定的已领券时间快照。旧条件不要求使用开始时间已到，因此固定券可以提前发放。

本仓对应 [StoreNewcomerService.ts](../src/services/activity/StoreNewcomerService.ts) 第302–320行与 [ProductCouponService.ts](../src/services/activity/ProductCouponService.ts) 第151–163行，新增的条件为：

```ts
issue.day > 0 || (issue.day === 0
  && Boolean(issue.useEndTime && issue.useEndTime.getTime() >= now * 1000))
```

| 数据 | 发放结果 |
| --- | --- |
| 正领后天数 | 按操作时钟生成滚动期限，忽略遗留固定结束值 |
| day=0，固定结束等于操作整秒 | 允许，截止秒包含 |
| day=0，固定结束早于操作整秒或缺失 | 跳过，库存与赠券证据不变 |
| day=0，使用开始仍在未来、结束有效 | 允许预发，保留未来开始时间 |
| 负day | 跳过，与PHP固定分支要求day=0一致 |

原领取窗口、启停、软删除和库存条件保留。新人注册仅 `isPermanent=1` 表示无限；商品赠券保留 `totalCount=0` 或 `isPermanent=1` 表示无限的既有解释。因此 `totalCount=0/isPermanent=0/remainCount=1` 在新人入口会扣至0，在商品入口不扣。这次修复不统一两种历史库存语义。

## 入口、时钟与事务

新人赠券在新账号创建事务内执行。实际调用包括 [LoginService.ts](../src/services/user/LoginService.ts) 的密码注册与短信新账号（212、281行）、[WechatAuthService.ts](../src/services/wechat/WechatAuthService.ts) 的共享新账号分支（1404行），以及 [OutUserService.ts](../src/services/out/OutUserService.ts) 的OpenAPI新建用户（781行）。注册配置仍决定是否送积分、余额及哪些发行券；跳过失效券不阻止用户创建或其它合法奖励。已有账号登录不因此重复送券。

商品赠券由 [OrderOutboxService.ts](../src/services/order/OrderOutboxService.ts) 第504–583行的已付款事件调用。真实下单、余额扣款、订单paid及支付outbox创建先完成提交，随后处理outbox；商品赠券不回到支付时刻取资格。处理延迟跨过固定截止时，该固定券跳过；滚动券从处理时刻起算。付款事实及已提交的扣款不因赠券跳过而撤销。

两个入口传入的 `now` 都是操作开始时捕获的Unix整秒；与Date比较时乘1000，截止用 `>=`。它不是等待发行锁后重新采集的墙上时钟，也不是商品付款的payTime。公开手领 [ActivityService.ts](../src/services/activity/ActivityService.ts) 第168、203–209行仍使用自己的毫秒时钟，本批不修改其协议。

新人先锁用户，再将去重发行按id升序 `FOR UPDATE`，随后执行资格判断；商品入口在付款outbox／订单事实之后，按相同顺序锁发行并检查订单＋发行的赠券证据。管理写入先持发行锁并提交停用、删除或过期截止时，等待中的消费者取得锁后重判最新行，跳过该券。测试通过真实阻塞PID验证这一“写者先行”顺序，不宣称等待后重采时钟。

可信赠券不套用公开手领的receive_type、category、app_type或receiveLimit门槛；可信来源是注册配置及付款工作流，保存用途flag本身不是公开授权。商品重复关联按issue去重，同一订单重放不再扣库存或新增owned／原始领取／订单赠券记录。runtime application身份包含callback与queue，并非终端用户身份；既有显式commission权限已支持这些操作，本批不增加grants，也不把直接服务调用当作HTTP权限证明。

## 原生验证范围与当前结果

[coupon-gift-use-window-postgres.test.ts](../test/coupon-gift-use-window-postgres.test.ts) 定义19例，通过生产注册、实际创建订单、余额支付和outbox入口执行，使用独立认证的真实App／Admin LOGIN及原生PostgreSQL 16。每个场景安装[正式夹具](../test/helpers/refundRuntimeFixture.ts)的完整176步注册迁移，并检查281张表；真实角色审计要求非superuser、无建库／建角色／绕过RLS能力，保留5／2／5秒期限。这证明所用本机完整结构与实际角色，不代表281张表的所有业务均被验收。

| 场景组 | 定义例数 |
| --- | ---: |
| 两入口的过期、缺失结束／负day拒绝 | 4 |
| 付款后延迟处理跨截止，付款保留、滚动期从处理起算 | 1 |
| 两入口的截止秒包含、未来开始、滚动期、有限与无限库存 | 2 |
| 相同手机号并发注册只送一次 | 1 |
| 两入口并发争抢最后一张有限券 | 2 |
| 同一真实付款消息并发与重放 | 1 |
| 两入口等待写者提交停用／删除／过期后重判 | 6 |
| 两入口真实晚期SQL失败、回滚及修复重试 | 2 |

截止秒测试在注册入口读取真实新用户addTime，且在发行锁前将结束时间设为该秒；付款入口先实际提交付款，再固定处理入口的 `Date.now` 到截止秒。延迟处理场景也只控制生产时钟API；原生SQL、计时器、行锁及阻塞结果没有替身。

注册晚期失败使用超长券名触发真实 `22001`，用户、积分／余额账及赠券同事务回滚，修复数据后重试。普通checkout及余额付款本身不生成已提交的订单状态记录；最终付款故障场景因此先额外执行真实checkout→cancel，取得已提交的取消状态记录，并将这笔取消纳入比较基线。付款outbox取得发行锁后，维护夹具将状态序列 `setval` 到该既存取消记录ID，使赠券之后的 `pay_success` INSERT触发真实 `23505`，不是伪造付款审计行。

该场景的回滚范围仅为本次outbox处理，先前余额扣款、已付款订单、outbox创建及额外取消均已提交。失败租约状态另行持久化，允许由PROCESSING转FAILED；最终测试确认恢复夹具序列后重试完成，重复消息不再产生第二份赠券。序列间隙不要求回滚。

回滚比较是 `refundRuntimeFixture.state()` 明确列出的业务表，加本场景的issue／owned／issue_user／order_product_coupon_reward及user_money／user_bill；不是281表全量快照。测试没有发送真实queue消息，外部fetch被阻止，token存储被替换，配置KV使用内存实现。因此不证明HTTP认证、短信／支付provider、真实KV、UI或生产角色配置。

首轮实跑为 **19例：8失败、11通过，另有1个unhandled rejection**，整体exit1。其中7项是两处缺失使用期判断的业务红例，1项是付款晚期故障夹具／观察器错误：夹具假定普通付款已产生可用状态记录，观察器异常又未正确传回等待者，最终得到连接关闭而非预期23505。该夹具失败不能算生产缺陷，也不能当作晚期回滚已通过。首轮冻结测试文件SHA256为 `26b27b9aba72c86796a218fec70c249be38d248a3bdfe4d6cc46efda3f2d483f`；修复前两份业务源码和原日志单独保留。

第一次修正版原生运行包含 **5个完整文件、110例：109通过、1失败，无unhandled error**。新范围文件是18通过／1项夹具失败，因此整份19例排除，不能只收取其中18个绿例；另外四个完整文件 **91例全部通过**，已接受且未重复跑。最终修正夹具后的完整文件 **19／19通过，exit0、零跳过、无unhandled error**，开始时间21:11:31、耗时146.03秒，日志为 `coupon-gift-use-window-native-accepted-20260927.log`。最终接受数按“四个完整文件91＋最终完整文件19”计算为两批去重110例，前次整体失败历史保留。

兼容回归 **4个完整文件22例**、统一台账 **17个完整文件95例**均实际exit0，另行计账，不加入原生110。最终unit类型检查exit0；runtime类型检查也已在相同生产输入下实际exit0。35个明确列入本批范围的源码／测试及支持文件已按精确字节冻结，不将它扩大为整个仓库的依赖快照。三轮原生日志均记录夹具剩余0及STOPPED；主代理另逐座运行 `pg_ctl status` 获得exit3，验证绝对路径在自有workspace/.cache内后删除三座data目录，日志独立保存。最终集群为 `finance-postgres-BPDemE`、端口60857。

## 未关闭的范围

- 配置候选列表仍需独立补齐失效券过滤；修正实际发放资格不等于配置页已完整恢复。
- `UserLevelService.ts:196–204` 的会员激活赠券仍对负day采用宽松固定期fallback，尚未纳入本批两处补丁。
- 普通会员卡激活的9键配置是独立合同：`member_func_status`、`level_activate_status`、`level_extend_info`、`level_integral_status`、`level_give_integral`、`level_money_status`、`level_give_money`、`level_coupon_status`、`level_give_coupon`。现服务读取这些SQL配置不代表管理配置操作面已验收，也不等于SVIP付费会员权益。
- 自动满赠、关注、新人真实配置全链、SVIP真实权益、完整Linux、真实provider／设备及发布继续开放。

路由与逐屏分类不变：Worker1813、Admin413调用点／437变体、274屏57候选／114部分／96缺失／7退役，营销48屏18／15／15／0；复选框246勾选／158开放／404总项。本批不重写前批issuer、模板或拼团已封存JSON。
