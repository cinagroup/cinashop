# 同城配送十键配置合同

本次承接旧 `/admin/setting/city/delivery/setting` 的完整配置屏，不新增计价、配送范围或半径字段，也不开放第三方发单和取消。当前代码、测试夹具与协议已实现；本地真实执行结果和最终状态以本批冻结 manifest 为准。首次后端输入冻结为 `.cache/city-delivery-settings-source-freeze-first-20261002.json`，此文档随后独立新增，不属于该首次 26 文件输入。

## 旧合同与字段

旧表单 [SystemConfigServices.php:1800](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1800) 通过 `setting/config/save_basics` 保存下列十键。主开关控制三个方式的显示，达达和 UU 开关各显示三项凭据；关闭开关不清除隐藏值。六项旧输入没有本屏非空、长度或 SDK 连通性验证；旧 blank 可以保存，不代表平台可用。

| 类别 | 键 | 新输入边界 |
| --- | --- | --- |
| 主开关 | `city_delivery_status` | 数字 0 或 1 |
| 自主配送 | `self_delivery_status` | 数字 0 或 1 |
| 达达配送 | `dada_delivery_status` | 数字 0 或 1 |
| UU 配送 | `uu_delivery_status` | 数字 0 或 1 |
| 达达 | `dada_app_key` | replace 最多 128 UTF-8 字节 |
| 达达 | `dada_app_sercret` | replace 最多 256 UTF-8 字节，保留旧拼写 |
| 达达 | `dada_source_id` | replace 最多 128 UTF-8 字节 |
| UU | `uupt_appkey` | replace 最多 256 UTF-8 字节 |
| UU | `uupt_app_id` | replace 最多 128 UTF-8 字节 |
| UU | `uupt_open_id` | replace 最多 64 UTF-8 字节 |

旧 [save_basics](C:/cinagroup/cinashop-php/app/controller/admin/v1/system/config/SystemConfig.php:435) 逐个键 `json_encode` 写入 SQL，随后清理缓存；旧 [DeliverySevices.php:35](C:/cinagroup/cinashop-php/crmeb/services/DeliverySevices.php:35) 从 SQL 配置初始化 SDK。新系统原先 provider 使用 Worker Env，不能用只写旧 SQL 明文的页面冒充已改变 provider。

## 权威和读取

[CityDeliverySettingsResolver](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliverySettingsResolver.ts) 直接读取 `is_store=0` 的十键。每键按 `sort DESC,id DESC` 选取精确名称 winner；所有候选值、sort 和 xmin 参与 revision，最多 1000 行。大小写或 ECMAScript trim 别名诊断并禁止专页自动覆盖，不通过最高 ID 合并别名；历史精确重复保留并明确诊断。GET 不新增配置。缺失开关返回 null，运行时按不可选处理，首次显式确认可新增必要键。

无受管密文时六项维持 Env 权威。旧 SQL 明文只诊断，不自动启用；`keep` 不会采用这些明文。`replace` 写入受认证加密 SQL 值；`clear` 写入加密 tombstone，禁止回退 Env。较高优先级旧明文遮蔽较低受管值时该项失败关闭，避免 clear 后复活部署凭据。唯一坏密文可用显式 replace/clear 修复；错误密钥不猜测解密内容。

GET 仅返回 revision、四项 nullable flags、六项 `{configured,source,issues}` 和部署 readiness。没有旧值、掩码后缀、密文或 part。`configured` 与 `enabled` 分开；只有主开关和对应 provider 同时开启时，新管理操作要求其三项有效凭据及已有部署协议 readiness。缺专用加密密钥仍可查看 Env 兼容状态，但不能 prepare 或新 confirm。

四项 SQL flags 实际接入 [StoreMobileOrderService.deliveryInfo](C:/cinagroup/cinashop/workers-ts/src/services/store/StoreMobileOrderService.ts:357)，避免 CONFIG_KV 旧值决定新方式选择。实际 callback service 创建的 Dada/UU 查询客户端使用共同 resolver；UU 验签及 receive 各自重读有效 OpenId。关闭方式只影响新选择，不阻断历史 query、reconciliation 或 callback。provider 独立构造器仍保留原 Env-only 兼容签名，生产 callback 查询路径明确注入 resolver。

