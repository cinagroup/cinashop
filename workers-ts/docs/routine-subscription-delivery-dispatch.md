# 原账号订阅发货通知的 Queue 派发与不可变回执

第47轮从已授权推送并直接核对的 `5b4074f24e9c28526ff86b1c88ceb376951bbff9` 继续，接通已有 A pin 发货通知的真实 Queue 消费。实现范围为 `wechat_routine` 的 `order.delivery.notice`；[来源准入](routine-subscription-delivery-source.md)与独立[批准/token](routine-subscription-authority.md)组合进入实际服务。旧通知 staging 作者仍未迁移：只承认本来就一致记录 A、精确目标/模板/渲染的意图，B pin 或历史缺失拒绝，不重新解释为 A。

## 显式安装与运行身份

新增独立 namespace `routine_subscribe_*` / `rsnd_`，不扩宽旧 subscription 策略 namespace。`runRoutineSubscriptionDeliveryUpgrade` 是显式 PG16 维护后继：双表、7/5列、15约束、5索引、4个不可变触发器，无 FK/default/sequence；App 仅获得非委托 SELECT/INSERT，Admin、Financial、Manager、Cashier 不新增数据权限。任意 JSON 样本和目录就绪均不代表通知批准、发送或结果。

目录绑定现有原付款、归属及订阅策略的同一维护者/App 名称与 OID，核对精确结构、约束、索引、触发器正文、类型、ACL、默认权限和实际 LOGIN。维护按 731714→731716→731725→731726 取得独占 try-only gate，稳定来源和权限表，完整核对原声明 App/Admin 与五角色 peer/reader 合同，原子安装、幂等，不修复半安装或漂移。沿用旧维护协议的每条 SQL/idle≤5秒、锁等待≤1秒；完整前后审计不使用业务事务总龄限制。runtime Read/Ready 及 fresh 发送事务仍限制实际 App、PG16、隔离/读写模式、public 解析和5秒事务龄。

Queue 消费在修改 claim 前检查可选目录。整个新 namespace 未安装时保留 legacy；只要有对象存在，就必须完整就绪并证明实际 App LOGIN。撤回 Env 材料不能退回 legacy。其他事件或渠道维持既有路径；运行时不提供以清除协议或历史来恢复 UNKNOWN 的入口，维护不得用卸载/删历史代替结果证据；完整 namespace 缺席的兼容判断本身不能区分从未安装与被外部整体删除。

## 一次 POST 对应一个不可变 attempt

`RoutineSubscriptionDispatch` 在第一次 await 前复制封闭 claim 与部署原语，只读取独立 subscription 注册表、APP_KEY、独立 token 缓存和固定数据库连接。先完整认证同 delivery_id **或** 语义 eventKey/channel 的 source_key 历史，最多5条；签名绑定数据库/维护者 scope、真实 App/OID、序号/前驱、lease、来源 facts、批准策略、精确请求与不可变 intentDigest。每条历史均核对保留的真实策略和声明窗口；该历史读取本身不证明任意过去时刻的 latest 或已经 POST。

任何历史 attempt 缺少有效 result 都是 sticky UNKNOWN：在来源/token/POST 之前停止。source_key 不含可替换 delivery ID，因此换 ID、清零 mutable attemptCount/replayCount 或旧 Admin confirmRetry 不能创建新 UUID 逃过未知历史。已有明确成功或永久拒绝可由真实回执恢复投递投影，人工状态不是提供方结果。

只有完整历史的明确可重试非零拒绝，才可进入下一序号。取得 token 后，在同一新的短 App 事务中重读来源、当前精确 owner、最新批准/模板/材料和请求；八个共享 try-only gate 均在物理锁前取得。核对 PROCESSING/lease、SQL 时钟、序号及完整来源摘要：租约必须仍未过期，leaseUntil-SQL now 的剩余时间上界为180秒，正常 Queue provider claim 仍为120秒，追加并读回验证 attempt。首次 claim 若已有未记录的 legacy 尝试或 replay 不会获准发送；跨重试请求和不可变意图不能改变。

最终 SQL 同时核对5秒事务龄与策略 validUntil，并返回精确 SQL 毫秒。一次性 WeakMap 能力使用该 SQL 前的 monotonic anchor，时限取两秒与剩余策略有效期的较小值；COMMIT 确认后不重置。慢确认耗尽窗口只留下 UNKNOWN attempt，不 POST。所有 SQL/维护锁在 token GET、缓存等待和 POST 前关闭。

## 固定提供方与结果原子落库

Provider 仅消费私有一次性能力，固定 POST `api.weixin.qq.com/cgi-bin/message/subscribe/send`，禁止重定向，原请求不接受外部替换。fetch 与流共用8秒硬截止，最多32KiB、严格 UTF-8、int32 errcode；HTTP非成功的 code0、未知 JSON/编码/超限/超时均为未知，不自动重发。忽略 abort 的 fetch/流仍受硬截止约束，迟到响应取消，错误统一脱敏。无内部 token 刷新或第二次 POST；40001/40014/42001 的明确拒绝先保存 result，再由下一独立 attempt 强制取新 token。

