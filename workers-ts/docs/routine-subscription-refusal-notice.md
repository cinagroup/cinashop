# 原账号退款拒绝订阅通知

第49轮基于已具体授权推送并核对远端的 `b68619873f870c6d448d76973a7603befe6093b9`，接通普通未拆单商品的 Admin／Financial 拒绝退款通知。真实链为 A 付款与原证留存 → 买家申请退款 → 当前账号、最新裸绑定及全局模板切 B → 正式拒绝及不可变业务回执 → 签名 request3 → App staging3 → 既有 Queue 的原 A／1451 发送及不可变 attempt/result。用户、UID、权益、旧单及原付款不迁号，不猜未知归属。

## 原申请与拒绝决定

`RoutineSubscriptionRefusalRequest` 使用独立 format3、`refusal-notice-request` MAC 域，不改变发货 format2 的合同与签名域。请求绑定真实 SQL 作者 LOGIN/OID、数据库及维护者名称/OID、UUID、eventKey、聚合、事件时间、原有五个业务字段，以及该次拒绝原因、时间和原申请摘要。公共作者只读目录、自己的真实身份及同事务实际退款／订单行，不取得私有付款、归属或订阅策略 SELECT，不决定账号、接收人或模板。

原申请摘要单独绑定15个公共字段：ID、订单关系、退款业务单号、UID、store/supplier、申请类型/金额/数量、退款金额、原因/说明/图片、cartInfo 和申请时间。实际拒绝须为未取消/未删除的状态3、规范非空原因和精确事件时间；图片≤256KiB、cartInfo≤64KiB、申请JSON≤1MiB，DTO及密钥在首次异步读取前复制。SQL JOIN 另核对真实付款订单、金额、UID、store/supplier、存活与解析，行锁为 SHARE NOWAIT。

买家真实 reapply 会新建 refundId，并为新申请持有当前 cart 数量。旧拒绝请求不绑定当前 hold 或订单 refundType；消费时重核原申请及原拒绝决定，不能把新申请当作旧拒绝，也不能要求当前 hold=0。后续金额／家族重构若不再满足原来源则拒绝发送，不重新定义原金额。1451继续使用原合同的整单商品标题、订单 payPrice、订单号与售后页，不拿申请退款金额替换订单金额。

整个 Dispatch namespace 缺席才保留原 legacy pin 作者。半安装、漂移、缺 writer 材料、非有效作者或公共来源不符，原事务记录不可发送的 unavailable3；实际元数据 SQL 故障由真正 SAVEPOINT 回滚后隔离。已有 eventKey 或并发 INSERT 赢家保留原版本、pin、缺失及签名，不因修复后配置重签。历史非规范申请不能补造成新证据。

## App staging、Financial 与实际 Queue

App沿用八个升序共享 try-only gate、物理 NOWAIT fence 与真实短事务，退款事件额外稳定 refund/refund_payment 两表并重读原拒绝行；不接受已在途或成功退款作为拒绝来源。随后独立核对商品付款根、完整家族守恒、原 SUCCESS 付款、NativeApp排除、精确原 AppID+买家UID归属及最新 `subscription_send` 的1451模板/材料。当前B、裸B、payer、shipping批准或 `refund_request/query/notify` 批准均不能替代。

staging3使用独立 `refusal-notice-stage` MAC，绑定请求签名、event/delivery/source、策略及完整请求。旧 format2 及其 sourceDigest 排列保持；新拒绝摘要另纳入实际退款和提供方退款投影。既有 intent 仅认证重放，新的 POST 仍须 fresh 来源、不可变首 attempt 及一次性能力。新增精确 key/mark 分类；已安装协议中的畸形退款 key 留在失败关闭分支，不能退回 legacy 发送。

Financial在原业务事务写完通知后，核验实际留存事件的五个业务字段并保留完整 payload，再执行原完整 outbox hash 核对和不可变 action receipt。它不重取当前B pin。缺失或冲突属于 `ValidateException`，原事务回滚后继续由既有协议产生 `rollback-rejected`；真正 SQL 故障仍向外传播，没有扩大 catch 或错误白名单。

