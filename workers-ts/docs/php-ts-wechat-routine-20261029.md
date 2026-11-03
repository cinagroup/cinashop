# 小程序微信配置迁移进度（实施中）

本轮接续已完成本地验收的原生 App 切片，开始实现小程序五字段配置作者及其真实消费者。当前尚未完成作者保存、页面和全部消费链路，不构成本切片验收，也不关闭整体 PHP→TypeScript 迁移。

## 已确定的业务边界

用户选择保留现有用户、权益和旧订单；跨 AppID 切换必须先完成归属维护。普通配置保存不能依据当前 AppID、openid、unionid 或缓存缺失认领旧历史，不能默认隔离旧 UID、迁移余额或自动合并账号。

固定 PHP 来源为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 的 `view/admin/src/pages/app/routine/download/index.vue` 与 `public/install/crmeb.sql`。本作者拥有 `routine_appId`、`routine_appsecret`、`routine_name`、`routine_contact_type`、`store_user_avatar`。`routine_auth_type` 与 `order_shipping_open` 保留各自已有作者；下载源码或打包功能另列。头像开关的缺行元数据来自 tab26，不能统一改成 tab7。

## 本轮实现

- `view/common/wechatRoutine.ts` 提供精确五字段保存合同、Secret 保留/替换/清空、数字 0/1 开关、旧值解析和不含草稿或凭据的请求恢复标识。文本不裁切或改写；JSON 序列化后容量为 5000 个 Unicode 码点。
- `AdminWechatRoutineIntentPlan.ts` 和 `AdminWechatRoutineMetadata.ts` 保留完整来源行、影子行及已有元数据，只计划显式修改；AppID/凭据内容变化标记不等于维护授权。
- `adminWechatRoutineOperation.ts` 声明独立不可变操作回执 SQL、目录检查及运行权限检查。尚未加入请求入口、正式安装器或全局迁移序列。PGlite 测试证明的是实际 SQL 约束及目录检查，不代表独立运行 LOGIN 的权限验收。
- `RoutineRuntimeConfig.ts` 从同一新鲜 SQL 快照读取成对凭据，使用完整行、影子行及 xmin 形成来源戳；既有 provider 文本规范化保留，名称/客服/头像变化不撤销凭据。独立门 `731666/0` 供后续作者与消费者共用，不复用原生 App 或公众号门。公开号读取不要求 OAuth Secret。
- `RoutineAccessTokenService.ts` 仅使用来源戳缓存空间，不读取旧全局或 AppID-only token。Redis 未配置时仍可直接取 token。provider、Redis 和短 SQL 检查分开；来源变化后的响应不得返回。有效期从请求开始计时，缓存保存绝对到期时间，Redis 使用绝对 `pxat`，缓存命中和最终返回均检查到期。
- `WechatAuthService` 的换码结果携带服务端来源戳；routine ticket、pending、手机号 code 及后续身份事务沿用这一来源，旧票据不能在读取时补上当前来源。缺戳、错戳、轮换后的票据及挪入 routine ticket 的其他渠道身份均要求重新授权；其他渠道原有 pending 行为保留。
- routine 的既有 UID 快速路径、注册与手机号写入使用同一连接内的短来源事务，注册礼包配置预取留在事务外。provider、Redis、KV 与 SMS 不占用凭据门。真实 AES 解密仍核对换码时的 AppID watermark，最终手机写入再次核对来源及当前关联身份。
- 小程序 bearer 每次签发使用独立 nonce；Redis 发布后复核当前来源和用户状态，失败撤销只针对本次 bearer。既有普通 API 会话保留。手机号解密 session 使用 `routine_session:v2:${stamp}:${uid}`，不读取或回填旧全局 session 键；旧请求失败时不裸删同 UID 的共享键，避免误删较新登录的有效会话。
- 推广关系 SQL 在来源事务内提交，分销等级评估使用 root container 在外层提交后单独执行。`UserFinanceService.bindSpreadRelation` 提供事务内 SQL 部分，原 `bindSpread` 仍保留既有独立调用行为。
- 二维码服务的会员激活、付费会员、线下收银、商品、活动、分销、员工邀请和签名图片入口均改用成对 SQL 凭据及共用 token helper。新图片缓存为 `routine_code:v2:${stamp}:…`，包内也带版本和来源戳；旧 AppID-only 图片/token 键不读取或回填。GET、provider 响应、SET 后复核来源；坏缓存作为 miss 重新生成，不裸删共享键。图片 provider 请求与流式读取同受 8 秒、JSON 32 KiB/图片 1 MiB 上限约束，既有页面与 scene 保留。
- `readRoutineCredentialsIfConfigured` 供可选功能保留“SQL 凭据不完整则未启用”的合同；SQL、容量、签名错误仍抛出，不因读失败降级到 KV。员工邀请使用相同完整 winner/shadow 来源并把 stamp 纳入签名 revision，Secret A→B→A 或影子行元数据变化不复活旧签名 URL。既有永久分享文档已签名的历史图片仍保留其确切 AppID；新 provider 生成路径另按当前来源验证，不因同账号换 Secret 撤销永久落地链接。
- 直播 token、回放、主播角色查询及三类同步均使用一次操作捕获的来源，invalid-token 重试沿用同一对凭据。远端读取及队列 I/O 在事务外，同步 SQL、主播保存及其审计在短来源事务中提交。Cron 继续只投递 `live_sync_dispatch`，消费端新建三个带 stamp 的同步页任务；continuation 保持原 runId、scheduledAt 和 stamp。旧无戳、坏戳或已换源分页明确终止并要求重新发起，不在消费时补当前来源。已提交页仍属于当时的有效操作，后续页不能换源接续。

- 回调入站使用新鲜公共 AppID 来源，与 OAuth Secret、APP_KEY 分离，部署 token/AES 的独立加密合同保留。解密/签名在 SQL 外，入站 event/outbox 在同连接公共来源门内提交；影子行或 AppID ABA 变化拒绝，Secret 轮换不撤销已验证回调。历史 event 的 AppID、规范化载荷及哈希保持原样。租约与水位按确切 AppID 分开；旧水位只有关联的历史 last-event 同账号时才适用。Mini subscribe/scan 不再投影到公众号用户表。
- Mini 社交付款、收货事件目前缺少原单 AppID/商户/付款人证据，明确记录 `wechat_callback_original_account_evidence_required`，保留原账号事件并走既有 FAILED/DEAD 恢复流程；此检查先于旧水位判断，不能被较晚的历史水位误记成已完成。公众号既有支付/收货行为保留，原单恢复仍待实现。
- 新的订单/提现通知在业务 outbox 创建事务中记录目标 `routineAppId`，投递渲染只继承原事件的记录。业务事件和投递回放保留原账号或历史缺失，不补当前 AppID；两份明确账号不一致时拒绝且不改原件。旧业务事件无记录则 Mini 渠道为 SKIPPED，旧已排队投递无记录或目标不符则为 DEAD，均保留原内容待维护。新安装未配公共 AppID 时仅跳过可选 Mini 渠道；确定的可选配置错误不回滚财务、SMS 或站内通知，SQL 故障仍传播。游客、次卡和机器人合同保留。
- routine 通知的成对凭据改读新鲜 SQL，统一使用来源戳 token helper；不读旧 KV 凭据或 AppID-only token。明确 invalid-token 只允许在原来源内重试一次。POST 的 fetch 与流式正文受 8 秒、64 KiB 上限约束。明确 `errcode=0` 成功就记录 SENT，不因响应期间换配置改成可重发；断连、超时或坏响应记录 UNKNOWN，Queue 回放不再发送。新目标 AppID 只证明通知意图，不证明既有 UID 或旧订单归属。
- 原账号商品发货已接入维护批准、独立归档 AppSecret/token、原付款及 NativeApp 反证、实际 Queue 派发和原子回执；正式同城冲突 reader 下还支持未完成 express 分包的严格扩包，详见 [原账号发货合同](routine-shipping-accounts.md)及[读取合同](fulfillment-city-conflict-readers.md)。商品付款后自提现已接通真实 paid outbox，详见[自提发货合同](routine-pickup-shipping.md)。已完成发货的更正、充值、会员、历史 SKIPPED/UNKNOWN 维护恢复及全局迁移仍未完成，`runtime_ready=false` 保留。

- `PaymentPublicRuntimeConfig.ts` 新增固定的 checkout/routine/official/merchant 公共 SQL 快照，沿既有平台 sort/id 优先级读取完整来源、影子行与 xmin；64 行和 1 MiB 上限拒绝不完整读取。公共摘要只证明来源一致，不证明旧 UID 或原订单归属；OAuth Secret、商户私钥和 KV 不进入该快照。
- 支付就绪状态的余额、线下、支付宝开关与微信公共配置改读同一 checkout SQL 快照；原生 App 继续独立读取既有账户目录并核对商户，不从通用键读取 App 凭据。Mini 支付的公共 AppID 与商户配置不要求 OAuth Secret 或 APP_KEY；APIv3 部署凭据的要求保留。
- `WechatPayService` 的公共账号/商户读取接入相应 SQL cohort。新 Mini 付款要求开启新支付、JSAPI 与有效 payer 形状，并在既有 beforeProviderRequest hook 之后、HTTP 之前，以 `731664→731666` 顺序短核对公共来源；不持锁执行外部 I/O。明确验签后的预支付成功仍使用原请求捕获的账号签名，不因随后换配置重发或改账号；非成功响应也要求验签，缺失或非法 prepayId 不返回可用支付参数。这里尚未新增 durable payer 归属或逐单发起见证，不能视为原单证据。
- 旧查单/回调不依赖新支付开关；退款继续使用仅 merchant 的公共配置，不依赖任何客户端 AppID/Secret。线下 dispatcher 已持有的冻结 SQL 选择保留，不因当前配置变化改写，已提交的提供方证明仍可在当前凭据缺失时恢复。原生 App 的账户/原单/退款 authority 分支保留。

身份 SQL 与 Redis 不能共享提交：来源有效时已提交的用户、礼包或推广关系不会因随后 Redis 失败被抹掉，失败请求需要重新授权。最终来源及用户复核是本次 bearer 的接受点，之后的凭据轮换不撤销已接受的普通 API 会话。以上来源门仍须配合专用作者的排他门及通用写入旁路保护；当前实现不能作为开放跨 AppID 保存的依据。身份表、旧 UID、既有权益与支付历史未作归属重写。

## 实际验证

基础阶段已完成 271 项定向单元/回归测试，其中输入合同 71、操作回执 30、token 生命周期 78、既有 App/OAuth 回归 92。另有独立 PG16 的凭据来源/并发门测试 16 项和真实 `auth_type` 换码入口测试 5 项通过。该阶段结果见 `implementation-result-01.json`，不与后续重跑重复累计。

登录边界阶段最终定向验证为 14 个文件、328 项通过且无跳过：11 个认证/推广回归文件 208 项，真实 PG16 的换码/会话文件 49 项，以及注册整文件 71 项。注册的 12 项独立连接并发用例均实际执行。会话用例还通过触发器记录不同顶层事务 ID，验证推广关系提交后才评估等级；双连接维护锁竞态后，较新会话仍能以其不同 AES key 实际绑定手机号。两个最终自有 PG16 均记录 `remaining=0` 和已停止状态。微信、Redis、KV 使用受控替身，不代表真实 provider 或生产 Redis 联调。

执行原始记录保留于 `.cache/migration-evidence/routine-work-20261029/`。本轮通过结果以 `auth-regression-02.json`、`auth-native-03.log`、`registration-native-01.log` 为准。初轮回归的新增凭据 fixture ID 与原 policy 用例 ID 冲突，改为独立的 90001/90002 后，注册整文件转至真实 PG 重验；原失败及 12 项未执行记录保留在 `auth-regression-01.json`，不计为通过。早期 47 项会话结果和基础阶段失败也保留；未加长测试、hook 或运行器时限。

后续消费者阶段最终定向验证为 17 个文件、299 项通过且无跳过：14 个旧业务回归文件 226 项，以及实际 PG16 的二维码来源 33、直播来源 24、共用凭据来源 16 项。原始记录为 `consumers-unit-02.json`、`consumers-token-unit-03.json` 和 `consumers-native-01.log`，自有 PG16 记录 `remaining=0` 和已停止状态。二维码测试逐一覆盖 13 类页面/scene 以及 GET、SET、provider 轮换和双连接维护门；直播测试执行生产 dispatch 接线、带戳 continuation、旧任务终止及主播/审计同事务回滚。员工邀请另通过实际路由验证 Secret ABA 和 shadow 变化拒绝旧 URL，并保留旧权益和可用 winner。

该阶段初轮旧回归 156/158：一项源码引号匹配未适配，一项旧测试把陈旧 KV 等同真实小程序换账户。修正后者为 snapshot 与实际 provider 方法之间提交真实 SQL AppID 变更，再验证拒绝且零 HTTP；成功路径同时验证忽略两类陈旧 KV 并使用各自 SQL 账号。原失败记录完整保留于 `consumers-unit-01.json`；未知结果的 ticket/图片恢复断言未减少。各阶段含重复回归，不将历史总数直接相加。

整理逐项清单时另发现 token 参数化标题碰撞：非有限值的 JSON 展示会变成同名 `null`，另有响应负例未区分标题。只给三组标题添加用例序号，全部输入与断言保留，完整 78 项重验通过；最终清单使用这份新结果替换旧批次的同一文件，不重复计数。初次清单的 299 次执行/289 个唯一名称检查失败也保留，修正后 299 项身份均可区分。

Worker 的 unit/runtime 两套完整严格类型均以 0 退出，消费者阶段执行参数和结果见 `types-full-05.json`，登录阶段见 `types-full-04.json`。部分源码/测试检查点及结果分别见 `current-source-inputs-03.json`、`implementation-result-03.json`；它们不代表完整来源验收或最终归档。全部重验证经一层共享串行锁运行，未并发执行重型检查。旧 auth-phone 场景及注册 fixture 已改用各自 SQL 来源戳；本轮未运行外部 auth-phone Worker 场景。

回调/通知阶段最终定向验证为 15 个文件、312 项通过且无跳过：真实 PG16 152 项（通知 45、回调 27、共用凭据 16、拼团 18、提现效果 14、提现收件箱 27、独立只读产品分享 5），普通回归 160 项。原始记录为 `callback-notifications-native-06.log`、`callback-notifications-native-07.log`、`callback-notifications-unit-02.json`，唯一逐项清单为 `callback-notifications-executed-cases-05.json`。自有 PG16 记录 `remaining=0` 和已停止；维护锁、实际 AES、真实业务 outbox/投递 SQL 及 UNKNOWN 回放均执行，微信/Redis/KV 仍为受控传输。

初次普通回归把需要真实 PG16 维护身份的提现收件箱放入内存批次，beforeAll 失败，另有只在 PG 启用的产品分享 5 项未执行；该批次共 160 通过、32 未执行，完整保留在 `callback-notifications-unit-01.json`，不计作最终通过。两个文件已移至实际 PG16 全部重验，最终普通批次单独重跑且无跳过。早期 39/85/119 项原生结果不与最终批次叠加；一次沙箱锁目录只读、一次精确白名单拒绝均保留日志。运行器仅补精确受影响文件名，未加长时限、放宽内存或更改信号处理。完整 unit 类型初次检查另发现新增测试的一条未使用导入；仅移除该行，反向恢复可精确重现此前源文件 SHA，所有输入和断言不变。通知整文件 45 项已重跑通过，最终逐项清单用 `native-07` 的同一 45 项替换旧执行，不重复累计；原类型失败日志保留于 `types-unit-07.log`。

外部 callback/notification Worker fixture 已改用 SQL 公共 AppID/凭据并核对缺原单证据的失败状态，本轮未执行这些外部 Worker，不作为通过证据。Worker unit/runtime 两套完整严格类型均以 0 退出，参数与原始日志见 `types-full-06.json`。部分源码检查点和实施结果见 `current-source-inputs-04.json`、`implementation-result-04.json`；本轮仍无 Mini accepted receipt 或最终归档。

支付公共来源阶段最终定向测试为 11 个文件、330 项通过且无跳过：普通回归 195 项（原生 App transport 43、原身份查单 adapter 83、线下 provider 49、会员渠道 12、readiness 5、退款归一化 3）；自有 PG16/本地 workerd 135 项（新公共来源 44、线下首次发起 27、原单查单 19、workerd→本地 Hyperdrive→PG16 7、查询证明与财务恢复 38）。原始记录为 `payment-public-unit-01.json`、`payment-public-native-03.log`（只选非新来源文件 53 项）、`payment-public-native-04.log`（38 项）和 `payment-public-native-06.log`（当前新来源文件 44 项），唯一逐项清单为 `payment-public-executed-cases-06.json`。三个有效原生批次的自有集群均记录 `remaining=0` 和已停止。受影响旧 fixture 改为 owner SQL 配置与真实 SQL 轮换，未给 restricted LOGIN 增加配置写权限；原签名、金额、UNKNOWN、不可变选择与并发单次结算断言保留。

早期合并原生批次达到既有 600 秒上限，退出 143，留下一个已停止自有集群中的唯一临时 fixture 数据库。原失败日志 `payment-public-native-02.log` 完整保留且不计为通过；之后以无网络监听的 PG16 single-user 模式核实精确目录、版本和唯一库名后删除该 fixture，复核遗留库/角色均为 0，集群仍停止，见 `native02-owned-cleanup-result.json`。最终整文件拆分批次分别以 0 退出，未修改运行器超时、hook、信号或内存上限。初始 40 项来源结果不与扩展后的 44 项重复累计。

完整 unit 类型初次检查发现新测试的 literal tuple 推断和 PgTransaction/DbClient 接口问题，保留于 `types-unit-09.log`。仅补 `as const`、导入并使用项目标准 `withTx` 包装；反向恢复精确匹配修正前 SHA，SQL 字面量、断言和生产输入均未改变，见 `payment-test-type-correction-proof-06.json`。修正后整文件 44 项已重跑通过；最终清单只计这次执行。另一次排队任务 89345 以 143 退出、日志为空，原因未确定，不记作测试执行或通过；其后新任务 34725 已实际以 0 退出并记录资源清理。

Worker unit/runtime 两套完整严格类型均以 0 退出，参数与原始日志见 `types-full-07.json`。本轮支付公共来源的源码检查点与结果见 `current-source-inputs-05.json`、`implementation-result-05.json`；这仍不代表完整 Mini 切片验收。下一步持久 payer 观察的接线地图见 `next-routine-payer-evidence-map-05.json`：必须从真实 code2Session 捕获实际 AppID，不能给旧 stamp-only ticket 或旧绑定补当前账号；首次 witness 需走完整身份 reconciliation，同事务追加，不在仅 unionid 解析出的快路径另开事务补证。观察记录保留当前 UID 与权益，不回写历史归属，也不证明旧单原始账号。

## 身份观察阶段（当前实施中）

`RoutineIdentityObservation.ts` 在真实 `code2Session` 返回并复核原成对来源后，签发实际 AppID、openid、unionid、来源戳、独立 UUID 和观察时间的独立域 HMAC。观察没有 code、OAuth Secret 或 session_key；所有字段精确校验，不读取配置或缓存来补旧字段。登录使用 900 秒上限、最多 60 秒未来容差；旧 stamp-only ticket/pending 必须重新授权。六种换码身份构造均传递这份服务端观察，续绑消费和最终身份事务再次验签。

`RoutineIdentityWitness.ts` 在完整 reconciliation 的精确 routine 绑定确认后，与既有 UID、手机号及新用户礼包使用同连接提交。此前可能仅凭 unionid 返回的 Mini 快路径不再跳过身份锁或精确绑定。门外既有身份查询仅用于避开无关的新人礼 KV 预取，不作为身份接受；门内候选若消失且未预取礼包计划，则明确重新授权，不无礼包创建用户。其他渠道既有行为保留。

`routineIdentityWitness.ts` 提供显式维护 SQL 和严格目录检查，尚未进入正式安装器或作者升级包。不可变 `routine_identity_witness` 保存完整公有观察、精确 UID/binding ID、提交时间与第二层 HMAC；主键防止同一观察被重用于另一绑定，同一原件可幂等读取，UPDATE/DELETE/TRUNCATE 均由触发器拒绝。追加要求调用方 RC/RW 短事务，在 `731666→731669` 共享门下前后复核当前成对来源；不复用已由客户财务使用的 731668。首次安装、完整运行角色 grants、目录命名空间及专用作者联动仍待闭合，任何请求都不做 DDL/修复。

公有观察后续读取可以跨过期和同 AppID 的 Secret 轮换，不要求当前配置可读。它仍验证两层 HMAC、实际有效的 UID/精确绑定和请求公开号，并把用户/绑定行锁保留到调用方事务结束。身份观察阶段结束时尚未接普通付款；后续接线见下方付款发起阶段。观察不能给旧绑定、旧用户权益或旧订单批量补 AppID，不能作为跨账号维护授权。

本阶段当前源码最终定向测试为 16 个文件、454 项通过且无跳过：普通认证/推广回归 208，签名观察 75 与真实换码入口 5；独立 PG16 中身份/会话 47、完整注册 71 和专门观察存储矩阵 48。原始记录为 `identity-regression-02.json`、`identity-unit-03.json` 与 `identity-final-native-03.log`；冻结输入为 `identity-validation-inputs-09.json`。原生整批的自有集群记录 `remaining=0` 和已停止。专门矩阵实际执行了完整 reconciliation、延迟提交故障的身份/礼包/观察整事务回滚、未知提交结果保留与幂等、同观察跨 UID/binding 重用拒绝、配置不可读的过期公有观察、目录漂移、双层 HMAC 篡改、独立维护门、真实独立 LOGIN 对此单表的精确 SELECT/INSERT 与不可变 DML 拒绝，以及新人礼 KV 可用性、候选消失和异步参数快照竞态。这不代替完整运行角色 commissioning 或作者安装验收。

首轮整批保留于 `identity-final-native-01.log`，为 165 通过、1 失败；失败项实际已被 PostgreSQL 的 `riw_observation_ck`（23514）拒绝，但测试错误地在 Drizzle 包装错误顶层断言 code。仅修正同一用例两条断言为 `cause` 内的 code 与确切 constraint_name，SQL、输入、用例数和生产文件均未改变；字节级反向证明见 `identity-check-constraint-assertion-proof-07.json`。其后整个 166 项原生批次重新以 0 退出，首轮 165 项不计入最终清单。更早的 80/47/71 项执行也保留而不重复累计。所有重型验证均经共享串行锁；原生 600 秒、单 worker、2048 MiB，以及完整类型 8192 MiB 上限保持原样。

完整 unit 类型首轮记录 `identity-types-unit-01.log` 中三处诊断：HMAC 显式 Buffer 返回注解和 Row 接口的 Record 约束。Row 改为结构类型别名，HMAC 去除显式注解；字节级类型擦除反向证明见 `identity-type-erasure-proof-08.json`。随后的 `identity-types-unit-02.log` 仍保留 Buffer.toString 编码参数冲突，因此最终使用既有支付模块同类的 `Hmac.digest('hex')`，并将两份十六进制签名都解码为字节后恒时比较；此处是编码表示的实际调整，不作为纯类型擦除宣称，完整来源逆向证明见 `identity-encoding-compatibility-proof-09.json`。域、固定 canonical 输入与返回的签名合同保持，最终 75 项独立 HMAC 对照、全部 166 项原生及 208 项认证回归均在这一实现上重验。前三轮停止记录完整保留，不计入最终用例；不能从空日志推断未达到的 runtime 步骤通过。

外部 `AuthPhonePostgresScenario.ts` 仅适配了真实观察，其旧临时 schema 与固定 public witness 的安装边界尚未闭合，本阶段未运行、不计通过。后续付款接线的只读地图为 `next-routine-payment-selection-map-07.json`：普通 resolver 单独切换不能闭合最终 provider 配置来源，必须把精确身份证明、本次逐单发起选择与商户验证的原单事实分开。

本阶段 Worker unit/runtime 两套完整严格类型均以 0 退出，实际终态与父 pipeline 的 tool 观察分开绑定，见 `identity-full-types-06.json`。本阶段 60 路径部分源码检查点与结果见 `current-source-inputs-06.json`、`implementation-result-06.json`；仍处于实施中，不代表 Mini accepted、完整运行角色安装、归属维护、普通付款人 resolver 或原单支付证据完成，也不闭合全局迁移。

## 小程序付款发起阶段（实施中，尚非切片验收）

商品、充值与付费会员的 Mini 入口不再从旧 UID/realm 裸绑定直接取 openid，也不再在来源门外登记付款或执行根连接 closure。它们传入 UID、物理订单 ID、订单域和使用 bound 连接的 SQL-only `lockOrder`；门内重新锁定精确订单，并复核未付状态、金额、归属、到期、活动拼团或会员/充值权益快照。其他微信渠道、原生 App 与线下 frozen dispatch 的既有边界保留。

`RoutinePaymentInitiation.ts` 先在短事务中读取原逐单记录；只有没有原记录时，才读取本次实际公开支付配置并在门外预检商户/平台密钥。首次准入锁序为 merchant 731664→routine 731666→witness 731669→attempt 731670→业务订单行→统一 payment boundary/provider/case。它按实际 cfg.appId 与 UID、精确 binding/openid 读取已签身份观察，冻结 UID、物理订单 ID、订单域、AppID、mchid、payer、金额、完整实际 HTTP body、公开来源戳和观察原件，并与对账登记在同事务提交。HTTP、RSA、KV 与 Queue 不在此事务内运行。

`routinePaymentAttempt.ts` 仅提供显式维护定义与目录检查，不在请求或启动时安装。不可变表 `routine_payment_attempt` 用 `(order_no,event_kind)` 分别保存唯一 INITIATION 和 PREPAY，以独立域 HMAC 保护完整内容，拒绝 UPDATE/DELETE/TRUNCATE。新发起只接受无发起、交易、事件、查询、lease、错误、终结或人工处置历史的精确初始案件；异金额/渠道/订单域案件先提交 CONFLICT，再在门外拒绝 HTTP。实际人工 RETRY 仍只重试查单，即使它清空所有可变状态，保留的处置记录仍禁止新下单。不能将旧 UNKNOWN 改成新账号付款。

已验证成功的预支付结果使用请求捕获的原密钥签成原 packet，再单独保存 PREPAY；晚到的配置轮换不会改签或覆盖原 AppID。原回执可在首次发起后的 300 秒显示期内原样重放，不依赖当前 AppID、开关、Secret、绑定或商户私钥；仍重新验证活订单归属、金额、物理 ID 与案件状态，并在最终返回前再次检查绝对到期时间。无回执、超时、签名/响应故障、过期、旧 UNKNOWN 或人工处置均保留原记录，进入原交易恢复，不自动重发、换账号或回填归属。该显示期不是微信 prepay_id 的有效期。

