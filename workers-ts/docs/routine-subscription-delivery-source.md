# 订阅发货通知的原付款、目标归属与模板准入

本轮从已推送的 `af314e5ba8f671c768eac4d03e67fa48f1923377` 继续。在[账号批准与 token 基础](routine-subscription-authority.md)上，新增实际已存在发货通知的 prospective 读取与重验：绑定原 Routine SUCCESS 付款、精确 AppID + UID 接收人、原事件 / 投递记录和独立批准模板。

这仍是来源准入，不创建发送 attempt / result，不提供 POST 许可。旧通知作者及 Queue 仍未接入新原账号路径。不能将该读取能力、token 字符串或历史策略行当作已发送证据。

## 原付款来源

`RoutineSubscriptionOriginal.ts` 的 `readRoutineSubscriptionOriginalTx` 只读取固定 store_order 付款根。输入为 rootId、buyerUid、orderNo、transactionId、totalAmount，首次 await 前复制封闭 DTO 与签名原语。调用者必须先稳定物理来源；reader 不取得新的付款、退款、业务或 advisory 锁。

完整读取同 orderNo **或** transactionId 的所有原证，最多 64 条 / 1 MiB；逐项验签、解析及核对相同事实、bound 本地根 / UID / 金额、CNY / SUCCESS / JSAPI、实际 paid / weixin / tradeNo / 价格与根形状。unresolved、异域、冲突、缺失和超限均拒绝。原证中的 payerId 保留付款含义，不转换为通知接收人。

独立 `readRoutineApprovedUsesForSubscriptionTx` 核对历史付款 query / notify use 与其原始策略留存，使用专属 `subscription-approved-use-set` 摘要域。它只解释付款 provenance，不借用付款批准作为 subscription_send 权限；无需当前 merchant 材料或当前小程序配置，也不要求 shipping 批准。

subscription、原付款、付款策略目录必须一致绑定维护者 / App 名称与 OID；对实际读取的关系核对 public 解析。原证返回冻结对象，以 WeakMap 绑定同一 SQL 事务，spread / JSON / 另一事务不能制造 proof。

## 发货事件、接收人与模板

`prepareRoutineSubscriptionDeliveryNotice` 接受封闭的 deliveryId / eventKey，在新的短实际 App RC / RW 事务中读取真实投递与业务事件。按 731663 → 731664 → 731669 → 731714 → 731716 → 731717 → 731725 升序先取共享 try-only 维护 gate，再取得物理 SHARE NOWAIT 表 fence；目录、实体和事务期限均失败关闭。

商品订单、商品明细、充值、会员订单、业务 outbox、投递表均在相应读取前核对解析并稳定候选集合。付款根 / 子单按 ID 加锁，核对完整有界 family、相同买家 / 付款、有效实体、叶金额守恒及完整同号 / 同 transaction 跨域候选。来源事件与当前已发货实体的订单号、UID、配送方式 / 名称 / 单号一致；同城额外使用既有 active attempt guard，不能让旧任务通知借用新任务状态。

`NativeAppRoutineSubscriptionAuthority.ts` 在原事务内持 try-only 付款边界，复查原证集合和付款 use 摘要。若已有 NativeApp bundle，使用独立的实际 App SQL 连接，核对数据库 / OID、独立 PID、当前真实 LOGIN、只读模式和随机持锁 challenge，调用既有完整 NativeApp 缺失检查。前后根 xmin / ctid / 物理值及身份必须一致；不借用发货批准或 Financial 退款身份。该独立连接仅为本地 SQL 反证，不是微信 HTTP。

接收人只通过 `readRoutineIdentityOwnerForUidTx({uid: 原买家, appId: 原证 AppID})` 读取。它核对完整归属候选、不可变观察锚点、活跃用户及精确物理 routine binding；没有映射或存在多个活跃主体则拒绝。当前 B、最新裸 UID openid、付款人及另一个买家的映射均不能代替 A + UID 归属。

