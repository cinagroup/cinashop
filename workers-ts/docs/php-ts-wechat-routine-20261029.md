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
- 发货上传旧载荷没有完整原单账号见证，已阻止借用当前商户号或当前 AppID 发送，投递保留为带 `wechat_shipping_original_account_evidence_required` 的 DEAD。原单证据、维护恢复及真正的发货上传迁移尚未完成。

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