微信官方 [JSAPI/小程序下单合同](https://pay.weixin.qq.com/doc/v3/merchant/4012791897.md) 要求 payer.openid 属于实际 AppID，prepay_id 最多 64 字符且有自己的有效期；[查单合同](https://pay.weixin.qq.com/doc/v3/merchant/4012791859.md) 不保证 NOTPAY 返回 payer、amount 或 trade_type。因而本地 INITIATION、预支付回执和登录观察均不证明付款成功、旧单原始 AppID 或实际原付款人，也不被这里升级成回调、退款或发货授权。

跨 AppID 的归属维护、正式作者保存与完整运行角色安装仍未完成；本阶段不启用配置切换或作者页面。要求保留现有用户、UID、权益和旧订单；新鲜身份观察不能替代跨账号切换前的审计维护。本阶段当前源码的最终定向验证共 422 项、14 个文件通过且无跳过。其中三个 Mini 原生文件为 119 项（公开来源 44、逐单发起 56、实际三域入口 19）；其余为六文件支付回归 195 项及旧 App/线下 dispatch、签名查单与恢复原生矩阵。完整 unit/runtime 两套严格类型均以 0 退出。所有最终步骤在同一个外层共享串行锁中依次完成，类型 8192 MiB、测试 2048 MiB、Linux 单 worker、每个原生批次 600 秒上限未改变；三个自有原生集群均记录 remaining=0 与停止。原始结果、逐例清单及类型终态见 `payment-final-native-04.log`、`payment-unit-02.json`、`payment-offline-native-01.log`、`payment-recovery-native-01.log`、`payment-executed-cases-07.json` 与 `payment-full-types-07.json`，冻结输入为 `payment-validation-inputs-05.json`。

早期 95、114、117 项原生批次及首轮 195 项回归均保留而不累计。完整 unit 类型第一轮仅报告新测试未使用符号及 USD 负例与固定 CNY 模型注解不兼容，见 `payment-types-unit-01.log`；移除无用 fixture 代码并改为自有 PG owner 原始 SQL 构造损坏负例，未放宽模型或运行器。后续静态复核修正了最终 TTL 返回边界，以及两类 UNKNOWN→RETRY 后遗留查询/处置历史的准入缺口；最终整文件 119 项是在这些修正上重新执行。随后完整类型发现调用 KV 重载 mock 的键被推断为 string[]，保留于 `payment-types-unit-02.log`；仅在原 Set.has 断言前补字符串形状校验，原允许键与全部断言保留，精确逆向证明见 `payment-kv-call-shape-fix-05.json`。修正后整个 119 项原生批次再次执行，最终 unit 类型为第 03 次；失败 pipeline 与此前 119 项不计入最终累计。正式检查点与未完成声明见 `current-source-inputs-07.json` 和 `implementation-result-07.json`；不重复累计早期尝试，也不把本地预支付回执当作原付款证据。

这里的一次性准入只覆盖 Mini 发起路径。其他渠道的既有登记/发起路径仍需与 Mini 共同闭合，尤其不能把登记 CONFLICT 后仍继续发起的旧 caller 当成已受此门保护；本阶段不声称所有渠道合计只会发送一次 HTTP。

## 必须继续完成

1. 专用作者服务、完整权限、API/旧别名、共享保存的第五个完整互斥合同，以及通用读写旁路保护。
2. 显式维护准入：明确新安装首填、同账号恢复/换 Secret 与跨 AppID 维护的区别；归属不明历史不能自动绑定或默认隔离。
3. 作者页面、未知结果恢复与不可变回执，以及真实运行角色安装/权限检查。
4. 将已实现的 ticket/pending 消费、身份事务和 bearer 发布边界，与专用作者及数据库通用写入保护一起完成闭合验证；本轮受控消费者结果不代替作者与独立运行角色验收。
5. durable 身份观察已接普通 Mini 付款人选择与本地逐单发起；继续完成提供方原付款证据、原单账号维护恢复、原包到期后的审计重发协议、发货上传等剩余消费者，并将通知/回调、二维码、直播及邀请的已实现部分共同完成作者切换验收。新鲜凭据不证明旧用户、直播目录或订单属于当前账号；原单支付账号和旧款事实不能由当前公开号推断。
6. 本片完整类型、受影响回归、原生 HTTP/权限/并发、来源、浏览器及逐图验收。尚无本片 accepted receipt 或最终归档。

未进行生产 DDL、真实微信/SMS/设备调用、提交、推送或部署。此前接受的 App 证据目录与所有旧归档保持不变。


## 跨渠道付款发起准入（阶段 08，仍在实施中）

`PaymentInitiationAdmission.ts` 只服务于付款发起和原链接交付，不改变回调、查单与恢复的登记合同。它在 attempt 731670→业务订单行→公共 payment boundary/provider→全部案件行的短事务下，重新验证 UID、物理订单 ID、金额、未支付状态与领域条件，检查不可变 Mini 发起记录、其他渠道案件和人工处置历史，然后决定是否交付支付能力。同 provider 的金额/渠道不一致会先提交 CONFLICT 再拒绝；其他渠道已有历史则进入原交易恢复，不创建另一条 initiated case。单独执行过 RETRY、清理 mutable registry 或没有当前配置，都不能把旧 Mini 发起变成可切换渠道的证据。

普通订单、充值与会员的官方 JSAPI/H5/App 发起，以及普通订单/会员的支付宝 URL 交付已接这个共同准入。原有代客一次性 claim 之后仍做同样的回放复核。密码学预检/签名、HTTP、KV 和 Queue 均在 SQL 门外；原有非 Mini 同渠道重试合同保留，因此这里不宣称所有支付渠道总共只发一次 HTTP。

支付宝兼容 key 现在用独立域 HMAC 固定 uid、orderNo、物理 ID、金额、原 case ID/replayKey、完整原签名 URL 及 300 秒绝对期限。消费重新验证活订单与 SQL 历史，只返回原 URL；拒绝旧无 pin 缓存，不再 fallback 重新发起。认证或 SQL 拒绝保留 key；成功 DEL 是消费提交点，DEL 的等待若跨过期限，也拒绝交付过期 URL，已消费的 key 不复活。该能力不证明提供方付款成功或旧账号归属，也不能撤销升级前已交付的链接。

当前冻结源码最终定向验证为 12 文件、439 项通过且无跳过：新跨渠道真实 PG16 37、原链接真实 PG16 33、原 Mini 三文件 119，以及 7 文件普通支付回归 250。完整 unit/runtime 两套严格类型均以 0 退出。全部有效步骤在两个外层共享串行批次中完成，类型 8192 MiB、测试 2048 MiB、单 worker 和原生 600 秒上限不变；两个自有 PG16 集群均 remaining=0 并停止。原始逐例清单、类型终态及冻结输入分别见 `channel-executed-cases-08.json`、`channel-full-types-08.json` 和 `channel-validation-inputs-03.json`。初始 69 项通过执行保留而不累计；其后修复并发测试的全局事务计数观察干扰，按各请求的实际异步事务上下文检查 I/O，并补 DEL 耗时跨过期限的生产修复与第 70 个原生用例。首个最终批次中普通回归为 249 通过、1 失败，原因是原静态 readiness 接线断言仍查找旧登记函数名；仅将该字面量更新为共同准入函数，保留原断言数量和调用顺序，见 `channel-readiness-route-assertion-proof-08.json`。该批次和实际父工具 exit=1 均保留。生产代码、原生测试及 runtime 源码没有变化，因此保留已通过的 70 项与 runtime 类型；另一个共享锁批次整批重跑 250 项回归、119 项 Mini 和当前完整 unit 类型，输入连续性见 `channel-validation-input-continuity-08.json`，不从失败 pipeline 推断未执行步骤通过。

共同准入要求不可变 attempt 存储已正式安装，缺表或目录/权限不完整一律拒绝交付；本阶段仍未完成正式安装器与完整运行角色 commissioning，不能据此部署。余额、零额和本地支付尚未纳入本阶段外部能力互斥，已交付的旧链接、原付款账号证据、审计恢复/重发、归属维护及完整作者切换验收也未闭合。继续保留现有用户、权益、UID 和旧订单；本地 INITIATION/PREPAY、当前配置和新身份观察均不得升级为原付款事实。本阶段源码检查点为 `current-source-inputs-08.json`，正式进度为 `implementation-result-08.json`，仍不代表 Mini accepted 或全局迁移完成。


## 本地付款准入（阶段 09，仍在实施中）

本阶段在普通商品及会员的新本地入账前增加 `LocalPaymentAdmission.ts`：先取有界、非阻塞的 attempt 731670 共享维护门，再锁定实际业务订单；完整检查不可变 attempt 目录与历史、公共 payment boundary、全部案件行及人工动作后，才允许余额、积分、权益、paid、发票、outbox 和审计写入。已有 Mini INITIATION/PREPAY、任何非初始案件或真实 RETRY 动作都要求先核对原交易；清理 mutable registry 不能恢复本地扣款权限。正常零额订单仍可入账；零额代客订单保留原 weixin/alipay 标签，但固定走完整本地 guard，不被解释为提供方付款事实。所有新本地入账拒绝调用方填入 provider tradeNo；原已付款回放先于此新检查。

服务端已验真 callback/query 使用固定 `applyProviderStoreOrderPayment` / `applyProviderMembershipPayment`，不由 HTTP payType 或 JSON 标志选择。旧已付款及缺失订单分支不做新的完整目录检查，保留既有回执；本地外层事务仍使用有界共享维护门。管理门店、客户财务、次卡/普通收银及供应商外层入口已放置先于业务资源锁的共享门，嵌套 core 仍用同一连接。本段只报告接线及定向结果，不声称这些外层路径的完整原生业务套件已全部适配或验证。

最终同一串行 pipeline02 的 16 文件、566 个唯一用例通过且无 skip/todo：六文件真实 PG16 265（含本地准入 76）、会员已验真查单原生 35、八文件支付回归 261、静态路由回归 5；完整 unit/runtime 两套类型第 02 次均以 0 退出。有效输入为 `local-admission-validation-inputs-04.json`；原始逐例清单与类型见 `local-admission-executed-cases-09.json` 和 `local-admission-full-types-09.json`。两自有 PG16 均 remaining=0 并停止。测试 2048 MiB、类型 8192 MiB、单 worker 和原生 600 秒上限保留；没有真实 provider 调用。

失败及早期结果完整保留，不累计：native01 为 8 通过/62 失败，新增快照误把无 id 的 `other_order_status` 按不存在字段排序；修为真实稳定字段，保留精确逆恢复证明。native02 为 67 通过/3 失败，local-first 测试误要求已付款幂等请求抛错；仅改为精确原 paid 状态、无新支付参数，继续断言全状态不变、零 attempt 与零 HTTP。首 pipeline01 原生 259/35、路由 5 通过，但完整 unit 类型以 2 退出，只有两个 `outcome` 的 union Promise 类型推断诊断。随后补显式类型参数和零额标签/非空 tradeNo 六例，并重跑完整最终 pipeline02；早期 unit01、runtime01、259/35/5 及 70 例尝试均不计最终累计。原件、patch 与逆向证明仍独立保留。

这是 guard 实现与定向验证，仍为 in_progress。正式 witness/attempt 安装器、完整 app/admin/custom 角色计划与审计、所有余额/现金外层原生业务套件及 nested 全链路尚未闭合；旧大 fixture 未偷偷补 raw ledger 或 grants。新测试两例 restricted LOGIN 只证明其自有 fixture 的显式最小权限，不是正式 runtimeBusinessCommission。case 的 `FOR UPDATE` 所需 UPDATE 权限也不能借测试中的 `UPDATE(id)` 裸授权推广到生产；SELECT-only custom 角色须用已审查锁能力或证明其既有权限合理，并显式评估 action 读取权限。

下一阶段 10 应按 `next-routine-payment-runtime-install-map-10.json` 及其 `-update-01.json` 后继，完成显式维护安装、完整目录/ACL 检查、正式角色最小权限与锁能力，再让旧 fixture 使用实际安装协议并验证真实独立 LOGIN 和更广本地业务回归。当前公开号、身份 witness、INITIATION 或 PREPAY 不能认领旧用户、旧单或原付款账号；归属维护、原账号恢复/退款/发货、作者保存/UI 与完整切换验收仍待继续。源码检查点 `current-source-inputs-09.json` 及结果 `implementation-result-09.json` 不代表 Mini accepted、全局迁移完成、生产部署或真实 provider 验收。


## 小程序存储安装与本地锁能力（阶段 10，仍在实施中）

本阶段增加显式维护安装器 `routinePaymentRuntime.ts`，只在调用方拥有的 PG16 维护事务内按 witness 731669→attempt 731670 取得排他门，将两个不可变 ledger 与精确具名角色授权共同提交。仅 absent 或目录、owner、ACL 完整匹配的状态可继续；owner-only 原件可补固定授权，部分 namespace、额外角色/权限、grant option 或漂移拒绝而不修复。App 仅有 witness/attempt SELECT、INSERT，Admin 与显式 local 仅有 attempt SELECT，另补必要 action SELECT；旧行、UID、权益和订单均不重分配。独立 app/admin 完整审计仅在精确 addon 验收后从固定 283 表增加到 285 表，历史 base plan 保持不变。

`localPaymentCaseLock.ts` 使用固定 SQL、受限无成员/无额外对象所有权的 NOLOGIN owner 和精确 EXECUTE ACL，向真正 SELECT-only 的 local LOGIN 提供同一事务的 case 行锁；运行角色不获得裸 UPDATE(id)，owner 也不能拥有或读写其他业务对象。保留数据库隐含的 PUBLIC invoker 执行权限；固定函数体不调用这些业务函数，并拒绝额外显式函数授权、其他 definer 或 default 能力。请求不执行DDL或自动补权，SELECT-only主体仅调用已完整审计的锁能力。已有获准 case UPDATE 的 App/Admin 及现行完整客服计划继续直接 FOR UPDATE；只有实际无任何 case UPDATE 的角色才走独立审计的 capability，之后仍检查完整 attempt、全部案件、真实 action/pristine 历史与期限。

当前冻结输入 `runtime-install-validation-inputs-07.json` 的最终同一外层串行 pipeline02 为 8 文件、260 个唯一用例通过且无 skip/todo：installer 22、案件锁与真实 guard fallback 47、完整 app/admin addon 1、本地准入 76、跨渠道 37、兼容 key 33、无 addon 原生 base 30、固定 plan 单元 14；完整 unit/runtime 两套严格类型均以 0 退出。两自有 PG16 集群均 remaining=0 并停止。实际外层 tool 终态与子进程 terminal 分开绑定；原始逐例与类型记录为 `runtime-install-executed-cases-10.json`、`runtime-install-full-types-10.json`，部分源码检查点与结果为 `current-source-inputs-10.json`、`implementation-result-10.json`。测试 2048 MiB、类型 8192 MiB、单 worker 与原生 600 秒上限保持，没有真实 provider 调用。

早期两轮 installer、两轮 formal 结果及实际 tool 观察均保留不累计。首 installer 的 19 项失败为维护超时配置误把 interval 文本当作 GUC 时长；修正后直接读取 pg_settings 毫秒值并保留更低调用方上限。首 formal 的独立角色审计与 witness/首余额路径已到达，但后续复用已消费 cart 导致 fixture 失败；改为每笔真实独立 cart，不以旧轮部分成功代替最终整文件结果。不得把任何失败轮未执行的步骤记成通过。首个完整 pipeline01 的 unit 类型以 2 退出，唯一诊断是测试将 raw Drizzle transaction 传入要求项目 DbClient adapter 的登记函数；仅换成既有 withTx(createContainerFromDb(ownerDb), callback)，原真实 SQL 与断言保持，见 runtime-login-transaction-type-fix-10.json。该 pipeline 其余四步未执行、不记通过；最终完整 pipeline02 在 inputs07 上重跑。

本阶段实现并定向验证了 standalone installer、app/admin 完整 addon fixture 及锁能力，不等于所有 manager/customer/supplier 自定义完整角色、旧余额/现金大套件与 nested 全链路或真实部署已闭合。固定 manager 仍需完整 profile/auditor 的精确 addon 与 capability 接线；当前继承 App 的完整客服及供应商 fixture 已有 case UPDATE，应保持 approved direct 锁，而非盲增 definer。后续具体文件与真实 LOGIN/业务门禁见 `next-routine-local-runtime-commission-map-11.json`。归属维护、原账号付款/退款/发货事实、通用 writer 闭合、作者保存/UI 与完整切换验收仍待完成；本阶段不构成 Mini accepted、全局完成或生产部署，不改变既有 accepted App 锚点。


## 小程序本地角色接线（阶段 11，实际定向验证，仍在迁移中）

固定 Manager 的完整旧 profile 通过显式 prior→固定 successor 接入 routine witness/attempt addon 的精确全局绑定与 SELECT-only 案件锁能力；不扩张案件 UPDATE(id)。已有 Manager 使用独立维护 forward，fresh Manager 可在已有 raw addon 与历史行下，以显式第四参数在同一事务内完成 NOLOGIN 完整基线审计、LOGIN 与 forward、最终完整 ready 审计。维护锁顺序为 731669→731670→731812，保留更低调用方期限；错误 prior/owner、后半失败与凭据碰撞均不自动修补或旋转既有凭据。请求不执行 DDL 或自动补权。

客服 financial/writeoff/cashier 及供应商 fixture 在 fresh owned PG16 上使用正式 standalone installer，明确绑定独立 companion App/Admin LOGIN 与实际 local writer；后继 fixture 复用同一 binding，不给通用 fixture 裸补 raw ledger 权限。原获准 case UPDATE 的主体继续直接行锁，不盲增 definer。供应商每次请求保持同一固定角色但使用独立真实 backend，包含嵌套 NOWAIT 锁竞争与关闭清理。该 addon/定向业务证据不等于这些 custom 主体的全部 base profile 已正式审计或实际部署。

本轮旧客服宽回归暴露此前通知 pin 的兼容缺口：真实拒绝通知新增 routineAppId，而旧 CustomerWorkFinancialService 对整 payload 仍按原五业务字段哈希比较，导致合法拒绝与数量释放整笔回滚为 rollback-rejected。这是旧 pin 接线与严格消费校验的不兼容，不称为 fixture 错误。补录修复前的两原服务字节均与已接受 App 原物理 inputs 完全相同，通知 pin 实现在 before11 已存在。已补充独立 before-fix 两源物理快照；最小修复仅在 refused 分支以 captureRoutineNotificationAccount 复用事件既有 pin/absence，UID0 保持原 guest 五字段，整 payload 哈希、金额/身份与数量断言不放宽、不按当前配置改绑历史事件。新增真实合法 pin 拒绝与两个 SQL BEFORE INSERT 污染负例，证明错误金额或额外字段仍整事务拒绝；路由 pin 不是原付款 authority。

最终运行前输入 `runtime-role-validation-inputs-10.json` 原有 168 份源码保持不变。最终清单预检发现漏列三个已执行的旧回归 test，首次 file-only checkpoint 在首写屏障前拒绝，未写最终产物；以 `runtime-role-late-test-coverage-11.json` 诚实补录运行后捕获的三个原测试副本，均逐字匹配 2026-10-26 与已接受 App 的旧物理原件，原件与 live mtime 都早于适用执行，未改源、未伪称运行前冻结或重复运行测试。最终源码覆盖 168+3=171 份。显式选定已完整成功的 manager-final05、regression-native05，customer-final、拆分为两个预算内完整文件组的旧客服回归与两套完整类型来自串行 recovery pipeline06，共实际 286 项唯一用例、15 文件通过，无 skip/todo/失败；原始展开数来自 verbose 逐例与 summary 双向核对，分布为 manager-final05=15、regression-native05=83、customer-final06=20、customer-regression-a06=114、customer-regression-b06=54。09→10 对既有 165 路径只加 runner 的两个新 test 白名单字面量，其余逐字保持；另纳入被修复 Customer 服务、只读 mature Refund 依赖与新测试。所选旧 manager/raw 结果的路径和完整输入不因 Customer-only 修复而被重算；04 的 customer17 和 05 的 Customer partial 165 项均不累计。完整 unit/runtime 类型均 exit0 且空日志；五个选定 owned PG16 runner 均 remaining=0、停止且无 postmaster.pid。05 父轮实际 99991/1 与 recovery 实际外层终态分别绑定，不包装为两轮父全通过。逐例、类型、171 源码物理副本与结果分别见 `runtime-role-executed-cases-11.json`、`runtime-role-full-types-11.json`、`current-source-inputs-11.json`、`implementation-result-11.json`。测试 2048 MiB、类型 8192 MiB、单 worker 与原生 600 秒上限保持；没有真实 provider 调用。

所有早期失败与定向 probe 原件、逐例、实际 tool 观察和资源清理完整保留且不累计。manager-native01/02 为早期 fixture 失败；probe03 失败、probe04 仅定向 1 pass/9 skipped，不能当作整文件通过。customer-native01/02 各 14 pass/3 fixture failure，随后改用真实 registrar 生成 replay key 并从固定 source models 显式安装 canonical case/action indexes，断言不削减。pipeline03 只执行 unit 类型并以 2 退出，三个 TS2554 为混用 Workers/Node Buffer 的带参 toString；三个测试凭据生成点改为既有 Array.from 十六进制转换，后续步骤未运行。pipeline04 的 customer17 成功后，Manager 为 14 pass/1 fixture failure：missing-capability 夹具订单号超 varchar32，尚未到拒绝断言，独立前缀缩短为 mgr_。pipeline05 的两完整 manager/raw 文件组成功后，旧 Customer 回归 165 pass/3 failure 为上述真实通知兼容缺口；该轮两类型没有运行，不造通过 terminal。recovery 完整重跑受影响 Customer 文件组及两类型，并完整保留05失败，旧准备 finalizer 从未执行。

保留既有 UID、用户、权益与旧单；跨 AppID/账号切换必须先完成可审查归属维护。本阶段不是 Mini 作者保存/UI 启用，不闭合所有 custom 正式 profile、所有 outer/nested 业务、原账号付款/退款/发货事实或通用 writer；witness、INITIATION/PREPAY 与当前配置不能升级为旧单原付款 authority。归属维护与实际部署仍未完成，不构成 Mini accepted、全局迁移完成或 commit/deploy，既有 accepted App 两锚点保持。


## 小程序独立客服财务角色（阶段 12，实际定向验证，仍在迁移中）

13 条现有 financial 路由在完整 UserJWT 鉴权后使用独立 HYPERDRIVE_CUSTOMER_FINANCIAL，缺失或与 App/Admin/Manager 共用绑定、相同连接串及错误真实角色均拒绝。独立 max1 会话实际验证 PG16 current_user/session_user/backend 固定身份与受限角色属性，成功或失败均关闭并恢复原 container；请求不执行 DDL、grant 或 fallback。middleware 不以当前客服资格阻断原 owner UUID 回执，新的业务操作继续使用 service 锁下 scope。

固定 cinashop_customer_financial_v1 使用完整既有源码 profile、严格全目录/列/ACL/序列来源、三个固定 capability 与显式 routine prior→successor 审计。fresh commissioning 在同一维护事务中完成 NOLOGIN 全基线审计、独立 LOGIN 与最终完整审计；碰撞不旋转凭据，错误 prior、漂移、锁竞争及调用方回滚原子拒绝，保留更低期限。源码明示的 serial/identity 与独立 pgSequence 绑定保持唯一校验，不学习服务端额外序列。native02 的实际 final JSON 只有 user capability ownerSafe=false，唯一 schema authority 为当前 session 的 pg_temp_5 CREATE 元数据；实际只读 OID 观察确认它等于 pg_my_temp_schema()。customerUserCatalogLock.ts 仅在 namespace CREATE 谓词中排除该精确当前临时 OID；所有 namespace ownership、其它 schema CREATE 与外部 definer/data/sequence 检查保持严格，没有按 pg_temp 名称前缀豁免。

native05 的实际完整角色审计与 fresh commissioning 已通过，但 FinancialAvailability 的旧 customer-work pricing envelope 未接入该完整 profile 合法的 product/user taxonomy capability，导致真实 HTTP writes/confirm_offline readiness 拒绝。checkoutPricingLock.ts 只对 public、customer-work 且实际 PG16 current_user=session_user=backend=固定 financial role 复用现有 ordinaryScope 的两 capability 完整 body/owner/ACL、taxonomy 只读与调用者 EXECUTE 审计；只有真实 ready OID 可纳入，最终仍要求两 capability 均 ready，未知 definer 或缺 EXECUTE 继续拒绝，其他角色与 scope 语义不变。新增实际 pricing ready、未知 definer 和撤销 taxonomy EXECUTE 后 pricing=false/fullaudit 缺函数、精确恢复后二者 ready 的完整文件证据只按选定 raw 结果计数，不以候选 source 的预期展开数声称通过。

显式选定完整文件组共 260 项实际参数展开用例、7 文件通过，无失败、skip/todo；展示名称共有 259 种：旧 Manager auth 的 it.each([undefined,invalid-jwt]) 两参数共用一个未带格式占位符的标题。只对该已固定源 6235B/SHA de812f6499877a760cf176509388a2919df83d99022b0da6c6a01d63a3b9741d 的恰好两次实际 raw 记录允许展示碰撞，保存 display_name_occurrence/raw_line；不从行序推定具体参数值，其他任何重复均拒绝。逐例与原始 summary 双向核对，分布为 {"unit09": 44, "native09": 33, "financial-regression09": 87, "user-profile-regression09": 81, "manager-auth09": 15}。两套完整 unit/runtime 类型实际 child0、actual outer0 且空日志；每个选定 owned PG16 runner 均 remaining=0、STOPPED 且无 postmaster.pid。测试 2048 MiB、类型 8192 MiB、单 worker 与原生 600 秒上限保持。逐例、类型、物理源码与结果见 customer-financial-executed-cases-12.json、customer-financial-full-types-12.json、current-source-inputs-12.json、implementation-result-12.json。

当前运行前 freeze 覆盖 674 路径，与 live 逐字一致；before12 仅含原声明的 208 路径，其中 202 份原物与 6 个创建前 absent 记录完整保留。定价生产修复另有 customer-financial-pricing-before-fix-12.json 的独立物理原件，明确作为 1 路径补充 delta 基线，不冒充全阶段初始 before；其它新增 model/旧回归/SQL 等依赖为 coverage expansion，未冒充 before 原件或新增 source delta。native05 原诊断旧分类原件不动，另以 customer-financial-native05-classification-supplement-12.json 澄清 18 失败为 3 个 HTTP readiness、1 个 table-restoration、14 个后续污染 cascade，不重复或隐藏失败。table 漂移恢复已保留源码获准 UPDATE(online)，没有新增权限。所有早期失败及未执行步骤保留，pipeline08 的 types2、unit 与 native 全部通过后，根代理将普通 Manager auth wholefile 误放 maintenance 组，运行器在创建 PG 前按既有白名单拒绝；没有测试 case、cluster 或 cleanup 可虚构。checker03 把它拆为普通 NOSUPERUSER/CREATEDB owned PG16 边界回归，financial2/user2 继续维护模式，runner 白名单保持仅原定2 literal 新增。Manager auth 使用实际 UserDAO、受控会话工厂，不升级为实际 Manager LOGIN 证明。该失败 parent 的所有先前成功均只保留历史。失败/部分成功/重复尝试不累计：

- `customer-financial-financial-regression-08-terminal.json`: exit1，{"passed": 0, "failed": 0, "skipped": 0, "todo": 0}；Actual runner assertion at schema-maintenance allowlist before any PG cluster or cases started. Manager auth wholefile was incorrectly grouped with schema suites; no cases/identity/cleanup invented, no passing test counted. Checker03 splits ordinary manager from unchanged maintenance finance2/user2. Following user regression step never executed.
- `customer-financial-native-01-terminal.json`: exit1，{"passed": 0, "failed": 0, "skipped": 23}；Actual setup failed before cases;23 skipped. Initial user capability final verification refused; no business success claimed.
- `customer-financial-native-02-terminal.json`: exit1，{"passed": 0, "failed": 0, "skipped": 28}；Actual setup failed before cases;28 skipped. Diagnostic-only SQL wrapper retained original predicates; JSON isolated exact current-temp schema CREATE ownerSafe metadata issue.
- `customer-financial-native-03-terminal.json`: exit1，{"passed": 0, "failed": 0, "skipped": 31}；Actual setup failed before cases;31 skipped. Official user capability installer passed after exact-temp fix; prerequisites then refused explicit kefu sequence ownership source binding.
- `customer-financial-native-04-terminal.json`: exit1，{"passed": 0, "failed": 0, "skipped": 31}；Actual setup failed before cases;31 skipped. Fixture user password exceeded varchar32. Two types never executed. Later LOGIN ordering correction was static review, not reached by this execution.
- `customer-financial-native-05-terminal.json`: exit1，{"passed": 13, "failed": 18, "skipped": 0}；Actual31 cases:13 pass/18 fail=3 HTTP pricing readiness+1 table drift restoration+14 following contaminated before-audit cascades. Full role commission succeeded inside a failed file; no partial accumulation. Classification clarification retained. Types not executed.
- `customer-financial-native-06-terminal.json`: exit0，{"passed": 33, "failed": 0, "skipped": 0}；Actual33 pass child0, but actual parent27177 exit2 due unit test full-type URL mismatch; superseded by final consistent-source pipeline. No partial accumulation.
- `customer-financial-native-08-terminal.json`: exit0，{"passed": 33, "failed": 0, "skipped": 0}；Actual33 pass child0; same source as current freeze08, but parent58059 exit1 due later harness grouping refusal; retained only, no partial accumulation.
- `customer-financial-types-runtime-08-terminal.json`: exit0，{}；Actual complete runtime types child0/empty log, but parent58059 exit1 due later regression-group runner preflight refusal; retained only, no partial accumulation.
- `customer-financial-types-unit-06-terminal.json`: exit2，{}；Actual complete tsconfig exit2 TS2769 only at auth unit test readFileSync(global URL); explicit Node URL import retained as minimal fix. Runtime types step not executed.
- `customer-financial-types-unit-08-terminal.json`: exit0，{}；Actual complete types child0/empty log, but actual parent58059 exit1 due later regression-group runner preflight refusal; retained only, no partial accumulation.
- `customer-financial-unit-01-terminal.json`: exit1，{"passed": 43, "failed": 1, "skipped": 0}；Actual 43 pass/1 fail: unit no-DDL regex matched CREATE inside a SELECT privilege literal. Assertion correction retained; failure not counted.
- `customer-financial-unit-02-terminal.json`: exit0，{"passed": 44, "failed": 0, "skipped": 0}；Actual 44 pass in an earlier source state. Later explicit Node URL import changes the test file; no old-state reuse or duplicated count.
- `customer-financial-unit-06-terminal.json`: exit0，{"passed": 44, "failed": 0, "skipped": 0}；Actual44 pass child0, but actual parent27177 exit2 due full-type Node/global URL mismatch; superseded by complete successful final pipeline. No partial accumulation.
- `customer-financial-unit-08-terminal.json`: exit0，{"passed": 44, "failed": 0, "skipped": 0}；Actual44 pass child0; same source as current freeze08, but parent58059 exit1 due later harness grouping refusal; retained only, no partial accumulation.

新增 native 使用 owned PG16 正式 capability installers、实际 App/Admin prior routine binding 与独立 fixed financial LOGIN；fixture 的 prior App/Admin 仅具备本测试所需 JWT lookup/全局 raw-binding 权限，不冒充已完成全部正式 App/Admin profile 迁移。

冻结 06 在任何执行前发现遗漏本轮 pricing 生产文件，作为 preparation-only 原件保留；pipeline06 实际使用补齐本地依赖的 freeze07。该 parent 实际 exit2，44/33 的局部成功仅为历史。freeze08 与07路径集相同，唯一改动为测试显式导入 Node URL；pipeline08 的两 types 与44/33测试通过后，旧回归编组在PG启动前被运行器拒绝。最终仅选择与 freeze08 逐字一致的完整成功 pipeline09；runner未改，Manager auth 单独普通非超级用户 owned PG16 wholefile，financial2/user2仍为维护套件。prepared pipeline07 从未运行，无伪造 terminal 或成功声明。

完整旧 financial/catalog/manager 以及 user catalog/work 回归以 whole files 串行运行；只有 raw 中实际完成且 child0/actual parent0 的实际参数展开案例计入当前阶段。新增快照覆盖不冒充新增生产改动；source delta 由208声明基线与1独立before-fix定价基线共同确定。

回执、INITIATION/RETRY denial-only 历史、配置与 witness 均不被提升为历史 provider 付款成功或跨 AppID 归属证明；本阶段不执行外部支付、短信、设备操作或生产维护。

保留现有 UID、用户、权益与旧单；跨 AppID/账号切换必须先完成可审查归属维护。本阶段只完成该独立角色与所选真实路由/回归证据，所有 custom profile、全部 outer/nested 业务、归属维护、原账号付款/退款/发货事实与实际部署尚未全部闭合。witness、INITIATION/PREPAY 与当前配置不能升级为旧单原付款 authority，不构成 Mini accepted、全局迁移完成或 commit/deploy，既有 accepted App 两锚点与阶段 11 原件保持。


## 阶段 13：独立 Financial 手工退款权限扩展（2026-10-29）

本阶段增加显式维护 forward：在完整基础 Financial 角色、原 routine binding 与 canonical manual 协议都已验收后，原子授予最小手工退款增量。完整角色审计支持显式 manual addon；未声明 addon 时仍严格核对原基础权限。促销记录删除仅经已核对 source／owner／OID 的函数执行，Manager 历史只读，Financial 不获得 Manager EXECUTE。失败、部分授权、漂移或锁竞争拒绝，不自动修复或换凭据。

本轮实际成功父会话及全部子检查见 implementation-result-13.json：305 项实际展开案例、9 个完整测试文件、两套完整 TypeScript 检查通过。最终只统计完整成功 pipeline03，不累计历史失败或局部成功。每个原生 PG16 实例均确认 remaining=0 且 STOPPED。

真实正式角色业务正例限会员 UID11、本客服 offline 收款、原 paid consumer、正金额及零金额退款，包含回执重放和客服资格撤销后的归属恢复。拒绝新请求保持 HTTP 200 与持久 rollback-rejected／410000 回执，除唯一新增拒绝行外业务快照不变。

旧现金与导入 PHP 现金 wholefile 属原部分角色回归，不能代替固定角色完整现金来源验收。Manager／Admin 原线下付款来源、cashier 原现金来源读取、UID0 正式角色矩阵和旧 offline-origin wholefile 适配留待后续；未验证的 canonical fixture 探索已归档并逐字恢复。completeServiceCoverageVerified 与全局迁移完成仍为 false。

保留现有 UID、用户、权益和旧订单；跨 AppID／账号切换须先完成归属维护。本阶段没有重分配旧证据，没有生产维护、外部调用、提交或部署。既有 accepted App 与阶段12结果／独立审计原件保持。


## 阶段 14：原付款来源读取与完整角色共存（2026-10-29）

本阶段实际选中 316 条通过用例、9 个完整测试文件和 2 套完整 TypeScript 检查。每个选中父进程均实际成功，全部重验证串行执行并绑定各自预执行的物理输入；历史失败及未选中的局部通过不累计为最终通过。

Financial 新增显式维护 forward，仅授予四个不可变原付款来源表的 SELECT。App 另有显式单表扩展，仅允许查询收银 origin 以隔离代客订单命名空间，不允许读取收银 cart／payment、执行来源 validator 或写来源记录。完整 App、Admin、固定 Financial、固定 Manager 与独立 Cashier 使用不同的真实 LOGIN；共享礼品权限例外需显式声明并先通过完整 source profile、目录、owner、OID 和有效 ACL 检查。缺少声明、部分授权、来源漂移或额外权限均拒绝，不自动修复、换凭据或重分配历史。

原退款整文件保留全部 58 个场景，并修正拒绝断言对 error.cause 链中原始 SQL 42501 的漏检。实际 Manager／Admin 线下收款、会员 UID11／游客 UID0、正金额／零金额、原 App paid consumer、三代发票、撤权保留历史、真实 COMMIT 后丢失响应恢复及 Cashier 来源尾部场景均以选中原始日志为证。共存测试还验证最小读取、幂等无 XID、调用方事务回滚、门锁和表锁竞争、委托权限及共享函数漂移。上述结果限已执行的本地场景，不代表所有 Cashier 继承的条件写边界或全部业务已验收。收银真实 HTTP 路由的独立连接绑定仍未完成，当前直接服务调用和权限探针不覆盖该边界。

新核销安装使用专属主键名 customer_writeoff_operation_request_pkey，与 Work 的 cwo_pk 共存。完整实测旧目录 8739570c… 与新目录 aed6ade4… 均可只读识别；旧孤立 Writeoff 仍占用 cwo_pk 的库不能自动安装 Work，须另行审计维护。安装新增 addon 后，未声明该 addon 的旧审计及后续维护调用仍严格拒绝，不能据此声称所有旧调用已自动兼容。

最终物理检查点共 711 条源路径，由五层真实分时捕获组成；晚补的未修改 gift 回归文件不追溯为原 704 路径或 offline11 的预执行输入。offline11 的 710 条共有源逐字等于最终对应源。阶段 13 对 canonical factory 缺席的结论保持为当时事实，本阶段才新增实现。代码变更为 24 个文件，另仅向本 MiniDoc 追加本节；具体证据、差异和独立预发布核对见 implementation-result-14.json。

保留 UID、现有权益与旧订单；跨 AppID／账号切换仍须先完成可审计的归属维护。当前配置、登录、witness、INIT 或 PREPAY 均不代表原付款成功。归属维护、原账号恢复、全部消费者和条件写边界、所有渠道、shipping 与全局迁移仍未完成，继承的 20 个范围标志均保持 false。本轮没有生产 DDL、真实支付／短信／设备调用，也没有 commit、push、PR、合并或部署。


## 阶段 15：Cashier 继承条件写约束（2026-10-29）

本阶段实际选中 211 条通过用例、7 个完整测试文件和 2 套完整 TypeScript 检查，来自两次实际成功、串行且不重叠的父进程；全部绑定同一份预执行 inputs03。阶段 01 只有类型失败且未运行 native；阶段 02 的 102 通过／4 失败仅保留为历史，不累计为最终通过。逐例结果和真实父子进程见 implementation-result-15.json。

显式维护 forward 为独立完整 Cashier LOGIN 扩展原有五个 invoker guard，绑定角色名称和实际 OID、数据库名称和实际 OID，并断言 current_user、session_user 与实际 backend。改名、同名换 OID、代理 SET ROLE 和缺席绑定均拒绝；quoted 混合大小写改名也使用 pg_roles 精确文字查 OID。默认未声明绑定仍输出原有 App／Admin body，不按角色前缀或相似权限放行。

本地原生用例检查 24 个可获锁表的真实行、批准的 counter、staff／supplier／登录元数据语义、schedule ID 和 agent 共享／独占 fence；中央目录核对 37 个 guard 绑定及 3 个 coupon transition hook，拒绝重载、未知 sibling、外表反向挂载、owner／ACL／body／trigger 漂移。forward 保留 function／trigger OID、权限、凭据与业务行，支持调用方回滚、门锁／表锁竞争和无 XID 重放。完整 App／Admin 审计依赖显式 peer 声明；既有 Admin menu 端口只在完整 staff 源码与实际 OID 证明后兼容。

最终物理检查点含 4,042 条路径：原始 715 层为 711 份原件与 4 条当时缺席声明，另有晚捕获的 3,327 份未修改既有源。晚层不冒充编辑前原始 baseline，合计 4,038 份旧原件；源码差异精确为 14 个文件，另仅向本 MiniDoc 追加本节。wrangler.toml 不在该冻结清单中，本轮没有修改 Env、wrangler 或启用新 HTTP 绑定。

生产 18 条 second-card HTTP 路由、6 条表单图片路由的完整 addon／独立会话、真实 member／guest × 正／零金额作者→App 消费者→Financial 退款矩阵仍待后续实现和验收；表单图片权限必须作为显式 addon 传播完整审计、GiftPeers 与维护 forward，不能以无表单最短路径替代。普通 Cashier 路由不随宽通配符切换。规划文件仅为后续工作依据，不计测试通过。Financial、Product、User、Work 及全局业务迁移也未因本局部约束检查完成。

保留 UID、现有权益和旧订单；跨 AppID／账号切换仍须先完成归属维护。继承的 20 个范围标志，以及 conditionalWriteSemanticsVerified／completeServiceCoverageVerified 均保持 false；没有 commit、push、PR、部署、真实 provider 调用或生产 DDL。本归档器与测试实现由同一参与者准备，不能自称独立实现审计；独立预发布证明是另一审阅者在两次父进程真实完成后提供的固定输入。


## 阶段 16：Second-card Cashier 独立 HTTP 会话与表单图片权限（2026-10-29）

本阶段实际选中 457 条通过用例、9 个完整测试文件和 2 套完整 TypeScript 检查；两次实际成功的串行父进程均绑定同一份执行前 inputs07，7 个原生 PG16 完整文件与 2 个直接单元完整文件均无失败或跳过。逐例 LF 原始行、实际父子进程、资源和清理证明见 implementation-result-16.json。

精确 18 条 second-card 路由在完整 App UserJWT、生产 token bucket、账号状态及密码校验后开启独立 Cashier 会话；16 条 ordinary Cashier 及 context 等既有路由保留原边界。可信 Env 身份来自完整维护回传的数据库名／OID 与角色名／OID，实际 current_user、session_user、backend 及数据库逐项相等才交付容器。四类绑定别名、独立 DSN 实际连错角色、同名换 OID、改名、缺少维护身份均关闭并受控拒绝；成功、解析失败、业务异常与关闭失败均先恢复 App 容器，关闭句柄幂等。中间件不以当前客服资格总闸阻断原 UUID 的合法恢复。

显式 owner 安装既有表单图片协议后，正式 forward 要求完整 conditional Cashier、Financial、Manager 和 App reader 声明，只授予两张台账的 SELECT／INSERT、13 个批准 UPDATE 列与 3 个 invoker 函数 EXECUTE；所有当前完整角色审计、GiftPeers 与条件 guard forward 显式传播 formImages。真实原生检查覆盖回滚、6 道维护门锁、表锁、窄列 SQLSTATE42501、目录／owner／ACL／default／重载／反向 trigger 漂移及无 XID 重放，不改角色、凭据或历史业务行。

本地生产控制器矩阵以真实已登录正 UID 操作者，覆盖 member／guest × 正／零金额 × 无表单／文本／图片共 12 组：Cashier 创建与现金原始来源、实际 App 队列消费者完成、Financial 原支付来源退款及同 UUID 回执／重放。另检查图片取消、两个 abandonment、私有签名和真实创建／支付／上传 COMMIT 回包丢失恢复。本证据不扩张为真实支付 provider、全部并发与故障组合或全局业务迁移完成。

实际发现 App context 的城市一致性读取依赖超出原 SELECT；修复按真实三张来源 SELECT 完整性决定是否读取，缺席或部分权限保留原拒绝标记，未给 App 扩权。旧 inputs05 的 context500 原始日志只有一般错误，不倒填 SQLSTATE；最终 inputs07 用例另直接观察原权限拒绝及完整授权 Financial 的城市事实读取。最终物理检查点 4,048 条路径，原 baseline 为 4,042 份原件与 6 条当时缺席声明；源码精确变化 16 文件，本 MiniDoc 仅追加本节。

inputs01 未执行检查；02／03 类型失败，04 的单元通过及图片权限 71 通过／1 失败，05 的 HTTP 22 通过／1 失败均只保留历史且不累计。06 实际 HTTP 24 例为 22 通过／2 失败，失败发生于原生 fixture 重置的 5 秒 statement timeout（原始 SQLSTATE57014），另有未初始化 spy 的清理噪音；修正记录将旧口述 31 表纠正为实际 33 表。保留完整 33 表集合与同一事务、owner／外部 FK 检查，按实际 FK 无向连通分量分组 TRUNCATE／RESTART IDENTITY，不使用 CASCADE、不增 timeout，并在重置前开启既有 provider spy。超时更深原因未获证明。另保留首次06启动实际143且没有 checker 执行原始输出佐证的记录；该记录不能证明 Python 是否启动或退出原因，不能记作成功父进程或已执行用例。

保留现有 UID、权益和旧订单；跨 AppID／账号切换仍须先完成归属维护。继承的 20 个范围标志，以及 conditionalWriteSemanticsVerified／completeServiceCoverageVerified 保持 false。Financial、Product、User、Work 及全局迁移尚需继续验收；没有 commit、push、PR、部署、真实 provider 调用或生产 DDL。归档作者参与了本阶段实现，独立预发布证明由另一审阅者在两次成功父进程真实完成后提供。


## 阶段 17：独立 Cashier 能力与真实 H5 收银恢复（2026-10-29）

本阶段实际选中同一 inputs11 的 395 条通过用例、14 个完整测试文件、3 套完整类型检查及 H5／MP 两次构建。三个父进程均真实成功且由共享锁串行执行；389 条普通用例有真实打印成功行，6 条浏览器用例由断言后的唯一 SQL checkpoint、冻结源码位置、真实 6 passed 汇总及完整 driver／native／cleanup 结果联合证明，不虚构 reporter 未打印的成功行。逐例与父子进程见 implementation-result-17.json。

新增精确 GET second-card/capabilities：完整 App JWT 校验后，独立 Cashier 的实际数据库、角色和 OID 须匹配可信维护 binding，并校验当前 backend 的角色身份；只读快照逐项检查基础来源、表单、abandonment、条件 guard 与图片权限，发布独立摘要和受 JWT 约束的到达提示。该能力只控制客户端展示，新写仍由服务端重新鉴权。有效账号失去客服资格时返回明确 403，账号失效沿用原认证拒绝；普通可选 scope 读取保留原语义。原 UUID 的本人创建、现金付款回执恢复不受新作者能力总闸阻断。

前端校验独立能力的 actor、service、scope、摘要、readiness 和 lease，并绑定页面与登录会话。普通 App 的 false 不阻止经独立角色核验的收银入口；首页原回执恢复入口独立于工作台 context，资格撤销后仍可进入。新作者请求在确认后再次检查会话与能力；旧异步任务不能清除新任务 busy 状态。实际浏览器发现并修复 computed 未订阅初始响应的问题，以及新无表单订单应提交空数组的合同问题；保留本机已有 UUID 和原请求内容。

真实构建 H5 经本地 HTTP、生产 Hono 控制器、完整 App JWT 与五个不同 LOGIN 的 PG16 fixture 运行六步：手机／桌面入口、会员 UID11 与 SKU70 报价、原订单创建、7.00 现金收款和 App outbox 消费／重放、客服资格撤销、同一有效会话查询原创建及付款回执。实际仅四个 UI POST，撤权后无新 UI 作者发送；新作者 403 是直接真实路由探针。创建不可变核心保持，支付投影正常从未支付变为已支付；原回执恢复与收款后的基准比较。浏览器图片、游客／零金额浏览器矩阵、小程序真机及真实 provider 尚未验收。七张截图、真实请求、SQL checkpoint 和三个 PG 实例正常关闭证明均已归档。

浏览器保留并解释已安装 router 的弃用告警、精确已知装饰 CDN 图片的阻断错误，以及两个预期 context403 控制台记录；不声称零告警。未知网络、业务错误与页面异常仍拒绝。手机首页入口的 DOM 与实际点击已验证，不声称它位于首屏。

最终冻结 4,826 条路径，覆盖原 4,699 条基线路径（编辑前原件另存）、其后 12 条新增源码及晚补的 115 份共享协议目录当前观察；115 份不追溯为原始 baseline。inputs01–10 的真实历史结果保持为当时较窄范围，最终只计完整重跑的 inputs11。源码精确变化 18 个旧文件与 12 个新增文件，本文仅追加本节。依赖、静态源资源及生产 wrangler TOML 不在源码冻结范围，405 份 H5 与 1,171 份 MP 构建产物另有物理副本。

历史失败及局部成功不累计为最终通过。01–04 的断言／原生 fixture 问题、05 类型错误、06／08 浏览器入口失败、09 无表单失败、10 较窄范围成功均保留原始证据；07 在执行前修正诊断消息，未运行检查。浏览器 verbose flag 提议因现有 runner 明确拒绝而在静态阶段放弃，没有产生或执行 v5，也未为 reporter 格式改动源码。

保留现有 UID、用户、权益与旧单；跨 AppID／账号切换须先完成可审查归属维护。继承的 20 个范围标志及 conditionalWriteSemanticsVerified／completeServiceCoverageVerified 仍为 false，归属维护与全局 PHP→TS 迁移尚未完成。本阶段没有 commit、push、PR、合并、部署、生产 DDL 或真实支付／短信／设备调用。归档作者参与实现，独立预发布及发布后审计由另一审阅者完成。


## 阶段 18：本机 H5 收银图片链路的局部验收

本阶段最终选择实际 attempt `06`，全部检查绑定同一执行前物理源码冻结。实际 runner wholefile 509 个、图片 Browser 13 个 sequential stages、既有 capability Browser 本轮重新执行 6 个，共 528 个通过，0 失败、0 跳过，3 个测试文件；另完成 Worker 完整 `tsconfig.json` 与 fresh H5 构建。未变更的前端类型、MP 构建及 type-runtime 没有列为阶段 18 新通过。

图片范围包括真实选图 multipart、私有 asset controller 二进制预览与永久 `/api/assets/id` 引用、同 UUID 图片 session 与创建、独立上传/付款 UUID、quote 冻结/创建消费、现金与实际 App outbox/replay；还包括 stored 后一次断回包的原 UUID 重载恢复、chooser 空选择（setFiles([])）与真实确认 modal、冻结/消费禁取消、同 JWT 撤销 Customer 资格后经 home→fresh cashier 的本人 GET 恢复和 active owner cancel 边界。浏览器与 SQL/五个独立 LOGIN 使用本机实际 App/server；Map 私有 R2 仅为本地替身。HMAC+TTL asset URL 的授权独立于 JWT 与当前 Customer 资格。

本轮保留并核查了四条 uni-h5 选图警告：只有实际 fresh bundle 的路径/字节数/SHA、零基行列、四个选图阶段和完整 12 条原生激活轨迹都与已独立审查的诊断相符，才解释为 SDK 任务计数警告；点击可信、选择器触发前原生激活有效。其他未解释的警告与异常仍失败，原始观察完整保留；此前失败的 01–04 不追溯改为通过。

图片 13 项由执行源码 `it.each(stages)` 数组/分支、native 结果中的实际完成顺序、实际 driver 最终结果/health、13 张实际截图和 aggregate 13 共同见证；未虚构 13 条 printed-success LF，也未声称逐 stage IPC payload 已全部持久化。Capability 6 项使用本轮实际 raw SQL checkpoints 与 aggregate 6，未挪用阶段 17 的通过结果。

Attempt 05 的图片子项曾通过 13 项，但父进程以 143 中断，后续 capability 没有终态；这些通过只保留为历史，不并入本轮结果。其唯一遗留的本机 PG 已按核实的 data/port 精确停止，未把这次补清理写成 fixture remaining=0。最终选择的两组 Browser 均另有实际正常清理证据。

源码变化共 4 路径；基线与最终冻结物理副本、精确 patch、H5 完整 tree、两组 Browser outputs、raw/实际父 session/子退出码及 case witnesses 见 `implementation-result-18.json` 绑定的归档。此段为验证后的单独文档追加；postpublication current manifest 明确不是已执行的输入冻结，原执行副本保持不变。

本机 H5 图片局部证据成立不代表设备/MP、真实 R2/支付/SMS provider、部署、完整运行身份 commissioning、所有消费者/通道、归属维护或全迁移完成；沿用结果 13 的 20 个 false，`conditionalWriteSemanticsVerified` 保持 false。未提交、推送、创建 PR、部署或执行生产 DDL。本追加由独立审阅确认 writer/prepared/source/候选字节后发布；最终 postpublication 审计另行进行。


## 阶段 19：资格失效时保留本人图片恢复列表

修复同步清理顺序：非空经营 context 失效时，图片状态 watcher 清空表单/预览后重新读取当前 UID 的 durable 原编号列表。业务资格、联系人信息和签名预览仍清除；不同 UID 不能看到这些恢复行。

隔离旧实现 wholefile 34 项为 33 通过/1 失败，新回归在实际 manager.invalidate 后得到 pending=0（预期2）；保持同一测试、只加 22 字节修复的隔离候选 34 项全通过。随后精确落地两个路径，在新物理冻结上完成 144 项前端测试（6 个完整文件）、完整 vue-tsc tsconfig.json 和 fresh H5 构建；实际父进程 96454/cee185/0。红/绿隔离运行不重复计入落地后的通过数。

阶段 18 的 528 项保留为其原执行版本证据。本阶段未重新执行 Browser、后端、MP 或 provider；真实同页新上传 HTTP403 触发的浏览器场景仍待验收，不能由受控传输的 SFC/manager 用例推定。旧 Browser harness 绑定的 SDK bundle 身份须在后续新构建上重新独立审查后才能更新，不能挪用旧通过。

精确 patch、冻结源码、raw、父/子终态和独立审阅见 implementation-result-19.json。此段为验证后的单独追加，不属于已执行输入；全迁移、设备、真实 provider、归属维护与 conditionalWriteSemanticsVerified 边界保持未完成。未提交、推送、创建 PR、部署或执行生产 DDL。


## 阶段 20：同页上传 403 后的原图片恢复（本机 H5）

在阶段 19 的产品修复上，保留原 13 个图片场景并新增 4 个同页场景，合计 17 项、1 个完整 Browser 文件实际通过，无失败或跳过；同一物理输入冻结还完成 Worker 完整 tsconfig.json 类型检查及 fresh H5 构建。仅变更两个 Browser 测试文件，未修改产品源码，也未将旧 528/144 项重复计为本阶段通过。

新增场景在原 stored upload 后，只由本机维护 fixture 撤销 Customer 资格，继续同一 document/href/timeOrigin 与原 JWT。第二次真实文件选择/multipart 返回实际 HTTP403 后，先证明页面上三条本人恢复行及查询按钮可用、表单/联系人/预览与经营控件已清除，再从这些 LIVE 行操作原编号 GET。原 session、已存图片和被拒绝 UUID 分别得到 active/stored/null receipt；新 UUID 没有 SQL upload 行，原一份 attachment 与 Map R2 put 均未增加。最后用原 parent UUID 实际取消 active session，释放三条本机 durable stages，原 stored 图片与对象保留，无新订单或付款。

本轮实际使用 Chrome/Playwright、390×844、127.0.0.1 H5→真实 App/server→自有 PG16/五个独立 LOGIN；Browser 插件不可用，沿用现有工具，未安装依赖。page identity、非空内容、无框架覆盖层、交互、无横向溢出及截图均有断言；17 项由源码 it.each/分支、实际 native 完成顺序、17 张截图及 aggregate17 见证，不虚构每项打印成功行或未持久化 IPC。SDK 警告只允许当前已独立审查的 bundle path/bytes/SHA 与精确 image 行列，要求完整 18 条原生激活轨迹和 6 条对应警告；其余既有 router/CDN/丢回包/context403 与新增确切 multipart403 均保留原观察与解释。新截图中的短暂旧成功 toast 保留，不声称 warning-free 或 toast-free。

三个真实父进程分别为 types 19544/7aefe4/0、build 11301/1b1f73/0、Browser 19498/914729/0。自有 PG16 实际 remaining=0、STOPPED、shutdown、pid 缺席，Browser/HTTP/fixture 也正常关闭。执行源码副本、完整405文件构建、raw、parent/child终态与截图证据在 `/tmp/cinashop-phase20-evidence/`；文档追加是验证后的单独变化，原执行副本不改。

这是本机五场景验收，不代表设备/MP/真实 R2或支付 provider、部署、跨账号归属维护或全迁移完成，原全局20项 false 与 conditionalWriteSemanticsVerified 保持。接下来返回 routine 作者主线：先闭合真实通用配置读写及凭据 KV 旁路，接专用作者/第五共享合同、显式维护准入和 operation 正式安装，再完成作者 UI、原付款事实与发货恢复；已存在的 witness/attempt 安装器不重复实现。只读主线地图不计测试通过。


## 浏览器能力判断更正

根据用户提醒，已实际调用 cua.getState 与 cua.getBrowser({id: "2"})，确认 Codex In-app Browser 入口及浏览器控制接口可用。上文“Browser 插件不可用”的判断不准确，不能从专用技能未列出推断浏览器能力不可用，也不需要用户另行安装。后续交互验收优先使用现有浏览器入口。历史阶段实际使用的是 Playwright/Chrome，其原始结果、截图、源码冻结与审计记录保持原样，不改称为内置浏览器执行。此段仅更正工具可用性说明，不新增业务验收结论。


## 阶段 21：通用配置入口与凭据 KV 旁路闭合（2026-10-30）

本阶段基于已合并并推送的 `42756fe6946115fefdab1fe65fc36a30f210aba9`，在 `codex/routine-config-migration` 继续实现。通用配置 list/get 不再交付五个专用作者键及其 shadow；save 在任何 SQL/KV 写之前预检整个批次，混入任一受保护键则整批拒绝。JSON 转义后的精确键同样拒绝，其余配置沿用原有通用接口限制。五键为 `routine_appId`、`routine_appsecret`、`routine_name`、`routine_contact_type`、`store_user_avatar`，不按模糊前缀扩大保护域。

`SystemConfigService.get/getMany` 在任何 SQL/KV 读取之前拒绝凭据 pair；公开 name/contact/avatar 的兼容读取保留，包括已导入 contact=2。通知 readiness 改从同一有界、完整 shadow、sort/id 优先级和严格 stored-text 解析的 SQL 只读快照取得两个独立 presence 布尔值，不读凭据 KV、不需要 APP_KEY、不生成或返回 Secret/stamp。缺失或损坏的最高优先级值报告未配置，不借低优先级 shadow 顶替；SQL/容量故障仍拒绝。presence 只说明按现有解析/归一化规则存在非空配置值，不代表 provider 可用或历史账号归属。

七个完整单元文件实际执行 **166 通过、2 跳过、0 失败**；两项跳过是未提供原生 PG URL 时保留的独立快照/凭据门锁用例，不能记为该次运行的 native 通过。随后整个 `routine-runtime-config.test.ts` 在新建 PG16.14 集群上完整执行 24 通过、0 跳过，包含这两项；实际角色 NOSUPERUSER/NOCREATEROLE，remaining=0 且集群已停止。这是另一次完整文件执行，不累计为 190 个独立用例。新 Hono fixture 使用真实控制器、DAO 和 SQL、污染 KV，检查两处 GET alias、混合批次原子拒绝、普通配置可用、公开兼容和通知投影。该 fixture 显式不覆盖真实认证/权限中间件，也不证明数据库原始写权限已闭合。原始日志在 `/tmp/cinashop-phase21-validation/routine-generic-01.log`。

同步处理基准提交的 CI 失败：Uni `test:toolchain` 恢复两条真实父分支的直接 Node 测试并集和原有 23 个独立 npm 子链，避免把后续任务误当成第一个任务的参数；末尾安全回补检查保留。workerd 的调度断言跟随现有 `live_sync_dispatch` 单一根任务，显式核对完整 12 个维护任务，生产调度未改。离线支付的 workerd PGlite 尝试 04 实际为 15 通过、49 跳过及 3 个未处理错误：即使输入静态 Wasm/data，库仍动态生成 Wasm，遭 embedder 拒绝。该尝试不能验收；已移除全部 Wasm/data/private-binding 适配，没有放宽运行时。改为 Node provide 显式专用 URL、workerd inject 调用复用原 URL/PG16/身份/owned database/endpoint/清理防线的 native fixture；原 49 个 SQL/RSA/provider 边界场景保留。CI 增加同版本独立 PG16 服务，本地 runner 新增互斥且精确白名单的 `--runtime` 模式，不开启维护权限或增加 timeout。首次真实 TCP 执行原 49 项均通过，但 postgres.js 3.4.9 关闭时留下两条 Stream was cancelled 未处理错误，父进程失败；不能验收。随后引入可复现、完整文件校验的 Cloudflare 关闭逻辑回补，保留 Node/CJS/types/manifest 和另外 36 个文件逐字节不变，具体来源与终态错误语义见 `../vendor/README.md`。这会影响实际生产 CF 驱动，不只是 fixture。干净 npm ci、归档重建和 8 项安装树/关闭/活跃错误回归已通过。回补后原 49 项、两种正常关闭和强制结束通过，但新增后端终止场景在测试清理超时（52 通过/1 失败）；该次两个 owned 数据库未清除，集群已停止，保留原日志，不计最终验收。后续修正仅在后端终止分支接受实际 FATAL/EOF 两种拒绝码，并在已拒绝会话上显式 end(timeout:0)，避免其残留 query 让默认五秒清理掩盖原断言；没有提高 timeout 或过滤错误。独立 observer 以每次事务局部剩余 statement_timeout 和实际完成时刻证明原 pid/db/role 在两秒期限内消失。定向 03 实际 53 通过、0 跳过、exit=0、remaining=0 且停止；实际观察 force-end 为 CONNECTION_DESTROYED、后台终止为 CONNECTION_CLOSED。随后完整 30 文件/410 项全部通过、0 跳过、exit=0、remaining=0 且停止；53 项是其子集，不重复累计。完整运行 stderr 另有 22 条 WebSocketPipe 断开和 4 条 native Uncaught(Network connection lost) 消息，Vitest 未报告 Errors；插件关闭 WebSocket/销毁 Miniflare 的实现提供了宿主 teardown 解释候选，但未逐条建立因果，不能声称所有诊断均无害、无 stderr 或完全无警告。并发/隔离及所有错误输出均保留。

秘密扫描的 277 个历史命中逐条核对后，仅保留 276 个精确 immutable commit/path/rule/line fingerprint；重复的一行含两个摘要。SHA256、解析正则、受控本地 fixture 及已过期安装 SQL 接口响应示例的分类证据见 `docs/security/gitleaks-reviewed-findings-20261030.md`。原 PHP/冻结 proof JSON 与既有扫描规则不改。新增独立临时 Git 仓库 canary 要求真实固定版本扫描器分别在生成 API Key、JWT、RSA 私钥的实际行检出；不输出生成值，原全历史扫描保留。本次真实 Gitleaks 8.29.0 canary 已在各对应字段行检出三类动态生成值，实际 exit=0；同一固定二进制全历史扫描 868 个提交、约 845.89MB，exit=0、无新增命中。这次 868 提交扫描只覆盖本阶段提交前的历史；本阶段提交后须独立重跑并保留结果，不能挪用该历史通过结论。

远端 run 41068214196 的两个 Worker 单测分片仍失败；已取得的日志包含缺失历史证据文件、旧源码/清单断言及实际前端 fixture 错误，尚未逐项完成复现修复。旧合并检查的 223 项失败不是本阶段的新验收结论；既有 proof hash、快照和原始失败日志不为得到绿色结果而重写。当前小范围结果不代表全分片或 CI 已通过。结构化两个分片共 37,657 条、36,703 通过、917 失败、37 pending，计数与原始 JSON SHA 见 `php-ts-ci-triage-20261030.md`。本轮六个导航相关完整文件为 331 通过/39 失败：五个文件通过，商品详情来源检查仍失败；未减少其断言。Uni 首轮 24 批报告累计 3,747 通过/2 失败，最后两份安全消费者文件因旧安装树在顶层校验中止；归档逆向/恶意 tar 24 项通过。按当前锁执行 npm ci 后，真实安全消费者与归档检查完整 29 项通过，依赖声明、lock/vendor 与安全断言未改（manifest 仅修复上述脚本链）；新依赖树的完整工具链 24 批累计 3,752 通过、0 失败、0 跳过，完整 vue-tsc 及 H5/MP/App 三次构建均 exit=0。H5 静态图片 URL、MP 空 chunk/样式及 App SDK 更新提示仍存在，不据此声称无警告或真机验收。两套 Worker TypeScript 检查 02 均通过；新增驱动回归后，最终完整 unit/runtime 两套检查 04 也均 exit=0。初次新回归的单元类型 03 在 Node/Cloudflare URL 与 Buffer 类型交界失败，已仅修正测试宿主的显式 Node URL 导入与字节比较，未关闭 strict 或扩大类型豁免。生产依赖审计实际报告 0 漏洞。修复 runner 非首位模式参数的原拒绝文案后，配置入口、memory 边界与 runner 三个完整文件 695 项通过。

下一阶段仍须实现五键原始 SQL writer 约束、独立不可假冒的受限作者能力、operation 正式维护安装与完整角色审计，再启用专用 service/controller/UI。当前 Admin 对 system_config 仍有整表 INSERT/UPDATE；advisory/GUC 不构成 DB 写授权。新增 guard 必须同时检查 OLD/NEW 的改名、realm、sort/id 与元数据，并与 App/Base/Open/PC 作者现有拒绝未知 trigger 的合同一并精确适配。已存在的 witness/attempt 安装器不重复实现。

保留现有 UID、用户、权益、旧单和付款。跨 AppID/账号切换须先完成可审查归属维护；当前配置、witness、INIT/PREPAY 均不证明旧付款归属。本阶段没有生产 DDL、真实 provider 调用或部署；全局迁移与既有范围标志继续保持未完成。


## 阶段 22：五键原子 SQL 写入与联合目录检查（2026-10-30）

新增尚未发布的低层写入能力：独立 NOLOGIN writer 与真实 Admin LOGIN、数据库名称和实际 OID 绑定；五键 INSERT/UPDATE/DELETE 的 OLD/NEW、realm、行号、sort、全部元数据和 TRUNCATE 均有固定 guard。writer 仅取得配置 SELECT/INSERT、value 列 UPDATE、配置序列 USAGE 和回执 SELECT/INSERT；Admin 对回执只读。配置变更与不可变回执由同一个 SQL 语句提交；keep 不解析、不改写旧值、不消耗序列，重放不重复写源或分配 XID。SQL 自行取得完整 shadow/metadata/xmin 来源及实际变更后摘要，不接受调用方声称的变更后事实。

存储文本解析器直接输出 UTF-8 bytea，处理 JSON 转义、NUL、合法代理对、ECMAScript 空白和两层 5000 码点容量，与共享 TypeScript 解析合同逐例比较。私有 SQL 来源摘要与 actor binding 通过分域 HMAC 形成公开 revision；公开回执严格投影七字段。同 UID 换 JWT 后恢复旧回执，保留原 binding 与原实际变更后来源。SQL 参数中的 actor 和摘要格式不证明当前 HTTP 身份；后续 service 仍须在同一事务内重新验证当前账号、密码、权限和签名。

只读联合检查精确核对 helper/main/guard 的唯一签名、源码、owner、实际 OID、属性和 ACL，回执目录及三个非 owner ACL、writer 的有效表/列/序列权限、角色属性和其他 owned 对象、system_config 全部 16 列/default、五个正式索引、序列及唯一两道 trigger。回执就绪判断使用这一联合检查，并要求实际 current_user=session_user=绑定 Admin；不在请求中安装、修复或扩权。

本阶段四个完整文件分别实际通过：原生文本解析 267 项、原生独立角色写入/目录/回执 45 项、PGlite 回执 30 项、运行器边界 681 项，均无失败或跳过；两套完整 Worker 类型检查使用项目既有脚本实际 exit=0。267 项与最终 45 项来自分别新建的 PG16.14 集群，两者 remaining=0 且 STOPPED。先前 36 项为最终写入文件的旧版本子集，不重复累计。日志在 `/tmp/cinashop-phase22-validation/`；最终运行绑定 `inputs-final-04.json`，验证后仅追加本节。早期双重 JSON 编码夹具、目录查询保留字和 input_type 默认值误写的失败保留，最终修正使用真实 schema 的 `input` 默认值，未放松断言。直接 tsc 的默认堆失败及两处测试宿主字节类型错误也保留；最终沿用原有 package 脚本，未改堆配置、超时或验证并发。阶段 21 提交 b874c56a 的提交后全历史扫描实际覆盖 869 个提交、无新增命中；本阶段提交须另行扫描，不能复用该旧结论。

正式维护 installer、全库角色 profile、既有 App/Base/Open/PC 作者 guard 共存、专用 HTTP service/controller/UI 和历史账号归属维护仍未完成。本阶段拒绝实质 AppID 变化（包括首次接入），只允许相同解析字节的原值规范化；这是未 commissioning 时的关闭状态，不代表跨账号切换已实现。保留既有 UID、用户、权益、订单与付款，当前配置、回执、witness、INIT/PREPAY 均不提升为旧付款归属证明。用户已授权将未提交迁移工作一并 checkpoint 并合入 main；本轮不执行生产 DDL、真实 provider 调用或部署，既有全量 CI 失败与全局迁移未完成状态保持如实记录。


## 阶段 23：正式维护准入、完整权限审计与四作者共存（2026-10-30）

阶段 22 的 `c7c36f42` 已在用户明确授权后推送 origin/main，其提交后全历史扫描实际覆盖 870 个提交、无新增命中。本阶段从该提交新建 `codex/routine-author-commissioning` 继续迁移。

新增 `runAdminWechatRoutineUpgrade`／事务组件，要求显式 PG16 维护身份、当前完整 App/Admin profile 和部署预建的空权限 NOLOGIN writer。先取得独立维护／凭据门及实际表锁，目录、最小授权、完整联合校验与最终双 profile 在同一事务中提交；完整重复只读返回，partial、额外权限或目录漂移拒绝且不修复。安装不创建角色、不改凭据或业务行。完整 runtime audit 只在精确 named catalog 通过后接纳 Admin 的回执 SELECT 与唯一实际函数 OID，App 不增加这些权限，基础首次 commissioning 的固定计划保持。

目标合同显式保留 local/caseLock，gift peers 必须声明同一数据库及完整身份集合，App reader 也显式传递。公共入口在等待 BEGIN 前同步复制并校验这些声明；真实五角色用例在取得安装 Promise 后立即修改独立调用方副本的 writer、local、caseLock、peer Admin 和 reader，仍只安装原绑定。该用例使用当前完整 App/Admin/Financial/Manager/Cashier LOGIN、conditionalGuards 与 formImages，实际核对五个完整审计、独立 PID、四个非 Admin 的读取／EXECUTE 拒绝，以及全部配置 xmin 和业务 facts 不变。

App/Base/Open/PC 四个已有作者仅接纳经过完整 Routine catalog／当前绑定 Admin／真实 guard OID 证明的两道触发器；无 bundle 时保留原有无触发器规则，未知触发器、反向挂载、未知 Routine 命名空间、默认授权和 partial 均拒绝。Menu 检查的 cache 目录保持独立。实际四作者保存及未知触发器拒绝后的全部源／五域回执原子性由正式 native 用例覆盖。

另发现旧 Routine 请求门 `731668` 与 CustomerWork 财务请求幂等门重复。独立 peer 持有相同 int32 键时，新增原生反例实际为原 45 项通过、新例 `55P03` 失败；仅将 Routine 请求门改为独立 `731752` 后，整个 46 项文件通过。财务门保持原值，新例同时证明旧门不阻挡 Routine、新门仍阻挡同 UUID，释放后无 XID／源／序列改写的合法重放可恢复。修复前源码在真实失败终态后另行保存，未伪称执行前冻结。

最终正式 native 完整文件 11 项通过，包含调用参数竞态；低层完整文件 46 项通过，两者无失败或跳过，各自 remaining=0 且 STOPPED。11 项选择 `upgrade-native-04`／`inputs-04.json`，46 项选择 `request-gate-green-01`／`inputs-03.json`；二者输入差异仅为后来修改的安装器与正式 native 文件，这两条路径不被低层文件调用。此前 `inputs-02.json` 的四个已有作者完整文件分别为 3／3／9／6 通过，回执和运行器两文件共 714 通过；这些是请求门修复及公共入口快照调整前的实测版本，不改称为最后源码上的重新执行。随后最终完整 unit/runtime 两套 TypeScript 检查 03 均 exit=0，13 条源路径在整个最终 pipeline 中保持不变，验证后仅追加本节。各阶段重复执行不累计为新增案例，首轮 8 通过／1 失败的公众号开关字符串断言保留，依既有存储合同纠正测试期望，未改业务序列化。完整五角色 fixture 的既有 IF EXISTS NOTICE 保留，不声称无诊断输出。原始日志与输入在 `/tmp/cinashop-phase23-validation/`。

上述为自有本机 PG16 的维护协议验收，没有生产 DDL、provider 调用、部署或新增 HTTP/UI 启用。专用作者的 fresh 账号／密码／权限校验、原绑定回执恢复、控制器／双前缀／第五共享 envelope、前端页面与 Browser 验收仍需实现；不能用 SQL actor 参数或底层 PostgreSQL 测试替代真实 HTTP。跨 AppID 仍须先完成可审查归属维护，现有用户、权益、旧单与付款事实保持；旧配置、回执、witness、INIT/PREPAY 仍不证明旧付款归属。原付款／发货恢复、既有 CI 失败及全部剩余迁移范围继续保持未完成。


## 阶段 24：受约束的 Routine 管理端 HTTP 作者与本人回执恢复（2026-10-30）

此前用户明确授权的 `b874c56a`、`c7c36f42` 已成功推送 origin/main；本阶段在阶段 23 的本地 `a776bcc1` 上继续实现。新增生产 Hono Controller/Service、`/adminapi` 与 `/api/admin` 两组五端点、旧 `edit_new_build/routine` 读取别名，以及共享 save_basics 的第五种完整请求合同。五种请求必须完整且唯一匹配；没有按部分键分流或 generic fallback。

普通管理员的域管理权限只由固定 PHP 叶子 1346（routine-download）与共享保存 315 的唯一、完整十一字段身份组合取得；父级 1345、info1347、源码下载1348、复制行和 opaque wechat_routine.* 均不能制造写权。新保存先持有 staff/role 与正式 menu 栅栏，在同一实际 Admin 事务内验证当前 UID、realm、状态、密码摘要、完整角色与权限，再验证独立 Routine writer 目录、完整 PostgreSQL source 和 actor HMAC CAS。唯一定义好的 SQL 端口独立比较全部 shadow/metadata/xmin，并原子提交配置和不可变回执；Service 首尾复验活跃权限，并在提交前按数据库时钟检查期限。

Drizzle 采用恰好一次序列化参数的 `::text::jsonb`；resolve 传真正 SQL NULL。保存和恢复均不返回 AppSecret、私有 source、binding 或 payload hash。已提交 UUID 重放使用持久化原 actor_binding/before_source，不被同 UID 的新 JWT 或后续配置变动误拒；SQL 仍核对原提交 revision/fields，禁止同 UUID 改意图。本人 recovery 在域权限撤销后保留，但禁用、删除、跨 realm、密码改变、JWT 过期及其他 UID 均拒绝。GET 缺失回执为业务状态码 404（HTTP 沿既有兼容信封）；明确 resolve 原子封存 not_applied 并阻止迟到保存。缓存失败只报告 pending，回执和配置不逆转。

新增 `storage_ready` 仅表示精确联合目录、同维护/Admin 的完整 Authority 回执/menu-lock 依赖、实际 current_user=session_user 及绑定 Admin 名称/OID 可用。SQL-only Routine installer 不隐式安装或修复 Authority 域；HTTP 应用必须另外显式安装该正式依赖。维护账号误接不报 storage-ready。`runtime_ready` 暂时保持 false，因为账号归属、旧付款和发货消费者尚未闭合；不能由 storage_ready 或 credentials_complete 推定可跨 AppID。凭据 presence 采用已有消费者的 trim 规则，作者原文仍无损保存；纯空白密钥可 parse 且原行存在，但 presence/complete 为 false。实质 AppID 切换及首次接入仍在任何五键写入前被 SQL 归属屏障拒绝。

最终 inputs-03 的 Routine HTTP 完整文件 8 项通过，包含 JSON 对象/五键、NUL/反斜线/Unicode、无 Secret 回显、原 binding 重放、精确权限错误、元数据过期、首次接入拒绝、独立锁、目录漂移、65 行完整容量和活跃用户状态；SQL-only/Authority 依赖分离和维护角色反例亦实际覆盖。三份定向单元完整文件共 749 项通过；最终两套 Worker 类型检查均 exit=0。原始输入、各次终态与日志在 `/tmp/cinashop-phase24-validation/`。最终 15 源路径在 pipeline 内保持不变，本节在验证后单独追加。

首轮 HTTP 为 1 通过/5 失败：夹具漏装正式 Authority menu-lock，保存在 SQL 写入前被拒绝；保留原失败与 remaining=0/STOPPED，补齐依赖后重跑，未放宽权限。inputs-02 上的 Routine 8 项、App HTTP 5 项和 PC native 6 项也分别完整通过；后两者覆盖旧 App 与 PC/Base/Open 的共享分流和既有 64/256KiB 限制，是该次输入的实际回归，不改称最终 bytes 上的重跑。重复执行不累计为新增案例。所有本阶段 native 集群均 remaining=0 且 STOPPED；预期拒绝请求的结构化 failure 日志保留，不声称无 stderr。

上述是进程内真实生产 Hono Request/JWT/Drizzle 与独立、实际 TCP 认证 PG16 LOGIN 的本机验证；不是 HTTP 监听器、Browser、微信 provider 或部署验收。数据库时钟末尾过期竞态、Service 读取到 SQL 调用间竞态未分别注入，不以静态检查或其他低层用例冒充该 HTTP 覆盖。完整迁移继续未完成：前端严格 DTO/session/pending journal/页面与 Browser、归属维护、原付款证据及旧查单/回调/发货恢复、其余消费者和既有 CI 失败仍须推进。保留现有 UID、用户、权益、旧单与付款；配置、回执、witness、INIT/PREPAY 不成为旧付款归属证明。本阶段没有生产 DDL、真实 provider 调用或部署；整体 conditionalWriteSemanticsVerified 和完整迁移状态保持 false。


## 阶段 25：Routine 真实提供方原始付款证据与结算复核（2026-10-30）

新增独立、显式维护的 `routine_original_payment_evidence` 插件，不修改历史基础迁移和既有 callback v1 canonical hash。精确 PG16 目录为九列、十一约束、四索引、不可变行/整表触发器；实际受限 App LOGIN 只有 SELECT/INSERT，Admin、Financial、Manager、Cashier 没有新增读取或写入权限。正式安装器原子复核 App/Admin 与显式 local/case-lock/peer/App-reader 声明，完整重复不改 DDL、ACL 或业务行；owner-only、部分对象和漂移均拒绝。只有整个可选命名空间完全缺失时才保留旧路径，运行入口不隐式安装。

生产微信适配器在真实 RSA 验签（回调另经过 AES-GCM 解密）之后，捕获 AppID、商户、订单、交易、金额、币种、SUCCESS/JSAPI、付款人 OpenID 和提供方成功时间。请求内不可枚举 Symbol 携带独立域 HMAC 证明；JSON/对象展开/Queue 不带证明。原始 body 仅取摘要，不存签名、密钥、Secret 或原始明文。回调事实和原最小事件/outbox 在同一事务提交，Queue 在提交后发出；查单在 SQL 事务外完成 HTTP 和 RSA，再提交原证。完整真实 SUCCESS 即使与本地金额冲突也保留原始事实，并标为不可结算；NOTPAY 不制造付款原证。来源同事实重放保留首次行及 xmin，同一来源改事实拒绝；相关订单/交易的不同账号、付款人或本地物理归属造成冲突。

本地订单号在商城、充值、会员三域完整采集，不从付款人 OpenID 推导 UID，不写用户、绑定或旧单。缺失、重复、非法本地事实保留为 unresolved，真实金额冲突留存但不派发结算。入口先取三表有限 NOWAIT SHARE 栅栏及候选行，再取订单 boundary、provider transaction 和 case/event 锁；事务内只有 SQL 与本地 HMAC。这个保守栅栏会与无关订单写入发生竞争，当前只能明确拒绝/重试，不能宣称已完成生产吞吐验收。

三个默认结算入口都在已有业务订单行锁之后重新读取确切不可变证据、相关冲突与当前 UID/物理 ID/订单号/金额/交易/付款状态。库或权限临时未就绪的 503 走有限 FAILED/重试，不再被永久业务 UNKNOWN 吞掉；真实业务矛盾仍按既有冲突与显式恢复流程处理。当前配置、管理回执、code2Session witness 和 INIT/PREPAY 仍不能充当旧付款归属；这些证据不激活跨 AppID 的历史账号，也不授权重绑用户或权益。

本阶段严格按照微信官方 Mini 成功回调及 JSAPI 查单字段合同采证，官方来源为 [Mini 成功回调](https://pay.weixin.qq.com/doc/v3/merchant/4012791902)与[JSAPI 查单](https://pay.weixin.qq.com/doc/v3/merchant/4012791859)（本轮在线核对）。传输为本机受控替身，RSA/AES、生产 Hono/默认消费者和实际独立 TCP PG16 LOGIN 执行，不代表真实微信、Workers、Hyperdrive、Browser、生产 DDL 或部署。

最终 inputs-05 的 16 源路径在整个串行 pipeline 内保持不变：七份定向单元完整文件 874 项通过；原始付款证据完整原生文件 13 项通过，包含真实双阶段回调/查单、三域默认结算、真实商城 checkout 与付款后置副作用、30天会员、付款人/买家隔离、权限503恢复、同事务回滚、TEMP遮蔽、金额变化恢复和两种真实跨订单能力拒绝后的正确订单成功。原证采集异常不传播未获原证授权的结果 scalar，故不会把另一订单交易号或缺证明 SUCCESS 的交易号写入当前 case；不把这项合同泛化为所有非 SUCCESS 诊断 scalar 的认证。33项离线回调/恢复整文件均通过；两套标准 Worker unit/runtime 类型检查 exit=0。正式目录/安装器完整七项在 inputs-01 实际执行，其四个目录、安装器、审计与测试文件至 inputs-05 完全同字节；既有公共来源/真实商户签名44项在 inputs-03 实际执行，其提供方代码保持不变，不改称最终全图重跑。每份原生集群均记录 remaining=0、STOPPED；预期拒绝的低基数结构化日志保留，不声称无 stderr。原始 inputs、各轮终态及日志位于 `/tmp/cinashop-phase25-validation/`，最终汇总为 `implementation-result-05.json`；本节在源冻结验证后单独追加。

首轮原证集成8通过/1失败，是测试预期详细错误字符串而既有日志只返回低基数 Error.name；生产拒绝与零财务变成立，修正期望后重跑。扩展普通回归873通过/1失败，为旧静态测试仍寻找已经迁出的 registerPaymentReconciliationIntent；三域生产文件在 main 早已统一 admission，本次改成 AST 追踪实际 awaited hook、事务登记与 provider 调用顺序，既有实际执行用例保留。离线初轮19通过/14失败：夹具只有陈旧KV，已迁移的正式SQL商户来源缺失，造成微信过早拒绝与部分负例假通过；补齐六个global SQL键，原账号旋转改为真实SQL变化，保留冲突KV并强制零读取，原33场景及断言全部保留。类型初轮三错为 source 字面量收窄与 Node/Workers typedarray 编码类型；显式类型与 node:buffer 包装修正，不放宽类型或提高资源/时限。所有早期失败均保留，不累计为通过，不据此宣布历史全量CI绿色。当前尚无单独的运行入口 truly-absent/partial命名空间新用例；正式安装部分/孤儿/漂移拒绝、完整schema真正legacy离线回归及实际 TEMP 运行反例各有其明确覆盖边界。

整体迁移与 runtime_ready 继续为 false。账号范围身份映射、完整历史清单与维护 manifest、原子消费切换授权，以及旧账号回调/查单/退款/发货/通知、Financial 的窄读取转交、前端 DTO/会话/操作 journal 与 Browser 验收及其余历史 CI 失败尚未闭合。用户已授权且成功推送的阶段23/24两笔为 a776bcc1、a8a57da7；本阶段提交和推送状态另由检查点记录，不纳入该次两笔授权。


## 阶段 26：归属维护的只读数据库清单组件（2026-10-30）

阶段25提交 `02b72d0e` 已按用户明确授权推送，并通过实际 `git ls-remote` 核对 origin/main。继续实现专用 Node 维护读取器与显式 CLI，不接入 Worker 请求图，不修改基础迁移或任何运行角色授权。完整运行合同见 [归属清单说明](./routine-ownership-inventory.md)。

清单发现全部非系统 schema 的 heap 表及分区根，不按手选 Routine 表集截断。先取得全源 NOWAIT ACCESS SHARE 锁，再建立 REPEATABLE READ / READ ONLY 快照并复核源集合；每个 heap 用 ONLY 扫描，分区/继承子表只计一次，软删除行不筛掉。读取实际 PG16 主库、数据库/维护 LOGIN 名称与 OID，要求 current_user=session_user、superuser、rolcanlogin 和 origin；维护连接使用独立 max-one、prepare:false 客户端。每次 FETCH16，数据库文本保留大整数和小数精度，独立域 HMAC 覆盖源身份、xmin、ctid、完整行文本及目录。相同值更新、新表、配置/业务事实和目录变化均可造成源指纹变化。

原生反例证明 TRUNCATE 与表重写不能在证据快照前制造假空读；独立 peer 的普通 DML 仍能提交，但本轮始终读取同一快照。显式 RR catalog 无法独立防住 schema 重命名后再建同名空表，故每个实际解析的数据源同时返回 composite type OID，空表也保留 sentinel，SQL 在预算和 to_jsonb 之前先核对该 OID。新增同名空表和带自定义 JSON cast 的非空替代表均整轮拒绝，后者的 session-lock 探针保持零执行。

所有支持列在任何目录 JSON 前先检查 built-in scalar allowlist；foreign/materialized/custom AM/custom type/array/domain/enum、超限和漂移整轮失败，不返回成功前缀。文本/bytea、受限 JSON 及数值展开在完整业务行序列化前预算；目录 attmissingval 另行预检，拒绝 JSON/JSONB fast-default、压缩或过大的 missing array，不从目录指纹中删掉它们。库 API 的 RC 预发现与 RR 扫描均使用保留较短现有值的有限 statement/lock/idle/temp-file 设置；RR 的第一条 SELECT 始终在全源锁之后。一般目录文本仍由 PG 后端先渲染，再做返回字节检查，不能把验收容量声明成后端总内存限额或生产吞吐验收。

报告仅在全部源扫描完成后返回，包含维护员可见的数据库/角色/关系名称与 OID、快照时间、十进制字符串计数和 keyed digests，不含原始业务行、openid、付款人、provider payload 或凭据；这不是匿名公开回执。错误与 CLI 连接关闭失败脱敏，无运行 URL/APP_KEY 回退。报告明确 ownership=not_evaluated、externalSourcesIncluded=false、activationAllowed=false；系统/临时存储、sequence reservation、large object、Redis/Queue 和外部账号凭据/提供方历史不在本组件内。不得由零计数推导首次接入许可，不把数据库库存指纹当成历史归属、成功付款原证或切换授权。

最终 inputs-03 六条源/测试/运行合同路径在整个 pipeline 内逐字不变：完整原生文件14项通过，包含真正185步迁移、注册283表图及逐表独立计数，JSONB outbox 大整数/小数原文指纹、读前后 xmin/ctid/序列保留、末页/软删除/非public、继承/分区、并发 DML、TRUNCATE、发现漂移、schema 替换、真实受限 LOGIN、容量/fast-default/自定义 cast 拒绝；remaining=0且STOPPED。CLI 与运行器两个完整文件703项通过，两套标准 unit/runtime TypeScript 检查 exit=0。独立只读审查无剩余必须修复问题。inputs-01/02 的14项通过与 unit-01 的703项通过各保留原终态；复核后补充 missingval/LOGIN/预发现预算，再在 inputs-03 全文件重跑，不累计重复执行为新增案例。fixture 既有 NOTICE 与未持锁 cleanup 探针 WARNING 保留，不声称无诊断输出。原始 inputs、每轮日志和只读设计/审查在 `/tmp/cinashop-phase26-validation/`；本节在最终验证后追加，提交文件另行秘密扫描。

本轮无生产执行、provider、Browser 或部署验收。完整迁移和 runtime_ready 仍未完成：数据库库存组件不能替代账号范围身份映射、外部闭合清单与归属分类、维护 manifest、原子消费许可或旧账号消费者。现有用户、UID、权益、旧单和付款继续保留，实质 AppID 切换/首次接入屏障保持关闭。新提交/合并/推送状态以本轮最终检查点为准，不把阶段25的推送授权扩展到新提交。


## 阶段 27：前瞻性账号归属与严格登录、付款身份选择（2026-10-31）

阶段26提交 `8e1d8cbd` 已按本轮明确授权推送，并通过直接 `git ls-remote` 核对 origin/main。新增独立、显式维护的 `routine_identity_ownership` 插件，记录精确 AppID／OpenID／UID／物理 binding 及首次不可变 witness anchor。十列、十二约束、四索引、行更新/删除与整表截断拒绝触发器采用完整目录与权限核验；App 只有 SELECT/INSERT，其余运行角色没有新增权限。正式安装器在独立门锁、真实维护 LOGIN 和完整角色声明下原子安装空表，调用参数在等待事务前复制；完整重复只读，partial、孤儿和漂移拒绝，不回填旧用户、绑定或付款归属。

记录使用 APP_KEY 的独立域 HMAC，校验固定身份和全部记录事实。写入保持 caller transaction 的 user→exact binding 顺序，由 Auth 调用者先验证旧 UID 连续性，底层 append 再校验 fresh observation 和精确活跃 UID/binding，追加真实新 witness 与映射；重复交换保留首次 anchor、created_at 和 xmin，新增 witness 不替换原始锚点。读者按确切 AppID／OpenID 或 UID／AppID 有界完整读取，超限拒绝，逐项核对签名、原锚点、活跃 UID 和物理 binding；无映射返回 null，由严格调用者拒绝或要求连续性；歧义、禁用、删除或漂移受控拒绝。仅整个可选命名空间真正缺席才沿用旧兼容路径，部分对象拒绝，已安装时错误实际运行角色也不降级。

已安装插件时，旧全局 OpenID／UnionID 只提供冲突候选，不能直接证明当前 AppID 对旧 UID 的归属。即使强制手机号配置关闭，未映射旧身份也须由已验证手机号独立定位同一旧 UID；给无手机号旧 UID 添加任意新手机号不能接管该账号。新身份仍可在同一事务创建 UID、礼包、binding、witness 和映射。已映射身份沿用原 UID，静默登录无需注册礼包 KV。加密手机号入口在首次 await 前捕获 UID/密文/IV，验证源绑定 session、AES watermark 及精确归属；普通更新手机号与 Routine 入口统一先锁排序后的旧/新手机号，再锁 user 并复验快照，避免这两条实际路径的相反锁顺序。

新付款准入按已捕获的当前 AppID 选择唯一活跃 payer；同一 UID 可保留不同 AppID 的不同物理 binding。原 INITIATION/PREPAY v1 内容及 hash 不变，旧 PREPAY 在读取当前身份前按原回执恢复；已有 INITIATION 缺回执时仍保留不确定状态，不在账号变化后重发。全局 OpenID 唯一约束保留，同一物理 binding 不能再归给另一 AppID。该映射记录本次采集时点的精确绑定，消费时另验当前活跃 UID/binding，不将新 code2Session、当前配置或 INIT/PREPAY 解释为历史归属。官方 [code2Session 合同](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html) 已在线复核；提供方身份合同不替代本地旧 UID 连续性证明。

最终身份归属完整原生文件在 inputs-03 实际重跑15项，通过、无跳过，remaining=0 且 STOPPED。正式安装器完整文件7项在 inputs-01 通过；既有 witness、auth session 和五个付款文件共七个完整文件291项在 inputs-02 通过；auth-phone-migration、auth-login-hardening 与 runner 三个完整单元文件708项在 inputs-02 通过。上述生产实现、目录、安装器与运行器从 inputs-01 至 inputs-03 保持逐字一致；inputs-02 只加入旧 phone 静态测试更新，inputs-03 只将新原生测试五处 raw transaction 改用项目既有 withTx 封装，不更换实际连接或放宽生产类型。不同批次及重复执行不相加为独立覆盖。完整标准 unit/runtime 两套 TypeScript 检查在 inputs-03 均 exit=0，12条源/测试路径在最终 pipeline 内保持不变；本节在验证后单独追加，提交文件另行扫描。

原生15项覆盖未映射旧UID拒绝/同UID已验证手机号连续性、任意新手机号不能接管无手机号旧UID、其他UID冲突、新UID与礼包同事务、首次锚点/xmin保持、A/B不同binding的payer选择、旧真实RSA PREPAY重放与未知INIT保留、同binding跨App回滚、映射HMAC/原anchor篡改、活跃/多live拒绝、调用方晚期回滚、独立peer的user→binding及phone→user锁顺序，并使用实际mpLogin/session/AES证明await期间将调用方UID从11改为22不会改写22。正式安装7项另覆盖完整五角色声明与异步BEGIN前参数快照、精确目录/ACL/不可变性、幂等、partial/orphan、漂移、门锁/表锁及同事务回滚。

首次 typecheck-02 的5处实际错误是新测试将 Drizzle raw PgTransaction 直接传给项目 DbClient 回调；改用已有 withTx，不削弱类型检查，随后重跑完整15项原生文件及两套类型检查。旧phone测试中4条要求反复读取 params.uid 的源码字符串断言由检查发现，移除这些实现细节断言并保留其余合同检查，以新PG/AES实际执行用例覆盖捕获UID连续性；没有虚构旧测试运行失败。历史失败与早期15项通过均保留原日志，不累计为最终新增通过；fixture的既有NOTICE和预期业务拒绝诊断保留，不声称零stderr或历史全量CI绿色。独立只读复核未发现剩余必须修复问题；目录/安装器作者另参与复核，其独立性不扩张为对自己实现的完全独立审计。原始冻结输入、各批日志/终态及审查位于 `/tmp/cinashop-phase27-validation/`。

本轮在自有本机 PG16 调用实际生产服务实现，服务商 HTTP/Redis/KV 使用受控传输替身；实际执行 SQL、独立 TCP LOGIN、HMAC、RSA 和 AES，不代表真实微信、短信 HTTP、Browser、Workers、生产 DDL 或部署。直接 reconcile 的 phone 是服务端已验证测试输入，独立另有实际 getuserphonenumber 服务实现及受控提供方响应的路径覆盖。fixture 的 AppID 变化由自有维护连接执行，不是生产切换许可。当前跨 AppID/首次接入 SQL 屏障、runtime_ready=false 和历史 CI 未完成状态保持。完整归属分类、外部清单与维护 manifest、原子消费切换许可、历史账号凭据解析、旧账号查单/回调/退款/发货/通知，以及前端会话、journal、页面/Browser 和其余全局迁移仍待推进；保留现有 UID、权益、旧单和付款。新提交/合并/推送以本轮最终检查点为准，不扩张阶段26的单笔推送授权。


## 阶段 28：经维护批准的原账号查单、回调与同事务使用证据（2026-10-31）

阶段27提交 `ee55456b` 已按用户明确授权推送并核对 origin/main。本阶段新增显式维护的 `routine_payment_account_policy` 与 `routine_payment_account_use` 两表插件：七列维护 journal 与五列使用记录、总十四约束和四索引、同一不可变函数及四道触发器；App 仅能 SELECT policy，能 SELECT/INSERT use，其余运行角色没有新增授权。正式安装器完整保留 local/caseLock/peer/AppReader 声明，在真实 PG16 维护 LOGIN、认证 backend/OID 和独立门731717下原子安装空表；重复只读，partial、孤儿、owner-only 半安装和目录/权限漂移拒绝，不自动创建批准、不改配置、身份或旧单。完整运行合同见 [原账号付款维护合同](./routine-approved-payment-accounts.md)。

新增 `appendRoutinePaymentAccountPolicy` 维护入口，没有 HTTP 管理作者或客户提交批准的路径。真实维护身份、数据库与角色 OID、操作 UUID、递增 CAS revision、前条记录和有效期由独立域 HMAC 保存；每个 subject 最多完整64版，超限拒绝。account 明确 AppID/merchant、query/notify 用途、active/revoked、opaque ref/version 及材料 commitment；query plan 另明确三域之一、单号、金额/CNY、account及revision。最新撤销、过期、未生效或不匹配不得回落旧版。维护输入、Env字符串和声明在异步事务前捕获，primitive string域拒绝对象转换；已存在原操作回执可在材料撤下后只读重放。

`ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS` 是部署显式 provision 的有界 secret JSON 闭集，不是当前配置、KV 或任意环境变量/文件/URL selector。每组 ref/version 唯一，实际 pair、商户serial、APIv3密钥、商户私钥和平台公钥/id的所有字节参与材料HMAC；不匹配、缺失和非法 registry 拒绝，既不遍历凭据试单也不猜历史。仅 public metadata/commitment进入policy，key/token/secret不进入公开DTO、Queue或使用记录；受限使用记录保留真实provider付款事实（含payer），不将其说成匿名公开回执。

默认Routine对账先提取六个正式请求primitive，按明确query plan选择批准原账号；没有plan才保留既有当前账号查单，present-invalid plan不降级。新增 POST `/api/pay/notify/routine-account/:accountId`，opaque路由值只选择一个已批准notify verifier；真实RSA/serial与AES-GCM之后仍必须核对解密pair。普通四类PHP回调和新付款入口保持原合同，新registry或批准不允许新付款，也不抬起AppID切换屏障。当前账号已经变成B甚至其公开配置全部清空，明确批准的A/refA仍可用实际A密钥查证旧单，无需给旧UID回填AppID。

服务商HTTP与RSA/AES在SQL事务外；短SQL在请求/验签前后复验批准。采证先取得共享account gate，再进入原physical-order/provider/event锁图；原证v1、签名使用记录和callback event/outbox同事务提交，query另绑定真实server claim。尾部以数据库时钟复验有效期和5秒事务deadline。实际付款证据与批准用途独立：错误域或本地金额范围可保留真正provider事实和scopeMatches=false的使用记录，禁止结算；payer不成为买家UID。相同evidenceId/account-record/query-record的重放保留首次use/original和xmin，新批准版可以另建use，不重写旧行。已接受SUCCESS在后置撤销后仍是真事实；结算锁住原订单后仅复核durable当时provenance，不倒取account门或要求现行凭据。已有v1/current-verifier原证可没有sidecar，不能据此声称全部历史对象已分类。

最终选择的正式安装完整文件7项在inputs-01通过；其catalog/installer/audit/runner/正式测试路径至最终版本同字节，root后续service修复不被该正式文件调用。原账号集成完整文件13项在inputs-03通过、无跳过，覆盖currentB/clear、不同真实密钥、实际默认对账/Hono callback/队列消费者、policy/registry/role/serial/pair拒绝、HTTP时独立peer可锁订单、期间撤销、同TX回滚、稳定重放、PENDING、跨订单/跨域、真physical-domain冲突留存，以及维护/callback跨await输入捕获和非primitive拒绝。既有原证/公开来源两份完整文件57项在inputs-03通过；共用服务的完整离线付款文件33项在inputs-04通过；回调路由/event/对账/query identity/runner五份完整单元文件808项在inputs-04通过。所有本轮native集群均有remaining=0及STOPPED。既有NOTICE和预期业务拒绝诊断保留，不声称无stderr。

完整标准unit/runtime两套TypeScript检查最终在inputs-05均exit=0。inputs-04仅新增旧route单元AST修改，原14路径仍同inputs-03；inputs-05仅删除新native测试未用常量，其他14路径不变，原生通过版本中的其他测试/生产行保持原样，不将这个最终类型检查版本冒称另一次原生重跑。生产实现从inputs-03至最终检查保持逐字一致。15条源/测试路径在最终类型pipeline中冻结；提交前另仅移除新native文件EOF多余空行，不冒称再次运行检查。本文和新维护合同在验证后另行追加并纳入提交文件秘密扫描。原始物理输入、各批日志/终态、跨作者审查和下一阶段退款源码地图位于 `/tmp/cinashop-phase28-validation/`。

首轮runtime类型检查3错是state/kind字面量被推断为string，显式返回/行类型修正，未放宽检查。首轮集成9通过/4失败：default reconciler传入带租约字段的宽case DTO，原 `{...raw}` 比较误将内部字段计入授权意图，在HTTP前拒绝；只投影完整六字段后，第二轮13项全通过。独立复核再发现 `String(orderDomain)` 会保留对象引用，改成严格string并加拒绝对象/coercion0次/journal不变断言，随后最终整文件重跑13项通过。单元首轮807通过/1失败为旧源码字符串要求回调校验恰好四参数；改为TypeScript AST核对实际transaction调用的headers/rawBody与profile传播，保留其他断言并整批重跑808项通过。早期结果保留原始终态，不累计重复用例。最终完整unit检查另发现native测试未使用的EVENT_TIME常量，仅删除该常量后重跑两套标准类型检查；生产代码未变，此类无运行效果修改不冒称重新执行原生测试。目录/测试作者参与root服务的跨作者只读复核，不扩张成对自己实现的完全独立审计；未发现剩余必须修复问题。

以上为自有本机PG16、独立实际LOGIN、生产服务/Hono/default消费者与真实Node生成RSA/AES验收，provider/Queue/KV为受控传输替身；没有真实微信、Browser、Workerd/Hyperdrive、生产DDL或部署验收。当前仅query/notify批准，原账号退款/CNSR派发与Financial角色、原账号OAuth/token/发货/订阅仍待接入；完整内外清单、历史对象归属分类与维护manifest、原子切换许可和所有消费者、前端DTO/session/journal/页面及Browser、其余全局迁移与既有CI失败继续未完成。保留现有UID、权益、旧单和付款；未知保持未知，首次接入/实质跨AppID的42501屏障与runtime_ready=false保持。提交/合并/推送以本轮最终检查点为准，不扩张阶段27的单笔推送授权。


## 阶段 29：原账号退款批准与 Financial 数据库协议基础（2026-10-31）

阶段28提交 `fc7d61e3` 已按用户单笔明确授权推送，本轮实际 `git ls-remote origin refs/heads/main` 再次核对为 `fc7d61e369a0f7bed5b1b6a55731a178e9638d46`。本阶段先完成独立可验收的退款协议基础，没有将未完成的原账号退款请求、查单、回调或结算接入运行路径。完整合同见 [原账号退款基础](./routine-refund-foundation.md)。

新增显式三表插件 `routine_refund_account_policy`、`routine_refund_dispatch`、`routine_refund_provider_evidence`：六/六/七列、总25约束/8索引、同一invoker不可变函数及六道行/整表触发器，无序列/default/FK。App仅SELECT policy，SELECT/INSERT dispatch及provider evidence；Admin/Manager/Cashier无新增权限。后两表本阶段没有生产写者或消费者，测试synthetic结构行不成为真实退款原证、CNSR授权或财务效果。正式安装器认证实际PG16维护LOGIN/backend/数据库，保留完整local/caseLock/peer/AppReader声明，以独立731718门原子安装；完整重复不改DDL/ACL/rows/xmin，部分、孤儿、owner-only半安装和漂移拒绝，不自动修复。

新增独立 `appendRoutineRefundAccountPolicy` 维护入口，无HTTP作者。严格固定退款用途refund_request/refund_query/refund_notify，与旧付款query/notify journal不互认；新HMAC域绑定实际库/维护OID、完整policy、前版、CAS revision、UUID和SQL时钟。64版及1MiB完整历史上限拒绝成功前缀；状态、有效期、opaque ref/version/完整材料commitment明确。首await前捕获Env字符串、target primitives与purpose数组，拒绝getter、coercion、sparse/custom arrays和未知字段。全局UUID不可跨account/改意图；已提交原回执在材料撤下后仍可精确重放，撤销不需要秘密材料。latest读取只返回冻结的public policy metadata；撤销、未来/过期、缺材料、篡改或用途不符均不回落，不返回商户秘密、提供方capability或历史归属。

Financial通过另一显式forward以{routineRefund:true}声明完整现行profile，原子取得三新表固定权限及三旧来源的SELECT。`routine_original_payment_evidence`、`routine_payment_account_policy/use`从未新增Financial写权限。旧两目录检查仅接受完整新插件加固定Financial精确联合ACL，不从任意grantee学习权限；新addon同步full Financial/App/Admin审计及gift peer声明，既有manual/second-card声明仍显式保留。新增probe验证真实独立App/Financial LOGIN与session/backend OID、RC/RW、public对象和有限SQL时间；后置纯历史读取无新gate，不把其当fresh provider授权。维护forward仅投影六个正式目标字段，夹具pricingOwner及未知字段不回显，异步BEGIN前捕获完整声明。

最终正式安装器完整文件8项在inputs-03通过，无跳过；覆盖精确25约束/8索引、完整重复、原子回滚、partial/orphan/drift、真实门锁/表锁/无后置门、实际App/Admin/维护拒绝、TEMP阴影，以及真正五类独立LOGIN的Financial升级/rollback/repeat/异步捕获、旧source联合只读权限与后置完整profile/source TEMP反例。维护批准完整7项在inputs-02通过；inputs-03只修正式安装测试的六字段期望，其余14条路径包括所有生产实现与维护批准测试/依赖逐字一致，不把它冒称该7项再次重跑。七项覆盖public metadata/HMAC、首次receipt/xmin、错误材料/撤材料/撤销、CAS/全局UUID/用途/未来窗口、真实role与SET ROLE、维护门、跨await捕获及旧payment HMAC域拒绝。

既有原始付款证据及批准账号恢复两个完整文件26项、八个完整定向单元文件884项在inputs-03均通过；包含真实Node RSA/AES、生产Hono/默认消费者与本机独立PG16，受控provider/Queue/KV传输不等同真实服务商。完整标准unit/runtime两套TypeScript检查也在inputs-03均exit=0。15条实现/测试/运行器路径在整个最终pipeline内冻结；不同输入、重复运行及先前失败不叠加计数。所有本轮native集群均实际remaining=0、STOPPED；既有NOTICE和预期业务拒绝诊断保留，不声称零stderr或历史全量CI绿色。

源秘密扫描初报一项，确认为正式Financial metadata测试的固定无效PEM；依据仓库既有方式，仅给private-key规则、唯一测试路径及整条固定无效材料/platform-ID行添加精确例外。材料/平台ID变动、追加内容、生产/其他测试路径不匹配；不匹配的初次规则仍报一项，最终源复扫零项。该非功能扫描配置与本文在实现冻结后单独纳入提交文件扫描；本例外不是实际私钥、提供方验签或退款证明。

首轮标准unit类型检查真实报TS2322：新ACL元组的数组literal在sort链后丢失tuple推断；改为显式tuple数组再push/sort，未放宽类型或提高资源。首轮新原生联合文件14通过/1失败，Financial正式forward/读取已执行到重复目标比较，测试误将夹具pricingOwner也计入六字段白名单目标；仅将期望改为明确六字段并保留unknown/pricingOwner不回显，后续完整重跑才计后置五profile/source TEMP结果。早期失败与开发18项/7项通过分别保留，不累计重复用例。共有source版本与每批终态可逐字复核。

跨作者只读复核未发现维护服务剩余必须修复问题；root另复核目录/权限forward并要求系统查询pg_catalog限定、primitive-only目标及确定快照排序，均在最终冻结前完成。目录作者参与root服务复核，不扩张成对其自己实现的独立审计。read调用方abort不是公共维护append的callerTx写回滚；正式安装器另有实际callerTx回滚。65行容量与倒退时钟没有单独native注入，不以源码检查冒充这两项执行覆盖。

本轮实际运行生产维护服务/目录/安装器、独立TCP认证LOGIN、HMAC与自有本机PG16，没有真实提供方退款、Browser、Workerd/Hyperdrive、生产DDL或部署。原账号CNSR首次派发与actor原子绑定、固定旧商户request/query/callback及负查单验签、provider证据与mutable投影同事务、durable SUCCESS结算及Financial只读状态/恢复仍待接入；基础批准不会放开旧商户退款。所有用户/UID/权益/旧单付款保留，未知不猜归属；首次接入/实质跨AppID的42501屏障、runtime_ready=false、整体迁移未完成及既有CI失败状态保持。

重新连接本轮环境时，过去记录的/tmp阶段验证目录已不存在；未伪造恢复旧日志，也未把旧结果改称本轮重跑。本阶段原始输入manifest、日志、终态、跨作者复核及后续退款接入设计均留在ignored工作区 `.cache/php-ts-phase29-validation/`，可跨后续继续使用。提交文件另行秘密扫描；新增提交的推送不扩张用户对fc7d61e3的单笔授权。

## 阶段 30：原账号首次退款派发、真实验签结果与 Financial 恢复（2026-10-31）

阶段29的 `e55dd114` 已按用户单笔授权推送，远端 main 已直接核对。本阶段从该点建立独立开发分支，接入实际 App 和显式升级的固定 Financial LOGIN。完整合同见 [routine-refund-dispatch.md](routine-refund-dispatch.md)；阶段29基础文档保留为历史快照。

首次退款继续使用现有实时 actor、review、数量与物理订单边界。原键 provider-admitted 回执先在真实业务事务内落定，再认证完整 Routine 原付款、相关冲突与旧 approved-use 历史，排除 NativeApp 原付来源。首派发 HMAC 绑定实际库/维护名称与 OID、root/child/refund/buyer/store/supplier、原证签名、完整 CNSR 请求/原因/金额、独立退款批准与归档材料 commitment、固定回调 URL，以及 Financial 首 actor/原键/请求 hash/回执摘要；首派发与 REQUESTING 同提交。后续有资格的 actor 可按现有协议恢复，不改首 actor。首回执时间以 epoch 秒规范化，避免连接 TimeZone 改变其摘要。在已证明 Routine 原付款的历史分支，已有 attempt/request 痕迹但缺首派发的旧 CNSR 拒绝补签；没有 Routine 原证的订单保留原路由。

NativeApp namespace 存在时，反证通过独立实际 App RO 连接完成：同数据库名称/OID、不同 backend、真实 App session/backend OID、随机 advisory challenge 与业务物理行前后核对。Financial 不取得 NativeApp ledger SELECT，业务写入仍在原 Financial 事务；全 absent 不建该连接，partial 拒绝。旧 NativeApp 当前账号 equality 检查未移除。其维护安装器增加显式完整 peer/App-reader 声明，首 await 前捕获完整输入，保留 local/caseLock、实际维护 LOGIN/backend、精确目标和完整前后 profile 审计，没有扩张其他 runtime grants。

fresh request/query/notify 分别要求当前独立 refund purpose 批准、完整历史、有效期及首派发固定材料 commitment。显式 `ROUTINE_REFUND_NOTIFY_ORIGIN` 仅接受 HTTPS origin，首派发固定 `/api/pay/notify/routine-refund/:dispatchId`；旧商户签名 POST/GET 及专用 RSA/AES 回调不依赖后来 current config。SQL preflight 关闭后才进行 provider I/O。正向 request/query 校验 CNY、根交易、CNSR 与金额；callback 校验解密 merchant 和对应 event type。官方 [退款查询](https://pay.wechatpay.cn/doc/v3/merchant/4013071041)未要求响应 mchid，可选冲突值仍拒绝；官方 [退款通知](https://pay.wechatpay.cn/doc/v3/merchant/4013071196)要求解密 mchid、未定义 currency 字段，未臆造两者共用字段。旧 generic scalar callback 不能更新历史派发。

lost POST 先 UNKNOWN，再查固定 CNSR。只有生产 RSA 验证后的 HTTP404 RESOURCE_NOT_EXISTS、当前 query lease、未有正向 providerRefundId 历史及新鲜匹配的 refund_request 批准才能同 CNSR 重发；unsigned404、MCH_NOT_EXISTS 和存量负证据不能代替。本轮依据官方 [重试指引](https://pay.wechatpay.cn/doc/v3/merchant/4014959631)保留原 CNSR 与完整请求，不因不确定响应创建另一个退款编号。

真实 provider 验证后才产生单独私有 result proof，绑定首派发、用途批准、source/lease、规范金融结果、首正文 digest、verifier/HTTP 状态及有限时间。immutable evidence 和 mutable payment 投影同退款事务提交；晚期失败共同回滚，本地错误不能造 SUCCESS，首正向 provider ID 不可更换，已接收 SUCCESS 不降级。在途真实结果按发起时批准认证，不因后来撤销丢失。request/query 按规范金融事实去重，lease/JSON 排序/非金融字段变化不新增行；真实重复事实可修复 UNKNOWN。已持久 callback eventId 继续核对首 raw digest。完整集最多128行/2MiB，127条后拒绝新增非 SUCCESS，预留第128条给首真实 SUCCESS；满容量的新 eventId 若为相同已持久 SUCCESS，可 ACK 而不记录该 event 的首 digest。

durable finalize 与 Financial 状态重新核对原付款/完整冲突和旧用途历史、当时批准、首 Financial 回执及已接收结果和 mutable 投影；无须 active policy/current registry/fresh gate，撤销或撤材料不阻断真实成功的本地完成。假 mutable SUCCESS 不能结算。Financial status 改为实际 RR/RO，新增 snapshot-only owner SELECT；原写入 owner 授权仍持锁，实时资格和原键归属语义保留。

本阶段覆盖 App/固定 Financial，未给 Admin/Manager/Cashier 新 addon。完整 bundle 安装后，未 commissioning 的 Admin/Manager 正数 WeChat 执行会被角色 guard 拒绝，包括尚未找到 Routine 原证的订单；原 readiness 可能更早拒绝。它们的既有 status/receipt/replay 尚未转换成此 durable-proof 合同。Cashier 没有独立退款执行 HTTP 路由；有资格的移动操作员进入既有 Financial 流程时仍重新认证并使用固定 Financial 身份。下一阶段应分别接入 Admin/Manager 完整权限、首 actor 回执与状态恢复，不能借 App/Financial 写业务绕过原 actor。

最终6条完整新原生验收在 `inputs-08.json` 通过：独立 A/B RSA/AES、真实生产付款回调/默认消费者、buyer 与 payer UID 分离、实际五类 LOGIN、真实 Financial quote/review/原键/执行、HTTP 期间物理锁释放；覆盖 A POST→query SUCCESS→实际拆单结算、current 配置清空后首次派发、专用回调重放、unsigned/signed404 跨秒同 CNSR 恢复、真实 APP SUCCESS 反证、无 proof 伪成功/假 mutable SUCCESS、晚期 payment UPDATE 失败与证据原子回滚、撤销/撤材料后 durable 状态、重复 PROCESSING/UNKNOWN 恢复及已有正向退款后的 signed404 拒绝。每案都证明到达独立 App RO 反证连接，回滚案用会话锁 witness 证明实际到达晚期 UPDATE。6项无跳过，cluster remaining=0 且 STOPPED，冻结19条候选源码/运行器/测试输入逐字未变。

另有5个完整单元文件187项在 `inputs-unit-03.json` 通过，旧退款原子物化与数量预留两个完整文件102项在 `inputs-native-regression-04.json` 通过；它们对应各自冻结版本，不把重复运行累计。当前代码的 Financial 完整71项与旧 NativeApp 安装器/作者完整9项在 `inputs-native-regression-10.json` 通过；独立退款批准完整7项和正式 Financial 升级完整8项在 `inputs-native-regression-11.json` 通过。两批均 remaining=0 且 STOPPED，输入逐字未变。本轮当前代码两套标准 unit/runtime TypeScript 检查在 `inputs-typecheck-09.json` 均 exit=0，未放宽 strict、提高内存/超时或并发。

开发早期 PGlite 两文件为28通过/63失败/11跳过，63项停在 checkoutPricing readiness，未与 main baseline 对照，不能声称既有故障或绿色；其同名 PG16 文件后来102项全部通过。早期类型批次02的5项错误及06的测试 spy 泛型1项错误保留，未进入 runtime；修正后07两套通过，但晚于07的去重/容量更动仅以最终09为当前类型结论。新 native05为4通过/1失败：反证测试更换 current merchant 后沿用旧 Financial review，被旧 review guard 提前拒绝；仅改为重读真实 review，最终08完整6案通过，没有削弱503、独立连接可达、零HTTP/零写入断言。

跨作者只读复核覆盖 root 编写的派发、provider/容量、核心退款和 Financial 接线；该作者自己的原证/NativeApp/安装器/测试改动不称为独立审计。127/128/129容量、字节边界及其临界并发没有额外 native 注入，也未单独执行已持久同 event 改 body、provider ID/冲突 SUCCESS 或满容量新 event ACK 反例；signed404 已有正向 ID 的新案到达 accept guard，不冒称 retry 冗余 guard 单独覆盖。没有为容量做压力请求。

所有验证使用自有本机 PG16.14、独立 TCP LOGIN 和生产服务/Node RSA/AES，provider 仅受控传输替身；无真实微信、Browser、Workerd/Hyperdrive、生产 DDL 或部署。本阶段未改 rendered UI。用户/UID/权益/旧单/付款保留，未知历史不猜归属；完整归属清单与维护 manifest、旧账号其余消费者、Admin/Manager 接线、旧 attempted CNSR 恢复、前端 session/journal/页面/Browser 以及其余迁移和既有全量 CI 失败继续未完成，首次接入/实质 AppID 切换屏障及 runtime_ready=false 保留。

本阶段精确输入、原始日志、终态、源码复核与下一阶段角色设计保存在 ignored 工作区 `.cache/php-ts-phase30-validation/`。最终22个提交文件含上述19条实现/测试/运行器及3份文档，另按固定 Gitleaks 8.29.0、现行精确规则和 redacted JSON 报告扫描；最终文件 manifest 和扫描终态独立记录，不挪用07旧版本的扫描或历史全库结果。提交/本地 main 合并与开发分支清理沿用用户授权；新提交推送不扩张此前仅覆盖 `e55dd114` 的单笔授权。

## 阶段 31：Admin／门店经理原账号退款、首派发身份与只读恢复（2026-10-31）

阶段30提交 `fdefefe7` 已按用户本轮明确授权推送，并直接核对 origin/main。本阶段按 `.cache/php-ts-phase31-validation/` 的冻结候选输入、各批结果和原始终态记录；完整迁移、生产 commissioning、部署和新提交推送仍分别受各自边界约束。

### 本阶段实际行为与验证范围

新增无DDL的角色元数据证明和显式 Admin/Manager refund addon：Admin身份来自既有named canonical作者/员工/锁合同的联合证明，Manager仅为固定受限角色；不从额外source读权猜身份。正式forward保留完整target/local/caseLock/peer/App-reader声明，只给显式启用角色三旧来源SELECT，以及新policy SELECT、新dispatch/evidence SELECT+INSERT；Cashier无新增退款权限。部分、未知ACL与漂移拒绝，不自动修复。

消费者沿用真实实时actor、review、原键及物理订单边界。Admin/Manager采用format2首派发actor：首回执须由同一业务事务实际追加，HMAC绑定规范化原行、actor/原key/hash、真实role及历史OID；首次记录与REQUESTING同提交，后续合法恢复不改首actor。App回调或跨kind消费者不取得其他角色ledger读权，实际同kind角色才核对自己的首回执。App/Financial原有format1保持原合同。

Admin新增两个真实alias下的POST `/refund/operations/execution`，body仅为 `{version:'admin-refund-execution-v1'}`，沿用原Idempotency-Key与Scope；返回独立execution DTO和固定原七字段receipt。它执行真实RR/RO读取与实时`refund.manage`/密码/状态/realm校验，不发provider请求。Manager既有状态入口改用同类耐久验证。已受理完成重放必须重新验证真实原证/批准历史/不可变provider结果及业务完成，mutable伪SUCCESS不能走shortcut。Admin客户端保留v3原key/hash/owner/session/CAS；查询按钮调用新execution版本，不新建nonce、不进入execute确认。

### 已完成批次，不累计重跑

| 批次 | 实际终态 | 证明范围 |
| --- | --- | --- |
| `native-principals-02` | 8通过，0失败/跳过，exit0；remaining0/STOPPED；输入未变 | named身份/当前OID元数据、Manager缺席、五独立LOGIN一致读取、getter与异步捕获、完整body/flags/owner/trigger及交叉named来源漂移、反向attachment、TEMP、Cashier conditional身份漂移、Manager禁用；不是业务退款执行证明。 |
| `native-upgrade-03` | 9通过，0失败/跳过，exit0；remaining0/STOPPED；输入未变 | 完整五LOGIN正式forward；callerTx rollback、partial/未知/列ACL/函数漂移无repair、实际维护LOGIN/数据库/SET ROLE、独立gate/NOWAIT、Admin-only→Manager完整successor、首await捕获、精确只读repeat及五profile/Cashier拒绝。metadata specimen不是真实付款或批准。 |
| `typecheck-04` | 标准Worker unit/runtime两套与Admin vue-tsc均通过，exit0；32个冻结输入未变 | 旧版消费者/前端类型检查。之后改过native测试并新增pricing兼容修复；不能用本批替代最终版本类型检查。 |
| `native-consumers-09` | 完整新文件6通过，0跳过，exit0，278.02秒；33个冻结输入未变；remaining0/STOPPED | 真实生产Hono/auth/服务、五独立受限LOGIN、正式addon、实际付款RSA/AES/默认消费者与旧用途原证、受控provider传输的Admin/Manager退款端到端。 |
| `unit-client-10` | 完整文件35通过，exit0，0.93秒；33个输入未变 | 客户端原键/hash/CAS与独立execution parser；8种非完成状态继续pending、余额UNKNOWN、缺失/跨version/extra字段拒绝及合法完成。它本身不挂载Vue按钮，不单独证明零execute HTTP。 |

Foundation两批各16条路径的输入与最终33条manifest对照，所有被记录的foundation source/test/helper字节保持一致；只有运行器因后续精确测试白名单而变化。其8+9是各自实际批次的结果，不冒称在consumer09再次执行。最终consumer测试SHA256为 `8716257d29a0b27de83fa3ecea0e938ba9f4157e432d009e73e7d419ee4ced7c`。

consumer六案分别覆盖：非root Admin实时菜单权限、旧A签名POST→真实query SUCCESS→拆单完成及两个status alias；current清空下Manager真实quote/create/review/execute、专用回调、RR/RO状态和原键重放；Admin161先受理丢响应后Admin162按新实时review合法恢复且首actor/首行xmin保持；实际权限/realm/password/scope/跨店/staff/review拒绝且无provider派发；Admin/Manager假mutable SUCCESS的UNKNOWN状态和completed replay503；同root真实APP SUCCESS原证冲突与独立实际App RO verifier到达。原买家UID与付款payer身份未混同，另核对payer原行和旧bindings保持；HTTP期间实际peer可锁定root/child/refund，未把提供方I/O放进SQL事务。

Manager旧pricing审计漏列已正式commissioned的 `local_payment_case_lock_v1(text)`，通过本轮真实HTTP定位并窄修：仅`public/shared-shop`、固定actual Manager current=session=backend与PG16成立后，完整`inspectLocalPaymentCaseLock(...).runtimeReady`才认可实际OID；无新ACL、函数执行、门或递归full-profile。最终case2真实COST101漂移仍使pricing拒绝，finally还原100后才运行真实Manager报价和派发。

### 早期失败与纠正

`typecheck-01`实际exit2，两处新leaf类型未满足`Record<string,unknown>`约束；runtime检查未启动。只给Context/RoleRow显式extends该约束，未cast绕过或放宽strict。

`native-consumers-05`为2通过/4失败，214.98秒，32输入未变：两个Admin主线已通过，Manager两案停在实际报价503，另外两案因真实assisted producer有限库存耗尽而未到目标断言。测试只给确切product70/SKU1一次性stock40，继续由真实producer/消费者扣减；增加安全公开msg以定位，不mock业务或扩大资源。诊断06、07各1失败/5跳过（139.27/138.95秒），精确确认pricing的catalogReady/callerSafe/requiredPrivileges为true，仅noUnreviewedDefinerRoutine=false，缺少的是上述唯一实际case-lock OID；没有通过盲加权限绕过guard。

完整08为5通过/1失败，273.38秒，33输入未变。失败实际是已撤销批准并撤下registry后的**第二次**same-packet回调误期望204；首次回调204、真实materialization、Manager耐久status与same-key完成重放已经通过。测试改为撤销前重放204并检查不可变行/业务稳定；撤销后新回调400，同时已接受结果、原receipt、完成业务及耐久查询/重放仍稳定。fresh notify仍需要有效`refund_notify`和材料，durable completion不需要，二者与phase30既定合同一致。未修改callback源码或时间限制；先前8秒截止仅为基于错误失败位置的未证实诊断候选，不是实际故障。纠正后才有上述完整09六案通过。

### 浏览器实测与传输边界

root使用CUA in-app浏览器，在1280×720自有本地UI合成传输夹具验证：一次真实页面execute动作、刷新恢复原记录、两次同key的独立execution-version查询；UNKNOWN保留pending，之后SUCCESS解决。`/tmp/php-ts-phase31-ui-result.json`记录passed=true、executions=1、queries=2、三次相同key、两个查询body仅新version、errors=[]，并明确`syntheticTransport:true, actualDatabase:false, actualProvider:false`。console为空来自本次浏览器验收说明；实际SQL、角色和RSA/AES证明来自独立原生六案，不归给浏览器夹具。此前本机夹具遗漏统计脚本GET `/api/get_script`，补上空JavaScript响应后重新从头验收；一次额外CDP诊断等待约404秒超时，夹具按既定8分钟期限停止。它们没有形成产品缺陷证据，未修改产品以绕过错误，也未使用其他浏览器fallback。最终页面身份、非空DOM、无框架overlay、控制台、UNKNOWN/成功截图及交互均通过；无手机尺寸、其他浏览器或真实后端UI验收。

### 兼容回归与基线核对

`native-compat-11` 四个完整文件为66通过/2失败、0跳过，exit1，432.23秒，33条候选输入未变，remaining0/STOPPED。其中旧App/Financial v1派发完整6项、Admin操作HTTP完整31项、Admin决策完整8项均通过；Manager完整23项为21通过/2失败。此批不是全绿，不把后续重复运行相加。

线下收款的失败链是既有 `offline→applyStoreOrderPayment→assertLocalPaymentAdmissionTx→assertRoutinePaymentAttemptReady`；subset夹具缺少完整Routine attempt存储。不能仅凭静态文件未变称其既有。本轮另建detached精确 `fdefefe73fe68e87cb7e810b7a81e5d5b55329a8` 基线、运行同一完整Manager文件：`native-baseline-12` 为22通过/1失败、0跳过，exit1，34.52秒；唯一失败就是相同线下收款503。6356个跟踪Worker文件hash不变，基线跟踪内容保持干净，remaining0/STOPPED；临时工作树已安全删除。没有取消或放宽生产付款存储检查，此既有故障仍未修复。

另一项Manager synthetic status夹具曾使用非生产 `CNSR_MANAGER_SEEDED_*`，被本轮新增精确CNSR校验正确拒绝。生产作者既有生成格式为 `CNSR+refundId`。仅将该夹具首行校正为真实格式，同时新增改回错误CNSR必须UNKNOWN、再恢复原正确CNSR的原生反例，保留无provider/noRoutine的legacy声明及全部owner、金额、materialization、假SUCCESS和隐私断言。没有删除失败案例或修改生产guard。`native-manager-13` 完整23项为22通过/1失败、0跳过，exit1，72.41秒，37条候选输入未变；退款状态的PROCESSING、错误CNSR/金额UNKNOWN及真实物化后的SUCCESS均通过，唯一余留失败与精确基线相同；remaining0/STOPPED。11之后所有生产实现/新原生测试/运行器字节保持不变，只改上述旧测试及文档。

最终 `typecheck-final-14` 标准Worker `npm run typecheck` 的unit/runtime两套及Admin `vue-tsc --noEmit`均exit0，360.26秒，37条冻结候选输入未变化；保持既有8192堆限制、单外层共享串行锁和原超时，没有并发重型检查。上述所有业务源码／测试／运行器从13至14保持相同字节，本节在最终类型检查之后单独追加。

最终提交文件另按固定Gitleaks8.29.0、现行精确规则、既有ignore和redacted JSON扫描；最终文件manifest与结果独立记录，不挪用typecheck04、前阶段扫描或历史全库结论。提交／本地main快进合并／安全分支清理沿用用户明确授权；新提交推送不扩张此前仅覆盖已推送 `fdefefe7` 的单笔授权。

### 审查与未执行边界

跨作者只读复核覆盖root的联合ACL/正式forward、format2 actor/dispatch、Manager消费者、policy角色扩展、pricing窄兼容及Admin前端；发现的尾部actor后deadline检查、Manager已完成split原键可达性、无Financial新actor源TEMP边界和pricing OID缺口已在最终冻结前修复。Admin六路径、principal leaf和三份新native由该复核者参与编写，对其自身部分仅自审/root复核，不扩张为独立安全审计。

尚无旧事务首receipt注入的xmin专门负例、Admin↔Manager跨kind接手续退、同名角色新OID重commission、pricing新分支单独SET ROLE反例、故意慢尾8秒/倒退时钟注入、无Financial新actor组合的专门原生执行、127/128容量边界运行或多会话高负载。旧Manager余额结算与Admin HTTP余额/本地完成兼容案例通过，但不能把它们称为新Admin execution状态入口的余额/零现金/Alipay专门验收。未运行真实微信账号/生产provider、生产DDL、部署、Workerd/Hyperdrive；未给Cashier扩权，未回填历史归属。用户/旧bindings/权益/旧付款保留，跨AppID屏障、`runtime_ready=false`、整体PHP→TS迁移未完成及既有历史CI状态保持。


## 第32阶段：原账号单履约发货（2026-10-31）

真实 App 消费者在领取 shipping Queue 前验证 SQL 身份，以验签 JSAPI SUCCESS 原证确定原 AppID、商户和实际付款人，再用专用维护批准读取归档 AppSecret。当前 B 配置、买家最新绑定、INIT 和 PREPAY 均不授权旧单发货。新 TS 的 `product.storeName` 与旧 PHP 的 `productInfo.store_name` 都从实际购物车快照读取，描述数量使用物理商品行。

三个维护者所有的不可变存储保存 CAS 策略、首次派发与 TLS 回执。外部请求前的 SQL issuedAt 固定批准时点，应用时钟只参与有限偏差检查。HTTP 在 SQL 事务外，已知回执与投递投影同事务提交；可能已发出的未知结果保留 UNKNOWN。当前单履约准入明确拒绝拆分家族，所有全局就绪标记仍为 false。

隔离验收使用完整五个真实 LOGIN、正式安装器与维护 API、真实 Admin 下单/发货、RSA/AES 回调、默认付款和 outbox 消费者。各批次只证明各自冻结版本，不累计重复运行：

| 批次 | 实际结果与范围 |
| --- | --- |
| `native-upgrade-01` | 存储／角色／正式安装器8项通过，115.89秒；相关安装器、目录、审计与测试字节此后保持不变，运行器只追加有限测试白名单。 |
| `native-account-01` | 当时版本的批准／token8项通过，135.51秒；之后新增了准备时 `now<created_at` 和历史读取时 `at<created_at` 两处拒绝保护，不冒称本批覆盖了这两条新负例。 |
| `native-compat-01` | 旧账号／退款／通知来源64项通过，439.59秒；对应共享批准读取、NativeApp反证与投递接线此后未变，后来的发货实现及描述修复另由最终批次验证。 |
| `final-02` | 当前单履约原生完整7项、3文件通知单测35项、标准Worker unit/runtime与Admin类型检查全部通过，465.78秒；23条冻结输入无变化。 |

原生批次均为零剩余夹具且本地PG集群已停止。最终批次覆盖实际付款人区别于最新绑定、current配置清空／在途撤销、应用时钟领先SQL、UNKNOWN不重发、源事实／批准拒绝、真实NativeApp冲突、晚期投递写失败时证据共同回滚，以及其他四个真实运行账号在领取前拒绝。HTTP期间另有独立会话证明物理锁已释放。七项没有单独执行最终分包准入负例或上述两条倒退时钟读取负例；当前正常批准、token及历史回执链已执行，不能扩张为这些反例的覆盖。

早期真实业务批次因未读取TS `product.storeName` 而在HTTP前失败；修复为规范／旧格式快照及物理数量后单履约七案通过。`final-01` 的7+35先通过，随后Worker unit类型检查报告通知查询未选择 `cartNum` 及关闭分包后的两处不可达访问，runtime/Admin未启动；补齐两个真实查询字段并删除死分支后，才有上述 `final-02` 全部通过。没有降低strict、增加内存／超时或并发重型检查。文档在最终批次之后补齐；实现、运行器与测试的冻结字节保持不变，提交文件另做完整秘密扫描。

尝试的3项拆包验收暴露基础 App 与 Admin 都缺少同城任务读取合同。该缺口没有通过额外 raw grant、维护者生产者或删除 fence 绕过；本轮分包保持关闭，正式跨角色合同另续。充值、会员、付款后自提、物流更正、退款退役分代和旧 SKIPPED/UNKNOWN 维护恢复继续列为未完成。本轮无生产 DDL、部署或真实微信调用。


## 第33阶段：同事务同城冲突 reader 与原账号 express 分包（2026-11-01）

阶段32的 `aa3315eb` 已按用户对该 SHA 的明确授权推送，实际远端 main 已核对。继续增加显式 PG16 维护 forward，不修改基础迁移，不临时给 App/Admin 增加同城表 raw SELECT。专用 NOLOGIN owner 的固定 SECURITY DEFINER 端口以完整源目录、命名角色/OID、固定 body 和精确 ACL 证明身份；App/Admin/Manager 必须分别选择，Manager 后继只能显式增加。正式五角色合同在前后审核，精确重复无 DDL，漂移和半安装不修复。声明在首次 await 前快照；调用者回滚会一并撤回 DDL/ACL。

运行请求先持付款根锁，再取 try-only 共享731721门；固定函数保持 store_delivery_order 的 SHARE ROW EXCLUSIVE NOWAIT 锁至业务提交。未结同城任务、超500行或非法上下文拒绝，维护 forward 在表锁前取排他门，避免反向等待。定价与角色审计只豁免精确核对的函数 OID，不扩大 profile。真正同城 writer 的完整合同及真实同根任务仍单独验证，reader 不提供 allowedJobId 逃逸。详情见[读取合同](fulfillment-city-conflict-readers.md)。

真实 Admin 下单、RSA/AES 原付款回调、默认付款、实际 GET/PUT 拆包发货端点与 App outbox/Queue 现已接通 express 分包。完整2..15叶子家族须与原付款金额、UID、渠道及物理状态相符。新意图只可在前一真实 code=0、仍未完成且包裹严格增加时追加；旧包裹、承运商、联系方式与条目保持原值。明确非零部分请求重试保持首次 body/upload_time，即使另一个包裹已物理发货；UNKNOWN 不重发且阻止后继上传。10060012/10060019 两个系统忙碌码加入既有五次上传尝试边界，运力 API 重试规则不变。

官方[发货信息录入](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)本轮读取版本为2026-05-08，确认 express 的 mode2、最多15包、必填 is_all_delivered、更新需更晚 upload_time、完成后或模式/物流切换计入重新发货。当前“未完成且旧条目不变才追加”的规则是基于这些条件的保守实现，不代表真实微信账号验收。已完成后的更正与重新发货仍关闭。

共用物流分类同时修正 TS/PHP 历史的“所有 shipping_type!=1 视为自提”问题：仅2是自提，1/3按明确 deliveryType 分类，未知及收银4拒绝。旧 PHP 的这一分支不能作为正确业务依据。type3目前有分类单测；真实拆包用例使用type1。源码未找到可证明门店归属的 TS 平台→门店生产者，不能用维护者设置 store_id 或传入客户端 store_id 来冒充 Manager 发货 HTTP 验收。

| 冻结批次 | 实际结果与范围 |
| --- | --- |
| `native-reader-02` | 正式完整18项通过，141.76秒，12条输入不变；五LOGIN、App/Admin首装→显式Manager后继、真实三角色端口调用、回滚/重复/参数快照、源/owner/body/ACL漂移、NOWAIT/ROLE/RCRO与安装后的TEMP/search_path。其foundation及相关审计字节至最终批次未变。 |
| `native-split-03` | 当时版本的真实业务完整10项通过，172.59秒，14条输入不变；后续增加两个忙碌码及共用物流分类，最终结果以下一行替代，不重复累计。 |
| `final-04` | 当前完整发货原生12项、三文件单元36项、标准Worker unit/runtime及Admin类型检查全部通过；17条实现/测试/夹具输入全程不变。 |

原生集群均记录 remaining=0 和 STOPPED；本地受控 HTTP 期间独立连接证明家族与 notice 的物理锁已释放。最终12项保留阶段32七项原账号、时钟、UNKNOWN、权限与原子回滚回归，并覆盖真实部分→完整两包、UNKNOWN阻后继，以及-1/10060012/10060019三种原体重试后完整上传。专用18项的同城冲突任务是明确维护测试标本，不声称执行真实同城 provider。所有重型检查使用一层共享串行锁，未增加内存、超时或并发。

首轮 `native-reader-01` 为3通过/6失败：五个漂移子操作塞入同一个默认5秒用例导致超时，后续锁及未安装函数错误级联；回滚用例实际完成安装再回滚，末尾TEMP用例当时能力缺失，不能计作已安装证明。只把有限子场景拆成独立用例，保留原默认限制后，才得到完整18项通过；原失败保留，不累计通过或误称产品目录修复。原始日志、输入及终态位于本地 `.cache/php-ts-phase33-validation/`；本节与合同文档在最终验证后补齐，实现/测试字节仍匹配冻结输入，提交文件另做秘密扫描。

未单独执行15/16包边界、连续三次以上扩包、运力列表删除旧公司、reader维护与fresh/recovery业务竞态或退款物化家族负例。Manager的函数能力与五角色共存已验收，Manager发货HTTP/可信门店归属作者仍未闭合。充值、会员、付款后自提、更正、退款代次、旧SKIPPED/UNKNOWN维护恢复、前端会话/journal/Browser及既有历史CI问题继续待推进。本轮无生产DDL、部署、真实微信调用或新的UI验收；保留现有用户、UID、权益、旧单与付款，跨AppID归属屏障、runtime_ready=false及完整迁移未完成状态保持。


## 第34阶段：真实付款 outbox 的原账号商品自提发货（2026-11-01）

阶段33的 `6c64e86e` 已按精确授权推送并直接核对远端。继续迁移固定 PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 的付款后自提作者：Pay.php:104–106 在 shipping_type=2 的付款成功时触发物流4，核销不会再次触发。官方[发货合同](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)本轮实时读取为2026-05-08版本，确认自提4/统一1/单条列表及只有快递支持mode2；付款业务时点来自固定PHP源码，不把它称为官方要求。完整blob及当前链路证据在本地 `php-paid-pickup-source.md`。

TS在实际 paid effects 事务的供应商分配/次卡有效期之后，原子创建真实 `order.paid:<root>` 对应的 wechat_shipping 投递，mark为 paid_pickup_shipping；与源COMPLETED一起提交。没有新增DDL、事件种类、运行grants、假delivery.notice或“已发货”状态。消费要求同源COMPLETED、真实受限App、完整原付款与归档批准、实际payer及NativeApp命名空间存在时的独立App反证。当前配置、最新买家绑定和渠道标签仍无旧付款authority。

完整自提家族按原付款根聚合为一条logistics4/mode1，供应商分区不变成快递mode2；买家/门店/金额/原商品数量全部一致。immutable事实排除status、verifyCode及剩余核销计数，真实部分/全部核销后仍只重试首次body/upload_time。新普通delivery.notice不再创建第二条type2 shipping，历史原件保留。真实paid Queue helper在提交后尝试派发同eventKey；仅Queue派发失败不使已提交付款重跑，既有扫描恢复。完整合同见[自提说明](routine-pickup-shipping.md)。

只读复核发现并修正两项共享paid兼容风险。第一，已有完整证明的预售退款物化恢复仍须完成原paid effects；新的fresh shipping会拒绝其退役家族，不能反过来永久阻断旧财务恢复。当前只在已证明recovery路径跳过新发货stage，其后结构/financial proof原样执行，源事实与不可变回执矛盾仍整笔失败。第二，真实付款服务允许SQL金额0保留weixin标签，但没有提供方交易；现在精确跳过零款的新意图，保留完整local guards、付款effects与幂等，不把零款标签升级为原证。

| 冻结批次 | 实际结果与证据范围 |
| --- | --- |
| `native-pickup-01` | 初版完整8项真实自提原生通过，143.10秒，12条输入不变；其后新增上述兼容保护、本地零款及提交后Queue派发，不能冒称本批覆盖后来的改动。 |
| `final-02` | 完整预售退款数据库基线42项、自提原生10项、既有发货原生12项、五文件单元48项全部通过；随后Worker unit类型因日志outcome枚举TS2322失败，runtime/Admin未启动。667.85秒，16条输入无变化。 |
| `recovery-03` | 更正唯一异常日志枚举后，受影响的Queue完整8项、标准Worker unit/runtime及Admin类型全部通过，323.29秒；16条当前输入全程不变。 |


自提10项覆盖真实Admin下单、RSA/AES/default付款、三叶平台/供应商聚合、后置任务回滚/同源重放、真实员工部分/全部核销后的原体重试、UNKNOWN不重发、四个实际LOGIN在领取前拒绝、撤销/源冲突、真实NativeApp冲突，以及独立的本地零款和实际paid Queue helper→ENQUEUED→shipping Queue→SENT接线。第9项是本地零款guard，不称提供方回调；第10项使用真实outbox处理器和派发端口，未用mock替代已提交事务。外部传输时独立peer NOWAIT持有家族与投递行锁，App无idle transaction。

预售完整基线保留旧yue场景，新增4个明确合成SQL weixin/type2/open1标本：whole/partial恢复及不可变回执/矛盾源拒绝。该旧fixture的付款标记和legacy provider SUCCESS为显式测试输入，实际checkout/finalizer/materializer/财务复验与事务执行，但不是提供方验签、原账号回执或生产LOGIN证据；不与10项原生链合成crypto覆盖。重复批次不累计为新增通过。

`final-01` 的预售基线为40通过/2失败：两个负例试图UPDATE不可变退款回执，正式append-only触发器以42501拒绝，尚未到达预期业务断言；后续阶段没有启动。修正后先明确断言回执不可变，再只改变普通cart的预售合同，使其与保留的回执矛盾；直接recovery读及完整paid effects都必须拒绝，未删除触发器、放宽ACL或修复证据。原失败和清理记录保留，不累计为最终通过。

final-02 的类型失败仅来自新Queue日志的outcome=deferred不在既有OperationalOutcome集合；更正为failure。逐字逆向证明16项冻结候选实现/测试/夹具中，除这一异常日志字符串外均与final-02相同；付款、源、外部请求、租约和控制流未改。recovery-03只补跑受影响Queue8项及完整两套Worker/Admin类型，不把它冒称又一次全原生重跑，重复8项也不计为新增测试。

原生集群均记录remaining=0和STOPPED；预期拒绝的低基数日志保留。所有重型检查在一个外层共享串行锁依次执行，沿用每个native600秒、单worker与现有内存/超时，没有并发重型验证。最终日志、输入、结果及独立复核位于 `.cache/php-ts-phase34-validation/`；三份文档在验证后补齐，源码和测试仍匹配冻结字节，提交文件另做完整秘密扫描。

本轮没有新的UI、Browser、Workerd/Hyperdrive、生产DDL、部署或真实微信验收。64/65叶与200/201商品边界、供应商家族核销竞态、Alipay零款/游客本轮专案、开关切换竞态、五次尝试终止/1MiB预算边界、退款代次发货和历史SKIPPED/UNKNOWN维护恢复尚未执行。充值/会员的真实领域意图、其余旧账号消费者、完整归属清单/维护manifest/原子切换许可、前端session/journal与Browser及既有CI问题仍待推进。保留现有用户/UID/权益/旧单/付款，未知归属不猜，跨AppID屏障、runtime_ready=false和整体迁移未完成状态保持。


## 第35阶段：真实充值／会员付款的原账号虚拟发货（2026-11-01）

阶段34 `a2b26985` 已按精确授权推送并直接核对远端 main。本轮迁移固定 PHP 的充值、会员付款后虚拟发货作者：真实领域创建、RSA/AES 回调或签名查单的默认消费者，在钱包/权益事务中原子写入 COMPLETED 的签名领域源与延迟投递，提交后只入队不透明引用。源使用真实 recharge/membership 主体，新的派发 format2 对 domain/subjectId 单独签名；商品 format1 解析及 HMAC 字节合同保持。内容使用原充值价或保存的会员天数/永久权益，原付款人和原账号批准不由当前配置、最新绑定或新套餐代替。详情见[虚拟发货合同](routine-virtual-shipping.md)。

显式 PG16 维护 forward 只接受精确旧14/15并升级完整16/17；两列 nullable 主体、封闭 CHECK、精确部分索引和事件列表共同成立。Supplier/DB007 后继与完整五角色前后审计保留。Financial/Cashier 的既有整表授权自然覆盖新列，但没有新增 grant；它们的逐列审计只在完整维护归属后接受这两个后继字段。新作者和消费者仍核对实际 App。旧库 inactive Stage 单独证明命名目录、current/session/backend OID、四门及可选存储 absent/full；新16/17与历史 Read 不降级，partial/TEMP/错误账号继续拒绝。

SQL stagedAt+10 决定初次延迟，Queue 使用数据库计算的剩余 delay，消费者在进入 PROCESSING 前再次核对 SQL 截止时间。事务外有限等待的实测包含应用时钟领先40秒仍 busy。财务提交后的 Queue 失败由普通扫描恢复，不重做入账；明确忙碌保持首次 body/upload_time，丢失 POST 为 UNKNOWN 且不自动重发。明确响应的签名观测和对应终态同事务保存；UNKNOWN 不伪造响应。领域源是既有可变 outbox 中受 HMAC 验证的快照，不是新增 SQL 不可变提供方账本。

| 冻结批次 | 实际结果与边界 |
| --- | --- |
| `runtime-native-06` | 当时完整13项通过，307.82秒，22输入未变、remaining0/STOPPED；随后新增旧库 inactive 兼容分支，以下最终批次重新执行。 |
| `final-09` | 74项单元、148项既有金融PG、正式12项、真实充值/会员13项、旧自提10项和快递12项全部通过；Worker unit/runtime与Admin类型通过，22条输入全程不变。三组原生均remaining0/STOPPED。 |

正式12案是结构协议证明，维护SQL标本不是付款事实。真实13案执行领域生产者、两类回调/查单、赠款/权益、晚期投递失败共同回滚及重放、Queue恢复、固定请求重试、UNKNOWN、四非App账号领取前拒绝、事实矛盾/撤销批准及独立App会话发现真实APP原证冲突。HTTP期间独立连接可取得物理金融/投递锁且App无idle事务，原UID22付款人和旧bindings保持。旧148项另在既有有限PG白名单运行，不把纯单测模式跳过视为覆盖。

保留失败记录：首类型8项诊断修正后，types07又报4处正式测试用了不同事务类型，改用真实项目withTx适配器而非cast。formal01为3通过/9失败；diagnostic02为1失败/11跳过，实际新CHECK/索引正确，失败来自Financial/Cashier把新两列视作未知；精确完整后继识别后formal03为11通过/1失败，唯一问题是测试期望的嵌套peer target含夹具专用pricingOwner。runtime04在批准初始化因多余声明失败、13项未执行；runtime05为1通过/12失败，后者由凭据恢复顺序错误级联。两处夹具纠正后才有06完整通过。final08误选三份需PG文件作纯单测，74项通过但3个suite失败、148项未执行；最终批次用真实PG运行并验证全部，不累计重复通过。

原生、类型和单测在一层共享串行锁顺序运行，保持原单worker、内存、每组native600秒及case限制。代码/测试冻结证据位于本地 `.cache/php-ts-phase35-validation/`；本节和独立合同在最终验证后补齐，执行文件字节保持，提交文件另做秘密扫描。交叉作者审查覆盖运行链，schema/正式测试作者对其自身部分是自审及root复核，不称独立安全审计。

本轮没有生产DDL、部署、真实微信、Browser或Workerd/Hyperdrive验收。永久会员专案、所有损坏format2字段、容量与重试终止边界、发货开关并发、退款代次发货、更正和历史SKIPPED/UNKNOWN维护恢复仍未完成；完整归属清单/切换许可、前端session/journal及既有CI缺口继续推进。保留用户/UID/权益/旧单/付款，未知归属不猜，跨AppID屏障、runtime_ready=false和整体PHP→TS迁移未完成状态保持。此前对a2b26985的推送授权已履行，本轮新提交需按具体SHA另行推送授权。


## 阶段36：真实数量退款后的余单原账号发货

新增[退款代次发货合同](routine-refund-shipping.md)。真实 Admin 快递下单和原账号 RSA/AES 付款，经 Financial quote/review/CNSR 首派发及签名查单 SUCCESS，同事务生成退款物化，再由 Admin 余单实际发货和真实 delivery outbox/opaque Queue 触发上传。退款成功本身不是发货作者；没有正向维护 SQL 补 paid、退款/发货事件或首次上传证据。

App 只读验证完整退款及 fulfillment branch 代次：精确 legacy/guest 实体目录/保护函数与维护owner、申请指纹、不可变档案、实体及商品数量/行身份、连续前驱/成对分支、实际退款payment和经生产验签器持久化的成功投影。仅 proved selected/whole 叶退休，活跃叶仍有真实履约事件。保持根付款全额和付款人、完整叶价款及数量守恒；零款读取仅承认申请档案的成熟纯积分条件，不把裸零额/无payment作为授权，也不修改普通正价微信零退款禁令。纯积分零款正向运行仍未证明。

新商品退款回执显式format3，保存有序退款/分支引用和active/retired ID/HMAC代次摘要。旧format1、format2具体decoder和原商品payment-source函数逐字不变。原payment-wide来源边界不变；旧UNKNOWN/无成功提供方结果阻止新intent，不能换版本/key重发。同一已证明代次仅按既有成功partial严格扩包，前包逐项不变、时间递增；跨代次、format1→format3不被当作更正许可。沿用所有status0子单参与的固定PHP完成判断，因此退休status0仍使is_all_delivered=false，不能称为全部完成。锁后只读退款原证，不调用退款写者/资金结算或新refund mutex；HTTP在事务外，可能已POST的丢失响应仍UNKNOWN。

最终验证 `final-04` 全六阶段退出0：74项单元、Worker unit/runtime与Admin类型，9项新真实组合原生、既有express12/自提10/虚拟13，共44项原生。8个冻结输入在运行期间不变，3个自有PG16 cluster均remaining0并STOPPED；最终执行文件字节另与提交扫描清单核对。首轮原生8通过/1失败的失败是错误测试假设普通正价微信可申请零退款，既有作者正确拒绝；修正用例，补齐纯积分零额读取条件后重新完整验证。final03在74单元通过后为此中止，不充当完整通过记录。源回执/hash/原始日志与详细限制在本地 `.cache/php-ts-phase36-validation/`；文档在最终运行结束后补齐，提交文件另做秘密扫描。

本轮没有生产DDL、部署、真实微信、Browser或Workerd/Hyperdrive；只读Manager来源地图也不等于已验收Manager正向链。64/201容量、整退兄弟分区、历史soft-delete、新格式完成回滚、清空当前配置与纯积分零款正向仍未专门运行。物流更正/永久partial完成、历史SKIPPED/UNKNOWN维护恢复、可信门店配送来源、完整归属清单/维护manifest/原子切换许可、前端session/journal及既有CI缺口继续未完成。保留现有用户/UID/权益/旧单/付款、未知不猜归属；跨AppID屏障、runtime_ready=false和整体PHP→TS迁移未完成状态保持。b19dfe03已按精确授权推送，本阶段新提交需具体SHA的新授权。


## 第37轮：UniApp 定向依赖与迁移验收链

本轮接续已推送的 `fcfaaf40`，完成 [UniApp 消费者与公告合同](uni-d3-consumer-upgrades-20261101.md)：官方 follow-redirects1.16.2，仅三个 named-API minimatch 消费者改用官方11.0.1，Glob/TestExclude 保留真实 callable3.1.5及未解决版本范围告警。旧25个直接 tuple、23个禁回来源不变；新1244003禁回，1244012仅绑定root3的单节点与精确传播图。门禁仅细化错误字段诊断，不接受空via、info或未知图。此前CI的centra原始条目未取得，不能声称历史具体根因已经确认。

本地类型、原工具链100文件/2723次执行及23后续组/1029次执行、6/21/4边界检查、三端资源构建及产物4通过。full-02第43阶段QR因清单字符串静态误命中而失败；修正测试冗余字面量，保持扫描与完整具名清单SHA不变后，final-03的D3离线94/live、QR5、实际运行图13、Uni/PC共享14/16全部通过。两个批次的源码差异只有该D3测试；1044项pre-run、运行中补充8496项和final-03的8495项哈希证据分别保存。整包中断、两处旧测试假设失败和QR失败均留存，不算整批通过。精确提交CI及原20分钟预算待后续验证，PC/Kefu历史审计缺口仍保留，没有部署或设备/真实供应商调用。

用户已选择下一步规则：仅后台受控分配到门店，保留不可变分配回执。本轮未实现该作者。后续最小正向闭环需从真实平台单、原账号付款和后台分配，经Manager专用整单履约入口到既有Queue/App首上传；技术设计优先保留平台root/store0及买家、付款、财务、库存事实，继续保留通用订单财务授权。存量有效店长身份的验收bootstrap与新业务事实须分别说明。整体迁移、归属切换和运行时就绪条件仍未完成。


## 第38轮：门店履约分配的不可变存储与 PG16 后继

阶段37的 `26a43cc7` 已按该 SHA 的精确授权推送并直接核对远端。[精确提交 CI](https://github.com/cinagroup/cinashop/actions/runs/41381002305) 的 UniApp job 已成功，03:04:00Z→03:21:36Z，共 17 分 36 秒，满足既有 20 分钟预算；主合同及安全回归步骤均通过。历史 centra 的具体失败条目仍未取得。最后观测时 secret scan、Admin、Supplier、PG16 catalog 和 workerd 成功，PC/Kefu 在完整依赖树审计失败，Worker 两个分片仍在执行，不能称整体 CI 全绿。

本轮实现[门店分配存储合同](store-order-fulfillment-assignment.md)。维护者所有的 16 列表保存 grant/revoke 结构、操作 ID、前驱、平台财务 store0、封闭购物车快照和 revision/hash；唯一约束防重复序号/同前驱分叉，不可变触发器拒绝 UPDATE/DELETE/TRUNCATE。hash 和 SQL 默认时间均不构成授权或提供方证明，前驱存在、连续性、状态转移、来源和真实后台权限仍须未来作者证明。本轮没有开放 Admin 分配 HTTP 或 Manager 分配单发货。

显式维护 forward 在首次 await 前捕获完整有界纯数据声明，绑定真实 PG16 维护 LOGIN/数据库/OID 和五角色前后 profiles；只增加 Admin SELECT/INSERT、固定 Manager SELECT，App/Financial/Cashier无新增权限。完整目录指纹、owner/body/ACL/附着对象同时核对；半安装及漂移拒绝，不修复。精确重复持物理 ACCESS SHARE NOWAIT fence 后只读复验；调用者回滚撤回全部 DDL/ACL。旧 city/refund forward 显式传递新声明，基础 profile 不变。

当前新原生 `native-04` 完整 24 项通过，203.65 秒、8502 冻结输入不变、remaining0/STOPPED；五真实 LOGIN、回滚/重复/ACL、source 边界、实际上下文、gate/表锁/TEMP/目录漂移，以及安装后旧 city/refund 正式后继均执行。最终 `final-07` 三组全部 exit0：35 项兼容原生、Worker unit/runtime 类型、四文件 40 项单元，687.95 秒、8498 外层冻结输入不变。新原生复用前逐项核对无变更，不累计重复执行；每个原生集群均清理停止。没有新增 Admin 前端代码，因此没有把前阶段 Admin 类型结果列为本轮验证。

首个 canonical-01 空指纹诊断为 1 失败/22 跳过，不算通过。native-03 为 5 通过/19 失败：正常部署 target 的 pricingOwner 元信息被严格键集错误拒绝，未安装引发后续级联。修正为捕获有界纯数据但只提取身份，额外元信息不参与授权，再修正夹具的 peers 快照，才有上述完整新原生通过。原失败及冻结证据保留，不据早期拒绝断言虚构目录覆盖。最终两套类型是修正后的重新验证，沿用单层共享串行锁、单 worker、既有内存/case/每阶段 600 秒限制。

本轮只读独立复核未发现范围内阻塞缺陷，没有独立重跑测试或扩张为安全审计。记录位于本地 `.cache/php-ts-phase38-validation/`，文档在最终执行后补齐，提交文件另做逐文件秘密扫描。后续 Admin 作者的隔离缓存草稿未接入应用，不能算业务完成。真实分配作者、Manager 专用整单快递、完整正向付款/Queue/App 链、前端会话/journal/Browser、归属 manifest/原子切换及既有 CI 缺口继续待推进。本轮无生产 DDL、部署、真实微信或业务 HTTP/Browser/Workerd 验收；现有用户/UID/权益/旧单/付款保留，跨 AppID 屏障、runtime_ready=false及整体 PHP→TS 迁移未完成状态保持。


## 第39轮：真实 Admin 门店分配作者与原回执恢复

阶段38 `c172d016` 已获精确授权、推送并直接核对远端 main。本轮接通[后台分配作者合同](admin-fulfillment-assignment-author.md)：可信 Env 显式完整peers、缺配置关闭，两个Admin URL前缀共用真实鉴权和独立Admin LOGIN。review/stores/commit分别按order.view/order.manage；只有精确receipt GET/HEAD允许当前原作者在角色移除后恢复最小回执，HTTP commit不豁免管理权限。严格有界JSON、UUID原内容幂等和head/revision/source CAS，失败不留下预占终态，缺失保持unknown。

写入持实际Admin/role barrier、请求锁、63842及物理根行，cart/refund/waybill空集合有表fence，目标门店与cart行锁定，同城冲突用正式reader。当前只接TS普通已付未发货平台整根快递，保留root/store0及type0/1原库存事实。私有来源hash绑定实际根/路由/cartInfo，保存source为封闭cart投影；hash不是签名，也不提供完整财务、purchase-origin或原账号付款证明。整链64项/1MiB；改派/撤销只追加回执，撤销保留原source并可在真实发货后执行，不倒退履约事实。

最终 `native-04` 完整11项通过，123.78秒，8510冻结输入不变、remaining0/STOPPED；真实Admin下单→RSA/AES默认Routine付款→App paid消费→实际production router双mount的grant/reassign/revoke、幂等/CAS、实际备注writer stale、真实Admin发货后撤销、角色失权恢复、错误LOGIN/缺Env、空waybill/根行锁、真实SQL尾部caller-abort回滚、type1及真实满送赠品最终总数量均执行。五种来源反向标本是明确维护SQL篡改并恢复原字节，不冒称正向业务证据。使用本地KV/Queue/内部ID和回调传输适配，不是createApp全栈或真实provider验收。

首轮 `native-03` 10项全失败，115.43秒、输入不变、remaining0/STOPPED。静态复核也漏检了正常下单和赠品都会写financial_version的事实；首版错误拒绝所有这类快照。只接受真实writer的checkout-line-finance-v1并核对id/cart_num、保留refund_generation/legacy/unknown拒绝后，新增反例再完整通过11项；原失败、原复核和后续聚焦独立复核分别留存。最终 `final-07` 的Worker两套类型和两文件33项单元全部通过，336.67秒、8506外层冻结输入不变，运行前核对native-04字节无变化。原生、类型与单元不重复累计；沿用单层共享串行锁、单worker、原内存/每阶段600秒/case限制。

文档在最终执行后补齐，当前14个提交文件另做秘密扫描。没有Admin前端修改，不挪用旧Admin类型或Browser结果；没有生产DDL、部署、真实微信、Workerd/Hyperdrive。Manager专用履约回执和正式后继、waybill能力适配、当前批准/员工scope与源证明、完整Manager HTTP→Queue/App首上传、前端session/journal/Browser仍未实现。缓存中的下一阶段设计不是实现。保持通用订单财务归属、promotion capability、现有用户/UID/权益/旧单/付款；跨AppID归属屏障、runtime_ready=false及整体迁移未完成状态保持。

CI界限：26a43cc7的Uni成功17分36秒已实际取得；该旧run之后由新main推送取消，Worker分片没有成功终态。c172d016的[新run](https://github.com/cinagroup/cinashop/actions/runs/41384583531)的secret/Admin/Supplier/PG16/workerd成功，PC/Kefu完整依赖树审计失败，两个Worker分片最后观测仍在执行。Uni主type/test/build成功16分15秒、安全回归成功，但job随后取得cancelled终态：03:43:35Z→04:03:52Z，共20分17秒，editorial步骤中止。未以timed_out替代实际cancelled字段，20分钟预算的稳定性仍未解决，整体CI不能称通过。本轮新作者提交的远端CI尚未运行。

## 第40轮：实际 Manager 分配单整单快递与成功回执

阶段39 `e11d6de4` 已按具体SHA授权推送并直接核对远端main。本轮接通[Manager分配整单合同](manager-assigned-whole-express.md)：专用26列不可变成功回执、显式五角色权限后继及实际Manager LOGIN准入；可信Env缺失关闭，真实导出router在主应用catchall前挂载。review须当前员工scope与有效Admin grant同意目标门店，commit在物理根锁后验证完整批准链、CAS、原cart/source和承运商，并由既有Supplier整单服务写入。付款根与财务store0、原type0/1库存来源不变，不伪造旧门店GUC或扩张promotion权限。

order、标准发货状态、补充Manager audit、唯一真实PENDING delivery.notice和新回执同事务提交，写后检查根/原cart、实际notice hash与回执readback。原键原内容只重放成功，不重新发货；后台后来撤销批准不倒退过去履约。员工失去角色后仅原用户GET恢复最小回执，unknown不是未应用，没有abandon/换键终态。waybill通过正式能力取得并核对实际SHARE锁，Supplier共享超时保留外层更窄限制。提交后仍由既有App outbox/Queue派发，实际actor是App；旧notice不虚构Manager/assignment原证，App不独立读取或核验新回执授权。

`author-04` 完整10项真实业务通过，164.05秒：Admin assisted checkout→默认RSA/AES Routine付款→App paid消费→真实Admin grant→导出Manager HTTP与独立LOGIN→SQL回执/notice→Queue/App旧账号A首上传；明确读取当前配置B，验证原A凭据/付款人和实际App dispatch/provider证据。type0/1、错门店、改派/撤销stale、明确损坏cart反例、真实根锁、其他五LOGIN、缺声明、角色撤销owner恢复及尾部实际SQL除零后全回滚/同键重试均执行。`storage-05` 完整101项通过（1目录捕获+100结构），143.37秒；结构SQL标本不冒称业务履约。`regression-06` 既有Admin分配11项与原账号快递Queue12项分别122.70/205.38秒通过。所有原生输入不变、remaining0/STOPPED。

最终 `final-07` 为41项单元、Worker unit/runtime两套类型检查全部通过，33.91/196.51/96.32秒、合计326.75秒，8525输入不变。`canonical-01` 原捕获22.17秒、源内空pin本身不算正式核对；其后固定实际PG16指纹，完整storage套件匹配。`types-02` 原14条编译错误保留，修正共享抽取import及测试savepoint类型；`author-03` 在fixture过完整shipping-policy target初始化失败、10项全skipped，143.17秒、清理完整，只收窄测试四身份字段而未放宽生产接口。文档后补；暂存格式检查后只从fulfillmentAssignmentRuntimeDeclaration.ts末尾删除一个多余LF，与已扫描前像逐字节核对，其余可执行源码和全部测试字节不变，不重复重型检查，提交文件重新秘密扫描。独立作者外复核核对通过日志与用例，未报阻塞问题，不冒称独立重跑或安全审计。

本轮为自有PG16、实际独立TCP LOGIN、production服务/导出router与本地provider/Queue/KV传输验收；无createApp全栈、Browser、Workerd/Hyperdrive、生产DDL、部署或真实微信验收。前端Admin分配面板、Manager分配待办、专用session/journal/Browser未接通；旧门店列表仍按真实store_id读取，不会因grant读到平台store0单。真实退款余单/分包/自提/虚拟/物流更正与历史UNKNOWN不属新Manager入口；完整维护manifest/原子切换、前端及整体迁移继续未完成，现有用户/UID/权益/旧单/付款、未知不猜归属、跨AppID屏障与runtime_ready=false保留。

阶段39的[远端CI](https://github.com/cinagroup/cinashop/actions/runs/41387142973)已观测UniApp success（04:12:58Z→04:30:39Z，17分41秒），Admin/Supplier/PG16/workerd/secret也成功，PC/Kefu依赖审计仍失败，Worker全量分片尚无本轮取得的成功终态。旧c172的20分17秒cancelled保留，未提高预算或删检查，整体CI仍不能称通过；本轮新提交与推送以最终检查点为准，需要具体新SHA授权。

## 第41轮：Admin分配与Manager整单快递页面、待办和恢复

`2681f27bb2a2322395d08374bc4145f1ff9b7831` 已按用户精确授权推送并直接核对远端main。本轮接通[实际页面与验收合同](assigned-fulfillment-ui.md)：Admin订单详情批准/改派/撤销，独立登录后原作者恢复路由；UniApp新增后台分配订单页，当前门店的专用游标待办、最新review、承运商/单号及显式整单发货确认。待办10+1前瞻均核对完整批准链与根身份，不扩张旧财务门店列表，不将发现结果冒称来源审阅。付款根、财务store0和原type0/1商品库存来源不变，没有新增SQL权限。

两端独立journal先持久化原请求再POST，未知保留原键/内容；H5 Web Locks、原字节CAS、会话/token/账号ABA/门店/路由/隐藏与晚到响应栅栏。Admin缺安全UUID/Web Locks关闭写入，角色丢失后仍可最小owner GET；Manager旧context失败不遮盖恢复，完整25字段公开回执关联保存intent/hash。原生Uni只覆盖单JS运行时，不宣称多进程互斥。页面区分发货记录和渠道上传。

manager-02原生完整15项（旧10+新5）通过196.63秒、输入不变、remaining0/STOPPED。final-06完整Admin64项（新14+旧50）6.11秒、正式Admin构建93.62秒、Uni61项（新19+旧42）17.12秒、Uni类型27.53秒/H5构建37.14秒、Worker unit/runtime类型218.18/109.63秒全部通过；8535外层冻结输入不变。旧merchant回归的失效.cache/过时页数修为固定Git审计真实98路径及父提交153路径，154页仅新增assignedOrders；原断言含义保留，无依赖升级。manager-02的Uni60/1失败和frontend-04的Worker5条类型错误均保留；final-06重跑修正后的全部受影响图，不挪用旧通过结果。

browser-07为一个真实createApp/CUA Browser用例内9阶段，通过401.84秒，remaining0/STOPPED。两笔实际下单→默认RSA/AES付款回调→App paid，由实际产品DOM/API执行4次Admin批准/改派/撤销和1次Manager发货；两次真实提交后的响应丢失、角色撤销后的owner GET恢复、Queue/App旧A凭据/付款人首上传与重复只上传1次均核对。3392源码及Admin358/Uni557构建文件终态逐项匹配，cart/商品/SKU全值不变，根只允许预期7项发货变化。两端页面身份、非空/无框架覆盖层、实际交互、桌面1163×858及移动full-page375×1324截图与无横向溢出均核对；Uni仅既有两条vendor router弃用警告，Admin无warn/error。截图和Browser证据保留在仓库外/tmp，执行摘要在本地忽略缓存。

browser-05确实失败521.05秒：监督漏读Vitest缓冲的READY，只在窗口末段完成Admin两阶段，六分钟窗口到期；没有完整成功evidence，也不是SQL死锁。仅修复仓库外监督程序实时读取ready.json，在未变源码、原时限/内存/单worker/单层共享锁下重跑通过。独立只读复核核对host、客户端和执行证据边界，没有独立重跑或安全审计声明；文档后补，最终提交文件另做秘密扫描与暂存字节核对。

本轮provider/Queue/KV、session bootstrap/角色开关/提交后丢响应为明确本机适配；没有真实登录表单、原生设备、Workerd/Hyperdrive、生产DDL、部署或真实微信验收。App仍不独立读取新Manager回执/分配权限。完整归属manifest、原子切换、其他迁移和CI缺口继续未完成；用户/UID/权益/旧单/付款、未知归属不猜及runtime_ready=false保留。2681的[远端run](https://github.com/cinagroup/cinashop/actions/runs/41390906709)截至2026-11-02 05:43:04UTC仍运行，Worker两分片仍unit；Uni实际cancelled20分17秒、原因未确证，PC/Kefu依赖审计失败，不能称整体CI通过。新提交推送仍需具体SHA授权。


## 第42轮：UniApp CI 分组容量与精确历史工作流证据

阶段41 `20f180ae24a88f40fe6d0a35c26d2cae0204ca01` 已按具体 SHA 授权推送并直接核对远端 main。本轮完成 [UniApp CI 分组合同](uniapp-ci-capacity.md)：原 12 条 core 命令及共享安全回归、完整十条作者链分别在两个独立 runner 执行，每组继续 20 分钟。唯一 `UniApp build` 使用 always/needs 严格要求两组 success，取消/跳过/失败不能放行；其他前端/审计、锁文件安装、固定版本与权限不变。旧2681 run 的 core 成功16分59秒，随后作者中取消，job实际cancelled20分17秒，原因未确证；不能因此声称新预算已实际通过。

49项实际YAML/真实Bash分组合同、69项D3离线、完整十条作者1087项均通过；作者组含分组验证439.21秒，为本机已有锁定依赖，不含fresh npm ci。D3尾断言修为严格security-backports→Manager原脚本、各一次，并保留六种反例。新增workflow-only历史读取器及完整两层来源，逐字节核对20f/b874和两旧merge来源，不修改旧7.1MB证据/PIN或旧断言正文，仅两条import接线；其他历史绑定差异保留。最终worker-04的新38项、既有容量5项、旧workflow2项和unit类型通过，类型198.6秒，8541输入不变；旧套件456项未选中，不宣告全绿。worker-03的Uint8Array解码类型错误及原失败保留，仅修正解码后重跑整个受影响图。按身份去重1250项，不重复累计49项重跑。

各批输入/原日志与来源核对在本地.cache/php-ts-phase42-validation，单层共享锁、单worker及既有内存/时限保持。独立只读复核未报范围内阻塞问题，非独立重跑/安全审计；文档后补，提交文件另做秘密扫描。完整当前core/live审计/安装/三端构建/Browser未在本轮重跑，远端新SHA的实际容量仍待验证；PC/Kefu审计及其他历史CI/绑定缺口、完整归属manifest/原子切换和整体迁移继续未完成。无生产DDL、部署或真实提供方调用；既有用户/UID/权益/旧单/付款、未知归属不猜、跨AppID屏障与runtime_ready=false保持。新提交推送需具体SHA授权。


## 第43轮：实际 Uni CI 失败后的门店入口与主题宿主修复

阶段42 `6d7ff3dfde5e09aab875d5e8a7090bba49f30fbf` 已按具体SHA授权推送并直接核对远端main。本轮修复前序提交20f实际Uni job的两条失败：运行时注册表精确补齐assignedOrders，与154条真实注册路径同步；MerchantShell现有唯一ThemePage内增加entry插槽，旧订单页入口处于context门禁之外，正常/失权/匿名仍可进入独立恢复页。没有把入口放进会隐藏的默认slot，也没有双主题宿主。全页主题负例按实际import依赖核验，独立ThemePage断自身宿主仍失败；新三例执行真实SSR主题祖先、可见性、导航及hide守卫。详见[页面合同追加](assigned-fulfillment-ui.md)。

targeted-01四脚本116项、Uni类型、H5/MP/App三端及4项产物通过；完整工具链按未改父package的100个Node子文件逐个串行及全部24条原npm尾链，在两批中成功覆盖3774次执行。toolchain-02在1200.98秒达到整组上限，前119组通过，第120组64通过/1取消、exit124，原失败保留；进程确认终止、全图未变后，tail-03以原600秒每命令/1200秒整组和单层共享锁完整重跑最后5组，47.41秒通过。覆盖计数仅前119与后5组，不把取消尝试记通过，也不称单批预算成功。执行次数不是唯一声明身份，定向重叠不重复加数。没有fresh npm ci或live audit，也不能以本地时间替代远端新SHA预算终态。

本轮CUA实际H5窄UI验收151.66秒：正常门店/403/匿名旧页点击新入口，新页重验或登录提示，403原用户GET原回执恢复；557份构建和8542份冻结输入终态匹配，桌面内容宽1224、移动319/334均等于scrollWidth，移动请求375×844、full-page截图360×1340。22个明确合成接口请求、零业务POST/未知API；截图、观察和原日志在仓库外`/tmp/php-ts-phase43-browser-e694d0d0-eca0-4ed7-8a47-655264d78d38/`（截图另在`/tmp/cinashop-phase43-shots/`）。会话/角色状态/既有journal及回执为明确本机HTTP fixture，不是PG/createApp/真实登录/业务写入重跑，不沿用第41轮原生闭环作为本轮结果。独立只读复核未报范围内阻塞；文档后补，提交文件另做秘密扫描。

PC/Kefu原审计与旧历史绑定、完整归属manifest/单次许可/原子切换及整体迁移继续未完成；只读后继地图不计实现。既有用户/UID/权益/旧单/付款、财务store0、原库存、未知归属不猜、跨AppID屏障与runtime_ready=false保持。没有生产DDL、部署或真实提供方调用；新提交推送需具体SHA授权。

## 第44轮：PC / Kefu 最小依赖后继与完整 live 审计

阶段43 `64bfb958e3ae27216036cb028c2c1a4e1a58386d` 已按具体SHA授权推送并核对远端。针对真实CI中PC / Kefu完整审计失败，实际完成[最小依赖闭包后继](pc-kefu-dependency-audit-20261102.md)：两端仅对language-core限定minimatch11.0.1，PC follow-redirects升级1.16.2；锁仅5 / 4条预期记录变化，其余187 / 160条（含根）、锁顶层及Vue / vue-tsc / core / TypeScript / axios原版本保持。没有force fix或放松完整审计门槛。

三个公共消费者用例实际核对官方37文件源码 / 锁SRI、真实language-core模板生成的data-* / aria-*与named ABI，以及32 / 64有界optimizer；经现有common gate只接PC / Kefu。PC重定向采用与Uni相同的跨realm、object / array及同 / 跨源8种组合，保留凭据剥离与正向保留检查。

先离线复制公共缓存生成锁并reify，源缓存不变；validate-03以49.94秒通过。原npm预检双配置同为/dev/null失败留存，未开始安装、锁未变，改两个独立空配置后继续。随后fresh-04实际两端npm ci（禁安装脚本）、完整官方npm audit、实际公共回归 / 单测 / 类型与Vite构建全部通过，65.36秒、8542冻结输入不变。本次PC191 / Kefu163总依赖审计全严重度为0。fresh公共19 + 29、PC367 + 9、Kefu30共454次执行，加另行Uni共享重定向2次为456；离线重复不加数。本轮审计时点结果不替代新提交CI，也不宣称永久无漏洞。

原日志 / 审计JSON / 冻结字节 / 精确差异与静态独立复核留在本机.cache/php-ts-phase44-validation，最终文件另做秘密扫描。全流程单层共享串行锁、单worker，沿用600秒每命令 / 1200秒整组。未重跑Browser / PG / 全Worker；无业务页面 / API / SQL / 工作流改动、生产DDL、部署或真实提供方调用。64bfb958作者组远端成功5分30秒，所读core快照仍运行；新SHA全CI / 正常安装脚本、完整归属manifest / 单次许可 / 原子切换及整体迁移仍需推进，跨AppID屏障与runtime_ready=false保持。新提交推送仍需具体SHA授权。

## 第45轮：独立订阅通知批准、模板与 token 基础

`ab90aa8cd7429b78bc9ae265bc0c97d2d5e0e727` 已按精确授权推送并直接核对远端。[该提交 CI](https://github.com/cinagroup/cinashop/actions/runs/41404561360) 的 PC / Kefu 完整审计与构建成功，Uni core 17分16秒、authors 5分43秒及唯一聚合 `UniApp build` 均成功，实际分组预算已有该 SHA 的远端证明。原历史失败和本地整包超时仍保留；最后读取时 Worker 两分片仍在运行，不能称整套 CI 全绿，也不替代本轮新提交 CI。

本轮实现[订阅通知账号合同](routine-subscription-authority.md)：新六列不可变策略表和显式 PG16 维护后继，双来源目录核对维护者 / App OID；App 仅 SELECT，不扩大其他业务角色。真实 LOGIN / 目录 / ACL / 触发器正文、固定 gate 顺序和五角色前后审计均封闭；缺失不启用，半安装和漂移拒绝且不修复。维护 UUID / CAS 与版本签名链绑定数据库、AppID、独立 `subscription_send`、有效期及有序模板清单，旧批准不能借用 shipping / payment / current 凭据。

独立 Env 材料注册表与 commitment、不具可复制性的 prepared 能力、实际短 App 事务 fresh 复验和独立 token 缓存命名空间已实现。HTTP / Redis 等待不持 SQL gate；固定 GET、禁止 redirect、32KiB / 严格 UTF-8、8秒硬期限、迟到响应清理及统一脱敏。历史策略读取只证明留存和声明窗口，不证明历史最新、已发送或 fresh 准入；没有通知发送消费者 / POST 接线。

native-02 新原生 9+15 共24项通过，265.31秒；compat-04 既有身份7 / 发货8 / 通知来源45共60项通过，333.41秒；final-03 单元139通过 / 2个既有PG条件跳过，Worker unit / runtime 类型检查通过，314.55秒。139已包含3个 mocked-admission 超时资源单测，不能重复计数或当作PG批准证明。三个完整批次各8554输入运行中及补文档前一致，五个成功原生阶段均remaining0 / STOPPED。native-01的7通过 / 2错误fixture peer期望失败保留；只修测试期望后完整重跑，首轮账号阶段未执行。原日志 / 冻结摘要在本地.cache/php-ts-phase45-validation；独立只读复核不冒称重跑或安全审计，文档后补，提交文件另做秘密扫描。

本轮为自有PG16 / 实际独立TCP LOGIN与生产服务代码，provider / Redis为受控本地传输；没有生产DDL、部署、真实微信、Browser或Workerd / Hyperdrive。旧单原SUCCESS付款来源、精确AppID+UID接收人归属、模板批准与首次attempt / result尚待组合，历史策略不能作发送证据，UNKNOWN不能换键重发。完整维护manifest / 单次许可 / 原子切换和整体迁移继续未完成；保留用户 / UID / 权益 / 旧单 / 付款，未知不猜归属、跨AppID屏障与runtime_ready=false保持。此前推送授权只覆盖ab90，本轮新提交需具体SHA授权。

## 第46轮：既有 A 发货通知的原付款、接收人与模板组合

`af314e5ba8f671c768eac4d03e67fa48f1923377` 已按精确授权推送并直接核对远端 main。[该 SHA CI](https://github.com/cinagroup/cinashop/actions/runs/41409626276) 的 PC / Kefu 审计与构建、Uni core 11分07秒 / authors 5分10秒 / 唯一聚合3秒均成功；最后取得 jobs 快照时 Worker 两分片仍在执行，不能称全 CI 绿色，亦不替代本轮新提交 CI。

本轮完成[发货通知来源准入](routine-subscription-delivery-source.md)：固定商品付款根的完整 Routine 原证 / 历史付款 use 读取与同事务 WeakMap proof，独立 subscription 摘要域，不依赖 shipping 批准或当前 merchant / Mini 配置。真实 App 短事务按七个低序维护 gate 先取共享 try-only fence，再稳定商品 / cart / 充值 / 会员 / outbox / delivery 来源，核对根 family、跨域同号 / transaction、原发货事件与数据。NativeApp 使用独立真实 App SQL 连接、数据库 / OID / PID / 持锁 challenge 和完整缺失反证；不借用 Financial 或发货身份。

只按原 AppID + 买家 UID 的完整归属 / witness / 活用户 / 精确 binding 选择接收人，与该账号独立批准的1458 / 1128模板核对。只接受本来已记录 A 的 event / delivery 及原 target / template / render，不重解释 B pin 或补历史缺失。复用原纯 renderer，新读取限200行 / 1MiB且纳入cart解析 / SHARE NOWAIT fence；legacy staging输出不变。返回冻结 facts / request 与 sourceDigest，每次重验重新读取完整事实；读取能力与 token 字符串都不是 POST / 历史发送证明。

native-03 新普通快递10项通过，153.48秒；真实Admin HTTP checkout / delivery、独立批准原账号RSA/AES付款回调、App paid / notice outbox、实际code2Session归属作者与A token GET组合，payer≠owner、当前B / 空配置、最新裸B和无归属UID22均核对。错误principal / pin / 目标 / 模板 / 原渲染、UNKNOWN、金额 / 同号变化、模板替换 / 撤销、真实验签Routine / APP冲突和实际锁占用均拒绝。native-02真实beforeAll因cache mock漏Admin读取导出失败，134.90秒、10项跳过，PG清理完整；仅补importOriginal保留真实导出后完整重跑，不放宽生产鉴权。手机号连续性与用户 / 地址 / 裸绑定明确bootstrap，不冒称真实SMS / 登录表单 / Redis鉴权。

compat-04 既有发货8 / 通知45 / 订阅15共68项通过，268.40秒；final-05单元139通过 / 2个既有PG条件跳过、Worker两套类型检查通过，316.31秒。三批各8559输入运行期间及补文档前一致，四个成功原生阶段均remaining0 / STOPPED；只计最终217次成功 / 2跳过，不把final-01或旧deadline单测重复加数。交叉只读复核、原日志 / 冻结摘要 / 失败记录在本机.cache/php-ts-phase46-validation；没有独立重跑或安全审计声明，文档后补，提交文件另做秘密扫描。

仅ordinary express动态正例已运行，split / send / city与64 / 200容量未单独证明；退款拒绝 / 成团 / 非微信单及旧缺来源意图不由本reader处理。新来源未接入现有通知作者或Queue / provider POST，没有immutable attempt / result；未来必须同事务fresh来源+首attempt、SQL外POST与不可变结果恢复，UNKNOWN不能换键重发。无新增生产DDL / grant、部署、真实微信、Browser或Workerd / Hyperdrive环境验收；完整维护manifest / 单次许可 / 原子切换及整体迁移继续未完成，用户 / UID / 权益 / 旧单 / 付款、未知不猜归属、跨AppID屏障与runtime_ready=false保持。新提交推送需具体SHA授权。


## 第47轮：原账号订阅通知的实际 Queue、首 attempt 与不可变结果

`5b4074f24e9c28526ff86b1c88ceb376951bbff9` 已按具体SHA授权推送并直接核对远端main。[该SHA CI](https://github.com/cinagroup/cinashop/actions/runs/41415138730) 最新快照中，PC/Kefu、Admin/Supplier、PG16、workerd、秘密扫描与Uni core 12分35秒/authors 5分11秒/唯一聚合均成功；Worker两分片仍运行，不能称全CI绿色或替代本轮新提交CI。

本轮完成[既有A pin发货订阅的实际派发](routine-subscription-delivery-dispatch.md)。独立双不可变表、7/5列、15约束/5索引/4触发器与显式维护后继，App只新增SELECT/INSERT，其他业务角色无新增数据权限；完整真实LOGIN/目录/ACL/默认/前后五角色声明审计，半安装/漂移拒绝。维护沿用逐SQL/idle5秒与锁1秒，fresh业务事务仍总龄5秒。整个可选namespace缺席保留legacy，任意对象存在则须完整actual-App就绪后才改claim，材料撤回不退回legacy。

实际Queue consumer组合完整历史、原付款/精确owner/模板及token后fresh同事务来源，先存验签attempt、关闭SQL后以一次性能力固定POST。能力期限从最终SQL前monotonic与精确SQL剩余策略窗口确定，COMMIT确认不重置。每POST一UUID/ordinal，eventKey+channel source_key跨delivery ID约束；任何无result历史先停UNKNOWN，旧Admin confirmRetry和换ID不能重新发送。40014等明确拒绝先落结果，下一独立attempt才刷新token；最多5次，永久拒绝停止。

Provider固定路径/禁止redirect、fetch+stream共8秒、32KiB/严格UTF8/int32，取消迟到结果并脱敏；私有结果绑定attempt签名，结果/投影同事务CAS。POST中撤销批准仍留存当次明确成功，历史策略不作任意时刻latest或发送证明。SQL结果写入/投影失败原子回滚，COMMIT确认不确定则保守停且不推断已回滚；人工状态不制造不可变提供方证据。

native-03 新存储9/实际Queue业务13共22项通过，332.34秒；compat-04旧来源10/通知45共55项通过，163.54秒；final-05单元166通过/2个既有PG条件跳过、Worker unit/runtime类型通过，335.92秒。三批8567输入运行中及补文档前均匹配，四PG均remaining0/STOPPED；只计最终243次成功/2跳过。27新provider单测明确mock admission，仅证明传输资源，不作PG批准/平台订阅同意证明。实际业务正例经过真实Admin鉴权/下单/发货、独立批准原账号RSA/AES回调、App paid/notice outbox、code2Session归属和Queue claim/不可变作者，payer≠owner/当前B/latest裸B；HTTP/Redis/KV/Queue受控，phone和配送员为明确fixture输入，不冒称真实SMS/登录/微信接受。

首轮storage-02为3通过/6失败，新增维护总龄5秒错误导致约8秒全审计回滚及级联未安装失败；移除误套总龄后完整重跑，既有单SQL/idle/锁限值和全部审计未放宽。final-01的166/2后标本unused/union类型失败保留，修正后最终两套类型通过。交叉复核修正慢提交确认能力窗口与send配送员/手机号标本，未改变生产鉴权；5个主流程文件独立交叉读、另6由复核者编写并由主流程另读，不称全11独立审计或重跑。原日志/冻结/失败/复核在本机.cache/php-ts-phase47-validation，文档后补、提交文件另做秘密扫描与暂存/提交字节核对。

新动态正例ordinary express/send，split/city及容量未单独重证。legacy通知作者仍未迁移；原本B pin和旧缺来源不重解释为A，其他事件/非微信单/历史恢复、完整归属manifest/单次许可/原子切换及整体迁移继续待办。无生产DDL/Env切换、部署、真实微信、Browser或Workerd/Hyperdrive环境验收；用户/UID/权益/旧单/付款、未知不猜归属、跨AppID屏障与runtime_ready=false保持。此前授权仅覆盖已推送5b4074f2，本轮新提交仍需精确SHA推送授权。


## 第48轮：切换后实际发货作者、签名请求与 App staging

`a400366b181a2303a452bb906d9acf40a443b883` 已按具体SHA授权推送并直接核对main。[其CI](https://github.com/cinagroup/cinashop/actions/runs/41423671523)末次快照10成功、Worker两分片仍运行，不作全CI绿色或本轮新提交证明。

本轮接通[新实物发货通知作者](routine-subscription-notice-author.md)：真实A付款后切当前B/裸绑定B/全局模板B，再由Admin express/send或受控分配Manager金融store0整单express发货；业务原事务只签封闭request2与实际LOGIN/OID，不读私有账本、不选择接收人。App同事务核对完整原付款、精确A owner、独立最新1458/1128批准与材料，再写绑定delivery/event/request的签名staging。旧A/B/空/缺pin和并发赢家保持原版本/签名，不升级；namespace全缺席才legacy，部分目录/缺writer材料/可回滚元数据SQL失败记录unavailable2，无新DDL/grant。

claim写入前以纯pg_catalog锚定真实App身份，不把完整目录反解器放在源锁隔离之前；hint若被外部owner改变，锁定V2行在写入前补验。八个共享try-only gate、outbox/delivery SRE NOWAIT与完整fresh源在真实Mini SAVEPOINT内，争用/SQL错误回滚后短信/站内信仍可提交。有效request缺consumer key/scope、owner/独立模板时仅Mini使用既有FAILED退避/8次上限；重试保留原已提交渠道/站内信，不随手机号/模板变化重渲染。确认无效或unavailable请求为空目标终态skip，配置修复不升级。intent解析先descriptor-only有界JSON快照；staging是可变投影，仍由phase47首不可变attempt和fresh一次性能力决定每次POST，UNKNOWN不重发。

最终regression-09为19新原生+13旧Queue+10来源+45通知共87通过，554.04秒；final-10单元198通过/2既有PG条件跳过、两套Worker类型通过，321.80秒。两批各8574输入运行中及补文档前一致、四PG remaining0/STOPPED，只计最终285次成功/2跳过；单层锁、单worker、命令600秒/整组1200秒及既有内存限值保持。32新纯codec单元不作SQL批准证明；新原生是导出的真实路由/服务链，HTTP/缓存/Queue受控、phone等为明确fixture输入，无真实微信或浏览器证明。

保留final-01 mock hook清理失败、author-03快照及源锁揭示问题、native-05延后安装漏传city peer而13未执行、compat-07 legacy SMS无payload兼容失败；分别修正后以上述同一最终图重验，不放宽安装器/准入、不累计中间通过。4主流程独立交叉读、另2源3测试由复核者编写主流程另读、余7窄diff，不称全16独立审计或重跑。本机.cache/php-ts-phase48-validation保留完整日志、冻结、失败和字节/扫描记录，文档在全部重验证终态后补。

split/city、其他角色与容量未单独动态重证，退款拒绝/成团等作者、非微信单原账号发送、完整manifest/单次许可/原子切换及整体迁移仍未完成。未执行生产DDL/Env切换、部署、真实微信或Workerd/Hyperdrive环境验收；旧用户/UID/权益/订单/付款保持，未知不猜归属、跨AppID屏障及runtime_ready=false保留。此前授权仅覆盖已推送a400366b，本轮新提交仍需具体SHA推送授权。

## 第49轮：原账号退款拒绝1451、Admin／Financial与真实Queue

`b68619873f870c6d448d76973a7603befe6093b9`已按具体SHA授权推送并直接核对远端main。[其CI](https://github.com/cinagroup/cinashop/actions/runs/41437973088)末次快照10成功、两个Worker分片仍运行，不作全绿或本轮新提交证明。

本轮完成[原账号退款拒绝订阅通知](routine-subscription-refusal-notice.md)：真实A付款及买家申请后切当前B／裸绑定B／全局模板B，正式Admin operation或实际Financial拒绝并留不可变业务回执。业务原事务只签独立request3，绑定五个原业务字段、实际作者LOGIN/OID、数据库/维护者scope与原申请15字段摘要及拒绝原因/时间；不读私有账本或选择接收人。App额外稳定实际refund/refund_payment，核对原SUCCESS付款、精确A+UIDowner、NativeApp排除和独立subscription_send的1451批准，写独立staging3后接既有Queue attempt/result。旧发货2及MAC域/摘要排列不改，旧pin/缺失/赢家不升级，无新DDL/grant。

真实reapply新建refundId和当前hold，旧通知绑定原申请而不要求当前hold0或order.refundType3；1451仍用原整单金额和商品标题。Financial验证实际留存完整payload，避免重新捕获B pin；缺失业务事实为ValidateException并保留既有rollback-rejected，真实SQLfault继续传播。Mini源锁、缺owner/模板/材料或晚intent UPDATE失败在真实SAVEPOINT隔离，短信/站内信可先提交且重试不重渲染；POST仍需fresh来源和首durable attempt，UNKNOWN不重发。

最终recheck-07新原生16＋Financial完整71共87通过，359.64秒；final-09单元264通过／2既有PG条件跳过及Worker两套类型通过，322.17秒。两批各8579输入运行中与补文档前一致，两PG remaining0/STOPPED，最终只计351次成功/2跳过；单层锁、单worker、命令600秒/整组1200秒及既有内存限值保持。新纯codec66项不作SQL批准证据；新业务普通未拆单Admin/Financial链为实际路由/服务LOGIN，HTTP/缓存/Queue和手机号连续性明确受控，不作真实微信或浏览器证明。

保留final-01只读字段测试类型失败（构造副本修复，runtime当时未启动）；中间refusal-03的16和regression-04旧19/13/10/45共87通过；financial-05为70通过/1失败，暴露普通Error导致缺必需通知时回滚回执分类回退。仅改helper错误类型/import，不放宽catch、准入或断言，之后重跑受影响16＋71和单元/两类型。旧87兼容是修复前图，不计最终351或冒称同字节重跑。8核心独立交叉读、5窄接线、5由复核者编写主流程另读，不称18文件全独立审计或重跑。本机.cache/php-ts-phase49-validation保留日志、冻结、差异、失败及复核；文档后补，提交文件另扫秘密并核暂存/提交字节。

其他角色入口、拆单/复杂后续退款、成团3098、非微信原账号通知、完整manifest/单次许可/原子切换及整体迁移仍未完成；成团只读地图不是实现。无生产DDL/Env切换、部署、真实微信或Workerd/Hyperdrive验收；旧用户/UID/权益/订单/付款、未知不猜归属、跨AppID屏障及runtime_ready=false保持。此前推送授权仅覆盖已推送b6861987，本轮新提交仍需具体SHA授权。


## 第50轮：多买家原账号成团3098与实际Queue

`d8372de57fad1a561cd8fa08be7c02b7f9665de0`已按具体授权推送并直接核对远端main。[其CI](https://github.com/cinagroup/cinashop/actions/runs/41456540520)现已取得终态failure：10个其他job成功，Worker两分片及聚合失败，包含旧来源绑定／缺失PHP、固定角色冲突和原生诊断问题，不再描述为运行中，不能称仅预算或全部无关。

本轮完成[成团3098作者与Queue](routine-subscription-pink-notice.md)：实际自然成团／既有虚拟阈值超时成团，在业务原事务批量读取一次目录、共同LOGIN和完整成员，派生独立request4。签名绑定整团成员身份与每位真实买家，虚拟成员不创建订单／通知。团的多买家集合不冒作付款家族；App分别证明每位买家自己的原SUCCESS付款、精确AppID+UID owner与独立3098批准，再写staging4和复用既有不可变attempt/result。真实混合A/C在当前B配置下分别GET／POST；原发货2／拒绝3域和旧pin／缺失／赢家保持，UNKNOWN不能换delivery ID重发，无新DDL／grant。

最终regression14成功的新13＋compatibility19既有拼团18＋拒绝16＋发货Queue13＋customer兼容3共63原生成功阶段合计628.64秒；final13单元212、零跳过及Worker两套类型通过，331.93秒。三批各8584输入运行中及补文档前一致，五成功PG及失败阶段remaining0／STOPPED，仅计275次最终成功。父CI暴露的两条退款拒绝错误文案失败恢复原ValidateException消息，customer兼容重证，未放宽业务准入或断言。

新原生是实际Admin活动、JWT买家type3下单、独立原账号RSA/AES回调、自然／虚拟超时、App与Queue完整服务链；provider／缓存／Queue及phone连续性明确受控。虚拟超时用既有显式逻辑now，未达阈值不作退款补偿完成证明。500成员由纯单元批量结构覆盖，原生正例为2人及1真实+2虚拟；拆单根路径未新增动态正例。真实C申请退款按既有资格整体disabled，A独立可发，不承诺C短信。

保留首轮临时启动失败、preflight08的旧图212／20跳过、pink10 beforeAll重复裸绑定使13未执行及pink12中间通过；修复测试精确裸绑定和unused import后，在最终同图重验。23源／测试／runner交叉复核及完整日志／冻结／失败在.cache/php-ts-phase50-validation；19既有文件另一作者复核、4新文件由其编写主流程另读，不称全量独立审计／重跑。三份文档后补，提交文件另扫秘密并核字节。

本轮未部署、无生产DDL／Env切换或真实微信／Browser／Workerd／Hyperdrive验收。其他通知作者／角色、非微信发送、复杂拆单退款、完整manifest／单次许可／原子切换及整体迁移仍未完成，旧用户／UID／权益／旧单／付款、未知归属不猜、跨AppID屏障及runtime_ready=false保持。旧虚拟超时41例在首笔余额准备缺正式付款协议而失败；精确d837导出的一条代表例复现相同503，不冒称41例全基线重跑，也未改旧套件／CI或放宽生产付款校验。本轮新SHA远端CI未验证，推送需要具体新授权。


## 第51轮：旧虚拟超时41例的付款协议准备与结算边界

`341490fc2d41d48d1cb60d442b960075cbdc39d9`已按具体授权推送并直接核对main。本轮恢复[旧虚拟超时业务验证](routine-subscription-pink-notice.md)：只在该suite的owned PG16安装既有正式attempt存储并核catalog，增加reconciliation表；旧weixin/tradeNo调用迁到现有server-only已核验后结算入口。共享quote helper、生产付款准入／DDL源／业务源码、CI不改。原105条断言、参数与完整快照／退款／PID锁等待／锁后clock均保留，结算标本不宣称真实回调签名或原账号证据。

virtual02原41项、regression05本地准入76及新旧通知31共148项PG16通过、零跳过，final07 unit类型通过；生产源码与341字节一致，没有重复runtime检查／构建。三批各8585输入运行中及补文档前一致，三个PG remaining0／STOPPED。原500人用例证明legacy业务5真实+495虚拟，不能升级为request4的500真实买家原账号证明。先跑的2例／39未选不重复计数，第50轮41失败及基线代表失败保留。只读复核非独立重跑／安全审计，文档后补，提交文件另扫秘密核字节。

341的[新CI](https://github.com/cinagroup/cinashop/actions/runs/41562752284)末次快照仍运行，不称全绿。固定角色碰撞、其余旧来源绑定／缺失PHP和诊断CI问题、其他通知／角色／非微信、完整manifest／单次许可／原子切换及整体迁移仍未完成。本轮没有生产DDL／Env切换、部署、真实微信或Browser／Workerd／Hyperdrive验收；用户／UID／权益／旧单／付款与runtime_ready=false保持，新提交推送须具体授权。


## 第52轮：固定角色文件调度与受控生命周期验证

`e2757cb1b6e2a4bc2031ff9c97c126d22eae94a4`已按授权推送。本轮完成[固定角色测试调度](fixed-role-fixture-scheduling.md)：AST反向闭包将三根夹具及未知动态目标保守收齐，保留原Manager六文件、专用项目去重；实际1648文件各一次、824／824完整分片，58文件单worker串行，原hook／内存／分片算法不改。真实工厂在外层期限后继续创建角色已受控证实，随后精确drain／owned close归零；不是实际失败hook或历史首次冲突复现，不修改工厂取消／所有权协议。

最终729单元、30原生（1＋6＋12＋11）及Worker unit类型通过，零跳过，四成功PG均remaining0／STOPPED；生产源码与共享夹具不改。保留类型宽化失败及600秒合并命令超时；后者17条打印不计成功，自有PG宿主确认停止但残留角色未审计，再按完整文件和原600／1200预算通过。各批输入运行期间不变、最终仓库源图相同；原日志／冻结／复核在本机.cache/php-ts-phase52-validation，文档后补、提交另扫秘密。

e275的[CI](https://github.com/cinagroup/cinashop/actions/runs/41565199699)在2026-11-03T03:06:18.557Z仍有两个Worker分片运行、其余10成功，不代替新SHA验证。PHP输入等剩余CI问题、其他通知／角色／非微信、完整manifest／单次许可／原子切换和整体迁移仍未完成；无生产DDL／Env切换、部署或真实微信，旧用户／权益／旧单／付款与runtime_ready=false保持，新提交推送须具体授权。

## 第53轮：完整固定 PHP 原证输入与私有只读 CI 接线

`f2a848eb6b8375b292de33df2937e9c091673662`已按精确授权推送并直接核对远端main。[其CI](https://github.com/cinagroup/cinashop/actions/runs/41571731884)本轮最后快照为10成功、Worker两分片仍运行，不作全绿或新SHA证明。远端原PHP仓库目前公开且为空，固定8ed对象只在本机；用户先选择完整真实检出、另审发布范围，再选择私有仓库与CI只读。两次选择均未直接授权远端变更或凭据发送。

本轮完成[固定原库CI输入](legacy-php-ci-input.md)：完整8ed/tree/14664文件/313865557字节合同，真正.git与全量fsck、全部原生blob和工作字节核对；真实git show的11原文/15片段、26路由和原SQL摘要保持。默认archive遗漏218文件被拒绝；已有原库的40项CRLF差异未被采用或改写。同大小损坏object虽能通过connectivity/type/size，新增真实Git反例和完整fsck正确拒绝。脚本只读源文，不执行原PHP/依赖/hooks；占用或悬空sibling停止，保护已有checkout。

两Worker分片固定checkout原SHA、严格SSH且不持久化凭据、预检后接实际sibling，artifact只增加元数据回执。独立main-only environment与专用只读deploy key/环境secret的管理计划及本地0600密钥已准备，尚未改远端、上传密钥或推送原库。main-only会阻止所有PR refs（包括同仓库PR）满足两个必需job；聚合仍要求success，不以skip作绿。此影响须列入具体新SHA/私有供应最终授权。

新证明以5项精确逆编辑还原完整f2 workflow再接旧两层，旧72feefd证明及断言正文不变；只有两处import读取历史前驱，其余当前gate直接读实际新图，Git/源文不投影。真实schema审计exit1曾被下游JSON consumer掩盖为pipeline0，原schema/route block新增pipefail；实际同报告旧0/新1，失败继续保留，不刷新既有源pin。

最终final07完整13阶段1029.29秒，预列25765输入每阶段不变、root/candidate各8589规范化源图一致、精确f2基线8584；单层锁、单worker及600/1200预算不变。候选四套输入/workflow81通过/1既有容量超时（82），新增13+26全通过；实际sibling四套源文194通过/5失败（199），零跳过，Worker两套类型通过。精确f2同四文件完整重跑194/5，5失败的规范化错误内容逐项相同；容量10秒子进程超时亦另在精确f2复现。只计候选275通过/6失败，不累计基线或中间run，不能称全CI通过。

真实分片收集1650文件各一次、825/825、固定角色58文件串行，仅是完整清单与配置证明。route CLI0仍有actionableMissing795；schema两边CLI1且原日志同字节，源201/目标287/共享201/源列缺口0、外部only3/Workeronly77/列漂移0，等价断言未解决。先前类型失败、被取消标本run、准备错误和审计失败原记录保留。独立只读交叉复核不称重跑或全安全审计；本机.cache/php-ts-phase53-validation保留日志/冻结/基线/范围/计划，文档终态后补、最终提交文件另扫秘密核暂存与提交字节。

完整原库默认规则限深扫描66项/55文件，11项有技术上下文、55项仍需持有人核实；OAuth appsecret配置、初始管理员哈希seed及再分发限制存在，不推断失效或公开许可。固定SHA保持全部原内容，私有只读不替代持有人/权利审查；新提交扫描与原库扫描分开。旧手动Uni的CRLF derivative未供应/运行，原LF Git字节与旧hash均不改。

尚无私有原库、环境规则/只读凭据和新SHA云端验收；现存源文/schema/容量CI缺口及完整归属维护/单次许可/原子切换、其他通知/角色/非微信和整体迁移继续未完成。没有生产DDL/Env切换、部署、真实微信/Browser/Workerd/Hyperdrive验收，用户/UID/权益/旧单/付款、未知不猜归属、跨AppID屏障及runtime_ready=false保持。本轮新SHA及私有供应远端操作须一并具体授权。


## 第54轮：合并后来源连续性与静态 SQL 声明读取

上一轮本地提交 `53f212ddf1a1025c19642c92be795d5c245af483` 的具体私有接入／两次推送计划，用户答复 **暂不执行远端操作**。计划已标记 deferred；没有变更仓库可见性、environment、deploy key、secret，没有发送凭据或推送任一仓库。远端原库供应、新 SHA 云端 CI 和原库 55 项待核实内容继续未完成。

本轮完成[来源后继与声明审计](ci-schema-source-declarations.md)：四个完整当前 package／pages／routes 文件、十个精确逆编辑及六笔真实 Git 历史，接回原 3d4780a6 合并图，旧三份证明／hash／断言正文不改，仅改 PHP helper 一个实际 import。当前直接读盘／运行时来源和 Git 原文不投影；旧图不能回退充当当前。另用 TypeScript AST 读取 exported const SQL／*_SQL 静态字面量，不执行被审阅迁移 TS 或猜插值；保留 raw 漂移／位置／已知 unresolved，明确有界提取、非穷尽且不是安装证明。默认 raw 模式最终仍拒绝当作完整安装，显式自包含原始 SQL 覆盖保持原语义。

最终 final-06 六阶段 742.80 秒，8598 输入每阶段不变；九完整文件313项为312通过／1既有来源 pin 失败、零跳过，其中新增37及全部153热词通过。Worker unit／runtime 两完整配置分别通过，完整固定PHP输入通过。真实schema CLI仍exit1：外部287／声明364、raw361、外部only0／Workeronly77／列PK漂移0；36静态补充与536已知未求值不构成完整提取／安装。真实原生收集1652各一次、826／826、固定角色58串行，仅是collection，未冒称全文件执行或旧10秒容量通过。

保留三来源首轮缺后继、600秒combined类型超时及新增测试TS2554／TS2345；仅修严格解码／必填BOM选项及stdout窄结构视图，原全字节／列／PK断言保持，最终两配置通过不覆盖原超时。只计最终313结果，不累计中间重复。单层锁／单worker／原内存及600／1200预算保持，原日志／冻结／只读复核在本机.cache/php-ts-phase54-validation；文档终态后补、九提交文件另扫秘密核字节。

剩余旧writeoff约束名来源后继、41新增声明表的封闭cohort／独立owner安装合同、77差异及容量CI仍待处理；不能直接刷新旧hash或320计数。完整manifest／单次许可／原子切换、其他通知／角色／非微信及整体迁移未完成。无生产DDL／Env切换、部署、真实微信／Browser／Workerd／Hyperdrive验收，用户／UID／权益／旧单／付款及runtime_ready=false保持。本轮仅提交合入本地main并清理已合并开发分支，远端操作继续暂缓。


## 第55轮：旧来源后继与独立声明 cohort

本轮基点为仅本地main的`a03a52a119122615fbf5bd5c3a983dc6f60bb5cd`。用户“暂不执行远端操作”持续有效：私有原库／environment／deploy key／secret／凭据发送及两仓库推送均未执行，新SHA云端CI未验证。

完成[独立声明合同](schema-declaration-cohorts.md)：d715真实Git父4094ce1e的writeoff完整来源仅一行PK约束名后继，当前15653B／05b10…精确逆成旧15619B／044d8…；旧pin／真实安装SQL／物理约束名不改，旧图回退或任意其他正文漂移拒绝。另固定63完整Git源813071B、33声明模块、41表列／PK、31维护安装器文件／61入口、实际命名import与SQL执行范围和两个原子bundle。34处仅为所列SQL常量的未求值插值，不替代全源536未知范围，不拼空串／执行迁移或推断安装／传递调用闭包。

七个历史301／305／310／312／315／319／320层及旧完整集合保留，只有已全图验证33basename从旧视图移出，未知模块不被自动分类。当前完整raw361／literal364及旧36＋新41＝77另断言，不将声明等价冒作runAll安装；全源ALTER-before-CREATE检查保留。

pure-01六阶段728.32秒、native-02两完整PG文件290.67秒，两批8607输入每阶段及跨批一致。单元77全通过（新27、原data36、旧literal14）、PG16 21全通过，零跳过；最终只计98次，不累计旧轮。Worker两完整类型配置／固定PHP输入通过，实际external287／runAll283／ORM292及显式city＋abandon组合、OID／owner／ACL保持和拒绝重装得到真实PG证明，两个宿主remaining0／STOPPED。不据此称31维护安装器均已安装或业务就绪。

真实schema CLI继续exit1：外部only0／Workeronly77／列PK差异0，36静态补充／536已知未求值、完整提取／安装标志false。真实原生1654各一次、827／827、固定角色58串行，仅collection，不是全部文件执行或容量10秒恢复。原预算／单层锁／单worker保持；日志／冻结／Git核对／只读复核在.cache/php-ts-phase55-validation，文档终态后补、九提交文件另扫秘密核字节。

生产源码／迁移SQL／grants未改，未部署／Env切换或真实微信／Browser／Workerd／Hyperdrive验收。真实可比安装等价、容量CI、私有原库供应及云端CI、完整manifest／单次许可／原子切换、其他通知／角色／非微信和整体迁移仍未完成；用户／UID／权益／旧单／付款及runtime_ready=false保持。本轮仅本地提交合main并清理已合并开发分支，远端操作继续暂缓。


## 第56轮：真实安装的扩展public目录与权限观察

本轮基点为本地main `6ae2bf97896cfba6355d74aadeb1858cd1adf231`。用户“暂不执行远端操作”持续有效；GitHub可见性／environment／deploy key／secret／凭据发送、两仓库推送与部署均未执行，新SHA云端CI未验证。

新增[实际安装public观察合同](installed-public-catalog.md)：严格显式profile与专用回环测试服务，实际执行external182→287表、runAll185→283再city3＋abandon1→287。全部构造完成后，两个REPEATABLE READ READ ONLY快照保留旧五类，并增加物理列、关系、完整函数、全部触发器、视图／规则、策略、owner／ACL／默认ACL／相关角色及成员关系和未知清单；原始OID／节点树单列。没有角色、正文或内部触发器名归一化，未知对象即使两边相同也拒绝equal；全安装／有效权限／运行就绪标志保持false。

默认ACL全局owner仅闭包，成员grantor只保留属性，不因此读取无关global默认授权；新实际PG反例查pg_auth_members真实bootstrap grantor和真实defaultACL，证明无关新grantee不被拉入观察范围，之后精确撤回并清理。未新建superuser或修改真实应用权限。CLI创建清单限定cleanup，逐库／角色复核不存在；源码／Node／三包元数据前后相同，明确不等于全传递依赖认证。

保留首批unit类型TS2352失败214.80秒及未执行后续的终态；终态后修复并收紧范围。最终pure-02六阶段800.53秒、final-05 PG四例／reader31／完整unit类型471.02秒（PG167.60秒）。pure 8613／final 8616输入各阶段一致；共有输入仅native单case正文可移植后继、reader两别名引号与列ACL输入修复及原pure断言（读真实grantor、临时独立库owner、独立cleanup），其余源和导入未变，旧单元794／runtime等结果复用，最终reader31替换旧31；新图完整unit类型、reader31与PG文件重跑，final03的1通过／3失败与final04类型／reader通过但原生1通过／3失败、两轮CLI无JSON／cleanup终态均保留，不重复累计那两次通过。最终单元825＋PG4＝829次成功，新增51例、零跳过；Worker两套完整类型／固定PHP输入通过。实际API和CLI旧五类均零差异，扩展真实差异与两次精确计数见合同；CLI如实exit1，绝不称全安装已等价。

旧schema CLI仍exit1：外部287／声明364（raw361）、only0／77／列PK0，36静态补充／536已知未求值，完整提取与安装false。原生case正文可移植修复前真实收集1657文件，829／828、固定角色58串行，仅collection不当全执行／10秒容量恢复。单锁／单worker／原预算保持，文档终态后补，八文件另扫秘密核index／commit字节，证据在.cache/php-ts-phase56-validation。

生产源码／迁移SQL／grants／Env保持基点；未部署或真实微信／Browser／Workerd／Hyperdrive验收。原始安装差异仍需独立合同解释，31维护安装器及其61入口、完整manifest／单次许可／原子切换、其他业务／角色／非微信、私有旧PHP供应及CI／容量和整体迁移仍未完成。用户／UID／权益／旧单／付款及跨AppID屏障、runtime_ready=false保持。本轮仅本地合main和清理本轮开发分支；远端继续暂缓。


## 第57轮：同一维护快照的身份归属与原始锚点分类

本轮基点为本地main `49f6d9959a295891d23a58d93fe04ad34c284dce`。用户“暂不执行远端操作”持续有效：没有GitHub读写、私有原库接入、environment／deploy key／secret配置、凭据发送、推送或部署，新SHA云端CI未验证。

完成[身份续办维护草案](routine-identity-continuation-draft.md)：从既有身份服务提取共享纯封闭解码，原HMAC字节、持久见证与owner各自时间规则、异常语义和runtime LOGIN／catalog／RC写事务／fresh观察／配置检查保持。维护侧不借App上下文或SET ROLE，而在完整数据库inventory的同一锁定RR只读流内分类ONLY四个public身份根，逐条核owner、原observation_id见证、UID、精确绑定与live／inactive状态。缺／坏原锚点不能借最新见证；同UID不同AppID保留不同承诺，同UID+AppID多live冲突不按行序选赢家，旧未映射／软删尾部不推断归属。

全库其他schema、继承子表及新来源仍完整计数／HMAC并显式unclassified；分类与inventory sourceDigest绑定，缺失的命名表列入missingSources；错误布局或超容量不返回成功前缀。输出只有维护库／角色／来源名OID、计数、keyed账户／主体／记录摘要及状态，没有原UID／AppID／openid／phone／签名或凭据。CLI独立三Env，无runtime或inventory变量回退；验证key只在进程中验HMAC，不发送SQL。catalog commissioning、付款、其他身份realm与外部源均明确未评估，activation／permit／switch始终false，现有跨AppID写入屏障未改。

首批完整身份20例为19通过／1清理后严格catalog失败，385.84秒，8620输入不变，原失败保留。原因是owned测试ADD／DROP列留下dropped属性槽；仅两段SQL改为RENAME／还原，前后case及helpers／其余全部输入字节相同。后继494.13秒、8621输入不变：当前literal1通过／19未选，另完整inventory14、三旧PG文件128和五纯文件156通过；首批19按未变正文复用，合计接受162原生＋156纯＝318，不重复累计未选或中间结果，也不称当前身份整文件重跑。新增76为纯codec52／classifier6／CLI13及原生5。types批336.16秒、相同8621输入，两完整Worker配置通过，unit220.90秒／runtime115.26秒。四次PG包括失败轮全部remaining0／STOPPED，单锁／单worker／600与1200预算未改。

新原生实际运行App LOGIN、code2Session／reconcile服务、存储签名、维护快照及独立进程CLI；provider／缓存为受控传输，新增phone连续性是server-verified夹具参数，不作本轮真实手机号HTTP或真实微信声明。动态覆盖老锚点、损坏owner／anchor、缺首见证但新见证合法、多AppID／同账号冲突、inactive／未映射软删尾部、真实peer并发DML与新来源、实际App拒绝和布局漂移，分类前后旧用户／权益／旧单／付款／证据快照不改。交叉复核区分作者与独立阅读范围，不称独立重跑或安全审计；证据／失败／逐项复用在本机`.cache/php-ts-phase57-validation`，文档终态后补，最终14提交文件另扫秘密核index／commit字节。

迁移SQL／grants／Env／配置作者未改；付款原SUCCESS／历史approved-use／各独立用途批准、provider／Queue等外部闭合、完整manifest／单次许可／原子切换、其余业务／角色／非微信、私有原PHP供应与CI／容量及整体迁移仍未完成。下一步只读地图绑定24当前来源，尚未实现付款分类或发出权限。没有生产维护执行、部署、Browser／Workerd／Hyperdrive或真实微信验收；用户／UID／权益／旧单／付款、跨AppID屏障与runtime_ready=false保持。本轮仅本地提交合main并清理开发分支；远端继续暂缓。
