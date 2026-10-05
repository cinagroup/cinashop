# 同城配送记录整屏：取消合同与读取语义复核

复核日期：2026-10-01；官方公开资源采集时间为 01:26:30–01:27:54 UTC（09:26:30–09:27:54，UTC+8），共享源码与本地验证日志复核至 02:00 UTC。本审查的资料采集只读，没有调用真实配送商订单、询价、取消或账单接口；审查子任务仅修改此文档。实施补充记录 root/backend 独立完成的 UNKNOWN 修复及本地原生验证，不能理解为本整批没有修改生产源码或运行测试。旧 ignored 备忘 `.cache/shipping-next-settings-scope-20261001.md` 保留。

## 1. 本增量的完成边界

旧 `/admin/setting/city/delivery/record` 对应 menu 1491、`setting-city-delivery-record`。真实整屏包含筛选、分页、不同履约归属的配送尝试、详情、取消原因、取消提交、取消产生的商户费用、原订单履约状态回退。菜单和页面证据分别见 [旧菜单](C:/cinagroup/cinashop-php/public/install/crmeb.sql:9550)、[旧路由](C:/cinagroup/cinashop-php/view/admin/src/router/modules/setting.js:593)、[旧页面取消入口](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/cityDelivery/record.vue:129)。

新 Admin 读取基础提供专用 list/detail/store-selector 与 `city_delivery_record.view`。它是这一屏的阶段性实现；只有真实读取合同通过验证时，台账才可从 **missing → partial**。独立读取完成、回调已有取消状态或按钮标注未开放，都不能把该屏判为完成或候选。生产入口见 [Admin 双前缀之一](C:/cinagroup/cinashop/workers-ts/src/routes/adminapi.ts:514)、[v1 双前缀](C:/cinagroup/cinashop/workers-ts/src/routes/v1/index.ts:1629)、[独立只读权限](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminPermissionService.ts:150)。

## 2. 目前官方可核实的取消结论

### 达达

