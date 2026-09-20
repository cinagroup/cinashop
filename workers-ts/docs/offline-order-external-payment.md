# 线下外部支付结算与回调链路候选

2026-09-19，本地候选已接现有验签HTTP入口、默认回调队列和持久回调恢复；未注册生产迁移、未部署。承接[支付路径互斥](offline-order-payment-selection.md)，不表示已接通真实微信/支付宝收款或完成支付发起。

2026-09-20后续已补[首次持久派发及未知结果恢复](offline-order-payment-dispatch.md)；原凭据轮换、入口刷新/关闭、公开收银与正式环境验证仍开放。本文以下保留回调/结算阶段合同及历史验证结果。

## 从持久回调到独立收银结算

原 `PaymentCallbackEventService.receive` 只保存允许的支付标量和摘要，不保存应用、商户或付款人明文。不能仅把 `other_order.type=3` 加入会员结算：会员分支会修改会员期限，且原回调记录不足以证明原支付身份匹配。

当前 `PayController`/`WechatController` 在现有RSA2或RSA＋AES-GCM验证后，传入同一通知中提取的商户/应用/付款人；不是从前端DTO或当前用户绑定补造。规范事件、恢复记录、outbox与身份绑定在**同一事务**提交，最后才标为独立 `offline_order` 域。绑定、权限、金额或域DDL失败时整体回滚，不返回接收成功。事务提交后才允许Queue发送，消息仍只有action/eventId/replayKey。`xx`前缀只是路由提示，仍须真实type3准入和唯一身份；跨充值/商城同号仍拒绝。

默认消费者按持久引用进入独立线下结算，之后才提交回调/恢复终态；财务提交后、回调收尾前中断，由重放校验原凭据，不能再次赠分。已验签的一单多交易冲突保留事件并隔离，不因绑定失败回滚掉冲突；完成收尾不能覆盖已存在的CONFLICT/CLOSED，非成功通知也不能降级已确认付款。

恢复队列可使用已经验证并绑定的持久回调补齐结算，先核对案件、事件和原交易再入账。后续[独立查单证据与恢复增量](offline-order-query-recovery.md)已接通原身份查询和共享结算：优先重放持久查单证据，否则使用可信回调；无二者时仅对已登记意图按冻结身份查询，不盲用当前商户配置。缺证据/身份不符仍保留UNKNOWN/DEAD，不推断为未付款。原凭据轮换和支付派发/UNKNOWN完整状态机仍开放。

新增两个内部入口：

1. `bindOfflineOrderCallback`：读取已持久化回调，核对冻结的 provider/profile/金额/CNY，以及受信入口传入的应用、商户和JSAPI付款人；持久化事件ID、选择UUID、事件摘要、身份核对摘要和数据库时间。
2. `settleOfflineOrderExternalPayment`：默认回调队列和回调恢复共用，仅接受事件ID和随机重放键，重新读取原始事件、绑定、支付选择、准入、订单和账户。在一个事务内记支付终态、完整交易号、积分、节省、推广资格、不可变结算凭据和状态日志。

绑定函数**不是验签器**；其输入必须来自对同一通知完成签名验证和解密后的受信适配器，绝不能来自顾客DTO。身份摘要不是签名或MAC，也不提供独立密码学真实性证明。不复制原始回调、令牌、密钥或付款人明文到新表，不改变原回调摘要算法或opaque队列消息。原子入口内部使用 `bindOfflineOrderCallbackTx`，无嵌套事务；旧的未绑定事件须重新接收验签通知，不凭原账本猜测商户身份。

重放核验首次结算的原事件、原绑定和各关联效果，不重算历史赠分、不对比今天的积分/余额。不同通知ID表示同一已核验交易时，保留首次结算凭据和支付时间；已有冲突、不同交易号、跨域同号、缺证据和损坏账单均拒绝。

## 财务与事务边界

