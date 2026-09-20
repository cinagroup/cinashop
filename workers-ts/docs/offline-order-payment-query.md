# 线下消费原身份主动查单适配候选

2026-09-19，本地候选，未接公开路由或生产部署。承接[回调与外部结算](offline-order-external-payment.md)，补齐无回调主动查询所需的身份和网络边界。后续增量已接入独立证据持久化和恢复服务，最新实现及验证边界见[查单证据与恢复](offline-order-query-recovery.md)；本文保留查询适配器合同及前一阶段验证记录，不表示完整支付发起已经完成。

## 实际完成的边界

`queryOfflineOrderPayment` 从真实 PostgreSQL 的不可变支付选择读取原应用、商户、渠道和必要付款人，复核 type3 建单准入、唯一订单、金额/CNY及已存在的跨域同号。在短 READ COMMITTED 事务中依次锁订单和账号，保留5秒语句/1秒锁预算，提交后才读取渠道配置、签名和发送请求。没有事务内 KV/fetch，也不依赖最新微信绑定或客户端传入商户身份。

后来禁用的账户、隐藏的订单仍可在内部查询已发出付款的结果；这一入口不允许新付款、不恢复账户、不结算、不改任何财务状态。缺表/权限/凭据失败直接拒绝，无运行时建表、修复或授权。

查询适配器在网络前校验当前凭据声明的应用/商户与冻结身份完全一致。配置换到其他商户时停止，不试探新商户、不覆盖选择，不把查询失败变成付款不存在。原身份的旧凭据选择、密钥版本及轮换保留策略仍需实现；仅应用/商户匹配不能证明运维配置从未出错。

| 渠道 | 成功证据来源 | 不允许的推断 |
| --- | --- | --- |
| WeChat | 验签响应中的 appid/mchid、trade_type；JSAPI 同一响应的 payer.openid 必须等于冻结付款人。 | 不能用今天的用户绑定补齐缺失付款人；H5 不虚构付款人。 |
| Alipay | 已验签交易响应与匹配原身份的直连应用请求，来源标记 `alipay-direct-request-scope`。 | 查询响应没有 app_id/seller_id；seller 映射来自受信配置，不能称为响应签名证明的商户字段。不支持 app_auth_token 代调用/服务商模式。 |

查询适配器本身只返回内部 `selectionKey` 和归一化结果，不写 callback inbox、outbox、恢复case或结算凭据；恢复服务通过独立的证据持久化入口消费结果。成功身份来源字段与回调身份类型区分，无伪造通知ID。包含付款人时属于内部敏感投影，不能直接返回前端、放入队列或日志。

## 共享查询适配器修正

- 请求和原身份在首次 await 前复制，避免异步执行期间被调用者改换订单或身份；支持范围内金额严格正整数分，最大2,147,483,647分。线下原始交易号不能超过现有50字符存储上限。
- 两渠道响应流按实际字节限制64 KiB，不信任 Content-Length；超限取消读取，非法UTF-8拒绝，不悄悄去掉参与验签的BOM。微信共用API调用器也应用此边界。
- WeChat 查单错误响应也必须验签才可报告 NOT_FOUND；返回体重放时间限制5分钟、指定平台公钥ID须匹配。金额数字类型、币种、交易号、时间、原渠道和付款人均独立检查。
- Alipay 仅精确的 `ACQ.TRADE_NOT_EXIST` 可报告 NOT_FOUND；金额不接受指数或多于两位小数，币种字段存在时必须CNY。线下缺有效支付时间保留UNKNOWN，日历溢出日期拒绝。共用RSA解析器确认原始验签节点与JSON消费节点相同，防止重复/嵌套键导致“验签一个、使用另一个”。
- `TRADE_CLOSED` 也可能是全额退款，所有调用方保持UNKNOWN；WeChat REFUND/REVOKED同理。线下其余关闭/失败也保持UNKNOWN，不据单次状态自动释放支付路径。普通域原有CLOSED/NOT_FOUND多次确认策略不等于线下关闭/退款政策。

## 官方合同核对