模板按原通知类型使用 PHP template mark：快递 `1458`，送货 / 同城 `1128`，由该 A 的最新独立 subscription_send 策略选择。系统 noticeMark 与 template mark 分别核对。旧 templateCode 列上限 100，不能截断批准的长模板 ID，也不能借用当前无 AppID 的配置表作为历史批准。

仅承认业务事件和投递本来就记录 A、目标恰为 A 的 owner、模板与原渲染完全一致的意图。B pin、历史缺失、裸目标或不一致模板均不补写、不改派、不重新解释；UNKNOWN / DEAD / SENT 等非 prospective 状态拒绝。此处不提供 lease 作者或历史 outcome 的证明。

## 原渲染与 fresh 重验

从现有 Outbox staging 抽取相同的纯发货 data renderer，旧调用保留同一输入与结果。新 `readRoutineDeliveryNotificationDataTx` 只查询渲染所需商品字段，最多 200 行 / 1 MiB，精确 UID、正数量和 SHARE NOWAIT fence；不再为了新来源读取无界裸身份列表。使用原投递 addTime 重算通知 data 与跳转页，不能接受任意同形状字符串。

返回的 facts、request、策略及模板均冻结。完整 sourceDigest 绑定根 family、原事件、投递不可变字段、原证 / use 集合、owner / witness、最新策略与真实请求；WeakMap 拒绝克隆。`recheckRoutineSubscriptionDeliveryNotice` 在另一个短实际 App 事务中重新读取所有事实，变化即拒绝。SQL 内无 Redis 或微信 HTTP；外部 token GET 之后仍须重新准入。

这些 public wrapper 关闭各自 SQL 事务；未来首次发送作者必须在追加不可变 attempt 的同一事务内重用 fresh 来源检查，再关闭 SQL 后 POST。不能从一次旧读取的完成时间、任意历史 timestamp 或旧策略窗口推导“当时仍获批准”。

## 实际验收

全部重型检查经单层共享串行锁，Vitest 单 worker / 不并行文件，沿用 Node24.14.1、npm11.11.0、自有 PG16.14、原内存上限、每命令 600 秒和整组 1200 秒。最终三批各冻结 8559 份输入，运行中及补文档前摘要均一致。

| 批次 | 实际结果 | 整组耗时 |
| --- | --- | --- |
| native-03 | 新普通快递来源 / 归属原生 10 项通过 | 153.48 秒 |
| compat-04 | 既有发货账号 8、通知来源 45、订阅账号 15，共 68 项通过 | 268.40 秒 |
| final-05 | 单元 139 通过 / 2 个既有 PG 条件跳过，Worker unit / runtime 两套类型检查通过 | 316.31 秒 |

新 10 项实际执行 Admin JWT / 账号 / 权限及 checkout / 发货 HTTP、RSA / AES 付款回调、App paid / notice outbox、真实 code2Session 观察与归属作者，再经新来源读取及 A token GET。正例保留 payer ≠ owner、A / B 同 UID 和最新裸 B binding；证明当前配置 B 或清空后仍选择 A，所有读取和 GET 保持订单 / 用户 / 绑定 / 投递事实不变。

负例覆盖错误 LOGIN、事务根和克隆能力、错误 pin / target / template / 原渲染、UNKNOWN、失效绑定、变化金额、跨域同号、最新模板替换 / 撤销、经真实验签存入的 Routine 冲突与 APP 成功，以及实际 gate / 源表锁占用。另一个真实已付款 UID22 只有裸 payer-shaped binding、没有 A + UID22 ownership，不能借用 UID11 的映射。

手机号连续性、既有用户 / 地址 / 裸绑定及角色为明确 fixture bootstrap；归属与付款正例均经实际作者生成。Redis / KV / Queue / 微信 HTTP 为本机传输适配，无真实短信 / 登录表单或 Redis 登录验收。Admin 在空 Redis 配置下仍执行真实 JWT、DB 账号、角色和 auth claim 校验。没有订阅 POST。

139 个单元数已包含以前的 3 个 transport deadline 单测，不算本轮新增；两个跳过项仍是 `routine-runtime-config.test.ts` 的 PG16 原子读取与 shared credential gate 条件用例。只计最终所选 217 次成功 / 2 跳过，不重复累计早期批次。四个成功原生阶段的自有 PG 均 remaining=0 并 STOPPED。

