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

当前仅接受付款根 `pid=0`、唯一履约单且未进入退款退役分代的商品发货。分包在读取凭据或调用微信前明确拒绝；没有开放 `delivery_mode=2`。物流公司通过原账号调用官方完整列表，匹配名称或 ID；没有默认快递公司。商品描述最多 120 个 Unicode 字符，SF 需要遮罩且保留末四位的联系方式。

派发记录固定原付款身份、首次 upload_time、请求体、包裹、批准与付款证据指针，并由 HMAC 认证。每笔原付款的短事务边界防止两个意图并发越过未决派发。SQL 事务关闭后才取 token、读取物流公司或上传；每次实际上传前重新验证身份、源事实、租约和批准。明确 invalid-token 拒绝最多刷新一次，仍使用相同请求体和 upload_time。

明确 HTTP 回执的摘要、状态、错误码和时间只由私有传输证明写入，并与 SENT／RETRYABLE／DEAD 在同一 App 事务提交。HTTP 期间撤销批准或移除凭据不能抹掉已经接受的结果。超时、断连、无效 JSON 或其他可能已发送的结果记为 UNKNOWN，不能自动重发。历史接受回执只用于只读恢复，不重新授权外部调用。人工 CONFIRM_SENT 不能冒充微信回执。

## 尚未完成的范围

充值、会员与付款后自提上报尚需各自真实的领域 outbox／投递主体合同，不能把它们的 ID 当作商品订单 ID。分包、物流更正／重新发货、退款退役分代、原 UNKNOWN 的微信侧查证，以及历史 SKIPPED 的维护恢复尚未开放。当前会拒绝这些未证明的路径，不通过重置状态或制造新 upload_time 重发。

分包验收发现：同城命名空间存在时，基础 App 与 Admin 的共享拆包路径会读取它们尚未获正式授权的 `customer_city_delivery_job/binding`，实际产生 42501。现有 CustomerWork grant compiler 没有完整的 commissioner／五角色共存 forward，不能作为临时加权的依据。后续需先完成专用读取合同、锁与角色验收，再开放分包。失败批次与三项未来用例保存在本地验证记录，本轮没有把失败改成成功或跳过现有安全 fence。

验收只使用隔离 PG16、独立运行 LOGIN、真实本地业务入口和受控外部传输。没有生产 DDL、部署或真实微信调用。

协议依据：[发货信息录入](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)、[access_token](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getaccesstoken.html)、[运力列表](https://developers.weixin.qq.com/miniprogram/dev/server/API/weixin-express/express-msg/api_get_delivery_list.html)。