本次使用 Firecrawl 读取[支付宝国内统一收单查询文档](https://opendocs.alipay.com/open/02ivbt)：区分请求 app_id、可选授权代调用与响应交易字段；`send_pay_date` 是特殊可选项，关闭状态包含全额退款，因此本候选缺支付时间时宁可待核查，不补造时间。没有用旧国际站接口合同替代国内接口。

微信字段依据[官方 API v3 SDK 支付交易模型](https://github.com/wechatpay-apiv3/wechatpay-go/blob/main/services/payments/models.go)，包含 Appid、Mchid、Payer、TradeType、SuccessTime；签名请求/响应依据[微信支付官方签名说明](https://pay.weixin.qq.com/doc/v3/merchant/4012365352.md)。读取日期均为2026-09-19。Workers规范沿用同日读取的[官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)与5.20260919.1类型；没有改绑定、生成Env或兼容日期。

## 适配器阶段验证（历史批次）

`payment-query-identity.test.ts` 使用独立Node RSA密钥/签名和请求验签；fetch只返回本地合成响应，不mock生产验签函数。覆盖不同渠道、身份轮换、原payer、签名/序列/时间反例、金额类型/日期/币种、流限额、重复节点、网络未知和输入变更。只创建惰性本机测试客户端以提供真实容器类型，配置DAO禁止调用，未打开数据库连接。

`offline-order-payment-query.test.ts` 使用PG16.15随机数据库与独立非所有者LOGIN；业务角色没有余额/积分/支付状态UPDATE或资金流水INSERT。真实建单和支付选择之后调用真实查询适配器；独立连接在fetch发生时观察原后端为idle、事务已结束，并以NOWAIT取得订单/账号行锁。覆盖H5/公众号/小程序/支付宝、禁用/隐藏、当前绑定变化、金额/渠道漂移、跨域/会员同号和权限失败，查询前后完整账号/订单/选择及资金、回调、outbox/case计数不变。

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-payment-query.test.ts test/offline-order-callback-pipeline.test.ts test/payment-reconciliation-membership.test.ts
node node_modules/vitest/vitest.mjs run test/payment-query-identity.test.ts test/alipay.test.ts test/wechat-crypto.test.ts test/payment-reconciliation.test.ts test/payment-callback-event.test.ts test/payment-callback-route.test.ts test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/route-parity-audit.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

最终三文件 **84项全部通过**（查询预检19、验签回调链路32、会员对账33），208.24秒，零失败/跳过；九文件 **194项回归通过**（19.54秒），另退款/配置两文件 **8项通过**。主/运行时双类型、运行器语法与作用域空白检查通过。批次不累加为全仓通过数。测试不是Cloudflare/workerd、真实provider账号、生产权限或Hyperdrive验收。

首轮主类型检查指出新夹具的多余eq导入和timestamp字段误用数字；原生PG首轮84项中对应1项报 `value.toISOString is not a function`、其余83项通过。改为真实Date并移除多余导入后，最终整批84项全绿，没有放宽账户禁用/隐藏或付款人断言。早期83项密码学/查询批次和扩展193项回归不是最终版本的验收数字，最终为上述194项。

专属集群 `finance-postgres-2zeomH:50537` 与 `finance-postgres-GS9tPp:62870` 均由运行器清理测试库/角色至0并停止。独立只读主机检查确认两者pg_ctl状态3、无postmaster.pid/启动口令，两测试端口监听及可信运行时或无法识别路径的PostgreSQL进程均0。诊断目录保留。原九暂存路径未增删；清单240项完成/164项开放/404项总数不变。

## 后续必须完成

1. 查询证据及共享结算已经形成后续本地增量，详见[当前恢复实现](offline-order-query-recovery.md)；受控DDL/ACL/目录注册及旧候选升级仍未完成。
2. 持续验证原来源和冲突边界；现有自动恢复仅允许已登记的原身份意图，不等于完整支付发起、未知结果处置或生产支付验收。
3. 持久支付派发/原凭据轮换、明确UNKNOWN与关闭/退款策略、跨域订单号并发互斥、公开鉴权接口及页面恢复。
4. 受控DDL/最小权限注册、真实provider/Hyperdrive/workerd/浏览器/CI与协调发布。

不关闭SUP-001、FE-003F或整个迁移目标。用户新图可读确认保持；本轮不改图、清缓存、访问生产、提交推送或部署。Workers/PostgreSQL技能用于有界读取和事务外网络，Firecrawl用于核对官方API合同。