native-02 首次真实运行在 beforeAll 的 Admin cart HTTP 阶段失败，134.90 秒、10 项跳过；测试缓存 mock 漏掉 Admin 鉴权所需真实导出。只改为 importOriginal 保留模块导出，未改生产鉴权；PG 已清理，失败日志保留，不记成业务用例失败或通过。final-01 的 139 / 2 与两套类型通过也保留；其后补齐商品表解析 / fence、缩短超出旧列长度的 fixture account、修正 mock，再由 native-03 / compat-04 / final-05 完整验证最终字节，早期重复不加数。

源码与日志交叉复核未发现范围内阻塞；原证 / 付款 use 两文件由复核者编写、主流程另读，其余文件由复核者交叉读取，没有独立重跑或安全审计声明。原始日志、冻结清单、失败记录与汇总在本机 `.cache/php-ts-phase46-validation/`，文档终态后补，提交文件另做秘密扫描及暂存 / 提交字节核对。

## 后继仍需完成

本轮动态正例仅普通 express；split、send、city 及 64 / 200 容量边界未单独运行，不能以代码分支或类型通过代替原生证明。退款拒绝 / 成团通知、非微信单、历史缺来源或缺 pin 的维护恢复也不由该 delivery reader 处理。

仍需新增可信通知作者接线、不可变 attempt / result、实际 Queue / provider POST，以及提交后未知结果恢复。可能已 POST 的 UNKNOWN 不能换键或仅凭旧 Admin retry 决策自动重发；历史策略行不证明发送结果。当前实现不创建新 SQL 表 / grant，不改变生产 AppID、用户 / UID / 权益 / 旧单 / 付款。无生产 DDL、部署、Browser、Workerd / Hyperdrive 环境或真实微信验收；完整维护 manifest / 单次许可 / 原子切换与整体 PHP→TS 迁移仍未完成，跨 AppID 屏障与 runtime_ready=false 保留。


## 第47轮后继：同事务来源与实际 Queue 派发

本页前述第46轮结果是当轮历史快照。第47轮已接通[实际 Queue 派发、不可变 attempt/result 与固定 POST](routine-subscription-delivery-dispatch.md)：新增同事务 `prepareRoutineSubscriptionDeliveryNoticeTx` / WeakMap 检查，维护 gate 顺序在731725后追加731726，并在写首attempt的同一实际App短事务内重新核对完整来源摘要、原接收人/模板/请求。token GET 后再准入，SQL之外发送，一次性能力不因慢COMMIT确认重新计时；未知旧attempt不因Admin重试或更换delivery ID重发。

新9项存储/13项实际Queue业务、旧来源10/通知45、单元166及Worker两套类型检查已通过，另2个既有条件用例跳过。普通express与真实配送员send已动态执行，split/city/容量未单独动态证明；来源/通知作者的版本化接线仍未完成，B pin与历史缺失继续拒绝。没有生产DDL、部署或真实微信调用；完整归属manifest/原子切换和整体迁移仍待完成。


## 第48轮后继：新发货作者接线

[新版本作者](routine-subscription-notice-author.md)已接入真实 Admin 与受控分配 Manager 发货：A付款→当前/裸绑定/全局模板B→真实发货→签名request2→App精确A归属/独立模板→既有Queue attempt/result。保留本页旧pin来源准入；旧B/空/缺pin事件不改版或重新解释。App claim仅作轻量真实身份核验，完整目录/来源检查留实际Mini SAVEPOINT；源锁/缺owner/模板可延后Mini并提交原SMS/inbox，既有渠道重放不重渲染。签名staging仍是可变投影，首不可变接受意图仍是dispatch attempt。

最终regression-09新作者19+旧Queue13+来源10+通知45共87项、final-10单元198/2既有跳过及Worker两套类型通过；两批8574冻结一致、四PG remaining0/STOPPED。失败批次和边界详见后继文档，未部署或执行生产DDL，其他事件/非微信单、split/city动态证明、完整切换及整体迁移未完成。