缺 owner、独立模板、consumer key、源锁或晚 intent UPDATE 失败仅延后 Mini；真实 SAVEPOINT 消除 aborted/unsigned 中间行，短信与站内信仍可先提交。重试保留原目标、模板、内容及时间，不随订单手机号和模板变化重渲染。已确认无效的请求为空目标终态 skip，unavailable3不升级。

实际 Queue 复用[既有不可变 attempt/result 协议](routine-subscription-delivery-dispatch.md)，不新增表、DDL、grant或传输协议。token GET／POST在SQL外，发送前再次重查来源；每次POST对应一个durable attempt，缺 result 的历史保持UNKNOWN，换delivery ID或人工状态不能再次发送。旧发货作者见[第48轮](routine-subscription-notice-author.md)。

## 验证与证据边界

| 最终字节批次 | 结果 | 整组耗时 |
| --- | --- | --- |
| recheck-07 | 新退款拒绝16 + Financial兼容71，共87项原生通过 | 359.64秒 |
| final-09 | 单元264通过／2个既有PG条件跳过，Worker unit/runtime类型通过 | 322.17秒 |

两批各8579份输入，运行中及补文档前均匹配；最终图只计351次成功／2跳过。Node24.14.1、npm11.11.0、自有PG16.14、单层共享串行锁、Vitest单worker/不并行文件、既有内存限制、每命令600秒／整组1200秒保持。两次最终PG均 remaining0/STOPPED。新增34个request与32个intent/key纯单元仅证明codec/边界，不作实际SQL准入证明。

16项新原生使用真实Admin checkout、默认RSA/AES A回调、App paid、买家退款HTTP、正式Admin JWT operation及不可变回执，或实际Financial LOGIN／review／execute及不可变回执，再经真实App作者和Queue dispatch/attempt/result。正例在付款后拒绝前切B，payer≠A owner，独立1451绑定；真实reapply、code2Session归属修复、独立shipping/refund批准不能借用、锁争用、晚UPDATE触发器故障、缺材料、篡改、撤销、稳定重放和UNKNOWN均有覆盖。Admin/Financial无三个私有来源表SELECT。

微信HTTP、缓存与Queue是受控本机传输，手机号连续性、用户/配置/模板是明确fixture输入；损坏SQL、额外索引与故障触发器仅为拒绝或回滚标本。新原生不是createApp、浏览器、真实SMS/登录表单、微信订阅同意或平台接受证明。Financial71为既有完整业务回归，其受控网关与种子不能替代新原证链的阳性证明。

失败与中间记录保留：final-01的264单元通过后，类型检查报6处新测试直接赋值readonly，改为构造替换副本，runtime当时未启动；refusal-03的16及regression-04的旧发货作者19／Queue13／来源10／通知45均通过；financial-05为70通过／1失败，发现新helper普通Error使缺必需通知时未返回既有回滚拒绝回执。仅新增ValidateException import并替换该helper同文本throw，未改原断言或SQL处理；随后以最终图重跑16+71与单元/两套类型。先前87兼容结果只保留为修复前图，不冒称最终字节重跑，也不加入351总数。

本机 `.cache/php-ts-phase49-validation/` 保留原日志、输入冻结、失败、修复前兼容差异与交叉复核。复核者独立读8个核心，5个文件仅核对窄接线，另5个request/测试文件由其编写、主流程另读；不是18文件全独立审计或独立重跑。文档在所有重型检查终态后补，最终文件另做秘密扫描及暂存/提交字节核对。

[父提交b6861987的CI](https://github.com/cinagroup/cinashop/actions/runs/41437973088)末次快照为10成功、两个Worker分片仍运行，不能称全绿或替代新提交CI。其他业务作者、拆单/后续复杂退款、成团3098、非微信单原账号通知、完整归属manifest/单次许可/原子切换及整体PHP→TS迁移仍待完成；下一成团地图只是只读建议。无生产DDL/Env切换、部署、真实微信或Workerd/Hyperdrive验收，跨AppID屏障和runtime_ready=false保留。新提交推送需要具体SHA授权。