Dada CLIENT_ID、两平台 callback token 和 UU 时间戳单位仍为部署协议。callback token 保留现有 24..128 UTF-8 字节验证。UU seconds/milliseconds 必须明确配置，本次不猜定供应商协议。六项新值在 trim 前拒控制字符和孤立 surrogate，replace 不能为空；明确 clear 表达清除。

## API、权限和可恢复意图

Admin 页面 `/setting/city-delivery-settings` 使用独立 `city_delivery_settings.view/manage`。旧 1490 只有精确页面 path/auth 且有效菜单形态时得到 view，不授 manage，也不借通用 config 权限。

两前缀 `/adminapi`、`/api/admin` 各注册五个接口：

| 方法 | 相对路径 | 作用 |
| --- | --- | --- |
| GET | `/config/city-delivery` | 非秘密快照，private/no-store |
| POST | `/config/city-delivery/intent` | prepare，不改变有效十键 |
| GET | `/config/city-delivery/intent/:requestId` | 本 actor 恢复准备状态，无秘密下载 |
| POST | `/config/city-delivery/confirm` | 确认或重试原不可变意图 |
| GET | `/config/city-delivery/request/:requestId` | 本 actor 成功回执 |

prepare 输入完整 `{request_id,client_nonce,revision,flags,credentials}`。request_id 与独立 client_nonce 都是规范 UUID；credentials 必须含六项 `keep/replace/clear`，只有 replace 携带 value。canonical 固定 `{operation:'update',revision,flags,credentials}` 键序，服务端 HMAC 额外绑定 actor、UUID 和 nonce。客户端不计算秘密的公共 SHA，也不在 local/session storage、队列或 KV 保存 replacement。confirm 只提交 `{request_id,client_nonce,payload_hash}`。

准备使用独立 `CITY_DELIVERY_CONFIG_KEY`：规范 43 位 base64url、解码 32 字节；HKDF 分离 AES-GCM 与 HMAC 子密钥，不复用 APP_KEY/JWT。每次随机 12 字节 IV；AAD 绑定 actor/UUID/nonce/HMAC，密文内认证 expiry。复用 system_log INSERT-only 权限，在同一事务保存一份 manifest 和最多 32 个 200 字符 part，明文预算 4096 字节。缺失、重复、附加 part 或篡改均失败关闭。prepare body 有界 16 KiB，重复 JSON 键拒绝。

TTL 为 1800 秒，每 actor 最多 5 个尚未确认的活跃准备。成功回执优先于 expiry 和密钥缺失检查：已经提交的 confirm 重试及 intent GET 可直接返回原成功证据。过期未应用的 confirm 返回确定 pre-DML 拒绝；普通 GET expired metadata 本身不用于释放未知确认。旧加密意图因 INSERT-only ACL 留存，没有自动删除或完整 retention 声明。

尚未发送 confirm 的准备可以显式放弃客户端 pending；这不声称服务端不存在或删除了意图。confirming/confirm-unknown 的 404、损坏、网络错误、泛型业务 400 均保留原 pending。只有匹配 actual HTTP/body 400 或 409、固定 code、operation、UUID、nonce、HMAC 的窄证明可解除未知结果；重读后须用户重新确认并使用新 UUID。迟到 prepare 不能自动 confirm。

## 原子性、轮换和旧回调

事务首先设 READ COMMITTED 和 5/2/5 秒 statement/lock/idle 上限，保留更严格会话设置，然后取得目录 advisory `(731720,0)`。Admin prepare/confirm/intent 独占；App UU verify/receive 使用 shared advisory，锁后鲜读。App 仅 SELECT 配置，无为 LOCK TABLE 而扩大的 UPDATE 权限。这项 advisory 只协调专用合作写路径；非合作维护 SQL 必须停流或遵循协议，不能据此声称任意 SQL 都被挡住。