正式人类文档入口为 [订单取消](https://newopen.imdada.cn/forward/#/development/file/formalCancel)；公开页面的实际 [官方文档 JS](https://crms.imdada.cn/goose/7a03d9dd/scripts/app.js) 内 `FormalCancelOrderView` 提供接口正文。此路径来自页面路由与导航定义，不是猜测的 API URL。

该接口只允许在配送员尚未接单或尚未提货时终止履约。请求路径为 `/api/order/formalCancel`，需提交配送标识 `order_id` 和理由编码 `cancel_reason_id`；理由选兜底类别时，另提供说明 `cancel_reason`。响应以 `deduct_fee` 表达商户承担的违约扣款，采用人民币元。正文举出骑手接单后一个时间窗口内的补偿规则，但没有证明所有账户、合同、追加单或时段共用固定费用，也未证明费用预览会锁价。**不能将该示例硬编码为实际扣款或费用上限**；金额仍需真实响应或对应账单证据。

没有在本次取得的正式取消正文中核实可锁价的取消费用预确认接口、费用有效期、取消幂等键、重复取消是否再次扣费、超时后可重发的保证、历史订单的账户选择规则。不能从旧 PHP 的接口常量推导这些保证。

### UU

[商户取消流程](https://open.uupt.com/#/development/businessCancel) 的实际 [官方文档模块](https://open.uupt.com/js/8368.87c826b8.js) 明确先查询实时取消费用、展示影响并确认，再执行取消；骑手取货后不能进行商户取消，需联系客服；取消结果需结合取消接口结果和订单详情判断。骑手放弃接单与商户取消也不能合并为同一个终态。

页面 [官方应用 JS](https://open.uupt.com/js/app.c1eb5f28.js) 确认有 `cancelFee`、`cancelOrder` 两种接口文档标识；[API 文档模块](https://open.uupt.com/js/6185.e098a0a0.js) 通过 `/open/v3/openapi/getOpenApiDetail` 动态取得请求、响应与错误代码。其公开前端客户端使用 `uuCryptoD.JM` 包装文档请求。本次没有执行下载的 JS、调用该动态文档请求或借用商户登录凭证，未取得这两个接口的动态字段。

因此 **未核实** UU 当前取消/费用查询的实际业务 endpoint、金额单位、quote/token 字段、报价有效期或锁价能力、取消结果中的费用字段、重复提交幂等保证、特定错误码是否意味着肯定未提交。不能把文档标识直接当 endpoint，不能沿用旧 V2 `cancelorder.ashx` 的字段拼接当前 V3 请求。Web 文本抓取该入口返回 403；公开页面资源只读下载成功，这不证明文档必须登录，也不证明动态 API 元数据当前不可取得。

### 本地保存的公开证据

以下为保存后的文件 SHA256；保存编码可能带 BOM，哈希表示本地审计快照，不声称等同 HTTP 原始字节。模块都作为文本读取，没有执行。

| 资源 | 保存 UTC | 本地证据与 SHA256 |
| --- | --- | --- |
| 达达官方 app.js | 01:26:30 | [dada-app.js](C:/cinagroup/cinashop/.cache/city-delivery-provider-docs-20261001/dada-app.js:1)；`1d713239dcbab550b11321a3bddd6d4477bd2631ac6a7e678e8a85c56e86af55` |
| UU 官方 app.js | 01:26:30 | [uu-app.js](C:/cinagroup/cinashop/.cache/city-delivery-provider-docs-20261001/uu-app.js:1)；`e7607087b94d440a091028db9b3622f3d411651b1e1c27e49ac8a7586aa8efff` |
| UU 商户取消模块 | 01:27:54 | [uu-business-cancel.js](C:/cinagroup/cinashop/.cache/city-delivery-provider-docs-20261001/uu-business-cancel.js:1)；`c4b66e796be7041a0bc77ea941b970016d412dfeb6d0583c13330cb4dc39eff8` |
| UU 动态 API 文档模块 | 01:27:54 | [uu-api-doc.js](C:/cinagroup/cinashop/.cache/city-delivery-provider-docs-20261001/uu-api-doc.js:1)；`f0b55362d65444a765e2e67f26657e6b409fbd9f86e243503f6bbb59a8be6fa2` |

## 3. 旧 PHP 完整取消合同及不能照搬的行为

旧 [Controller](C:/cinagroup/cinashop-php/app/controller/admin/v1/order/StoreDeliveryOrder.php:86) 要求记录 ID 与非空原因。旧 [cancelForm](C:/cinagroup/cinashop-php/app/services/order/StoreDeliveryOrderServices.php:349) 对达达读取远端原因目录，对 UU 使用文字原因；它仅排除本地 status=-1，没有充分验证其他终态和已取货状态。

旧 [cancel](C:/cinagroup/cinashop-php/app/services/order/StoreDeliveryOrderServices.php:374) 从具体配送记录冻结 `order_id` 与 `delivery_no` 后，在数据库事务内调用真实取消；缺少 `deduct_fee` 时直接视为 0。旧 [doCancel](C:/cinagroup/cinashop-php/app/services/order/StoreDeliveryOrderServices.php:410) 将配送 status 写成 **1**、写 mark 与 deduct_fee，将原单 status 回退到 0 并清空 delivery_type/name/id/uid，追加 `city_delivery_cancel` 日志。这与 UI 的已取消=-1 不一致。

该路径没有展示顾客支付退款、余额退款、库存/优惠券返还或商品售后；`deduct_fee` 是配送商取消费用快照，不能把商户违约金当作顾客退款。新实现应恢复对应配送履约的待发货状态，保留支付与商品售后合同，不能顺带调用商品退款 finalizer。外部请求不能继续放在长期 SQL 事务内，缺字段/超时不能变成免费或取消成功。

旧 [达达 adapter](C:/cinagroup/cinashop-php/crmeb/services/delivery/storage/Dada.php:145) 和 [UU adapter](C:/cinagroup/cinashop-php/crmeb/services/delivery/storage/Uupt.php:119) 是历史映射证据，不能代替当前官方协议与账户合同。旧物理删除接口也不构成删除取消意图、收费证据或历史配送尝试的授权。

## 4. 新读取基础的归属、单位与历史值审查

### 履约归属与原单关联

旧 [create](C:/cinagroup/cinashop-php/app/services/order/StoreDeliveryOrderServices.php:229) 选择履约站点的顺序是：非零 store_id → type=1/relation_id=store_id；否则非零 supplier_id → type=2/relation_id=supplier_id；否则 type=0/relation_id=0。配送表 type 是履约归属，原订单 type 是促销，不能比较同名字段。旧 [storeInfo](C:/cinagroup/cinashop-php/app/model/order/StoreDeliveryOrder.php:59) 不分 type 直接把 relation_id 当门店，而且排除隐藏/删除门店；新按类型关联门店与供应商并保留隐藏/删除诊断是合理修正。

新 [ownerMatches/originMatches](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordService.ts:18) 同时检查 oid、正 UID 与归属；原单不匹配时不投影原单号，也不允许关键词借原单号查出它。平台自提的当前 store_id 可能非零，不能凭这一字段推断历史配送属于门店。已收敛的 [originOwnerUnverified](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordService.ts:36) 对 type=0/relation_id=0、UID一致、当前 supplier_id=0/store_id>0 标 `origin_owner_unverified`，保留 origin_order=null 与原单关键词遮罩；明确冲突仍标 `origin_owner_mismatch`。这是保守未核实状态，不是对自提记录开放关联或取消授权。

当前读取按具体 delivery.id 处理每次尝试，不按 oid 折叠，不挑最低/最高 id 作为唯一配送。底表 [索引](C:/cinagroup/cinashop/workers-ts/src/models/schema/order_delivery.ts:38) 不保证 provider/order_id 唯一；同 oid、同配送商单号甚至跨账户的历史重复都必须保留诊断。未来取消必须绑定这一尝试及当时有效履约，不能因为 oid 相同就清空新尝试的原单字段。详情目的性投影见 [detail](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordService.ts:111)：不扩成 finish_code、坐标、原始 provider body 或无界日志。原单日志没有 attempt ID 时，不应声称它们都是该配送尝试的时间线。

### 时间

底表 add_time 是 Unix **秒**，默认 0：[模型](C:/cinagroup/cinashop/workers-ts/src/models/schema/order_delivery.ts:35)。旧 [systemPage](C:/cinagroup/cinashop-php/app/services/order/StoreDeliveryOrderServices.php:85) 非零时间错误地使用当前 `date()`，0 则为空；应修复为真实保存时间，0 显示“未记录”，负值显示无效，不把默认 0 展示为真实 1970 年事件。

新查询边界使用成对的整数秒、包含起止秒，日期文本按上海 UTC+8 转换，与浏览器本地时区脱钩；0 可以作为显式查询下界，不能被 truthy 判断丢掉。见 [Input](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordInput.ts:30)、[前端时间函数](C:/cinagroup/cinashop/view/admin-ts/src/api/cityDeliveryRecords.ts:85)。记录显示零值与查询边界显示应分开。列表 count 与 rows 处于同一个有 timeout 的 REPEATABLE READ/READ ONLY 快照，稳定按 add_time/id 降序；不能复制旧不带筛选的 count。

### 金额与距离

[cargo_price/fee/deduct_fee](C:/cinagroup/cinashop/workers-ts/src/models/schema/order_delivery.ts:18) 是 decimal(8,2) 快照；读取保留十进制字符串，避免 Number 舍入、科学计数或把 NaN/Infinity/负费用回填 0。具体见 [金额投影](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordInput.ts:47)。页面可展示历史人民币快照与其原始无效值；这不证明当前 UU V3 新费用字段的货币与单位已核实，也不能将 fee 与 deduct_fee 合并为顾客应付金额。

底表 distance 是 REAL **米**，旧列表仅展示时除以 1000；新 [distance converter](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordInput.ts:49) 以十进制位移生成 km，保留原米数，不再浮点除法二次舍入。1320.5 m → 1.3205 km；负值、NaN、Infinity 保留原始诊断，不能渲染成 0 km。REAL 本身是近似测距快照，位移不使它成为精密测量或收费计算权威。

### 状态与诊断

新 [status labels](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminCityDeliveryRecordService.ts:16) 将 0 显示为初始记录，1 显示为历史歧义并附诊断，其余未核实本地值展示明确数字与未知状态。不能把旧取消 bug 产生的 1 批量改成 -1，也不能按 provider 原始 state=1 把本地历史 status=1 断言为待接单。Dada 当前 callback mapper 的 6/8/1000 有各自明确含义，读取基础可先保留原数值及未知诊断；后续补标签必须同时核对 provider、投影来源与历史证据，不能关闭取消缺口。

## 5. 当前 callback/outbox/reconciliation 能复用什么

[Dada adapter](C:/cinagroup/cinashop/workers-ts/src/services/delivery/DadaCityDeliveryProvider.ts:84) 和 [UU adapter](C:/cinagroup/cinashop/workers-ts/src/services/delivery/UuCityDeliveryProvider.ts:91) 目前只有查询方法，有固定 HTTPS URL、短 timeout、32 KiB 响应上限与标识校验，没有取消、原因目录或取消费用查询方法。配置来自环境账户，不来自任意客户端或历史配送行；UU timestamp 单位仍需部署选择与联调，不能因查询单测通过就认定取消签名/时间合同完整。

[事件模型](C:/cinagroup/cinashop/workers-ts/src/models/schema/city_delivery_callback.ts:48) 的 source 只有 callback/query，没有 cancel-response 和实际取消费用字段。事件+outbox 的 [原子 receive](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:257)、重放键、租约与 subject advisory lock 可以借鉴；不能将取消响应伪造为现有 callback 事件。

[当前取消投影](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:538) 能在合法取消状态下回退原单，但不保存 deduct_fee，不验证当前 active attempt 与配送 snapshot 的 UID/归属完整合同。[完成投影](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:602) 在第一事务结束后调用通用 completeOrderReceipt；该 [收货函数](C:/cinagroup/cinashop/workers-ts/src/services/order/OrderBrokerageService.ts:823) 没有 expectedDeliveryAttempt 参数。未来取消、送达、用户收货、新发单必须共享同一履约尝试及订单结算 fence；只加取消路由不能消除这些竞争。

[普通 reconciliation](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:680) 仅从活动配送和原单 status=1/city_delivery 建立 case；[reconcileOne](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:787) 看到本地终态就结束查询。因此它不能原样承担“取消已确认但费用未知”或本地回退后的取消恢复。MAX_ATTEMPTS 后 DEAD 是需要处理的状态，不能等价于未提交或免费。

当前 [subject hash](C:/cinagroup/cinashop/workers-ts/src/services/delivery/DadaCityDeliveryCallback.ts:188) 仅由 provider+providerOrderId 组成，未绑定账户；历史配送行也没有不可变账户 profile。新取消必须冻结经过核实的账户身份/密钥版本引用，不能用今日环境密钥猜测任意历史记录的所属账户。账户归属可核实的办法是实施前真实依赖，不是本审计已验证的现有能力。

### UNKNOWN authority：本地原生红绿复现与最小修复

合法 Dada callback status=777 可通过 [validator](C:/cinagroup/cinashop/workers-ts/src/services/delivery/DadaCityDeliveryCallback.ts:251)，映射为 UNKNOWN/rank=0/terminal=false。transition [先返回 ignored](C:/cinagroup/cinashop/workers-ts/src/services/delivery/DadaCityDeliveryCallback.ts:324)。**修复前**，service 的 ignored 分支仍调用 [upsertWatermark](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:135)，覆盖 lastState、lastRank、terminal、providerUpdateTime 与已确认事件游标；本次已由独立真实 PostgreSQL service 回归证实，不再是仅静态推测。

归一化的脆弱序列为同 subject 的 Dada `3@100 → 777@101 → 5@102`；`3@200 → 777@100 → 5@150` 还倒退时间权威。新 [四矩阵 SQL 测试](C:/cinagroup/cinashop/workers-ts/test/city-delivery-callback-watermark-postgres.test.ts:115) 对 Dada/UU × callback/query，使用真实 service receive→dispatch→process 完成上述新旧 UNKNOWN 序列后才断言业务结果。修复前四矩阵均把取消写成 APPLIED，使原单 status=0、配送 status=-1、取消日志数=1；不是只有 watermark 数值断言失败。另验证首次 UNKNOWN 不应建立已确认 cursor、完成终态 rank=60/terminal=1 不应降为 0、UU 取货前骑手取消仍可回等待池。完成终态用真实 APPLIED_NOOP 投影分支验证 authority，不声称这组测试重新覆盖了实际收货财务结算。

修复前于 09:54:32（UTC+8）运行，新 SQL **9/9 失败**，既有 pure **14/14 通过**：[红基线摘要](C:/cinagroup/cinashop/.cache/city-delivery-callback-watermark-native-before-fix-20261001.log:316)、[真实错误回滚](C:/cinagroup/cinashop/.cache/city-delivery-callback-watermark-native-before-fix-20261001.log:127)。原 pure transition 只验证函数、旧 isolated audit 的 UNKNOWN 使用独立 subject，均不足以捕捉跨事件持久投影的 authority 降级；红基线不累计为已通过的验证。

现行最小修复是 [ignored 分支](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:482) 直接返回 IGNORED，不插入或更新 watermark；UNKNOWN 仍保存在 event/outbox 作为诊断证据，事件终结、outbox 完成和 PII 清理沿用原路径。已确认 state/rank/terminal/time/key 保持原值，首次 UNKNOWN 也不制造新的权威时间门槛。修复后于 09:57:09（UTC+8）运行，同一新 SQL **9/9** 加原 pure **14/14** 合计 **23/23 通过**：[绿色日志](C:/cinagroup/cinashop/.cache/city-delivery-callback-watermark-native-final-20261001.log:8)。新原生测试还断言不调用 provider fetch，不是通过真实配送商请求取得这项证明。

旧 [AuditWorker 的必要源码兼容](C:/cinagroup/cinashop/workers-ts/test/integration/CityDeliveryCallbackAuditWorker.ts:556) 加强 UNKNOWN 不建立 watermark 的断言，并把 [watermark 数量](C:/cinagroup/cinashop/workers-ts/test/integration/CityDeliveryCallbackAuditWorker.ts:568) 从 8 改为 7 个已确认 subject，全部 lastState 非 UNKNOWN，唯一性按 provider+subjectKeyHash 组合检查；事件/终态 outbox 仍为 18、顶层断言仍为 19。此次没有重跑旧 deployed audit，也没有改其历史部署报告；源码兼容与本地 23/23 不能冒充旧部署审计的新执行结果。

**该修复不自动修复历史数据。** 已被旧代码降为 UNKNOWN/rank=0、伪造 cursor 或丢失 terminal 的 watermark，不会仅因部署新分支恢复最高阶段/终态；之前发生的业务回退与日志也不会自动撤销。历史核对/恢复须依据可追溯的已知事件、具体 attempt 与真实原单现状，另行设计和验证，不能靠最大 id、今日 provider 状态或批量重写推测恢复。本次未运行这样的历史修复。完整主动取消协议与 active attempt/费用合同仍未交付。

## 6. 具体可实施的取消架构建议

以下是建议的新设计，不是当前生产功能、当前官方字段或已经批准的 DDL。将取消意图、外部取消结果、收费确认、本地履约投影分开，使 UI 能如实区分等待结果、已取消但费用待核实、完成、竞争冲突。

1. **只读预检与费用确认。** 专用 cancel 权限检查具体 delivery.id，核实 UID/履约归属、provider/account/原始 identifiers、当前 active attempt 和原单可取消状态，读取最新 provider 状态与原因目录。UU 按已核实流程先查取消费用；还必须取得其动态字段、有效期与是否锁价的正式合同。没有锁价能力时不能承诺费用不超过预览值；如产品要求严格费用上限且 provider 不支持，则这条承诺不能安全交付。预检或查价本身不授权提交。
2. **持久化不可变意图后提交一次。** Admin 确认使用 UUID 请求键；冻结 actor、delivery PK、oid/uid/owner、provider/account profile、原 providerOrderId/deliveryNo、原因、确认的费用信息及证据摘要。同 UUID 不同正文拒绝；同原单活动尝试已有取消，包括 UNKNOWN/待核费状态时，不能发第二次取消或新发单。先提交 SQL 中的 SUBMITTING 与租约/CAS 标记，再进行有界外部 I/O；远端 I/O 不占 SQL 事务。
3. **结果不明只查原单。** 网络超时、断开、结果格式不符、worker 在提交后失去租约均进入 UNKNOWN；不能改回 PREPARED 自动提交。成功接收响应也要按已核实 provider 合同判断它证明了接受、终态还是仅排队。使用冻结账户与原 identifiers 查询，记录真实 query/callback/cancel-response 的各自来源。查询 NOT_FOUND 不自动重发；没有当前 provider 幂等与未提交证明时，维持未知并提供授权人工处理。
4. **取消状态与费用状态独立。** 明确取消终态可成为履约回退证据；实际费用仅由经过验证的响应/账单或经审计的人工账单核对确定。若取消已确认而费用尚不明，保留 `CANCEL_CONFIRMED_FEE_PENDING`，不能把旧 deduct_fee=0 当作收费为零。若决定等待费用确认后才回退，也必须在 UI 明确这个业务阻塞，不能悄悄宣称取消完成。任何 fee 查询或账单 endpoint、unit、receipt ID 都须补官方合同，不在此猜测。
5. **统一一次性本地 finalizer。** callback/query/取消响应只向同一取消 finalizer 提交可验证证据。取得原单结算与履约 attempt 共同 fence，按一致锁序重读 operation、binding、delivery、原单；确认仍指向被冻结的 attempt，再原子写配送已取消状态、原因/费用证据、原单 status=0、清空旧履约字段与唯一日志。支付状态不回退，商品退款不触发。费用证据后来补齐只补同一 operation 的收费投影，不第二次回退订单。已完成、退款、拆单变化、不同 active attempt 或证据矛盾时保留远端事实并进入冲突处理，不清空新履约或回滚已完成订单。
6. **完善共享投影 fence。** 本批已阻止新的 UNKNOWN authority 降级；完整取消仍需把“当前有效配送尝试”显式绑定原单，并评估已有降级数据。旧 subject 锁不能串行化同 oid 的不同 attempts，需要共同原单结算锁/履约版本检查。送达确认必须在 completeOrderReceipt 所在事务内再验证 expected attempt；第一事务检查后的跨事务窗口不能授权完成新尝试。数据库锁序须同时覆盖 callback、取消、收货、新发单、退款关联 writer 并用真实 peer 验证，不能仅在取消 controller 内加锁。

### 建议持久化对象和权限

| 建议对象 | 必须保护的字段/约束 |
| --- | --- |
| `city_delivery_attempt_binding` | 原单当前 active delivery PK、履约版本、provider/account身份；明确历史 adoption 证据；新发单/取消/送达/收货共同检查。历史重复或归属不明不能按最小/最大 id 自动 backfill。 |
| `city_delivery_cancel_operation` | UUID+正文哈希+actor，冻结身份/原因/确认信息；FOREIGN KEY RESTRICT；活动唯一约束覆盖 SUBMITTING/UNKNOWN/FEE_PENDING/CONFLICT；状态转换、租约 token/CAS、到期时间与恢复索引。可让本表同时承担取消 command outbox，避免不必要的第二队列表。 |
| `city_delivery_cancel_evidence` | append-only 来源与可验证事实，绑定 operation/原 attempt/account、provider状态、实际费用/货币、原始证据哈希与保留策略；请求/响应摘要不存凭证、finish code、完整地址/手机号。防重复收费/重复日志的唯一键和不可变 guards。 |

状态机应限制 PREPARED→SUBMITTING；一旦可能触达 provider，过期租约恢复只能进 UNKNOWN/查询，而不能重新提交。数据库 CHECK/触发器应阻止变更冻结身份、删除/截断意图与证据、任意跳转成功、第二次发单绕过 UNKNOWN。仅对运行角色授予所需 SELECT/INSERT/限定 mutable columns UPDATE；migration owner 的 DDL 能力不授运行角色。现有 [runtime plan](C:/cinagroup/cinashop/workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts:62) 有 delivery 表 UPDATE，不代表新取消表已经具备安全权限或 guards。新 DDL/权限需后续独立实现与真实 runtime 登录验收，本次没有修改 runtime plan。

## 7. 最接近的既有模式与不能复制的分支

- [OfflineOrderPaymentDispatchService](C:/cinagroup/cinashop/workers-ts/src/services/order/OfflineOrderPaymentDispatchService.ts:72)：先冻结 selection/attempt，SQL 提交后 external I/O，结果按原 attempt CAS；ISSUING/UNKNOWN 不自动重新发起。可借状态纪律与 [DB immutable guards](C:/cinagroup/cinashop/workers-ts/src/migrations/offlineOrderPaymentDispatch.ts:22)，不能把支付票据 READY 当取消成功证明。
- [OfflineOrderPaymentQueryService](C:/cinagroup/cinashop/workers-ts/src/services/order/OfflineOrderPaymentQueryService.ts:26)：按冻结身份查原交易；query 证据单独保存，不能冒充 callback。取消也要查冻结的配送商账户/单号，不能改用今日配置猜旧订单。
- [OrderWaybillJobService](C:/cinagroup/cinashop/workers-ts/src/services/waybill/OrderWaybillJobService.ts:531)：UUID+actor+canonical hash，UNKNOWN/DEAD 阻止新根任务；[失效 PROCESSING → UNKNOWN](C:/cinagroup/cinashop/workers-ts/src/services/waybill/OrderWaybillJobService.ts:884)、lease token CAS 与外部成功/本地投影分离可借鉴。[DDL](C:/cinagroup/cinashop/workers-ts/migrations/0091_electronic_waybill_outbox.sql:66) 的活动唯一索引模式适用；运单人工 CONFIRM_RETRY 不是配送取消证据。
- [StoreOrderRefundService](C:/cinagroup/cinashop/workers-ts/src/services/order/StoreOrderRefundService.ts:520) 的幂等 finalizer 与 [成功后只重做本地 finalizer](C:/cinagroup/cinashop/workers-ts/src/services/order/StoreOrderRefundService.ts:1872) 可借鉴；**不能复制** [QUERY→NOT_FOUND→requestRefund](C:/cinagroup/cinashop/workers-ts/src/services/order/StoreOrderRefundService.ts:1505)。退款供应商的原退款号协议不证明 Dada/UU 未知取消可以重发，也不授权取消路径返还顾客资金。

## 8. 完整取消实施前仍需取得的证据与验收

真实外部依赖是当前对应账户的取消/费用/原因/错误码 API 合同、merchant/account身份与历史订单归属、费用确认或账单核对方式、重复取消与未知结果的幂等约束、回调取消来源和金额是否完整、UU 时间单位与联调环境选择。公开文档可确定的部分已经列在第 2 节；未取得部分必须保持未核实，不能以 mocked HTTP success、旧常量或关键词覆盖声明已贯通。本次禁止真实 provider 请求和费用，仅提供设计与读取复核。

后续最小有意义验收包括：

1. 专用 view/cancel 权限分别验证双前缀；仅 order/config 权限不隐式拥有取消；hidden/deleted/missing owner、UID/归属冲突、平台 pickup 未核实、拆单/同 oid 多 attempt 不泄露或错误回退。
2. 真实 runtime SELECT 与新表限定 writer 权限/不可变 guards；UUID 重放、不同内容复用 UUID、两个独立 PID 同时取消、旧租约迟到结果、callback 与主动查询重复，无第二次外部调用/日志/扣费。
3. 可控 transport stub：请求前失败、请求已到对方后超时、远端成功后本地保存失败、ack 非终态、schema/身份/单号不符、缺失/非有限/单位未核实费用；全部有真实持久状态与恢复路径，不能默认 0 或自动重发。
4. 真实 SQL 竞争：取消与骑手取货、送达/顾客收货、退款、拆单/新履约 attempt；本地回退只作用原 attempt。UNKNOWN 不能降低已确认最高阶段/终态，旧取消不能覆盖新投影，UU 骑手取消只回等待池。
5. list/count 同快照、稳定分页/边界时间/literal `%_\\` 查询、未记录 0 时间、NaN/Infinity/负值金额或距离、未知 provider/status、每个历史尝试独立显示、费用未知回执可操作、只读与取消确认态交互正确。
6. 正式账户/非生产联调和账单核对需另行取得与记录授权及环境合同。本文件没有进行该验证；其缺口仍影响完整取消合同的交付，不影响有边界的本地读取基础先验证为 partial。

审查子任务没有自行新增测试或运行 PG。本文已直接核对 root/backend 的本地真实日志：读取基础的输入/SQL/JWT 三文件 **17/17 通过**，见 [读取验证](C:/cinagroup/cinashop/.cache/city-delivery-records-native-final-20261001.log:8)；UNKNOWN 修复的新 SQL 9 与既有 pure 14 合计 **23/23 通过**，红基线完整保留。前端最终发布检查、旧 deployed audit 新执行、正式 provider 联调与历史 authority 恢复均不能由这些日志推导。记录整屏仍只能按实际读取验收推进到 partial。