- 外部支付只确认已收款事实，**不扣 `user.now_money`、不新增余额支出、不延长会员、不增加 `pay_count`**。积分计算与余额支付共用精确BigInt策略：截断比例积分后加当前有效会员固定积分；节省来自建单冻结价差。已关闭或异常的余额支付开关不阻止确认外部收款。
- 顾客在付款发出后被禁用、删除，或订单被隐藏，不能抹去已经收到的外部款项；只在已验证持久绑定的内部结算路径保留收款，原禁用/隐藏标志不变。此例外不用于发起支付，缺少账户/准入/绑定仍失败。
- 锁序为provider交易号→事件→provider恢复订单→订单→账户→固定配置，与现有回调入口及恢复登记共用对应锁键。读取已知恢复冲突，禁止重复交易号或一单多交易冲突被当作成功。READ COMMITTED及不放宽的语句5秒/锁1秒预算，在获取全局锁前设置。没有事务内网络调用。
- 积分溢出、配置损坏、任何迟后写入失败均回滚本地结算；已提交的回调及绑定或独立查单证据保留以便恢复，不把异常当成未发生收款。业务校验失败保留offline域并转人工关注；数据库故障按原队列退避重试。完整支付发起与UNKNOWN状态机尚待接线。
- 当前外部证据金额上限21,474,836.47元，交易号上限50字符来自旧 `other_order.trade_no` 存储边界；过长拒绝，不截断。零元免费结算、关闭/超时、退款及补偿政策仍开放。

## 候选DDL与权限

依次在拥有的事务内安装 admission → selection → balance → external payment → callback domain；最后一步显式扩展回调事件/恢复案件的domain CHECK。没有重写已部署0120/0121或ORM的历史基线约束，无运行时建表/授权/自动修复、历史回填或 `IF NOT EXISTS`。候选模型不进入schema入口，SQL不进入MigrationService。已有旧候选升级、完整目录/所有权/ACL/RLS核对和生产发布尚未实现，不能直接把本文SQL当作生产迁移；缺少最后的域DDL时验签接收也必须整体失败。

绑定不可改删截断，已绑定回调的核心证据不可修改（队列状态、租约等运行字段仍可变）。外部凭据唯一关联订单、provider交易号以及原事件或独立查询证据（CHECK要求恰有一个来源），CHECK限制正且有限金额、积分守恒与公式。触发器核对准入、路径、订单支付状态和实际积分/节省账本，阻止修改已付事实或关联效果；延迟约束要求已付订单与凭据在同一事务提交，不能先单独写已付标志。

业务测试使用真正独立的非所有者LOGIN，无SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS；只授予指定表、列、序列和固定配置锁函数。外部结算账号没有余额列UPDATE或现金流水INSERT权限。触发器为固定search_path、显式public对象的SECURITY DEFINER，撤销PUBLIC EXECUTE。维护角色仅负责本机夹具安装和故障注入；这些约束不声称能防御维护所有者或受信入口被任意调用。

## 验证与剩余工作

### 回调阶段接线验证（历史批次，最新查单恢复见上文）