有效 HTTP 解析结果由另一私有 WeakMap 绑定 attempt UUID/signature。result 保存 code/status、原始响应字节摘要及始发/验完时间，不保存 token、原始响应或提供方错误消息。结果 HMAC 和唯一键绑定 attempt，真实 SQL 时钟校验窗口；result 插入、读回及 SENT/RETRYABLE/DEAD 投影 CAS 在同一事务中完成。发送中撤销批准不抹去已明确返回的成功，结果只验证留存的当次策略，不要求 latest 仍 active 或接收人仍存活。

结果写入或投影 SQL 失败时一并回滚，先前 durable attempt 保留为 UNKNOWN。提交确认不确定时保守停止，不据此推断是否已提交，以真实留存 attempt/result 核对；既有 attempt 缺少回执就不许可后续新 attempt/POST。明确重试码只允许最多5次 POST；永久拒绝停止。手工确认状态不制造回执，旧人工重发不能重试 UNKNOWN 或永久拒绝。本轮无提供方查单式恢复，也不把慢已提交返回标本当作真实网络 COMMIT ACK 丢失测试。

## 验证与边界

| 最终批次 | 结果 | 整组耗时 |
| --- | --- | --- |
| native-03 | 新存储9 + 真实Queue业务13，共22项通过 | 332.34秒 |
| compat-04 | 既有来源10 + 通知45，共55项通过 | 163.54秒 |
| final-05 | 单元166通过/2个既有条件跳过，Worker unit/runtime类型通过 | 335.92秒 |

三批各冻结8567份输入，运行中及补文档前均匹配；单层共享串行锁、Vitest 单 worker/不并行文件，Node24.14.1/npm11.11.0/自有PG16.14、既有内存上限、每命令600秒/整组1200秒保持。只计所选最终243次成功/2跳过，不累计重复批次；四次原生PG均 remaining0/STOPPED。27个新 provider 单元明确 mock admission，只证明传输/资源边界；其余139既有单元和两个既有PG条件跳过不冒称新增原生验收。

9项存储验收包括三源缺失、真实五 LOGIN/SET ROLE、封闭输入快照、半安装/owner-only/23类漂移、真实尾 SQL 回滚、实际 gate/源表争用、精确 ACL/列/约束/索引和幂等全角色审计。原始 SQL JSON 明确只是结构样本，不是业务 attempt/result。

13项业务验收通过真实 Admin JWT/账号/权限、下单/发货 HTTP、独立批准原账号 RSA/AES 回调、App paid/notice outbox、code2Session-backed 归属及真实 Queue dispatch/claim/attempt/result 作者。payer≠owner、当前B与最新裸B存在；普通 express 和真实配送员 send 的1458/1128模板均到精确 A 接收人。覆盖 GET 时撤销/改模板零POST、POST中撤销后SENT/重复消费、响应丢失+旧Admin重发/换delivery ID、40014独立刷新、43101停止、五次45009、真实晚SENT SQL失败回滚及已提交返回延迟2100ms无POST。手机号连续性和用户/地址/配送员为明确 fixture bootstrap，非 SMS/登录表单验收。微信HTTP、Redis/KV、Queue是受控本机传输，不是真实微信接受、订阅同意或收件证明。

首次 storage-02 的3通过/6失败保留：新安装器错套5秒维护总龄，完整审计约8秒即回滚，后续因未安装级联失败；移除该错误总龄，保留既有单条SQL/idle/锁限值及完整审计后重跑。final-01 的166通过/2跳过后类型检查只报新标本 unused import/union 类型问题，也保留；修正后最终两套类型重验。交叉复核另外识别并修正慢COMMIT确认重置窗口、send遗漏delivery_uid及配送员与买家重复手机号；未放宽生产鉴权。

原日志/冻结摘要/失败记录在本机 `.cache/php-ts-phase47-validation/`。复核者独立读取主流程5文件，另6文件由其编写、主流程另读；不是全11文件的独立审计或独立重跑。文档在全部验证终态后补，最终提交文件另做秘密扫描和暂存/提交字节核对。

父提交 [5b4074f2 的 CI](https://github.com/cinagroup/cinashop/actions/runs/41415138730) 最新读取快照中，PC/Kefu、Admin/Supplier、PG16、workerd、秘密扫描及Uni两组/唯一聚合成功；Uni core 12分35秒、authors 5分11秒。Worker两个分片仍 in_progress，不能称全CI绿色，也不替代本轮新提交CI。原快照/末次快照分别在 base-ci-jobs-03.json / base-ci-jobs-final-06.json。

split/city分支和容量上限未单独动态证明，通知作者版本化接线、退款拒绝/成团等其他事件、非微信单/旧缺来源恢复、完整归属manifest/单次许可/原子切换及整体 PHP→TS 迁移仍待完成。未执行生产DDL/Env切换、部署、Browser或Workerd/Hyperdrive环境验收；用户/UID/权益/旧单/付款保持，未知不猜归属、跨AppID屏障和 runtime_ready=false 保留。新提交推送仍需精确SHA授权。
