# 原账号商品自提的付款发货意图

固定 PHP 版本的 Pay listener 在 shipping_type=2 付款成功时产生物流4发货意图；核销不再次产生该意图。TS 现在沿用这个业务时点，使用真实付款 outbox 与既有原账号发货协议。官方[发货信息录入](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)证明物流4为自提、统一发货只有一条 shipping_list，不能据此声称官方要求本应用在付款时上报。供应商分区合成一条自提的规则是本实现对该合同的应用。

## 来源与原子提交

实际下单先持久化自提类型2、门店及原购物车快照。经既有付款入口提交 paid 和 `order.paid:<root>` 后，App 的 OrderOutboxService 在后置事务完成供应商分配和次卡有效期，再创建 `wechat_shipping` 投递。来源就是该真实 order.paid 行，投递 mark 固定 `paid_pickup_shipping`；不增加事件类型或 DDL，不伪造 order.delivery.notice，不把订单状态改成已发货。

投递与付款后置任务、源 outbox 的 COMPLETED 状态在同一事务提交。任何后置失败均回滚投递，Queue 扫描不会看到付款 effects 尚未提交的意图。重复已完成 paid 源保留原行，不重新渲染或补历史缺失投递。当前开关关闭、游客 UID=0 或非 WeChat 渠道不创建这一新意图；它们不认领原账号付款人。

实际 SQL 金额恰好为0时，即使本地完成保留 weixin 标签，也不产生原证或 shipping 意图。已证明的预售退款分代恢复保留原 paid effects 和后续结构/财务复验，只跳过当前未支持的发货意图；损坏的恢复证明仍整笔失败。fresh 发货消费者继续拒绝已退款/退役家族，没有放宽原证或金额规则。

## 完整家族与内容

消费者要求真实受限 App LOGIN，源行精确为同根 order.paid、载荷 `{orderId,orderNo}`、状态 COMPLETED，且投递的 outboxId/orderId/userId/mark/空target与之相符。数据库源解析沿现有 public 合同，整个付款家族按ID取得 NOWAIT 行锁，原购物车与 paid 源在同一事务稳定。

单履约根为 pid=0；供应商分区根为 pid=-1 且分配完成，直接叶子2..64个、整个家族不超过65行。全部为明确自提类型2、相同买家/门店、已付款 WeChat、非删除且未退款退役；叶子金额合计与原付款根一致。每叶原 cartNum 合计等于其 totalNum，所有原商品数量合计也等于付款根 totalNum，最多200行和1MiB购物车读取预算。完整事实不足时不上传成功前缀。

一笔原付款只生成一个根投递，固定 logistics_type=4、delivery_mode=1，一条 item_desc，不发送 tracking_no、express_company、contact 或 is_all_delivered。描述读取规范 product.storeName 或旧 productInfo.store_name 及原 cartNum，最多120个Unicode字符。供应商子单没有各自的自提上传，不把内部 supplier 分区误作仅快递支持的 mode2。

来源摘要固定完整家族身份、supplier/store、原金额、付款时点、原商品行与数量。订单 status/verifyCode/clerkId、核销剩余次数和核销时间不属于这份付款意图；真实部分/全部核销不会改变旧请求或再创建发货。新普通 delivery.notice 不再为类型2创建第二个 shipping 投递，已提交的历史投递保留原件。

## 原账号及 Queue

实际 App 消费者仍以真实验签 JSAPI SUCCESS 原证取得原 AppID、商户、交易与付款人，并在 NativeApp 命名空间存在时用独立 App 会话排除冲突；命名空间全缺席时仍核对实际 App 和原证。当前配置、买家最新 openid、渠道标签和 INIT/PREPAY 都不能成为付款 authority。归档 AppSecret/token、维护批准、短事务复验和原子回执沿[原账号发货合同](routine-shipping-accounts.md)，没有新增运行权限或城市任务读取能力。

生产 paid Queue helper 在 completed/already-completed 后调用真实通知派发端口，只投递相同 eventKey 的账本引用。派发失败不重做已提交财务，原 paid 消息仍确认，由既有数据库扫描恢复。未完成的 busy/failed/deferred 与 terminal dead 不借此派发。Queue 内容只有 action/channel/deliveryId/eventKey，不含原付款人、凭据或请求体。

SQL 事务关闭后才调用提供方。明确忙碌仍保留首次派发 body/upload_time 和五次尝试边界，真实核销后可重试同一意图；可能已发送的未知结果保持 UNKNOWN，不自动重发。已确认回执与 SENT 同事务提交，历史接受不能重新授权外部请求。

## 已验证和未覆盖

完整10项原生文件在 final-02 使用五个实际 TCP LOGIN 与生产 Admin checkout；其中9项由真实本地 RSA/AES 回调/default付款驱动，第9项单独执行本地零款，无提供方证明。文件还执行真实付款 effects、普通员工 HTTP 核销、生产 paid Queue helper 及 shipping 消费者。包含原账号与付款人分离、实际平台加两供应商家族、后置回滚/重放、部分/全部核销后的原体重试、UNKNOWN、四账号领取前拒绝、源/批准拒绝、真实 NativeApp 冲突、本地零款及提交后即时入队。外部 HTTP 期间独立连接证明家族/投递锁已释放且 App 无 idle transaction。

另有完整既有发货12项、通知/Queue单元及严格类型回归。预售退款完整数据库基线中的新增4项使用明确合成的 legacy SQL 付款和提供方状态作为输入，只证明该层 whole/partial 恢复、回执不可变与矛盾源拒绝；它们不证明真实提供方、原证或生产LOGIN，也不混入10项原生链的证据。

final-02 的原生与48项单元全部通过，随后类型检查发现日志 outcome 使用了未定义枚举。唯一源码更正是将该异常日志值 deferred 改为已有 failure，逐字逆向还原与原冻结哈希完全相符，没有改变付款、源事实、请求或控制流。recovery-03 在当前字节补跑受影响的8项Queue单元及完整Worker unit/runtime、Admin类型，全部通过；不声称又跑了一遍全部原生。

尚未执行64/65叶、200/201商品边界、供应商家族核销竞态、零款标签Alipay或游客的本轮专门验收、发货开关切换并发，以及退款分代发货/历史 SKIPPED/UNKNOWN 的维护恢复；五次尝试终止与1MiB预算也尚无边界运行。充值与会员必须继续使用各自真实业务主体，不能把同号ID当作商品单。没有生产DDL、部署、真实微信或新的Browser验收；跨AppID归属屏障、现有UID/权益/旧单/付款及 runtime_ready=false 保留。