`test/offline-order-callback-pipeline.test.ts` 使用独立Node RSA签名与AES-GCM加密，调用实际Hono回调分发器、验签/解密、入库和默认队列消费者；只有配置KV和Queue传输为本地替身。应用账号仍是真实独立非所有者LOGIN。覆盖WeChat/Alipay/小程序身份、重复通知、原商户变化、签名/解密/时间/币种反例、缺域DDL/权限失败、未提交可见性、Queue发送失败、财务提交后中断、晚到冲突、独立offline域及持久回调恢复。**最终三文件96项全过**（32项新链路＋31项结算核心＋33项会员对账，218.18秒，零失败/跳过）；另六文件**97项回归全过**（22.09秒），主/运行时双类型、运行器语法及作用域空白检查通过。不声称真实provider账户、workerd、Hyperdrive或生产验收。

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-callback-pipeline.test.ts test/offline-order-external-payment.test.ts test/payment-reconciliation-membership.test.ts
node node_modules/vitest/vitest.mjs run test/payment-callback-event.test.ts test/payment-callback-route.test.ts test/payment-reconciliation.test.ts test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/route-parity-audit.test.ts --maxWorkers=2
```

首轮新链路25项中的13项失败：独立Queue观察连接返回bigint字符串，夹具却按数字比较，断言中断发送后使后续测试没有队列消息；改为显式整数投影，未放宽原子可见性要求。补充7项签名/关联反例后最终32项全部通过。初次类型检查的四处Node/Workers Buffer声明冲突通过显式Node Buffer转换修复；纯回归初轮95过/1失败是抽取规范持久化文件后的旧静态路径断言，改为同时验证新原语及调用接线，随后增加运行器入口断言并97项全绿。

本轮专属集群 `finance-postgres-av8CfY:62456`、`finance-postgres-wXi4Kz:61102` 已独立核验pg_ctl=3、无PID/启动口令，两个端口监听及可信目录或无法识别路径的PG进程均0；最终运行器报告测试库/角色剩余0。诊断目录保留，原九暂存路径未改变。本轮没有连接生产数据库、调用真实provider或修改线上图片/缓存。

### 前一阶段独立结算核心记录

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-external-payment.test.ts test/offline-order-balance.test.ts test/offline-order-payment-selection.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/payment-reconciliation.test.ts test/payment-callback-event.test.ts test/http-cache-policy.test.ts test/route-parity-audit.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

核心套件使用真实canonical持久化原语写入隔离PG16.15，故意构造未绑定的旧事件以单独检验绑定边界，不用伪造的仓储返回值代替资金事务；合成的“已验签”回调仅用于测试信任边界，**该核心套件不算验签、HTTP、Hyperdrive或Cloudflare运行时验收**，实际合成签名HTTP链路由新增pipeline套件覆盖。所有测试禁止外部fetch，并发以独立后端 `pg_blocking_pids` 作阻塞屏障。

最终外部结算 **31项全部通过**，162.37秒，零失败/跳过。前一联合批次的余额47项、支付路径35项（共82项）也全部通过；共享赠分策略提取未使余额路径绕过余额开关。五文件相关回归 **91项通过**，主/运行时双类型、运行器语法和作用域空白检查通过。批次不累加为全仓测试总数。

首次联合批次中外部27项均在候选SQL安装阶段失败，原因是PL/pgSQL条件内CASE表达式需要括号；修正后补充一单多交易恢复冲突、跨域同号、延迟已付约束及隔离级别/缺表反例，取得上述31项结果。初次类型检查也暴露一个未使用导入，后续恢复凭据核验实际使用该条件组合并通过复查；没有放宽类型或测试断言。

两个专属集群 `finance-postgres-l78QyC:60580`、`finance-postgres-WxKuKL:58507` 均报告测试数据库/角色剩余0并停止。独立只读主机检查确认pg_ctl=3、无PID/启动口令文件，两测试端口监听为0，可信目录或无法识别路径的PostgreSQL进程为0；原九暂存路径保留。诊断目录保留，不删除历史测试证据。

仍须完成原身份下持久支付派发、完整UNKNOWN处置、凭据轮换适配、通用跨表订单号互斥、客户端/公开鉴权DTO和页面持久恢复、受控DDL/ACL注册及旧候选升级、真实provider/Hyperdrive/浏览器/CI及协调发布。当前只检测已存在的跨表同号，不声称跨域并发唯一性已解决。回调/outbox/恢复case只在真实结算或凭据重放验证成功后进入相应终态；公开建单/支付路由仍未开放。SUP-001、FE-003F不关闭。

Workers/PostgreSQL技能指导了短事务、外部I/O隔离、持久证据及最小权限验证。用户确认的新图可读保持有效；本增量未访问生产、改图、清缓存、暂存、提交、推送或部署。