confirm 先查同 actor 成功 journal，再恢复 sealed intent，取 system_config SRE table fence，检查鲜明 CAS、expiry、有效值。实际凭据变更对相关 provider 按固定顺序取 `store_delivery_order -> event -> outbox -> reconciliation` SRE fence，再读取其非终态/unknown 尝试、未处理或冲突事件、未完成 outbox、未解决 reconciliation；存在任一项即 pre-DML 拒绝。等待后再次检查 expiry。四 flags、显式凭据写入及成功回执一起提交，最终 journal 失败全部回滚。table fences 覆盖这些表的非合作 INSERT phantom；不根据最大配送 ID 猜账号归属。

严格 stale code 为 `CITY_DELIVERY_SETTINGS_STALE_VERSION`，拒绝 code 为 `CITY_DELIVERY_SETTINGS_REJECTED`。controller 只在确切异常且 withTx 已成功回滚后返回 actual 409/400；raw parse、UUID 冲突、损坏 journal/intent、NotFound、SQL/未知错误不附这类证明。

轮换后旧 UU 账号未知回调拒绝。唯一路径是 token 已认证、完整 canonical/hash/subject/account/provider-order/source/status/time/repeat/cancel/payload 精确匹配唯一旧 callback，且旧 event 为 APPLIED/APPLIED_NOOP/SUPERSEDED/IGNORED、唯一 outbox COMPLETED 时 ACK 原 duplicate。verify 和 receive 均在 shared fence 下核对，不新增、重派或处理旧账号事件；变异、query-source、FAILED/DEAD 等不例外。

既有 UU event.client_id 按原合同保留 OpenId 业务验签证据，旧事件 canonical/idempotency 未迁移。这不属于本次配置秘密密文范围，不能宣称数据库所有身份字段均已加密。既有旧 SQL 明文也可留存且不被隐式采用。新 Admin DTO 和通用日志不展示这些身份或 intent 密文。

## 通用入口和验证边界

通用 config list 滤除六项及 normalized 别名；SystemConfigService.get/getMany 在 KV/SQL 前拒六项；通用 config batch 禁十键；旧任意键 SMS save 也在首 SQL 前拒整个含十键的 batch。通用 Admin 日志 list/count 排除 intent manifest/part，仅成功回执的非秘密 metadata 可见。没有启用旧 shared save_basics 或无版本写 URL。

新库存实际 33 项：6 pure、11 settings SQL、8 actual JWT HTTP、8 runtime SQL；首次输入 freeze 的 34/HTTP9 为手工库存误计，重试元数据明确纠正而保留初始证据。首轮 `.cache/city-delivery-settings-native-initial-20261002.log` 实际执行新 33 与旧 87 共 120 项，119 通过；唯一失败是新第二笔测试原单与第一笔共用默认空 unique/uid，撞正式 `so_unique_uid_uq`。重试仅给第二笔 seed 独立 unique，保留正式索引、所有 provider 签名和业务断言，待根集中复验后记录最终通过。夹具为 19 个实际 ORM 表的当前 App/Admin 权限交集、真实独立非 owner LOGIN，不是完整 production commissioning。维护角色仅建隔离测试表、安装官方 callback DDL/测试故障 trigger；HTTP 不创建角色、DDL 或自动修权限。旧 ownership 和 watermark 夹具仅增加共同 resolver 必需的真实 system_config 表及已有 SELECT 交集，保留旧业务断言。

有意义边界包括：prepare 无有效 DML、加密与恢复、六字段实际 provider 签名、master off 仍查询、真实 StoreMobile 四 flags、tombstone 不回退、所有候选 CAS、两会话同 UUID、严格真实 tx-local deadlines、最后 journal 故障回滚、两前缀 exact 400/409、泛型保护、轮换未决 matrix、exact 旧 replay、真实 pg_blocking_pids/table-lock phantom 证据。provider 网络使用本地确定响应，禁止真实供应商外呼；浏览器合成 API 与真实 SQL/HTTP 必须分别计证据。

生产密钥部署、真实 provider 账号/回调协议/UU V3 时间戳核验、第三方新发单与取消、密钥轮换和留存运维仍为独立开放边界。本批不 commit、push、deploy，也不宣称上述运行环境已上线。最终执行数字、失败尝试和 source SHA 以冻结验收 manifest 为准。
