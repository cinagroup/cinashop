# 原账号小程序商品发货

本模块延续既有 UID、权益、订单和付款。跨 AppID 的归属维护屏障仍然存在，`runtime_ready=false`；不能以发货批准代替历史用户或付款归属维护。

## 安装与批准

`runRoutineShippingUpgrade` 由真实 PG16 维护 LOGIN 执行，依赖已完成的原付款证据与付款账号策略目录。必须声明现有 App/Admin 及 Financial/Manager/Cashier 的完整运行合同；安装器不会借用 App 写库权限安装、修复目录漂移、补默认授权或扩大其他角色权限。新增策略、派发、回执三张维护者所有的不可变表。App 只有策略 SELECT 和派发/回执 SELECT、INSERT，其他运行账号没有这些新表的权限。

部署单独提供 `ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS`，格式为：

```json
{"format":1,"credentials":[{"ref":"archived_mini_a","version":1,"appId":"<原AppID>","secret":"<该AppID的AppSecret>"}]}
```

这是独立的、封闭的 AppSecret 注册表，最多 16 份材料。它不是微信支付私钥注册表，也不接受文件路径、URL 或任意环境变量选择器。材料包括 ref、version、AppID 和每个 AppSecret 字节的承诺；缓存键使用该承诺，不能命中全局、当前配置或仅 AppID 的旧 token 缓存。

维护者先通过 `routineShippingCredentialCommitment` 取得无秘密的材料承诺，使用 `routineShippingAccountId` 为真实原 AppID/商户生成固定主体，再调用 `appendRoutineShippingAccountPolicy`。用途固定为 `shipping_upload`，需有 active 状态、明确有效期、材料 ref/version/stamp 和 CAS revision。声明参数只包含 database、maintenance、app、admin 四个字段，完整运行合同另用于安装器。

每个维护操作使用 UUID。相同 UUID 的精确重放保留首次行与 xmin，即使材料已撤回；更改主体或意图不能借重放绕过 CAS。策略以作用域 HMAC 和完整的前序链认证。撤销通过追加 revoked revision 实现，不修改历史行。时钟倒退不能使批准早于实际提交生效。

## 实际商品 Queue 路径

现有 Admin／Supplier／虚拟商品发货写入同一事务的 `order.delivery.notice`，再由 OrderOutboxService 渲染通知、OrderNotificationDeliveryService 领取和消费。新的 shipping 投递不要求买家有最新小程序绑定；历史 target 和 transactionId 的重放保留原值，不回填旧行。

消费前先证明真实 App LOGIN，错误角色不能领取投递。短事务验证实际付款根、子单、购物车、有效发货 outbox、投递租约和完整原付款证据。`JSAPI/SUCCESS` 的原 AppID、商户和实际 payer.openid 来自已认证的原付款，不能来自当前配置、买家绑定、INIT 或 PREPAY。另用独立 App 只读会话证明不存在 NativeApp 成功付款冲突。

当前接受付款根 `pid=0` 的单履约，以及正式[同城冲突读取合同](fulfillment-city-conflict-readers.md)下受约束的 express 分包。分包必须是 `pid=-1`、分配完成的真实付款根，完整家族恰好有 2..15 个直接子单；UID、已付款渠道、非删除状态、子单金额总和和原付款必须一致，不能进入退款物化或退役分代。已发货包裹须各有真实物理商品、发货 outbox 和相符投递，统一为 express。每次新上传先证明实际 App 的 reader 合同，不借 raw city SELECT。

分包使用 `delivery_mode=2`，上传当时全部已发货包裹，并显式带 `is_all_delivered`。首个包裹可以先上传；后继意图要求前一个确有持久化 code=0 回执、仍未全部发货、原付款身份相同、包裹集合严格增加且旧包裹完全不变。新 upload_time 来自更晚的 SQL 时点；已接受包裹沿用首次承运商 ID、联系方式及请求条目，当前运力列表删除旧公司也不改原件。前一个 UNKNOWN 或只有明确非零结果时，不能创建后继意图。明确非零的部分请求可在物理包裹增加后重试，但原请求体、upload_time、批准和凭据材料保持不变。

物流分类只接受明确值：自提类型2为物流4；实体类型1/门店配送类型3按 express、send/city_delivery、fictitious 分别映射为物流1/2/3。未知 shippingType、收银类型4及实体类型1/3中的未知 deliveryType 不生成新的 shipping 投递，消费者也在外部调用前拒绝；分包仍只允许物流1。类型3的分类有单测，实际业务验收仍使用类型1，不据此声称 Manager 发货 HTTP 或门店归属生产者已闭合。

新包裹的物流公司通过原账号调用官方完整列表，匹配名称或 ID；没有默认快递公司。商品描述最多 120 个 Unicode 字符，SF 需要遮罩且保留末四位的联系方式。

派发记录固定原付款身份、首次 upload_time、请求体、包裹、批准与付款证据指针，并由 HMAC 认证。每笔原付款的短事务边界防止两个意图并发越过未决派发。SQL 事务关闭后才取 token、读取物流公司或上传；每次实际上传前重新验证身份、源事实、租约和批准。明确 invalid-token 拒绝最多刷新一次，仍使用相同请求体和 upload_time。

明确 HTTP 回执的摘要、状态、错误码和时间只由私有传输证明写入，并与 SENT／RETRYABLE／DEAD 在同一 App 事务提交。HTTP 期间撤销批准或移除凭据不能抹掉已经接受的结果。超时、断连、无效 JSON 或其他可能已发送的结果记为 UNKNOWN，不能自动重发。历史接受回执只用于只读恢复，不重新授权外部调用，也不取得 fresh 分包的 reader 门。人工 CONFIRM_SENT 不能冒充微信回执。明确忙碌码 -1、45009、45011、10060012、10060019 及明确 HTTP 429/5xx 仍受既有最多五次投递尝试约束；新增两个系统忙碌码仅用于发货上传，不扩展运力列表的重试集合。

## 尚未完成的范围

充值、会员与付款后自提上报尚需各自真实的领域 outbox／投递主体合同，不能把它们的 ID 当作商品订单 ID。已完成发货后的更正／重新发货、模式或物流类型切换、退款退役分代、原 UNKNOWN 的微信侧查证，以及历史 SKIPPED 的维护恢复尚未开放。当前会拒绝这些未证明的路径，不通过重置状态或制造新 upload_time 重发。

此前基础 App/Admin 拆包的同城任务读取 42501 缺口已由显式维护安装器、专用 NOLOGIN owner、精确 EXECUTE 和五角色合同解决；旧失败记录保留。新能力不授予同城表 raw SELECT。尚未单独执行 15/16 包边界、连续三次以上扩包、当前运力列表移除旧承运商、fresh/recovery 与 reader 维护的业务竞态，以及退款物化家族反例；对应限制不能写成已验收。

验收只使用隔离 PG16、独立运行 LOGIN、真实本地业务入口和受控外部传输。没有生产 DDL、部署或真实微信调用。

协议依据：[发货信息录入](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)、[access_token](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getaccesstoken.html)、[运力列表](https://developers.weixin.qq.com/miniprogram/dev/server/API/weixin-express/express-msg/api_get_delivery_list.html)。
