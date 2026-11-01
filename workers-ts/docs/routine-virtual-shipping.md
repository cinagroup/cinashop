# 充值与会员的原账号虚拟发货

固定 PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 在充值和付费会员的真实付款成功后，延后十秒调用统一虚拟发货。TS 使用各自的 `user_recharge` / `other_order`，不会将同号 ID 当作商品单。官方[发货信息录入](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)确认物流3、统一模式1和单条商品描述；十秒业务时点来自 PHP 作者。

实际 Routine WeChat 回调和默认签名查单消费者在原财务事务中，完成充值本金及赠款、或会员权益和状态记录，同时写入 COMPLETED 的领域源和 PENDING 投递。源是既有可变 outbox 内受 HMAC 验证的快照，不是新增 SQL 不可变表；源键为 `recharge.paid.shipping:<id>` 或 `membership.paid.shipping:<id>`，不重做财务。重复完成、历史已付款、余额/免费/卡激活/线下/Alipay 均不会由新作者补发。发货关闭时保留原付款行为。完整旧14/15合同通过既有命名目录及实际 App 身份证明后只返回“不启用”，可选原证、账号和发货存储须全部缺席或各自完整且归属一致；半安装与 TEMP 遮蔽仍拒绝。发货开关开启且新主体合同就绪后，缺失签名材料必须拒绝并共同回滚。

新投递使用 nullable `subject_domain` / `subject_id`，商品与提现 ID 都为空。正式 PG16 维护 forward 从精确旧14/15升级到16/17；联合 CHECK 封闭领域、ID、key、mark 和渠道，保留旧商品/提现形式，增加精确部分索引。前后验证完整五角色合同、表归属与既有批准存储，不执行新 grant、不回填旧付款。既有整表授权仍有效覆盖新列；新作者和消费者另强制核对实际 App 身份。默认值、列 ACL、索引和约束漂移拒绝，不自动修复；调用者回滚包含所有 DDL。维护指纹保留每表10,000行、单行1MiB预算，超出即拒绝；本轮不证明更大生产账本的升级。Supplier 改价和 DB007 后继须保留完整新合同。

初次投递截止以财务事务末的数据库时钟加十秒计算。提交后只发送不透明 action/channel/deliveryId/eventKey，使用 Cloudflare [batch 延迟](https://developers.cloudflare.com/queues/configuration/batching-retries/)；扫描恢复可使用[逐消息延迟](https://developers.cloudflare.com/queues/configuration/javascript-apis/)。消费者在领取前再次核对 SQL 截止时点，应用时钟领先不能提前上传。Queue 不可用时不撤回已提交财务，由实际扫描器恢复投递。

新不可变派发 format2 以 domain/subjectId 隔离身份和 HMAC，不包含伪造 rootId/childId。format1 商品派发仍按原格式和签名读取。充值描述使用原价格，会员使用保存的天数或永久权益，不咨询今天的套餐或用户到期时间。提供方载荷固定 logistics_type=3、delivery_mode=1，单条 item_desc，无物流单号、承运商、联系资料或 is_all_delivered。

仅实际受限 App LOGIN 能领取和上传。原付款的验签 JSAPI SUCCESS、真实付款人、原 AppID/商户、归档 AppSecret 维护批准和独立 NativeApp 反证共同成立，当前配置或最新 openid 不能替代。外部 I/O 不持金融事务锁；明确系统忙重试保留首次 body/upload_time，丢失 POST 结果保留 UNKNOWN 且不自动重发。明确 HTTP 结果的签名观测与对应 SENT/RETRYABLE/DEAD 同事务落库，丢失 POST 的 UNKNOWN 不伪造提供方结果，已接受历史不重新授权请求。

## 冻结版本验收

正式12项只证明结构协议及角色，所用 SQL 标本不是付款事实。业务13项使用真实领域创建、RSA/AES 回调、默认签名查单、五独立 TCP LOGIN、维护批准和生产 Queue 消费者；外部微信/Queue 传输为受控本地替身。最终 `final-09` 的74项单测、148项既有金融PG回归、正式12项与真实业务13项、旧自提10项与快递12项、Worker unit/runtime及Admin类型全部通过；22条实现/测试/夹具输入全程未变。三个原生批次均无剩余夹具且集群停止。

本轮不证明生产微信、生产 DDL、部署、Browser、Workerd/Hyperdrive、负载或边界压力。退款代次发货、更正、历史 SKIPPED/UNKNOWN 维护恢复、完整归属清单与切换许可、前端 session/journal 和既有 CI 缺口仍待迁移。保留用户/UID/权益/旧单/付款，未知归属不猜，跨 AppID 屏障、`runtime_ready=false` 与整体未完成状态保持。

首次类型检查8项诊断及后续4处测试事务类型错误均已修正后重验；早期正式验收的完整角色逐列审计缺口以精确16/17后继识别解决，没有扩权。正式03唯一失败是测试误把夹具专用 pricingOwner 算入返回 peers.target，生产声明未扩张。业务04因维护API多余声明在初始化失败、05因恢复凭据晚于重新激活批准而级联失败；修正夹具后06完整13项通过，最后旧库兼容修补另由上述最终批次重验。final08误将三份需要PG的文件选作纯单测，74项通过但三个suite失败、148项未执行；最终改用原有PG白名单运行器全数执行，不把跳过算通过，也不累计重复批次。
