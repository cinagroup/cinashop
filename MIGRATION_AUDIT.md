# CinaShop PHP → TypeScript/Cloudflare 迁移审计

## 提交后全量复审（2026-08-27，`main@34394ce`）

本轮先确认累计迁移提交 `34394ce` 已推送，且本地 `HEAD`、`origin/main` 与 GitHub 远端引用完全一致。随后新增可重复静态路由审计器，按 ThinkPHP 嵌套 group、标准 resource 展开、HTTP 方法和归一化参数对 PHP 权威路由与 Hono 注册逐项比较；通配 501 不算覆盖，显式接到 `*Unavailable`/501 的路由单列。结果是六个业务面共有 1,912 条 PHP 唯一合同，Workers 注册 1,209 条、精确匹配 519 条（27.1%），其中 15 条仍为明确 501，因此静态可执行匹配上限为 504/1,912（26.4%）。分面为 API 164/460、Admin 202/1,156（15 条 501）、Supplier 79/184、Kefu 47/63、Out 27/41、ERP 0/8。该口径比此前按已审计业务域描述的进度更严格，也证明不能用客服 74.6% 或结构覆盖率代表整体迁移完成度。

一次性认证只读 Worker 通过正式 Hyperdrive 重新读取生产目录后自动删除。生产 PostgreSQL 16.14 当前为 2,930 列、670 索引、200 主键；201 张 PHP 共有表都存在，16 张 Worker 专用表中存在 12 张，缺少 `order_print_job`、`order_print_job_action`、`order_waybill_job`、`order_waybill_job_action`，即生产为 213/217 表（98.2%）。数据迁移控制运行数仍为 0，本机 `SOURCE_MYSQL_URL`/`TARGET_POSTGRES_URL` 均未设置，`data:plan` 因缺源连接失败。生产有商品 71、订单 29、明细 28、售后 3，但客服账号/会话为 0、商品描述/访问/商品分类关系均为 0；3 条客服消息成为“有历史消息但没有可登录客服/会话”的待核对孤立数据证据。`system_config` 仍有 6 个重复键和 20 条额外历史行，未在无法判断权威值时擅自删除。

Cloudflare 资源侧已确认 Hyperdrive、CONFIG_KV、私有 `cinashop-assets`、订单 Queue 和两级 DLQ 存在；主 Worker Secret 只有 APP_KEY、DEBUG、内部聊天/运维 token 与两个 Upstash 项，支付、短信、Turnstile 和电子面单凭据均未配置。主 Worker仍保持 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；Admin/H5 Pages 最新生产来源仍为 `48297d2`，PC 没有可追踪 Source，Supplier/Kefu 尚无 Pages 项目。仓库没有 GitHub Actions，Windows runtime 套件仍未进入断言。完整分级缺口、阻塞条件与验收门槛已固化在 `MIGRATION_CHECKLIST.md`，后续按编号逐项实现。

随后按 checklist 的 DB-001/DB-002 使用固定 DDL 一次性 Worker 应用 `0090_print_job_outbox.sql` 和 `0091_electronic_waybill_outbox.sql`。入口只接受认证后的 `/apply-print`、`/apply-waybill`，不接受请求 SQL；事务固定 `search_path=public`、`lock_timeout=3s`、`statement_timeout=30s` 并取得 advisory lock，在事务内比较 `print_document/store_order/store_order_cart_info/system_config/store_config/express_company` 六表行数与内容摘要，任何变化都会抛错回滚。首次在 Secret 刚更新后立即调用收到 Cloudflare 1042，独立只读检查确认四表仍不存在、业务指纹不变，未盲目重试；等待部署传播并接入 tail 后重新调用成功。两组 DDL 均执行第二次，日志只有 PostgreSQL `42P07 already exists, skipping`，业务指纹始终一致。

最终使用新的临时只读 Worker 把生产表名与仓库 schema-audit 的 217 表清单做集合差，生产为 217/217、missing/extra 均为空，目录更新为 3,021 列、696 索引、204 主键；四张任务/动作表均为 0 行，商品 71、订单 29、明细 28、售后 3 等业务计数不变。迁移后同一 Worker 内重复目录查询一度显示缓存的 215 表，而目标表存在性查询已为 true；独立事务/新审计 Worker返回 217，确认这是 Hyperdrive SELECT 缓存而非结构缺失。所有临时迁移/审计 Worker和一次性 Secret均已删除，主 Worker未发布。

迁移完成后分别重跑小票和电子面单生产引擎隔离场景。小票场景 `schema_created/schema_removed/public_state_unchanged=true`、临时 schema 0，自动创建/支付、无效提供商跳过、自动/手工重放、租户账本、Queue 只含引用、提供商并发单次调用、HTML 转义、歧义结果不重试、确认重试/已发送/关闭及不可变动作全部通过。面单场景同样保持 `public` 不变并清理 schema，创建重放、根单活跃任务、租户边界、不可变动作、Queue 脱敏、HTTPS 协议/字段方向、歧义结果、明确拒绝、提供商成功但本地提交失败、应用已有单号、人工重试/确认/关闭、履约与通知精确一次全部通过。两个正式任务表及动作表仍为 0 行；生产打印机配置 0、平台/供应商面单配置 0，因此结构和状态机完成不代表提供商已可上线。

## Kefu 退款合同闭环与证据化退役（2026-08-28）

继续逐行核对 PHP `route/kefu.php`、`Order.php`、`RefundOrder.php` 与 `StoreOrderRefundServices.php` 后，确认两个“缺失路由”不能原样移植。`POST /kefuapi/order/refund` 注册到不存在的 `Order::refund()`；实际控制器只有 `refundForm()` 和未注册的 `refundOld()`，同文件的 `GET /order/refund_form/:id` 也错误写成 `Order/refund`。`GET /kefuapi/refund/agree/:order_id` 则以 GET 修改售后状态，控制器忽略 path 参数、另读同名 query，服务还把退款 ID 当成订单状态 `oid`。这两条现写入 `workers-ts/audit/legacy-route-decisions.json`，每条都要求源行证据、原因与替代合同；路由审计器会校验它们仍存在于 PHP、尚未被 TS 注册且无重复。原始 PHP 分母和缺失数保持不变，另输出退役与可执行缺口，避免把退役当迁移完成。

替代合同为认证后的幂等 `PUT /kefuapi/refund/agree/:id` 与资金 `PUT /kefuapi/refund/refund/:id`。退货同意在“客户转接锁→客服会话锁→退款锁→订单结算锁”顺序下复核唯一当前归属、售后/订单 UID 和可见状态，只允许需要退货的申请从 0/1/2 进入 4；相同请求重放不再重复日志，状态日志使用真实原订单 ID。资金退款只接受 type=1，提交金额必须精确等于售后权威金额；非完成态只允许 `refunded_price=0`，历史部分退款先人工核对，已完成且金额一致的重放返回收敛结果。核心 `RefundExecutionScope` 新增已退金额绑定和“退款锁前授权”回调，客服用它在每个决定事务里锁定当前会话；scope 同时绑定 store、supplier、customer、退款号、原订单、权威金额、已退金额、支付及系统可见性。渠道成功后的系统回调/主动对账继续依据持久化退款账本完成，不依赖已转接客服在线。

正式 Hyperdrive 隔离场景直接运行真实 `KefuOrderManagementService` 与完整 `StoreOrderRefundService`。前三次运行分别暴露并安全清理了：资金预授权读取仍在 Hyperdrive 事务外、核心私有 `runInTx` 绕过每连接 `SET LOCAL search_path`、审计器自身的会话删除/结果读取在事务外；三次均在随机 schema 的 `finally` 删除后返回，外层也删除临时 Worker。修正后 PostgreSQL 16.14 最终报告 `schema_created/schema_removed/public_state_unchanged=true`。客服专项结果全部为真：退货首次变更、退货重放收敛、篡改金额拒绝、资金单次完成、资金重放收敛、历史部分退款拒绝、转接撤权；余额精确为 `10.00`，退款用户流水 1、退货状态日志 1。完整退款回归同时再次验证重复余额退款、失败原子回滚、累计超额并发拒绝、精确累计并发、纯积分退款、渠道金额绑定、积分/佣金/供应商/拼团补偿和超时重复投递恢复。

静态路由复审因此变为 Workers 1,211、精确匹配 520/1,912（27.2%）、明确 501 为 15、原始缺失 1,392；原始可执行匹配 505/1,912（26.4%）。Kefu 为 Workers 51、精确/可执行 48/63（76.2%）、原始缺失 15，其中退役 2、剩余可执行缺口 13，有效可执行上限 48/61（78.7%）。13 条是扫码/微信 4、游客 8 和面单模板 1；OnePass Secret 与模板配置仍缺失。所有临时 Worker均已删除，主 Worker和 Kefu 前端没有发布，生产支付渠道也未因本批代码而启用。

## API-001 公共首页与商品发现迁移审计（2026-08-28）

### PHP 权威合同与迁移前差距

逐项核对 `route/api.php`、`PublicController`、`DiyServices`、`StoreProductServices`、`StoreProductRankServices`、`StoreProductReplyServices` 与评价 DAO 后，本批界定为 17 条缺失 GET 合同：导航、首页、个人中心菜单/数据、预售、搜索推荐/筛选、品牌、排行分类/列表、详情推荐/活动/可选类型、详情正文、首页推荐、热门和评价回复。既有 `/products`、商品详情、分类和评价列表/统计虽然已经注册，但审计发现 `/products.count` 永远为 `null`，商品详情只返回 TS 驼峰平铺结构且收藏状态永远为 false，评价统计返回 `total/avgScore/goodRate/picsCount` 而不是 PHP 的 `sum_count/good_count/in_count/poor_count/reply_chance/reply_star`，评价列表也忽略好/中/差类型。

PHP 的推荐标志已不再以 `store_product.is_hot/is_best/...` 为权威，而是通过 `store_product_relation.type=3` 的关系 ID 1～5；TypeScript searcher 原本已实现这一点，本批所有首页/推荐/排行读取统一复用该路径。系统组合数据仍是 `system_group_data.value` 中 `{type,value}` 嵌套 JSON，导航从指定模板、活动 `type=1` 或 `default` 页面中寻找 `pageFoot`。这些细节不能用硬编码空数组或旧商品布尔列替代。

### 当前实现与查询边界

新增 `PublicCatalogService`，集中实现 17 条路由和 PHP 响应形状；同一次组合数据读取批量连接 `system_group/system_group_data`，品牌与门店标签按整页 ID 批量装配，不进行逐商品 N+1。配置批量读取改为并行 KV get、一次数据库 miss 查询和并行 KV 回填。商品推荐统一强制上架、未删、审核通过、平台根商品和非 SVIP 专属；登录 SVIP 才放宽专属商品。所有页码归一化且 `limit<=100`，模板名走字符白名单，旧 JSON 有大小、字段数和原型污染键边界。

`/products` 现在使用与列表完全相同的 searcher 谓词返回精确 count。销量、评分和收藏排行只允许固定排序枚举，分类选择通过已迁移分类树解析，不把请求排序拼进 SQL。详情恢复可选 SKU 类型、真实收藏读取和类型隔离缓存键；控制器同时返回现有 PC/UniApp 使用的 snake_case 平铺字段，以及 PHP 客户端需要的 `storeInfo/productAttr/productValue` 外层。评价统计按 PHP 三档定义计算并保留现 TS 兼容别名；列表支持 `type=1/2/3`，评论回复批量读取用户和点赞关系。未审核或已删除评价继续不公开，这是相对 PHP 缺少 status 条件的有意安全收紧。

详情活动读取当前生产可表达的商品券、套餐和直接商品促销关系，并对预售直接返回空活动结构；没有伪造优惠后到手价。个人中心菜单按已迁移全局开关和用户推广/事业部状态过滤，未迁移的客服、配送等身份不会被猜测为可用。生产数据为空时所有接口返回稳定空结构，不把缺数据转换成 500。

### 生产 Hyperdrive 证据与数据缺口

一次性认证 Worker 绑定用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产合同调用固定 `search_path=public`、`statement_timeout=30s` 并执行 `SET TRANSACTION READ ONLY`：`/products` 得到精确 count 71 和首屏 ID 71～62；销量榜前八为 `1,70,68,66,64,62,60,58`，评分榜与收藏榜均成功返回 8 条，一级排行分类为 6 条。首页响应 14 个顶层键完整，导航与推荐/品牌/活动/预售为空且没有异常。此前 `EXPLAIN (ANALYZE, BUFFERS)` 的销量榜在 71 行规模使用顺序扫描和 top-N heapsort，仅 4 个 shared hit block、0 read、执行 0.095ms，因此没有为当前微小数据量增加投机索引。

同一只读审计精确解释了空结果：71 个可售商品全部为 `product_type=0`，五类旧布尔标志和 `type=3` 推荐关系均为 0；分类/品牌关系、商品描述、预售、促销/关系、套餐/关系、商品券关系、DIY 页面、首页组合定义/数据和评价回复均为 0。品牌表有 1 行、分类有 24 行，但商品 `brand_id` 样本为 0 且关系未迁；评价表有 2 行，但抽样商品 71 没有评价。相关配置只有 5 个 distinct key/9 行且存在 1 组重复。准确结论是读取代码和目标引擎验证完成，源首页内容、推荐关系、商品正文和营销数据没有完成迁移。

随机 `codex_api001_*` schema 复制相关生产表结构并播种两件隔离商品、分类、品牌、标签、推荐关系、描述、预售、导航、组合数据、三档评价和评价回复。真实服务的 12 类断言全部通过：组合值解包、`pageFoot` 导航、热卖/精品/优品推荐、品牌、搜索标签、详情正文、进行中预售、好/中/差统计、评价筛选和评论回复。场景返回 `cleanup=dropped`；随后生产复核 `temporary_schemas=0`。临时 Worker 成功场景版本为 `c16791d1-43ac-4b04-8956-516419409bbc`，最终只读复核版本为 `fed0a0ad-03a3-435c-8e9e-a99b25ae19cd`，审计结束后 Worker 已删除。本批没有对 `public` 执行 DDL 或业务写入，也没有部署主 Worker/前端。

### 工程验证与当前判定

静态路由复审从 534 提升到 551/1,912，TS 注册从 1,225 到 1,243；`/api` 从 164/460 提升到 181/460，总代码可执行匹配为 536、证据化退役 2、可执行缺口 1,359。新增 5 项 API-001 测试后，全量为 115 文件/667 项通过；双 TypeScript 配置通过，审计 Worker dry-run 为 970.66 KiB / gzip 175.47 KiB。Windows Workers runtime 仍在加载断言前以 `workerd` 0xc0000005 失败，不能记为 runtime 测试通过。

本项可以判定为“公共首页/商品发现读取合同、PostgreSQL 语义和现有生产商品对账完成”，不能判定为“真实首页和商品运营数据已迁移”或“线上已更新”。后者继续由 DATA-001～006、DB-003 和 REL-002 管理：需要只读源 MySQL、逐表复制/校验、运营确认重复配置，并在明确批准后发布主 Worker，使用真实前端同时对照 PHP 验收首页、详情、筛选、预售和评价。

## API-002 订单与售后详细迁移审计（2026-08-28）

### 19 项合同逐项判定

迁移前标注的 19 项不是 19 个都应照抄的控制器方法。逐行对照 `route/api.php`、`StoreOrder.php`、`StoreOrderRefund.php`、`StoreOrderServices.php`、`StoreOrderRefundServices.php` 及旧 PC/UniApp 调用后，当前判定如下：

| # | PHP 合同 | 当前处理 | 审计判定 |
|---:|---|---|---|
| 1 | `POST /api/order/comment` | 进入本批前已精确匹配，继续复用现有评价状态机 | 已有代码；不重复实现 |
| 2 | `GET /api/ali_pay` | 新增五分钟随机不透明 `pay_key`，只从服务端 KV 恢复 UID/订单并重新生成支付宝请求 | 代码完成；有意忽略客户端 `quitUrl`，避免开放重定向 |
| 3 | `POST /api/order/check_shipping` | 校验购物车归属/有效状态，按商品配送能力、门店开关和有效门店返回类型 | 代码完成；生产没有有效门店可验真实自提 |
| 4 | `POST /api/order/confirm` | 返回地址、购物车、用户、支付就绪状态并写 30 分钟确认键；金额预览调用与正式建单相同的权威报价路径 | 核心代码完成；生产无足够会员、赠券和配送样本供真实订单验收 |
| 5 | `POST /api/order/computed/:key` | 绑定当前用户的确认键并调用正式建单报价，覆盖会员、券、首单、积分与运费 | 核心代码完成；一般促销叠加仍归 API-006 |
| 6 | `GET /api/order/data` | 恢复 PHP 字符串计数与支付开关 | 基本完成；旧 `type/search/refund_type` 组合筛选尚未全部复刻 |
| 7 | `POST /api/order/prize/:orderId` | 用户归属校验后从订单赠券归属账本读取已落库奖励；支付 outbox 按券模板去重发券 | 核心代码完成；生产商品赠券关系为 0，尚缺真实数据验收 |
| 8 | `GET /api/order/write/records/:id` | 用户归属、分页上限和核销记录/商品快照读取 | 代码完成；生产核销记录为 0 |
| 9 | `GET /api/order/refund/reason` | 读取并标准化 `stor_reason` | 代码完成；生产配置缺失，真实返回为空 |
| 10 | `GET /api/order/refund/cart_info/:id` | 用户订单归属、可退数量和旧/新商品快照兼容 | 代码完成 |
| 11 | `POST /api/order/refund/cart_info` | 返回选中商品、订单状态和进行中件数摘要 | 代码完成；改价展示细节仍需旧客户端 E2E |
| 12 | `POST /api/order/refund/verify` | 作为按订单号申请的兼容入口，复用同一退款核心 | 代码完成；不接受客户端退款金额 |
| 13 | `POST /api/order/refund/express` | 只允许本人、退货申请、已同意状态 4 在退款锁内转为 5 | 代码完成；生产无该状态样本 |
| 14 | `POST /api/order/refund/again/:id` | 只允许本人被拒状态，复制原原因与商品数量快照重新申请 | 代码完成；比 PHP 更严格 |
| 15 | `GET /api/order/refund/del/:uni` | 只允许本人拒绝/已退款终态，事务内软删售后与订单并维护父单 | 代码完成；保留旧 GET 写合同仅为兼容 |
| 16 | `POST /api/order/product` | 按评价商品唯一键和 UID 读取旧/新订单快照 | 代码完成 |
| 17 | `GET /api/order/pay_cashier` | 只读本人最新未付收银订单并复用统一 cashier | 代码完成；生产无 `shipping_type=4` 样本 |
| 18 | `GET /api/order/nopay` | PHP 路由指向不存在的 `StoreOrder::get_noPay()`，一方前端也未调用 | 证据化退役；替代为 `/order/data` 或 `/order/list?status=0` |
| 19 | `ANY /api/order_call_back` | 未注册 | 转入 CORE-001；旧实现只用 `sms_token` AES 解密后写订单，没有独立签名、时间窗、nonce/事件账本或乱序对账，不能原样迁移 |

除新增 16 条精确路由外，本批还加固已存在但不在静态缺口中的 `order/create/:key`、`order/pay`、取消、收货、删除、再次购买、退款申请/取消/列表/详情：同时接受必要的 PHP snake/camel 参数；订单列表补齐状态 5～9 与 -1～-3；创建仍由短事务内购物车认领、库存守卫和 UID+key 幂等状态机决定最终金额；支付宝兼容入口使用一次性短期随机键，不把 UID、订单号或回跳地址交给匿名请求决定。

### 退款金额、数量与状态机审计

初版部分退款实现虽然拒绝客户端 `refund_price`，但按“退款件数/订单总件数”分配金额。这个算法在不同单价商品中会退错钱，例如 1 件 90 元和 9 件合计 9 元的订单，选择高价商品会错误得到 9.90 元。现已改为读取不可变 `store_order_cart_info.cart_info` 的 `sum_true_price`，把订单实付整数分用 BigInt 按商品行权重确定性分配，再按该行已完成/本次件数取累计差；选择全部剩余商品时强制收敛到尚未退款的精确余额。整单退款不再保存空商品集合，而是保存每行 `{cartId,cartNum}`，因此售后金额、退款件数、`store_order_cart_info.refund_num` 与库存恢复使用同一权威快照。历史无商品快照的已完成整单退款继续失败关闭，避免猜测剩余可退数量。

所有用户售后写入均以认证 UID 二次限定；申请在订单结算 advisory lock 和订单行锁下阻止并发进行中申请，校验已付、供应商分配状态、可退商品和核销数量。退货物流固定从 4→5，再次申请固定从拒绝态 3 创建新单，删除仅允许 3/6；取消、拒绝、完成、渠道账本、订单镜像、积分/余额/佣金/供应商补偿和状态日志继续在既有固定锁序与短事务中执行。请求原因、说明、图片和物流字段增加非空/长度上限。PHP `refund_time_available` 已接入：配置 0 表示不限期，存在最后一次 `user_take_delivery`/`take_delivery` 收货状态时按自然秒执行含截止边界的用户申请校验；没有收货记录时不凭空拒绝，系统自动退款显式绕过用户申请时限。

### 展示定价、支付后赠券与售后期限续审

对 PHP `StoreOrderServices`、积分配置和会员权益判断再次逐行对照后，确认旧 `useIntegral` 是“是否使用积分”的布尔开关，而不是允许客户端提交任意扣减点数。TS 现只接受开关，服务端读取 `integral_ratio_status`、`integral_ratio`、`integral_max_type`、`integral_max_num`、`integral_max_rate` 计算上限，并扣除 `user_bill.frozen_time > now` 的冻结积分；正式创建还会在用户行锁内重新报价，避免确认页与下单之间积分余额变化。会员价只在会员功能开启时生效；付费会员必须是永久会员，或 `is_money_level>0` 且未过期，并同时满足会员卡、SVIP 价格、`vip_price` 权益和商品 VIP 开关。普通总价、会员总价、优惠券、首单、积分、固定/模板运费、满额/线下包邮和 SVIP 运费权益全部由 `StoreOrderCreateService.quoteOrder` 同源返回，确认、计算和建单不再维护三套金额逻辑。一般秒杀、拼团、砍价及其他促销叠加仍属于 API-006，不能据此宣称完整定价迁移完成。

PHP 支付后赠券按券模板 ID 去重，即同一订单购买多个关联同模板商品也只领一次。TS 新增 `store_order_product_coupon_reward` 订单归属/幂等账本，以订单+模板和用户券双唯一约束固定结果；支付 outbox 在同一事务锁定模板、创建用户券、递减库存并写账本，重放和并发都不会重复发券。`/order/prize` 只通过账本关联用户券和券模板返回持久结果，不再依赖短期缓存或订单表中不存在的奖励字段，并保持 PHP 的积分奖励返回值为 0。

同一固定 DDL 通过用户指定 Hyperdrive 在 `public` 应用两次，前后业务指纹不变；生产目录由 220 表/3,046 列/708 索引/207 主键更新为 221 表/3,053 列/712 索引/208 主键，新账本为 7 列、4 索引、2 约束且 0 行。随后随机 schema 直接调用生产代码：报价与实际落单完全一致，原价 `20.00`、会员价 `16.00`、优惠券 `3.00`、积分 `2.00/200`、原运费 `5.00`、实付运费 `2.50`、最终实付 `13.50`，冻结积分确实排除；同模板双商品的两个并发发券调用严格为 `0/1`，库存只减 1，用户券、账本和奖品各 1；售后场景证明过期用户申请拒绝、自动退款放行、未收货用户申请放行。三个场景均为 `schema_removed=true/public_state_unchanged=true`。一次性 Worker `cinashop-api002-audit-1787896737` 已删除，主 Worker保持版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布。

### 生产 Hyperdrive 数据与执行计划

临时认证 Worker 绑定用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，只读事务固定 `search_path=public`、`statement_timeout=20s`、`SET TRANSACTION READ ONLY`。生产为 PostgreSQL 16.14：订单 29、可见 28、未付 8、已付 20；状态分布 `0:23 / 1:1 / 3:4 / -2:1`，支付方式 `yue:18 / alipay:1 / integral:1 / 空:9`，29 单全为 `shipping_type=1` 且 `delivery_type` 全空。订单商品 28（支持退款 28、孤儿 0），售后 3（`refund_type 0:2 / 6:1`、孤儿 0、UID/Supplier 归属错配 0），订单累计件数快照错配 0。

生产数据同时暴露出明确阻塞：退款支付账本 0、订单发票 0、核销 0、配送订单 0、商品赠券关系 0、订单商品赠券账本 0、退款理由配置 0、有效门店 0；用户发票 2、用户券 4、运费模板 1。完整性检查中已付无支付方式 0、全退但没有完成售后 0，存在 1 单发货状态却没有物流类型/单号，需要 DATA-006 人工核对。用户订单列表在当前 29 行上选择顺序扫描，计划/执行分别约 0.111/0.027ms、shared hit 6、read 0；虽然存在 UID 索引，优化器对微小表选择顺扫合理，本批未凭小样本新增索引。

### 生产隔离验证、回归与残余风险

最终临时 Worker 版本 `eb1aafad-070a-4293-98a1-caae92f00b04` 在正式 Hyperdrive 上依次创建随机 `codex_create_order_it_*`、`codex_pay_cancel_it_*`、`codex_refund_it_*` schema，直接调用生产代码。下单场景验证同购物车竞争、同 key 并发幂等、超卖拒绝、秒杀/砍价/拼团/积分预留与取消归还；支付场景验证取消原子回滚、双取消、支付取消竞争、渠道/余额/积分幂等、outbox 失败回滚和余额不足；退款场景验证重复完成、失败回滚、累计超额与精确并发、纯积分、渠道金额绑定、积分/佣金/供应商/拼团补偿、拼团超时重复投递和客服授权边界。新增高低价申请返回 `partial_refund_price=90.00/refund_num=1/partial_snapshot_exact=true`，整单返回 `10.00/2/full_snapshot_exact=true`。三组均报告 `schema_removed=true`、`public_state_unchanged=true`；末次复核订单仍 29、售后 3、订单商品 28、全部 `codex_*` schema 为 0。临时 Worker与 Secret 随后删除，主 Worker没有部署。

静态路由因此从 551 提升到 567/1,912，TS 注册从 1,243 到 1,259；`/api` 从 181 提升到 197/460。总可执行精确匹配为 552，明确 501 为 15，证据化退役 3，原始缺失 1,345、可执行缺口 1,342。双 TypeScript 配置、API-002 审计 Worker 打包、主 Worker `wrangler deploy --dry-run --minify` 和全量单元测试通过；审计包为 1,196.99 KiB / gzip 275.58 KiB，主包为 2,358.08 KiB / gzip 582.75 KiB，全量单元测试为 116 文件/677 项。Windows runtime 仍在加载断言前因 `workerd` 0xc0000005 失败，0 条 runtime 断言执行，不能记为通过。

本批当前判定是“静态订单组缺口、权威展示定价、支付后商品券奖励和售后期限的核心代码及生产隔离证据已收口”，仍不是 API-002 完成。剩余门禁是：API-006 一般促销叠加；旧 PC/UniApp 与新五端的订单/退款浏览器 E2E；DATA-001～006 的退款原因、门店、发票、核销、配送和商品券真实关系；CORE-001 安全 `order_call_back`；以及经明确批准后的预发/正式发布。等待这些外部条件期间可以进入 API-003 用户中心。

## DIY-HOME-WIDGETS 迁移审计（2026-08-30）

### 权威合同与路由进度

本批以 `cinashop-php/route/api.php`、`app/controller/api/v1/diy/Diy.php` 及 DIY、短视频、新人、优惠券、商品排行、签到 service 为权威，逐字段复核公开 `GET /api/diy/get_diy/:id?`、`diy_version/:id?` 和可选登录 `user_info/video_list/newcomer_list/product_rank/sign/get_suspended`。八条此前均未精确注册；现已全部恢复，并保持外层 `StationOpen` 先于可选认证。`station_open` 配置缺失按 PHP 默认开放；已存在的值按 `json_decode(..., true)` 后的 PHP 真值判断，`0/false/null/空字符串/空数组/空对象/损坏 JSON` 都返回业务码 `410010`。静态路由审计因此更新为 PHP `1,904`、TS `1,412`、精确/可执行 `714/696`、不可用 18、原始缺失 1,190、退役 4、可执行缺口 1,186，覆盖 `37.5%/36.6%/36.6%`；`/api` 为 TS 723、精确/可执行 `332/329`、缺失 125、可执行缺口 124，覆盖 `72.6%/72.0%/72.1%`。

### 严格 PHP 对照发现与修复

审计不是只补路由。Admin 原“DIY 装修”会混写 `content/value`、把 `type=1/3` 降为 0、保存后不刷新版本，且允许删除默认页、悬浮配置或启用中的首页；现改为严格 DTO、独立 JSON 列、不可变合同字段、请求/JSON 复杂度上限、事务行锁、单调更新时间与新版本，并在前后端双重保护删除。旧导入 JSON仍直接从 `value` 编辑，不再用 `content` 的 fallback 覆盖它。

服务端继续修复了以下确定偏差：DIY JSON 的 2 MB 上限改为 UTF-8 字节而不是 UTF-16 code unit；新人不合资格的 `newcomer_integral` 保持 PHP 的空数组，匿名券保留原始 Unix/DECIMAL 类型，登录券恢复中文 accessor、`tidyCouponList` 的未开始/首 24 小时/可用/已用/过期分支、数值 `_type/pc_type`、日期别名和 issue bind 字段；默认开启的配置读取新增 presence API，严格区分“行缺失”和“显式空”。DIY 视频使用专用查询，固定 `sort DESC,id DESC`、最多 10 条，只返回视频表字段及 `product_info/product_num/type_name/type_image`，不再额外查询普通视频接口的关系、直播和 UI 播放状态；service 额外返回内部 `playIds`，HTTP GET 只返回 `list`，controller 用 `playIds` 在 `waitUntil` 中把播放计数及 append-only 关系事件同事务记录。公开分页把最大数据库 OFFSET 限为 10,000，超出时在查询前失败，避免匿名大页请求放大 PostgreSQL/Hyperdrive 扫描。

商品三榜恢复 `sort/presale_day`，并把 `member_card_status`、`svip_price_status`、`member_right(right_type=vip_price,status=1)` 三重门禁纳入 VIP 价格；连续签到首页卡片固定上海周一至周日二维 7 格，不套 SVIP 倍率。PHP 在删除非末尾 `pageFoot` 后可能保留数字键缺口并把 JSON 数组编码为 object，本实现有意压紧为稳定数组；但显式非零 ID 未命中后回退默认页仍按 PHP 原始 `$id` 保留 `pageFoot`。PHP `get_thumb_water('mid')` 在缩略图开关开启时依赖旧上传驱动，Cloudflare 私有 R2 的等价变换策略尚未确定，保留为发布门禁。

原 `ur_uid_rel_type_cat_idx` 是全局四列唯一，会阻止同一用户重复播放同一视频。已发布的外部 `0105` 保持字节不变，新建前向 `0106_user_relation_play_partial_unique.sql` 才把唯一范围收窄为 `type <> 'play'`；Worker 内嵌 `0112` 复用同一升级 SQL，避免已有迁移账本跳过原地改写。Drizzle 的非播放写入使用同一 predicate 的显式 conflict target；播放事件为 append-only，计数与事件同事务。外部 `0106`、内嵌迁移、schema 定义和生产审计 Worker 使用同一精确定义，遇到未知同名索引会失败关闭。

### 生产 Hyperdrive 证据

通过用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 部署一次性 SHA-256 Bearer 保护 Worker。授权边界实测 GET 为 404、无 token POST 为 403；生产审计在 `REPEATABLE READ, READ ONLY`、`search_path=public`、锁/语句超时下执行，只返回聚合、结构和布尔门禁，不返回配置值、PII、业务 ID、媒体引用或指纹正文。

24 张主依赖表和 2 张真实装饰链支持表全部存在，临时 schema 为 0。`system_dise=0`；21 个候选配置只存在 6 个键，缺 15 个，`site_url/sign_give_point/sign_status` 各有重复历史。用户 3/活跃 3、可见等级 3；用户券 4、当前可用 0、运行时已过期但持久状态仍未更新 2、券 owner 孤儿 3；关系 1 且 owner 孤儿 1，商品收藏计数漂移 1；签到 1 且 owner 孤儿 1，连续奖励 0。视频、新人商品、促销均 0，有效 VIP 价格权益 0；71 个商品可返回销量/评分/收藏各 3 条排行。八类真实 service 均返回合法结构，但这些空内容和孤儿是源数据/运营配置缺口，不是代码完成的证明。

生产索引端点先确认非播放关系和上海自然日签到重复组均为 0，再在 advisory lock 和短事务中执行 USER-CENTER 六索引迁移两遍。事务显式使用 `search_path=public,pg_temp`，把 PostgreSQL 隐式临时 schema 放到最后，并验证未限定 `user_relation` 实际解析到 `public`；地址、关系、签到三表使用全部列的 `to_jsonb(row)` 摘要。结果为 `applied=true/replayed=true`、精确索引 6、地址/关系/签到行数 `5/1/1`、DML=false、业务全行指纹不变；前后依赖表索引总数均为 90，因为本次是全局唯一到部分唯一的一换一升级。

### 随机 schema 与清理证据

随机 schema 克隆 24+2 张表，重建 25 个 identity/serial 绑定并确认外部序列依赖 0；每个顶层事务把 `pg_temp` 显式置于随机 schema 之后、固定 `TIME ZONE UTC`，并用 `to_regclass('system_dise')` 证明未限定表实际解析到随机 schema。真实 `DiyHomeCompatibilityService`/`ShortVideoService` 依次验证 DIY 5、用户聚合 3、视频 4、新人 7、三榜 4、签到 3、悬浮窗 2，共 28 项断言全部通过。24+2 张 `public` 表全行摘要和 25 条 public 序列状态前后相同，播放写只发生在隔离 schema，随机 schema 在 `finally` 删除，未使用真实外部绑定，也没有返回 fixture 数据。

首轮部署在 Secret 版本传播窗口遇到空传输，数据库尚未访问即由 `finally` 删除；随后隔离断言先后暴露“显式 ID 回退”预期错误和 fixture 会话时区不确定，两次均先完成 schema/Worker 清理且 public 指纹不变。修正测试 harness 后最终完整通过。一次性 Worker `cinashop-diy-home-widgets-audit` 与 Secret 均已删除，URL 返回 404；主 `cinashop-api` 未部署本批代码。

### 当前判定

DIY-HOME-WIDGETS 的服务端、生产只读审计、部分唯一索引升级和目标 PostgreSQL 隔离场景已收口，但父项仍不能完成：生产 DIY、视频、新人和促销内容为空，15/21 配置缺失且 3 键重复；新 UniApp 还没有类型化 client、allowlist renderer、版本缓存、微页面、首页组件和全局悬浮导航；R2 缩略图策略、旧端真实 token E2E、预发、影子流量、主 Worker/Pages 发布均未完成。下一代码批进入 PUBLIC-ARTICLE 7 条，数据与发布门禁继续独立跟踪。

## PUBLIC-ARTICLE 迁移审计（2026-08-30）

### 权威范围与 PHP 实际合同

本批以 `cinashop-php/route/api.php`、公开 `Article`/`ArticleCategory` controller、`ArticleServices`、`ArticleDao`、相关 model 及旧 UniApp 新闻页为权威，逐层核对 7 条 GET：`/api/article/category/list`、`list/:cid`、`like/:id`、`details/:id`、`hot/list`、`new/list`、`banner/list`。七条都位于 `StationOpenMiddleware` 之后并使用 `AuthTokenMiddleware(false)`；匿名读取时 UID 为 0。旧第一方客户端实际消费其余 6 条，`new/list` 没有 wrapper 或调用，但它仍是已发布公开合同，不能据此退役。

分类只取 `hidden=0,is_del=0,status=1`，按 `sort DESC`，并在首项插入 `{id:0,title:"热门"}`；PHP 内部缓存约 360 秒。分类文章列表返回 `id/title/image_input/visit/likes/add_time/synopsis/url`，hot/new/banner 不返回 `likes`；`image_input` 是不修剪的逗号拆分，空字符串精确为 `[""]`。列表 `add_time` 是上海时间到分钟，详情到日期；PHP 的 `page=0` 表示完全不加 LIMIT，`page>0,limit=0` 落到 ThinkORM 默认 20，显式 limit 最大 100。`list/:cid` 还排除 `wechat_news_category.new_id`，而 PHP 把可能含逗号的原串传给 `NOT IN`，没有可靠展开。

详情先增加 `visit`，返回文章全字段、正文、分类名、五个商品摘要字段和 `is_like`。ThinkORM 的 `bind` 只把正文与分类名展开为顶层 `content/catename`，不暴露 `contents/cateName` 关系容器；缺正文时 `content=null`，旧 varchar 分类 ID 保持字符串。文章不可用时 PHP 仍以 HTTP 200 返回 `{status:400,msg:"文章不存在或已删除",data:[]}`。点赞使用 `GET /like/:id?status=...`，正数添加、其他值取消；成功响应精确为 `{status:200,msg:"1"}`，没有 `data`。旧 PHP 允许匿名 UID 0 写关系、把计数更新与关系写入拆成两个非事务步骤，重复添加、取消不存在关系及并发都会使 `likes` 漂移；详情的读改写也会丢并发浏览量。

### 审计发现的泄露缺陷与迁移决策

PHP `ArticleDao::cidByArticleList()` 虽传入 `status=1,hide=0`，但 `ArticleDao::search()` 实际调用 `parent::search($where,false)`；Article model 又没有 status/hide searcher，因此 list/hot/new/banner 会泄露停用或隐藏文章，details/like 也直接按 ID 读取而不检查可见性。目标 `system_article` 还有 PHP 旧表没有的 `is_del` 软删列。新 Worker 明确不复刻这项信息泄露：所有公开列表、详情和点赞目标统一固定 `status=1 AND hide=0 AND is_del=0`；匿名详情继续可读，匿名点赞失败关闭。

公众号排除按每个逗号 token 展开，只接受数字并以去除前导零后的十进制文本比较，避免 PostgreSQL 整数转换溢出；这也是相对 PHP 偶然原串语义的有意修复。排序在 PHP 的 `add_time DESC` 后增加 `id DESC` 稳定次序。`page=0` 仍表达不分页，但 Worker 只取 1,001 行哨兵并在超过 1,000 时明确拒绝，绝不静默截断；分页 OFFSET 在执行查询前限制为 10,000。分类和列表当前也使用 `no-store`，详情及点赞使用 `private,no-store`，避免在正文媒体、发布失效和个性化状态尚未收口前形成错误 CDN 缓存。

详情浏览量改为同一事务中的原子 `LEAST(visit::bigint+1,2147483647)`；点赞先锁文章行，使用排除 `play` 的四列部分唯一关系，添加/取消后以关系表重算文章计数，整组事务失败则全部回滚。生产目录按 `0106_user_relation_semantics.sql` 的完整 catalog 条件精确核验该索引，唯一、有效、ready/live、非延迟、无表达式、四个键列和谓词均符合，`article_like_partial_unique_ready=true`。正式 `createDb` 启动参数及 `withTx` 都固定 `public,pg_temp` 且显式把 `pg_temp` 置后，不再依赖数据库角色的默认 search path。这样保留客户端可观察的路径、字段和成功信封，同时修复匿名写、重复请求、取消失败、并发漂移、未发布内容泄露和整数溢出风险。

### 生产 Hyperdrive 只读证据

一次性审计 Worker 绑定用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，只读审计与隔离写场景使用两枚不同的一次性 Bearer；Worker 只保存各自 SHA-256 摘要、做 timing-safe 比较并拒绝相同摘要，两个端点不能互相越权。生产查询固定 `REPEATABLE READ, READ ONLY`、`search_path=public,pg_temp`、短锁/语句超时，并验证未限定 `system_article` 实际解析到 `public`。响应只包含聚合、表/索引存在性和布尔门禁，不返回标题、正文、完整 URL、UID、业务 ID、配置值或表指纹。

目标为 PostgreSQL 16.14，所需文章、分类、正文、商品、公众号分组、用户关系和用户表均存在；临时 `codex_public_article_*` schema 为 0。生产 `system_article=0`、`article_category=0`、`article_content=0`、`wechat_news_category=0`、文章点赞关系=0，因而可见/停用/隐藏/软删、缺正文/孤儿、公众号 token、计数漂移、危险 HTML 和媒体类型聚合都为 0。最终审计还按每个逗号封面 token 区分空值、HTTP(S)、根路径、资产代理和其他值，并检查危险标签、事件属性、`srcdoc`、内联 style、明文/实体编码主动协议及正文媒体；SQL 已在生产执行，但零文章意味着所有结果仍是 0，不能替代真实样本验收。商品目录本身存在，但当前没有文章可形成商品关联。索引聚合为 `system_article=2`、`article_category=2`、`article_content=1`、`user_relation=5`；文章表没有 add_time/hot/banner 专用索引。由于公开文章为 0，本次没有数据量或执行计划证据支持新增文章排序索引，`forward_latest_indexes_recommended=false`，没有对 `public` 业务 schema 执行索引 DDL；后续写场景仅创建并删除下述隔离 schema。

### 随机 schema、并发与清理证据

写场景只在同一生产 PostgreSQL 的随机 schema 中执行：取得专用 advisory lock 后，先从生产目录失败关闭地核对全部 sequence-backed/identity 列，再克隆 `system_article/article_category/article_content/store_product/wechat_news_category/user_relation`，为全部 serial 重绑 schema 内序列并回读确认默认值没有指向 public；每个顶层事务固定随机 schema 在前、`pg_temp` 在后，并以 `current_schema()` 和 `to_regclass('system_article')` 双重证明未逃回 public。场景直接调用真实 `PublicArticleCompatibilityService`，不是 SQL 替身。

最终版本再次 10/10 断言通过：分类热门首项与排序、四种列表字段/公众号排除、草稿/隐藏/软删失败关闭、正文 fallback/商品/分类装饰、详情并发原子 visit、点赞幂等、点赞并发、匿名点赞拒绝、触发器故障全回滚及 search path 隔离。六张 public 表使用限时只读快照中的行数、最大键和全部列聚合摘要，相关 public 序列使用状态快照；即使场景或清理失败也会继续执行 after fingerprint/schema-count 并聚合报告错误。最终前后完全相同，随机 schema 在 `finally` 删除，临时 schema `0→0`。一次性 Worker、路由与 Secret 随后删除，复核其 deployment 已不存在；主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批未部署主 Worker。若审计期间恰有合法 public 写入，前后指纹会保守地报失败而不是误报安全。

### 静态覆盖、前端与剩余门禁

七条路由注册后，全域静态审计更新为 PHP 1,904、TS 1,419、精确匹配 721、可执行匹配 703、明确不可用 18、原始缺失 1,183、证据化退役 4、可执行缺口 1,179，覆盖率为 `37.9%/36.9%/37.0%`；`/api` 为 PHP 457、TS 730、精确/可执行 `339/336`、不可用 3、缺失 118、退役 1、可执行缺口 117，覆盖率为 `74.2%/73.5%/73.7%`。

新 UniApp 已本地恢复类型化七接口 client、分类/Banner/分页列表、详情/关联商品、首页“品牌资讯”入口和登录后点赞；正文不用 `v-html`，先由识别引号的 tokenizer 重建 tag/attribute allowlist，并为图片/表格生成跨端固定安全宽度，再交给 UniApp 受限 `rich-text`。类型检查、H5/微信小程序构建及 390×844 mock API 浏览器验证通过，危险属性没有进入渲染结果；安全链接的跨端点击策略和微信真机媒体效果仍需真实内容决策/验收，这只证明本地实现和模拟合同，不是生产内容 E2E。

最终仓库门禁为 Worker 单元/runtime 类型检查通过、143/143 文件与 861/861 单元测试通过、PUBLIC-ARTICLE 定向 4 文件 22/22；主 Worker `wrangler deploy --dry-run --minify` 成功，未实际发布。UniApp 类型检查及 H5、微信小程序、App 构建均成功。Workers runtime 套件在本 Windows 主机仍因 `workerd` 启动阶段 `0xc0000005` access violation 退出，0 个断言执行，不能计为通过；Linux/兼容主机 runtime 与 CI 门禁保持未完成。

服务端合同、生产只读审计、随机 schema 与本地前端接线已经收口，但 PUBLIC-ARTICLE 父项不能完成：生产没有任何文章、分类、正文、公众号文章引用或文章点赞样本，无法形成 PHP golden response，也没有历史正文/封面可验证发布时 HTML 清洗和媒体迁移。私有 R2 的短时签名 URL 不能持久化到正文或微信分享图，仍需稳定媒体代理、旧附件映射和服务端发布清洗。旧 PHP 若与 Worker 并行写点赞且不采用相同行锁，关系计数仍会跨栈竞态；历史 UID 0、孤儿或重复关系必须在切流前清理/映射。匿名详情每次更新 visit，热门文章还会形成数据库热点写放大，需在发布前确定边缘/WAF 限流、是否改为异步聚合或接受该兼容成本。真实 token、H5/小程序/APP、预发、影子流量、主 Worker/Pages 发布和发布后观察继续作为独立门禁。

审计更新：2026-08-30

## 结论

`cinashop` 已具备一个可构建、可测试且已有核心版本部署到 Cloudflare 的商城切片，但仍不是 `cinashop-php` 的等价替代。历史 M1～M24 标签只描述实现批次，不代表旧系统业务覆盖率；上一加固版本的远端 Worker、Hyperdrive 绑定、公开数据库读取和安全门禁已经核实。

## 生产 PostgreSQL 审计与 schema 升级

2026-08-11 已通过 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 直接核验生产 PostgreSQL 16.14。升级前 `public` 只有 54 张表，`data_migration_run`、`data_migration_checkpoint`、`live_room`、优惠券关系表、积分/其他订单状态表及 6 张无键企业微信关系表均不存在，不能开始 201 表 MySQL 数据复制。生产库规模很小：最大表 `store_product` 71 行，订单 29 行、订单明细 28 行、用户 3 行。

85 个 Worker 内嵌迁移先在同一生产事务内以 `lock_timeout=500ms`、`statement_timeout=5s` 全量执行并强制回滚，结果为错误 0、54→207 表；回滚后仍为 54 表。静态风险扫描统计为 207 个 `CREATE TABLE IF NOT EXISTS`、69 个 `ALTER TABLE`、416 个索引、6 条 `INSERT`、7 条 `UPDATE`，没有 `DROP`、删列、`DELETE` 或 `TRUNCATE`。

演练同时发现早期基础配置 seed 的 `ON CONFLICT DO NOTHING` 无法在非唯一 `system_config.menu_name` 上判重：生产 6 个基础键已各重复 4～5 次，`site_url` 同时存在示例域名和实际 Pages 域名。迁移已改为按 `menu_name + is_store=0` 显式补缺，DAO 单项/批量读取统一按 `sort`、`id` 确定优先级。修复后的 20/40/60/85 步生产事务阶梯全部错误 0，最早 6 个键新增 0 行。现有重复历史行未擅自删除，仍是待单独确认的数据清理项。

提交前精确影响为：28 条订单明细补结算价，同 28 条初始化拆分余量（合计 39）；2 条评价补物流评分并建立 2 条唯一订单明细关联；订单分配状态、拼团快照和新建事业部申请表均命中 0 行；新增 14 个缺失业务配置、5 个代理等级和 1 个会员权益。全量 schema 随后在一个带前后置断言的事务中提交，85/85 执行、错误 0，持久状态为 207 表、48 条配置。

提交后独立查询确认生产现有 2,831 列、610 个索引、194 个主键，14 个关键迁移表全部存在；28 条订单明细拆分余量、2 条评价评分和关联均满足预期，新增 14 个配置键各只有 1 行，原 6 个重复基础键数量没有增加。再在 207 表状态下全量重复执行并回滚，85/85 仍错误 0，表数和配置数均不变。所有临时审计/迁移 Worker 及一次性密钥均已删除，主 `cinashop-api` Worker 没有在本轮被重新部署。

本地最新验证为 TypeScript 双配置类型检查通过、111 个 Worker 单元测试文件 646 项全部通过、静态 MySQL→PostgreSQL 覆盖 201/201 表且缺列 0、外部 SQL 与 Worker 内嵌定义漂移 0。加入不保存消息正文的客服转接审计表后目标定义为 217 表（201 个 PHP 共有表、16 个 Worker 专用表）。Admin、PC、Supplier、UniApp H5 和 Kefu 全部重新完成生产构建，Kefu 的 6 项实时 reducer/资产路由测试通过。主 Worker 最近一次使用仓库内 Wrangler 4.122.0 的 minify dry-run 通过，上传体积 2,227.49 KiB、gzip 549.58 KiB。Workers runtime 测试仍未进入断言阶段：Windows `workerd` 启动时发生 `0xc0000005` 原生访问冲突，应作为本机运行时环境阻塞而不是测试通过。真实 PHP MySQL 数据复制仍未开始；迁移控制表为 0 行。本地未设置 `SOURCE_MYSQL_URL`，PHP 安装目录虽有未跟踪数据库配置字段，但其 3306 目标不可达，因此下一阶段仍需可访问的源 MySQL 连接。

2026-08-14 继续完成旧数据库缓存的有效运行时消费者。`kf_adv`、`open_adv`、`uni_app_url`、五类用户协议、`newcomer_agreement` 和按管理员隔离的商品草稿均已接入真实 `cache` 表；兼容公开/Admin 路由、Admin“客户端内容”页面、商品新建页 1 秒防抖草稿、UniApp 开屏广告与客服富文本均已恢复。缓存写入使用有界 JSON 和短事务原子 UPSERT，读取只在谓词中判断过期且坏 JSON 安全降级，不把前台读取变成清理写入；运行时内容七键批量保存可整体回滚。旧 `scan_upload` / `*_supplier_scan_upload` 的公开时间戳令牌上传没有恢复，继续由认证、私有 R2 上传替代。

同一生产 Hyperdrive 的只读审计确认 PostgreSQL 16.14 上上述 9 个固定键、商品草稿、旧扫码上传缓存和 `uni_app_link` 组合配置当前全部为 0。临时 Worker 随后只在随机 schema 中克隆 `cache`、`system_group`、`system_group_data`，验证空库安全默认、七键原子保存、触发器故障全回滚、单键 UPSERT 不重复、商品草稿 68,400 秒 TTL/过期隐藏/显式删除、`uni_app_url` 缓存回退与活动组合配置覆盖、坏 JSON 返回默认值且保留原行。schema 已删除，`public` 三表与两条序列前后不可逆摘要完全一致；临时 Worker 已删除且 URL 返回 404，主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。这证明目标生产引擎上的兼容语义，不等于源 MySQL 内容已经复制、真实运营内容已验收或主 Worker 已发布。

## 客服独立安全域与实时链路详细审计（2026-08-27）

### PHP 权威合同、覆盖范围与迁移前风险

旧 `route/kefu.php` 注册 63 条客服端点，覆盖账号/扫码/公众号登录、用户会话、订单/退款、商品、话术、转接、游客聊天、上传与版权/ERP 配置。当前 `/kefuapi` 精确恢复其中 48 条可闭合验证的 HTTP 合同，并新增专用 WebSocket、签名资产别名和安全的 PUT 退货同意替代合同：账号密码登录、配置/版权/ERP 开关读取、认证客服图片上传、用户会话/详情/标签/分组/退出、聊天记录、当前/可转接在线客服、客服转接、公共/个人话术与个人分类，已购/浏览/热销/商品详情四条商品上下文，客户订单/售后上下文与管理、退货同意/资金退款，以及手工快递、平台配送、虚拟发货、拆单预览/发货、核销信息/部分核销/全部核销。PHP 的 `GET /service/list` 保持为聊天记录，在线目录保持 `GET /service/transfer_list`，转接保持 `POST /service/transfer` 与 `uid + kefuToUid` 字段，没有保留臆造路径。按旧 63 条路径计算，客服 HTTP 原始精确覆盖为 48/63（76.2%）；总注册数为 51（48 条 PHP 精确 HTTP、3 条安全新增合同）。另有 2 条 PHP 坏合同带证据退役，剩余可执行缺口 13。这只是路由覆盖率，不代表已迁移业务量或生产可用率。

本轮继续审计旧 `BaseHandler`、`StoreServiceRecordServices::saveRecord()` 和新 Worker 后发现：旧实现的记录属于接收方，即 `(user_id=接收者, to_uid=发送者)`；客服会话列表必须固定 `user_id=客服 UID`，客户 UID 在 `to_uid`。此前 TypeScript 的查询、测试种子和 `ssr_kefu_recent` 设计沿用了反向理解，测试会用错误数据证明错误实现。现已修正查询、断言和随机 schema 种子，并由新的 `ssr_kefu_inbox` 覆盖正确查询方向；旧索引保留以避免未经评估的破坏性删除。

迁移前 WebSocket 还有五个高风险缺口：所有连接挤在单一 `global-v2` Durable Object；Admin ID 被当成客服聊天 UID；DO 通过公开 `INTERNAL_API_URL + INTERNAL_CHAT_TOKEN` 回调自身落库；持久化失败仍可能推送“幽灵消息”；UniApp 固定 `to_uid=0` 且同一消息同时 REST 与 WS 双写。Admin 聊天接口也没有专用客服主体，存在读取或发送私有会话的身份混淆风险。

### 当前身份、会话与实时架构

`type=kefu` 专用 JWT、bcrypt/`$2y$` 兼容、密码版本、账号状态、Redis bucket 类型和每来源 10 次/分钟强一致登录限流继续保留；Admin、用户和 Supplier token 不能进入客服域。会话/聊天查询固定客服与客户双方 UID、游客标志和每页最多 100 的 keyset 边界；个人话术固定 `store_service.id` owner，跨 owner 写入和仍含话术的分类删除继续失败关闭。

实时链路现改为每个认证主体一个 DO：`user:<uid>` 与 `kefu:<uid>` 分开命名，不再有全局热点或角色碰撞。入口只接受真实 WebSocket Upgrade；用户走 `/api/ws/kefu`，客服走 `/kefuapi/ws`，都由各自中间件把已验证的主体、账号 ID、密码版本、token 摘要和绝对过期时间作为内部元数据转交。原始 JWT 子协议在进入 DO 前剥离。DO 使用 WebSocket Hibernation API 和序列化 attachment 恢复会话；帧上限 8 KiB，消息正文去标签/控制字符后最多 2,000 字，事件和消息类型均为白名单。

消息写入以 PostgreSQL 为权威：每次写入先复核 token 过期/Redis 撤销状态，再在带 2 秒锁等待、5 秒语句超时和会话 advisory lock 的短事务中复核数据库身份与目标、插入 `store_service_log`、更新接收方 `store_service_record` 和未读数；事务提交后才通过对方主体 DO RPC 投递。接收方正在查看时再标记已读。跨 DO 推送失败不会把已提交消息伪装成发送失败，只记不含正文的结构化告警并向发送方确认持久化结果，避免客户端因错误重试制造重复消息。登出可按 token 关闭对应客服 socket，最后一个连接关闭才清理在线状态。

用户端新增 `/api/user/service/list` 与 `/api/user/service/record`，UniApp 先选择真实在线/最近客服，再派生 H5/小程序连接地址。客户端已删除硬编码生产 WS URL、`to_uid=0`、旧 login 帧和 REST+WS 双写；WS 可用时只发 WS，未连接时只走 REST 回退，并以服务端持久化回执加入消息。Admin 的历史、会话和发送入口现在明确返回 501，不能再冒充客服。

新增独立 `view/kefu-ts` Vue 3/Vite 工作台，不复用 Admin token：账号密码登录后持久化专用 `kefu` JWT，以 `Authori-zation` 访问 38 条兼容 HTTP 合同，并以 `cinashop` + `cinashop-auth.<token>` 子协议连接 `/kefuapi/ws`。桌面恢复深色工具栏、会话搜索/未读筛选、当前聊天、客户资料/分组/标签、客服转接、图片发送、订单/售后上下文、未支付订单改价/积分、订单/售后备注、商品上下文和公共/个人话术；移动端恢复会话列表、单会话页、客户资料侧抽屉、转接底部弹层、图片发送、订单/售后与商品详情底部弹层、订单管理底部弹层和快捷话术底部抽屉。资金退款按钮仍未开放。发送只走实时持久化回执，消息按数据库 ID 去重并把对应会话置顶；断线重连保留最后选择的客户而不是回到首次会话；个人话术支持个人分类、新增和删除。订单/售后与商品详情请求都用请求代次和会话 ID 防止迟到响应覆盖新客户。Pages Function保持 `/kefuapi/*` HTTP/WebSocket 同源转发，签名 `/api/assets/*` 在独立工作台无直连 API base 时改写为同源 `/kefuapi/assets/*`，SPA 直达刷新回退到 `index.html`。预览夹具严格要求 `import.meta.env.DEV && preview=1`，不进入生产路径。

### 私有 R2 上传与图片消息边界

旧 PHP 的认证客服 `POST /kefuapi/upload` 和游客 `POST /kefuapi/tourist/upload` 都接受 `file`/`filename` multipart 字段、每个身份 24 小时最多 100 次，并把图片放到 `store/comment`；聊天图片用 `msn_type=3`。旧附件元数据没有按客服账号隔离，游客上传还把用户 token 放在 multipart 正文中。新实现只恢复认证客服上传：在读取 multipart 前用 `kefu-upload:<store_service.id>` 强一致 Durable Object 桶执行 100 次/86,400 秒门禁，实际流与声明长度均限 10.25 MiB，文件限 10 MiB，并以魔数和声明 MIME 双校验 JPEG/PNG/WebP/GIF。失败尝试同样消耗限额是有意加固。游客上传继续关闭，不能由前端匿名开放。

客服对象写入正式私有 `cinashop-assets` R2，键为 `attachments/kefu/<客服账号ID>/<年>/<月>/<UUID>.<ext>`；`system_attachment` 固定 `type=1/relation_id=<store_service.id>/module_type=2/file_type=1/image_type=8`。UniApp 登录用户复用既有 `/api/upload/image`，固定用户 `type=3/relation_id=<uid>/module_type=3`。对象先写 R2，再在短事务中写 PostgreSQL；元数据失败立即补偿删除 R2。客户端拿到的 `url` 是稳定 `/api/assets/:id`，`src` 只是短期签名预览。

图片消息写入前在聊天事务内再次按角色复核附件 ID、owner type、relation ID、module type、file type和 R2 image type；客服不能发送其他客服或用户附件，用户不能发送其他用户或客服附件。`store_service_log.msn` 和两向 `store_service_record.message` 永远只保存规范路径，不能保存 15 分钟或 1 小时后失效的签名 URL。事务提交后实时回执、客服历史和用户历史才投影为最长 1 小时的 HMAC-SHA256 地址；旧 HTTPS 图片原样兼容。会话摘要统一显示 `[图片]`，不泄露长签名 URL。UniApp 已支持相册/相机选择、签名图渲染与预览，并保持 WebSocket 优先、REST 单路回退。

对照旧 `UserLabelCateServices::getUserLabel()` 另发现一个此前未计入的响应兼容缺口：旧 `GET /user/label/:uid` 返回全部启用标签分类，并给每个标签附 `disabled` 选中状态；当前 TS 原先只返回已拥有标签，导致客服无法新增标签。现已新增平台作用域分类/标签全集查询，排除隐藏分类和停用标签，按分类/标签排序返回并以当前关系标记 `disabled`；PUT 继续原子校验新增/取消 ID。生产隔离夹具覆盖未选/已选及保存后二者均选中，不能再用只读标签展示冒充编辑完成。

旧 `KefuServices::setTransfer()` 的权威语义是复制原客服与客户的消息窗口、把客服 UID 替换为目标 UID、创建目标会话，并向目标客服推送 `transfer`、向用户推送 `to_transfer`；但它没有请求幂等键、客户级并发锁或不可变审计，且保留原客服会话记录，历史消息也可能继续被当成访问凭据。新实现保留 `uid + kefuToUid` 合同，新增可选 UUID `request_key`/`Idempotency-Key`，以“请求键→客户→两个客服会话”的固定顺序取得 advisory lock，在 10 秒上限短事务中验证当前归属和唯一在线目标、复制历史消息、迁移客服/用户两向摘要、删除原归属并写入 `store_service_transfer`。审计表只保存请求键、四方 ID、源/目标记录 ID、复制数量和时间，不保存消息正文；同键同载荷返回幂等结果，同键异载荷失败，目标/源重复记录失败关闭。

转接完成后，HTTP 会话/用户/标签入口和客服 WebSocket 写入都只承认当前 `store_service_record` 归属，历史 `store_service_log` 不再授权原客服；用户旧 socket 若仍指向原客服也会被数据库分配检查拒绝。事务提交后才分别向原客服、目标客服和用户主体 DO 投递 `transfer_out`、PHP 兼容 `transfer` 与 `to_transfer`；DO 同步修改 hibernation attachment，原客服当前 `toUid` 清零，用户 `toUid` 切到目标客服。投递失败只记录不含消息内容的结构化告警，不回滚已提交转接或诱导重复执行。

### 商品上下文 PHP 合同与授权边界

本轮逐项对照旧 `ProductServices` 恢复四条原路径：`GET /product/cart/:uid`、`GET /product/visit/:uid`、`GET /product/hot/:uid` 和 `GET /product/info/:id`。已购列表仍从 `store_order` 与 `store_order_cart_info` 取得客户实际购买过的商品；保持 PHP 的一个非直觉兼容点：传入非空 `store_name` 时搜索范围扩展到整个可见商品目录，而不是只在已购 ID 中过滤。浏览记录仍读取旧 `store_visit` 并按访问时间倒序；热销仍以客户已购商品的 `type=1` 分类关系扩展同类商品，再按计算销量取前 20；详情仍读取 `type=0` 的 `store_product_description.description` 并安全解析轮播图。畸形轮播 JSON 降级为空数组，描述按纯文本渲染，避免把旧富文本直接作为可执行 HTML 注入工作台。

旧 PHP 商品入口只依赖客服登录，没有一致复核当前会话归属。新实现对已购、浏览和热销统一要求存在 `(user_id=当前客服 UID, to_uid=客户 UID, is_tourist=0)` 的当前 `store_service_record`；转接删除源归属后，原客服立即失去这些客户派生数据的访问权。商品详情属于已认证的平台目录读取，不要求伪造客户 UID。查询采用有界页码、每页上限和最长 100 字商品名；已购/热销使用数据库子查询，不把无界商品 ID 集合拉入 Worker 内存。

生产只读分布揭示了数据迁移的真实边界：商品 71、订单明细 28，但 `store_product_description`、`store_visit` 和 `type=1` 商品分类关系均为 0。也就是说，目标引擎上的查询、排序、授权、回滚与索引语义已经验证，真实生产仍无法展示历史浏览、分类热销或商品描述；这三类源数据必须从旧 MySQL 复制后再做业务验收，不能把空表安全返回算作数据迁移完成。

### 订单/售后 PHP 合同、筛选语义与脱敏边界

上一订单只读批次逐项审计旧订单组 18 条、退款组 5 条路由，先恢复四条可以在当前授权模型下闭合验证的只读合同：`GET /order/list/:uid`、`GET /order/info/:id`、`GET /order/refund/detail/:id` 和 `GET /refund/list`。客户订单列表继续固定 `is_del=0`、`is_system_del=0`、`store_id=0`、`pid=0` 与订单 `refund_type IN (0,1,3,6)`；状态 `0/1/2/3/4/5/6/7/8/9/-1/-2/-3/-4` 的旧 DAO 组合条件保留。旧控制器的固定 `is_del=0` 与 `type=-4` 追加的 `is_del=1` 本来就互相矛盾，因此该筛选继续返回空集，不把它误修成未经确认的“回收站”权限。`type=-1` 继续切换为该客户 `refund_type IN (0,1,2,4,5)` 的活动售后列表，不把已退款或已撤销记录混入。搜索继续覆盖订单号、收件人、手机号、用户 UID/昵称/手机号和订单商品名/关键词；页码、每页数量、时间、售后状态与搜索词全部有界。

旧 PHP 的客户订单列表只检查存在任意 `to_uid=客户 UID`，订单/售后详情甚至没有当前会话归属复核，`refund/list` 还是所有客服共享的全局售后目录。新实现要求客户列表、订单详情和售后详情都存在 `(user_id=当前客服 UID, to_uid=数据所属客户 UID, is_tourist=0)`；售后总表也只允许当前客服已分配客户的 UID 子查询。转接删除源 `store_service_record` 后，原客服的客户列表、详情和总表范围同时失效。列表先批量读取订单，再批量加载购物车和退款，不按订单逐条查询；订单/售后快照 JSON 限 256 KiB，坏 JSON 安全降级。

响应保留客服决策所需的订单号、状态、金额、收件信息、支付/配送类型、商品快照、发票摘要、优惠明细、售后原因和原订单号，但明确不投影 `verify_code`、`user_ip`、用户 `pwd`、原始虚拟卡内容或其他认证秘密。

本轮在上述只读基线上恢复六条不触发第三方支付渠道的管理合同：`GET /order/edit/:id`、`PUT /order/update/:id`、`POST /order/remark`、`POST /refund/remark/:id`、`GET /order/refund_form/:id` 和 `GET /refund/refund/:id`。两类表单不复制 FormBuilder 的内部序列化细节，而返回标题、动作、方法以及字段名/标签/类型/值/disabled/min/precision/required 的稳定对象；订单编辑仍为 6 个 PHP 字段，只有 `pay_price` 与 `gain_integral` 可编辑。`order/refund_form` 实际来自 `CommonOrder::refund`，处理主订单主动退款；`refund/refund` 才按售后单计算 `refund_price-refunded_price`，不能把两者合并为同一 ID 语义。

旧 `updateOrder()` 会把客户端提交的 disabled 商品总价/邮费也写回数据库，且无客服会话归属或并发锁。新实现兼容接收这些旧字段但要求与锁内快照逐分相同，只更新实付金额、改价差额和整数赠送积分；金额先转安全整数分，`change_price=(历史 pay_price+历史 change_price)-新 pay_price`，最后格式化为数据库精度。订单必须未支付、未删除且属于当前客服会话。事务按“客户转接锁→当前客服会话锁→订单锁→订单行锁”顺序取得锁，设置 2 秒锁等待/5 秒语句上限，在同一事务写 `order_edit` 状态；状态写失败时金额与积分全部回滚。完全相同的重放返回 `changed=false`，不再产生重复状态行。

`POST /order/remark` 保留“先按公开主订单号查找，否则按售后单号查找”的 PHP 兼容分支；`POST /refund/remark/:id` 保留数值退款 ID 分支。订单备注去空白后限 512 字，售后备注限 255 字；更新前同样锁定会话所有权与行，转接完成后原客服立即失权。相同文本重放为无写入；首次变化与数据在同一事务写 `kefu_order_remark` 或 `kefu_refund_remark`，不可变状态只记录客服 UID 和动作，不复制备注正文。

退款表单目前只恢复金额与状态门禁读取，不执行资金操作。主订单必须已支付、不是 `pid<0` 的拆分审计主节点、剩余可退金额非异常，且没有 `refund_type IN (1,2,4,5,6)` 的未撤销售后；售后表单要求关联订单已支付、已退金额不超过上限，并保持 PHP 对类型 1/5 已退完的拒绝。返回的旧动作路径只是下一资金批次的合同信息，Kefu 工作台没有渲染退款提交按钮。

旧订单/退款组现已补齐 9 条：`POST /order/delivery/:id`、`GET /order/export`、`GET /order/delivery_all`、`GET /order/delivery_info`、`GET /order/verific/:id`、`GET /order/writeOff/cartInfo`、`PUT /order/write_update/:order_id`、`GET /order/split_cart_info/:id` 和 `PUT /order/split_delivery/:id`。其中前端不调用带写副作用的旧 `GET /order/verific/:id`，而使用 `PUT /order/write_update/:order_id`；客服手工发货明确拒绝电子面单记录类型，电子面单必须进入可重试任务。该组仍有 4 条未迁移：语义存在路由/方法矛盾的 `POST /order/refund`、依赖外部面单模板提供商的 `GET /order/temp`、读取 query 而不是路径参数的 `GET /refund/agree/:order_id`，以及会实际调用余额/微信/支付宝的 `PUT /refund/refund/:id`。资金退款必须另做金额绑定、提供商幂等、处理中状态、重试/对账与客服会话作用域验证；当前仍不能描述为订单/退款域完成。

### 生产 Hyperdrive 直接证据与索引变更

按用户授权直接使用 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产 PostgreSQL 为 16.14；当前 `store_service` 账号/有效/在线均为 0，会话 0，聊天消息 3，话术和话术分类均为 0。代码与 schema 通过不等于客服可登录：仍需从源 MySQL 复制并复核客服账号、bcrypt 密码、`store_service.uid` 绑定、历史会话/消息、话术和分类。

随机 `codex_kefu_*` schema 直接运行真实服务，生产 DDL 应用前后各完成一次，最终 24/24 断言均通过：原 20 项身份、会话、标签、话术、消息、回滚、并发与索引门禁继续通过；新增转接触发器故障全回滚、同键重放/异载荷冲突审计、原客服 HTTP/WS 与用户旧目标权限撤销、两连接同键并发严格单次提交。结果为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；生产仍为客服账号/有效/在线 `0/0/0`、会话 0、消息 3、话术/分类 `0/0`。每轮临时 Worker都在 `finally` 删除。

商品上下文另由一次性 Worker 在同一正式 Hyperdrive 的随机 schema 调用真实 `KefuProductService`。10/10 项断言全部为 true：已购分页、显式搜索扩展全目录、旧 `store_visit` 顺序、已购分类扩展热销排序、详情精确合同、畸形轮播降级、非当前客户关闭、转接后立即撤权、详情仅要求客服认证，以及四个查询索引存在。最终 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；生产只读计数为会话 0、商品 71、描述 0、订单明细 28、访问 0、`type=1` 商品关系 0。

订单/售后上下文同样由一次性随机命名 Worker 通过正式 Hyperdrive 在随机 `codex_kefu_order_*` schema 调用真实 `KefuOrderService`。最终 10/10 项断言全部为 true：默认订单过滤、PHP 状态组合、商品搜索、`type=-1` 活动售后、订单详情脱敏合同、售后详情脱敏合同、外部客户三类读取关闭、售后总表按当前客服分配范围收口、转接后四类读取撤权，以及两个查询索引存在。最终 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；生产只读计数为会话 0、订单 29、可见根订单 28、订单明细 28、售后 3、用户 3、发票 0、优惠明细 0。一次性 Worker 已删除。

本轮订单管理写入场景继续直接绑定正式 Hyperdrive，在 `audit_kefu_b3886cf08d6c` 隔离 schema 克隆 `store_order`、`store_order_refund`、`store_order_status` 与 `store_service_record`，并为状态表改用私有序列。最终 14/14 项通过：临时 search path/归属探针、6 字段编辑表单、外部客服读取拒绝、`20.00→18.50/change_price=1.50/gain_integral=10.00` 精确分值改价、相同重放单状态、disabled 金额篡改拒绝、已支付订单拒绝、订单备注去空白/审计/重放、公开退款号回退与数值退款 ID 两条备注路径、主订单剩余 `25.00` 与售后剩余 `10.00` 两种表单、强制状态约束失败全事务回滚，以及转接后原客服写入拒绝。无需新增索引，既有会话方向索引、订单主键/公开单号和退款主键/公开单号已覆盖这些点查路径。

生产 `public` 基线与最终均为订单 29、售后 3、状态 17、会话 0；四张表的内容 MD5 分别保持 `1d9785e23b28b7a4ac7f7a5311636233`、`831a8dbff6b9c6a10d3025d2a4225f3e`、`c080706be1958699494b0584a33028ed`、`d41d8cd98f00b204e9800998ecf8427e`。前两次调试运行分别暴露非事务读取没有采用临时 search path、外层审计事务再套服务事务导致写入不可见；两次都在首个有效写入证据前失败并由 `finally` 删除 schema。为排除误写，随后只读核对 `public` 指纹完全等于基线，且 `oid=101/change_type=order_edit` 探针行数为 0。修正为“读服务显式 schema 事务、写服务自身短事务”后才取得 14/14 最终证据。临时 Worker `cinashop-kefu-audit-b3886cf08d6c`、隔离 schema、一次性入口与本地配置均已删除；主 Worker未部署。

履约/拆单/核销批次复用已经过生产隔离验证的 `SupplierFulfillmentService` 与 `StoreOrderWriteoffService`，并新增客服会话所有权授权回调。锁顺序固定为“转接请求→客服会话→订单结算→订单行”；配送员姓名与电话只取锁内启用的平台注册记录，客户端不能伪造；部分核销会旋转 12 位核销码，全部核销在同一事务结算且写不可变客服操作状态。发货、拆单、核销的业务写入、outbox 和客服审计任一失败都会整体回滚。所有客服只读入口也进入事务级 `SET LOCAL search_path`，避免 Hyperdrive 不保留连接启动 `options/search_path` 时隔离或多租户查询落回 `public`。

一次性 `cs-kfa-*` Worker 只绑定正式 Hyperdrive，在随机 `codex_kefu_fulfill_*` schema 中运行真实服务。13/13 断言全部为 true：元数据合同、外部会话关闭、手工发货原子性、重复发货拒绝、未结售后/未结束预售门禁、平台注册配送员权威值、部分核销旋码、全部核销只结算一次、拆单数量金额守恒、履约审计失败回滚、核销审计失败回滚和转接后撤权。生产 PostgreSQL 16.14 基线为订单 29、明细 28、状态 17、核销 0、会话 0、启用配送员 0；最终 `schema_created/schema_removed/public_state_unchanged=true`、临时 schema 0，所有精确审计标记为 0。场景同时确认生产缺少 `order_waybill_job` 和 `order_waybill_job_action`，即电子面单 `0098` 结构尚未落库，已列入后续 checklist。

首次隔离调试因把 Hyperdrive 启动 `search_path` 当成会话保证，播种在 `public` 留下 3 个 `audit-*` 用户、2 条测试会话和 1 条测试配送员；没有门店、订单、购物项、退款或临时 schema。检测后用多字段唯一标记和依赖顺序在单语句事务中精确删除，独立读回七类标记和临时 schema 全为 0。场景随后改为所有播种、读取和业务访问都使用事务级 `SET LOCAL` 并通过最终公共指纹验证。长临时子域还出现 TLS EOF，改短名称后排除；一次 `CONNECTION_CLOSED` 作为 Hyperdrive 瞬时故障重试，只有最终 13/13 报告计作通过。长/短两只临时 Worker、令牌和本地配置均已删除，主 `cinashop-api` 保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。

商品场景的过程失败也保留在审计结论中：首次入口遇到平台 `1042`；随后种子 SQL 使用 PostgreSQL 保留字 `unique` 未加引号；另有一次 Hyperdrive `Network connection lost`；调试 Worker 日志最终定位到场景末尾两次验证读绕过事务 `search_path`、误读 `public` 并报“商品未查到”。逐项修正后最终 10/10 通过；每次失败均清理随机 schema 和 Worker，调试 Worker与一次性本地令牌也已删除。这些早期失败不计作通过证据，最终报告才是权威结果。

本轮另用一次性 `cinashop-kefu-media-audit-*` Worker同时绑定同一生产 Hyperdrive 与正式 `cinashop-assets` R2，只在随机 `codex_kefu_media_*` schema 和随机客服对象前缀写入。10 项隔离断言全部为 true：客服与用户附件作用域、R2 私有缓存/owner 元数据、签名读取字节一致、聊天库只存规范路径、实时双方回执签名、客服历史签名、用户历史签名、跨作用域附件拒绝、PostgreSQL 触发器强制失败时 R2 补偿删除。最终 `schema_created/schema_removed/public_state_unchanged=true`、`temporary_schemas_after=0`、`r2_residue_after=0`；生产 `system_attachment` 当前仍为 0 行，`public` 五表及三条序列前后不可逆摘要完全一致。临时 Worker 已删除，主 Worker没有部署。

审计过程没有隐藏失败：前两次暴露事务外身份查询绕过随机 search path，第三次暴露只读目录仍在事务外，修正后又发现两项审计读数本身误读 `public`；所有失败均在进入生产索引步骤前退出并删除临时 Worker。另一次为 Hyperdrive `CONNECTION_CLOSED` 瞬时传输错误。最终证据要求所有读写都进入显式短事务，反而加强了生产 token 撤销复核与 schema 边界。

`0092_kefu_core_indexes.sql`、`0093_kefu_realtime_indexes.sql` 和 `0094_kefu_transfer_audit.sql` 已直接、幂等应用/确认于生产 `public`。原 8 个查询索引保持不变；新增空表 `store_service_transfer`、主键索引及 `sst_customer_time`、`sst_target_time`，并用 3 项检查约束限制正 ID、不同客服及非负数量/时间。相同 DDL 第二次执行定义不变；应用前后 10 张相关业务表及 5 条序列的行数/不可逆内容摘要完全一致，外部迁移与 Worker 内嵌版本字节等价。

`0095_kefu_product_context_indexes.sql` 同样已直接、幂等应用于生产 `public`：`soci_kefu_order_product` 支持客户已购商品，`sv_kefu_recent` 支持客户最近浏览，`spr_kefu_product_category` 与 `spr_kefu_category_product` 支持已购分类到热销目录的双向过滤。第二次执行后精确索引集合不变，业务行指纹不变。外部 `0095` 与 Worker 内嵌 `migration_0102()` 字节等价；一次性商品/调试审计 Worker 已删除，主 Worker没有部署。

`0096_kefu_order_context_indexes.sql` 已直接、幂等应用于生产 `public`：部分索引 `so_kefu_customer_orders(uid,id DESC)` 只覆盖客户可见平台根订单，`sor_kefu_customer_refunds(uid,add_time DESC,id DESC)` 只覆盖未撤销、未删除售后。第二次执行后精确索引集合不变，8 张相关业务表的行数/内容指纹不变。外部 `0096` 与 Worker 内嵌 `migration_0103()` 字节等价；一次性订单审计 Worker 已删除，主 Worker没有部署。

### 独立工作台浏览器证据与概念对照

前端先生成并归档桌面、移动概念稿，再按当前可闭合接口实现。应用内浏览器在 `http://127.0.0.1:5178/workbench?preview=1` 验收 1440×900 和 390×844：页面标题为 `CinaShop 客服工作台`、DOM 非空、无 Vite 错误层，所有阶段 console warning/error 均为 0。原话术、发送、标签、抽屉和返回流程继续通过；本轮桌面选择第二位在线客服后确认，目标单选 `aria-checked=true`，会话从 4 条降为 3 条并切换下一客户；移动端底部转接弹层完整显示两名客服和确认按钮，确认后同样移除原会话、切换下一客户并显示成功状态。首次移动验收发现的层级问题保持修复。

本轮在同一预览入口补做图片交互：桌面真实文件选择后消息区出现 256×256 图片、当前会话摘要变为 `[图片]`，1440×900 下 `scrollWidth=clientWidth=1440`；390×844 下图片约 223×223、关闭快捷回复抽屉后输入区无遮挡，返回会话列表仍显示 `[图片]`，`scrollWidth=clientWidth=390`。桌面与移动 console warning/error 均为 0。与概念稿逐项比较：四列桌面信息架构、深炭工具栏、冷白/浅灰表面、珊瑚红强调、会话选中态、左右消息方向、客户资料与分组、公共/个人话术切换、转接对话框、移动单会话顶栏和底部弹层均一致；实现有意使用文字首字头像而非生成稿人物图。此前省略的订单/退款入口已在本轮按下述只读边界补入，二维码登录仍保持关闭。移动实现把客户标签移入资料抽屉而不是永久占用聊天顶栏，给 390 px 视口保留消息高度。两张概念稿保存在 `view/kefu-ts/design/`，最终截图只用于验收，不作为生产资源提交。

商品上下文在同一入口补做 1440×900 与 390×844 验收。桌面右侧客户资料可在已购、浏览、热销三标签间切换，输入“云朵”后列表精确收敛为 1 项，点击后弹窗显示售价 `49.90`、会员价 `44.91`、划线价 `69.00`、库存/销量 `18/214` 和纯文本描述。移动端通过“客户资料”按钮打开抽屉，清空搜索后热销恢复 3 项，点击同一商品后使用底部详情弹层完整展示；两个视口 console warning/error 均为 0。清空输入时应用内浏览器的 `fill("")` 没有派发有效值变更，改用真实全选/退格后页面立即恢复 3 项，因此判定为浏览器驱动限制而非应用缺陷。验收后的代码复核再为详情请求加入代次与会话 ID 校验，避免快速切换客户或连续点开商品时旧响应覆盖新状态；修订后 Kefu 6 项测试与生产构建再次通过。

订单/售后上下文在同一入口完成 1440×900 与 390×844 验收。桌面默认显示 3 条订单，订单详情完整显示未发货状态、实付 `128.90`、客户/时间/支付方式、脱敏收货信息、备注和两条商品；切换“售后”并搜索“云朵”后精确收敛为 1 条，售后详情显示申请金额 `44.91`、原订单号、申请时间、原因、处理备注和商品。1440 px 下右侧栏宽 365 px、页面无横向溢出。390 px 下客户资料抽屉为 359 px，订单区宽 343 px；订单详情以宽 390 px、底边贴合 844 px 视口的底部弹层展示，页面仍无横向溢出。全流程 console warning/error 为 0。

订单管理本轮在 `http://127.0.0.1:4177/workbench?preview=1` 继续用应用内浏览器验收。桌面打开待付款 `wx202608250016`，确认“修改金额/编辑备注”只出现在详情管理区；编辑表单显示订单号和三项只读金额，把实付 `35.00→33.25`、积分 `0→8` 后保存，详情与右侧列表同时出现两份 `¥33.25`。首次检查发现预览详情已变而列表仍为 `35.00`，补齐预览列表同步、reload 后复测通过。订单备注保存为“已与客户确认改价”；售后 `refund202608260001` 的备注最终精确保存为“已核对退货凭证”。390×844 下客户资料抽屉完整显示三条订单，修改订单使用贴底面板，三项只读金额纵向排列，`scrollWidth=clientWidth=390`；1440×900 复测为 `scrollWidth=clientWidth=1440`。页面身份、非空首屏、无 Vite 覆盖层、所有交互状态与截图均通过，console warning/error 为 0。Kefu 6 项测试和生产构建通过，工作台 chunk 为 47.53 KiB（gzip 14.80 KiB）。

履约/核销界面在同一预览入口继续完成真实交互：打开已付款待发货单 `wx202608270001`，选择“平台配送”和启用配送员后保存，详情与右侧列表同步变为“待收货”，并出现“订单核销”；两条商品的剩余核销数均为 1，提交后详情和列表同步变为“已完成”。首次提交抓出 Vue 响应式 Proxy 不能直接 `structuredClone` 的预览缺陷，改为只同步 `status/delivery_type/_status` 后 reload 全流程复测通过。默认桌面视口和 390×844 下 `scrollWidth=clientWidth`，订单底部弹层可见且 console warning/error 为 0。最新工作台 chunk 为 55.73 KiB（gzip 17.14 KiB）。

### 当前判定、验证门禁与剩余工作

当前准确判定是：专用登录、核心只读/写入会话、带审计/幂等/权限撤销的客服转接、认证私有 R2 图片、客户已购/浏览/热销/详情、客户订单/订单详情/售后详情/按客服分配售后列表、未支付订单改价、订单/售后备注、退款表单、幂等退货同意与客服归属/金额绑定的资金退款、手工/平台/虚拟履约、拆单发货与客服核销、双向持久化、未读/在线状态、每主体 hibernating WebSocket、UniApp 用户端、独立 Kefu 工作台和生产查询/转接/媒体/商品/订单/履约/退款隔离场景已实现，并通过目标 PostgreSQL/R2 隔离验证与真实浏览器桌面/移动验收；仍不是“客服系统完成”或“生产可用”。本地门禁为 Worker 111 个测试文件/646 项单元测试、Kefu 前端 6 项测试、Worker 双 TypeScript 类型检查，以及 Admin/PC/Supplier/UniApp H5/Kefu 生产构建通过；Wrangler 4.122.0 最新主 Worker minify dry-run 为 2,227.49 KiB/gzip 549.58 KiB。Windows `workerd` 仍在任何断言前以原生 `0xc0000005` 退出，因此不能声称本地 runtime/WebSocket 测试通过。线上部署仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；本轮未发布主 Worker或 Kefu 前端。

剩余上线门槛按优先级为：复制并校验真实客服账号、会话、消息、附件、标签、话术、商品描述、访问记录和商品分类关系，并把旧 `store/comment` 对象迁入私有 R2 后重写可追踪附件关系；创建或迁移至少一个有效客服账号并用真实 token 验收 hibernation、断线重连、图片上传/过期重签、转接三端通知、100 次日限额、多会话、真实商品上下文及订单/售后管理上下文；为扫码/微信 4 条和游客 8 条建立一次性挑战、签名、作用域与重放合同，并在 OnePass 凭据/模板就绪后补齐面单模板读取；在 Linux CI 或受支持主机运行 runtime 套件；最后经明确批准部署主 Worker和 Kefu 前端并观察登录/上传/转接/商品/订单/退款写入失败率、Hyperdrive/R2 延迟、DO 告警和消息积压。二维码/微信/ticket 登录、游客聊天/游客上传和 ERP 写入/回调在一次性挑战、签名、重放保护与补偿合同完成前继续关闭。

## 手机认证与人机验证迁移详细审计（2026-08-15）

### PHP 权威合同与迁移前缺口

旧 `cinashop-php` 的用户短信链路不是单一验证码接口。`GET /api/verify_code` 先生成并缓存 5 分钟 `sms.key.*`；AJCaptcha 通过 `GET /api/ajcaptcha` 创建图形挑战、`POST /api/ajcheck` 做一次验证，客户端再把 `captchaType + captchaVerification` 提交到 `POST /api/register/verify`，服务端执行 `aj_captcha_check_two()` 后才检查手机号/IP/分钟频率并投递短信。旧 `GET /api/sms_captcha` 是另一套图片验证码兼容分支。PHP 源码还存在 `CaCacheServiceche::delete` 拼写错误，但实际用户短信主链依赖 AJCaptcha 二次校验，不能把这个旧错误解释为允许删除人机防护。

本批审计前的 TypeScript Worker 只把 `verify_code` 改成绑定 IP 的随机 UUID，PC/UniApp 获取 key 后直接调用 `register/verify`，没有渲染 AJCaptcha、没有提交验证证明、也没有等价的第三方校验。这个 key 能限制重放，却不能区分人和自动化请求；因此“短信生命周期已迁移”不等于“发送前防滥用已迁移”，属于明确的认证安全缺口。

### Turnstile 状态机与服务端边界

新实现以 Cloudflare Turnstile 替换 AJCaptcha，并把挑战创建改为 `POST /api/verify_code` 的 4 KiB 有界 JSON，避免手机号进入查询字符串、代理日志和浏览器历史。挑战记录只在 Upstash 保存 5 分钟，绑定规范手机号、用途隔离后的内部 capability、创建请求的脱敏网络标识、状态和绝对过期时间；创建端按网络每分钟最多 20 次。Turnstile 完成端每个 key 最多 5 次尝试，token 限 2,048 字符，向官方 Siteverify 发送 5 秒超时和 UUID 幂等键，响应以流式 16 KiB 上限读取。

服务端只有在 `success=true`、精确 `TURNSTILE_EXPECTED_HOSTNAMES`、`action=sms_send`、`cdata=挑战 UUID`、挑战时间不超过 5 分钟且不超前超过 30 秒时才把状态改为 `verified`。`TURNSTILE_SECRET_KEY`、公开 site key 或 hostname allowlist 任一缺失都返回“人机验证尚未配置”；网络、HTTP、超限和坏 JSON 统一失败关闭，不记录 token、secret 或原始 IP。短信请求再以 Redis `GETDEL` 原子消费挑战，并同时复核 verified、绝对期限、原创建网络、手机号和用途；所有判断都发生在用户重复查询、`sms_record` 写入与 Queue 投递之前。这样一个 token/key 不能跨手机号、跨注册/登录/重置/绑定用途或重复使用。

PC 在应用根挂载受控 Element Plus 对话框，以 `sandbox + no-referrer` iframe 加载 Worker challenge 页面；仅接受 challenge origin 且 key/type 精确匹配的 `postMessage`，随后还调用只读 status API 复核服务端 verified 状态。UniApp 新增全屏 `pages/auth/smsChallenge` WebView，H5 监听受信 origin 的 window message，App/小程序接收 web-view message；返回原登录/注册/重置/手机号管理页后再次查询 status，覆盖小程序只在后退/销毁时投递 message 的平台语义。Challenge HTML 使用 nonce CSP、`no-store`、`no-referrer`、关闭摄像头/麦克风/定位，并只允许 Cloudflare Turnstile 与微信小程序桥脚本。小程序正式发布仍必须把 challenge hostname 加入业务域名白名单；这属于部署前置条件，不是代码可自动完成的配置。

### 本地、真实 Worker 与生产 PostgreSQL 证据

新增测试覆盖缺 secret/site key/hostname 失败关闭，token/响应大小上限，Siteverify 请求字段，以及 hostname、action、cdata、时间、`success=false` 五类拒绝；结构测试确认 one-time `GETDEL` 位于数据库/Queue 前，PC 校验 origin，UniApp 复核 status。最终回归为 Worker 双 TypeScript 配置、100 文件/581 项单元测试、PC 生产构建、UniApp 类型检查/H5 构建、Wrangler minify dry-run（1,973.59 KiB / gzip 488.98 KiB）和 `git diff --check` 全部通过。Cloudflare Workers 类型最新版已实时核对为 `5.20260814.1`；仓库当前兼容范围无需为本批 API 改动强制升级锁文件。Windows runtime 套件仍在加载任何测试前以 `0xc0000005` 退出，0 个测试进入执行，继续明确记为环境失败而非通过。

本地浏览器通过只监听 `127.0.0.1` 的状态机夹具验证真实客户端交互，不向生产发送手机号或短信。PC 桌面和 390×844 均完成“切换手机登录→输入测试手机号→打开安全验证对话框→iframe 回传→status 复核→短信请求→60 秒倒计时”，页面身份/非空 DOM/成功提示正确，无 Vite 错误层、控制台 warning/error 或横向溢出。首次移动截图只因夹具遗漏生产页已有的 `box-sizing:border-box` 出现双向滚动条；把夹具尺寸模型与生产 HTML 对齐后复测无滚动条，不需要为假差异修改正式组件。UniApp H5 390×844 同样从验证码登录进入全屏 `smsChallenge`，回传后自动返回并开始倒计时，无错误层和横向溢出；唯一 warning 是 DCloud 依赖自身的 `vue-router` 旧入口提示。

临时 `cinashop-turnstile-audit-20260815a` Worker 只绑定生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，用不可逆令牌摘要保护单一 POST 审计端点。第一次上传因新加坡已到 8 月 15 日而 Cloudflare 控制面仍在 UTC 8 月 14 日，未来 compatibility date 被发布前拒绝，没有创建 Worker或访问数据库；改为 2026-08-14 后执行。真实 Worker 初跑发现 `fetch` 存为类字段后以 `this.fetcher(...)` 调用会在 Cloudflare 运行时产生非法接收者，本地 Node 单测未暴露；改为脱离 service receiver 调用并增加 `this===undefined` 回归断言后复跑通过。

最终远端探针确认官方测试 Siteverify 为 HTTP 200、144 字节、`success=true`、hostname `example.com`，但按官方测试语义没有 action/cdata；生产代码因此精确返回“人机验证用途不匹配”，证明没有因测试 key 弱化 metadata 门禁。未配置环境精确返回“人机验证尚未配置”。生产 PostgreSQL 16.14 前后均为用户 3、`sms_record` 0、有效重复手机号组 0、`codex_turnstile_*` schema 0，用户与短信审计脱敏指纹分别保持 `ba1a51010501276eaa13414ecc90e1dc` 与空集 `d41d8cd98f00b204e9800998ecf8427e`，`production_state_unchanged=true`。临时 Worker 已删除，远端 API 确认不存在且 URL 返回 404；主 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布本批代码。

生产主 Worker 当前 secret 仍只有 `APP_KEY`、`DEBUG`、`INTERNAL_CHAT_TOKEN`、`OPERATIONS_TOKEN`、`UPSTASH_REDIS_TOKEN`、`UPSTASH_REDIS_URL`；没有 `TURNSTILE_SECRET_KEY`、`ALIYUN_SMS_ACCESS_KEY_ID` 或 `ALIYUN_SMS_ACCESS_KEY_SECRET`，生产版本也没有正式 site key/hostname 配置。因此本批准确判定是“用户短信发送前的人机验证代码面、PC/UniApp 接入和生产只读/平台传输证据完成”，不是“生产短信可用”或“认证域全部上线”。剩余必须由运营创建正式 Turnstile widget、配置三项 Turnstile 值与小程序业务域名白名单，补齐 Aliyun SMS 签名/模板/密钥，使用真实 PC/H5/App/小程序验证发送、过期、重复、用途错配、弱网与 Queue 重试，再经明确批准发布主 Worker和前端。

## 小票打印迁移详细审计（2026-08-15）

### PHP 权威链路与迁移前风险

逐项审计 `cinashop-php/app/services/system/PrintDocumentServices.php`、`app/jobs/notice/PrintJob.php` 以及易联云/飞鹅云 provider 后，确认现行权威是 `print_document`，旧 `supplier_ticket_print` 只保留历史。平台 `supplier_id=0` 的打印机在下单后按 `print_type=2` 打印，付款后按每个履约订单的供应商打印机与 `print_type=1` 打印；PHP 手工打印却传入 `print_type=0`，与管理 UI 只允许 1/2 的配置不匹配，可能静默不出纸。旧实现还在请求/Job 链内直接调用第三方，没有持久 outbox、幂等事件、提供商租约、失败审计或“请求可能已被接受但响应丢失”的未知状态；订单、商品和备注可直接注入打印控制标记。飞鹅云使用旧 HTTP 端点，易联云 `origin_id=crmeb+time` 也不能稳定标识同一业务事件。

电子面单不是同一协议。PHP 的“一号通”配置、承运商面单签发和打印机小票属于不同服务边界；当前仓库没有可验证的一号通账号、协议或测试环境，因此本批只恢复收据打印，电子面单继续保持关闭，不能因小票出站代码完成而标记为已迁移。

### 当前 Worker、Queue 与操作边界

新增 `0090_print_job_outbox.sql` 及字节等价的 Worker 内嵌迁移，建立 `order_print_job` 和无订单隐私/凭据的不可变 `order_print_job_action`。订单创建和支付 outbox 在各自业务事务内写入稳定 `event_key`，定时 dispatcher 只向既有 Queue 投递 `{action, printJobId, eventKey}`；手机号、地址、商品快照、渲染内容和提供商密钥都不进入 Queue、日志或操作审计。`PENDING/ENQUEUING/ENQUEUED/PROCESSING/RETRYABLE/SENT/UNKNOWN/DEAD/CLOSED` 状态机分别覆盖 Queue 租约、提供商租约、明确可重试、明确失败和结果不明。过期的提供商租约进入 `UNKNOWN`，不会盲目重打；管理员或供应商只能在自身 `supplier_id` 范围内执行确认已发送、确认承担重复风险后重发或关闭不重发，原因至少 8 字且请求键幂等。

易联云恢复官方 OAuth 与 HTTPS print API，签名为 PHP 契约的 MD5 组合，`origin_id` 改为稳定事件键 SHA-256 派生；飞鹅云恢复官方 HTTPS `Open_printMsg`，签名为 SHA-1，内容限制 5,000 字节。两个提供商响应均有 32 KiB 流式上限和 8 秒超时。订单姓名、电话、地址、备注、商品名、规格和编码中的 `<`、`>`、`&` 与控制字符全部替换为全角安全文本，不能注入 `<QR>`、`<CB>`、`<BR>` 等控制标记。无效旧打印机类型不会阻断下单；真正调用前再次核对打印机作用域、订单存在性、供应商归属、提供商未变化及付款触发的已付状态。Admin 和 Supplier 均新增手工打印、任务台账、风险确认与操作历史入口。

### 生产 Hyperdrive 隔离证据与一次审计故障

一次性审计 Worker 直接绑定用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。第一次场景错误地让四张合成种子表在事务外依赖连接启动 `search_path`；Hyperdrive 池没有稳定保留该设置，场景在供应商读取订单时安全拒绝，但 3 条打印机、2 条订单、2 条商品快照和 2 条配置已落入 `public`。随后专用探针按固定高位 ID 与哨兵字段核对 `mismatched_rows=0`，确认没有打印任务/人工操作行和临时 schema，再在一个显式 `search_path=public` 的短事务中精确删除 9 条合成行；二次读回为各类 0。所有种子均显式提供 ID，因此没有消费公共序列。这个审计事故及修复保留在报告中，不把失败尝试隐藏为成功证据。

实现随后把打印 Service 的任务列表、操作历史和订单/打印机/快照/站点配置读取统一放入显式事务，隔离场景的所有种子、读取、写入和断言也改为每个事务 `SET LOCAL search_path=<随机schema>`。最终在 PostgreSQL 16.14 上应用真实 `0090` DDL并完成：下单/付款自动任务各只生成 1 条、重复事件为 0 新增、无效 provider 被跳过、手工请求重放返回原任务、供应商跨租户打印拒绝、平台/供应商账本各精确 2 条；所有 Queue 消息只有三个引用字段且不含密钥或渲染数据。两条独立 Hyperdrive 连接竞争同一消息时结果严格为 `sent + busy`，mock provider 只调用 1 次；传输结果不明只调用 1 次并进入 `UNKNOWN`，人工重发后成功，另两条分别人工确认已发送和关闭不重发，最终 `SENT=3/CLOSED=1`、不可变操作行 3。注入字符串均被全角转义。

最终报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；审计前后固定合成 ID 探针也全部为 0。生产真实状态为打印机 0、已启用 0、完整凭据 0，`public.order_print_job` 尚不存在，说明代码和 DDL仍未发布，也没有任何真实第三方出纸。一次性审计/清理 Worker 均已删除；主 `cinashop-api` 未在本批部署。

### 本地构建与浏览器证据、剩余门槛

最终回归为 Worker 双 TypeScript 配置通过、101 文件/588 项单元测试通过、Admin 与 Supplier 生产构建通过。Admin `/setting/print?preview=1` 在桌面完成新增打印机弹窗与任务台账切换，390×844 改为移动卡片后信息无挤压；Supplier `/printers?preview=1` 桌面显示启用的 outbox 风险提示与任务区。两端页面身份和非空 DOM 正确、无 Vite 错误层或控制台 warning/error。Supplier 新任务台账本轮没有可靠的 390×844 新截图，因此只把此前打印机配置移动验收与本轮 Admin 移动验收计为移动证据。

当前准确判定是“收据打印代码面、Queue/outbox、权限/人工处置、Admin/Supplier 主要操作和生产 PostgreSQL 隔离 E2E 完成”，不是生产可用。发布前仍须：取得源 MySQL 并复制 `print_document`/模板历史；由运营逐台确认租户、触发时机、联数和凭据；在测试订单上分别用真实易联云/飞鹅云验证出纸、明确拒绝、超时/断线与提供商后台对账；先部署 `0090`，再经明确批准发布 Worker/Admin/Supplier，并观察 Queue/DLQ 与 `UNKNOWN` 人工处置。电子面单仍是独立未完成域。

## 电子面单迁移详细审计（2026-08-15）

### PHP 权威协议、同步副作用与迁移前缺口

逐项审计旧电子面单 Service/Controller 后，确认 CRMEB 一号通根地址为 `http://sms.crmeb.net/api/`，认证端点 `v2/user/login`，签发端点 `v2/expr/dump`，认证头为历史协议的 `Authorization:Bearer-<token>`。旧系统把 `sms_account/sms_token` 同时复用于短信与一号通认证；`config_export_id` / `store_config_export_id` 实际表示默认快递公司 ID，不是月结账号，`*_siid` 才是云打印机编号。虽然旧 PHP docblock 的命名有误，真实请求中 `to_name/to_tel/to_addr` 承载收件人，`from_name/from_tel/from_addr` 承载发件人，迁移实现按已观察到的线网协议保持该方向。

旧实现的关键风险不只是 HTTP。提供商签发在订单发货数据库事务前同步执行；网络响应丢失时没有持久意图、租约或幂等证据。旧 GET 重打入口可能重新申请一个运单号，并吞掉提供商异常后继续返回页面，无法区分“明确未签发”和“提供商已受理但本地未知”。因此不能把它机械迁成普通 Queue 自动重试，否则可能为同一订单重复分配运单号。旧 HTTP 根地址也被替换为 HTTPS；新实现不再把短信配置当电子面单 secret，也不把凭据写入 PostgreSQL、Queue、日志或响应。

### 新任务账本、不可逆边界与发货事务

新增外部 `0091_electronic_waybill_outbox.sql` 与字节等价的 Worker 内嵌迁移，建立 `order_waybill_job` 和不含收/发件隐私、配置快照或凭据的 `order_waybill_job_action`。创建请求以 UUIDv4 请求键、规范化内容 SHA-256 和根订单 advisory lock 保证幂等；根订单在 `PENDING/ENQUEUING/ENQUEUED/PROCESSING/RETRYABLE/UNKNOWN/DEAD` 任一阻塞状态下只能有一个任务。Queue 消息严格只有 `{action, waybillJobId, eventKey}`，定时 dispatcher 只补投可安全重试的签发前状态。

提供商认证发生在不可逆签发前：缺 Worker Secret 或快递/模板/发件配置损坏进入 `DEAD`，认证临时失败最多按有界退避进入 `RETRYABLE`。一旦 `v2/expr/dump` 被调用，传输超时、非 JSON、畸形成功响应、提供商租约过期或签发成功后的本地发货失败一律进入 `UNKNOWN`，不会由 Queue 自动二次申请；提供商明确业务拒绝才进入 `DEAD`。签发成功先把单号、标签、提供商引用和 payload 摘要写入账本，再由既有 Supplier 履约服务在单一事务中写订单状态、`express_dump/kuaidi_label/is_stock_up`、发货状态证据和通知 outbox。整单与拆单共享同一订单结算锁；人工发货在任何阻塞面单任务存在时拒绝绕过。

人工处置分成四个有审计的动作：`APPLY_EXISTING` 使用账本已有单号完成本地发货；`CONFIRM_ISSUED` 由运营录入已在提供商后台确认的单号；`CONFIRM_RETRY` 只允许在账本没有单号且运营明确承担重复分配风险时重签；`CLOSE_NO_RETRY` 关闭不再签发。每次操作要求至少 8 字原因和独立 UUID 请求键，重放只返回同一决定；Admin 可跨供应商查看，Supplier 只能查看和处置自身任务。Admin `/setting/waybill` 与 Supplier `/waybills` 已提供状态汇总、台账和动作入口，订单发货弹窗可选择电子面单或手填快递，并保留拆单商品选择。

### 本地回归与生产 Hyperdrive 隔离 E2E

新增协议/服务测试覆盖外部 SQL与内嵌 DDL等价、UNKNOWN/DEAD 阻止人工绕过、Queue 脱敏与 ack/retry、HTTPS/字段方向/认证头、无云打印机的 `IMAGE + version:v1.1`、认证失败/明确拒绝/配置错误分类，以及 Controller 不在 HTTP 请求中同步调用提供商。最终 Worker 双 TypeScript 配置通过，102 个测试文件 594 项全部通过；Admin 与 Supplier 生产构建均通过。数据迁移静态目标更新为 216/216，其中 201 张 PHP 共有表、15 张 Worker 专用表。

一次性 `cinashop-waybill-audit-*` Worker 直接绑定用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，但不带生产 Queue 或真实一号通凭据。审计先对 11 张相关 `public` 表及其序列做行数、全行摘要和序列值指纹，再把旧表结构复制到随机 `codex_waybill_*` schema；所有克隆表的 `id` 默认值立即改接隔离序列，每个业务事务还执行白名单 schema 的 `SET LOCAL search_path`。第一次运行只因隔离商品快照唯一键超过旧 `VARCHAR(32)` 而在 seed 阶段失败，`finally` 已删除 schema，临时 Worker 也已删除；缩短 fixture 后严格重跑通过。该失败发生在提供商流程前，没有写入 `public`。

最终 PostgreSQL 16.14 报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`。同一消息由两条独立 Hyperdrive 连接竞争得到 `busy + sent`，签发端点只调用一次；请求键重放、活动根单唯一门禁、Supplier 跨租户创建/读取拒绝、Admin/Supplier 账本边界和 4 条不可变人工动作全部通过。Queue 只含三个引用字段，不含 Worker Secret、token、手机号、地址或发件信息；HTTPS URL、`Bearer-` 认证、收/发字段方向与 `IMAGE` 模式逐字段匹配。

两个模拟传输不明结果各只调用一次并进入 `UNKNOWN`：一条由人工确认可重签后成功，一条由人工确认已有单号后发货。另一个场景在提供商明确成功后用隔离 trigger 强制本地订单更新失败，账本仍保存单号并进入 `UNKNOWN`；移除 trigger 后 `APPLY_EXISTING` 完成发货，没有第二次提供商调用。明确拒绝进入 `DEAD` 后人工关闭。最终任务为 `SENT=4/CLOSED=1`，4 个订单各只发货一次、通知 outbox 精确 4 条、`waybill_delivery` 重放证据精确 4 条，外部状态和人工动作全部收敛。

### 生产现状与上线门槛

生产只读状态显示可用快递公司 2 个，但平台 `config_export_*` 0 行、供应商 `store_config_export_*` 0 行，`public.order_waybill_job` / `public.order_waybill_job_action` 均不存在。因此准确结论是“PHP 协议与风险审计、Worker 状态机、Admin/Supplier 操作、单元测试和真实生产引擎隔离 E2E 完成”，不是“生产电子面单可用”。本批没有真实调用一号通，没有真实申请运单，没有应用 `0091` 到 `public`，也没有部署主 Worker或前端；临时 Worker已删除，主 `cinashop-api` 仍保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。

上线前必须按顺序完成：取得源 MySQL 并迁移/复核平台及每个 Supplier 的电子面单配置与快递公司参数；由运营在 Cloudflare 通过 stdin 注入 `CRMEB_ONEPASS_ACCESS_KEY`、`CRMEB_ONEPASS_SECRET_KEY`，不得落入仓库或 CLI 参数；先在短锁/语句超时下应用并复核 `0091`；使用提供商测试账号或受控真实订单验证认证、签发、标签/云打印、明确拒绝、断线对账、UNKNOWN 四类人工处置、拆单及通知；再经明确批准发布 Worker/Admin/Supplier，并观察 Queue/DLQ、账本和人工处置。任何这些步骤缺失时都应保持电子面单入口关闭。

## Admin 首页统计迁移详细审计（2026-08-27）

### PHP 权威合同与迁移前缺口

逐项对照 `app/controller/admin/Common.php`、`StoreOrderServices::homeStatics/orderCharts`、`UserServices::userChart` 及相关 DAO 后，确认旧后台首页不是一个通用 dashboard 响应，而是四条不同合同：`GET /adminapi/home/header` 返回 `{info:[销售额,用户访问量,订单量,新增用户]}`；`GET /home/order` 接受 `thirtyday/week/month/year` 并返回金额/订单数双轴序列、上期/本期总数与涨跌；`GET /home/user` 返回 30 天新增用户和按 `pay_count` 划分的四组消费层；`GET /home/rank` 的实际查询已被 PHP 注释，稳定结果就是 `{list:[]}`。

迁移前 TypeScript 把 `header/order/user` 三条路由全部指向同一个 `AdminAuthService.dashboard()`，`rank` 未注册；响应又只有销售、订单、用户三个对象，漏掉访问量和 PHP 的 `info` 数组。旧 Admin TS 页面因此只能显示三张卡，没有订单周期图、用户曲线和消费分层。更严重的是早期 Worker 用运行时 UTC 的 `Date.setHours()` 切日，而 PHP 配置为 `Asia/Shanghai`，在每日 00:00～08:00 会把当天数据统计到错误日期；查询也没有一致排除 `is_system_del`、用户/商品日志软删除行。PHP 自身的 30 天/上周/上月区间还存在端点重叠，周轴从周日开始却以周一作为查询起点；迁移没有继续固化这些明显的比较偏差。

### 当前 Worker 与 Admin 实现

新增独立 `AdminDashboardService`，四条兼容路由和 `/api/admin/home/*` 别名分别绑定四个控制器，不再复用认证服务。所有日、周、月、年边界用固定 `Asia/Shanghai` 业务日计算并采用 `[start,end)`，上期与本期严格不重叠；非法 cycle 失败关闭。header 以 PostgreSQL CTE 一次返回订单销售、订单量、用户和访问日志，订单限定已付、未业务删除、未系统删除且退款状态为 0/3，用户与访问日志排除软删除。订单/用户时间分桶直接使用 `to_timestamp(...) AT TIME ZONE 'Asia/Shanghai'`，空日期补零；金额先在数据库以 numeric 聚合，响应再固定到分级与两位小数。30 天比较总数直接聚合上期原始行，不能用本期的 `MM-DD` 槽位映射上期。

Admin 页面已恢复四张指标卡、30 天/周/月/年订单金额与订单数双轴图、上期比较、30 天新增用户曲线和购买用户环形分层，并保留待办与平台总览。页面使用现有 ECharts、响应式 4/2/1 列布局和移动端纵向头部；API/类型定义与 PHP 兼容响应同步更新。`home/rank` 保持 PHP 当前空列表合同，没有把另一个 `/statistic/rank` 的商品销量排行偷换成旧首页合同。

### 生产 Hyperdrive 隔离证据与审计发现

永久审计夹具通过临时 Worker 绑定指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。最初隔离连接再次证实 Hyperdrive 不可靠保留 postgres.js 启动包中的 `search_path`：场景读到了 `public` 的真实聚合，但没有执行任何生产业务写入；随机 schema 与临时 Worker均在 `finally` 清理。修正为白名单事务内 `SET LOCAL search_path` 后，夹具准确读到隔离数据，并抓出实现中的真实缺陷：30 天上期日期键与本期不同，若以本期 `MM-DD` 映射会把上期比较归零。改为直接聚合上期行后复验通过。另一次调用在进入审计代码前收到 Cloudflare 1042 边缘错误；新临时 Worker等待传播后有限重试成功，未把边缘失败当作数据库通过证据。

最终 PostgreSQL 16.14 报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_row_counts_unchanged=true`。隔离夹具的 8 项断言全部为 true：四卡合同、系统删除订单排除、上/本期金额与数量、30 天零填充、用户曲线、删除用户排除、删除访问排除和空排行合同。生产只读聚合为 `store_order=29`、`user=3`、`store_product_log=0`；当前月有效根订单 19 单、销售额 2,687.20 元，当日为 0 单/0.00 元，近 30 天有效订单也是 19 单/2,687.20 元；3 个有效用户均为未消费分层，访问量为 0。这些数值与源 MySQL 尚未复制、生产数据量很小的既有结论一致，不代表真实运营报表已完成业务验收。

### 工程验证与当前判定

新增 5 项单元测试覆盖东八区午夜、周/月/年无重叠边界、cycle 白名单、涨跌方向、双路由面四条独立映射和 SQL 过滤结构。最终 Worker 双 TypeScript 配置通过，103 个测试文件/599 项单元测试全部通过；Admin 生产构建通过；主 Worker minify dry-run 为 2,071.00 KiB / gzip 512.70 KiB；`git diff --check` 通过。Admin 本地开发预览还在默认 1280×720 和 390×844 两种视口完成真实浏览器验收：四卡与待办/总览均有非空内容，订单周期成功从 30 天切换到周，3 个 ECharts canvas 持续存在，移动端四卡宽度一致并单列，`documentWidth === innerWidth`，控制台 warning/error 均为 0。预览数据只在 `import.meta.env.DEV && preview=1` 时启用，不进入生产构建路径。临时审计 Worker已删除，主 Worker和 Admin 前端均未发布。

本域的准确判定是“PHP 首页合同、统计口径、Admin 图表和生产 PostgreSQL 隔离验证完成”，不是线上已更新。发布前仍需用有权限的真实 Admin 对照旧 PHP 在同一业务时刻核验卡片、四种周期、退款/删除订单、月末年末与每日东八区切日；确认访问日志是否应继续以行数而不是 `visit_num` 求和；随后经明确批准发布 Worker/Admin 并观察慢查询与 Hyperdrive 缓存。原有 `/statistic/overview`、`/statistic/trend` 和 `/statistic/rank` 已在下一批统一为新统计服务的兼容别名，不再保留独立 UTC/宽口径实现。

## Admin 订单与商品统计迁移详细审计（2026-08-27）

### PHP 权威合同与迁移前差距

逐项核对 `route/admin.php` 及订单、商品统计控制器/服务后，确认旧后台统计模块不是迁移前 TypeScript 自行设计的三个通用端点。订单域的权威合同为 `GET /statistic/order/get_basic`、`get_trend`、`get_channel`、`get_type`；商品域为 `GET /statistic/product/get_basic`、`get_trend`、`get_product_ranking`，另有独立 Excel 导出 `get_excel`。迁移前 Worker 只有 `/statistic/overview`、`/statistic/trend`、`/statistic/rank` 三条合成接口，日期按 UTC，响应字段和筛选项均无法与 PHP Admin 页面互换；Admin 页面也只有薄弱的销售/排行展示。迁移覆盖率因此应判为订单/商品统计主链未迁移，而不是“三条统计接口已完成”。

PHP 实现本身还有不能照搬的确定性错误：32～92 天范围按“每 3 天”只抽样单日，遗漏中间两天；退款趋势累加 `pay_price` 而不是 `refund_price`；商品排行毛利率和访客转化率的表达式分别存在比值/减一方向错误。订单聚合还可能把父单和拆分子单同时计入，日期区间端点与其他页面不一致。这些问题在新实现中作为迁移纠错记录保留，不再固化为新系统行为。

### 统一统计服务、路由与 Admin 页面

新增 `AdminStatisticService`，在 `/adminapi` 与 `/api/admin` 两个路由面完整注册上述 7 条 PHP 主合同；旧三个 TypeScript 端点只作为标记废弃的兼容适配器调用同一服务。日期接受两个 `YYYY/MM/DD` 或 `YYYY-MM-DD` 值，缺省为最近 30 个东八区业务日，最大跨度 3,660 天；非法、倒置或超限输入失败关闭。所有窗口统一为 `Asia/Shanghai` 的 `[start,end)`，对比期长度精确相等，订单只统计根订单并排除业务删除/系统删除，商品、行为日志和关系同样排除软删除。排行排序字段、方向和分类 ID 均走白名单，不把请求值拼接为任意 SQL。

订单基础统计恢复支付金额/笔数、退款金额/笔数、优惠金额/笔数及逐项环比；趋势按短区间逐日、32～92 天连续 3 日、长区间逐月聚合，不再漏日；来源和类型分别返回支付金额/订单数。商品基础恢复浏览、访客、加购、下单、支付、成本、退款和转化率；趋势同窗返回访问、支付金额和退款金额；经营排行返回商品状态、浏览/访客/加购/下单/支付/收藏、支付金额、毛利率和转化率，并支持 PHP 页面需要的排序/分类筛选。金额用 PostgreSQL numeric 汇总后固定两位小数，百分比显式四舍五入，退款趋势使用真实 `refund_price`。

Admin `/statistic` 页面先恢复订单/商品两标签。订单视图包含 6 张比较卡、6 序列经营趋势、来源与类型图表/明细；商品视图包含 10 张指标卡、4 序列趋势和可排序经营排行。开发预览只在 `import.meta.env.DEV && preview=1` 生效。商品导出已在后续统计批次按 PHP 的结构化导出合同补齐为 UTF-8 CSV，不再列为缺口。

### 生产 Hyperdrive 隔离证据

一次性 `cinashop-statistic-audit-c6576f2c39e9` Worker 只绑定指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，在 PostgreSQL 16.14 的随机 schema 中克隆所需表、切换私有序列并运行真实服务；所有生产 `public` 业务表仅做前后行数与只读聚合。最终 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_row_counts_unchanged=true`。生产前后行数保持：`store_order=29`、`store_visit=0`、`store_cart=27`、`store_order_refund=3`、`store_product_log=0`、`store_product=71`、`store_product_relation=0`、`user=3`。

隔离场景 12 项断言全部为 true：订单基础精确值、趋势精确值、根单/删除单排除、来源、类型、商品基础、商品趋势、商品排行、分类过滤、删除日志/商品排除、连续 3 日桶不漏日、旧别名使用东八区业务日。生产最近 30 天只读值为支付金额 2,787.10 元、支付 20 单、退款金额/笔数 0、优惠 20.00 元/2 单；商品侧浏览 0、支付金额 2,787.10 元、访客转化率 0，排行 0 行。这些空行为与生产 `store_product_log/store_product_relation` 当前无数据一致，不能解释为源 MySQL 行为数据已经复制。

临时 Worker 版本为 `da3c770e-3774-4e97-bc5b-37ab8e50d233`，审计结束后已删除。远端主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；本批没有部署主 Worker或 Admin，也没有对生产业务行做任何写入。

### 工程验证、浏览器证据与剩余边界

新增 6 项单元测试，覆盖日期解析/上限、环比、排序/分类白名单、连续 3 日桶、路由映射和 SQL 过滤；相关统计/首页定向回归为 2 文件 11 项通过，全量为 104 文件/605 项通过，Worker 双 TypeScript 配置通过。Admin 生产构建通过；主 Worker minify dry-run 为 2,087.91 KiB / gzip 516.25 KiB，审计 Worker dry-run 为 698.91 KiB / gzip 129.29 KiB。Windows `workerd` 仍在断言前以 `0xc0000005` 崩溃，继续列为运行环境失败，不能记成 runtime 测试通过。

内置浏览器在 1280×720 验证订单 6 卡/3 图与商品 10 卡/排行 8 行，商品排序从浏览量切到支付金额；验收发现预览毛利率出现 JavaScript 浮点尾数，修复为两位小数后复验无长尾。390×844 下订单 6 卡/3 图、商品 10 卡/1 个可见图表均正常，`documentWidth=bodyWidth=innerWidth=390`，查询按钮可见；两视口控制台 warning/error 均为 0。该证据验证本地生产代码的渲染/交互契约，不是已发布 Admin 或真实账号 E2E。

本域当前可判定为“订单与商品统计主合同、纠错口径、Admin 页面和生产 PostgreSQL 隔离 E2E 完成”，不是整体迁移完成。商品导出及用户、交易、余额统计已由下一节补齐；仍需源 MySQL 的访问日志、商品行为和分类关系数据复制，真实 Admin 与旧 PHP 同时刻对账，生产慢查询/Hyperdrive 缓存观察，以及经明确批准后的 Worker/Admin 发布。

## Admin 用户、交易、余额统计与导出迁移详细审计（2026-08-27）

### PHP 权威合同、迁移前覆盖和确定性缺陷

本批逐项核对 `route/admin.php`、`UserStatisticServices`、`TradeStatisticServices`、`UserMoneyServices` 与旧 Admin 页面，确认剩余权威合同共 14 条：用户 7 条（基础、趋势、微信概况、微信趋势、地域、性别、导出），交易 2 条（今日/月度顶部、指定范围十项交易概况），余额 4 条（生命周期基础、趋势、来源、消耗类型），以及商品导出 1 条。连同上一批订单/商品 7 条，统计模块当前共有 21 条 PHP 主合同进入统一实现。迁移前 Worker 对本批 14 条路由覆盖为 0，Admin 也没有对应页面；不能把三个旧 TypeScript 合成端点视作用户、交易或余额统计已经迁移。

PHP 用户统计存在多处确定性偏差：32～92 天趋势仍按每 3 天只查一个自然日；拆分父子订单和删除订单可能重复进入成交人数/客单价；付费会员趋势筛选不足；微信累计值本期/上期读取同一当前快照，环比恒为 0；性别循环首个匹配后立即 `break`，最多只填一个性别；地域排序字段未经白名单且地址/用户删除状态不一致。交易统计还有 25 个小时刻度、余额支付环比拿两个“百分比”互比、任意日期上期参数位置错误、收入曲线混用下单时间/支付时间、月度人数遗漏根单/删除过滤等问题。余额统计则把 `status<>1` 的无效流水纳入生命周期与分布，且 3 日趋势同样漏日。新实现保留字段/响应形状，不复制这些可证明的错误。

### Worker 查询边界、14 条路由和导出合同

新增 `AdminExtendedStatisticService` 并把 14 条路由同时注册到 `/adminapi` 与 `/api/admin`。用户渠道只接受空值/`wechat/routine/h5/pc/app`，地域排序只接受 `allNum/newNum/visitNum/payPrice`；日期复用统一的东八区 `[start,end)` 解析与最大 3,660 天限制。用户基础一次返回 12 个 `{num,last_num,percent}` 指标，趋势恢复新增、访客、成交、充值、付费会员五序列；成交与客单价只使用已付有效根订单，用户/地址/微信记录排除软删除，付费会员只统计有效 `type=1` 订单。微信累计指标改为“截至窗口末/窗口初”的可比较快照，3 日桶做真实连续聚合；地域合并有效地址、访问与已付根订单，性别固定返回未知/男/女三桶。

交易收入由有效根商品订单、未退款成功充值、有效后台余额增加、付费会员和线下收银组成；支出由余额支付商品/会员、已成功佣金提现和已成功商品退款组成，毛利明确为营业额减支出。所有已付收入使用 `pay_time`，退款优先使用 `refunded_time`，无值才回退 `add_time`；本期/上期严格不重叠。顶部曲线固定 24 小时，日/月订单数和支付人数统一根单、删除与退款状态过滤。底部继续返回 PHP 页面需要的 10 项 `name/desc/money/type/rate/value`，并把旧 PHP 的下载 URL 兼容为有界 `data:text/csv`。余额基础保留生命周期语义，但只汇总有效用户/流水；趋势、来源和消耗均限定 `status=1`。

用户与商品 `get_excel` 保留 PHP 的 `header/filekey/export/filename` 元数据字段和原字段顺序，Admin 在浏览器端生成带 BOM 的 UTF-8 CSV；没有把 CSV 假称为 XLSX。商品导出恢复浏览/访客/加购/下单/支付件数、支付/成本/退款金额、退款件数和访客支付转化；用户导出恢复访客、浏览、新增、成交、转化、会员、充值与客单价。响应行数由统计时间桶上限约束，不会把无界明细一次载入 Worker 内存。

### 生产 Hyperdrive 随机 schema 证据

一次性 `cinashop-ext-stat-audit-*` Worker 只绑定用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。审计先读取 `public` 12 张相关表的精确行数，再在随机 `codex_extended_stat_*` schema 建立最小同构表和合成数据，事务内固定 `search_path` 后调用真实服务。第一次请求仅在 Cloudflare 边缘返回 1042，临时 Worker 在 `finally` 删除，未得到数据库通过证据；第二个临时 Worker版本 `e1a98e3f-d53e-42fb-a223-56e9cd9f685c` 返回 HTTP 200 并在响应后删除。

最终 PostgreSQL 16.14 报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_row_counts_unchanged=true`。17 项隔离断言全部为 true：用户 12 卡精确值、渠道、五序列、用户导出、微信概况、微信累计趋势、地域、三性别桶、商品导出、余额生命周期、余额趋势、余额两类分布、交易十项精确金额、交易 CSV 合同、24 小时顶部、无效/删除行排除和连续三日桶。`public` 前后保持：用户 3、访问 0、地址 5、微信用户 0、余额流水 0、充值 6、提现 5、其他订单 0、商品订单 29、购物车 27、退款 3、商品访问 0。

生产只读基线为当前有效用户余额 1,900.10 元、最近 30 天用户访客 0、综合营业额 2,787.20 元。该营业额比上一节只统计商品订单的 2,787.10 元多 0.10 元，来自交易域纳入的非商品收入；它证明多来源查询能在真实生产引擎执行，不代表源 MySQL 的用户访问、微信、余额或会员历史已经复制。审计后主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有部署主 Worker/Admin，也没有写入 `public` 业务行。

### 工程与浏览器验证、当前判定

新增 4 项结构/白名单测试；订单/商品与本批定向回归为 2 个文件 10 项通过，全量为 105 个文件/609 项通过，Worker 双 TypeScript 配置通过。Admin 生产构建通过；主 Worker minify dry-run 为 2,120.36 KiB / gzip 522.61 KiB，隔离审计 Worker minify dry-run 为 397.05 KiB / gzip 89.39 KiB。Windows `workerd` 仍在任何断言前以 `0xc0000005` 退出，因此 runtime 套件明确记为未执行，不记为通过。

Admin `/statistic` 现为订单、商品、用户、交易、余额五标签。桌面验收中用户普通渠道有 12 卡/3 图，公众号条件区增加 5 卡和第 4 张图；交易为今日/月度四卡、十项交易卡和 2 图；余额为 3 张生命周期卡、趋势与两类分布共 3 图，控制台 error 为 0。验收发现用户预览的上期人数出现 JavaScript 浮点尾数，已统一按人数整数格式化复测。390×844 下五个活动面板均可见，图表数依次为 3/1/3/2/3，`scrollWidth=innerWidth=390`、无横向溢出、控制台 error 为 0。商品 Blob 下载事件没有被内置浏览器捕获，因此不把浏览器下载事件写成通过；导出字段、顺序、行数和 CSV URI 已由单元/生产隔离场景验证。

当前可判定为“Admin 统计模块 21 条 PHP 主合同、明确纠错口径、五标签页面和生产 PostgreSQL 隔离 E2E 完成”，不是整体迁移或线上发布完成。上线前仍需取得可访问的源 MySQL，复制并核对 `user_visit/wechat_user/user_money/other_order/store_product_log/store_product_relation` 等历史；用真实受限 Admin 与旧 PHP 在同一东八区业务时刻对账日/月末、退款、删除、拆单、会员到期和微信取关；对有真实数据的范围执行 `EXPLAIN (ANALYZE, BUFFERS)`，再决定是否新增 `user_money(status,pm,add_time,type)` 等部分/复合索引；在 Linux CI 运行 runtime 套件；最后经明确批准发布 Worker/Admin 并观察 Hyperdrive 缓存、慢查询和 CSV 大范围导出。

## 社区社交迁移详细审计（2026-08-15）

### PHP 权威契约与迁移前缺口

逐行对照 `cinashop-php/app/controller/api/v1/community/CommunityUser.php` 及其 Service/DAO 后，确认旧用户侧社交合同至少包括八条路由：`GET community/user_info/:authorUid`、`POST community/update_desc`、`POST community/set_interest/:authorUid`、`GET community/follow_list/:type`、`GET community/user_friend`、`GET community/recommend_list`、`GET community/follow` 和 `PUT community/browse/:id`。迁移前 Worker 只有帖子、话题、点赞、评论以及一个不完整的好友列表，缺少社区资料、简介编辑、关注/取消关注、关注/粉丝列表、推荐作者、关注动态和持久浏览标记，不能把“社区帖子可读写”判定为社交域已迁移。

旧数据语义不是普通好友表：`community_interest.left_id` 是关注者、`right_id` 是作者；`community_browse.left_id` 是浏览用户、`right_id` 是帖子；“好友”来自推广关系落下的 `user_friends`，不等于互相关注。PHP 还允许同一作者资料或同一关注三元组存在历史重复，源表没有可证明的唯一约束，因此目标没有凭空增加唯一约束或把旧重复行静默丢弃。旧关注动态的 Redis 集合改为 PostgreSQL 最新可见帖子与 `community_browse` 的持久关系推导，避免缓存丢失改变未读语义。

### 当前 Worker 与客户端实现

新增 `CommunitySocialService` 恢复上述全部路由及 PHP snake_case 响应。资料读取只投影有效用户并返回等级、付费会员、好友数、自身、关注和粉丝状态；用户首次编辑/关注时可从有效账号原子物化缺失社区资料。平台资料严格限定 `type=0 + relation_id=0`，不会被脏的门店 `relation_id=0` 行抢占。简介限制 255 字并拒绝控制字符；控制器所有社区 JSON 正文使用流式有界读取，未再调用无界 `c.req.json()`。

关注写入以稳定升序取得双方 transaction advisory lock，再锁有效账号/资料；同一请求重放不漂移计数，双向并发不会形成 A→B/B→A 死锁。取消关注删除全部历史重复边，但 `follow_num/fans_num` 只按一个逻辑关系递减一次且不低于 0；重复有效资料会安全拒绝写入，等待显式历史数据清理。关注/粉丝列表按关系对象分组后分页，推荐先按作者选最新有效资料、排除停用账号/自身/已关注作者再排名分页，避免重复资料吃掉页容量；好友列表按 `user_friends` 双向去重，并返回数据库真实关注/粉丝状态。浏览公开帖子会逐次增加播放数，但同一用户/帖子只保留一条浏览关系。

UniApp 新增社区资料/关系 API、`pages/discover/people` 四标签页（好友、关注、粉丝、推荐）、关注/回关/互关/取消确认、分页去重与空态；社区首页新增“好友与关注”和带未读红点的关注作者条。PC 社区页同步恢复关注动态条、好友/关注/粉丝/推荐四标签、关注/回关/互关状态和取消确认，并采用桌面双栏粘性关系面板、移动端单栏布局。为真实渲染验收增加的演示夹具只在 `localhost/127.0.0.1` 且显式 `?preview=1` 时启用，不会改变生产请求。两个客户端的桌面和 390×844 浏览器验收覆盖入口、四标签、推荐关注后立即出现在关注列表、取消关注确认/取消分支和横向溢出；PC 直接预览控制台无日志或错误覆盖层，UniApp 唯一 warning 是依赖自身的 `vue-router` 弃用提示。

### PostgreSQL 索引与生产 Hyperdrive 证据

外部 `0087_community_social_graph_indexes.sql` 与 Worker 内嵌 `migration_0094()` 字节一致：`c_author_public_latest(type, relation_id, add_time DESC, id DESC)` 只覆盖公开已审核未删除帖子，`cu_recommend_rank(fans_num DESC, id DESC)` 只覆盖有效且有内容的作者。生产应用使用 `lock_timeout=3s`、`statement_timeout=20s` 的短事务；两条索引已创建并按 `pg_indexes.indexdef` 复核，DDL 前后帖子行/播放总数、资料行/关注和粉丝总数、关系行及好友行快照完全一致。

生产只读状态为 PostgreSQL 16.14、用户 `3/3`（总数/有效）、社区资料 0、公开帖子 2、关注 0、浏览 0、好友 0、重复资料组 0、重复关注组 0。随后临时 Worker 在随机 `codex_community_social_*` schema 中克隆 `user/community_user/community_relevance/community/user_friends/system_config/system_user_level` 七表，并把会发生插入的资料/关系序列替换为 schema 私有序列。第一次真实运行发现新 Service 在 Drizzle 事务对象上误用不存在的 `tx.$client`；这项仅靠 TypeScript/结构测试没有暴露的运行时缺陷已改为事务原生 `execute(sql)`，并增加禁止回归的结构断言后重新运行。

最终场景全部通过：缺失资料物化、等级/VIP/平台资料、简介保存、关注重放、互相关注、关注/粉丝列表去重、推广好友真实状态、推荐过滤、浏览前未读/浏览后已读、浏览关系幂等、播放数逐次增加、取消重放、历史重复边一次逻辑扣减、自关注拒绝、重复资料拒绝，以及两条独立 Hyperdrive 连接并发关注严格只产生 1 条边和 1 次计数增长。报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；场景后公共表仍为帖子/资料/关系/好友 `2/0/0/0`，目标索引 2。首个 canonical `workers.dev` 请求曾返回 Cloudflare 1042，有限重试后执行成功；最后一次冗余探活返回 1104，但此前独立 live-state 已确认临时 schema 0，随后清理端点也返回 `remaining=0`。所有七个失败或成功尝试的临时 Worker 名称均再次查询为不存在，主 `cinashop-api` 仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布主 Worker。

当前判定是“社区用户社交主链代码面与 PC/UniApp 主交互完成，并通过生产 PostgreSQL 隔离并发/回滚/幂等验证”，不是整个社区或整体迁移完成。社区 Admin 审核/运营已在下一批补齐；剩余包括评论点赞、帖子分享/精选/点赞列表/用户编辑等 PHP 客户端长尾路由、PC/移动端社区长尾体验、真实源 MySQL 社区资料/关系/好友/浏览数据复制与去重决策、真实登录用户与运营账号验收、运行时套件环境修复，以及经批准发布主 Worker/Admin/UniApp/PC。

## 社区 Admin 运营迁移详细审计（2026-08-15）

### PHP 权威合同与迁移前差距

本批逐项对照 `cinashop-php/app/controller/admin/v1/community/Community.php`、`CommunityTopic.php`、`CommunityComment.php`、对应 Service/DAO/Job 及 `route/admin.php:870-932`。PHP 方法级合同共 30 条：话题 7 条，内容 12 条，评论 11 条，覆盖统计头、筛选分页、表单元数据、创建/编辑、显示、推荐、星级、审核/拒绝/强制下架、平台回复、虚拟评论和删除。迁移前 Worker/Admin 对这一整组路由为 0 覆盖，因此即使用户侧帖子与社交已经可用，也不能把社区运营判为完成。

审计还确认 PHP 路由表本身存在三处不可执行分支：内容 `set_recommend` 指向控制器缺失方法，评论 `takeDownForm` 缺失，回复列表依赖的 Service 方法也未实现。新 Worker 保留 URL/HTTP method 兼容，但把这些路由实现为可工作的显式合同，而不是复制旧代码的运行时 500。PHP 的异步 `CommunityJob` 会在内容/评论变更后重算作者帖子数、话题使用数和评论数；删除还要清理话题/商品/点赞/浏览/评论点赞关系。新实现把这些副作用放回同一 PostgreSQL 短事务并即时收敛，避免后台返回成功而异步计数长期漂移。

### Worker 服务、并发与权限边界

新增 `AdminCommunityService` 与有界流式控制器，恢复全部兼容路由。内容正文上限 512 KiB，普通运营动作 16 KiB，控制器不调用无界 `c.req.json()`；标题、话题、商品、图集、视频、审核原因、虚拟身份和时间均有类型/长度/数量门禁。新内容固定为平台所有，编辑既有用户内容只更新可运营字段，不再沿用 PHP 会把 `type/relation_id` 强制改为 `0/0` 的所有权破坏行为。话题名大小写不敏感判重，全部话题选择器有 1000 条硬上限，既避免旧实现隐式截断 100 条，也保持 Worker 响应有界。

帖子、话题、资料和评论生命周期使用 PostgreSQL transaction advisory lock 与 `FOR UPDATE`；多话题按 ID 升序加锁，作者可见帖子数、话题关联数、帖子可见评论数和一级评论回复数全部按权威行重新统计。删除帖子会软删除评论并移除话题/商品/点赞/浏览/评论点赞关系；删除一级评论会连同回复软删并清理评论点赞。用户侧写入也同步加固：顶级评论过去遗漏 `is_reply=1` 且吞掉计数更新失败，用户删帖过去只改帖子两个标志而不级联；现在二者复用同一锁定生命周期，点赞读取帖子行也加 `FOR UPDATE`，可与后台下架/删除串行化。

权限新增 `community.view/community.manage` 域并进入 Admin 菜单。GET/HEAD 默认只读、写方法要求 manage；PHP 遗留的两个 GET 写路由 `topic/set_status`、`topic/set_hot` 被显式提升为 `community.manage`，查看角色不能借兼容 URL 改状态。未知 Admin 路由继续默认拒绝，超级管理员边界不变。

### Admin 界面与渲染验收

Admin 新增 `/community` 页面与“社区运营”菜单，提供内容审核、话题目录、评论治理三标签；可创建/编辑平台内容，操作显示/推荐/星级/审核/强制下架，管理话题，查看回复、平台回复、评论审核/显示/删除和添加平台或虚拟评论。页面只在 Vite 开发且显式 `?preview=1` 时使用演示数据，生产构建始终调用真实 Admin API。

应用内浏览器在 `http://127.0.0.1:4176/community?preview=1` 完成 1440×1000 与 390×844 验收：页面身份和非空 DOM 正确，无 Vite/框架错误层，两个视口控制台均为 0 warning/error；话题新建、评论回复、虚拟评论和内容拒绝弹窗均完成打开/取消状态验证。首次手机截图发现表格固有宽度把整个 flex 主容器撑宽，Hero 文案、第二个按钮、统计右列和标签被裁切；已把布局容器 `min-width`/窄屏固定宽度、Hero 网格、统计单列和卡片内部溢出边界收紧，复测后 Hero 完整换行、两个按钮与四张统计卡全部可见，宽表只在卡片内部承载。

### PostgreSQL 索引与生产 Hyperdrive 证据

外部 `0088_community_admin_indexes.sql` 与 Worker 内嵌 `migration_0095()` 字节一致，新增三个仅覆盖 `is_del=0` 热数据的部分复合索引：内容审核 `c_admin_moderation(is_verify,type,content_type,add_time DESC,id DESC)`、评论治理 `cc_admin_moderation(is_reply,is_verify,is_show,community_id,add_time DESC,id DESC)` 和话题目录 `ct_admin_catalog(status,is_recommend,sort DESC,id DESC)`。生产首次审计时三个索引均不存在；以 `lock_timeout=3s`、`statement_timeout=20s` 的单一短事务创建后，`pg_indexes.indexdef` 三项逐条匹配，DDL 前后五张社区业务表的不可逆摘要完全一致。

正式 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 的生产状态为 PostgreSQL 16.14、社区帖子/评论/话题/资料/关系 `2/2/0/0/0`，可见帖子/评论 `2/2`。一次性令牌保护的临时 Worker 随后在随机 `codex_community_admin_*` schema 克隆 `user/community_user/community/community_comment/community_topic/community_relevance/store_product` 七张真实表，并为会插入的五张表替换 schema 私有序列。场景通过平台内容创建、用户帖子编辑保持所有权、作者计数随显示/审核变化、无效商品全事务回滚、删帖级联；话题判重/标志/计数；用户顶级评论、平台回复、虚拟评论、评论显示/审核计数、一级评论级联和点赞关系清理；两条独立 Hyperdrive 连接并发发表评论后严格得到 2 行评论和 `comment_num=2`。

最终报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`，所有 14 个领域布尔断言为 true；独立清理端点再次返回 `remaining=0`。临时 Worker `cinashop-community-admin-audit-1786736147` 删除后由 Wrangler API 返回“不存在”。第一次上传因新加坡本地已到 8 月 15 日而 Cloudflare 控制面仍按 UTC 8 月 14 日拒绝未来兼容日期，发生在 Worker/schema 创建之前；将临时配置回退到 2026-08-14 后一次运行完成。主 `cinashop-api` 没有部署，仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。

本批的工程验证为 Worker 双配置 TypeScript 检查通过、96 个单元测试文件 549 项通过、Admin 生产构建通过、主 Worker minify dry-run 通过（1,917.36 KiB，gzip 474.61 KiB）、目标文件 `git diff --check` 无空白错误。Workers runtime 测试再次在任何断言前因 Windows `workerd` 原生 `0xc0000005` 访问冲突失败，不能计为通过。当前准确判定是“社区 Admin 主运营面代码与生产 PostgreSQL 隔离事务证据完成”，不是“已上线”或“社区/整体迁移完成”；仍需可访问的源 MySQL 数据复制、真实 Admin/用户账号验收、客户端长尾、运行时环境修复，以及明确批准后的主 Worker/Admin 发布。

## 社区客户端长尾迁移详细审计（2026-08-15）

### PHP 权威合同与审计前缺口

本批继续逐项对照 `cinashop-php/route/api.php:611-650`、社区控制器、Service 与 DAO。除前两批已经恢复的帖子基础读写、关注图谱和 Admin 运营外，PHP 客户端仍有配置、完整筛选、商品来源、话题计数、用户编辑、点赞/精选列表、分享、评论回复/点赞/删除等未迁移合同。审计前 TypeScript 路由缺少 `GET community/config`、`GET community/product_list`、`GET community/topic_count/:id`、`POST community/community_update/:id`、`GET community/like_list`、`GET community/elegant_list`、`GET community/share/:id`、`POST community/comment_like/:id` 与 `DELETE community/comment_delete/:id`；已有列表也没有完整实现 `topic_id/keyword/relation_id/content_type/ids/start_id/is_follow/order`，评论列表缺少回复分页与点赞投影，因此“帖子基础接口存在”仍不能视为客户端合同完成。

PHP 的用户编辑路径按请求 ID 更新，未把 ID 与登录用户绑定，存在横向编辑其他用户帖子的 IDOR 风险；新 Worker 不复制该漏洞，而是固定 `type=2 + relation_id=uid` 所有权，越权编辑明确拒绝。用户编辑已审核帖子后会清空拒绝原因并重新进入配置驱动的审核状态。帖子与评论点赞用 transaction advisory lock 串行化同一逻辑关系，重放不重复增减；一级评论删除与回复、评论点赞、帖子/一级评论计数在同一短事务收敛。正文采用 256 KiB 流式上限，小型点赞动作单独限制为 4 KiB，控制器没有退回无界 `c.req.json()`。

### 当前 Worker 与客户端兼容层

`CommunityService`、`AdminCommunityService`、`CommunityController` 和 v1 路由现已补齐上述客户端后端合同。列表支持公开审核门禁以及仅作者可见的待审/下架预览；详情同样允许作者预览，但只对公开已审核帖子记录浏览，避免作者预览被误计为公开曝光。话题与商品引用在写入事务内复核为公开有效对象；图文/视频字段、ID 数组、页长、关键字和视频 URL 均有有界归一化。用户商品列表分别从支付/浏览日志与收藏关系读取，支付记录按商品去重并取最新时间；评论支持顶级、直接回复和回复回复的 PHP 兼容 `reply_id/comment_reply_id` 结构。

PC 与 UniApp 的社区 API 包装已适配 Worker 的 `{list,count}` 返回，避免页面把分页信封当数组。UniApp 文字发布原先错误发送 `content_type=2`，严格视频校验后会被当成缺视频地址；现已修正为图文类型 `1`。这只是现有主社区页的协议兼容和构建证据，不等于所有旧移动端长尾交互页面都已逐屏验收。

### 索引迁移与生产 Hyperdrive 证据

外部 `0089_community_client_indexes.sql` 与 Worker 内嵌 `migration_0096()` 字节一致，增加三个与查询谓词对应的索引：公开回复 `cc_public_replies(reply_id,add_time,id)`（只覆盖可见、已审核、未删除回复）、用户商品日志 `spl_user_source_latest(uid,type,add_time DESC,product_id)`，以及收藏商品 `ur_user_product_collect_latest(uid,add_time DESC,id DESC,relation_id)`（只覆盖 `type='collect' AND category='product'`）。生产首次执行使用 `lock_timeout=3s`、`statement_timeout=20s` 的短事务；索引 DDL 已幂等应用。首次后置校验因 PostgreSQL 16.14 把 `varchar` 谓词标准化为 `::text` 而误报失败，DDL 本身已经提交；校验器随后兼容实际 `pg_indexes.indexdef` 并重新确认三项均为 true，业务行指纹未变化。

正式 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 的最终只读状态为 PostgreSQL `16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)`，帖子/评论/话题/关系/商品日志/用户收藏关系行数 `2/2/0/0/0/1`，可见帖子/评论 `2/2`，三个索引定义全部有效。一次性令牌保护的临时 Worker 在随机 `codex_community_client_*` schema 克隆 `user/community_user/community/community_comment/community_topic/community_relevance/store_product/store_product_log/user_relation` 九表，并为七张写入表替换私有序列。公共业务表只做前后不可逆指纹读取，场景写入全部位于随机 schema。

真实场景第一次暴露作者待审详情虽通过所有权门禁、却无条件调用只接受公开帖的浏览服务，最终错误返回“帖子不存在”；实现已改为只有公开已审核详情才计浏览。第二次暴露 `topic_id` 数字数组直接绑定 `ANY(...)` 时被 Workers/Postgres 驱动按字符串数组编码并拒绝；实现已改为每个整数独立参数化的 `IN (...)`。这两项都未被静态类型检查发现，修复后重新运行完整场景。

最终报告全部为 true：作者待审预览且他人不可见、跨用户编辑拒绝、编辑后重新审核、六类列表筛选、点赞与精选列表、双连接并发分享精确 +2；顶级/直接/嵌套回复结构、列表/回复/帖子计数、双连接评论点赞幂等、跨用户删除拒绝与作者删除级联；已购去重、浏览/收藏范围；话题可见计数与持久计数。报告同时为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`，独立清理端点返回 `removed=[]/remaining=0`。最终临时 Worker `cinashop-community-client-audit-1786740376` 已删除；主 `cinashop-api` 未发布，仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。

### 工程验证与当前判定

Workers 双配置 TypeScript 检查通过，96 个单元测试文件 552 项通过；PC 生产构建与 UniApp 类型检查/H5 生产构建通过。主 Worker Wrangler 4.122.0 dry-run 为 3,510.26 KiB、gzip 658.38 KiB，并识别现有 DO、KV、Queue、Hyperdrive、R2 和生产变量；目标已跟踪文件 `git diff --check` 无空白错误。Windows runtime 套件仍在加载任何测试前由 `workerd` 以 `0xc0000005` 退出，不能记作通过，但本批真实 Worker/Hyperdrive 运行时场景已经通过。

当前准确结论是“社区客户端 PHP 后端长尾合同、索引和生产 PostgreSQL 隔离行为已补齐并验证”，不是“社区 UI 全等价”“源数据已迁移”或“已经上线”。仍缺可访问源 MySQL 的社区数据复制与重复关系处置、真实登录用户和运营账号的部署后验收、PC/UniApp 所有旧长尾页面逐屏/真机验收、Windows runtime 或 Linux CI 复跑，以及用户明确批准后的主 Worker 与各前端发布。

## 手机认证生命周期迁移详细审计（2026-08-15）

### PHP 权威合同与迁移前高风险缺口

本批逐项对照 `cinashop-php/route/api.php:37-47,193-199`、`app/controller/api/v1/Login.php`、`app/services/user/LoginServices.php` 与 `RegisterValidates.php`。PHP 的公开生命周期包括 `GET verify_code`、`POST register/verify`、`POST register`、`POST login/mobile`、`POST register/reset`，登录态生命周期包括 `POST user/updatePhone` 与 `POST user/binding`。审计前 TypeScript 只有密码登录、无验证码注册和登录态改密，PC/UniApp 注册页直接提交手机号和密码，意味着新 Worker 一旦发布会绕过旧系统强制的短信注册验证；PC 的手机号登录按钮还明确显示“接入中”。

迁移也发现旧 PHP 的安全问题不能原样复制：手机号登录自动注册使用固定密码 `123456`，会制造已知凭据；手机号查询只取一行，历史重复手机号会由数据库物理顺序随机选中；`user_binding_phone(step=1)` 可跳过验证码；手机号写入没有数据库唯一约束或跨注册/换绑的一致锁；旧验证码比较不是恒定时间且注册、登录、重置、换绑共用 `code_<phone>`，可以跨用途复用。目标 PostgreSQL 的 `user.phone/account` 只有普通索引，不能在未审计全部源数据前直接增加唯一约束。

### 当前 Worker、Redis、Queue 与客户端实现

v1 已恢复上述七条路由，所有认证 JSON 正文统一限制为 4 KiB，不再调用无界 `c.req.json()`。二次审计发现最初只拆成 `user_register/user_mobile` 仍会让登录验证码跨权用于重置密码或换绑，因此继续细分为 `user_register`、`user_login`、`user_password_reset`、`user_phone_binding`、`user_social_binding`、`user_phone_update` 与既有 `supplier_application`；Redis key 和 Queue 消息都携带精确用途，控制器逐项只消费对应能力。六位码用 Web Crypto 无偏采样，比较改为 SHA-256 固定长度后调用 `crypto.subtle.timingSafeEqual`。公开挑战为 300 秒一次性 token，并绑定规范化客户端 IP；短信请求仍执行手机号/网络日限额、全局分钟限额和 60 秒冷却，审计表只保存用途与“redacted”，真实代码仅进入 Queue 和短时 Redis。验证码消费用 `SET NX EX` 分布式锁串行化，并以带随机锁 token 的 Lua compare-delete 释放，错误尝试不会删除正确验证码，成功验证码只能消费一次。未登录社交绑定不能复用登录态手机号绑定验证码。

注册、短信自动建号、换绑和空手机号绑定统一对 `user-phone:<phone>` 取得 PostgreSQL transaction advisory lock；换绑多个手机号时按稳定顺序加锁。每次写入都在锁内同时检查有效 `account/phone`，历史同一手机号若存在多个有效账号则拒绝登录并提示人工处理，不再随机挑选。短信自动注册改用不可猜随机密码摘要，新人标志/赠礼仍与用户行处于同一事务；密码重置更新 `pwd` 后，旧 JWT 的 `auth` claim 与数据库密码摘要不再一致。手机号型账号换号时 `account/phone` 同步，社交账号只补 `phone` 而保留原 `account`。认证退出现在真实删除 Upstash token bucket，不再返回成功但保留会话。

PC 已把手机号登录与注册验证码从占位改为真实“挑战 → 请求短信 → 60 秒倒计时 → 提交”流程，并新增 `/forgot-password` 找回密码页、登录页入口、认证保护的 `/user/phone` 手机号管理页和用户中心入口。UniApp 同步增加密码/验证码双登录、短信注册、`pages/auth/reset` 找回密码与 `pages/user/phone` 绑定/更换手机号页，个人资料和用户中心均可进入；退出登录也会先调用服务端撤销 Token，再清理本地凭据。PC 生产构建与 UniApp 类型检查/H5 构建通过。应用内浏览器除原 `/login`、`/register` 外，又在 `http://127.0.0.1:4178/forgot-password` 验收页面身份、完整四字段表单、返回登录入口、空手机号发送的本地错误提示、无框架错误层和零 warning/error；认证手机号管理页没有伪造生产账号做渲染成功声明，本地浏览器也不提供视口重设能力，因此 PC 390px、登录态手机号页及 UniApp 真机交互仍需真实账号/设备验收。

继续审计社交认证时发现两个现存高风险缺口并已修复。第一，微信/公众号新用户仍继承 PHP 的 `md5("123456")` 已知默认密码，现已改为不可猜的随机 UUID 摘要。第二，`wechat/auth_binding_phone` 虽要求登录，却继续用客户端提交的 openid 选择 `session_key` 和待修改用户；现在 `mpLogin` 同时写入 600 秒的 `session_key_uid:<uid>` 服务端会话，绑定接口只接受当前认证 UID，核对该 UID、服务端 openid 与 routine 身份关系后解密手机号，并复用与短信注册相同的手机号 advisory lock、重复身份拒绝和绑定/换绑事务。客户端 openid 不再参与身份选择，相同手机号幂等返回，服务端会话缺失或身份不匹配均要求重新登录。小程序登录和解密绑定的 JSON 正文也改用共享流式解析器限制为 8 KiB；该解析器另有声明长度、实际流长度、坏 JSON、数组根和非法上限测试。

公众号 OAuth 在 `store_user_mobile=1` 时现已恢复安全的“待绑定”语义：微信换码和用户信息请求全部结束后才生成 15 分钟随机能力键；没有手机号的新身份不会提前创建用户或签发 JWT。公开 `POST /binding` 先确认待绑定能力存在，再消费独立 `user_social_binding` 短信码，最后用 Redis `GETDEL` 原子取走经过提供商验证的身份。PostgreSQL 事务按稳定顺序锁定全局 openid、可选 unionid 和手机号，重新读取三类候选；多个不同 UID 会明确拒绝人工处理，只有唯一候选才能补手机号/渠道映射，没有候选才创建随机密码账号。Redis 与 PostgreSQL 无法共享提交，因此待绑定能力采用故障关闭的至多一次语义：数据库失败后必须重新完成提供商授权和短信验证，不会把已消费能力重新开放。

旧 `apple_login` 对客户端 `openId/email` 的直接信任没有复制。新 `POST /apple_login/challenge` 要求显式 `APPLE_SIGN_IN_CLIENT_IDS` 和 Redis，生成 5 分钟一次性 raw nonce 与 SHA-256 值；客户端必须把 `nonceSha256` 放入 Apple 授权请求。`POST /apple_login` 只接受有界 `identityToken + nonce_key`，用 Apple 官方 JWKS 验证 ES256、`iss=https://appleid.apple.com`、配置 audience、`exp/iat` 最大时龄与 nonce，以签名后的 `sub` 作为唯一身份，并用 nonce `GETDEL` 和令牌摘要 `SET NX EX` 双重拒绝重放；客户端 `openId/email` 均不进入身份选择。只有 token 中 `email_verified=true` 的 email 别名可用于初始昵称。验证完成后复用同一待绑定/冲突检测状态机。

### 生产 Hyperdrive 隔离证据与清理事件

正式 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 的只读状态为 PostgreSQL `16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)`、生产用户 3、有效重复手机号组 0。一次性令牌保护的临时 Worker 在随机 `codex_auth_phone_*` schema 中克隆 `user/system_config/wechat_user`，为两张写入表使用 schema 私有序列并直接调用真实 `LoginService/WechatAuthService`。原手机号场景继续全部通过；扩展社交场景还证明两条 Hyperdrive 连接并发提交同一 openid+手机号时只生成一个用户和一个身份映射，openid/unionid 与手机号分别指向两个既有 UID 时明确拒绝，相同 unionid 的新渠道 openid 归并到原 UID 并补手机号，新账号保持随机密码摘要。

第一次场景暴露 Hyperdrive 不保证事务外查询继承启动 `search_path`，预置夹具的 7 条固定审计用户误写入 `public.user`。审计 Worker立即按“固定 UID 列表 + `audit-<uid>` 昵称 + 固定测试密码摘要”三重守卫删除全部 7 行；独立状态确认用户数 `10→3`、审计标记 `7→0`、临时 schema 0，清理 Worker 随后删除。夹具已改为每一次读写都包在显式 `SET LOCAL search_path` 事务中，且场景异常也必须继续执行公共指纹检查。最新扩展场景运行前后生产用户均为 3、重复手机号组 0、用户/微信审计标记 0；报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`。临时 Worker `codex-cinashop-auth-social-3a7bef25d8b8` 已删除且 URL 返回 404。

### 生产就绪边界与剩余认证缺口

生产主 Worker 当前只有 `APP_KEY/DEBUG/INTERNAL_CHAT_TOKEN/OPERATIONS_TOKEN/UPSTASH_REDIS_URL/UPSTASH_REDIS_TOKEN` 六项 secret，当前版本绑定也没有 `APPLE_SIGN_IN_CLIENT_IDS`；Aliyun SMS 三项凭据同样不存在。实现会在任何审计行、Queue 或“发送成功”响应之前明确返回“短信服务尚未配置”，Apple 端点则在 JWKS 网络请求和数据库访问前返回“Apple 登录尚未配置”，不会伪造成功。因此本批证明数据库、并发、路由和失败关闭合同，不是真实 Aliyun 短信或 Apple 真机 E2E。最终工程回归为 Worker 双配置类型检查、99 文件/571 项单元测试、PC 生产构建、UniApp 类型检查/H5 构建、Wrangler 4.122.0 minify dry-run（1,960.96 KiB / gzip 485.26 KiB）与目标文件 `git diff --check` 全部通过；Windows runtime 套件仍在加载任何测试前以 `0xc0000005` 崩溃。生产部署状态继续是 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布主 Worker。

旧 AJCaptcha 人机二次验证尚未迁移；现有一次性挑战、同 IP 绑定和多级限流不能视为等价的人机验证。在配置短信提供商之前还应接入 Cloudflare Turnstile 或等价受支持挑战，并完成真实手机号收码、Queue 重试/失败、错误码、PC/UniApp 登录态手机号页和运营审计验收。PHP 的 `sms_captcha`、`ajcaptcha/ajcheck` 仍未迁移。Apple 服务端安全骨架虽已完成，但生产缺少 audience 配置；当前安装的 DCloud `LoginOptions` 只暴露 provider/scopes/timeout 等字段，Apple 结果虽返回 `identityToken`，却没有 nonce 注入字段，因此客户端没有用不安全降级强行接线。必须选用能把服务端 `nonceSha256` 传入 `ASAuthorizationAppleIDRequest` 的原生插件/模块，再用真实 iOS App、真实 Apple ID 验收首次/重复授权、隐藏邮箱、过期/错误 audience/nonce 和重放。主 `cinashop-api` 与两个前端都未发布本批，线上仍不是此实现。

2026-08-12 继续迁移系统自定义表单下单闭环。普通、秒杀、砍价、拼团和积分直兑不再因 `system_form_id > 0` 直接拒绝；客户端不允许指定表单 ID，Worker 以商品/活动记录为权威，在订单事务中读取仍启用且未删除的模板，把客户端值合并回服务端模板，校验组件完整性、可靠的必填标志、文本子类型、选择项、日期/时间范围、模板图片上限、总大小与图片引用，再同时写入 `store_order.custom_form` 原始组件快照和 `system_form_data(type=1, relation_id=order.id)` PHP 兼容归一化采集记录。私有 R2 `/api/assets/:id` 还必须属于当前用户，历史外链只接受 HTTPS。购物车响应已带活动权威 `systemFormId`，PC/UniApp 结算页恢复十类表单组件与图片上传；秒杀、砍价、拼团页面通过活动购物车进入统一结算，UniApp 积分直兑也先填表再提交。订单详情会安全解析不可变快照，只给订单用户签发仍归其所有的私有图片链接，非法或越权引用不会返回。拼团详情明确分开开团与参团，参团把团 ID 交给统一订单事务，不再由前端额外调用独立写接口；详细 PHP 对照后进一步纠正为“未付款订单只做持久名额预占，支付成功事务才创建公开 `store_pink` 团长/成员行”。Worker 类型检查、PC 生产构建、UniApp 类型检查/H5 构建、75 个单元测试文件 429 项和 Wrangler dry-run 全部通过；主 Worker 与 Pages 尚未发布本批。

同日通过生产 Hyperdrive 只读探针核验动态表单真实数据分布：`system_form` 0、启用模板 0、`system_form_data` 0、关联表单的商品/秒杀/砍价/拼团/积分商品均 0、带非空表单快照的历史订单 0，孤儿引用 0。探针随后删除。因此本批只能证明代码契约和生产结构就绪，无法以当前生产数据完成真实表单订单 E2E；也再次证明 PHP 源数据尚未复制到生产 PostgreSQL。

同日继续补齐门店店员扫码与平台配送员送达核销。平台 Admin 选择有效且唯一的 `delivery_service(type=0, relation_id=0)` 身份后，在同一订单事务内锁定配送员、生成全局不重复的 12 位核销码并写入 `delivery_uid`；配送员只能预览和核销分配给自己且 `delivery_type=send` 的订单，部分核销换码，全部核销复用统一收货结算。用户手工收货和 Cron 自动收货都拒绝/排除平台配送订单，PC/UniApp 只在正确状态显示“送达核销码”。UniApp 新增店员/配送员共用的扫码页、角色探测、掩码客户信息、逐行数量与不可逆确认。供应商端没有实名配送员作用域，因此服务端明确拒绝 `send`，界面只开放快递和虚拟交付，历史 `send` 仍可只读展示，避免继续制造无核销出口的订单。

生产 Hyperdrive 只读复核确认 PostgreSQL 16.14、事务 `transaction_read_only=on`、`public` 207 表，履约相关 6 张表与 12 个关键列全部存在。生产共有订单 29 条，但 `delivery_service`、自提订单、`delivery_type=send` 订单、`store_order_writeoff` 与配送商品行均为 0；核销码重复组、配送身份重复、缺失身份/核销码等不变量均为 0，因此没有真实样本可做扫码、部分核销或结算 E2E。索引清单发现生产缺少源码已声明的 `so_verify_code`；新增外部 `0078` / 内嵌 `0085` 幂等迁移后，以 2 秒锁超时和 10 秒语句超时在生产 29 行订单表上单独创建并复核：索引数 `0→1`，再次执行前为 1。只读审计 Worker 和索引 Worker 均已删除，两个临时 URL 返回 404；主 `cinashop-api` 与 Pages 没有发布本批代码。

在用户明确授权直接使用生产数据库后，又通过同一 Hyperdrive 在生产 PostgreSQL 中创建随机命名的临时隔离 schema，复制核销路径实际需要的 11 张表并把退款、状态和核销审计默认序列替换为 schema 私有序列。合成数据完整跑通门店部分核销、换码、最终结算、错误配送员拒绝、正确配送员送达、两条独立 Hyperdrive 连接竞争同一核销码，以及统一收货原语对自提/平台配送的中央防绕过；并发结果严格为 1 次成功、1 次拒绝、1 条不可变核销记录。扩展场景进一步证明重复店员/配送员身份会显示冲突并拒绝执行，未成团订单在商品数量和审计行不变的前提下拒绝核销、成团后才允许完成；售后申请与核销通过两条连接同时竞争时也严格只有一方成功，本次为售后获胜、核销由“待处理售后”业务门禁拒绝，没有锁超时或死锁。结束时 `DROP SCHEMA ... CASCADE` 后再以 `to_regnamespace` 确认 schema 消失，`public` 业务表行数与三条相关公共序列前后快照完全一致。临时集成 Worker 已删除且 URL 返回 404；主 `cinashop-api` 仍未部署。本证据是“生产数据库引擎/Hyperdrive + 隔离合成数据”的真实 SQL/锁集成测试，不是真实客户订单、真机扫码、真实商户验签支付回调或通知/打印 E2E。

同一授权下继续建立支付/取消随机隔离 schema，克隆订单、购物车、商品/SKU、发票、状态和 outbox 共 8 张表，并把状态/outbox 默认序列替换为 schema 私有序列。取消事务改为先 `FOR UPDATE` 锁订单，将订单状态、SKU/商品/活动库存、购物车、积分、优惠券补偿和 `cancel` 状态证据一次提交；支付事务同样锁订单，并把 `paid=0→1`、发票状态和不可变 `order.paid` outbox 一次提交。生产 PostgreSQL 故障触发器证明取消状态日志写失败时全部补偿回滚、支付 outbox 写失败时付款/发票状态全部回滚，移除触发器后均可安全重试。两条独立 Hyperdrive 连接的双取消严格为 1 成功/1 业务拒绝且只恢复一次库存；支付/取消竞争本次由取消获胜，支付等待后返回 `not-payable`；两个并发支付回调严格为 1 次 `paid`、1 次 `already-paid` 和 1 条 outbox。没有锁超时或死锁，临时 schema 删除后 `public` 8 张表行数及状态/outbox 公共序列前后完全一致；一次性 Worker 删除成功，URL 返回 404，主 `cinashop-api` 没有部署。本证据验证的是生产引擎上的合成状态转换，不等于真实商户验签回调、Queue 消费、自动分单或真实客户订单 E2E。

同日继续把实际 `createOrder` 入口抽成生产与集成场景共用的窄运行时核心：生产仍由 Sequence Durable Object 生成订单号，测试只注入隔离订单号和只读配置桩，不复制建单 SQL。审计发现原实现仅在事务外查询 `uid + unique`，并发同键请求都可能通过预检，唯一索引只能把重试变成数据库异常，不能兑现“返回已有订单”的幂等契约；现已在建单事务开头按用户和幂等键取得 PostgreSQL transaction advisory lock，并在锁内复查已有订单。临时场景克隆用户、门店、购物车、订单/快照/状态、商品/SKU、秒杀、砍价参与、拼团共 14 张生产表，为订单、快照、状态使用 schema 私有序列，通过四条独立 Hyperdrive 连接调用真实核心。PostgreSQL 16.14 的执行结果为：同购物车双 key 严格 1 成功/1 业务拒绝且库存只扣 1 次；同 key、不同购物车的两个重叠请求均成功返回同一订单，实际只有 1 行订单、1 个购物车被认领、库存只扣 1 次；商品与 SKU 各只有 1 件时两个不同用户竞争严格 1 成功/1 库存不足，失败事务的购物车认领和订单均回滚；秒杀最后 1 个名额严格单赢家，失败购物车保持可用，取消赢家后活动、商品和 SKU 库存/销量全部恢复；砍价取消同时恢复活动库存、商品/SKU 和参与状态 `4→3`；开团取消同样完整恢复拼团与商品库存。结束后随机 schema 已删除，`public` 14 张表行数及订单/快照/状态三条公共序列前后完全一致；额外只读探针确认 `codex_create_order_it_%` 残留 schema 为 0。两个一次性 Worker 均删除成功，主 `cinashop-api` 仍 100% 运行版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本轮没有部署。本证据补齐生产引擎上的合成建单并发与活动补偿，不等于真实客户地址/运费/优惠券/积分/动态表单组合、真实支付、通知打印或源 MySQL 历史订单 E2E。

余额支付继续从 Service 内复制逻辑收敛为可验证的 `applyStoreOrderBalancePayment` 事务入口。旧实现事务外读取订单、拼团和用户，事务内先扣余额再更新订单，0 元订单还忽略支付状态入口的失败返回；新实现固定按“订单行 → 用户资金”加锁，在订单锁内复查归属、付款/取消状态和拼团可支付性，金额以整数分解析，然后把余额条件扣减、`user_bill(pay_product)`、`paid=0→1`、拼团激活、发票与不可变 outbox 一次提交。扩展后的生产 PostgreSQL 临时场景新增 `user` 与 `user_bill` 并使用私有账单序列：同一余额订单双连接并发严格为 1 次 `paid`、1 次 `already-paid`，余额 `20.00→10.00` 且账单/outbox 各 1；余额仅 `5.00` 时业务拒绝，资金、账单、订单、发票与 outbox 全部不变；故障触发器拒绝 outbox 时余额扣减、账单、付款和发票全部回滚，移除后重试只扣 1 次；余额支付/取消竞争本次由取消获胜，支付返回 `not-payable`，余额仍 `20.00`、账单/outbox 为 0、取消状态为 1；0 元单成功付款，余额不变、资金账单 0、outbox 1。场景结束后 schema 删除，`public` 用户、账单、订单等 10 张表行数及账单/状态/outbox 公共序列前后完全一致，临时 Worker 删除且 URL 为 404；主 Worker 未部署。本证据验证的是隔离合成资金状态，不是真实用户余额扣款、支付后 Queue/Supplier 分单或退款返余额 E2E。

2026-08-14 逐行对照 PHP 积分商城后确认，旧系统的积分商品不是独立“扣积分即发货”链路，而是统一 `store_order(type=4)`：活动 SKU 与基础 SKU 同时校验，现金、运费、地址和自定义表单均由统一结算处理，`pay_integral` 在建单时固化、支付成功时才扣除，取消/退款则恢复活动/SKU/基础商品库存和积分。原 Worker 只有 `/store_integral/exchange/:id` 直兑，UniApp 也直接调用它；这会绕开现金支付、地址、购物车快照和支付 outbox。现已让详情返回活动与基础 SKU 的交集库存，购物车以服务端活动价/积分/运费/表单为权威；建单在用户+活动 advisory lock、用户行锁下复查累计限购，原子扣 `store_integral`、活动 SKU、基础 SKU 和商品库存，拒绝优惠券及普通积分抵扣叠加，并把 `pay_integral`、活动/SKU 快照、地址和运费写入统一订单。余额与第三方付款都在订单支付事务中条件扣必付积分并写独立账单；取消和现金退款按快照恢复三层库存，积分加现金退款按累计现金比例返还，零现金纯积分退款则按累计退货数量比例返还，部分退款 `40→70`、全退 `70→100`，重复完成返回幂等结果。旧直兑只保留统一流程同样认定无需配送的零现金/零运费兼容类型，其他类型强制走购物车，成功直兑也写不可变 `order.paid` outbox，不再静默跳过支付后履约。

生产 Hyperdrive 随机隔离验证分别跑了真实建单、支付/取消和退款核心。现金+积分订单得到服务端权威单价 `3.50`、必付 30 积分和完整活动快照，创建后活动、活动 SKU、基础 SKU/商品各只扣一次，取消精确恢复；同一积分余额订单并发支付严格 1 次 `paid`、1 次 `already-paid`，余额 `20.00→10.00`、积分 `90→60`，两种账单与 outbox 各 1，积分不足时资金/订单/证据全部回滚。退款场景新增两行纯积分商品的真实申请→完成→重放：首行完成后积分 70、`refund_status=3`，第二行完成后积分 100、`refund_status=2`，累计返还 60、账单 2，重放不重复。所有临时 schema 均删除且 `public` 行数/序列快照前后不变；临时审计 Worker 查询返回 `10007`（不存在）。UniApp 内置浏览器用本地拦截假数据完成桌面和 390×844 验收：选择两件“黑色 500ml”后统一结算显示收货地址、余额/微信入口和 `60积分 + ¥7.00`，积分订单不加载优惠券；一次误触提交被 localhost 拦截并返回本地失败信封，没有命中生产。主 Worker/Pages 均未发布本批。

2026-08-14 对 PHP 收银台、订单支付和充值路径逐行复核后，发现迁移中的高危资金缺陷：旧 Worker 的 `/order/pay` 会把 `cz...` 充值订单和 `yue` 组合交给 `rechargePay`，后者直接把 `price + give_price` 记入用户余额，却没有扣减既有余额，也没有任何第三方支付凭据，等价于可伪造充值入账。现已彻底移除该服务入口：通用订单支付明确拒绝充值订单，充值只能经独立 `/recharge/pay` 发起服务端权威微信预支付，实际入账只允许微信/支付宝验签回调传入精确金额和 `trade_no` 后执行；同一事务锁定充值单，条件更新用户余额和充值状态并写一条不可变 `user_bill(recharge)`，同交易重放幂等，冲突交易号、金额不符和重复订单号均拒绝。充值创建同时恢复最小金额、整数分、用户存在性、来源渠道和 Web Crypto 订单号校验，不再使用弱随机数。

订单、会员和充值现共用服务端收银台与有效支付能力矩阵。`GET /order/cashier/:orderId/:type` 会复核登录用户归属、已付/取消/超时、拼团和积分余额，返回服务端金额、到期时间、可用余额及每种方式的禁用原因；`GET /payment/readiness` 同时要求数据库开关、HTTPS 回调地址和当前 Worker secret/证书完整，避免只凭前端或数据库开关展示不可工作的支付按钮。微信 JSAPI `openid` 只按登录 UID 和 `Form-type` 在服务端解析，客户端传入值不再可信；PC 使用服务端 `code_url` 生成二维码并轮询订单状态，UniApp 按 H5/公众号/小程序/App 分支处理，所有外部渠道均在回调确认前保持“待支付”。复核还发现商品订单的“已支付”幂等分支没有在订单锁内核对渠道/交易号，两个不同第三方交易并发时第二个可能被错误确认；现已改为只有相同 `pay_type + trade_no` 才返回 `already-paid`，冲突交易在事务内拒绝，支付宝按订单号回调也不再绕过该检查。

生产只读支付就绪审计确认 PostgreSQL 16.14 上订单、充值、会员订单和微信用户表均存在，但 `pay_weixin_open`、`ali_pay_status`、余额支付和线下支付开关当前全部关闭；系统配置没有可用微信 AppID/商户号/证书序列号或最低充值额，主 Worker secret 列表也没有微信或支付宝支付凭据。生产共有 6 条充值记录：5 条未付、1 条已付；已付历史行没有 `trade_no`，重复 `order_id` 为 0。初查发现 `user_recharge` 的三个 `0082` 查询索引尚未应用，随后以 `lock_timeout=2s`、`statement_timeout=10s` 直接执行幂等 DDL；独立防缓存查询确认 `ur_order_id_lookup(order_id)`、`ur_uid(uid)`、`ur_uid_paid_time(uid,paid,add_time,id)` 精确存在，业务快照持续为 6 行、已付 1、总充值 550.00、总赠送 0.00。第一次 DDL 后的同版目录查询曾命中 Hyperdrive 旧缓存并错误显示空索引；探针因此加入一次性查询参数，重新部署后的事务内和独立只读结果一致。进一步逐行对照 PHP 后删除了 Worker 原先硬编码的 100/200/500 元虚构套餐：`system_group + system_group_data(user_recharge_quota)` 现在是唯一权威，服务端按 `rechar_id` 重新读取价格和赠送额，拒绝客户端篡改；`/recharge/index` 恢复 `{recharge_quota, recharge_attention, user_extract_balance_status}` 旧响应契约。生产再次只读确认启用档位为 0，因此客户端保留自定义/本地金额按钮但不会显示虚构赠送。PHP `type=1` 佣金转余额也已恢复：先锁用户并扣除仍冻结佣金，再把 `user_recharge(balance)`、`user_money(extract)`、`user_extract(balance)`、`user_brokerage(extract_money)` 与 `now_money/brokerage_price` 双余额更新放在同一事务；PC/UniApp 仅在旧配置开关允许时展示，并在不可逆转入前二次确认。生产隔离 schema 证明冻结门禁、双连接单赢家、账单故障全回滚/重试及三用户资金总额守恒，3 组转换均有四表一致关联；schema 删除且 `public` 快照不变。生产只读聚合显示 3 个有效用户的佣金总额、冻结额和可转额均为 0.00；`user_extract_balance_status` 与 `recharge_attention` 均缺失，当前按 PHP 默认开关 1 处理，因此这仍是“配置未复制”，不是运营已确认开启。上述历史充值行只读保留，不伪造交易号或修改余额。随后经 Hyperdrive 在随机 schema 执行真实充值回调核心：两个并发同交易回调严格得到 `1 paid + 1 already-paid`，余额 `10.00→135.00`（充值 100 + 赠送 25）且账单仅 1 条；再次重放幂等，错误金额零落账，冲突交易号和重复订单均拒绝。随机 schema 已删除，`public.user/user_recharge/user_bill` 行数前后完全一致，所有临时 Worker 均已删除；主生产 Worker 仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布本批。该证据证明生产数据库引擎上的事务/并发语义，不等于真实商户验签、真实客户端支付或历史充值账务对账。

同日继续逐行还原 PHP 首单优惠。普通订单先依据 `newcomer_status`、`first_order_status`、新人时限、`user.is_first_order` 和是否存在 `type<>7` 已支付历史判定资格；折扣按 PHP `bcdiv(..., 2)` / `bcmul(..., 2)` 的向下截断语义和金额上限计算，并优先且排斥优惠券，随后才抵扣积分。Worker 现在把资格复核、`is_first_order=0→1`、订单/商品快照、购物车认领和库存写入放在同一事务；不同 key 的同用户并发先锁用户，因此最多一单获得实际优惠，取消不恢复资格，而后续失败会整体回滚。新增认证 `POST /order/first_order_quote` 以服务端有效普通购物车为权威，只读返回资格、互斥状态、小计与首单金额；PC/UniApp 结算页据此展示优惠、调整预估实付，UniApp 在互斥时隐藏优惠券且提交不携带 `couponId`。直接生产只读结果为活跃用户 3、`is_first_order=0/1/-1` 分布 `3/0/0`，订单 29、历史首单优惠订单 0、首单与券重叠 0；六项首单配置在 `system_config` 全部缺失，所以当前生产配置不会启用该能力。随后临时 Worker 通过同一 Hyperdrive 在随机 schema 调用真实预览与建单核心：200 元商品按九折计算 20 元优惠并精确封顶为 15 元，预览和最终订单金额均为 15 元，券保持未占用，订单与快照均为首单优惠 15、实付 185；取消后资格仍消费，下一单改用 5 元券并实付 95；已支付历史和超过 7 天用户均为原价；同用户双连接并发两单都成功但优惠严格为 `[0.00,10.00]`；库存为 0 时资格、购物车和订单全部回滚。schema 已删除且 `public` 业务行数/三条序列前后完全一致；临时 Worker `cinashop-first-order-audit-20260814` 已删除并返回 404，主 Worker 保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布。该证据验证生产 PostgreSQL/Hyperdrive 的合成并发与回滚，不等于源配置复制、真实用户下单或 Admin 运营验收。

随后补齐 PHP `/adminapi/config/user/register` 新人运营闭环。专用 Worker 服务只接受 16 个注册/新人配置键，缺失时返回关闭新人礼的安全默认值；保存时以 transaction advisory lock 串行化，在一个短事务中更新全部重复历史配置行或补建缺失行、写入 `newcomer_agreement`、锁内复核普通商品资格与基础 SKU，并替换 `store_newcomer` 和 `type=7` 活动 SKU。Admin 新增响应式“新人运营”页面、商品/优惠券选择、逐 SKU 专享价和 `config.view/config.manage` 权限分离。逐行审计同时发现原 Worker 只初始化资格标志，并未执行 PHP 注册赠积分、余额和优惠券；现在密码与微信注册均在用户创建事务中完成用户行、两类账本、优惠券库存、用户券和领取证据，余额继续兼容 PHP `(int)` 截断整元语义。密码注册按账号 advisory lock 在事务内二次查重；微信按稳定顺序锁 openid/unionid 并在锁内复核，避免并发重复用户或重复赠礼。

生产 Hyperdrive 只读结果显示上述 16 个配置键全部缺失，新人活动商品/活动 SKU、重复或失效目录均为 0，历史新人积分账、余额账、用户券和领取证据均为 0，因此没有改写 `public` 配置或擅自启用新人礼。随机隔离 schema 直接调用真实 Admin 和密码注册服务：首次保存得到 16 行配置、2 个活动商品/3 个活动 SKU，基础库存不变；替换后只保留 1 个活动商品、移除项软删除、价格为 `16.50`；无效商品使配置、协议和目录全部回滚。注册得到积分 100、余额 `9.00`（配置 `9.99`）、资格标志、积分/余额账、用户券和领取证据各 1；同账号双连接严格 1 成功/1 拒绝且所有赠礼 exactly-once；强制余额账写入失败时用户、券库存和领取证据全部不变。schema 已删除，`public` 11 张关键表的行数、全行内容指纹及 9 条序列前后完全一致；临时 Worker 已删除且 URL 返回 404，主 Worker仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。该证据不等于源 MySQL 配置/目录复制、真实微信登录或真实用户端验收，本批仍未发布。

退款完成继续从 Service 私有方法收敛为生产入口与集成场景共用的 `finalizeStoreOrderRefund` 事务核心。审计发现旧实现虽以退款单锁和订单结算锁串行化回调，却先把当前退款标为完成、再汇总累计金额，且没有拒绝“累计已退 > 订单实付”；后台异常记录、历史脏数据或两张同时完成的退款单可造成超额余额返还。新核心在同一事务中锁定退款行和订单行，以整数分读取已完成退款总额，在任何状态/资金/库存写入前拒绝累计超额；第三方退款还要求渠道 `SUCCESS` 的 `request_amount` 与当前退款金额一致。随后才一次提交退款/订单/发票、库存、余额与账单、积分/佣金累计冲正、拼团补偿、状态证据和供应商负向流水。生产 PostgreSQL 16.14 的随机隔离 schema 克隆 11 张真实表并使用账单/状态私有序列：同一余额退款双连接为 1 次 `completed`、1 次 `already-completed`，余额、账单、状态和库存只变 1 次；账单触发器故障时所有状态/资金/库存/发票写入回滚，移除后重试成功；两笔 `6+6` 竞争严格为 1 成功/1 次“累计退款金额超过订单实付金额”业务拒绝，余额和累计退款均为 `6.00`；两笔 `4+6` 均完成并精确收敛为全额 `10.00`；渠道确认 `5.00` 而本地记录 `7.00` 时零落账，修正为 `5.00` 后重试成功。临时 schema 删除并确认 `public` 11 张表行数及两条公共序列前后一致；一次性 Worker 和 Preview 版本均删除，主 `cinashop-api` 仍未部署。本证据不等于真实用户退款、真实积分/佣金历史对账或微信/支付宝商户 E2E。

同日继续审计退款补偿守恒。供应商负向流水原先按每笔退款独立四舍五入，`0.05` 元原结算额遇到 `3.33 + 3.33 + 3.34` 元三次部分退款会错误生成 `0.02 + 0.02 + 0.02 = 0.06`；现改为“累计退款比例对应的目标冲销额减去既有冲销额”，保持原四舍五入规则但全额时精确封顶，三笔增量变为 `0.02 + 0.01 + 0.02 = 0.05`。生产隔离执行同时暴露 `store_pink.is_refund` 被错误迁成 `SMALLINT`：PHP 实际把团长/接替者的 `store_pink.id` 写入该列，正常大 ID 会直接触发范围错误。模型、外部迁移 `0079` 与 Worker 嵌入迁移 `0086` 已统一为 `INTEGER`；生产列在短锁/语句超时事务中完成拓宽，现存 2 行的行数、非零数、最小/最大值与总和前后不变，复核时类型已为 `integer`、表大小 57,344 字节。扩展场景克隆 14 张真实表并替换 6 条默认序列：先在供应商交易写入点强制失败，证明余额、积分、佣金、供应商流水、退款/订单/发票/状态和拼团全部回滚；再完成 `3.33 + 3.33 + 3.34`，最终余额 `10.00`、赠送积分冲回 7、抵扣积分返还 5、佣金 `0.12` 全冲回、供应商 `0.05` 精确冲回，拼团成员标记退款且团长活动人数 `3→2`。另一全额场景证明团长退款后最早成员接替，存活成员重新归组且两张成员订单的 `pink_id` 全部重写。随机 schema 删除，`public` 14 张表行数和 6 条公共序列前后完全一致；临时 Worker 的 canonical/版本 URL 均为 404，主 Worker 继续保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。这仍是生产引擎上的隔离合成数据证据，不是真实客户退款或第三方商户端到端验收。

继续沿拼团超时的 Queue 至少一次投递语义审计时，发现原实现先在事务内把整团置为 `status=3`，再在事务外逐单退款；若 Worker 在两步之间或首个成员退款后中断，重投会因团已失败或团长 `is_refund` 已改变而直接跳过，Cron 也只扫描 `status IN (1,2)`，其余已付款成员会永久漏退。另一个缺口是已有进行中的部分售后会被超时任务直接复用却不补齐剩余金额，并且后续整单补退没有保存“未退款商品”快照，可能把库存回补到错误行。PHP 对照进一步确认旧 `cart_info` 是商品快照数组，并由元素 `id` 表示 cart ID，而不是新 Worker 的 `{cartIds}`；解析器现同时兼容 `id/cart_id/cartId` 和新格式。现已让失败团只要仍存在 `refund_status <> 2` 的已付款订单就重新进入游标扫描；消费者允许恢复 `status=3`，在订单结算锁内复用唯一进行中退款，完成后按整数分创建精确剩余金额，并把已完成商品快照的补集写入新退款记录。生产 Hyperdrive 随机隔离 schema 中，两个成员的失败团被扫描投递，同一消息经两条连接并发执行后两张订单各只有 1 条全额退款和 1 条余额流水，第三次回放不新增副作用；使用 PHP 旧数组快照的 `3.00` 部分退款双商品订单自动创建 `7.00` 补退款，两条记录分别保留不同 cart ID，最终余额与累计退款均为 `10.00`。完成后两个失败团均不再进入扫描；临时 schema 删除，`public` 14 张表和 7 条公共序列前后完全一致，临时 Worker 删除且 URL 为 404，主 Worker 版本未变。外部支付 `PROCESSING` 仍由既有退款支付状态和定时对账继续推进，本批没有真实微信/支付宝商户端证据。

2026-08-13 继续用真实 Cloudflare Queue、DLQ 与生产 Hyperdrive 做平台级故障恢复验证。临时 Worker 使用随机一次性鉴权、独立主队列/死信队列和隔离 schema，只在 schema 私有事件表中记录投递，不读写 `public` 业务行。显式 `message.retry()` 的消息从 `attempts=1` 重投并在 `attempts=2` 成功；消费者在首投记录事件后主动抛错，平台同样在 `attempts=2` 恢复；持续失败消息在主队列依次收到 `attempts=1/2/3/4`，证明生产配置 `max_retries=3` 表示初投加 3 次重试，随后以新消息 ID、重置为 `attempts=1` 进入 DLQ。审计由此发现短信消费者原 `attempts >= 8` 收口分支在当前配置下不可达；现已把 `ORDER_QUEUE_MAX_RETRIES=3` 与 4 次总投递集中为可测试策略，短信第 4 次发送失败时删除验证码并把 `sms_record.resultcode` 标为失败，单元测试同时读取 `wrangler.toml` 防止配置与代码再次漂移。隔离 schema 删除前确认 `public` 始终为 207 张表、190 个序列，随后两个消费者解绑、临时 Worker/两条队列删除，URL 返回 404；主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。本证据验证真实 Queue 重投、消费者中断和 DLQ 转移，不等于支付 outbox、拼团退款或 Aliyun 短信业务消息已在生产 Worker 上端到端消费；生产 `cinashop-order-dlq` 目前仍无消费者、持久告警或受控重放闭环。

同日把平台级证据推进到真实 `processOrderPaidOutbox` 业务消费器。主 Worker 的支付 outbox `ack/retry` 契约已抽成可复用入口；生产 Hyperdrive 审计发现连接池不保留 postgres.js 启动包中的自定义 `search_path`/`options`，因此隔离改为在每个经白名单绑定的业务事务开头执行 `SET LOCAL search_path`，故障状态写入也统一进入该事务入口。最终随机 schema 场景通过真实 Cloudflare Queue 单并发消费者运行 4 条合成已付款混合订单：正常消费、业务前消费者中断、过期 `PROCESSING` 租约和供应商交易写入故障。四单最终都严格生成 1 个 Supplier 子单和 1 个平台子单，买家 `pay_count=1`、供应商流水/交易各 1、根单/子单状态共 4 行且 `pay_success` 1 行、根/子商品快照各 2 行；中断与数据库故障均以 Queue `attempts=1→2` 恢复，过期租约把应用 attempt 从 1 提升为 2。故障第 1 次的事务内 checkpoint 明确为根单未拆分、`pay_count=0`、子单/流水/交易/状态/拆分快照全 0，解除故障后第 2 次完成。正常事件再投递两次均返回 `already-completed`，三次投递仍只有一套业务副作用和应用 attempt 1。服务器端总断言确认 `public` 相关表行数、公共序列无差异，审计订单/outbox 标记均为 0；随机 schema、一次性 Worker、主测试 Queue 与 DLQ 全部删除。主 `cinashop-api` 未部署，本证据仍不等于真实商户回调、真实客户订单、通知/打印或生产主 Queue 消费已上线。

随后补齐 PHP `queue_list` / `queue_auxiliary` 所提供的持久运维语义，而不是把 Cloudflare DLQ 当作可无限保留的数据库。新增 `system_queue_dead_letter` 保存实际接收 Queue、Cloudflare 消息 ID、原始时间/尝试次数、消息类型、脱敏正文、正文 SHA-256、出现/重放次数、状态、租约、操作人/原因和最后错误；同一 Queue + 消息 ID 幂等归档，相同正文只累计出现次数，ID 被不同正文复用则拒绝 ack 并重试。白名单只允许当前类型守卫仍认可的支付 outbox、定时维护/订单、拼团超时、附件清理和公众号二维码消息重放；短信验证码强制 `BLOCK_SENSITIVE`，手机号掩码且验证码/令牌等敏感键递归脱敏，旧版和未知消息为 `BLOCK_UNSUPPORTED`。Admin 重放要求认证管理员、显式 `REPLAY_DEAD_LETTER` 确认、8～500 字原因、SHA-256 与当前消息契约复验、最多 20 次和 120 秒租约；人工处置同样需要显式确认与原因。只有归档成功才 ack，失败采用有界指数重试，最终还有 `cinashop-order-dlq-unarchived` 备份 DLQ。`/adminapi` 与 PHP 兼容 `/api/admin` 两套路由均提供列表、受控重放和处置。

Admin 原“支付后置任务”入口现扩展为同一 ACL 下的“任务运维”，用双视图区分业务 outbox 与 Cloudflare Queue 死信。死信视图展示待处理/重放中/禁止重放/最早待处理四项持久摘要、状态和消息类型筛选、服务端脱敏正文、SHA-256、出现/重放次数及操作审计；内部 `replay_token` 不进入列表响应。受控重放和人工处置都使用独立原因对话框，8～500 字门禁与后端一致；敏感/不支持消息不出现重放按钮。桌面内置浏览器完整执行“详情 → 有效原因 → 支付消息重放 → `REPLAYED/replay_count=1`”和“短信正文脱敏 → 无重放按钮 → 人工处置 → `RESOLVED`”，摘要同步从 2/1 收敛为 0/0。390×844 下桌面表格切换为卡片，文档宽度严格等于 390px；验收发现详情抽屉受后台布局偏移后右缘达到 415px，已改为挂载 `body`，复测右缘精确为 390px，确认框也完整位于视口内。页面身份、非空渲染、框架错误层与控制台 warning/error 检查均通过；这仍是本地 preview 契约证据，不是生产 Admin 或线上 DLQ 消费证据。

真实 Cloudflare Queue + 生产 Hyperdrive 随机隔离 schema 场景复用了上述生产服务与消费者：支付类消息先在源 Queue 连续失败两次再转 DLQ，短信直接进入 DLQ；支付消息持久归档后再直接投递一次验证幂等，`occurrence_count=2`，受控重放后源 Queue 只处理 1 次并归档状态收敛为 `REPLAYED` / `replay_count=1`；短信正文中的验证码变为 `[REDACTED]`、手机号变为 `138****8000`，策略为 `BLOCK_SENSITIVE`，只能由管理员处置为 `RESOLVED`。投递事件最终严格为“失败 1、失败 2、重放处理 1”，业务处理计数为 1；隔离 schema 删除且当时 `public` 快照始终不变，临时 Worker、源 Queue、DLQ 与备份 DLQ 全部删除。随后在用户明确授权下，把外部 `0080` / 内嵌 `0087` 的同一增量 DDL 先在生产事务中完整创建并强制回滚，再实际应用；独立连接最终确认 `public` 为 208 表，`system_queue_dead_letter` 有 26 列、6 个约束、5 个索引、0 行，原 `store_order_outbox` 行数和序列均不变。正式 `cinashop-order-dlq-unarchived` 备份队列现已建立并完成独立消息闭环，但主 `cinashop-api` 仍未部署，因此线上 `cinashop-order-dlq` 暂时仍无消费者，归档/告警/重放代码尚未承载生产消息；本证据也不等于真实 Aliyun 短信、真实商户回调或真实客户订单 E2E。

同日继续审计 PHP 付费会员后台的 16 条权威路由并全部恢复：批次列表/新增/编辑/快速修改、卡列表/状态、套餐列表/选择/新增/编辑/停用、会员记录、权益列表/编辑/内容、会员协议读写和 `member_scan` 均已有 Admin API；旧 GET 写路由仍兼容，但服务端 ACL 明确要求 `paid_membership.manage`，新管理页自身使用 POST。新批次最多一次签发 6,000 张卡，卡号与密码使用 Workers CSPRNG，无偏采样；明文只在创建响应返回一次，后续卡列表只返回 `password_configured`。批次状态向卡片传播，列表同时核对声明/实际卡数和用量漂移，历史会员记录只显示掩码卡号。`member_scan` 的 H5 码由 Worker 本地生成 SVG data URI，不调用外部图片服务；小程序码只在已配置真实 AppID/AppSecret 时调用微信官方 API，失败或未配置会显式标记而不伪造图片。

继续逐行对照 PHP 用户会员路由后，恢复 `/user/member/card/create`、`/user/member/card/pay` 与 `/user/member/overdue/time`，并保留既有首页、卡密兑换和会员券列表。审计确认 PHP 把客户端 `price` 直接写入 `pay_price`，存在低价篡改风险；新实现只接受套餐 ID，固定按源系统语义把 `price` 作为划线原价、`pre_price` 作为实际优惠价，锁定用户和套餐后保存服务端价格/期限/永久属性快照。免费会员在建单事务内一次性领取并落支付证据；余额付款把条件扣款、`user_bill(pay_member)`、会员状态、订单付款和状态日志同事务提交；微信/支付宝仅在真实商户配置完整时下单，统一回调在验签后区分商品单与会员单、拒绝跨域同号、校验金额及交易号并幂等结算。UniApp 原占位 SVIP 页已改为真实套餐/权益/余额与三渠道支付入口，新增与后台二维码一致的卡密激活页。

上述服务通过生产 Hyperdrive 在随机隔离 schema 中实际执行：创建 1 个批次/3 张卡、2 个套餐、1 个权益、1 份协议和 1 条已支付会员记录，逐项证明卡号唯一与格式、密码格式、列表不回显密码、批次状态传播、使用计数一致、用户关联、免费套餐价格服务端强制归零、权益正文、协议 upsert 和记录卡号脱敏。隔离计数严格为 `1/3/2/1/1/1`；生产 `public` 前后行数与 6 条序列快照完全一致，审计唯一标记为 0。生产真实数据分布同时显示 `member_card_batch/member_card/member_ship/agreement/other_order` 均 0 行，仅迁移 seed 的 `member_right` 为 1 行，进一步证明旧 PHP 会员数据尚未复制。临时 schema 与 Worker `codex-cinashop-member-audit-8d3f1a2c` 已删除，URL 返回 404；主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。这是生产 PostgreSQL/Hyperdrive 引擎上的隔离合成数据 E2E，不是真实会员、真实购买或真实支付 E2E。

同日继续恢复 PHP `OrderPayHandelJob` 的虚拟商品自动交付，但修正其逐卡更新且异常后直接返回成功可能漏发的语义。卡密商品下单会拒绝陈旧商品类型、实体混单和门店自提，并免除运费；支付后沿用既有可重放 outbox，在同一 PostgreSQL 事务内按稳定顺序锁定履约订单/商品快照，以 `FOR UPDATE SKIP LOCKED` 原子认领 `uid=0` 的卡库存，库存不足或任一 SKU 失败时整单回滚，补库存后可重试。共享 `disk_info` 不消耗卡库存。交付成功一次写入 `status=1`、`delivery_type=fictitious`、受限大小的 `virtual_info` 与 `delivery_fictitious` 状态证据；列表不返回卡密，只有已登录订单所有者的详情会解码显示。PC 与 UniApp 订单详情均恢复卡号、密码/下载密钥和复制入口。

该核心通过正式 Hyperdrive 在随机隔离 schema 中运行：两个各需 2 张卡的订单竞争 3 张库存时严格单赢家、无重复卡，败方保持可重试；补第 4 张卡后完成，赢家重放无新增副作用。两 SKU 订单先认领第一 SKU、第二 SKU 库存不足时第一张卡和订单/状态全部回滚，补卡后重试成功；共享密钥订单不认领卡。最终 4 个已交付订单、5 条购物车快照、4 个 SKU、6 张唯一已分配卡和 4 条精确交付状态均满足断言，`public` 快照前后完全一致且审计标记为 0。canonical `workers.dev` 首次受本账户边缘 1042 阻断，改用 Preview URL 后场景通过；隔离 schema、Preview 版本和临时 Worker 全部删除，一次性令牌未落盘，主 Worker 仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`。这证明生产引擎上的锁、回滚与幂等语义，不代表旧 `store_product_virtual` 库存已复制、Admin/Supplier 已有批量导入能力、真实用户付款/通知已验收或本批代码已发布。

继续审计 PHP 卡密运营入口时发现四个迁移差异：旧 Admin 商品编辑会读取并返回含已售记录在内的完整卡号和密码；旧浏览器实际上已把 XLSX 转为 `virtual_list` 后提交，服务端并不需要解析上传文件；Supplier 保存路径漏写 `store_id`，历史供应商卡可能仍为 0；去重只依赖 `card_no`，数据库也没有可证明的唯一约束，且旧 Supplier 页面并未形成可复用闭环。新 Worker 因此新增 Admin `GET/POST /product/virtual/:id[/import]` 与 Supplier `GET/POST /product/product/virtual/:id[/import]`：Supplier 身份只从签名账号关系派生并以商品 `type=2 + relation_id` 判租户，Admin 继续经过服务端 `product.view/manage` ACL；列表只返回脱敏卡号、密码是否配置和分配状态，短卡号全部遮蔽，密码永不投影。导入兼容 PHP `{key,value}`、新 `{card_no,card_pwd}` 和仅密码行，限制 512 KiB/1,000 行、长度和控制字符，固定内容 SKU 明确拒绝。商品级事务 advisory lock 与商品/SKU 行锁串行化同商品批次，以 PHP MD5 身份加原字段比较抵抗摘要碰撞，只按真正新增数增加商品/SKU 可售与累计库存并写库存审计，不会把库存重置成 `uid=0` 卡数，也不会破坏下单阶段已预留的库存。

同一生产 Hyperdrive 的随机隔离 schema E2E 已证明：两条独立连接并发导入同批卡严格只有一方新增，重放为幂等跳过；跨 Supplier 读写均拒绝而 Admin 可查看供应商商品；固定内容和实物商品拒绝；仅密码卡可导入；响应不含任何密码/完整卡号；游标分页、供应商 `store_id`、商品/SKU 增量和库存审计精确；旧 `store_id=0` 供应商卡仍可由商品所有权安全查看。隔离最终为商品 5、SKU 5、卡 5、库存审计 2，全部断言为 true；`public` 四表行数与四条公共序列前后完全一致、审计标记为 0。随机 schema 与临时 Worker `cinashop-vinv-audit-ccbf1edef0a141` 已删除，远端查询返回 Worker 不存在；主 Worker 版本未变。本证据仍不等于旧卡库存已复制、真实运营账号验收、最小库存告警、敏感导出或真实付款通知 E2E。

继续补齐卡密库存风险告警：Admin `GET /product/virtual-alerts` 聚合平台与全部 Supplier 商品，Supplier `GET /product/product/virtual-alerts` 由签名账号关系限制为当前租户。仅统计未删除卡密商品的普通 SKU，并排除固定 `disk_info`；`available_cards < sellable_stock` 判为库存缺口，覆盖库存后的余量不超过可配置阈值（默认 5、范围 0～1000）判为低缓冲。结果只投影商品/SKU、归属和计数，不查询卡号/密码；列表按 SKU ID 游标分页，卡聚合复用现有 `(product_id, attr_unique, uid, id)` 索引。生产 Hyperdrive 只读汇总确认当前 `public` 卡密商品、卡密 SKU 与 `store_product_virtual` 均为 0，孤儿卡也为 0：生产仍无旧卡库存可告警，这一空分布再次证明源 MySQL 数据复制尚未开始。本地 `SOURCE_MYSQL_URL` 及候选 `.env`/`.dev.vars` 仍未配置。

同一临时 Worker 在随机隔离 schema 中把 Supplier A 可售库存调至 4、未分配卡维持 2，严格得到 1 个缺口；平台 SKU 可售/未分配均为 2，得到 1 个低缓冲。Admin 汇总为已扫描商品/SKU `2/2`、缺口 1、低缓冲 1；一页 1 行的游标为 `201→202`，Supplier A 只见自己的缺口，Supplier B 为 0，固定内容、实物和空的 Supplier B 商品均不进入结果，序列化响应不含 `card_no`、`card_pwd` 或任一合成秘密。原有并发导入、密码遮蔽与库存审计断言仍全部通过；隔离计数保持商品 5/SKU 5/卡 5/库存审计 2，`public` 四表/四序列前后不变、标记 0。临时 schema 和 Worker 已删除。Admin/Supplier 新页面均提供阈值、级别、汇总和补充卡密入口；桌面/390px 移动渲染、筛选交互、控制台 error 与文档横向溢出检查通过。主 Worker 仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批未发布；剩余卡密缺口是源库复制、只显示一次的受控敏感导出、真实运营账号/付款/通知/客户验收。

2026-08-14 继续对照旧卡密导出边界。PHP `StoreProductVirtualServices::getArr()` 按商品/SKU 直接取出全部 `card_no,card_pwd` 并回填商品编辑数据，既包含已分配记录，也没有短时票据、调用原因、一次消费或独立审计；这不是可沿用到 Worker 的安全导出契约。新 Admin/Supplier 路由改为两步式受控导出：先以显式确认串、8～500 字原因和当前签名身份创建 60 秒票据，再以原始随机令牌立即消费。数据库只保存 SHA-256 摘要，票据绑定角色、账号、Supplier、商品与 SKU，只允许普通卡密 SKU、最多 1,000 条且仅导出消费时仍为 `uid=0` 的未分配卡；消费事务以 `FOR UPDATE` 保证并发单赢家，重放、过期、跨租户、跨商品和已分配卡全部拒绝。明文只在成功消费响应出现一次，响应固定 `private, no-store`、`Pragma: no-cache`、`Expires: 0`、`Referrer-Policy: no-referrer` 与 `nosniff`，前端只在内存生成 JSON Blob，未把结果保存到响应式状态或持久存储。

外部 `0081_virtual_inventory_export.sql` 与 Worker 内嵌 `migration_0088()` 已建立 `system_virtual_inventory_export`：只记录票据摘要、身份/租户、商品/SKU、原因、请求/实际数量、状态与时间，不含卡号或密码；6 条约束和 5 个索引分别限制身份、状态、计数、过期关系并支持令牌唯一、操作者/商品审计和 READY 过期清理。生产 Hyperdrive 迁移过程中发现连接池会复用会话 `search_path`，因此每个内嵌迁移现在独立事务执行并先 `SET LOCAL search_path TO public`。一次早期 apply 的响应校验失败，但后续预检发现表已存在，不能声称该次失败自动回滚；随后以幂等 apply 和独立查询确认生产 `public` 为 209 表，新表 0 行、6 约束、5 索引、无秘密列，商品/卡库存行数与相关序列仍为 `71/0`、`71/1`。

正式 Hyperdrive 随机隔离 schema 的最终场景包含 29 个布尔断言，全部为 true：Admin/Supplier 建票、响应不含秘密、数据库只留摘要、仅未分配卡导出、租户绑定、双连接消费单赢家、重放/过期拒绝和精确审计均通过；隔离计数为商品 5、SKU 5、卡 5、库存审计 2、导出审计 3。清理后随机 schema 不存在，`public` 业务快照、卡密导出审计 0 行和公共序列前后完全一致；临时 Worker 已删除。Admin 与 Supplier 页面均在桌面和 390×844 下完成原因输入、二次确认、敏感提示和无横向溢出验收，最终“创建票据并立即下载”动作被取消，未触发明文导出。主 `cinashop-api` 未部署，线上仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；剩余项缩小为旧 `store_product_virtual` 真实复制、真实运营账号/付款/通知/客户验收和经批准发布。

## 优惠套餐迁移详细审计（2026-08-14）

逐行对照 PHP 后确认优惠套餐使用统一活动类型 `type=5`。`store_discounts.type=0` 是固定套餐，必须选择全部关联项；`type=1` 是任选套餐，必须包含所有 `store_discounts_products.type=1` 的必选项且总数至少 2。客户端提交的是套餐关联行、基础商品和套餐 SKU `unique`；套餐 SKU 通过相同 `suk` 映射到基础 `type=0` SKU，价格取套餐 SKU，但只扣减/恢复基础商品和基础 SKU 库存。有限套餐的 `limit_num` 每单只占用一次，取消或发货前全额退款只恢复一次；部分退款不恢复。`free_shipping` 覆盖基础运费，`is_support_refund` 必须固化到每条订单商品快照并在申请售后时执行。

审计前 Worker 只保留两张旧表和公开列表/整数分价格组装，没有完整套餐购物车契约、`type=5` 下单复核、限额锁、免邮/退款快照或 PC/UniApp 选品流程；通用购物车还可能把单个 `type=5` 商品当成完整套餐，不能视为已迁移。现已建立服务端统一解析器：固定/任选规则、活动状态/时间/限额、关联行、商品、套餐 SKU 与基础 SKU 全部按数据库权威复核，拒绝重复关联/商品、过期配置、陈旧 SKU、库存不足和客户端价格，并把一次选择限制为 2～100 项。通用单品添加明确拒绝 `type=5`，兼容路由仍接受 PHP 的 camel/snake 字段，但只创建完整选择的一组一次性直购购物车行。

建单事务先锁套餐，再锁关联行、商品与两类 SKU，重新计算规则和精确分价；有限套餐以条件更新原子扣 1 次，基础商品/SKU 按每个关联项各扣 1，套餐 SKU 不扣库存。订单保存 `activity_id`、逐行套餐关联 ID、活动 SKU 价、免邮和退款能力；任何快照/库存/订单写入失败都回滚套餐限额、购物车认领和基础库存。取消恢复基础库存和一次套餐限额；售后申请按快照拒绝不可退款项，部分退款继续占用套餐限额，只有发货前全额退款恢复一次。PC 与 UniApp 商品详情均已接入固定/必选规则、逐项 SKU 选择和多购物车结算，结算入口限制最多 100 个购物车 ID。

正式 Hyperdrive 隔离验证先只读确认生产 PostgreSQL 16.14 中套餐、关联行、`type=5` SKU/购物车/订单均为 0。随机 schema 随后直接调用真实服务：固定套餐 `7.25 + 8.50 = 15.75`、免邮、活动/关联快照和取消补偿全部正确；任选套餐缺必选项及少于两项均拒绝；`limit_num=1` 的两用户双连接竞争严格 1 成功/1 业务拒绝、赢家认领 2 行且败方 2 行保持可用；强制快照写失败后订单 0、认领 0、限额 1、库存扣减 0；部分退款保持限额 0，剩余全退后限额只恢复到 1、两类基础库存归位；不可退款套餐没有产生退款单。结束时随机 schema 已确认删除，`public` 业务行和六条相关序列前后完全一致，临时 Worker 删除后 URL 为 404。

### PHP 管理端契约与迁移前缺口

PHP `route/admin.php` 提供五条权威运营路由：`POST discounts/save`、`GET discounts/list`、`GET discounts/info/:id`、`GET discounts/set_status/:id/:status` 和 `DELETE discounts/del/:id`。控制器接收标题、主图、固定/任选类型、限量、标签、日期、排序、包邮、状态、商品规格和配送/表单字段；Service 在事务中保存主表、关联商品以及 `type=5` 的属性、属性结果和 SKU，启用时复核结束时间、主商品/规格和库存，删除只把 `is_del` 置 1。PHP 编辑逻辑会先删掉全部关联再重建，并由 GET 列表在发现无效/过期套餐时写回 `status=0`；前者会让关联 ID 和活动 SKU 标识不稳定，后者使只读列表产生隐式写入，因此这两点只作为源行为记录，没有原样复制。

本批开始前，Worker 已有用户端套餐购买服务，却没有上述五条 Admin 路由、写入事务、商品/标签选择接口、`activity.view/activity.manage` 权限边界或后台页面。生产套餐表又全部为空，所以不能以“用户购买代码存在”推断运营闭环完成。

### 当前 Admin 实现

| 能力 | 当前实现与兼容边界 |
|---|---|
| 路由 | 恢复 PHP 五条路由；同时提供 `GET /discounts/products`、`GET /discounts/labels` 两个有界选择接口，并为新客户端增加 `PUT /discounts/set_status/:id/:status`。旧 GET 状态变更仍兼容，但权限解析器明确把它判为 `activity.manage`，不会让只读角色借 GET 越权写入。 |
| 请求边界 | JSON 正文上限 512 KiB；标题、图片、金额、日期、标签、商品和 SKU 均做类型/长度/数量校验。固定/任选都至少 2 个商品，最多 100 个商品、每商品最多 200 个 SKU；任选至少一个主商品，重复商品/SKU、无效标签、下架/无库存商品和陈旧基础 SKU 均拒绝。金额允许 0，但只接受最多两位小数的非负十进制。 |
| 时间和状态 | 日期按旧系统运营时区 `+08:00` 解释；过期套餐不能保存为启用或再次启用。未来定时套餐允许预先启用，列表在开始前返回 `effective_status=0` 和原因，不改写数据库。限量为 0、主商品无效、可选商品不足 2 个时启用被拒绝。 |
| 事务和并发 | 保存以全局 advisory transaction lock 串行化，再按稳定顺序锁商品和基础 SKU；主表、关系、`type=5` 属性/结果/SKU 在一个事务提交。任一步失败全部回滚。编辑按基础商品保留既有关系 ID，并按 `suk` 保留活动 SKU `unique` 与销量；移除商品时才精确删除对应关系和三类 `type=5` 行，避免 PHP 全删重建破坏购物车/快照引用。 |
| 源兼容字段 | 固定套餐 `product_ids` 保存全部商品；任选套餐只保存首个主商品，符合 PHP 的旧读取约定。`link_ids`、`delivery_type`、`freight`、`custom_form`、包邮和退款开关均往返；删除继续仅软删主表并保留关联证据。列表同时返回 `available`、`invalid_reason`、`effective_status` 和服务端最小套餐价。 |
| 后台页面 | 营销活动页新增“优惠套餐”标签，支持类型/状态/名称筛选、新建、编辑、启停和删除；表单覆盖主图、限量、日期、标签、包邮、退款、配送和每个基础 SKU 的套餐价，任选套餐可指定主商品。桌面使用表格，390px 宽度切换为卡片，避免横向裁切。 |

PHP 控制器还暴露了 `postage` 与 `system_form_id` 参数，但当前 PostgreSQL `store_discounts` 模型没有这两列，用户端 `type=5` 下单也只消费套餐包邮及基础商品的配送/表单权威；本批没有凭空增加源表未确认的列或让 Admin 表单制造无运行时消费者的数据。这两个字段应在取得真实源 MySQL 表结构和样本后重新对账，属于明确剩余差异，不影响当前已验证的套餐选品、价格、限量、退款和基础配送链。

### 本地和生产验证证据

Worker 单元测试新增 5 项，覆盖 snake/camel 归一化、固定套餐零价、重复/无主商品/非法日期拒绝、ACL 以及路由/事务结构；完整单元套件为 92 个文件、511 项全通过，unit/runtime 两套 TypeScript 配置均通过。Admin 生产构建通过。浏览器在 `/activity?preview=1` 完成桌面和 390×844 验收：列表、无效原因、编辑弹窗、两商品选择、SKU 勾选/价格启用、移动卡片和操作按钮均正确，无框架错误、控制台 warning/error 或横向溢出。Windows `workerd` 原生 `0xc0000005` 阻塞仍存在，所以这不是本机 Workers runtime 套件通过的证据。

临时审计 Worker 通过指定生产 Hyperdrive 连接 PostgreSQL 16.14，只读确认 `public` 的套餐、启用/删除套餐、关联商品、`type=5` 属性/结果/SKU和两类孤儿记录均为 0。随后在随机 schema 中直接调用真实 Admin Service：商品/基础 SKU/标签选择为 `3/4/2`；固定套餐保存为 2 个关系、2 个属性、2 个结果、3 个活动 SKU，`product_ids=1,2`、`link_ids=1`、最小价 `14.50` 且列表可用；编辑为任选套餐后，保留商品关系 ID 和同 `suk` 的活动 `unique`，精确清理移除商品，得到 2 个关系/2 个活动 SKU、`product_ids=1`、`link_ids=1,2`，退款关闭和自定义表单均往返。强制属性结果写入失败时整包状态指纹不变；未来定时套餐可启用但开始前有效状态为 0；主商品库存归零时启用被业务异常拒绝，恢复库存后成功；软删后详情/列表隐藏、主表 `is_del=1` 且关联证据保留。

最终报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`。一次早期播种因 Hyperdrive 未可靠保留连接启动参数中的 `search_path` 而在首条重复主键上立即失败，没有写入；场景随后改为每个步骤在事务内显式 `SET LOCAL search_path`。另一次 HTTP 传输 EOF 没有被误判为通过，重试后才取得完整 JSON 断言。所有临时 Worker 和一次性密钥均已删除；主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布。

当前判定提升为“套餐用户购买主链 + Admin 运营闭环代码面完成，并分别通过生产 PostgreSQL 隔离集成验证”，仍不是业务或迁移项目完成。生产没有真实套餐数据，源 MySQL 复制、`postage/system_form_id` 源结构核对、真实运营账号权限验收、真实客户地址/支付/通知、Linux/可用 workerd runtime 套件以及主 Worker/Admin/PC/UniApp 发布仍未完成。

## 对外 Out API 迁移详细审计（2026-08-14）

### PHP 权威接口与审计前状态

PHP `route/out.php` 的对外域不止分类和商品。除 token、刷新、分类/商品读写外，还包含订单列表/详情、快递公司、拆单商品，退款列表/详情及处理，优惠券列表/创建/启停/删除，会员等级列表，用户列表/详情/创建/更新/赠送，以及发货、核销、备注、退款和任意外部推送。审计前 Worker 只注册分类列表/详情和商品列表/详情 4 条 GET；`out_interface` 目录即使导入其他 URL，也只会显示文档，不会自动成为可调用路由。因此此前“Out API 已迁移”只能成立于 token/ACL、账户管理和四条商品目录读取，订单、退款、优惠券、等级与用户读取仍是明确缺口。

PHP 用户列表直接选取 `u.*`，会同时返回 `pwd`、`card_id`、登录 IP、条码、随机码等字段；用户详情控制器还存在参数形状与 Service 签名不一致的问题。该行为只作为兼容风险记录，没有原样复制。订单/退款接口则包含收货人、电话、地址、退款电话、原因和发票资料，属于被授权第三方所需但不可公开缓存的 PII。所有外部写操作又缺少 Worker 侧可证明的幂等键、不可变审计和副作用 outbox，不能仅因 PHP 有路由就恢复。

### 当前读写实现与安全边界

本批新增 10 条 GET：`order/list`、`order/:order_id`、`order/express_list`、`order/split_cart_info/:order_id`、`refund/list`、`refund/:order_id`、`coupon/list`、`user_level/list`、`user/list`、`user/info/:uid`。连同原 4 条，运行时共有 14 条明确注册的只读路由。每一条仍先验证独立 Out token，再把账户 `rules` 与启用、未删除的 `out_interface` 行按 HTTP 方法和规范化模板精确匹配；模板同时兼容 PHP `<id>`、Hono `:id` 和 Worker `{id}` 写法。目录的 `runtime_status` 只有这 14 条会显示 `available_read`，其他记录保持 `not_migrated`。

列表页大小统一封顶 100，搜索词、ID 数量和 JSON 快照均有大小上限；查询使用 Drizzle 参数化条件，不接受任意排序或 SQL 片段。订单默认只读平台、未系统删除且未软删数据，支持支付、状态、类型、Supplier、支付方式、关键词和 `+08:00` 日期范围；详情显式投影旧合同字段、发票和商品快照。商品快照解析同时兼容新 Worker `{product,sku}` 与 PHP `{productInfo,attrInfo}`。退款从退款单的 cart ID 选择中重建精确商品投影；优惠券和会员等级保持分页及旧字段命名。

用户列表/详情改为显式白名单，只返回账号、姓名/昵称、头像、电话、余额/佣金/积分、等级、推广和事业部等业务字段；不会返回密码摘要、身份证号、注册/登录 IP、`uniqid`、条码、随机码或软删除元数据。订单、拆单商品、退款和用户响应全部设置 `Cache-Control: private, no-store`、`Pragma: no-cache` 与 `nosniff`。这并不把 PII 变成普通公开数据：只有被真实 `out_interface` 权限逐项授权的账户才能读取，生产启用前仍须最小化分配订单/退款/用户权限并由业务方确认字段范围。

后续加固先恢复 `PUT /order/remark/{order_id}`、`PUT /refund/remark/{order_id}` 和 `PUT /order/receive/{order_id}`。两类备注以平台作用域行锁、相同内容重放和同事务不可变状态证据保证幂等，证据不含备注正文；确认收货则直接复用完整订单收货结算状态机，以订单 transaction advisory lock 串行，原子限制付款、拆分/分配、履约方式和退款状态，并结转供应商流水、积分/经验/佣金及累计退款冲正。外部账户只出现在脱敏状态消息中，重复或并发请求不会重复结算。

本轮继续恢复 PHP `PUT /order/delivery/:order_id` 与 `PUT /order/split_delivery/:order_id`。PHP 控制器虽然接收过 `type`、`fictitious_content` 等字段，但在进入 Service 前固定覆盖为人工快递 `type=1`；Worker 因此只采纳并校验 `delivery_name/delivery_code/delivery_id`，强制 `delivery_type=express`、清空虚拟内容和配送员，客户端伪造 `send` 或虚拟发货不会改变合同。普通发货和拆单都复用 Supplier 已验证的履约状态机，而不是在 Out 域复制 SQL：平台入口先以公开订单号固定 `store_id=0`，保留订单真实 `supplier_id`，事务内再次把平台范围加入根单、子单和最终条件更新；未支付、已删除、非待发货、自提、未成团、进行中售后以及多个待发货子单全部拒绝。拆单按稳定顺序锁商品快照，首次生成已发货/待发货子单、后续继续唯一待发货子单，最后一批整体发出，并保持数量及所有订单金额字段守恒。

两条发货路由与退款/收货共用逻辑主订单 transaction advisory lock。幂等摘要只由账户 ID、规范化路由、公开订单号、规范化快递字段和排序后的拆单商品构成；同事务写入 `store_order_status` 的不可变重放证据只保存 SHA-256 与结果订单 ID，不保存运单号、快递公司或请求体。完全相同的并发请求严格为一次业务写入和一次重放；已完成订单上的不同载荷按业务冲突拒绝，状态变更或重放证据写入任一步失败则全事务回滚。

随后恢复 `PUT /order/distribution/{order_id}`。PHP 权威实现只根据订单现有 `delivery_type` 修改 `delivery_name/delivery_code/delivery_id`，不承担首次发货或 `delivery_uid` 重分配；旧 Service 没有事务、付款/状态/平台范围检查，并把送货姓名和电话拼入状态日志。Worker 将它收紧为已付款、已发货、未删除的 `store_id=0` 订单元数据更正：按拆单逻辑主订单取得与发货/收货/退款共用的结算锁后再锁目标订单；快递订单可更正公司、编码和单号，虚拟订单只保持旧三字段兼容。`send` 订单不能把姓名/电话改为任意值，只接受 `delivery_uid` 对应的唯一、有效平台配送员权威姓名和电话，且不修改配送员 ID 或核销码。每个规范化请求写入不含物流原文的摘要证据；旧请求在更正为新值后延迟重放只返回原幂等结果，不会把新值回滚，状态日志故障则连同元数据更新全事务回滚。

本轮再恢复 `PUT /order/invoice/{order_id}` 与 `PUT /order/invoice_status/{order_id}`。PHP 权威接口只允许修改已有订单开票申请：资料接口要求大陆手机号、个人/企业抬头正则、企业税号和可选银行卡号；状态接口在 `is_invoice=1` 时要求 8～20 位数字发票号，并在每次写入时更新时间。Worker 保留个人/企业资料和 `-1/0/1` 处理状态能力，但将目标固定为未删除的 `store_id=0` 平台订单，按逻辑主订单共享结算锁后锁订单和唯一有效发票行；缺申请、同单多条有效申请、发票用户/类别错关联均拒绝，不猜测要修改哪一行。资料、状态和 `invoice_time` 在一个短事务提交，完全相同请求和双连接并发只产生一次业务变更；后续新值生效后，旧请求延迟重放只返回原结果，不反向覆盖。`store_order_status` 只保存账户 ID、SHA-256 摘要、订单/发票 ID 与状态，不保存抬头、手机号、邮箱、地址、税号、银行卡号、发票号或备注；状态证据写入失败时资料/状态和普通审计日志一并回滚。

随后将售后决策拆成无资金与有资金两层，只恢复 `PUT /refund/agree/{order_id}`（同意退货、等待用户寄回）和 `PUT /refund/refuse/{order_id}`（拒绝售后）。PHP 的 agree 控制器把路径值强制转成退款表主键且不验证状态，refuse 会把原因拼入状态日志；Worker 统一使用外部退款单号定位平台订单，并要求退款单与订单均为 `store_id=0`、未取消/删除、系统可见且 Supplier 关联一致。事务按“退款 advisory lock → 逻辑主订单结算锁 → 退款/订单行锁”固定顺序；同意退货只接受退货类申请和待处理状态，拒绝允许从待处理、同意退货或已寄回状态决策，但已拒绝时不能用不同原因覆盖。任何 `store_order_refund_payment` 已进入 `REQUESTING/PROCESSING/UNKNOWN/SUCCESS/ABNORMAL` 的退款都不能再改变决策。原因只保存在权威退款行，普通状态日志和摘要重放证据不含原文；完全重放、并发和延迟旧请求均不重复或反向覆盖。同意/拒绝与订单镜像状态、普通日志、摘要证据同事务提交，任一步失败全部回滚。

资金与履约批次完成时 Out 域为 14 条 GET + 11 条 PUT。`PUT /refund/{order_id}` 已恢复 `type=1` 真实退款与 `type=2` 拒绝分支，但没有照搬 PHP 的同一售后单累计部分退款漏洞：PHP 首次调用无论退款金额是否只占一部分，都会先执行整单拆分/库存/奖励等完成副作用并把售后单写成 `refund_type=6`，下一次又被入口状态校验拒绝。Worker 因而要求客户端金额精确等于该售后记录的权威 `refund_price`；真正的部分退款继续由多张独立售后记录表达，并由统一核心校验订单累计退款不得超过实付。平台入口把外部退款单号、内部订单/退款主键、`store_id=0`、UID、Supplier 和整数分金额绑定为调用范围；生产 Hyperdrive 当前 `caching.disabled=false`，因此退款核心连“已完成重放”也不信任事务外 SELECT，而是在退款锁和订单锁内取得新鲜快照。余额/零元退款在短事务内重复核验并一次提交，微信/支付宝只在短事务写入稳定 `CNSR{refundId}` 渠道意图后于事务外调用，且意图写入前再次把请求单号、渠道、原交易号和金额与锁内新鲜订单核对，重试先复用/查询同一渠道单号。完成态只有在 `refund_price=refunded_price=请求金额` 时才作为幂等重放，否则要求人工对账。商品、优惠券、用户的其他 POST/PUT/DELETE、赠送和任意外部 URL 推送仍保持 501。PHP `event('order.delivery')` 与拒绝退款事件现已进入订单 outbox，并可原子暂存站内信、短信、公众号/小程序和微信发货上报投递；但生产模板、渠道配置和凭据为空，主 Worker 也未发布，因此不能视为真实外部渠道已上线。

### 分类写入续审（2026-08-28）

本轮补齐 PHP 的四条分类写合同：`POST /category`、`PUT /category/:id`、`DELETE /category/:id` 和 `PUT /category/set_show/:id/:is_show`。四条路由仍由既有 Out token、IP/账户双层限流和 `out_interface` 方法+模板精确 ACL 保护；非 GET 调用继续写只包含静态模板、账户、结果、耗时及资源/IP/User-Agent HMAC-SHA256 的 `out_api_audit`，不保存动态 ID、图片地址、类目名称、查询值或请求体。导入接口目录不会自动把路由变成可执行能力。

写入固定为平台作用域 `type=0/relation_id=0`。名称要求非空、NFC 规范化且最多 30 字，父级/排序/状态拒绝 JavaScript 隐式类型转换；图片只接受 HTTPS 或站内绝对路径并受 PostgreSQL 列宽限制。类目目录使用 PostgreSQL advisory lock 加 `SHARE ROW EXCLUSIVE` 表锁串行化，也覆盖不认识 Worker 锁命名空间的旧 Admin 写入。同父级名称按大小写不敏感判重；完全相同的创建返回既有 ID，更新与显隐对已达目标状态返回幂等结果。编辑通过实际 `pid` 图而不是信任旧 `path` 判断后代，拒绝自身/后代循环和移动后超过三级，并在同一事务重算所有后代 `path/level`、修复 `store_product_relation.relation_pid`。显隐保持 PHP 的“目标类目及直接子类”合同。

删除先以同一固定锁顺序冻结类目、商品及四张引用表；有直接子类时拒绝。商品门禁同时检查所有作用域活动商品的 `store_product_relation(type=1)`、旧 `store_product.cate_id` CSV、历史 `store_product_cate` 和 `store_product_category_brand`，避免生产当前新关系表为空时误删仍被 71 个商品引用的类目，也避免畸形历史跨租户引用被静默破坏。仅被已回收商品引用不会阻止清理；不存在的全局 ID 作为 DELETE 重放收敛，但同 ID 若属于 Supplier 作用域则返回不存在，不能跨租户删除。

一次性 `cinashop-out-category-audit` 只绑定用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产只读状态为 PostgreSQL 16.14、平台类目 24、活动平台商品 71、新分类关系 0、历史类目关系 0、类目品牌关系 0。随机 `codex_out_category_*` schema 克隆 Out 接口目录、类目、商品及三张关系表并替换全部私有序列；public 六表及序列先后做全行摘要。四条分类权限逐条放行且未授权商品写入拒绝。最终场景中首次/重放创建、双连接并发单行创建、同名不同载荷拒绝、自身/后代移动拒绝、第四级拒绝、后代路径和关系父级联动、关系写失败全事务回滚、显隐直接子级联动、子类删除门禁、四种引用门禁、跨租户活动商品引用门禁、安全删除重放、已回收商品引用忽略和 Supplier 类目作用域保护全部为 true；并发两个返回严格是一项业务变更、一项幂等重放，共同 ID `2`，两种测试名称合计严格 2 行。

第一次生产验证只因审计脚本在事务外复查而受 Hyperdrive 会话缓存影响读到 `public` 的 0 行，业务并发返回本身已是 `[false,true]` 且同 ID；所有复查改为显式短事务 `SET LOCAL search_path` 后不再依赖连接级状态。随后一次边缘调用返回 Cloudflare 1042，同样没有计作通过；按官方同 zone Worker 边界仅为一次性审计 Worker 加 `global_fetch_strictly_public` 后才重跑取得完整 JSON。最终 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`，生产前后计数仍为 24/71/0/0/0；临时 Worker 已由 Wrangler 删除。主 `cinashop-api` 未发布本批。该分类批次当时的静态审计为 Out 31/41、剩余商品 4、优惠券 3、用户 3；全仓 PHP 1,912、TS 1,215、精确匹配 524、可执行匹配 509、证据化退役 2、可执行缺口 1,386，后续商品续审已更新当前数字。

### 商品写入续审（2026-08-28）

PHP 权威路由是 `POST /outapi/product`、`PUT /outapi/product/:id`、`PUT /outapi/product/set_show/:id/:is_show` 与 `PUT /outapi/product/stock/upload`。旧控制器把 `supplier_id` 原样传给共用商品 Service，使平台 Out 账户可以触达供应商商品作用域；编辑商品会重新保存 SKU 库存，可能覆盖与订单并发变化后的权威库存；库存同步按全库 `bar_code` 查找、缺失时静默跳过且没有重复条码歧义门禁，也没有请求级幂等。PHP 同一保存入口还同时接受卡密、优惠券、虚拟商品、次卡、活动、品牌、预售、会员、自定义表单、标签、保障、参数和自动上下架等尚未迁移的履约能力，不能通过忽略字段伪装成兼容。

新实现把四条写路由固定为平台 `type=0/relation_id=0`，并在对应 Out 接口 ID、账户/IP 双层限流及既有 HMAC 脱敏审计之后执行。当前仅允许实物商品；`supplier_id!=0` 和上述未迁移能力全部失败关闭。请求体分别封顶 1 MiB 与 64 KiB，文本、整数、金额、列宽、轮播 JSON、分类 CSV、站内绝对路径与 HTTPS 资产地址均在写库前验证。商品详情同步收紧为平台作用域，不能用 Out 读取 Supplier 商品。非实物商品必须等待卡密、优惠券、虚拟交付和次卡履约闭环完成后单独开放。

新增 `out_product_write_replay` 事务回放账本。四类写入都强制 UUID-v4 `Idempotency-Key`，以账户、操作和 key 唯一；账本只保存 canonical 请求 SHA-256、商品 ID、更新计数和时间，不保存商品名、条码、库存、请求体或响应体。同 key/同载荷返回原结果，同 key/不同载荷拒绝。商品创建/修改和库存条码解析共用 advisory lock；修改按 SKU→商品的固定顺序锁行，与订单库存链保持同序。创建生成不透明 SPU/SKU 标识；修改不允许增删 SKU、伪造唯一标识或改库存，只更新非库存属性。上下架同步商品、购物车和关系状态，上架清零自动下架时间。库存上传是最多 100 项的绝对库存合同，只匹配活动平台实物商品；缺失条码、同批重复条码、库内重复条码和任一项失败都会整批回滚，实际变化才写库存流水并重算商品聚合库存/售罄状态。

仓库外部 `0097_out_product_write_replay.sql` 与 Worker 内嵌 `migration_0104` 字节等价，结构审计现为源 MySQL 201/201 表与全部源列覆盖、目标 218 表、17 张 Worker 专用表、外部/内嵌表集合及列/主键漂移 0。生产 Hyperdrive 上在短事务固定 `search_path=public`、3 秒锁超时、30 秒语句超时和 advisory lock 后执行真实 DDL两次，结果均成功；验证为 8 列、4 个约束、3 个索引、0 行，10 张业务表及 9 个原有序列前后摘要不变。生产最终目录为 PostgreSQL 16.14、218 表、3,029 列、699 索引、205 主键。

严格随机 schema 场景逐条验证 4/4 ACL 放行、未授权优惠券写入拒绝、同 key 双连接并发只创建一件商品、创建重放与冲突 key、跨 Supplier 和非实物拒绝、修改保持库存/SKU 身份、规格拓扑拒绝、修改回放、数据库约束故障全事务回滚、上下架联动及重放、绝对库存与流水、同库存新 key 收敛、Supplier 同条码忽略、平台重复条码拒绝、缺失条码整批回滚、Supplier 商品详情保护和回放账本无业务内容。最终 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；DDL 应用前后及增加并发锁后的最终场景均通过。生产最终商品 71（全部平台实物）、平台 SKU 2、非空平台条码 0、购物车 27、回放账本 0，审计商品/SKU/购物车标记、故障探针和临时 schema 均为 0。

本次生产审计也保留一次隔离事故而不把它隐藏成成功。最初场景有三处事务外直接插入依赖连接级 `search_path`，Hyperdrive 把一件固定 ID 203 商品、一条固定 ID 301 SKU和两条购物车 ID 28/29 写入 `public`；故障探针也曾短暂建到公共表。发现后立即停止场景并删除临时 Worker。商品/SKU清理要求固定 ID、名称、图片、价格、库存、唯一值、条码和全部引用计数精确匹配；购物车清理要求两行所有 16 个字段、全表 29 行、最大 ID 29、序列 29 同时匹配，在排他表锁内只删除 28/29，最后把序列恢复为 27。独立读回确认商品 71、平台 SKU 2、购物车 27、最大 ID/序列 27、所有审计标记和临时 schema 为 0。随后场景把服务调用、直接查询、播种和 DDL全部改为外层显式事务 `SET LOCAL search_path=<随机schema>`；事故清理端点已从最终审计 Worker源码删除。

最终本地门禁为 112 个测试文件/651 项全部通过、双 TypeScript 配置通过、主 Worker Wrangler 4.122.0 minify dry-run 2,246.05 KiB/gzip 553.56 KiB、`git diff --check` 无错误。静态路由审计变为 PHP 1,912、TS 1,219、精确 528、可执行 513、明确 501 为 15、退役 2、可执行缺口 1,382；Out 为 35/41（85.4%），只剩优惠券 3 条和用户 3 条。Windows runtime 仍在进入任何断言前由 `workerd` 以 `0xc0000005` 崩溃，明确记为环境失败；主 `cinashop-api` 仍未部署本批代码，因此生产数据库前置已就绪不等于四条路由已经线上可调用。

### 优惠券写入续审（2026-08-28）

PHP 权威合同是 `POST /outapi/coupon`、`PUT /outapi/coupon/status/:id/:status` 和 `DELETE /outapi/coupon/:id`。逐字段审计确认迁移存在两组交换语义：PHP `type` 是适用范围、`coupon_type` 是满减/折扣模式，而 PostgreSQL 目标列分别为 `coupon_type` 和 `type`；PHP `coupon_time/start_use_time/end_use_time` 则映射为 `day/use_start_time/use_end_time`。旧 Out 列表因此把 `coupon_type` 过滤到了范围列、把 query `type=send` 错当数字优惠类型，响应又把交换后的目标列名直接暴露给客户端。现已恢复 PHP 查询与输出合同：`coupon_type` 过滤目标 `type`，`type=send` 同时校验赠送券、状态、库存、领取窗口和使用有效期，响应重建 PHP 的 `type/coupon_type/product_id/category_id/brand_id/start_use_time/end_use_time/coupon_time` 并移除目标迁移辅助列。

金额审计还发现跨服务的高风险倍率错误。PHP 折扣券用 `85` 表示支付 85%（8.5 折），计算式是 `price * coupon_price / 100`；旧 TypeScript `calculateCouponDiscountCents` 却把 `8.5` 当成 85%，使 Out/Admin 创建值和下单核销语义相差 10 倍。计算现统一为 0–100 百分比、整数分和 BigInt 中间值：`85.00` 对 10.01 元产生 1.50 元优惠，`100.00` 为 0 优惠，超过 100 失败关闭。新增接口只接受 PHP 实际字段，名称/金额/整数/列宽/领取与使用窗口先归一化；限量券总量必须大于 0，领取方式 2/3 强制不限量，固定有效期必须有完整使用起止时间，滚动天数不能与固定时间混用。Out 当前没有 `brand_id` 输入合同，因此创建仅开放通用、平台分类、平台实物商品三种范围；未迁移字段和跨 Supplier/已删除/非实物商品都拒绝，不能静默丢弃。

新增 `out_coupon_write_replay` 内容脱敏事务账本。三类写请求均强制 UUID-v4 `Idempotency-Key`，唯一键为账户+操作+key，只保存 canonical SHA-256、优惠券 ID、结果状态和时间，不保存标题、金额、折扣、范围、日期或请求/响应体。同 key/同语义返回原结果，同 key/不同语义拒绝；优惠券目录 advisory lock 与模板行锁使双连接创建和状态切换收敛。启用会重新验证标题、优惠模式、领取方式、发行余量、未过期窗口和实际平台分类/商品/品牌关系。停用只阻止未来发放；已经领取的用户券仍按快照使用。删除固定为 `is_del=1/status=-1`，保留 `store_coupon_issue` 和 `store_coupon_product`，因为下单仍需模板和适用商品关系校验已领商品券；同时统计已领、已用、占用和领取证据，并在仍有活动商品赠券、有效抽奖、有效促销或启用新人礼包配置时拒绝删除。PHP 原删除误删的是支付后赠券 `store_product_coupon`、却遗留真正适用范围 `store_coupon_product`，该错误没有复制。

外部 `0098_out_coupon_write_replay.sql` 与 Worker 内嵌 `migration_0105` 字节等价。生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 在固定 `search_path=public`、锁/语句超时和 advisory lock 下直接应用同一 DDL 两次，验证 8 列、4 约束、3 索引、0 行且业务表指纹不变；目录更新为 PostgreSQL 16.14、219 表、3,037 列、702 索引、206 主键。生产实际只有 1 张未删除但未启用的满减品类券，用户券 4 张（未用2、已用2、占用0），领取证据0、适用商品关系0、商品支付后赠券0、优惠券抽奖0、促销优惠券关系0、新人礼包优惠券配置未启用。该分布足以证明历史数据很小且关系不完整，不代表真实 Out 客户验收；生产仍没有有效 Out 账户或接口权限目录。

最终随机 `codex_out_coupon_*` schema 场景的 ACL 3/3、同 key 双连接单行创建、创建重放/冲突、跨租户和严格字段拒绝、PHP 列交换、状态并发/重放、过期启用拒绝、`send` 列表、商品赠券/抽奖/促销/新人礼包四类删除冲突、已领券范围保留、删除重放、数据库故障全回滚及账本无业务内容全部为 true；`schema_created/schema_removed/public_state_unchanged=true`、临时 schema 0。隔离验证也保留一次审计事故：服务事务已固定 search path，但准备冲突的事务外夹具仍被 Hyperdrive 写入 `public`，新增用户券 ID 5、配置 ID 504–506、抽奖/奖品 500/501 和促销 600。发现后停止场景，专用最小修复 Worker 在单事务、表锁和唯一全字段证明下精确删除 1 张用户券、1 条领取证据、抽奖/奖品各1、促销1、配置3；只有序列仍精确为5/506且剩余最大 ID 为4/503时才恢复序列。独立读回确认所有事故标记为0，用户券4、领取证据0、配置最大ID/序列503，生产前后最终业务状态一致。最终场景加入静态门禁，`runScenario` 禁止任何事务外 `container.db`；事故清理端点和 Worker 已从源码/Cloudflare 删除。

本批静态审计更新为 PHP 1,912、TS 1,222、精确匹配531、可执行匹配516、明确501为15、退役2、可执行缺口1,379；Out 为38/41（92.7%），只剩用户新增、修改和资金/积分赠送3条。结构审计为源201/201表和全部源列覆盖、目标219表、18张Worker专用表、外部/内嵌表集合与列/主键漂移0。113个单元测试文件/657项和双TypeScript配置已通过；Wrangler 4.122.0 主 Worker minify dry-run 为2,265.38 KiB/gzip 558.16 KiB。Windows runtime再次在进入断言前由`workerd`以`0xc0000005`退出，不能记为通过。主`cinashop-api`未部署本批代码，因此生产账本前置完成不等于三条优惠券路由已在线开放。

### 用户写入续审（2026-08-28）

PHP 权威合同是 `POST /outapi/user`、`PUT /outapi/user/:uid` 和 `PUT /outapi/user/give/:uid`。发布的 Out 接口目录把新增手机号标为必填；赠送合同的 `money_status/money/integration_status/integration` 四项也全部标为必填，示例中的 `days/coupon` 并不在控制器实际读取字段中。源码审计发现旧新增虽然文档要求手机号，控制器却允许空手机号；`true_pwd` 完全不校验；更新缺省值会把未提交的姓名、证件、生日、备注、状态、等级、手机号、地址、分组、性别和地区批量清空。更新还允许请求伪造 `adminId` 写入资金流水关联值，只检查一级父子关系而不能阻止更深推广环，更新密码也没有新增时的长度/弱口令门禁。

更严重的是旧 `UserServices::updateInfo` 没有显式事务：余额流水、积分流水、等级/标签/微信性别、推广关系和用户主表可能部分提交。余额超额扣减会收敛到 0，积分超额扣减却直接变负；同时修改余额和积分时，外部推送变量被后者覆盖，只通知最后一项。新实现保留 PHP 兼容字段和手机号/MD5 登录边界，但采用严格 allowlist、列宽/枚举/日期/JSON/身份证校验；新增必须有中国大陆格式手机号，活动用户手机号由数据库 partial unique index 兜底。密码为空时生成不可登录的随机口令摘要，不再落空 MD5；显式密码要求 6～128 位、拒绝 `123456`，并在提供确认密码时要求完全一致。更新改成安全 partial semantics，只修改请求实际出现的字段；未迁移字段（包括可伪造的 `adminId`）明确拒绝而不是静默丢弃。

新增用户在同一事务创建用户、平台标签、会员等级、新人资格/积分/整元余额/优惠券赠礼和社区作者资料。等级切换会停用原 `user_level`、复用或新建目标记录并同步 `user.level/exp/level_status`；标签只接受启用的平台 `type=0/relation_id=0` 行并精确替换；分组必须真实存在。推广换绑先取得全局关系锁，再检查最多 100 层完整祖先链，阻止自身、任意深度后代和已有历史环；解绑/换绑同时原子修正旧/新父级 `spread_count`、事业部/代理/员工快照、`user_spread` 历史和好友证据。手机号目录、标签和回放账本分别使用事务级 advisory lock，用户资金和资料使用行锁；事务通过 Hyperdrive/transaction pooling 使用未命名语句，没有在请求间保存全局可变状态。

三条写路由都要求 UUID-v4 `Idempotency-Key`。新增 `out_user_write_replay` 只保存 Out 账户、操作、请求键、canonical SHA-256、用户 ID、两类流水 ID 和时间，不保存姓名、手机号、证件、生日、资料、请求体或响应体；密码在进入 canonical 摘要前先用 `APP_KEY` 做 HMAC，避免回放摘要成为弱口令离线字典。账户+操作+key 唯一，同 key/同语义返回原结果，同 key/不同语义拒绝。余额以整数分计算，积分以安全整数计算；增加检查目标列上限，减少统一取 `min(请求值, 当前值)`，所以余额与积分都不会因本接口变负。实际非零变化分别写 PHP 兼容的 `user_money system_add/system_sub` 和 `user_bill category=integral/type=system_add|system_sub`，链接 ID 为去连字符 UUID；两个 partial unique index 独立阻止重复资金证据。资料、推广、主余额/积分、两类流水和回放账本都在同一个短事务，任何流水约束故障会全部回滚。

外部 `0099_out_user_write_replay.sql` 与 Worker 内嵌 `migration_0106` 字节等价。生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 的 DDL 前置只读为 PostgreSQL 16.14、用户 3/活动用户3/删除0、合法非空手机号3、重复手机号组0、畸形手机号0、负余额0、负积分0、系统余额/积分流水0、用户等级/标签/分组/社区资料0、有效 Out 账户/接口0、临时 schema 0。DDL 在固定 `search_path=public`、3 秒锁超时、30 秒语句超时和独立 advisory lock 下执行两次均成功；业务表全行及序列指纹不变。最终回放表为 9 列、4 约束、3 索引、0 行，活动手机号/余额证据/积分证据三个 guard index 均 `valid/ready`；生产目录更新为 220 表、3,046 列、708 索引、207 主键。

一次性 `cinashop-out-user-audit` 随后在同一生产实例创建随机 `codex_out_user_*` schema，克隆 Out 接口、用户、余额/积分流水、分组/标签、等级、推广/好友、社区和微信身份 13 张真实表，替换全部私有序列，并在隔离 schema 应用完全相同的 0106 DDL。场景逐条验证 3/3 ACL 放行和未授权路由拒绝、同 key 双连接只新增一名用户、创建重放/冲突、不同 key 重复手机号拒绝、用户/新人标记/社区/标签/等级原子创建、口令非空且不等于明文、部分更新不清空手机号和备注、手机号连同 phone-account 登录别名安全更新、标签/分组/等级/微信性别同步、重复手机号更新拒绝、任意深度推广环拒绝、解绑再换绑的计数/快照/历史/好友原子一致，以及余额和积分同 key 双连接各严格一条流水。

资金负向继续覆盖同 key 不同金额拒绝、`12.50/150` 超额扣减后余额与积分均精确归零且流水记录实际扣减量、活动手机号/两类证据重复组均为0。给 `user_money` 注入 `NOT VALID` 故障约束后，更新请求先修改姓名和余额、再在流水插入处失败；最终姓名、余额和回放行全部回滚，证明不再复现 PHP 部分提交。隔离观察为合成用户5、回放7、余额流水2、积分流水2、推广历史1；回放 JSON 不含合成手机号或名称。最终 `schema_created/schema_removed/public_state_unchanged=true`、前缀 schema 0，生产用户/流水/回放仍为3/0/0。临时 Worker版本 `3fc6e1e6-f679-4e56-a7ec-ea0a28101737` 已删除，URL 返回404，Wrangler API 返回不存在 `10007`。

本批静态审计更新为 PHP 1,912、TS 1,225、精确匹配534、可执行匹配519、明确501为15、退役2、可执行缺口1,376；Out 为41/41（100%）。结构审计为源201/201表和全部源列覆盖、目标220表、19张Worker专用表、外部/内嵌表集合与列/主键漂移0。114个单元测试文件/662项、双TypeScript配置和主 Worker minify dry-run 均通过；dry-run 为2,289.37 KiB/gzip 564.19 KiB。Windows runtime再次在进入断言前由`workerd`以`0xc0000005`退出且测试数为0，不能记为通过。主`cinashop-api`仍为100%版本`9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布，所以三条用户路由尚未在线开放。

41/41 是静态 HTTP 路由合同覆盖，不等于 Out 业务域已经真实投产。生产仍没有有效 Out 账户或逐路由权限目录，无法做真实 token、PII 最小权限和客户调用验收。PHP `out.outPush` 还会在提交后直接请求 `out_account.user_update_push` 任意 URL：没有可靠重试、没有签名/去重，能触达内网且余额+积分同时变化只保留最后一项。该行为没有原样复制；已在 checklist 新增 OUT-005，要求真实客户先确认事件协议、HTTPS 域名 allowlist 和签名，再以事务 outbox + Queue + UNKNOWN 对账实现。主 Worker发布、真实账户导入、限流/审计真实验收和安全回调完成前，不能把 Out API 宣称为生产完成。

### 生产 Hyperdrive 证据与剩余阻塞

临时审计 Worker 直接绑定生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。只读分布为 PostgreSQL 16.14、有效 Out 账户 0、Out 接口 0、GET 接口 0、订单 29、有效退款 3、优惠券 1、会员等级 3、有效用户 3、可用快递公司 2、审计前临时 schema 0。生产业务表已有读接口样本，但没有迁入任何真实 Out 账户或权限目录，因此无法也不会伪造生产 token、客户权限或真实调用验收；这再次证明源 MySQL 配置/数据复制尚未完成。

随后只在同一生产 PostgreSQL 的随机隔离 schema 中克隆 10 张实际表并写入合成数据，所有事务显式 `SET LOCAL search_path`。场景建立 10 个独立接口权限并逐路由调用真实 Service：允许路由 `10/10`，未授权商品路由被拒绝；订单列表只见 1 条有效订单、软删订单隐藏，详情得到 2 个商品且 Worker/PHP 两种快照价格均正确，收货合同字段、发票、日期过滤、拆单 2 行、快递 1 行和“待收货”状态均通过；退款列表/详情只返回退款指定的 1 个 cart；优惠券为 1 条且有效期“7天”，等级 1 条；用户列表只见有效用户，电话/余额合同保留，7 类凭据/内部标识哨兵全部未出现在序列化响应。

最终报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`。canonical Worker 首次因同 zone 访问门禁返回平台 `1042`，按 Cloudflare 明确兼容边界为一次性审计 Worker加入 `global_fetch_strictly_public` 后才执行数据库场景；一次播种因测试身份证哨兵超过真实 `varchar(20)` 被数据库拒绝并由 `finally` 清理，缩短为合法边界后完整通过，没有把失败算作成功。临时 Worker 删除后 URL 为 404；主 `cinashop-api` 部署仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布。

同一个临时审计 Worker 随后通过生产 Hyperdrive 在随机 `codex_out_fulfillment_*` schema 克隆 `delivery_service/out_account/out_interface/store_order/store_order_cart_info/store_order_refund/store_order_status/store_pink/user` 九表并使用私有序列。3/3 新写权限放行且缺权拒绝；普通发货的首次变更、完全重放、双连接并发单写、不同载荷拒绝、平台范围、非零 Supplier 订单、业务门禁、强制快递合同、证据脱敏和日志故障全回滚均通过。拆单的首次部分发货、重放同结果、完成后原请求重放、双连接单次拆分、金额/数量守恒、最后一批完成、退款门禁、证据脱敏和故障全回滚也全部通过。配送信息更正继续通过首次/完全重放、新值覆盖后旧请求延迟重放不反向覆盖、双连接单写、平台范围、未发货拒绝、配送员记录与用户账号双有效的权威值、伪造身份拒绝、4 条摘要证据脱敏和日志故障全回滚。场景结束为 schema 删除、前缀 0、公共九表及序列指纹不变；临时 Worker 经 Wrangler 确认为不存在，传播完成后 URL 404。

发票独立场景直接使用同一生产 Hyperdrive，在随机 `codex_out_invoice_*` schema 克隆 `out_account/out_interface/store_order/store_order_invoice/store_order_status` 五张真实表并改用私有序列。2/2 发票权限放行且缺权拒绝；资料修改的首次写入、完全重放、新值覆盖后旧请求延迟重放、双连接并发单写、平台门店隔离、缺申请、重复申请、错关联、3 条摘要证据脱敏和日志故障全回滚全部通过。状态修改覆盖待处理→已开票→拒绝、完全重放、拒绝后旧“已开票”请求延迟重放不改回、双连接并发单写、3 条摘要证据脱敏和故障全回滚。报告为 PostgreSQL 16.14、`schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`，公共五表及序列指纹前后一致，`out_api_audit` 仍为 0 行。把历史两套大场景和新场景合并的首次请求返回平台 `1042`，没有被计作通过；拆成独立端点后才取得完整 JSON 断言。临时 Worker 已删除，Wrangler API 返回“Worker does not exist”；该账户的已删除 workers.dev 名称返回通用 403，而不是把状态码误写成 404。主 Worker未发布。

售后决策场景继续在随机 `codex_out_refund_decision_*` schema 克隆 `out_account/out_interface/store_order/store_order_refund/store_order_refund_payment/store_order_status` 六张生产表。2/2 决策权限放行且真实资金退款路由缺权拒绝；同意退货的首次/完全重放、双连接单写、同意后拒绝再延迟重放旧同意不改回、平台门店/非退货类型/Supplier 错关联/渠道处理中/已取消门禁、2 条摘要证据和故障全回滚全部通过。拒绝的首次/完全重放、不同原因防覆盖、双连接单写、3 条摘要证据脱敏和故障全回滚也全部通过。报告同样为 PostgreSQL 16.14、schema 创建后删除、前缀 0、公共六表及序列指纹不变，审计表仍 0 行；临时 Worker 删除后 Cloudflare API 返回不存在。主 Worker未发布。

资金退款场景随后在随机 `codex_out_refund_money_*` schema 克隆 Out 目录、用户/账单、订单/退款/渠道状态、奖励/供应商/拼团/商品等 16 张生产表，并为所有可能写入的账本与状态表替换 schema 私有序列。`PUT /refund/{order_id}` 权限放行且缺权拒绝；同一余额退款双连接调用均完成，其中 1 次识别为幂等重放，余额 `5.00→15.00`、退款状态 `1→6`、`refunded_price=10.00`，资金账和退款状态各严格 1 行。缺金额、同售后单部分金额、`store_id!=0` 越界和 `refund_type=6` 但 `refunded_price!=refund_price` 的历史矛盾状态全部拒绝且资金不变。`type=2` 首次拒绝、完全重放和不同原因防覆盖通过。状态日志故障约束使余额、退款状态和账单全部回滚，移除后同请求重试只入账一次。报告为 PostgreSQL 16.14、`schema_created/schema_removed/public_state_unchanged=true`，执行前后 `codex_out_%` schema 均为 0，公共 16 表行数及 7 条公共序列完全一致，审计表仍 0 行；临时 Worker 删除后 Cloudflare API 返回 `10007`。主 Worker 未发布，也没有调用真实微信/支付宝商户退款。

本地双 TypeScript 配置通过，优惠券续审时的 113 个文件/657 项历史快照已由用户写迁移的 114 个文件/662 项全通过覆盖。Cloudflare 本地 runtime 套件再次在加载测试前由 Windows `workerd` 以 `0xc0000005` access violation 崩溃，因此不能写成 runtime 通过；生产 Hyperdrive 隔离场景提供了真实 Worker/PostgreSQL 执行证据，但不替代 Linux runtime/CI。当前结论是“Out 安全账户/token/逐路由 ACL + 14 条 GET + 25 条写路由 + 强一致限流与脱敏访问审计已完成代码面并通过生产引擎隔离验证”；源 Out 账户/接口目录复制、真实客户最小权限/PII 审核、真实 Durable Object RPC/429、微信/支付宝真实退款与回调/对账、通知模板/渠道配置复制及真实第三方验收、安全用户变更回调（OUT-005）、CI/runtime、发布和回滚演练仍未完成。

## 发货与拒绝退款通知迁移详细审计（2026-08-15）

### PHP 权威副作用与审计前缺口

PHP `app/listener/order/Delivery.php` 会按履约类型选择通知标记：快递为 `order_postage_success`，平台配送为 `order_deliver_success`，虚拟/收银台交付为 `order_fictitious_success`；`app/listener/order/RefuseRefund.php` 使用 `send_order_refund_no_status`。逐方法对照 `NoticeService` 后的精确渠道矩阵为：虚拟交付发送短信和站内信；快递发送短信、站内信、公众号模板和小程序订阅通知；平台配送发送短信、站内信和小程序订阅通知，PHP 中公众号调用本身已注释；拒绝退款发送站内信、短信、公众号模板和小程序订阅通知。公众号快递/拒绝模板键分别为 `42984`/`46232`，小程序快递/同城配送/拒绝退款模板键分别为 `1458`/`1128`/`1451`，短信模板取 `system_notification.sms_id`。

PHP `OrderShipping` 是独立于普通通知开关的第四类副作用：只有 `order_shipping_open` 启用、商品订单 `is_channel=1`、`pay_type='weixin'` 时才上报微信小程序发货信息；快递/同城/虚拟映射为物流类型 1/2/3，其他非发货类型为 4，拆单使用 delivery mode 2 并按剩余未发子单计算 `is_all_delivered`。交易号使用 `trade_no`，付款人使用 routine openid，快递手机号按 PHP 规则遮盖第 4～7 位，承运商列表查不到时回退 `ZTO`，商品描述为“商品名 * 数量”并以 ` | ` 拼接。审计前 Worker 的 Admin、Supplier、拆单、虚拟卡密和 Out API 已能改变履约/售后状态，但没有这些可靠外部副作用：状态提交后进程失败会永久漏发，若直接在请求事务内调用第三方又会拉长锁时间并产生不可控重试。

生产只读审计显示四个目标 `system_notification` 行均为 0，相关 `notification_template` 行为 0，`wechat_user` 为 0，`sms_record` 为 0；`order_shipping_open`、短信提供商配置、公众号/小程序 AppID/AppSecret 与微信商户号配置均缺失，只有 `site_url` 存在且有 5 条历史重复。主 Worker secrets 只有应用/调试/内部与运维令牌和 Upstash 两项，没有阿里云短信或微信支付外部凭据。生产 28 条非删除订单中 5 条已发货，但符合微信发货上报条件、带交易号和 routine 身份的订单均为 0。因此本批可以完成代码、DDL 和隔离合成验证，不能宣称真实渠道已经可用或真实历史通知已经补发。

### 当前 Worker 实现与一致性边界

新增 `order.delivery.notice` 和 `order.refund.refused.notice` 两类不可变事件，复用已有 `store_order_outbox`、`ORDER_QUEUE`、过期租约补投、失败退避、`DEAD` 与 Admin 重放能力。Admin 普通发货、Supplier 普通/拆单发货、支付 outbox 内的虚拟卡密自动交付、Out API 普通/拆单发货，以及 Admin/Supplier/Out API 拒绝退款都在改变订单或售后状态的同一 PostgreSQL 事务写入通知 outbox；事件键分别固定为订单 ID 或退款记录 ID。重复写入会比较 canonical JSON，而不受 PostgreSQL `jsonb` 键顺序影响；同键不同不可变快照会拒绝，而不是覆盖原事件。

Queue 消费端在一个短事务中锁定 outbox，验证消息 action、事件类型、聚合 ID 和 payload，再按 PHP mark 读取唯一模板、解析用户昵称和订单商品快照、渲染占位符并写 `system_message`。`system_message.event_key` 为 nullable，旧消息保持 `NULL`，新事件由唯一索引精确去重；模板缺失或 `is_system!=1` 时事件完成但不产生消息。消息与 outbox `COMPLETED` 同事务提交，注入消息约束故障时二者都回滚。Queue 是至少一次投递：完成/已完成/死亡事件 ack，活动处理租约返回 `busy` 时显式 retry；本轮生产竞态实际得到 4 个首次完成、`1 already-completed + 3 busy`，之后 4 次重试全部收敛为 `already-completed`，因此没有把一个合法租约竞态错误写死为单一返回顺序。

外部渠道现由独立 `order_notification_delivery` 账本承载。根 outbox 消费事务把不可变目标、模板号和渲染载荷写入 PostgreSQL，并与站内信及根事件完成原子提交；Queue 只携带 delivery ID、event key 和 channel，不携带手机号、openid 或模板载荷。调度器使用 `FOR UPDATE SKIP LOCKED` 和短租约把 `PENDING/RETRYABLE` 转为 `ENQUEUED`，提供商 HTTP 调用始终在事务外；确定成功写 `SENT`，确定的限流/服务端拒绝按最多 5 次有界退避，配置或确定性错误写 `DEAD`。连接断开、超时、非法响应或 `PROCESSING` 租约过期可能发生“提供商已接收但本地未知”，统一进入终态 `UNKNOWN`，不让 Queue 自动盲重发。阿里云 `SendSms` 没有幂等键，`OutId` 只用于外部跟踪，因此 `UNKNOWN` 必须先人工对账再决定是否承担重复风险重放。

提供商适配已实现阿里云通用模板短信、公众号模板、小程序订阅消息和微信小程序发货上报；验证码 Redis 前置条件与通用模板短信凭据已拆分，避免订单短信因缺少验证码缓存而全部失败。微信 access token 会缓存并在明确失效码时刷新一次，响应体限制 64 KiB，HTTP 超时 8 秒。生产隔离场景还暴露并修复了一个 Hyperdrive 边界：认领事务设置随机 `search_path` 后，事务外状态更新会在连接复用时落回 `public`；现所有账本状态迁移均为独立短事务且校验更新行数，提供商调用仍不持锁。

外部 `0084_order_notification_outbox.sql` 与内嵌 `migration_0091` 完全一致：增加 nullable `system_message.event_key`、唯一索引 `smsg_event_key_uq`，并把 `soob_event_type_ck` 从仅 `order.paid` 扩展到三种明确事件，没有放宽为任意字符串。生产 PostgreSQL 16.14 已直接应用并独立确认：列类型为 `character varying`，索引和约束定义精确，unsupported outbox 行为 0；现有 `system_message` 1 行且非 NULL 事件键 0，`store_order_outbox` 0 行，业务行数没有因 DDL 改变。

外部 `0085_external_notification_delivery.sql` 与内嵌 `migration_0092` 增加 1 张账本表、唯一 `(event_key, channel)`、按 outbox/order 查询索引、三类 partial dispatch/lease 索引和 channel/status/time 三项检查约束；同时补齐 `wechat_user` 的 openid 唯一索引、unionid/uid/uid+type 查找索引，以及启用模板 `(legacy_type, mark, id) WHERE status=1` partial index。生产已幂等应用并独立确认账本索引 6、检查约束 3、目标查找索引 5，账本业务行 0；DDL 前后站内信 1、根 outbox 0、外部投递 0，未改动业务行。

外部 `0086_notification_delivery_operations.sql` 与内嵌 `migration_0093` 完全一致，新增不保存手机号、openid 或渲染 payload 的 `order_notification_delivery_action`。每条人工决定保存 UUID 请求键、动作、前后状态、管理员、理由、可选提供商引用和时间；请求键唯一，按 delivery 与管理员时间建立 2 个查询索引，并以 2 个检查约束限定动作及管理员/时间。生产已原子幂等应用，确认 3 个目标索引、2 个检查约束、表 0 行，应用前后现有消息、outbox、投递和动作行数不变。旧 `/sms/config` 写接口已改为拒绝：阿里云密钥只能通过 Worker secrets 注入，Admin API 只返回配置是否存在，不保存或回显 AccessKeySecret。

### 生产 Hyperdrive 隔离验证与清理事件

正式 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 的严格场景在随机 `codex_order_notice_*` schema 克隆用户、订单、商品快照、售后、渠道退款状态、订单状态、outbox、通知模板和站内信九张表，并把所有 serial 默认值替换为 schema 私有序列。真实 Supplier 发货和真实售后拒绝服务验证了发货/outbox、拒绝/outbox 同事务：故障约束下业务状态和状态日志全部回滚，移除后安全重试。场景共生成 5 条事件，其中 2 条快递、2 条拒绝模板启用、1 条配送模板禁用；消费结果为 5 条 outbox 全完成、4 条站内信、禁用事件 0 条消息，失败目标首次为 `FAILED/attempt=1` 且消息 0，重试完成后 attempts 精确为 `[1,1,1,1,2]`。重复 enqueue 返回同一 ID，变更不可变载荷被拒绝，标题/正文已替换昵称、商品、物流和退款占位符。

第一次生产场景暴露了 Hyperdrive 不可靠保留连接启动 `search_path` 的隔离缺陷：播种语句没有显式事务级 schema，重试 6 次后在 `public` 留下精确审计标记 6 个用户、30 单、30 条购物车、12 条退款和18 条合成通知模板；故障发生在业务状态/outbox/消息写入前，这四类行均为 0。发现后立即停止场景，增加带固定账号、订单号、金额、电话、模板 ID/名称/mark 和退款原因多重守卫的清理端点，在单事务只删除这些合成行；独立查询确认上述七类审计标记全部归零、临时 schema 为 0、公共 `system_message` 仍为 1 行且非 NULL 事件键 0、公共 outbox 仍为 0。显式主键没有推进公共序列。随后所有播种/读取/业务调用都改为外层事务 `SET LOCAL search_path`，并把建 schema、业务场景、清理/指纹拆成独立数据库连接生命周期。

修正后严格生产报告为 `schema_created=true`、`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`；公共九表全行摘要及公共序列前后完全一致，最终用户/订单/购物车/退款/状态/outbox/模板审计标记全为 0。期间一次 `/state` 请求在数据库场景前收到传输 EOF，临时 Worker 仍由 `finally` 删除；加入只读就绪重试后才取得完整严格报告，没有把传输失败当成通过。所有本批临时 Worker 和一次性令牌均已删除；主 `cinashop-api` 没有部署。

扩展后的 2026-08-15 严格场景把 `order_notification_delivery`、`order_notification_delivery_action`、`wechat_user` 和渠道配置纳入同一随机 schema，共暂存 17 条外部投递：短信 5、公众号 4、小程序订阅 5、微信发货上报 3。mock 提供商只在 Worker 内存返回响应，不调用真实阿里云或微信；16 条确定成功写入 `SENT`，第 1 条短信模拟发送后的网络结果丢失并写入 `UNKNOWN`。随后逐条重放得到 16 个 `already-sent` 和 1 个 `unknown`，实际 mock 调用没有增加；Queue 17 条消息全部只有账本引用，没有目标或载荷。人工运维扩展继续验证 `UNKNOWN→RETRYABLE`、`UNKNOWN→SENT`、`UNKNOWN→DEAD` 三条状态迁移，完全相同请求键重放只产生 1 条动作，同键改变理由或提供商引用会拒绝，三类处置严格产生 3 条不可变审计记录，Admin 投影只返回遮罩目标且不含 `target/payload`。场景还验证 provider 调用不在事务内、状态更新短事务、失败业务/outbox 与失败站内信全回滚、根事件并发重放收敛。最终随机 schema 删除、同前缀 schema 为 0、public 14 表全行摘要和序列前后完全一致，生产投递账本、动作审计和审计标记均为 0；临时 Worker 已删除。

人工处置首次扩展时又捕获一个隔离测试缺陷：新增的两条处置夹具直接使用根连接插入，未经过事务级 `SET LOCAL search_path`；`/run` 的 HTTP 500 又被探针当作平台 1042 重试，最终在 `public.order_notification_delivery` 留下 4 条带固定 `audit_manual_*` 标记的孤儿夹具。发现后立即停止，改为只对平台 1042 重试；场景插入改为显式隔离事务。清理端点以固定错误标记、事件键范围、十位审计 ID、短信渠道、固定测试手机号、`UNKNOWN` 和 `sent_time=0` 多重守卫锁定并删除 4 行，没有匹配任何动作或业务记录。Hyperdrive 缓存一度继续返回旧的 count=4，因此没有以缓存读作为清理证据；事务内加入 `clock_timestamp()/random()` 的不可缓存实时查询在 `2026-08-15 01:15:18+08` 确认为 delivery 0、action 0、孤儿 0、临时 schema 0。随后严格场景完整通过且 `public_state_unchanged=true`。

### 当前判定

本批已把“业务事务 outbox + 站内信精确一次 + 四类外部渠道可对账投递账本 + 人工处置审计”完成到代码和生产引擎隔离验证层。Admin 已新增响应式渠道矩阵、`mark/tempid` 模板维护、发货上报开关、仅布尔值的凭据就绪视图、脱敏投递台账，以及 `UNKNOWN` 确认已发/承担重复风险重发/关闭不重发和动作历史；任意人工重发最多 20 次并要求理由、风险二次确认和幂等请求键。它仍不是完整通知上线：生产没有四类源模板、通知开关、openid、短信/微信凭据或符合微信发货条件的订单。Yihaotong/Tencent 短信提供商兼容、真实阿里云/微信账号验收、源配置和身份复制、受限运营账号验收、主 Queue 发布/回滚演练均未完成；主 Worker尚未发布。

## 拼团迁移详细审计（2026-08-12）

### PHP 权威状态机与旧 Worker 偏差

| 阶段 | `cinashop-php` 权威行为 | 审计前 Worker 偏差 | 当前修复 |
|---|---|---|---|
| 统计接口 | `route/api.php` 的 `GET /pink` 只返回成团人数与头像统计 | 错迁为可直接创建/加入团的 `POST /pink`，可绕过订单和支付 | 恢复 `GET /api/pink`；删除独立写入入口 |
| 创建参团订单 | `StoreOrder` 控制器以 Redis `checkStock/popStock(md5(pinkId))` 预占名额，订单保存 `pink_id`；此时不创建公开成员 | 下单事务立即插入/修改 `store_pink`，未付款用户已公开且可能把团标为成功；还把 PHP 的“成团所需人数”列当作当前人数递增 | PostgreSQL 锁团长行，以“有效公开成员 + 未付款有效订单”计算容量；未付款订单自身作为可回收持久预占，`people` 始终表示成团门槛 |
| 支付成功 | `listener/order/Pay.php` 投递 `PinkJob::createPink`，`StorePinkServices::createPink` 才创建团长/成员并在满员时整团置为 `status=2` | 支付事务没有可靠的成员激活步骤，公开状态可能早于资金状态 | 余额支付和所有外部支付回调在同一 `paid=0→1` 事务内激活成员；回调到达时原团失效会为已扣款订单安全开新团，避免资金已扣而订单仍未付款 |
| 旧 Worker 在途订单 | 不适用 | 旧版本把团长行在付款前写入，并把幂等 key 而非数据库订单 ID 写入 `order_id_key` | 支付预检识别“业务订单号 / 旧 unique key / 数据库订单 ID”三种关联；属于当前未付款订单的旧团长行可被原子认领并规范化，已失败行则新开团 |
| 未付款超时 | PHP 按普通/活动/拼团配置自动取消并返还占用资源 | 没有定时取消；未付款订单和活动库存可长期占用 | Queue 根任务分页扫描，消费前重验 `paid/status/is_del/add_time`，复用完整取消补偿；`order_pink_time=0` 按 PHP 回退到活动订单时限，生产缺少配置时默认 1 小时 |
| 拼团超时 | `PinkJob`/`StorePinkServices` 将未成团记录失败并为已付款参与者退款 | 无拼团截止任务和失败退款 | 每 5 分钟按主键游标扫描到期团；失败团只要仍有未全退订单就持续重入，重复 Queue 消息在订单锁下复用唯一进行中退款，部分售后完成后精确补齐剩余金额；外部处理中结果由既有退款对账重试 |
| 团长/成员退款 | PHP 成员退款减少团员；团长退款可提升下一位成员并重写其他订单 `pink_id` | 直接把团长设失败，没有退款、接替或关联重写 | 全额退款事务同步标记成员、重算人数；团长退款按最早有效成员接替，并重写成员与未付款订单的团 ID；超时失败团不被错误复活 |
| 履约闸门 | PHP 后台发货、对外订单与两套核销服务均要求拼团 `status=2` | Admin 与 Supplier 发货未统一检查成团状态 | Admin 整单发货及 Supplier 整单/拆单发货均在订单事务内要求 `status=2`；新运行时尚未迁移真实核销执行链，因此核销门禁仍是明确剩余项 |
| 用户显示 | 订单和拼团详情区分进行、成功、失败 | 订单详情缺少团状态，PC/UniApp 可能把待成团订单当普通待发货订单 | 详情返回 `pinkStatus/pinkInfo`；PC/UniApp 显示“拼团中”或“拼团失败退款处理中”，并阻断未成团订单动作 |

### 生产 PostgreSQL 只读证据

2026-08-12 通过临时 Worker 直接使用指定 Hyperdrive 对生产 PostgreSQL 做只读聚合，复核 `public` 仍为 207 张表。`store_pink` 只有 2 行且都是团长行：1 行 `status=1`、1 行 `status=2`，两行都没有任何已付款拼团订单作为凭据；其中成功行由未付款订单提前生成，正是旧 Worker 偏差。`store_order(type=3)` 共 3 行：2 行未付款且仍指向上述已“成功”的假团，1 行已付款但 `activity_id=0/pink_id=0`，不构成可用拼团样本。

不变量统计为：未付款却已有公开参与行 1、未付款订单引用无效团 2、运行时成员计数与公开行数不一致 2、无付款凭据的旧团长 2、活动 ID 无效的拼团订单 1；超额占位 0、有效拼团订单“已付款但缺公开成员”0、已到期仍活动的团 0。三个取消时限配置在生产均不存在，因此新代码会使用明确默认值。上述异常行没有被探针直接修改：直接 SQL 取消会绕过库存、购物车、积分、优惠券与退款补偿，必须由发布后的订单/拼团状态机处理或先在隔离副本演练定向修复。临时审计 Worker `cinashop-prod-pink-audit` 及本地探针已删除，主 `cinashop-api` 没有部署本批代码，生产异常数据因此仍原样存在。

后续退款隔离场景进一步确认 PHP `is_refund` 不是布尔值而是团记录引用；生产原 `SMALLINT` 已安全拓宽为 `INTEGER`，现存 2 行统计不变。成员全额退款已在生产 PostgreSQL 隔离 schema 中验证：成员状态置 3、`is_refund` 写入大于 32767 的团长 ID、团长活动人数从 3 精确降为 2，并与积分、佣金、供应商结算和余额处于同一失败可回滚事务。团长全额退款也已验证：最早成员成为新团长、人数为 2，其他成员和存活订单的 `pink_id` 均原子重写。

超时恢复场景进一步覆盖状态提交后的中断窗口：Cron 可重新发现已失败但仍有未全退订单的团；两个成员在同一 Queue 消息并发重投下各只退款一次，随后回放无新增账单或退款行；已有 `3.00` 部分退款会先完成原申请，再以 `7.00` 和剩余商品 cart 快照补齐全额。该合成场景结束后已完成团不再被扫描，证明代码层的至少一次投递可收敛；真实 Cloudflare Queue 消费、消费者进程强杀和 DLQ 仍需部署到隔离环境验证。

### 当前判定

拼团代码已从“结构和页面存在”提升到“生产 PostgreSQL 隔离状态机主链与超时重复投递收敛通过”，但不能标为迁移完成：生产没有一笔有效的真实已付款拼团样本，真实微信/支付宝回调、真实 Cloudflare Queue/DLQ、并发抢最后名额、核销以及生产清理均未做 E2E；PHP MySQL 源数据也尚未复制。上线前仍须以定向发布和只读复核确认两条旧孤儿团及两个未付款引用已由补偿任务安全收敛。

## 门店自提与核销详细审计（2026-08-12）

PHP 对照确认核销不是单一 `store_order.status` 更新：必须同时验证已付款、售后状态、自提/配送身份、拼团成团、商品核销时间窗与剩余次数；每条商品行递减 `write_surplus_times`，部分核销把订单置为 `status=5`，全部核销才进入统一收货结算，并为每次消费写入 `store_order_writeoff` 不可变记录。旧实现还区分平台管理员、门店店员/客服和配送员。Worker 原先只保留表结构、门店/店员管理及 `canStaffVerify`，没有公开自提门店、下单门店/核销码、核销执行路由或结算联动，且 Admin 发货没有阻止 `shipping_type=2`。

| 边界 | PHP 行为 | 审计前 Worker | 本批结果 |
|---|---|---|---|
| 自提下单 | 选择可营业门店并生成核销码 | 接受 `shippingType`，但不保存 `store_id/verify_code`，前端无选择器 | 仅允许 1 快递或 2 自提；自提在事务内重验 `is_store=1/is_show=1/is_del=0`，以 Web Crypto 无偏随机生成 12 位码，并用全局 advisory lock + 冲突查询弥补旧表没有唯一约束；PC/UniApp 可选门店和独立自提联系人 |
| 操作者权限 | 平台、客服/店员、配送员按身份核销 | 只有只读资格函数，无执行链 | `operator/profile` 只从当前登录 UID 推导角色；店员必须是唯一有效 `system_store_staff` 且固定 `staff.store_id = order.store_id`、`verify_status=1`、门店营业和用户有效；配送员必须是唯一有效平台身份 `type=0/relation_id=0` 且固定 `order.delivery_uid = current uid`；Admin 路由受 `order.manage` 服务端 ACL 保护 |
| 平台配送发单 | 指定有效配送员并生成核销凭证 | Admin `send` 只写 `delivery_uid/status=1`，没有核销码 | Admin 发货事务重新锁定有效平台配送身份和用户，在全局核销码锁内生成 12 位码，再原子写入 `delivery_type=send`、`delivery_uid`、`verify_code` 和状态；自由填写姓名/电话不能成为授权依据 |
| 并发与售后 | 核销前阻断进行中售后 | 售后申请不参与订单结算锁，存在申请/核销竞态 | 售后申请、核销、收货和退款执行共用订单 settlement advisory lock；核销再锁订单行，商品行按 ID 升序 `FOR UPDATE`，售后查询在锁内重验。已有核销的商品行不能再按整行申请退款；生产 PG 双连接竞争已证明恰好一方成功，失败方由业务不变量拒绝而非超时/死锁 |
| 部分核销 | 递减每行剩余次数，订单 `status=5` | 未实现 | 请求行必须唯一、数量为正整数且不超过剩余次数；校验 `write_start/write_end`；每条消费写审计记录；部分核销后立即随机换码，旧码失效 |
| 全部核销与结算 | 全部商品消费后执行通用收货结算 | 未实现 | 最后一笔核销原子更新订单 `status=2`、清空核销码，并复用统一结算原语处理 Supplier 应收、积分/经验、两级/事业部佣金、既有退款冲正和状态日志，避免复制或双结算 |
| 扫码与客户显示 | 操作者扫码核销；客户只在交付时出示凭证 | 无专用扫码页，客户看不到核销码 | UniApp 新增店员/配送员共用扫码页，支持原生扫码或手输、角色切换、掩码客户信息、逐行数量和不可逆确认；PC/UniApp 区分“自提核销码/送达核销码”，普通快递才显示物流链接 |
| 防绕过 | 配送订单必须由配送员送达核销完成 | 用户确认收货和 Cron 可直接把 `send` 订单结算 | 用户收货服务端拒绝 `shipping_type=2` 或 `delivery_type=send`；Cron 候选查询及消费前重验都排除 `send`；共享 `completeOrderReceipt` 结算原语也中央拒绝两类订单，防止新调用点绕过；前端隐藏配送单手工收货按钮 |
| 供应商同城配送 | 需要供应商作用域配送员、订单归属和核销闭环 | Supplier 允许自由填写配送员姓名/电话并提交 `send`，没有实名 UID 或核销码 | 服务端硬拒绝 Supplier `send`，发货弹窗移除该选项并解释边界；历史记录保留只读显示。待建立供应商配送身份模型前不伪装为可用能力 |
| 履约边界 | 自提单不可走普通发货 | Supplier 已阻止，Admin 未阻止 | Admin/Supplier 均阻止自提单普通发货；Admin 订单详情可对自提或平台配送订单校验、选定数量或全部核销 |

### 生产 PostgreSQL 只读证据

两次临时 Worker 通过指定 Hyperdrive 取得聚合证据后均已删除，本地探针目录也已删除，URL 复核为 404。只读事务明确返回 `transaction_read_only=on`；当前 `system_store=0`、有效自提门店 0、`system_store_staff=0`、有效核销员 0、`delivery_service=0`、有效平台配送员 0、`store_order(shipping_type=2)=0`、`store_order(delivery_type='send')=0`、配送商品行 0、`store_order_writeoff=0`，相关孤儿、重复身份、缺码、码长、重复码、完成后残留码和越权关系均为 0。只对缺失的普通 B-tree 索引 `so_verify_code` 执行了明确且幂等的生产 DDL；订单和身份数据没有修改，主 `cinashop-api` 没有部署本批代码。这意味着当前没有历史部分核销行需要在线兼容处置，也意味着无法用生产数据证明真实自提/配送下单、扫码、并发核销、换码、结算或退款门禁。

### 生产 PostgreSQL 隔离写入集成证据

`test/integration/StoreOrderWriteoffPostgresScenario.ts` 通过生产 Hyperdrive 连接 PostgreSQL 16.14，但只在随机 `codex_writeoff_it_*` schema 中写入合成数据。测试以 `LIKE public... INCLUDING ALL` 克隆 `user`、门店/店员/配送员、订单/商品快照/退款/核销/拼团/状态和供应商流水共 11 张必要表，为退款、核销与状态表创建 schema 私有序列；每个事务固定 `search_path` 并设置 3 秒锁超时和 15 秒语句超时，避免长时间影响生产。

真实执行结果为：自提预览手机号掩码通过；首次部分核销把订单置为 `status=5`、记录店员并更换 12 位核销码，旧码失效；最终核销把订单置为 `status=2`、清空码并留下 2 条不可变记录。错误配送员被拒绝，正确配送员完成送达并把身份写入商品行；源表没有配送员审计列，因此核销记录按兼容约定保留 `staff_id=0`。两条独立 Hyperdrive 连接同时核销同一码，严格得到 1 次成功、1 次拒绝、1 条不可变记录和最终 `status=2`。共享收货结算原语分别拒绝平台配送与自提，只允许普通快递完成。重复店员和配送员身份均在角色探测中标记冲突并在执行时拒绝；未成团拼团订单拒绝后没有消费商品或生成审计行，团状态改为成功后才核销完成。售后申请与核销的双连接竞争严格得到 1 次成功、1 次拒绝；本次售后写入 1 行而核销写入 0 行，失败由业务门禁触发。测试最后删除临时 schema，独立查询确认不存在；`public` 的订单、商品快照、退款、核销、状态、用户、门店、店员、配送员行数和退款/核销/状态公共序列前后完全一致。

本域已从“本地主链完成”提升为“生产 PostgreSQL/Hyperdrive 隔离合成场景已验证”，仍不能标为迁移完成：专用扫码页尚无真机扫码与浏览器渲染证据，生产没有真实门店、店员、配送员或可核销订单样本；门店商品/库存范围、供应商作用域同城配送、打印/通知副作用、支付后真实自提/送达、真实拼团成员和第三方退款 E2E 仍未验证。旧 `store_order_writeoff` 没有配送员列，因此配送身份目前记录在商品行 `delivery_id`，不可变核销行的 `staff_id=0`；这是保留源 schema 的证据拆分，未来若要求单表直接归因需另做兼容迁移。PHP MySQL 复制还必须逐行保留 `write_surplus_times` 与历史 `store_order_writeoff`。

本轮继续保留订单解释证据、促销/活动/积分订单、商品元数据、用户分群、动态表单、签到、代理任务、商品赠券与砍价帮助等旧数据，并新增商品保障服务、商品行为日志、访问聚合、用户反馈和客服快捷话术。商品详情会实时解析启用的保障服务；Admin 可管理平台保障，Supplier 只能读取平台公共项与自身项；商品浏览会追加 `store_product_log(type=visit)` 并维护 `store_visit` 聚合，登录用户的浏览历史支持分页、日期分组与仅删除访问事件。用户反馈按旧手机号/必填规则校验并在存储前转义，Admin 可处理和删除；平台公共话术按原分类域管理，新写入以作用域锁防并发重复。`store_product_log` 的购物车、下单、支付、收藏、退款事件，以及专用客服身份的私有话术管理尚未全部接入新运行时，不能把“表已迁移”解释为所有统计/客服链路已恢复。

`0056` 新增 `promoter_apply`、`user_spread` 与 `user_brokerage_frozen`：用户端推广员申请继续要求系统分销配置与 Upstash `code_<phone>` 短信验证码，未配置缓存或验证码缺失时安全拒绝；Admin 两套路由恢复申请列表、审核和软删除，并在事务内校验申请归属。直接绑定、密码登录/注册和微信登录的有效推广关系统一走事务级全局关系锁、稳定用户行锁、防环/深度检查、上级计数与 `user_spread` 审计写入。`user_brokerage_frozen` 仅保留旧历史证据，现行冻结余额继续只读取 `user_brokerage.frozen_time`，避免重复冻结；事业部角色管理现有的专用层级写入尚未统一追加这张通用审计表。

`0057` 继续补齐 `user_friends`：旧库四列与非唯一历史语义原样保留；新推广绑定在同一事务内写入去重后的好友对，社区恢复登录态 `/community/user_friend` 双向列表，并在旧 `community_user` 快照缺失时从有效用户资料生成兼容返回。社区关注/粉丝关系尚未迁移，因此当前好友列表的 `is_follow` / `is_fans` 明确返回 0，不能当作关注链路已恢复。

`0058` 继续补齐 `user_search` 与 `user_visit`：两表 16 个旧列及非唯一搜索历史原样保留；商品关键字搜索恢复两小时完整 ID 结果复用，并在短事务内以 advisory lock 和行锁串行更新用户/游客搜索次数。登录态搜索历史、旧 GET 清理别名与新 POST、页面停留上报均已恢复；微信小程序和公众号登录以失败不阻断登录的方式追加首页访问记录。搜索分词仍没有接入旧外部分词服务，当前 `vicword` 新写入为空数组；旧访问统计后台接口也尚未整体迁移。

`0059`/`0060` 继续补齐 `store_newcomer` 与旧数据库 `cache`：新人目录、活动 SKU 定价/基础库存、创建订单时原子消费资格、注册标记及四条前台路由已恢复；新人协议重新读取带过期语义的 `newcomer_agreement` 缓存。普通订单首单折扣现按 PHP `checkUserFirstDiscount` 恢复服务端计价、时限/已支付历史复核、封顶、与优惠券互斥、商品快照分摊和创建时资格消费；PC/UniApp 通过服务端只读 quote 同步结算展示与优惠券互斥。Admin 新人目录、16 项注册配置和协议写入，以及密码/微信注册赠积分、余额和优惠券的原子账本链路均已恢复并通过生产 Hyperdrive 隔离场景；`kf_adv`、`open_adv`、`uni_app_url`、五类协议和管理员商品草稿也已恢复，旧公开扫码上传则由认证私有 R2 明确替代。源缓存内容、真实用户与正式发布仍未完成。

`0061` 继续补齐 `member_card_batch`、`member_card`、`member_ship`、`other_order` 与 `other_order_status`。前台会员首页、会员券列表、期限预估、套餐建单/支付和卡密兑换路由已恢复；兑换在同一短事务内按用户→卡→批次固定顺序加锁，条件认领卡片、增加批次使用量、更新会员期限并写入已支付会员订单和状态证据。卡密仅做迁移与恒时摘要比较，不进入响应或日志；过期会员从当前时间重新计算，不沿用 PHP 中已过期时间继续累加的缺陷。Admin 已恢复 16/16 条 PHP 会员管理路由以及批次/卡片/套餐/权益/协议/记录/二维码页面，卡密只在发卡响应出现一次，后续不回显密码；生产 Hyperdrive 的 Admin 运营和购买/支付两个随机隔离 schema 均已完成真实 SQL/锁 E2E。仍缺旧会员数据复制、真实微信/支付宝测试商户回调、真实用户验收和本批主 Worker/前端发布，因此不能把付费会员域标为生产完成。

`0062` 继续补齐 `store_coupon_product` 与 `store_coupon_issue_user`：商品券模板保存会在同一行锁事务内同步重建适用商品关系，普通领券和支付后赠券会在原发券事务写入领取证据；下单同时读取模板逗号串与关系表，两者都存在却不一致时安全拒绝，避免静默扩大券范围。两张源表均无主键/唯一约束，目标没有凭空新增约束；迁移器现按全部映射列的二进制规范值分组并携带 multiplicity，完全相同的历史重复行按原次数插入。初次复制必须使用空目标表，仍待隔离数据库演练。

`0063` 继续补齐 `system_store`、`system_store_staff`、`delivery_service` 与 `store_user`：目标结构原样保留源列、空值和普通索引，不凭空增加唯一约束或外键；四表均以 `id` 进入确定性迁移 manifest。Worker 恢复 PHP/Admin 兼容的门店、店员、配送员管理路由和响应式管理页；店员安全选择明确排除 `pwd` 与 `last_ip`，新增/更新忽略客户端权限和密码字段；核销资格同时校验有效门店、店员、核销开关和用户状态。平台配送员的新写入以 advisory lock 拒绝重复有效 UID/手机号，但允许无损导入历史重复；订单门店配送只使用服务端唯一有效身份记录的姓名和手机号，不信任客户端覆盖，并在订单行锁事务内提交配送状态证据。

`0064` 继续补齐 `store_config`、`store_branch_product`、`store_branch_product_attr_value` 与 `store_extract`。源码调用链表明两张分店商品表没有对应旧模型，所谓 Branch service 实际注入主 `store_product` / `store_product_attr_value` DAO；`store_extract` 也没有活动模型、服务或控制器引用，因此三表只作为历史证据无损迁移，不被误建成新的库存或提现权威。`store_config` 仍有供应商路由消费者，但 PHP 保存方法继续写已不存在的 `store_id`，供应商控制器还以三参数调用两参数方法，读取却使用 `type + relation_id`，属于明确版本漂移。Worker 已改为从认证身份固定 `type=2 + relation_id=supplierId`，只允许旧打印/电子面单键，事务锁下拒绝歧义历史行，密钥只返回“已配置”状态且空白提交保持原值；供应商中心新增响应式履约配置页。收据打印已由 `print_document + Queue/outbox` 单独恢复；电子面单签发仍未恢复。

`0065` 继续补齐 `supplier_ticket_print` 与 `print_document`。前者仅作为被后者取代的单打印机历史配置迁移，后者是当前 PHP 实际订单打印权威。审计发现旧 Supplier 的详情、保存、启停、删除和打印内容操作只按 `id`，可跨租户/平台读写，且易联云应用密钥与飞鹅云 UKEY 会回显；Worker 所有读写改为认证身份派生的 `supplier_id` 与软删除状态联合限定，平台固定 `supplier_id=0`，写入采用 advisory lock，密钥只返回配置状态且空白提交保留原值。模板字段、数组、站内二维码路径和提示语均做显式白名单、长度及打印控制标记校验，只有凭据与有效模板齐全时才能启用。Admin/Supplier 兼容路由均已恢复，Supplier 新增响应式打印机与打印内容页面；旧 `/printing` 表不再作为运行时权威。后续 `0090` 已建立带幂等、Queue/提供商租约、未知结果隔离和人工审计的小票 outbox，并恢复易联云/飞鹅云协议；生产 Hyperdrive 隔离 mock-provider E2E 已通过，但主 Worker、DDL和前端尚未发布，生产也没有打印机配置或真实出纸证据。

`0066` 继续补齐 `system_user_apply` 与 `sms_record`，恢复供应商入驻的用户提交/重提/记录、Admin 列表/详情/审核/备注/删除和账号短信激活。审计确认 PHP 更新申请只按客户端 `id`，可覆盖其他用户记录；审批还使用手机号后六位作为默认密码并在用户详情返回。Worker 所有用户读写固定 `uid + type=2 + is_del=0`，已通过申请不可修改或删除；审核通过在一个短事务中创建供应商和禁用的 `admin_type=4` 账号，只返回账号与待激活状态，不生成或泄露可预测密码。申请人必须以原手机号验证码设置 12～72 位密码后才启用账号。验证码由 Web Crypto 无偏生成，仅写入 5 分钟 Upstash 缓存和可重试 Queue 消息，PostgreSQL 只保存脱敏发送审计；手机号/IP/全局频率均在事务锁下限制，Aliyun 密钥只允许 Worker secret，响应有 64 KiB 上限与 8 秒超时。真实 Queue 实测确认当前 `max_retries=3` 最多投递 4 次，代码已在第 4 次失败后删除验证码并标记发送失败，配置一致性由单元测试约束。DLQ 脱敏归档与敏感消息禁止重放已在独立真实 Queue + 生产 Hyperdrive 隔离 schema 中验证；主 Worker 尚未发布，真实 Aliyun 短信、供应商账号登录 E2E 和线上 DLQ 消费仍未执行。

`0067` 继续补齐 `system_attachment`、`system_attachment_category`、`system_file` 与 `system_storage`。前三张运行时相关表按旧列、主键、空值和普通索引语义保留；`system_file` 只作为 PHP 本地文件完整性历史，因为 Worker 文件系统不可写。新图片使用生成的私有 `ASSETS_BUCKET` R2 binding，上传先校验 10 MiB 上限、JPEG/PNG/WebP/GIF 魔数与声明 MIME，再写对象，随后以短 PostgreSQL 事务写附件元数据；失败会补偿删除对象。读取只接受规范 `/api/assets/:id`，由 `APP_KEY` 生成最多一小时的 HMAC-SHA256 临时 URL；Admin、Supplier、用户和客服分别固定平台、认证供应商、认证 UID 和认证客服账号作用域。PHP 中供应商附件/分类按裸 `id` 删除或编辑的越权行为没有被兼容。旧 Qiniu/OSS/COS `access_key` 只迁移历史，列表只返回是否配置，运行时唯一权威是 R2 binding。Admin 素材中心、UniApp 资质上传和客服双端图片聊天已接入；视频、分片、在线图片抓取和扫码/游客上传仍未迁移。正式 `cinashop-assets` R2 bucket 已在 APAC 以 Standard 存储建立，远端精确写读删、临时 Worker binding和客服媒体 PostgreSQL/R2 隔离 E2E 均通过，清理后无残留；但主 Worker 尚未发布本批代码，旧附件对象搬迁和真实账号应用上传仍未执行。

`0068` 继续补齐 `store_product_category_brand`、`store_product_cate` 与 `store_product_label_auxiliary`。源码调用链确认分类品牌表没有 PHP 运行时引用，旧分类/标签 Job 也没有任何 dispatch；现行商品创建/更新只派发 `ProductRelationJob`，统一写入 `store_product_relation`。因此三张旧表只按源列、主键和普通索引语义保留为可迁移历史，不新增路由、页面或双写。审计同时修复 Worker 漂移：PHP 分类关系保存所选分类的即时 `pid`，目标此前却从 `path` 取根祖先，分类移动还把同一个根值写给全部后代；现在商品保存直接写 `category.pid`，移动时按每个受影响分类自己的即时父 ID 更新，继续保持 `store_product_relation` 为唯一运行时权威。

`0069` 继续补齐 `page_category` 与 `page_link`。两表保持 PHP 列、默认值、主键及历史重复/孤儿语义，只为 `pid/cate_id + sort + id` 实际读取增加普通复合索引，不自创外键或唯一约束。Worker 恢复四条 `diy/*` 兼容路由：分类树保持旧服务从 `pid=0` 递归且不按状态过滤；普通链接按分类分页；`special` 动态读取未删除的 `system_dise(type=1/2)`；`product_category` 固定平台 `type=0 + relation_id=0` 并只返回启用分类，避免跨供应商/门店暴露。新增自定义链接同时限制 8 KiB JSON/form 请求体、字段长度、控制字符和危险 URI scheme，删除保持旧版硬删除。当前新 Admin 仍只有简化 DIY 页面编辑器，完整可视化链接选择器没有伪装成已迁移。

`0070` 继续补齐 `luck_lottery`、`luck_prize` 与 `luck_lottery_record`，并新增仅由 Worker 使用的 `luck_lottery_entitlement`，把 PHP/Redis 中会被同类事件覆盖且仅存活 120 秒的支付、评价抽奖次数改为带来源幂等键、剩余次数和过期时间的 PostgreSQL 权益。抽奖在短事务内按固定顺序锁定用户、活动、奖品、优惠券和权益，使用 Web Crypto 无偏随机，并把积分/余额扣减、库存、中奖快照、优惠券/余额/积分发放和账单原子提交；领奖按 `record id + uid` 限定，实物奖品由用户选择自身地址后等待 Admin 发货。支付、评价和永久推广绑定分别接入因子 3/4/5；Admin 恢复活动、8 奖位、记录和发货页面，UniApp 恢复抽奖、规则、记录和实物领奖。新活动明确禁止微信红包和语义不明的用户等级奖品；历史 type 4/type 8 记录可查看但不可在新运行时领取，避免伪造第三方打款或猜测等级写入。

`0071` 继续补齐 `wechat_key`、`wechat_media`、`wechat_message`、`wechat_news_category` 与 `wechat_reply`。Admin 恢复关注/默认/关键词回复、图文组和脱敏消息历史页面；关键词目录在短事务与 advisory lock 下拒绝新歧义，回复删除与关键词清理原子提交，图片/语音仅能引用已迁移且类型匹配的素材。图文编辑只允许修改当前分组已有文章，新建分组不能覆盖任意 CMS 文章；历史共享文章会克隆后再编辑，正文同时镜像到 `system_article` 与 `article_content`。完整 `/wechat/serve` 仍联动尚未迁移的二维码、用户卡券、支付和企业微信事件链，因此本批没有启用半套回调；回复二维码和群发路由返回明确不可用，也不会在请求链同步调用微信外部接口。

`0072` 继续补齐 `qrcode`、`wechat_qrcode`、`wechat_qrcode_cate` 与 `wechat_qrcode_record`。源端唯一的 `qrcode(third_type, third_id)` 约束原样保留，渠道分类、渠道目录、扫码事件不自创外键或业务唯一约束；Admin 恢复分类、渠道增删改查、状态、推广员与平台标签校验、扫码用户去重视图、最多 366 天的 SQL 聚合趋势和回复二维码入口。永久二维码不在 HTTP/数据库事务中同步请求微信，而是进入现有 Queue 至少一次消费，使用 advisory lock/源唯一键做目标幂等，微信 JSON 流限定 64 KiB，token 失效只刷新并重试一次。公众号扫码回调、用户/卡券事件写入与群发仍保持关闭，因此历史 `follow/scan` 只读，不伪装为实时增长。

`0073` 继续补齐 `queue_list`、`queue_auxiliary` 与 `system_timer`。三表列、空值和源主键语义原样保留，其中 `queue_list` 继续使用 `(id,type,status)` 复合主键，不自创外键或业务唯一约束；迁移 SQL 不插入默认任务，也不会因复制历史行触发 Cloudflare Queue。源码调用链确认两张 `queue_*` 表只是 Redis/ThinkPHP Job 批处理的任务头与逐项结果，`system_timer` 的 18 个 mark 则由 Swoole listener 动态消费；现有 Worker 只有 `auto_take → auto_receipt` 与 `auto_comment` 的独立 scheduled/Queue 实现，其他 16 类消费者尚未迁移。因此本批只恢复定时目录、批处理历史和发货逐项结果的只读 Admin 兼容接口，新增独立 ACL 与响应式“迁移运行历史”页，明确不提供重试、停止或启停按钮，也不让旧 `is_open/cycle` 配置 Cloudflare。

`0074` 继续补齐 `live_anchor`、`live_goods`、`live_room` 与 `live_room_goods`。四表全部源列、`live_room(id,phone)` 复合主键及关系表“只有非唯一索引”的重复证据语义均原样保留，不自创外键或业务唯一约束。`live_anchor`/`live_goods` 以 `id` 进入实时复制；`live_room` 以精确的 `(id,phone)` 混合主键进入实时复制，迁移器对 `id` 使用数值顺序、对 `phone` 使用二进制 UTF-8 顺序，并把两个分量写入 JSONB 检查点，因此不依赖公开接口只接收 `id` 的运行时语义，也不需要假设 `id` 单列唯一。`live_room_goods` 使用全行多重集策略，重复房间/商品关系按 multiplicity 原次数插入，初次复制要求空目标表。Worker 恢复公开直播列表、回放读取、Admin 只读目录，以及 Cron→Queue 的直播间/商品状态读取；远端创建/删除直播间、商品提审/删除和导入商品均缺少可由 Worker 控制的幂等键，因此没有迁移。`system_timer.auto_live` 现在标为部分迁移，而不是伪装整个旧消费者已等价恢复。

`0075` 继续补齐 `out_account` 与 `out_interface`，完整保留 PHP 安装表的 33 个源列、空值和普通索引语义，不增加源端不存在的唯一约束或外键。迁移器以两表 `id` 做确定性游标；运行时新增隔离的 `/outapi` token/ACL 域，并明确开放分类、商品、订单、快递/拆单商品、退款、优惠券、会员等级和用户共 14 条 GET，以及订单/退款/履约/发票/售后 11 条 PUT、分类 4 条写路由和实物商品 4 条写路由。备注写入先锁定平台订单/退款行，相同内容重放不重复写证据，变更与不含备注正文的 `store_order_status` 同事务提交；供应商退款不在对外平台作用域内。确认收货复用用户、供应商和 Cron 共用的完整收货结算状态机，而不是复制简化 SQL。两条发货路由复用 Supplier 履约状态机，以 `store_id=0` 二次限定平台范围，按逻辑主订单共用结算 advisory lock，并用不含原始物流字段的请求摘要提供事务内重放；拆单保持商品数量和金额守恒。PHP Out 控制器实际强制两条发货路由为人工快递，因此客户端 `send`/虚拟字段不会启用配送员或虚拟发货。配送更正路由只修改已发货订单的现有类型元数据；`send` 姓名/电话必须匹配已分配有效配送员，不修改 `delivery_uid`/核销码，旧请求延迟重放不会覆盖后来的新值。两条发票路由只修改平台订单唯一有效申请，在共享订单锁和发票行锁内校验旧手机号/抬头/税号/卡号/发票号合同；摘要证据不含任何发票 PII。两条售后决策路由按退款锁→订单锁固定顺序原子维护退款单/订单镜像状态，渠道退款已发起时拒绝改判，原因不进入日志/摘要；并发、延迟重放、关联门禁和失败回滚均通过生产 Hyperdrive 隔离验证。资金退款要求请求金额等于售后记录权威金额，绑定平台店铺、订单/退款、UID、Supplier 和整数分金额，余额退款短事务原子结算，外部渠道调用保持在事务外并复用稳定退款单号；PHP 同一售后单累计部分退款的不可达矛盾合同不会恢复。分类写入按平台作用域串行维护三级树、幂等重放和四类商品引用删除门禁；实物商品写入以独立回放账本、固定平台作用域、库存保持和条码歧义门禁恢复，优惠券和用户写入仍未开放。PHP 发货、拒绝事件和小程序上报已由后续 Queue/outbox 批次补齐代码与生产隔离验证。新建或轮换账户使用 Web Crypto 生成 64 字符密钥、bcrypt cost 12 存储并清空 `apppwd`，密钥只显示一次；Admin 响应不返回旧明文/推送凭据。每条路由继续逐接口 ACL 授权，订单/退款/用户读取使用显式安全字段投影并禁止缓存；用户密码摘要、身份证、登录 IP、条码和随机码不会返回。PHP 的任意 `push_token_url` 出站测试和推送不会恢复，导入 `out_interface` 文档也不会自动启用路由。生产当前两张 Out 账户/接口表均为 0，真实账户/权限复制与客户验收尚未开始。

`0076` 继续补齐全部 24 张 `work_*` 企业微信表。源端已有的 `work_member.userid` 与 `work_member_other.member_id` 唯一约束原样保留；`work_channel_cycle`、`work_channel_limit`、`work_client_follow_tags`、`work_group_msg_relation`、`work_member_relation`、`work_welcome_relation` 本来没有稳定唯一键，目标不凭空补键，迁移 manifest 显式选择重复行保真的全行多重集策略，初次复制要求空目标表。Worker 只恢复 Admin 专属、PII 默认脱敏的成员/客户/客户群/渠道码/群发/朋友圈/欢迎语目录；成员和客户同步、渠道码与入群方式变更、欢迎语发送、客户标签、群发和朋友圈投递统一返回 HTTP 501。PHP 中这些操作会在数据库事务或 ThinkPHP Job 中直接调用企业微信，缺少 Worker 可控制的幂等 outbox；在 Cloudflare Queue、投递记录、重试边界与专用 secret 就绪前不能启用。公开 `/api/work` 身份与客户群接口也没有恢复，避免泄露企业联系人数据。

`0077` 补齐最后 3 张源表：旧商户申请 `user_enter`、公众号会员卡配置 `wechat_card` 与领取/激活历史 `user_card`。源端只有 `user_enter.uid` 唯一约束，目标原样保留，不为微信远端 ID、会员卡 code 或 openid 凭空增加唯一性。`user_enter` 已被 `system_user_apply` 取代，仅计数保留历史边界；Admin `/content/wechat-card` 只读展示会员卡配置和领取记录，远端 card_id、code 与 openid 默认脱敏。PHP 制卡流程会同步上传图片并创建/更新微信卡券，`/wechat/serve` 回调还会领取、激活和删除用户卡；当前缺少可重放的幂等 outbox、回调验签和事件去重记录，所以外部写入统一返回 HTTP 501，公开回调没有恢复。

`0083` / 内嵌 `migration_0090()` 新增 Worker 专用 `out_api_audit`。表只保存账户、方法、静态路由模板、读写类型、查询字段名、结果、耗时，以及资源/IP/User-Agent 的 HMAC-SHA256；不保存动态路径、资源 ID、查询值、请求体或响应体。数据库约束限制摘要格式、结果枚举和数值范围，Admin 只展示 16 位摘要前缀。`get_token`、`refresh_token` 和所有受保护接口使用 Durable Object 固定窗口限流；无效 token 在 JWT/PostgreSQL 前先过 IP 阈值，已认证调用再叠加账号阈值，首次越限返回 HTTP 429 与 `Retry-After`，持续洪泛不逐次放大审计写入。2026-08-14 已通过指定 Hyperdrive 在生产以 3 秒锁超时/20 秒语句超时创建空表并复核 14 列、7 约束、4 索引、0 行；再次 apply 为幂等无变更。扩展后的随机 `codex_out_hardening_*` schema 真实验证了 3/3 写 ACL、两类备注重放/双连接串行化/状态证据脱敏/故障回滚、平台退款范围，以及确认收货首调/重放、双连接单次结算、平台订单作用域、自提/平台配送/待处理退款中央门禁、状态证据脱敏和日志失败全事务回滚；审计截断及应用/数据库双重坏摘要拒绝也通过。首次扩展运行在事务外预读处暴露 Hyperdrive 不可靠保留连接级 `search_path`，请求在写入前以“订单不存在”退出；预读与竞争后复查改为显式短事务后重跑全部通过。结束后 schema 前缀 0，`public` 八表行摘要和相关序列不变，生产审计表仍 0 行，临时 Worker 删除后 URL 为 404。主 Worker 仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef` 100% 流量，未部署本批，因此真实 Durable Object RPC、真实 Out 账户和客户流量仍未 E2E。

旧 MySQL → PostgreSQL 的默认只读审计/计划、显式白名单复制、列映射/转换、检查点恢复、冲突记账和双端行级验证基础设施已经落地，但尚未连接隔离 MySQL/PostgreSQL 做真实计划、复制及金额/外键校验。旧库 201 张表已全部进入当前目标结构与迁移 manifest（含显式改名映射），201 张逻辑共享表全部表示源端列，外部 SQL 与 Worker 内嵌迁移的表、列和主键定义零漂移。静态覆盖不等于实时类型、NULL、金额、外键或业务语义已通过真实数据验证；12 张无稳定键表虽已接入重复行保真的全行多重集策略，但目标空表门禁、跨批恢复和 multiplicity 仍缺真实数据库演练，其他弱唯一键也需按真实分布复核，因此数据迁移仍未完成。

`0007`～`0077` 已随 85/85 内嵌迁移在生产 PostgreSQL 执行并完成独立复核；`0078` / 内嵌 `0085` 的核销码查询索引、`0082` / 内嵌 `0089` 的充值查询索引和 `0083` / 内嵌 `0090` 的 Out API 审计表也已单独在生产幂等执行并复核。PHP 源数据复制仍未开始，本轮新增代码和前端没有发布。生产结构已就绪不等于生产业务已迁移，当前仍不能全量切换生产流量。

## 可复核的规模代理

这些数字用于发现范围差距，不能直接换算为“完成百分比”：

| 代理指标 | PHP 旧仓库 | 新仓库 | 说明 |
|---|---:|---:|---|
| 路由语法出现次数 | 1,851 | 935 | 旧仓库 7 个路由文件中的 `Route::`；新仓库 `src/routes` 与 `app.ts` 的路由对象 HTTP 方法调用代理，含 v1、v2、admin、supplier、别名和内部端点 |
| Admin 页面组件 | 378 | 44 | 各自页面目录中的 `.vue` / `.nvue`；新增供应商提现审核/转账页、任务运维、付费会员、事业部管理、门店/店员/配送员运营页、素材中心、抽奖管理、公众号内容、渠道二维码、迁移运行历史、小程序直播、企业微信与公众号会员卡只读目录 |
| PC 页面组件 | 30 | 27 | 页面数接近不代表功能和接口契约已经等价 |
| Supplier 页面组件 | 41 | 10 | 新仓库已补登录、概览、商品列表、实物商品表单、订单、售后、财务、电子面单配置、打印机/打印内容和资料页面；营销、客服及特殊商品类型仍缺失 |
| UniApp 页面组件 | 250 | 48 | 各自页面目录中的 `.vue` / `.nvue`；新增抽奖主页面与中奖记录页 |
| MySQL / PostgreSQL 唯一表定义 | 201 | 217 | 解析旧安装 SQL 与全部外部迁移；201 张逻辑共享（含 4 组改名映射）、旧库独有表为 0、目标独有表为 16 |
| 共享表源列覆盖 | — | 201 / 201 | 静态 schema 已表示全部源列，缺口为 0；不等于实时类型、数据和业务语义检查通过 |
| PostgreSQL schema 声明 | — | 217 | 新仓库 `pgTable()` 语法出现次数；声明数不是旧表覆盖数 |
| SQL/Worker 目标表定义 | — | 217 / 217 | 外部迁移与 Worker 内嵌迁移的唯一表集合已经一致；其中 201 个 PHP 共有表、16 个 Worker 专用表 |

## 分域状态

| 业务域 | 状态 | 审计判断 |
|---|---|---|
| 认证、配置、商品浏览 | 部分完成 | 核心接口、`print_document` 管理、收据打印 Queue/outbox/易联云/飞鹅云，以及电子面单一号通 HTTPS 签发、独立任务账本、UNKNOWN 人工处置和 Supplier 作用域配置均已实现；作用域由 token 固定，凭据不回显。小票与电子面单都已通过生产 PG 随机 schema E2E，但均未发布、未做真实打印/签发；生产电子面单两表和配置/secrets 仍缺失，旧分词服务、访问统计后台、源 MySQL 数据和真实流量契约比对也未完成 |
| 附件与对象存储 | 正式 R2 已建立，应用主链待发布 | 四张旧表已进入 manifest；新图片使用私有 R2、魔数/MIME/大小校验、短期签名读取、作用域元数据和 Queue 幂等清理。供应商资质与 Admin 素材中心已接入，旧存储密钥不回显且不作为运行时权威。正式 `cinashop-assets` 已完成 CLI 精确写读删和临时 Worker binding 写入验证，清理后为 0 对象/0 B；主 Worker 尚未发布 binding，真实应用上传/签名读取、旧附件对象搬迁、视频/分片/在线图片/扫码上传仍未完成 |
| 商品编辑元数据与组合配置 | 部分完成；卡密运营、告警、受控导出与交付主链已通过生产 PG 隔离 E2E | 已保留多态分类、单位、SKU 规则、参数模板、虚拟卡密和系统组合配置；Admin/Supplier 元数据接口已恢复并做租户隔离。卡密运营已支持安全脱敏查看、状态/SKU 筛选、游标分页、PHP/新格式/仅密码批量导入、精确库存增量、库存风险告警、固定内容互斥和 60 秒一次性受控导出；支付 outbox 已支持一次性卡和共享密钥原子交付。仍缺旧卡库存真实复制、真实运营账号和真实付款通知/客户验收及发布 |
| 购物车、下单、订单操作 | 部分完成；生产 PG 隔离并发已通过 | 已补并发认领、SKU 归属、商品/SKU 库存守卫、事务内同键 advisory lock 与锁内幂等复查、取消补偿；生产 PostgreSQL 隔离场景已证明同购物车双 key 单赢家、并发同 key 两请求返回同一订单、不同购物车最后 1 件库存不超卖，秒杀最后名额单赢家，以及秒杀/砍价/拼团取消完整恢复。取消状态失败全回滚、双取消只恢复一次，支付/取消竞争严格单赢家。下单保留经营主体快照，混合平台/多 Supplier 购物车可先生成支付根单，再由支付 outbox 自动生成履约子单；真实客户地址/运费/券/积分/表单组合、历史数据和真实支付链路仍需 E2E |
| 余额支付 | 部分完成；生产 PG 隔离资金并发已通过 | 余额入口先锁订单、在锁内复查归属/状态/拼团，再以整数分条件扣款，把账单、`paid=0→1`、发票和 outbox 原子提交。生产 PostgreSQL 隔离场景已证明并发同单只扣一次、余额不足零副作用、outbox 失败资金/账单/付款全回滚、支付/取消单赢家和 0 元单一致性；外部回调也已证明并发只产生一次状态转换和一条事件。券核销、支付次数和状态日志可重试；真实用户余额、Queue 消费、自动分单、退款返余额及商户回调仍未 E2E |
| 付费会员 | 代码面基本完成；两组生产 PG 隔离 E2E 已通过，尚未发布 | PHP 6 条用户会员路由和 16/16 条 Admin 路由均已恢复；包含会员首页/券/期限、服务端定价建单、免费领取、余额/微信/支付宝编排、商品单/会员单回调分流、卡密兑换和 Admin H5/小程序二维码。卡认领、余额扣款、会员状态、订单、账单与状态证据均为短事务并具并发/幂等门禁。生产 Hyperdrive 已分别验证 Admin 发卡运营与用户购买支付，两个场景结束后 `public` 行数/序列不变。剩余是旧会员数据复制、真实商户验签回调/真实用户验收和部署发布，而不是已知路由缺口 |
| 微信支付 | 部分完成；代码门禁与生产 PG 隔离回调已通过 | 已补 V3 请求/响应/回调强制验签、退款申请/查询/通知和主动对账；JSAPI `openid` 改为按登录 UID/客户端类型服务端解析，数据库开关、HTTPS 回调、商户号/证书和当前 Worker secrets 必须同时就绪才会开放。生产当前开关关闭且无商户材料，未验证真实商户配置和线上回调 |
| 支付宝支付 | 部分完成；当前生产保持关闭 | 已补 RSA2 下单/退款签名、支付通知与退款响应验签、退款查询和金额校验；有效能力矩阵要求应用 ID、私钥、公钥和 HTTPS 通知/返回地址全部存在。生产当前开关关闭且缺少支付 secrets，未验证真实商户配置 |
| 统一收银台与充值 | 本地主链完成；充值生产 PG 隔离并发已通过，尚未发布 | 订单/会员/充值收银台以登录用户、订单状态/超时、服务端金额、积分和实际支付配置为权威；PC/UniApp 不再根据静态开关或发起结果宣告成功。已关闭 `cz... + yue` 可无凭据增加余额的高危迁移缺陷；充值只从独立入口发起微信支付，回调以金额、交易号、订单行锁和单条资金账保证只入账一次。生产 6 条历史充值中 1 条已付但无交易号，本轮未修改，仍须源库/渠道账单对账 |
| 优惠券、秒杀、拼团、砍价 | 部分完成；拼团状态机主链本地完成 | 商品券关系与领取证据结构已保留，新 Admin 保存/领券/支付后赠券会事务化双写；活动下单验证购物车、活动 ID、权威系统表单与库存。拼团改为未付款订单持久预占、支付事务激活成员、满员成团、超时失败退款、全额退款成员/团长重整，并阻止未成团发货；生产已发现 2 条旧孤儿团、2 个无效未付款引用和 1 个无活动 ID 历史拼团订单，尚未清理。两张无主键优惠券历史表仍需真实复制，拼团也缺真实支付、并发、Queue、核销及生产补偿 E2E |
| 固定/任选优惠套餐 | 购买与 Admin 运营代码面完成；两组生产 PG 隔离 E2E 已通过 | 固定全选、任选必选+至少两项、套餐 SKU 定价/基础 SKU 库存、完整选择购物车、`type=5` 订单、每单一次限额、免邮、取消和部分/全额退款补偿均由服务端执行；PC/UniApp 已接入。Admin 已恢复 PHP 五条路由、商品/标签选择、逐 SKU 定价、稳定编辑、定时启用、启停/软删、ACL 和响应式页面。生产相关表当前全空，仍缺源数据复制、`postage/system_form_id` 源结构核对、真实运营账号及客户支付/通知验收和发布 |
| 抽奖活动 | 主链本地完成 | 三张旧表与专用权益表、支付/评价/推广次数、积分/余额消耗、原子抽奖和奖品发放、实物领奖/Admin 发货、Admin 与 UniApp 页面已恢复。新建活动不开放微信红包和语义不明的等级奖；生产表迁移、真实 PostgreSQL/Hyperdrive 并发及历史 type 4/type 8 处置仍未完成 |
| 公众号内容、自动回复与渠道码 | Admin 管理/异步生成主链本地完成 | 九张旧表、预留/关键字回复、素材、图文、脱敏消息历史、渠道分类/目录/用户/统计和 Admin ACL 已恢复；图片/语音引用数据库素材，回复/渠道永久二维码只由 Queue 异步生成并可重试。完整扫码回调、用户/卡券事件写入和批量推送保持关闭，生产迁移、真实素材/二维码可达性与微信联调尚未完成 |
| 积分商城 | 主链本地完成；生产 PG 隔离资金/库存/退款已通过 | 当前写入统一使用 `store_order(type=4)`；积分加现金、运费、地址和自定义表单已接入统一购物车/结算/付款，服务端固化活动价、必付积分和三层库存快照。余额/第三方付款条件扣积分，取消与现金/纯积分退款按累计目标恢复；旧直兑只保留无需配送的零现金零运费兼容类型并写支付 outbox。仍缺真实客户、真机支付、源数据复制和发布 |
| 售后、退款、物流 | 部分完成；生产 PG 隔离退款并发已通过 | Supplier 整单/拆单发货、包裹列表、状态轨迹、退货同意/拒绝、余额退款、累计积分冲正、微信/支付宝原路退款状态机，以及订单/拆分子单/用户退货的真实运单查询已本地实现。退款完成先在订单锁内以整数分拒绝累计超额，第三方完成金额必须与渠道确认一致；生产 PostgreSQL 隔离场景已证明重复余额退款只返一次、故障全回滚、并发部分退款不超额且精确全额可收敛。物流查询恢复 PHP `logistics_type=2` 阿里云契约和 30 分钟 KV 缓存，仍缺真实用户资金/积分/佣金历史对账、真实商户/AppCode E2E、电子面单和完整承运商覆盖 |
| 门店、店员、核销与平台配送 | 状态机主链完成，生产 PG 隔离集成已通过 | 四张旧表、门店/店员/配送管理、自提下单、平台配送发单与核销码、当前 UID/订单范围鉴权、UniApp 店员/配送员扫码页、部分/全部核销、不可变记录、换码、售后竞态锁、收货/Cron/共享结算原语防绕过、统一结算和 Admin/客户页面已恢复；供应商 `send` 在实名作用域完成前服务端禁用。生产 PostgreSQL 隔离合成场景已证明部分/最终核销、配送越权、重复身份拒绝、未成团门禁、同码并发、售后/核销竞争和公共数据不变；真实身份/订单样本、真机扫码、门店商品/库存、供应商配送、通知/打印和支付后生产 E2E 仍缺失 |
| 企业微信 | 表结构与 Admin 只读目录完成 | 24 张 `work_*` 表、源唯一性、迁移 manifest、Admin ACL 和 PII 脱敏目录已恢复；6 张无稳定唯一键的关系表已使用重复行保真的全行多重集策略，但尚无真实数据库演练。同步、打标签、渠道码/入群方式变更、欢迎语、群发与朋友圈投递缺少幂等 outbox，统一返回 501；公开 Work 身份/客户群接口未恢复，生产迁移与企业微信联调未执行 |
| 订单评价 | 核心状态机本地完成 | 已补商品快照 UID/订单归属校验、收货与售后状态门禁、固定锁序、快照级幂等、全部非赠品评价后完成订单、真实自动评价、幂等点赞/取消点赞及 PHP 路由/字段兼容；`0019` 尚未在真实 PostgreSQL/Hyperdrive 执行，历史重复评价仍需迁移前审计 |
| Admin | 部分完成、长尾大量缺失 | 已覆盖核心商城、财务、事业部、供应商及门店/店员/配送运营页和权限门禁，但页面与后台路由仍只覆盖旧系统的一部分 |
| PC | 部分完成 | 页面代理数量接近，但没有逐路由、逐接口、逐交互验收 |
| UniApp | 大量缺失 | 长尾页面和平台分支明显不足 |
| Supplier | 实物商品与经营核心切片、虚拟卡密库存本地完成 | 已补独立鉴权/租户隔离、资料、概览、实物商品分类/创建/编辑/SKU/库存审计/回收/批量上下架、虚拟卡密脱敏库存/批量导入/风险告警/一次性受控导出、支付后自动分单、订单、整单/拆单发货与包裹视图、售后、结算流水、提现、打印机/打印内容安全管理、Admin 审核及第三方原路退款状态机；卡密跨租户拒绝、并发导入和导出票据绑定已通过生产 Hyperdrive 隔离 E2E。尚未迁移生产账号/旧卡库存，真实物流 AppCode、出纸、电子面单、自动出款、营销/客服和真实付款通知验收仍缺失 |
| 事业部 / 代理商 / 员工 | 结算与管理面本地完成 | 已补层级角色 CRUD、管理员事业部作用域、代理申请审核、员工绑定、邀请小程序码、订单/统计/趋势/排行页面和 API，以及差额佣金快照、入账与累计退款冲正；仍缺真实小程序/数据库联调与生产迁移 |
| 客服 / Out / ERP | 客服实时核心、并发安全转接、认证私有图片、商品与订单/售后管理上下文、退款决策、独立工作台及 Out 写入切片已分别通过生产 PG/R2 隔离和浏览器验证；整体仍为部分恢复 | 客服已精确恢复 48/63 条 PHP HTTP 合同，另有 2 条 PHP 坏合同带证据退役；专用 token、每主体 hibernating WebSocket、双向持久化/未读/在线状态、每客服 100 次/日私有 R2 上传、双方图片消息、已购/浏览/热销/商品详情、客户订单/订单详情/售后详情/按客服分配售后列表、未支付改价、两类备注、退款表单、退货同意和资金退款、UniApp 用户端和独立 Vue Kefu 工作台均已实现。生产 Hyperdrive 隔离覆盖身份/转接、商品、订单读取/管理、履约、媒体和客服退款，验证标签、回滚、幂等、权限迁移、并发、脱敏、精确金额、备注审计、附件 owner、R2 补偿、退款金额绑定、单次入账、历史部分退款拒绝和转接撤权；生产已幂等应用客服相关索引与转接账本。但生产客服账号/会话/话术、商品描述/访问/分类关系均为空，旧图片对象尚未复制，剩余可执行缺口为扫码/微信 4、游客 8、面单模板 1。Out 已恢复独立 token/ACL、14 条只读及 6 条幂等写接口；生产 Out 账户/目录仍为 0。ERP 只读开关存在，写入/回调的签名、重放和补偿合同仍不完整；主 Worker和 Kefu 前端未发布。 |
| 安装、升级、数据迁移 | 全部源表静态结构完成、真实迁移未完成 | 已有默认只读 schema 审计/计划、显式 apply 门禁、201 表 manifest、显式源表/目标表与源列/目标列映射和转换、由整数与文本分量组成的单列/复合键 keyset 分批、12 张无键表的全行多重集分批、数据库检查点、advisory lock、冲突记账、实际写入目标自增列的序列同步、源重复键统计和双端一致性快照行级验证；201 张逻辑共享表静态源列缺口已清零，但尚未在隔离数据库完成真实复制/恢复/验证演练，其他弱唯一键仍需真实分布审计 |
| Cloudflare 生产运行 | 部分验证 | 加固后的 Worker、H5 和 Admin 已发布；Hyperdrive 读取、安全门禁以及随机临时 schema 内的建单幂等/库存/活动补偿、核销、退款、外部支付/余额资金/取消并发写入已远端验证。主 Worker 本批未部署，`public` 真实客户建单与真实支付仍未验证 |

## 本轮已修复的高风险问题

- 运维迁移/种子/调试端点改为 POST，并增加“调试环境 + `X-Operations-Token`”双重门禁；移除硬编码重置管理员密码的入口。
- 数据库迁移不再写入可预测的默认管理员密码；仅在提供不少于 12 位的 `INITIAL_ADMIN_PASSWORD` secret 且账号不存在时首次创建。
- 订单事务原子认领购物车，防止不同幂等 key 对同一购物车重复扣库存；同一用户/幂等 key 在事务内取得 advisory lock 后复查订单，并发重试返回第一次创建的订单而不是唯一约束异常；校验 SKU 必须属于购物车商品。生产 Hyperdrive 隔离场景已验证双 key 单赢家、同 key 双成功同订单和失败事务购物车回滚。
- 活动库存按购买数量扣减，并修复砍价库存更新缺少活动 ID 条件的问题。
- 下单时占用优惠券；取消未支付订单时先锁订单行，在同一事务内恢复 SKU、商品、活动库存、购物车、积分和优惠券，并写入取消状态证据；日志失败不再留下已补偿但无审计记录的半提交状态。
- 外部支付成功先锁订单行并使用 `paid=0` 条件更新，把支付状态、发票状态与不可变 outbox 一次提交，避免并发回调重复提交支付状态、Supplier 待结算流水和 outbox。
- 支付入账同时要求订单仍为待支付且未删除；生产 PostgreSQL 双连接已证明支付/取消严格单赢家，避免“取消已回库存”后第三方回调把订单重新标记为已支付。
- 余额支付不再事务外检查后先扣资金，也不再忽略 0 元单状态提交结果；统一入口先锁订单并复查拼团/取消状态，再锁用户资金，把余额、账单、付款、发票和 outbox 原子提交。生产 Hyperdrive 隔离场景已验证并发只扣一次、余额不足和 outbox 故障零副作用，以及取消获胜时用户资金完全不动。
- 拼团不再在创建未付款订单时写公开参与者或提前成团；团长行锁把公开成员与未付款订单预占统一计数，余额支付和外部支付回调只在 `paid=0→1` 事务内激活成员。旧 Worker 的业务订单号/幂等 key/数据库 ID 三种关联可被兼容认领，已扣款回调遇到失效团会安全开新团而不是把资金卡在未付款状态。
- 定时维护新增未付款自动取消与拼团超时两个 Queue 根任务；取消复用库存、活动、购物车、积分和优惠券补偿，超时复用现有原路退款及主动对账。全额退款会同步重算成员，团长退出时提升最早有效成员并重写其他成员及未付款订单的 `pink_id`；Admin 和 Supplier 整单/拆单发货均要求拼团成功。
- 支付宝下单使用 RSA2 签名；异步通知必须验签，并校验 AppID、可选 SellerID、订单号和金额。
- 客服 WebSocket 不再信任查询参数 UID 或 Admin 身份；用户/客服分别使用专用 token 域和 `user:<uid>`/`kefu:<uid>` DO。原始 JWT 在网关剥离，hibernation attachment 保存最小会话状态，消息经短事务先落 Hyperdrive 再跨 DO 投递；公开内部 HTTP 回调和 `INTERNAL_CHAT_TOKEN` 代码依赖已移除。UniApp 不再固定 `to_uid=0` 或 REST+WS 双写。
- 删除没有消费者实现却会被直接 ack 的历史订单消息生产逻辑；新增的 `order.paid` 消息只在数据库 outbox 落盘后投递，并由明确的可重试消费者处理，其他历史消息继续显式告警。
- Worker 绑定类型改由 Wrangler 生成，兼容日期更新到审计日。
- 抽奖后台中奖记录只选择 UID、昵称、姓名、手机号和头像，不再把完整用户行放入响应；活动启用/保存使用事务级目录锁，避免同一抽奖因子并发出现多个启用活动；邀请奖励修正 PHP 临界判断少发最后一次的问题，并在用户已达上限时不再报告成功。
- 公众号回复保存使用事务级目录锁并拒绝创建新的歧义关键字；图片/语音回复及渠道码必须引用已迁移且类型匹配的素材，消息历史中的 OpenID/用户标识在 API 层脱敏。回复/渠道二维码只进入 Queue，由消费者有界读取微信响应；HTTP 请求和数据库事务不执行同步外部 fanout。运行时仍不主动抓取/上传微信素材，不执行扫码回调、卡券/用户事件写入或批量推送。
- Supplier 身份只从已验证 token 派生，禁止请求参数指定租户；商品强制限定 `type=2 + relation_id=supplierId`，订单强制限定 `supplier_id=supplierId`。
- Supplier 作用域配置不再照搬 PHP 的 `store_id`/参数数量漂移；所有读写固定为认证令牌派生的 `type=2 + relation_id=supplierId`，键名和长度显式白名单，写入由 advisory lock 串行化，历史同键重复时安全拒绝。API Key/UKEY 永不回显，空白密钥提交只保持原值。
- 旧 `print_document` Supplier 详情、保存、启停、删除及打印内容操作只按记录 `id`，可跨 Supplier 甚至平台越权，且两个第三方打印密钥直接回显。新服务的每个读写均叠加认证身份派生的 `supplier_id` 与 `is_del`，平台固定为 0，密钥只返回配置状态；请求体不能注入租户，启用前还必须通过凭据与模板完整性校验。
- Supplier 实物商品写入采用事务级 advisory lock；分类、详情、SKU、库存调整、回收和上下架均再次校验租户。保存会强制 `product_type=0`、`is_verify=0`、`is_show=0`，并同步禁用购物车，避免未审核改动直接销售。
- Supplier SKU 使用 Web Crypto 生成 8 位不可预测标识，并在全局事务锁内查询碰撞后写入；编辑按规范化规格组合保留现有 SKU 标识和销量。多规格输入必须完整覆盖最多 3 个维度、200 个 SKU 的笛卡尔积，价格/结算价/佣金使用精确两位小数字符串校验。旧 MySQL 仅有非唯一索引，历史重复值仍需在正式数据迁移时单独审计，不能静默加唯一约束破坏既有购物车引用。
- Supplier 上架要求审核通过且价格大于零，并同步商品分类关系和购物车状态；库存入/出库禁止负库存并写入 `store_product_stock_record` 审计。当前明确拒绝创建卡密、优惠券、虚拟商品和次卡，直至其履约状态机完成迁移。
- Supplier 登录验证 `system_admin.admin_type=4` 与 `relation_id ↔ system_supplier.admin_id` 双向关系；资料改密要求至少 12 位并在事务内同步管理员账号。
- 平台 Admin 登录和存量 token 校验均强制 `admin_type=1`，供应商账号不能再跨域换取或继续使用平台 Admin token。
- Supplier 订单发货、订单轨迹、确认收货、售后详情和资金查询全部同时校验资源 `supplier_id` 与当前 token 租户，旧 PHP 中详情/备注可能越权的路径未照搬。
- Supplier 拆单发货兼容 PHP 的 `split_cart_info`、`split_delivery`、`split_order` 契约：首次部分发货生成已发货/待发货子单并把主单标为 `pid=-1`，后续从唯一待发货子单继续拆分，最后一批整体发出。事务先按逻辑主订单取得与收货/退款共用的 transaction advisory lock，再按固定顺序 `FOR UPDATE` 锁定订单和商品快照；重复 cart_id、超量、进行中售后、多个待发货子单均拒绝。订单金额按商品价值权重分配，舍入余数留在待发货子单，主单审计节点从经营统计和活动订单列表排除，避免金额重复。
- 下单时把商品 `type/relation_id` 保存在订单商品快照；单一经营主体直接归属根单，混合平台/多 Supplier 订单标记为待分配。支付 outbox 在同一事务内先取得订单 advisory lock，再按稳定顺序锁根单、既有子单、商品快照和有效 Supplier：失效/关闭 Supplier 回落平台组，金额与积分按商品权重精确分配并守恒，所有履约子单完成后才将根单标记 `pid=-1`。Supplier 财务流水只为验证后的履约子单生成，避免支付前后 Supplier 状态变化造成错账；根审计单从用户列表、收货、退款、后台发货和经营统计排除。
- 订单评价不再只凭 `unique` 写入：先以 `uid + unique` 限定商品快照，再按“订单 advisory lock → 订单行 → 商品快照 ID”固定顺序加锁，验证已支付、已收货、非审计根单、非待分配和非售后处理中状态。评价 `oid` 恢复为 PHP 的订单 ID，并新增 `order_cart_info_id` 稳定幂等键；全部非赠品快照评价完成后才原子更新 `status=3` 和 `check_order_over` 日志。定时自动评价改为真实补写缺失评价，点赞/取消点赞使用 `user_relation` 唯一关系与计数同事务更新。
- 删除按付款时间生成深圳转运中心、目的地营业点等虚构节点的物流实现。订单和退款查询均以 `uid` 限定资源，直接读取订单/拆分子单/退款记录的真实运单；恢复 PHP `order/express/:uni/[:type]`、`logistics_type=2` 与阿里云响应契约，AppCode 优先从 Worker secret 注入。外部查询固定 HTTPS 主机、6 秒超时、256 KiB 流式响应上限，未签收缓存 30 分钟、签收缓存 30 天；拆分包裹每请求只读一次配置并限 5 路并发，第三方失败绝不伪造轨迹。
- 用户申请售后时写入 `supplier_id`，修复 Supplier 售后列表无法可靠隔离的问题；余额退款、库存/积分补偿与供应商负向流水在同一数据库事务中完成。退款完成在任何副作用前以整数分校验历史累计与当前金额不超过实付，并把第三方本地金额绑定到渠道成功金额；生产 PG 双连接与故障触发器已证明幂等、超额业务拒绝和全事务回滚。
- 微信/支付宝原路退款使用独立渠道状态表和稳定商户退款号；网络结果未知时先查询再复用原号重试，微信受理态等待验签回调/定时查询，只有渠道确认 `SUCCESS` 后才原子完成订单、库存、积分和供应商流水。
- 微信支付成功响应、支付回调和退款回调均强制平台公钥验签，并校验商户、订单和整数分金额；支付宝退款响应按原始 JSON 节点验签，`code=10000` 且 `fund_change!=Y` 时继续查询，不误报成功。
- 支付成功生成幂等待结算流水，确认收货后转可提现；提现使用 PostgreSQL 事务级 advisory lock 和整数分校验，防止并发超提与浮点金额误差。
- 订单 `paid=0→1`、Supplier 待结算流水与 `order.paid` outbox 在同一 PostgreSQL 事务提交；Queue 至少一次消费、过期租约补投、指数退避、8 次失败转 `DEAD` 以及 Admin 人工重放共同覆盖 Worker 中断和投递结果未知窗口。券核销、支付次数和状态日志在处理事务中一起提交，重复消息不会重复处理。
- 定时入口不再直接连接 PostgreSQL 或固定扫描前 100 单，而是一次投递支付 outbox、未付款取消、拼团超时、自动收货、自动评价、直播间状态、直播商品状态和退款对账八个 Queue 根任务。订单任务按主键单调游标每页 80 单推进，拼团/支付 outbox/退款对账各按 20 条持续排空；候选处理前重验资格。直播同步只读取固定微信接口并在本地 advisory lock 下幂等更新；退款对账在调用第三方前使用 `FOR UPDATE SKIP LOCKED` 原子认领并更新时间租约，所有消息逐条 ack/指数退避。
- 引入官方 `@cloudflare/vitest-pool-workers` 0.21.2、Wrangler 4.122.0 与 Vitest 4.1.10，新增完全本地的 `wrangler.test.toml`，测试代码覆盖 Cron 根任务、Queue legacy ack、数据库失败时 30 秒 retry、KV 隔离绑定、SequenceDO 并发唯一性及实例回收恢复；测试配置没有生产 Queue consumer，也不引用生产 Hyperdrive/KV ID。当前本机 workerd 启动缺陷的边界见验证表，不能把类型检查通过误报为 runtime 断言通过。
- 修复 `SequenceDO` 只在内存保存雪花序列的问题：改用 SQLite 单例行同步读写，实例回收后继续序列；移除每次 RPC 使用启动期 `blockConcurrencyWhile` 的误用，序列耗尽或时钟回拨时推进逻辑毫秒且不在分配临界区 yield。
- 纠正旧 Worker 在支付 outbox 内立即按固定 10%/5% 入账的时机与规则偏差：现在下单时按旧版配置、指定 SKU、分销层级及售价/实付/利润口径快照两级佣金。统一配置服务同时兼容 PHP `system_config` 的 JSON 标量值（如 `"7"`），但保留数组/对象 JSON 字符串契约，自动收货/评价也不再因引号失效。
- 用户收货、Supplier 确认和定时自动收货改用同一事务路径：订单级 advisory lock 将收货与多个退款单的完成串行化；条件更新订单后，结算 Supplier 与佣金，并重新检查分销总开关、账号状态、`spread_open` 和当前推广资格。已完成的部分退款在收货同一事务内立即对冲，全额退款订单不再进入收货结算；佣金部分唯一索引保证重复收货不会重复入账。
- 部分/全额退款按累计退款比例只扣当次退佣增量；佣金汇总与提现使用整数分并排除冻结佣金，提现记录、账户扣减和流水在单一事务完成。这些路径仍缺真实 PostgreSQL 集成与历史金额对账。
- 下单补齐商品 `give_integral × 数量` 的整数积分快照；确认收货按 PHP BCMath 精度计算商品积分、实付返积分、付费会员 `member_right.integral` 倍率和经验，账单保留旧 `category/type` 并以 `event_key` 防重复入账。
- 收货经验到账后同步检测 `system_user_level.exp_num`，写入缺失或重新激活的 `user_level` 历史并更新用户当前等级。退款不回退经验，与旧 PHP 一致；赠送积分和抵扣积分按累计退款目标只处理本次增量，兼容旧 Worker 按退款单号写入的抵扣积分流水。
- 买家和两级佣金接收人在收货/退款事务中统一按 uid 升序加锁，避免跨订单中买家与推荐人角色交叉造成锁顺序反转；配置和会员权益读取留在事务外，缩短 Hyperdrive/PostgreSQL 临界区。
- 还原 `DivisionServices::divisionBrokerage`：按买家是普通用户/事业部/代理商/员工、角色有效期、是否自购返佣以及推荐人与角色是否重叠，重新分配普通一级/二级比例和三级差额；指定 SKU 固定佣金保持不参与事业部分成。
- 订单新增事业部、代理商、员工接收人与金额快照；收货允许同一用户按不同佣金类型分别幂等入账，不再用 uid 去重而误吞重叠角色收益。退款流水新增 `source_type`，按每个原佣金类型计算累计目标，修复旧 PHP 退款只筛 `spread_uid/spread_two_uid` 而漏退事业部角色佣金的问题。
- 收货和退款的统一升序用户锁扩展到六类潜在接收人；历史没有 `source_type` 的退款流水按原收入顺序兼容归属，新数据由部分唯一索引和来源字段共同防止重复入账/重复退佣。
- Admin token 注入数据库中的 `system_admin.division_id`，事业部管理员的角色、申请、订单和报表查询由服务端强制加作用域，拒绝请求参数越权；超级管理员继续拥有全局视图。
- 角色保存、员工比例修改、级联解除和申请审核按 uid 升序锁行，并验证父角色状态、比例与到期时间；申请手机号必须等于登录用户已绑定手机号，避免在未迁移短信验证码缓存时静默弱化身份校验。
- 旧版“GET 删除员工”改为 DELETE/POST，拒绝保留状态变更 GET；经营报表改用真实存在的订单角色快照字段，并修复 PHP 局部事业部排行错误按 `division_id=agent_uid` 汇总的问题。
- 代理商邀请小程序码改为 10 分钟 HMAC 签名图片 URL，生成和每次取图都重新校验代理商状态/到期时间；微信 access token 缓存遇到失效码只刷新重试一次，图片限制 1 MiB 并以私有缓存响应。二维码 `scene` 直接使用代理商 uid，兼容员工绑定接口的 `agent_id` / `agent_code`，不复制旧版临时二维码表依赖。
- 后台鉴权从登录返回的 `unique_auth=["*"]` 占位升级为 42 个服务端权限域；两个 Admin 路由面超过 200 个受保护端点均由中间件按 GET/HEAD 查看、写请求管理权限执行，未知管理路由默认拒绝，只有 `level=0` 超级管理员显式跳过。付费会员域单独提供 view/manage，旧 PHP 的 GET 状态写接口也必须具备 manage。
- 旧数字菜单规则仅从 `system_menus(type=1, auth_type=2)` 解析；新角色保存使用稳定权限 key，管理权限自动包含查看权限。受限管理员不能创建/修改/删除或委派超出自身权限的角色，包含旧数字规则的迁移与委派只允许超级管理员执行，避免通过角色管理自提权。

## 旧 MySQL 数据迁移基础设施

- 新增 `data:schema-audit`、`data:plan` 与 `data:copy`。`schema-audit` 只解析仓库 SQL，不连接数据库；`plan` 只读连接 MySQL/PostgreSQL，检查实时表、列、主键、类型、默认值和源端行数；`copy` 只有同时提供 `--apply`、非空 `--tables` 白名单、目标数据库名确认，且远端目标另行显式放行时才会写入。
- 连接字符串只允许通过 `SOURCE_MYSQL_URL` / `TARGET_POSTGRES_URL` 环境变量传入；命令行中出现 URL、password、token 或 secret 参数会在连接前拒绝。源 MySQL 会设置只读会话，PostgreSQL 使用单连接且关闭 prepared statements，以适配事务池/Hyperdrive 场景。
- 201 张源表全部进入有序 manifest，静态源列缺口已清零；迁移器显式支持不同源/目标表名，并拒绝同一源表或目标表的重复分配。`express → express_company`、`article → system_article`、`diy → system_dise` 与 `template_message → notification_template` 已进入同一套计划、复制、检查点与验证链路。企业微信 24 表、公众号会员卡 3 表、对外 API 账户/文档、小程序直播间/商品/主播/关系、旧批处理任务头/逐项结果/定时目录、公众号内容、永久渠道码、抽奖、页面链接及既有业务表继续保留各自真实引用语义；关系/聚合表没有旧唯一约束时不静默增加约束或删除历史重复行。
- `store_order_economize`、`store_order_invoice`、`store_order_promotions` 与 `store_order_writeoff` 保留订单解释和核销证据；补开发票在事务级 advisory lock 内复制用户发票模板快照，支付/退款与发票状态在同一订单事务联动。`store_promotions` 与辅助范围表使促销分摊可关联规则，`store_activity` 与商品关系使秒杀 `activity_id` 可追溯，但完整促销计算尚未恢复。
- `store_discounts`/`store_discounts_products` 恢复固定套餐与任选套餐的公开读取，关联商品和两类 SKU 均按批查询，金额以整数分计算；`store_delivery_order` 独立于拆单包裹，保留达达/UU 单号、位置、费用、完成码和状态轨迹。`capital_flow` 是平台外部现金收支，`user_bill` 是用户余额/积分内部账，`supplier_flowing_water` 是供应商账，三者不合并；当前 PHP 无模型/服务引用的 `store_finance_flow` 作为休眠门店历史账独立迁移。
- `store_integral_order` 与 `store_integral_order_status` 只保存统一订单改造前的独立积分订单历史；当前兼容路由读取和新兑换写入均使用 `store_order(type=4)`，不恢复第二套订单状态机。直兑已改为事务内锁用户、复核累计限购并原子扣减积分/活动/SKU/商品库存，同时写订单商品快照、状态和积分账；积分加现金或运费订单仍必须进入尚待补齐的统一购物车下单/支付流程。
- `category` 不与商品分类合并：它继续承载用户/商品标签分类、参数模板等多态语义；`store_product_rule` 不与每商品 SKU 快照合并，`system_group`/`system_group_data` 也不压入 `system_config`。单位、规则和参数模板写入使用事务级 advisory lock 防同作用域并发重名，参数行批量读取避免 N+1；Supplier 所有读取均限制为平台公共项和自身项。`store_product_virtual` 的卡号/密码不通过这些兼容接口暴露，运行时交付仍保持禁用。
- `user_group` 保留 `user.group_id` 的后台分群目录，删除时锁定分组并拒绝仍被活跃用户引用的记录；`user_label_relation` 保留平台/租户作用域和源端历史重复行，不凭空增加唯一约束。新的分组和标签批量写入在事务内锁定稳定排序的用户行，校验活跃平台标签，并清理标签时先删除关联后删除标签本身。
- `system_config_tab` 保留 `system_config.config_tab_id` 的层级导航，不与配置值合并；`system_form` 是商品和活动引用的表单定义，`system_form_data` 是订单采集历史，二者不与 `store_order.custom_form` 快照合并。Admin 恢复配置目录与表单管理/采集历史读取，Supplier 只读取启用表单；新表单 JSON 有大小和结构门禁，历史无效 JSON 原文仍可迁移。普通、秒杀、砍价、拼团和纯积分直兑已在服务端按商品/活动权威模板校验用户值，并在订单事务中同时保存不可篡改模板快照与 PHP 兼容采集记录；生产当前没有任何表单定义、引用或历史采集数据，所以仍缺真实数据 E2E，且本批代码尚未发布。
- `0059_store_newcomer.sql` 保留新人专享商品目录；活动 SKU 继续使用旧 `store_product_attr_value(type=7, product_id=store_newcomer.id)` 语义，展示和下单采用活动价、基础 SKU 实时库存。购物车与下单强制活动 ID、一件限购和类型一致；创建订单的同一事务先锁用户，再复核配置、活动、SKU、历史已支付新人单并原子消费 `is_newcomer` 资格，与 PHP 在创建订单时消费且取消不恢复的语义一致。已恢复新人列表、详情、信息和礼包四条前台路由，并在密码/微信注册时按开关初始化标记。普通订单首单优惠现同时要求 `newcomer_status + first_order_status`、`is_first_order=0`、仍在新人时限且不存在 `type<>7` 已支付历史；按 PHP BCMath 截断规则从商品实价计算并受金额上限约束，优先且排斥优惠券，再进行积分抵扣。不同 key 并发建单在事务内锁用户并复核，只有实际优惠大于 0 才把 `is_first_order` 原子置 1；取消不恢复，后续库存/快照失败则资格随事务回滚。订单主表与商品快照都固化首单抵扣，拆单可继续按快照分摊。认证只读 quote 让 PC/UniApp 以服务端普通购物车、资格和金额为准展示首单优惠，并在互斥时停用优惠券提交。Admin 已恢复 16 项注册/新人配置白名单、协议、商品和逐 SKU 活动价写入，注册时的积分、整元余额和优惠券赠礼也已纳入用户创建事务；生产 Hyperdrive 隔离场景已验证配置/目录替换、并发 exactly-once 和强制故障回滚。生产 16 项配置目前全部缺失，目录与历史赠礼证据均为 0，源数据尚未复制，真实微信/用户验收和正式发布尚未完成，因此不能把整个新人业务标为生产完成。
- `0060_legacy_db_cache.sql` 原样保留 PHP 数据库缓存的 `key/result/expire_time/add_time`。`newcomer_agreement`、五类通用协议、`kf_adv`、`open_adv`、`uni_app_url` 回退和管理员商品草稿均由该表按旧过期语义读取；非法历史 JSON 安全降级，前台读取不删除过期行，批量设置使用有界 JSON、确定性键顺序和短事务 UPSERT。迁移器为这一真实表新增单列文本键支持：MySQL 以二进制顺序做 keyset，文本游标存入既有 JSONB 检查点。旧公开扫码上传缓存因弱时间戳令牌不再恢复，改由认证私有 R2 上传承担。
- `0061_paid_membership_core.sql` 原样保留会员卡批次、复合主键会员卡、会员套餐、会员订单和无主键状态历史；没有为旧 `card_number` 或 `order_id` 凭空增加唯一约束，也没有为 `other_order_status` 增加主键。卡密兑换使用恒时摘要比较、固定锁序和条件认领，写入 `card_redeem` 状态证据；卡密字段不进入前台返回。`other_order_status` 通过全行多重集游标保留完全相同的重复状态行，初次复制要求空目标表。
- `0062_coupon_relationship_evidence.sql` 原样保留三列领取证据和两列商品适用关系，不增加主键或唯一约束。Admin 商品券保存锁定模板行后在同一事务重建关系；普通领券与支付后赠券在已有发券事务追加证据。下单以关系行校验模板内编码范围，发现不一致就拒绝。两张无键表使用全行多重集策略而不是空键阻断或静默去重。
- `0063_store_fulfillment_identity.sql` 原样保留 `system_store`、`system_store_staff`、`delivery_service` 与 `store_user`，不增加源端不存在的唯一约束或外键；四表均以 `id` 进入 manifest。运行时对新有效店员、配送员和门店用户关系使用 advisory lock 串行校验，既阻止新的歧义身份，又不阻断历史重复行无损导入。
- `0064_store_legacy_auxiliary.sql` 原样保留 `store_config`、`store_branch_product`、`store_branch_product_attr_value` 与 `store_extract`，四表均以 `id` 进入 manifest。源码证明分店商品两表与门店提现表当前无活动运行链路，因此仅迁移历史；`store_config` 恢复供应商配置读写，并纠正 PHP 写入不存在 `store_id`、调用参数与读取作用域不一致的版本漂移。
- `0065_print_documents.sql` 原样保留已被取代的单打印机历史配置 `supplier_ticket_print` 和现行打印权威 `print_document`，均以 `id` 进入 manifest；不增加源端不存在的唯一约束或外键。运行时只恢复严格租户隔离、密钥遮蔽和模板校验的管理能力，不调用易联云或飞鹅云。
- `0066_supplier_onboarding.sql` 原样保留供应商入驻 `system_user_apply` 和短信审计 `sms_record`，均以 `id` 进入 manifest；不增加源端不存在的唯一约束或外键。运行时修复旧申请更新 IDOR 与可预测默认密码，使用禁用账号加短信激活，而不是兼容缺陷。
- `0067_attachment_storage.sql` 原样保留附件、附件分类、PHP 文件完整性历史和旧对象存储配置四表，并只增加不改变数据语义的运行时普通索引。图片运行时固定使用生成的私有 R2 binding；旧 provider access key 不进入运行时配置或响应。
- `0068_superseded_product_relations.sql` 原样保留三张已被 `store_product_relation` 取代的商品辅助关系表；不恢复旧 Job、双写或前端入口。目标分类关系写入改为与 PHP 一致的即时 `pid`，分类移动逐分类同步父 ID。
- 安装 SQL 是静态复制契约；同时记录版本漂移：折扣套餐 PHP 服务写入安装表中不存在的 `postage`/`system_form_id`，同城配送服务写入不存在的 `info`。本轮没有凭空添加这些列，真实源库计划必须据 `information_schema` 再决定版本列映射。
- 计划器仍会拒绝静默丢列、目标必填列缺值、类型不兼容、缺失/不受支持的迁移策略及目标冲突键无唯一约束，并把 MySQL `enum`/`set` 作为有界文本传输而不是误判为不支持类型。迁移键支持由整数与文本分量组成的单列或复合元组，且要求源目标类型一致；`member_right` 按目标真实主键 `id` 迁移，`store_product_description`、`member_card`、`queue_list` 与 `live_room` 分别按 `(product_id,type)`、`(id,card_batch_id)`、`(id,type,status)` 与 `(id,phone)` 复合唯一键迁移。没有稳定源键的 12 张表是 6 张企业微信关联表、`store_order_status`、`store_integral_order_status`、`other_order_status`、`store_coupon_issue_user`、`store_coupon_product` 与 `live_room_goods`；这些表不补主键，而是按全部映射列生成无碰撞、区分 NULL/空串/大小写的长度前缀十六进制游标，并按每个全行组的 multiplicity 原次数插入。201 张旧库源表已全部进入 manifest，源端独有表为 0。
- 有键表按单调单列/复合迁移键做 keyset 分批，不使用 OFFSET；整数分量按数值字典序，文本分量在 MySQL 以 `CAST(... AS BINARY)` 排序和续页。单列整数游标保存在 NUMERIC，复合或含文本的游标以字符串数组保存在 JSONB。无键多重集表同样不使用 OFFSET，游标保存“全行规范键 + 当前组已消费次数”，即使单个重复组大于 batch size 也能分事务恢复；初次复制必须面对空目标表，每批在 `EXCLUSIVE` 表锁内确认目标行数精确等于本 run 已提交插入数，预存或并发写入会安全中止。每批数据写入和 `data_migration_checkpoint` 更新在同一短事务中提交。目标端全局 advisory lock 防止同一迁移并发运行；有键表的 `ON CONFLICT DO NOTHING` 绝不覆盖已有生产行，任何冲突都会将运行标记为 `NEEDS_REVIEW`。完成后对本次实际写入的全部目标 serial/identity 列同步序列，因此复合迁移键中的 `member_card.id` 也会推进，再核对源行数与“插入 + 冲突”或多重集插入守恒。
- 新增默认只读 `data:verify`：要求同一个 `MIGRATION_RUN_ID` 和显式表白名单，在 MySQL/PostgreSQL 两端各自取得一致性只读快照，重新应用时间/JSON 转换；有键表按单列/复合迁移键全量比较所有映射列，无键表按全行值比较目标 multiplicity。它同时核对源/目标行数、目标额外行、检查点源行数、插入/冲突或多重集插入守恒及 run 终态；缺行、字段差异、重复次数差异、额外行、非完成检查点、历史冲突或 run 非完成态都会非零退出。报告只含稳定迁移键或不可逆的全行游标 SHA-256 摘要和差异列名，不输出源字段值。
- `0020_data_migration_control.sql` 与 Worker 内嵌 `migration_0027()` 逐字等价，记录运行、源库匿名指纹、可空单列/复合游标、目标表名和错误，不存凭据；源表改名不会改变稳定的目标检查点标识。`0022_composite_migration_cursor.sql` 与内嵌 `migration_0029()` 为既有控制表补 JSONB 游标列。单元测试已覆盖负主键首批、复合键相同前缀、复合键内目标自增列识别、首批提交后故障、检查点保留、恢复只复制剩余键以及冲突记账；序列同步先于终态检查点，崩溃后仍会重试。
- `0016_supplier_product_management.sql` 与 Worker 内嵌路径不再自动删除 `store_product_description` 重复行；唯一索引会在目标已有重复时显式失败，实时计划只报告源端重复组数/多余行数，由运维人员在另行归档或合并后重试，工具不会擅自选取“最长描述”。
- 所有复制/验证入口现在要求先完成实时行数、整数范围、源 NULL、转换后为 NULL 的空 JSON/零时间哨兵、显式数值字符串/Unix 秒转换和弱唯一键检查；`0023`～`0069` 继续覆盖既有领域，`0070`～`0077` 依次保留抽奖、公众号内容、永久渠道码、旧批处理/定时目录、小程序直播目录、对外 API 身份/目录、企业微信 24 表和公众号会员卡 3 表，并只恢复具备明确安全边界的运行链路。对应 Worker 内嵌迁移为 `migration_0030()`～`migration_0084()`，两条路径逐字等价；`0078` 与内嵌 `migration_0085()` 逐字等价，独立修复升级库缺失的核销码查询索引。上述批次使源列完整的逻辑共享表由 37 张增至全部 201 张，静态缺口归零。
- 仓库此前有 18 张表只存在于 Worker 内嵌迁移，导致文件系统从零执行时可能在建表前先执行 `ALTER`。`0006a_embedded_schema_parity.sql`、`0021_repository_schema_parity.sql` 与内嵌迁移已补齐路径漂移；在后续 DLQ、卡密导出和 Out API 审计表加入后，当前外部 SQL 与 Worker 两条独立路径均为 210 张唯一表，表集合、列定义和主键差异均为零，且测试拒绝任何先于建表的 `ALTER`。
- 当前没有可用的源 MySQL 连接与 MySQL/PostgreSQL 成对迁移凭据，因此尚未执行实时 `plan`、真实复制、进程中断恢复、行级 `verify`、金额/外键/抽样对账；生产 Hyperdrive 已执行原 85/85 schema 迁移及 `0078`～`0084` 定向升级，并完成多轮只读数据复核和随机 schema 集成场景，但 MySQL→PostgreSQL 复制工具尚未写入生产业务数据。本节只能证明迁移工具、生产目标结构和定向 PostgreSQL 状态机可运行，不能证明 PHP 源数据已经迁移。

## Supplier 本地迁移范围

- 后端新增 `/supplierapi` 独立路由、鉴权中间件、DAO、服务与控制器，覆盖登录/会话、供应商资料、经营指标和七日趋势、商品列表/详情/上下架、订单列表/详情/备注。
- 数据层新增 `system_supplier` PostgreSQL schema、`0007_supplier_core.sql` 和嵌入式 `migration_0014()`；两条迁移路径保持同一表结构，生产 schema 已执行，但供应商源数据尚未复制。
- 第二批新增订单履约字段、订单结算价快照、`supplier_flowing_water`、`supplier_transactions`、`supplier_extract` schema，配套 `0008_supplier_fulfillment_finance.sql` 与嵌入式 `migration_0015()`；生产 schema 已执行，历史订单正式迁移仍必须使用旧订单结算快照并做金额对账。
- 第二批后端覆盖快递/虚拟发货、订单轨迹、确认收货、售后列表/详情/备注/退货同意/拒绝/余额退款、财务概览/流水/账单、收款设置和提现申请。原自由填写姓名/电话的供应商同城配送没有实名身份、核销码和订单范围闭环，当前由服务端拒绝并从新建发货界面移除，历史 `send` 记录仍只读保留。
- 第三批新增 `store_order_refund_payment`、`0009_third_party_refund.sql` 与嵌入式 `migration_0016()`；微信/支付宝退款复用同一幂等号，120 秒请求租约防并发，5 分钟定时任务主动查询处理中/未知结果。生产 schema 已执行，但源数据复制、代码发布和真实商户配置尚未完成。
- 支付可靠性批次新增 `store_order_outbox`、`0010_payment_outbox.sql` 与嵌入式 `migration_0017()`；使用部分索引扫描待投递/过期租约，`FOR UPDATE SKIP LOCKED` 并发认领，Queue/DLQ 加速处理，5 分钟 scheduled 补偿，Admin 提供游标分页查询与显式重放 API。生产 schema 已执行，但代码未发布且未回填历史已支付订单，避免未对账前重复分佣。
- 通知可靠性批次以 `0084_order_notification_outbox.sql` / 内嵌 `migration_0091()` 扩展同一个 outbox，并为新站内信增加 nullable 精确事件键；生产 schema 与随机隔离验证已通过，但四类源通知模板均未复制，短信、微信/小程序渠道和主 Worker代码均未发布。
- 佣金结算批次新增 `agent_level`、订单推广/佣金快照字段、佣金冻结字段及幂等部分唯一索引，配套 `0011_order_brokerage_settlement.sql` 与嵌入式 `migration_0018()`。迁移只在缺失时补旧版默认分销配置，不覆盖现有值，不对历史订单计算或回填佣金；上线前必须单独对账。
- 收货奖励批次新增 `member_right`、`user_level`、账单 `event_key` 与奖励幂等部分唯一索引，配套 `0012_order_rewards.sql` 与嵌入式 `migration_0019()`。迁移只补缺失配置/权益，不覆盖旧值，也不为历史已收货订单补发积分或经验；上线前必须对账并决定历史处理策略。
- 事业部分佣批次为用户和订单补齐旧版层级/快照字段，为退佣流水新增 `source_type` 和查询索引，并增加三级角色收入部分唯一索引，配套 `0013_division_brokerage.sql` 与嵌入式 `migration_0020()`。约束以 `NOT VALID` 安全接入历史数据，新写入立即受约束；历史佣金不自动回填。
- 事业部管理批次新增 `division_apply`、事业部管理员/申请查询索引与每用户一条有效申请的部分唯一索引，配套 `0014_division_management.sql` 与嵌入式 `migration_0021()`；创建唯一索引前只保留每个用户最新的未删除申请，其余记录软删除。
- 后台 ACL 批次新增兼容旧 PHP 字段的 `system_menus`、菜单/唯一权限/API 方法索引和安全接入历史数据的 `NOT VALID` 约束，配套 `0015_admin_menu_acl.sql` 与嵌入式 `migration_0022()`。迁移只建表，不伪造旧菜单 ID；使用旧数字角色规则的环境必须导入对应 `system_menus` 行并由超级管理员复核/转换为权限 key。
- Admin 新增供应商提现列表/统计、审核通过、拒绝释放预占余额和实际转账凭证登记；审核与转账采用条件更新防重复操作，并补 `pay_time` 审计字段。系统不会伪装成自动打款，仍需管理员在外部银行/支付平台完成真实划款。
- 前端 `view/supplier-ts` Vue 3 + TypeScript 应用生产默认连接 `https://cinashop-api.cinagroup.workers.dev/supplierapi`；本地 `?preview=1` mock 仅在 Vite 开发模式生效，不进入生产路径。
- 第三批补齐供应商实物商品分类树/CRUD、创建/编辑/回收、单/多规格 SKU、快速库存与审计、批量上下架和购物车状态同步；新增 `store_product_description`、`store_product_stock_record` schema，配套 `0016_supplier_product_management.sql` 与嵌入式 `migration_0023()` 逐字一致。商品 JSON 请求体限制为 1 MiB，避免大型请求无界读取。
- Supplier 前端新增完整实物商品表单、分类维护、SKU 生成/编辑、库存调整和批量操作；保存后明确进入待审核并下架。卡密、优惠券、虚拟商品和次卡没有伪装成可用能力。
- 拆单履约批次为订单商品快照补齐 `old_cart_id`、`split_surplus_num`、`split_status`，增加待拆商品与待发货子单复合索引及安全接入历史数据的 `NOT VALID` 状态约束；配套 `0017_supplier_split_fulfillment.sql` 与嵌入式 `migration_0024()` 逐字一致。新订单从创建时初始化可拆数量，旧 TS 行按 `cart_num-refund_num` 回填，不改写生产数据。
- 支付后自动分单批次新增 `supplier_allocation_status`、待分配部分索引及安全状态约束，配套 `0018_supplier_order_allocation.sql` 与嵌入式 `migration_0025()` 逐字一致。迁移只把既有 `pid=-1` 审计根单标记为已分配，不会为历史已支付根单推导或补生成子单；历史处理必须先对账。
- 订单评价完整性批次补齐 PHP 的经营主体、SKU、综合评分、物流评分、浏览与商家回复字段，新增 `order_cart_info_id`、有效评价部分唯一索引、复合查询索引、`NOT VALID` 外键/评分约束，配套 `0019_order_review_integrity.sql` 与嵌入式 `migration_0026()` 逐字一致。迁移兼容 PHP `oid=order.id` 与旧 TS `oid=cart_info.id`，只回填唯一可判定记录；历史重复评价不删除，仅绑定最早有效记录并留待上线前审计。
- Supplier 订单页发货弹窗新增整单/分批模式、商品与数量选择、全量选择保护；详情抽屉新增子单包裹、商品、金额、状态和物流视图。
- 1280px 桌面和 390×844 移动视口浏览器验收覆盖发货、物流轨迹、确认收货、第三方退款门禁、同意退货、余额退款、资金流水、收款设置与提现精度校验；Admin 覆盖支付 outbox 的 `DEAD` 筛选/重放，以及角色权限预选、勾选、保存和移动端 366px 响应式弹窗。控制台无 warning/error，页面级无横向溢出。
- 尚未用微信/支付宝测试商户完成端到端退款，也未用真实小程序 AppID/AppSecret 取码或真实阿里云 AppCode 查询承运商轨迹；支付后自动分单与拆单/分包发货已通过生产 PostgreSQL/Hyperdrive 隔离合成并发场景，但仍缺源 MySQL 历史订单复制后的兼容验证、真实客户调用、通知和小程序发货上报。电子面单、更多物流提供商、优惠券/营销、客服、自动出款和旧后台长尾菜单仍属于后续迁移。

## 后续优先级

1. 在隔离 MySQL/PostgreSQL 上先执行 `0000`～`0085` 的全新建库演练，再运行实时 `data:plan`；重点验证 6 张无稳定键的企业微信关联表、`store_order_status` / `store_integral_order_status` / `other_order_status` / `store_coupon_issue_user` / `store_coupon_product` / `live_room_goods` 的全行多重集初次复制、重复组跨批恢复、目标非空拒绝和 multiplicity 验证；再审计订单优惠复合主键、社区关系三元组、访问聚合/搜索/客服话术/推广关系和好友历史重复键及其他弱唯一键，并检查门店/店员/配送员身份、充值订单号/交易凭据、企业微信目录、公众号会员卡、作用域配置、打印、供应商申请、附件、页面链接、抽奖、公众号、渠道码、旧批处理/定时目录、直播目录和对外 API 账户/ACL 的真实分布；不允许通过忽略列或静默去重换取“可复制”。
2. 对计划通过的表按依赖顺序做小批量复制、故障恢复和重复运行演练，使用 `data:verify` 做全量映射列比对，并生成金额、库存、余额、订单/退款/佣金/积分守恒、外键孤儿及抽样哈希报告；冲突必须人工归因，之后才评估预发 Hyperdrive 与影子流量契约比对。
3. 生产 PostgreSQL 隔离合成场景已覆盖建单幂等/库存/活动取消补偿、取消原子回滚、支付/取消竞争、外部与余额重复支付、支付 outbox 原子回滚，以及余额退款重复执行/故障回滚/累计超额竞争/精确全额收敛/渠道金额绑定、积分/佣金/供应商/拼团累计冲正守恒和拼团超时重复投递恢复；真实 Cloudflare Queue 已进一步覆盖支付 outbox 的真实业务消费、自动 Supplier/平台拆单、重复投递幂等、消费者中断、过期租约和数据库事务故障 `attempts=1→2` 恢复。DLQ 持久归档、敏感数据脱敏、白名单受控重放、人工处置、重复归档幂等和备份 DLQ 已完成本地实现，生产归档表已落地，并在独立真实 Queue + 生产 Hyperdrive 隔离 schema 中闭环验证。正式 `cinashop-order-dlq-unarchived` 与 `cinashop-assets` 已创建、分别完成真实消息和对象 roundtrip，清理后均为空且未残留临时 consumer/Worker。下一步优先做经批准的主 Worker 定向发布，启用线上 DLQ 消费者与 R2 binding 并观察空载/告警状态，再把真实商户回调产生的 outbox 和真实附件上传/签名读取完整验收；在此之前不要把“资源已创建”误报为生产闭环已上线。随后迁移 Supplier 账号、商品描述/规格/库存、订单评价、事业部层级/申请、历史结算快照、财务/佣金/积分/经验流水及旧菜单/角色规则并完成对账。
   拼团仍须单独覆盖真实外部支付回调、回调晚于团失效后的真实渠道处理、真实拼团消息的 Cloudflare Queue 消费中断/DLQ、两人同时抢最后名额和真实账号核销；超时多成员余额退款、部分退款补齐、团长接替、成员重算、重复投递以及未成团发货/核销门禁已在生产 PostgreSQL 隔离 schema 中通过。之后只允许通过状态机收敛生产 2 条旧孤儿团和 2 个无效未付款引用，不执行绕过补偿的裸 SQL 删除。
   履约核销的生产 PostgreSQL 隔离场景已覆盖错误配送员越权、重复身份歧义拒绝、部分核销换码/旧码失效、两个连接同码竞争、售后申请/核销竞争、未成团拒绝/成团放行、最终结算及共享收货原语防绕过；后续仍须覆盖真实自提/平台配送发单、真机扫码、真实账号/门店/配送员、支付后订单、真实拼团成员及通知/打印副作用。供应商同城配送只有在独立租户身份与核销闭环完成后才可重新开放。虚拟卡密运营已补 Admin/Supplier 脱敏查看、批量导入、库存风险告警和一次性受控导出，并通过生产 PG 隔离并发/租户/重放 E2E；生产只读分布为卡密商品/SKU/库存全 0。下一步须取得可访问的源 MySQL 并复制旧 `store_product_virtual`，再用真实运营账号、付款 outbox、通知和客户订单验收。
4. 在隔离环境配置微信平台公钥/APIv3 密钥、支付宝 RSA2 密钥和小程序 AppID/AppSecret，用测试商户验证申请、处理中、成功、重复通知、超时后查询及失败重试；同时验证自动分单、拆单履约、评价、小程序码、outbox、Queue/DLQ、ACL 和事业部并发路径，并用真实物流凭据覆盖在途/派送/签收/异常/空轨迹/超时/缓存命中。
5. 在 Linux CI 或另一台受支持的 Windows x64 主机复跑 Workers runtime 套件，并向 Cloudflare 附最小复现；本机 Windows build 26200 已安装 VC++ x64 Runtime 14.51，但最小无绑定 Worker 仍在启动时发生 `0xc0000005`。runtime 恢复后补客服 hibernating WebSocket 的真实升级/休眠/恢复/撤销/多连接测试，并在隔离 PostgreSQL 上压测重叠 Cron、真实业务 Queue 重复投递、游标续页、消费者中断，以及 DLQ 归档/受控重放的高并发租约、故障恢复和备份 DLQ 路径。

## 本轮验证证据

| 检查 | 结果 |
|---|---|
| Workers `npm run typecheck` | 通过；普通源码与 Workers runtime 测试分别检查 |
| Workers `npm run test:unit` | 119 个测试文件、689 个测试通过；除既有迁移、客服、Out、社区、资金、通知、活动、核销、会员、建单/支付/取消/退款和卡密断言外，新增 PHP 注释路由遮蔽、会员激活字段白名单/越权等级删除/事务奖励、用户中心路由与敏感字段投影、分享冷却证据、Web Crypto 付款码及用户推广小程序码请求断言 |
| Admin 首页统计 + 生产 Hyperdrive 隔离场景（本轮） | 通过；四条 PHP 合同分别恢复，UTC 切日和删除数据混入口径已修复。PostgreSQL 16.14 随机 schema 的四卡、系统删除订单、上/本期金额数量、30 天零填充、用户曲线、删除用户/访问和空排行 8 项断言全部为 true；`schema_removed=true`、临时 schema 0、`public` 三表行数前后不变。生产只读为订单 29、用户 3、访问日志 0，本月/近 30 天有效订单 19 单、2,687.20 元。真实运行还抓出并修复 30 天上期键被本期日期槽位归零的问题；本地浏览器 1280×720 与 390×844 均通过，3 图表、周期切换、零控制台错误和零横向溢出均有证据；全部临时 Worker 已删除，主 Worker/Admin 未发布 |
| Admin 订单/商品统计 + 生产 Hyperdrive 隔离场景（本轮） | 通过；恢复订单基础/趋势/来源/类型和商品基础/趋势/经营排行 7 条 PHP 主合同，旧三端点改为同服务兼容别名。PostgreSQL 16.14 随机 schema 的精确金额/数量、根单与删除过滤、连续 3 日桶、分类/排行及旧别名东八区共 12 项断言全部为 true；`schema_removed=true`、临时 schema 0、`public` 八表行数前后不变。生产近 30 天为支付 20 单/2,787.10 元、优惠 2 单/20.00 元、退款 0；商品行为/分类关系为空，排行 0。浏览器 1280×720 和 390×844 验证两标签、排序、订单 6 卡/3 图、商品 10 卡/趋势/8 行预览排行，修复浮点尾数后零控制台错误、零横向溢出；临时 Worker 已删除，主 Worker/Admin 未发布，Excel 导出和用户/交易/余额统计未迁移 |
| 社区客户端长尾 + 生产 Hyperdrive 隔离场景（本轮） | 通过；生产 PostgreSQL 16.14 的三个客户端查询索引定义精确有效，帖子/评论/话题/关系/商品日志/收藏关系为 `2/2/0/0/0/1`。随机 schema 真实执行作者预览、越权拒绝、重新审核、筛选、点赞/精选、分享并发、嵌套评论、评论点赞并发、删除级联、商品来源和话题计数，全部布尔断言为 true；`schema_removed=true`、临时 schema 0、`public_state_unchanged=true`。真实运行发现并修复待审作者预览误调用公开浏览和数字话题数组 `ANY` 绑定两个缺陷；临时 Worker 删除，主 Worker 未部署 |
| Out API 写入 + 生产 Hyperdrive 隔离场景（本轮） | 通过；原备注/收货场景继续验证 PostgreSQL 16.14 随机 schema 下 3/3 写 ACL、首调/重放/并发/平台范围/门禁/证据脱敏/故障回滚。履约场景克隆 `delivery_service/out_account/out_interface/store_order/store_order_cart_info/store_order_refund/store_order_status/store_pink/user` 九表并改用私有序列，3/3 新写 ACL；普通/拆单发货的首调、重放、双连接单写/拆分、不同载荷、平台/Supplier 范围、业务门禁、强制快递、金额数量守恒、最终发货与日志故障回滚全部通过。配送更正的首次/完全重放、新值后旧请求延迟重放不反向覆盖、双连接单写、平台范围、未发货拒绝、配送员记录与用户账号双有效的权威值/伪造拒绝、4 条摘要证据脱敏和故障全回滚全部通过。分类场景逐条放行 4/4 ACL、拒绝未授权商品写入，并验证创建/并发重放、同名冲突、循环与第四级拒绝、后代路径及商品关系父级联动、触发器故障全回滚、显隐级联、子类及新旧四类商品引用删除门禁、跨租户活动商品引用门禁、已回收引用忽略和 Supplier 类目保护。公共表摘要与序列前后相同，最终 `schema_created/schema_removed/public_state_unchanged=true`、临时 schema 为 0；临时 Worker 已删除。主 Worker 保持 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，未发布本批 |
| 生产数据库缓存只读审计 + Hyperdrive 隔离场景（本轮） | 通过；生产 PostgreSQL 16.14 的 9 个固定缓存键、商品草稿、旧扫码上传缓存与 `uni_app_link` 组当前均为 0。随机 schema 克隆 3 表后，七键保存、触发器强制回滚、UPSERT、68,400 秒草稿 TTL/过期隐藏/删除、URL 回退/覆盖、坏 JSON 无副作用全部通过；schema 删除且 `public` 三表/两序列摘要不变，临时 Worker 删除、URL 404，主 Worker 未部署 |
| 固定/任选优惠套餐 + 生产 Hyperdrive 隔离场景（本轮） | 通过；生产套餐/关联/活动 SKU/购物车/订单均为 0。随机 schema 真实执行固定/任选选品、服务端价、免邮、逐行快照、取消补偿、双连接最后一个限额单赢家、快照故障全回滚、部分退款持有限额、全额退款恢复一次及不可退款门禁；schema 删除，`public` 行数/相关序列不变，临时 Worker 删除且 URL 404，主 Worker未部署 |
| 优惠套餐 Admin + 生产 Hyperdrive 隔离场景（本轮） | 通过；生产套餐/关联/`type=5` 属性/结果/SKU与孤儿记录均为 0。随机 schema 中商品/基础 SKU/标签选择为 `3/4/2`；固定保存为 2 关系/2 属性/2 结果/3 SKU、最小价 `14.50`，转任选后保留关系 ID 和活动 `unique`、精确清理移除项、字段往返正确。强制写失败全回滚，未来定时启用、主商品缺货拒绝/恢复、软删隐藏和关联保留均通过；`schema_removed=true`、`temporary_schemas_after=0`、`public_state_unchanged=true`，临时 Worker 删除，主 Worker未部署 |
| 生产 PostgreSQL/Hyperdrive 核销隔离场景 | 通过；PostgreSQL 16.14 随机临时 schema、11 张克隆表和退款/核销/状态私有序列中完成自提部分/最终核销、配送越权/送达、重复身份拒绝、未成团拒绝/成团放行、双连接同码并发、售后/核销竞争和共享收货防绕过。同码并发严格为 1 成功/1 拒绝/1 不可变记录；售后竞争严格为 1 成功/1 业务拒绝且无锁超时/死锁；临时 schema 删除确认、`public` 业务行数及三条公共序列前后完全一致；临时 Worker 删除后 URL 为 404 |
| 生产 PostgreSQL/Hyperdrive 支付/取消隔离场景 | 通过；PostgreSQL 16.14 随机临时 schema、8 张克隆表和状态/outbox 私有序列中完成取消日志故障回滚/重试、双连接取消竞争、支付/取消竞争、重复支付回调和 outbox 故障回滚/重试。最新复跑中支付赢得支付/取消竞争；相同交易号并发为 1 次 `paid`/1 次 `already-paid`/1 条 outbox，随后不同交易号回调严格拒绝，发票仍只更新一次。余额、积分余额、0 元支付及不足/故障回滚也全部通过；无锁超时/死锁，schema 删除、`public` 快照不变，临时 Worker删除，主 Worker未部署 |
| API-002 订单/售后生产 Hyperdrive 审计与隔离场景 | 通过核心代码范围；生产只读为订单/明细/售后 `29/28/3`，孤儿/归属错配/件数错配均 0；订单赠券账本 DDL 二次应用后为 221 表/3,053 列/712 索引/208 主键、目标表 0 行，业务指纹不变。既有随机 schema 重跑下单、支付取消和完整退款状态机继续通过；本轮报价与建单同为原价 `20.00`、会员 `16.00`、券 `3.00`、积分 `2.00/200`、运费 `5.00→2.50`、实付 `13.50`，冻结积分排除；同模板双商品并发赠券为 `0/1`、库存只减 1、账本/奖品各 1；过期用户申请拒绝，自动退款及未收货申请放行。全部 `schema_removed/public_state_unchanged=true`，最终临时 schema 0；临时 Worker `cinashop-api002-audit-1787896737` 已删除，主 Worker未部署。一般促销叠加、真实运营数据/五端 E2E、安全回调和发布仍未完成 |
| API-003 用户中心生产 Hyperdrive 审计与隔离场景 | 通过核心代码范围；生产只读为用户/激活用户/可见等级/活动用户等级 `3/0/3/0`，激活积分/余额/券证据均为 0，9 个激活配置仅 `member_func_status=1` 存在。真实用户/商品在同一 `READ ONLY` 事务完成活动、自资料、108 键个人中心、推广海报、客服会话摘要和商品口令 6 类断言，当前会话摘要 0 条，输出无 PII。随机 schema 的会员 7 项断言、重复激活拒绝、分享单证据/重放拒绝和 6 位码 TTL 内复用全部通过。最终临时 schema 前后为空、9 类 `public` 审计标记全 0；临时 Worker 已删除，主 Worker未部署。付款码消费、客服安全扫码挑战、微信真实凭据、五端 E2E 和发布仍未完成 |
| 生产支付就绪只读审计 + 充值回调 Hyperdrive 隔离场景 | 通过；真实生产开关为微信/支付宝/余额/线下全部关闭，微信 AppID/商户号/证书序列和主 Worker 支付 secrets 不完整，因此新版收银台会全部禁用。生产充值 6 条（未付 5、已付 1），已付历史行无 `trade_no`，重复订单号 0，本轮未修改。随机 schema 中双连接同一回调严格为 `1 paid + 1 already-paid`，余额 `10.00→135.00`、账单 1；重放幂等，错误金额零落账，冲突交易号/重复订单均拒绝。schema 删除且 `public.user/user_recharge/user_bill` 快照不变，临时 Worker 删除，主 Worker未部署 |
| 生产 PostgreSQL/Hyperdrive 退款隔离场景 | 通过；PostgreSQL 16.14 随机临时 schema 中调用真实退款申请/完成核心。同单重复余额退款为 1 次完成/1 次幂等返回，余额/账单/状态/库存只变一次；账单故障全回滚后可重试；`6+6` 并发超额只允许一笔，`4+6` 两笔精确完成为全额；第三方渠道确认金额不匹配零落账、修正后重试成功。新增纯积分两行退款得到部分状态 3/积分 70、全退状态 2/积分 100、累计返还 60/账单 2，重放幂等。临时 schema 删除，`public` 行数/序列前后一致；一次性 Worker 删除，主 Worker 未部署 |
| 真实 Cloudflare Queue / DLQ + 生产 Hyperdrive 隔离场景 | 通过；独立主队列与 DLQ、临时 Worker 和随机隔离 schema 中，显式 retry 与消费者首投抛错均从 `attempts=1` 在第 2 次投递恢复；持续失败消息完成主队列 `attempts=1/2/3/4` 后进入 DLQ，DLQ 使用新消息 ID 且 `attempts` 重置为 1。由此修正短信 `attempts>=8` 不可达分支为与 `max_retries=3` 对齐的第 4 次失败收口。`public` 前后均为 207 表/190 序列，schema、两个消费者、Worker 和两条队列均删除，临时 URL 为 404；主 Worker 未部署。该项是平台故障语义证据，不是支付 outbox/拼团/SMS 业务 E2E |
| 真实支付 outbox Queue 业务消费 + 生产 Hyperdrive 隔离场景 | 通过；真实 `OrderOutboxService.processMessage` 为四条混合经营主体订单完成 Supplier/平台各 1 个子单、财务流水/交易、状态日志和买家付款次数。重复投递三次只执行一次；消费者中断、供应商交易写入故障均从 Queue `attempts=1` 在第 2 次恢复，过期 `PROCESSING` 租约被应用 attempt 2 重新认领。故障第 1 次 checkpoint 中根单、子单、流水、状态、拆分快照与 `pay_count` 均无副作用。`public` 相关表/序列前后无差异且审计标记为 0，随机 schema、临时 Worker、主 Queue 与 DLQ 全删除；主 Worker 未部署。仍不等于真实商户回调和真实客户订单 E2E |
| 发货/拒绝退款通知 + 外部投递/人工处置账本 + 生产 Hyperdrive 隔离场景（本轮） | 通过；真实 Supplier 发货、售后拒绝和通知消费者在随机 schema 验证业务/outbox 同事务回滚、重复 enqueue、不可变冲突、消费故障后重试、并发租约、模板渲染、禁用抑制与站内信精确一次。5 条 outbox 全完成、4 条消息、attempts `[1,1,1,1,2]`；17 条外部投递为短信 5/公众号 4/小程序 5/微信发货 3，mock 结果 `16 SENT + 1 UNKNOWN`，重放 `16 already-sent + 1 unknown` 且无第二次提供商调用。`UNKNOWN→RETRYABLE/SENT/DEAD`、请求幂等、3 条不可变动作和 Admin 脱敏投影均通过。生产 `0084`～`0086` 的列、约束、索引定义精确，公共 14 表/序列指纹不变、最终投递/动作/孤儿/审计标记和临时 schema 均为 0。主 Worker未部署；生产四类模板、openid、渠道配置和外部 secrets 仍为空 |
| 虚拟商品自动交付 + 生产 Hyperdrive 隔离场景（本轮） | 通过；真实交付服务在正式 Hyperdrive 随机 schema 中验证 3 卡争抢 2×2 订单严格单赢家、无重复卡、败方补库存重试，已完成事件重放幂等；两 SKU 部分认领遇缺货时卡/订单/状态整单回滚，补卡后成功；共享 `disk_info` 不占卡。最终订单 4、购物车 5、SKU 4、唯一已分配卡 6、交付状态 4，全部断言为 true；`public` 快照不变、审计标记 0，schema/Preview/临时 Worker 已删除，一次性令牌未持久化。主 Worker 未部署，旧卡库存也未复制 |
| 虚拟卡密库存运营 + 生产 Hyperdrive 隔离场景（本轮） | 通过；Admin/Supplier 真实库存服务在正式 Hyperdrive 随机 schema 中完成双连接同批导入单赢家、重放幂等、跨 Supplier 读写拒绝、Admin 跨主体可见、固定内容/实物拒绝、仅密码卡、响应不含密码或完整卡号、游标分页、供应商 `store_id`、库存增量和审计精确以及历史 `store_id=0` 兼容。隔离计数为商品 5/SKU 5/卡 5/库存审计 2，全部断言为 true；`public` 四表/四序列前后相同、标记 0，schema 和 Worker 已删除，主 Worker 未部署；短卡完全遮蔽由单元测试覆盖 |
| 卡密库存风险告警 + 生产 Hyperdrive 隔离场景（本轮） | 通过；Admin 全局与 Supplier 租户告警在正式 Hyperdrive 随机 schema 中得到缺口 1、低缓冲 1，分页游标 `201→202`，Supplier A 只见自有缺口且 Supplier B 为 0；固定内容、实物与空库存商品排除，响应无卡号/密码/秘密。生产 `public` 只读汇总为卡密商品/SKU/卡库存均 0、孤儿 0；隔离清理后 `public` 行数/序列不变，临时 Worker 删除。Admin/Supplier 桌面与 390px 移动页面、筛选交互、控制台和无横向溢出检查通过；主 Worker 未部署 |
| 卡密一次性受控导出 + 生产 Hyperdrive 隔离场景（本轮） | 通过；正式 Hyperdrive 随机 schema 中 29 个布尔断言全部为 true，覆盖 Admin/Supplier 建票、数据库只存 SHA-256 摘要、仅未分配卡、租户/商品/SKU 绑定、双连接单次消费、重放/过期拒绝和精确审计。隔离计数为商品 5/SKU 5/卡 5/库存审计 2/导出审计 3；清理后 schema 不存在，`public.system_virtual_inventory_export` 为 0 行且业务快照/序列不变。生产表已确认为 6 约束、5 索引、无秘密列；主 Worker未部署 |
| DLQ 持久归档/脱敏/受控重放 + 生产 Hyperdrive 隔离场景 | 通过；生产服务与消费者在独立真实 Queue 中把连续失败两次的支付消息转入 DLQ，归档后重复投递只把 `occurrence_count` 增至 2，受控重放严格处理 1 次并收敛为 `REPLAYED/replay_count=1`。短信验证码与手机号分别脱敏为 `[REDACTED]` 和 `138****8000`，标记 `BLOCK_SENSITIVE`，只能人工处置。事件序列为失败 1、失败 2、重放处理 1，处理计数 1；临时 schema/Worker/三条 Queue 全删除。外部 `0080` 与内嵌 `0087` 定义一致，生产事务回滚演练后实际应用，独立查询确认 `public` 208 表、归档表 26 列/6 约束/5 索引/0 行，原 outbox 行数/序列不变。主 Worker 未部署，线上 DLQ 消费者仍未启用 |
| 客服实时核心 + 安全转接 + 商品/订单管理上下文 + 独立工作台 + 生产 Hyperdrive 隔离场景（2026-08-27） | 通过；正式 Hyperdrive 随机 schema 中核心/转接 24/24、商品 10/10、订单/售后读取 10/10、订单管理写入 14/14 项均为 true。核心覆盖 PHP 兼容“全部标签 + disabled 选中态”、专用登录、会话/聊天/用户/话术作用域、接收方记录方向、在线客服选择、双向持久化、未读归零、错误目标拒绝、触发器故障全回滚、反向并发 advisory lock、转接事务/幂等审计/所有权迁移/双连接并发；商品覆盖已购分页、搜索扩展全目录、浏览顺序、分类热销、详情、坏轮播、非归属拒绝与转接撤权；订单读取覆盖 PHP 状态筛选、商品搜索、活动售后分支、订单/售后脱敏详情、按客服分配售后总表和转接撤权；订单管理覆盖精确分值改价、disabled 防篡改、已支付拒绝、重复无日志、两类备注、两类退款表单、日志失败回滚和转接后撤权。生产 PostgreSQL 16.14 当前客服账号/活跃账号/在线账号/会话/话术为 0/0/0/0/0、消息 3，商品/描述/订单明细/访问/分类关系为 71/0/28/0/0，订单/可见根订单/售后/状态为 29/28/3/17；`0092`～`0096` 的客服、转接、商品及订单查询索引均已幂等应用，公共业务指纹不变；随机 schema 和临时 Worker 均 0 残留。独立 Kefu Vue 工作台构建/6 测试通过，1440×900 与 390×844 完成转接、商品、订单/售后搜索/详情、改价和两类备注交互，console 0 warning/error；主 Worker和前端未部署 |
| Workers `npm run test:runtime` | 测试与本地隔离绑定已完成、类型检查通过，但本机 workerd 在加载任何测试前以 `0xc0000005` 原生访问冲突退出。Wrangler 4.122.0 / Vitest Pool 0.21.2 / workerd 2026-08-11 和完全不加载 CinaShop 代码、Hyperdrive 或 DO 的最小 Worker 均同样复现；Windows build 26200 的 VC++ x64 Runtime 已为 14.51。此项是本机 runtime 阻塞，不得记为测试通过或业务断言失败 |
| 客服履约/拆单/核销 + 生产 Hyperdrive 隔离场景（2026-08-27） | 通过；9 条 PHP 合同补齐后客服覆盖为 47/63（74.6%）、总注册 49。随机 schema 的元数据、会话越权、手工/平台注册配送、重复发货、售后/预售门禁、部分核销旋码、完整核销只结算一次、拆单数量金额守恒、两类审计故障全回滚和转接撤权共 13/13 为 true；`public_state_unchanged=true`、schema/标记/临时 Worker 均为 0。生产缺 `order_waybill_job` 与 `order_waybill_job_action`，电子面单仍关闭。浏览器完成平台配送→待收货→两商品核销→已完成，390×844 无横向溢出且 console 0 warning/error；主 Worker/Kefu 前端未部署 |
| `data:schema-audit` | 通过；旧 MySQL 201 表、目标 217 表、逻辑共享 201 表、源端独有 0 表、目标独有 16 表；201 张逻辑共享表已表示全部源列，源列缺口为 0；外部迁移与 Worker 两条独立路径均为 217 表，表、列定义和主键差异为零 |
| 数据迁移控制与恢复测试 | `0020`～`0084` 与 `migration_0027()`～`migration_0091()` 中的对应文件迁移逐字等价；每个内嵌迁移独立事务并以 `SET LOCAL search_path TO public` 固定目标 schema。负主键、复合整数键、混合整数/二进制文本键、自增序列、显式映射、故障恢复和历史冲突保持回归覆盖；`live_room` 以精确的 `(id,phone)` 混合主键通过计划，`live_room_goods` 与其余 11 张无稳定键表使用全行多重集策略；充值订单查询、Out API 脱敏审计及通知事件键/白名单均覆盖；尚无真实源 MySQL 复制 E2E |
| `data:verify` | 默认只读；显式表白名单和既有 run ID 在连接前校验，双端一致性快照内对有键表按单列/复合迁移键全量比较映射列、对无键表核对全行 multiplicity；规范化数值、时间和 JSON，缺行/差异只报告稳定迁移键或不可逆全行摘要与列名。实现和纯比较测试通过，尚无真实数据库 E2E 证据 |
| PostgreSQL schema / SQL 定义 | 外部 SQL 与 Worker 内嵌迁移均定义 217 张唯一目标表；其中 201 张与 PHP 源库共有、16 张为 Worker 专用表，旧库覆盖率仍以共有表/列审计为准 |
| Wrangler 绑定类型生成 | 通过，生成 `worker-configuration.d.ts` |
| Wrangler 4.122.0 `deploy --dry-run`（2026-08-27 最新） | 通过；当前工作树上传体积 3,951.63 KiB（gzip 741.64 KiB），识别 `CHAT_ROOM` 等 4 个 DO、KV、Queue、Hyperdrive `9748c294e21c49a99579c9cef70102e0`、R2 与生产变量；输出 `--dry-run: exiting now.`。体积较客服批次前显著增长，虽仍可部署但应继续做依赖/路由拆分审计。独立 `deployments status` 确认线上主 Worker仍 100% 使用 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；本轮未部署 |
| Wrangler 4.120.0 `deploy --keep-vars` | 通过，Worker 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef` 已上线 |
| Admin `npm run build` | 通过；首页新图表 chunk 6.49 KiB（gzip 2.63 KiB）、CSS 1.45 KiB（gzip 0.50 KiB）；应用主包仍为 1,203.77 KiB（gzip 387.61 KiB），既有拆包信号仍在 |
| PC `npm run build` / UniApp `npm run typecheck` / `build:h5` / `build:mp-weixin` | 全部通过；订单列表改为进入服务端收银台，PC 订单/充值页生成微信 native QR 并轮询真实状态，UniApp 订单/充值/会员页按 H5、公众号、小程序和 App 分支处理且回调前不宣告成功；非 H5 端明确禁用支付宝 H5。PC/UniApp 结算页新增服务端首单 quote 展示和优惠券互斥，PC 主 chunk 1,046.35 KiB（gzip 345.64 KiB）的拆包信号仍在；构建通过不等于真机支付或已发布 |
| PC 收银台浏览器验收（本轮） | 应用内浏览器使用本地一次性假 API 验证生产等价“全部支付方式关闭”状态：桌面四种支付方式与底部按钮均为 disabled 并显示各自原因，零 warning/error。微信可用 fixture 中点击付款并确认后只出现 native 二维码，订单继续显示待支付且 DOM 无“支付成功”；点击“我已完成支付”而回调仍未付时提示稍后重试、二维码保留。移动实际视口 375px，`scrollWidth=clientWidth=375`、四方式仍禁用且无框架遮罩/控制台错误。fixture、测试 token、浏览器标签、端口和临时脚本均已清理；该证据不连接真实商户或生产订单 |
| Admin 付费会员浏览器验收（本轮） | 内置浏览器访问本地 `/member?preview=1`，桌面完成切换卡批次、创建 3 张/14 天卡、一次性查看卡号密码、关闭后确认密码从 DOM 清除；再次完成 2 张卡签发。套餐卡正确区分实际收费 `pre_price` 与划线原价 `price`，激活二维码弹窗同时展示本地 H5 QR 与小程序码配置状态。390×844 下侧栏收窄、二维码弹窗和内容均无横向溢出，`document/body scrollWidth=clientWidth=390`；两视口页面身份、非空渲染、无框架错误层且控制台零 warning/error。使用本地 preview 数据，不是生产 Admin 发布证据 |
| UniApp 付费会员浏览器验收（本轮） | 内置浏览器访问本地 `?preview=1#/pages/user/vipOpen`，桌面和 390×844 均显示 3 个套餐、实际价/划线价、预计到期日、权益和余额/微信/支付宝入口；卡密入口可进入 `pages/annex/vip_active/index`，填写本地测试卡号与 12 位卡密后成功回跳会员页。移动端会员页和激活页均有 `scrollWidth=clientWidth=375`，无横向溢出或应用错误；控制台只有 `@dcloudio/uni-h5` 内置 Vue Router 路径的弃用 warning。使用本地 preview 数据，不是真实用户、真机支付或已发布证据 |
| 付费会员生产 Hyperdrive 隔离 E2E（本轮） | 临时 Worker 经正式 Hyperdrive 创建随机 schema，真实执行 1 批次/3 卡、2 套餐、1 权益、1 协议、1 记录；卡号唯一/格式、密码格式与不回显、批次状态传播、用量一致、用户关联、免费价格归零、权益正文、协议和记录卡号脱敏全部通过。`public` 6 表行数/6 序列快照前后相同且审计标记 0；隔离 schema 和临时 Worker 已删除，URL 404。生产真实会员表除 `member_right=1` 外均 0 行，因此不是旧数据复制或真实会员/支付 E2E |
| 会员购买/支付生产 Hyperdrive 隔离 E2E（本轮） | 临时 Worker 经同一正式 Hyperdrive 在随机 schema 内创建 2 用户、3 套餐、4 订单。划线原价 `199/599` 只用于展示，服务端实际收费严格为 `99/399`；同一余额订单双连接并发结果为 `paid + already-paid`，余额 `250→151`、`pay_member` 账单仅 1 条；免费套餐建单即付款、只能领取一次并从现有期限续 30 天；微信回调金额差 1 分时订单/会员零落账，正确回调后重放幂等，冲突交易号拒绝；永久会员落为 `is_money_level=1/is_ever_level=1/overdue_time=0`；余额不足时订单、资金、账单、会员全部回滚。隔离计数为用户 2/套餐 3/订单 4/状态 7/账单 1，全部断言为 true。`public` 5 表行数及 4 条序列前后完全一致、审计标记 0；schema 和临时 Worker 已删除，URL 404；主 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`。该证据不是真实微信/支付宝验签商户或真实用户 E2E |
| 佣金转余额生产 Hyperdrive 隔离 E2E（本轮） | 随机 schema 直接调用真实 `applyBrokerageToBalance`：100 元佣金中冻结 30 元时只允许转 70，随后 0.01 元拒绝；同用户两个并发 60 元请求严格 1 成功/1 拒绝且仅一组四账；强制 `user_brokerage` 写入失败时充值记录、余额流水、提现记录、用户双余额全部回滚，移除故障后重试成功。3 用户的 `now_money + brokerage_price` 均守恒，最终 3 条 paid balance recharge、3 条 user_money、3 条 user_extract、3 条 extract_money 佣金支出逐组关联；schema 删除、`public` 五表快照不变、临时 Worker 删除，主 Worker 未部署。生产真实聚合为有效用户 3、佣金/冻结/可转均 0.00，且开关与说明配置缺失 |
| 首单优惠生产 Hyperdrive 隔离 E2E（本轮） | 生产只读为活跃用户 3、首单资格 `0/1/-1 = 3/0/0`，29 单中首单优惠单 0、首单与券重叠 0，六项配置全部缺失。随机 schema 直接调用真实服务端 quote 与建单核心：200 元九折优惠按 15 元上限封顶，预览/建单均为 15，券不占用，订单/快照优惠 15、实付 185；取消后资格不恢复，下一单使用 5 元券实付 95；已支付历史与过期用户均原价；同用户双连接并发优惠严格为 `[0.00,10.00]`；库存失败后资格、购物车、订单全部回滚。schema 删除、`public` 行数/三条序列不变，临时 Worker 删除且 URL 404，主 Worker 未部署 |
| Admin 新人运营与注册赠礼生产 Hyperdrive 隔离 E2E（本轮） | 生产只读确认 16 项注册/新人配置全部缺失，活动商品/SKU、重复或失效目录及四类赠礼历史证据均为 0，没有写入或启用生产配置。随机 schema 首次保存得到 16 行配置、2 商品/3 活动 SKU，基础库存不变；替换后只保留 1 商品/1 SKU、移除项软删除、价格 `16.50`，无效商品强制配置/协议/目录全回滚。密码注册得到积分 100、余额 `9.00`（配置 `9.99` 的 PHP 整元兼容）、资格标记及四类账本/券证据各 1；同账号并发严格 1 成功/1 拒绝且赠礼 exactly-once，强制账本失败时用户和券库存/证据全部回滚。schema 删除且 `public` 11 表全行指纹、9 序列前后不变，临时 Worker 删除并返回 404；主 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef` |
| Admin 对外接口浏览器验收（本轮） | 内置浏览器访问 `http://127.0.0.1:4176/system/out?preview=1`，1440×900 与 390×844 均通过；桌面表格和移动卡片按断点切换，390px 文档宽度等于视口。创建本地预览账户会显示一次性 64 字符密钥，编辑页没有密钥输入框且提供显式轮换；接口目录把 4 条 GET 标记为可用只读，并把 POST 文档标记为尚未迁移。控制台无 warning/error；该证据不连接 PostgreSQL/Hyperdrive，也未写生产资源 |
| Admin 小程序直播浏览器验收（本轮） | 内置浏览器访问 `http://127.0.0.1:4173/marketing/live?preview=1`，1440×900 与 390×844 均通过；页面身份、非空渲染、边界告警、直播间/商品/主播标签切换及同步入队提示可见，控制台无 warning/error。390px 下文档宽度等于视口，移动卡片可见且桌面表格隐藏；该证据不连接 PostgreSQL、Queue 或微信 |
| Admin 门店运营浏览器验收（本轮） | 本地预览在默认桌面与 390×844 通过；门店、店员/核销、配送员标签和编辑/新增弹窗可交互，店员表单不含密码/权限输入。验收发现并修复移动弹窗固定宽度导致的横向溢出和底部按钮不可见；修复后长门店表单与配送表单的取消/保存均可见，文档宽度保持 390px，控制台无 warning/error。该证据不是 PostgreSQL/Hyperdrive E2E |
| PC `npm run build` / UniApp `npm run typecheck && npm run build:h5` | 通过；系统自定义表单十类组件、模板图片数量限制、私有 R2 图片上传、普通/活动统一结算提交、拼团开团/指定团参团、积分直兑填表和订单详情快照/图片预览通过前端类型检查和生产构建；拼团详情新增进行中/失败退款提示及动作门禁；尚未用真实表单或有效拼团数据做浏览器/小程序 E2E |
| Admin 事业部浏览器验收 | 默认桌面与 390×844 通过；层级表、汇总卡和代理申请标签交互可见，控制台无 warning/error；移动端侧栏收窄为 64px，页面无横向溢出 |
| Admin 角色 ACL 浏览器验收 | 1280px 与 390×844 通过；角色规则预选、权限勾选和保存成功，移动端弹窗 366px 且文档宽度保持 390px，控制台无 warning/error |
| Admin 供应商提现页构建 | 通过；独立 `SupplierExtractList` 路由 chunk 约 9.5 KiB，审核与转账登记契约通过类型检查 |
| Admin 支付 outbox 浏览器验收 | 1280px 通过；`DEAD` 事件重放后变为 `ENQUEUED`，尝试次数归零、投递/重放次数递增、旧错误清空；控制台无 warning/error、无残留遮罩 |
| Admin Queue 死信浏览器验收（本轮） | 内置浏览器访问本地 `/operations/outbox?preview=1`，桌面与 390×844 通过。桌面查看脱敏正文和 SHA-256，支付死信在原因少于 8 字时禁用确认、有效原因后重放为 `REPLAYED/replay_count=1`；短信验证码/手机号为 `[REDACTED]` / `138****8000`，没有重放按钮，人工处置后为 `RESOLVED`。消息类型筛选只保留目标卡片。移动端表格切换为卡片，`scrollWidth=clientWidth=390`；验收发现并修复抽屉右缘 415px 越界，挂载 body 后右缘为 390px，确认框位于 15.6～374.4px。控制台零 warning/error、无框架错误层；该证据是 preview 契约，不是生产 Admin 或线上 Queue E2E |
| Admin 订单通知中心浏览器验收（本轮） | 内置浏览器访问本地 `/setting/notification?preview=1`，默认桌面与 390×844 通过；凭据仅允许 Worker secrets 的提示、四类提供商就绪状态、渠道矩阵、模板目录及脱敏投递台账均可见。`UNKNOWN` 投递的人工重发先要求填写至少 8 字理由，再显示“重复发送风险”二次确认；本轮在最终确认前取消，没有触发外部通知。移动端桌面表格切换为卡片，`scrollWidth=clientWidth=390`，无横向溢出；页面无框架错误层，初始控制台零 warning/error。使用本地安全 fixture，不是生产 Admin、真实凭据或第三方渠道 E2E |
| PC `npm run build` | 通过；订单根单/履约子单契约、真实物流降级/拆分包裹选择、路由参数重载、移动页头响应式和已收货订单评价弹窗通过类型检查 |
| PC 自动分单浏览器验收（本轮） | 使用本地契约 fixture 在 1280px 与 390×844 通过；根审计单显示 2 个可点击履约包裹、商品快照名称和金额，隐藏根单退款/收货动作，点击后正确重载子订单；移动端文档宽度等于视口、控制台无 warning/error。该证据不是 PostgreSQL/Hyperdrive E2E |
| PC 订单评价浏览器验收（本轮） | 本地契约 fixture 下桌面与 390×844 通过；桌面完成“已收货 → 打开评价 → 调整评分/输入 → 提交两件商品 → 已完成”，评价按钮随状态消失；移动视口弹窗、商品、评分和输入区可见可用，控制台无 warning/error。该证据不是 PostgreSQL/Hyperdrive E2E |
| PC 虚拟商品交付浏览器验收（本轮） | 内置浏览器使用系统临时目录的只读静态 fixture 访问已构建 PC 订单详情；默认桌面与 390×844 均显示“卡密已发放”、卡号/密码、共享下载密钥和两个复制按钮。点击卡密复制后“已复制”反馈可见；两视口无框架错误层或控制台 warning/error。fixture 仅使用安全假数据，临时服务器、脚本、日志和浏览器标签均已清理；该证据不是生产 API、真实卡密或真实用户 E2E |
| PC 真实物流浏览器验收（本轮） | 本地隔离 fixture 的 1280×720 桌面通过；根单加载两个可切换包裹，第一包只展示承运商返回的真实轨迹，切换第二包后显示运单与唯一降级提示且不生成轨迹；验收中修复提示条与空状态重复文案。页面身份、DOM、无框架错误层和控制台无 warning/error 均通过。当前内置浏览器忽略 390×844 参数并保持 1280×720，因此本轮没有移动渲染通过证据；该证据也不是真实 AppCode/Hyperdrive E2E |
| UniApp `npm run typecheck` + `npm run build:h5` | 通过；供应商申请/重提、私有 R2 资质选择/上传/删除、验证码请求、审核状态与短信密码激活页面，以及订单状态筛选、真实物流降级/拆分包裹选择、履约包裹、根单动作门禁和评价页均通过编译 |
| Supplier `npm run build` | 通过；受控卡密库存页 chunk 8.36 KiB（gzip 3.95 KiB）、CSS 1.62 KiB（gzip 0.51 KiB），`Orders` 路由 chunk 14.37 KiB（gzip 5.10 KiB），服务端与界面均关闭未完成的 Supplier `send`；生产环境应用壳主包 1113.52 KiB（gzip 368.94 KiB）的既有拆包警告仍在 |
| Admin/Supplier 卡密库存浏览器验收（本轮） | 本地生产构建通过真实登录表单进入两端库存页，桌面均显示 SKU/状态筛选、5 条脱敏卡、密码仅为“已配置”和已交付状态；分别粘贴“卡号 + Tab + 密码”与仅密码两行后新增 2 条，统计 3→5，响应与 DOM 均不出现明文密码，文本框清空。390×844 下 Admin 图标侧栏和 Supplier 移动导航可用，标题/安全说明完整换行、统计卡单列、筛选满宽和脱敏列表可见；验收中补了长文本/告警响应式收缩。使用本地契约服务器与安全假数据，不是生产 Admin/Supplier 发布或真实账号证据 |
| Admin/Supplier 卡密受控导出浏览器验收（本轮） | 两端桌面与 390×844 均通过；页面只显示脱敏卡号、未分配数量和明文文件风险，原因弹窗强制 8～500 字，最终确认准确显示 2 条、60 秒、不可重放及下载失败需重申请。文档无横向溢出，Supplier 控制台零 warning/error，DOM 无预览秘密。最终动作均在“创建票据并立即下载”前取消，未触发导出 API 或明文下载；使用本地安全假数据，不是生产账号验收 |
| Supplier 履约配置浏览器验收（较早证据） | 当时合并页面的 1440×900 与 390×844 验收通过，密钥不回显、移动单列布局和电子面单保存均正确。当前源码已把打印从该页移入独立打印机页面，`Settings` 只保留电子面单；该证据使用本地 preview 数据，不是 PostgreSQL/Hyperdrive E2E |
| Admin/Supplier 小票打印浏览器验收（本轮） | Admin `/setting/print?preview=1` 桌面完成新增弹窗和任务台账切换，390×844 移动卡片无挤压；Supplier `/printers?preview=1` 桌面显示启用的 outbox 风险提示与任务区。两端无错误层或控制台 warning/error。Supplier 新任务台账本轮无可靠 390×844 新截图；preview 数据也不是生产 API或第三方出纸 E2E |
| 供应商入驻 Admin 浏览器验收（本轮） | 默认桌面和 390×844 通过；页面身份、三种审核/激活状态、安全提示与待审核筛选均正确，控制台零 warning/error、无框架错误遮罩。首次移动验收发现固定操作列遮挡申请信息，已改为窄屏专用卡片并复测联系人、账号状态、备注和操作按钮均可读。使用本地 preview 数据，不是 PostgreSQL/Hyperdrive、真实 Aliyun 短信或供应商登录 E2E |
| Admin 素材中心浏览器验收（本轮） | 本地 `/assets?preview=1` 在 1280×720 与 390×844 通过；标题、R2 私有存储提示、分类/搜索/上传控件和两张素材卡均可见，文档宽度分别精确等于 1280/390，无横向溢出、框架遮罩或控制台 warning/error。“新建分类 → 输入 → 保存”关闭弹窗并显示成功反馈。使用本地 preview 数据，不是真实 R2/PostgreSQL/Hyperdrive E2E |
| Supplier 浏览器验收 | 1280px 桌面与 390×844 通过；发货→轨迹→确认收货、售后安全门禁/余额退款、财务设置/提现校验均通过，控制台无 warning/error |
| Supplier 商品管理浏览器验收（本轮） | 1280×900 商品列表、分类树、预览态新增分类、SKU 库存弹窗和库存成功反馈通过；验收中修复库存提交后列表不立即同步。随后本地 URL 被浏览器安全策略中止，本轮未完成新商品表单与 390×844 的再次浏览器复核，不能将生产构建/响应式 CSS 当作该项浏览器通过证据 |
| Supplier 拆单发货浏览器验收（本轮） | 默认桌面与 390×844 通过；订单→发货→分批发货→选择商品后计数从 `0/4` 更新为 `1/4`，桌面详情正确显示发货包裹、商品和数量，移动弹窗无横向溢出且底部操作可见；控制台无 warning/error |
| Admin / PC / Supplier 生产构建与 UniApp 类型检查/H5 构建（本轮） | 全部通过；Admin 生成抽奖管理路由 chunk，UniApp 抽奖、记录与领奖契约通过类型检查和 H5 构建，PC/Supplier 回归构建通过 |
| Admin 抽奖管理浏览器验收（本轮） | 本地 `/marketing/lottery?preview=1` 在桌面和 820×900 窄视口通过；活动列表、创建弹窗、8 个奖位、权重/库存提示和不支持奖品安全提示可见可交互，无框架错误层或控制台 warning/error。使用本地预览数据，不是 PostgreSQL/Hyperdrive E2E |
| Admin 公众号内容浏览器验收（本轮） | 本地 `/content/wechat?preview=1` 在默认桌面通过；预留回复、关键字、图文与消息历史标签可见，关键字“二维码”入口打开就绪图片弹窗并显示 Queue 重试边界。控制台零 warning/error、无框架错误层。使用本地预览数据，不是 PostgreSQL/Hyperdrive、真实微信二维码或公众号回调 E2E |
| Admin 渠道二维码浏览器验收（本轮） | 本地 `/content/wechat-qrcode?preview=1` 在默认桌面与 390×844 通过；页面身份、异步生成提示、三条渠道数据、统计抽屉、完整新建表单与回复类型切换均可交互。窄屏使用卡片而非桌面表格，文档 `scrollWidth=clientWidth=390`，重试生成入口可见；两视口控制台零 warning/error、无框架错误层。使用本地预览数据，不是 PostgreSQL/Hyperdrive、Queue 或微信 E2E |
| Admin 公众号会员卡浏览器验收（本轮） | 本地 `/content/wechat-card?preview=1` 的桌面视口通过；概览、卡配置与领取/激活标签可切换，card_id、code 与 openid 示例均只显示掩码，页面没有外部写入控件。用户要求转入详细审计后浏览器会话重置，本轮未完成该新页的 390×844 与控制台复核，因此不把移动端标为通过；使用本地预览数据，不是 PostgreSQL/Hyperdrive 或微信 E2E |
| Wrangler 4.122.0 直接执行 `deploy --dry-run --minify`（本轮） | 通过；2026-08-28 最新上传体积 2,345.48 KiB（gzip 579.21 KiB），输出 `--dry-run: exiting now.`，识别 4 个 DO、KV、Queue、Hyperdrive `9748c294e21c49a99579c9cef70102e0`、`ASSETS_BUCKET (cinashop-assets)`、Out API 四项限流变量与 `ORDER_DLQ_NAME`；本轮没有执行主 Worker 生产部署 |
| Cloudflare 正式 R2 / 备份 DLQ 资源验收（本轮） | 已创建 APAC/Standard `cinashop-assets` 和 Queue `cinashop-order-dlq-unarchived`（ID `ec0ef96ffcd3429da48500cdf90ca532`）。R2 对 `codex-audit/69680504ff71/roundtrip.json` 完成精确写读删；临时 Worker `codex-cinashop-resource-audit-5e7c2a6f`（版本 `cf66d1ab-b8e5-4361-ad44-19673e8b86e0`）把审计消息 `b42b9093acf5488aa8bde0be` 以 `attempts=1` 从正式备份 Queue 消费并写入正式 R2 receipt 后 ack。receipt、consumer 和临时 Worker 均已删除，临时 URL 返回 404；最终 R2 为 0 对象/0 B，备份 Queue 为 0 producers/0 consumers，原 `cinashop-order` 仍只有 `cinashop-api` 一组生产者/消费者，原 `cinashop-order-dlq` 仍为 0/0，主 Worker 保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef` |
| Pages 发布 | H5 `15330769-f7ef-4635-81f5-4e7b4e2dba4a`、Admin `00ac193e-be07-464e-8e77-b89295e9df7a` 已发布到 production/main |

### Cloudflare 生产发布与远端核验

- 账户：`CinaGroup`；使用 Wrangler 4.122.0 查询成功。
- Hyperdrive：`9748c294e21c49a99579c9cef70102e0`，名称 `cinashop-pg`，PostgreSQL origin，连接上限 60，缓存启用。
- Worker：`cinashop-api` 线上 100% 版本为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，兼容日期 `2026-08-09`，启用 `nodejs_compat`，包含 fetch、queue、scheduled handlers。
- 本轮曾因 `npm exec` 吞掉 `--dry-run` 参数，在 `2026-08-09T13:57:58Z` 短暂把未授权版本 `6bfd982f-7052-489d-8804-6b55b8ef426a` 切到 100%；发现后立即停止写操作，并于 `2026-08-09T13:59:31Z` 回滚到原版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。`wrangler deployments status` 已确认原版本恢复 100%，`/health` 返回 HTTP 200；误发布版本只保留在版本历史中，不承载流量。本轮未主动执行数据库迁移、Cron 手工触发或绑定资源写入，只对 `/health` 做了只读核验。
- 线上绑定：`HYPERDRIVE` 正确指向上述 ID，同时存在 4 个 Durable Objects、KV、订单 Queue，以及 `NODE_ENV=production`、`INTERNAL_API_URL` 两个生产变量。正式 `cinashop-assets` bucket 已在 APAC/Standard 建立并完成独立 binding 验收，但当前线上主 Worker 版本仍没有本批新增的 `ASSETS_BUCKET` binding；资源存在不等于应用链路已经上线。
- 线上请求：`/health`、`/api/site_config`、`/api/category`、`/api/products?page=1&limit=1` 均返回 HTTP 200；商品接口返回数据库商品记录，证明当前 Worker → Hyperdrive/PostgreSQL 读取链路可用。
- 2026-08-12 生产动态表单只读审计：模板、启用模板、采集记录、五类商品/活动引用、订单表单快照和孤儿引用均为 0；临时探针成功删除。生产缺少可用于表单下单 E2E 的真实样本，且该空分布与“PHP 源数据尚未复制”一致。
- 2026-08-12 生产拼团只读审计：`store_pink` 2 行均无已付款订单凭据，其中 1 行由未付款订单提前公开并错误标成成功；2 个未付款订单引用该无效团，另有 1 个 `activity_id=0` 的历史 `type=3` 订单。超额占位与有效已付款订单缺成员均为 0。临时 `cinashop-prod-pink-audit` Worker 及本地探针已删除；未修改异常行，等待新状态机在隔离环境演练后安全补偿。
- 2026-08-12 生产履约只读审计：6 张相关表与 12 个关键列存在，订单总数 29；门店、店员、配送员、自提/同城配送订单、配送商品行和核销记录均为 0，身份/核销码不变量异常为 0。生产缺少 `so_verify_code`，已通过独立 `0078` DDL 在短锁超时下从 0 创建为 1，并以第二次幂等执行复核；订单行数仍为 29。临时只读/索引 Worker 和本地探针均已删除，URL 返回 404；没有部署主 Worker，也没有修改业务行。
- 2026-08-13 真实 Queue 审计：线上 `cinashop-order` 消费者远端配置确认 `max_retries=3`、`dead_letter_queue=cinashop-order-dlq`，而 DLQ 没有消费者。独立临时队列实测总投递为 4 次，随后进入 DLQ；显式 retry 与消费者抛错都能在第 2 次恢复。生产 Hyperdrive 只写随机隔离 schema 的事件表，`public` 前后保持 207 表/190 序列；隔离 schema、临时 Worker、主测试队列与 DLQ 已全部删除，URL 为 404。主 `cinashop-api` 仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布本批代码。
- 2026-08-13 支付 outbox 业务 Queue 审计：临时单并发消费者复用主 Worker 的真实支付 outbox 消费器和 `OrderOutboxService`，在随机 schema 内处理正常、中断、过期租约和事务故障四单。每单最终生成 Supplier/平台子单各 1，`pay_count=1`、财务流水/交易各 1、状态日志 4、`pay_success` 1；中断与事务故障 Queue attempts 均为 `[1,2]`，过期租约应用 attempt 为 2，正常消息三次投递为 `completed + already-completed + already-completed` 且业务副作用不重复。故障 attempt 1 checkpoint 的根单/子单/财务/状态/拆分/付款次数全部为 0。Hyperdrive 还暴露连接启动 `search_path` 不可靠，测试隔离已改为白名单 schema 的事务级 `SET LOCAL` 并由 `current_schema()` 实证。最终 `public` 相关表行数、序列无差异，审计标记为 0；schema、临时 Worker、主 Queue 与 DLQ 全删除，主 Worker 未发布。
- 2026-08-14 发货/拒绝退款通知 outbox 审计：生产 `0084` 已增加 nullable `system_message.event_key`、唯一索引并把订单 outbox 约束扩展为支付、发货通知和拒绝退款通知三类；现有站内信 1 行/非 NULL 事件键 0，outbox 0 行，四类源通知模板 0。随机 schema 严格场景的业务/outbox 回滚、不可变重放、失败重试、并发租约、模板渲染、禁用抑制和精确一次消息全部通过，5 条事件完成、4 条消息、attempts `[1,1,1,1,2]`，公共九表和序列指纹不变。首次场景因 Hyperdrive 启动 `search_path` 未保留而把精确合成播种写入 `public`；已用多重守卫事务清理 6 用户、30 单、30 快照、12 退款和 18 模板，独立复核所有标记归零且未产生状态/outbox/消息。修正为事务级 `SET LOCAL` 和独立连接生命周期后严格重跑通过；schema、临时 Worker和一次性令牌均删除，主 Worker未发布。短信、公众号/小程序通知和小程序发货信息上报仍未迁移。
- 2026-08-15 外部通知投递账本审计：生产 `0085` 已增加 `order_notification_delivery`、6 个账本索引、3 个检查约束和 5 个微信身份/模板查找索引，表当前 0 行。真实 Hyperdrive 随机 schema 暂存短信 5、公众号 4、小程序 5、微信发货 3 共 17 条，mock 提供商结果为 `16 SENT + 1 UNKNOWN`；全部重放得到 `16 already-sent + 1 unknown`，没有第二次提供商调用，Queue 不含手机号/openid/载荷。过程中发现并修复事务外状态更新因 Hyperdrive `search_path` 落回 public、以及通用短信错误依赖验证码 Redis 两项缺陷。最终 schema 与审计标记为 0，public 13 表/序列指纹不变，临时 Worker 删除，主 Worker仍未发布；生产模板、openid、渠道配置和外部 secrets 仍为空。
- 2026-08-15 通知人工处置审计：生产 `0086` 已增加 `order_notification_delivery_action`，独立复核 3 个索引、2 个检查约束、表 0 行。随机 schema 的 `UNKNOWN→RETRYABLE/SENT/DEAD`、请求键重放幂等、3 条不可变动作和 Admin 目标/payload 脱敏全部通过，原 17 条渠道矩阵仍为 `16 SENT + 1 UNKNOWN` 且不盲重发。首次扩展因夹具插入遗漏事务级 `search_path` 且探针错误重试 HTTP 500，在 public 产生 4 条固定审计孤儿；已以多重守卫单事务精确删除，并用不可缓存实时查询确认投递、动作、孤儿和临时 schema 均为 0。修正后 public 14 表/序列指纹不变，临时通知 Worker 0；主 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，未发布。Admin 已有渠道/模板/投递/UNKNOWN 处置界面，但生产模板、openid、渠道配置和外部 secrets 仍为空。
- 2026-08-13 虚拟商品交付审计：支付 outbox 事务新增卡密/共享密钥交付。正式 Hyperdrive 随机 schema 内的卡库存竞争、补库存重试、重复消费、两 SKU 部分认领故障回滚和共享密钥场景全部通过；最终 4 单、6 张唯一卡、4 条交付状态，`public` 快照与审计标记均未变化。首次 canonical URL 的 1042 发生在数据库场景前，Preview URL 正式运行通过；schema、Preview/临时 Worker 已删除，令牌未落盘，主 Worker 未发布。
- 2026-08-13 虚拟卡密库存运营审计：正式 Hyperdrive 随机 schema 中运行 Admin/Supplier 真实服务，双连接并发同批导入、重放、租户拒绝、固定内容/实物门禁、仅密码行、保密响应、掩码、分页、精确库存/审计和历史 `store_id=0` 兼容全部通过；`public` 四表/四序列前后无变化且标记 0。测试配置为同区 Worker 显式启用 `global_fetch_strictly_public` 后再调用 canonical URL，未修改主配置；schema 与 `cinashop-vinv-audit-ccbf1edef0a141` 已删除，远端确认 Worker 不存在，主 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`。
- 2026-08-13 卡密库存风险告警审计：生产只读汇总为卡密商品/SKU/`store_product_virtual` 全 0；随机隔离 schema 中 Admin 精确得到缺口 1、低缓冲 1，游标 `201→202`，Supplier A/B 严格隔离，固定/实物排除且响应无秘密。既有并发导入等断言全通过，`public` 四表/四序列不变；schema/Worker 已删除，主 Worker 未部署。Admin/Supplier 告警页桌面与 390px 移动渲染、级别筛选、控制台和无横向溢出检查通过。
- 2026-08-14 卡密受控导出与生产 schema：PHP `getArr()` 直接返回全部卡号/密码的编辑回填已替换为 60 秒、角色/账号/Supplier/商品/SKU 绑定的一次性票据；只导出消费时仍未分配的卡，令牌只存摘要，明文响应固定 no-store 并只在内存下载。正式 Hyperdrive 随机 schema 的 29 个断言全部通过，双连接消费严格单赢家，重放/过期/跨租户均拒绝；隔离导出审计 3 行，清理后 `public` 0 行且业务快照/序列不变。生产 `system_virtual_inventory_export` 已确认 6 约束、5 索引、无秘密列，`public` 共 209 表；一次早期 apply 响应失败后表已存在，后续仅以幂等 apply 和独立查询确认最终状态，不把失败响应误报为回滚。临时 Worker/schema 均删除，主 Worker 未部署。
- 2026-08-13 DLQ 持久闭环与生产 schema：独立真实 Queue 复用生产归档/重放服务，支付消息连续失败两次后进入 DLQ，重复归档累计为 2 次，白名单重放只产生 1 次处理；短信验证码/手机号正确脱敏且禁止重放，只能人工处置。随机隔离 schema、临时 Worker、源 Queue、DLQ 和备份 DLQ 全删除。生产 `public.system_queue_dead_letter` 经完整事务回滚演练后实际应用，独立连接确认当前 `public` 为 208 表，归档表 26 列、6 约束、5 索引、0 行，原支付 outbox 行数和序列不变。主 `cinashop-api` 未部署，线上 `cinashop-order-dlq` 仍无消费者，待经批准发布后才会真正承载生产归档。
- 2026-08-13 正式发布前资源验收：创建 `cinashop-assets` R2 与 `cinashop-order-dlq-unarchived` 备份 Queue。先对 R2 进行 CLI 精确写读删，再用仅持有这两个 binding 的一次性 Worker 消费正式备份 Queue 合成消息并把 receipt 写入正式 R2，首次投递即 ack。合成对象、consumer、一次性 Worker 和本地探针均已删除；Worker URL 返回 404，R2 为 0 对象/0 B，Queue 为 0 producers/0 consumers。原订单 Queue/DLQ 绑定和主 Worker 100% 版本均未变化；仍须主 Worker 定向发布后才能验证真实附件接口和线上 DLQ 归档消费者。
- 2026-08-12 生产履约隔离集成：直接通过 Hyperdrive 在随机临时 schema 中运行合成订单，自提部分/最终核销、配送越权/送达、重复店员/配送员身份拒绝、未成团拒绝/成团放行、双连接同码并发、售后申请/核销双连接竞争和统一收货防绕过全部通过；售后竞争本次由售后获胜、核销在等待后由业务门禁拒绝，无锁超时或死锁。临时 schema 以 `to_regnamespace` 确认删除，`public` 业务行数和退款/核销/状态公共序列前后完全一致。一次性集成 Worker、令牌和本地执行器均已删除，URL 返回 404；没有部署主 Worker，也没有修改公共业务行。
- 2026-08-12 生产支付/取消隔离集成：直接通过 Hyperdrive 在随机临时 schema 中运行合成订单，取消状态日志故障和支付 outbox 故障均触发全事务回滚并可重试；双取消只恢复一次库存，支付/取消竞争本次由取消获胜，两个并发支付回调只产生一次 `paid` 和一条 outbox。所有竞争均由业务状态收敛，无锁超时或死锁。临时 schema 删除后 `public` 8 张表行数与状态/outbox 公共序列完全不变；一次性 Worker `cinashop-payment-cancel-it-20260812`、令牌和本地执行器均已删除，URL 返回 404；没有部署主 Worker。
- 2026-08-12 生产退款隔离集成：真实 `finalizeStoreOrderRefund` 通过 Hyperdrive 在随机 `codex_refund_it_*` schema 中运行；重复余额退款、资金账单失败回滚/重试、并发累计超额拒绝、精确全额收敛和第三方渠道金额绑定全部通过。过程中先以 Preview URL 绕过本账户 canonical `workers.dev` 的边缘 `1042`，再修正一次临时认证器把 `crypto.subtle.timingSafeEqual` 误写成全局函数导致的 `1101`；这些错误均发生在数据库场景外，相应 Worker 均删除。最终报告确认 schema 删除、`public` 11 张表行数及账单/状态公共序列不变；主 `cinashop-api` 保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。
- 2026-08-12 生产退款补偿守恒：纠正供应商部分退款逐笔舍入漂移，以累计目标减既有流水计算本次增量；同时把错误承载团记录 ID 的 `store_pink.is_refund` 从 `SMALLINT` 拓宽为 `INTEGER`，生产 2 行统计前后不变。扩展 Hyperdrive 场景对三笔 `3.33 + 3.33 + 3.34` 先强制供应商交易写入失败并验证全事务回滚，再确认积分 `7/5`、佣金 `0.12`、供应商 `0.05` 和拼团成员 `3→2` 全部精确收敛；团长退款后的最早成员接替、成员重归组和订单 `pink_id` 重写也通过。临时 schema 删除且 `public` 14 张表/6 条序列不变，临时 Worker URL 均为 404；主 Worker 版本未变。
- 2026-08-12 生产拼团超时重投恢复：失败团扫描新增“存在已付款且未全退订单”的恢复分支，消费端在订单锁下复用进行中退款并在完成后补齐精确剩余金额。Hyperdrive 隔离场景中两个成员的同一消息双连接并发与第三次回放只保留 2 条全额退款/2 条余额流水；使用 PHP 历史商品快照数组的 `3.00` 部分退款双商品订单补 `7.00`，兼容解析元素 `id`，两条记录分别保存不同 cart ID，完成后两个团均退出扫描。随机 schema 已删除，`public` 14 张表/7 条序列前后不变；临时 Worker 删除、URL 为 404，主 `cinashop-api` 仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。
- 2026-08-14 生产支付就绪与充值审计：只读探针确认微信、支付宝、余额和线下支付开关全部关闭，微信公开配置和主 Worker 支付 secrets 不完整；6 条充值记录中 5 条未付、1 条已付且无 `trade_no`，无重复订单号，异常历史行未修改。第二次只读探针确认生产启用充值档位为 0、畸形档位为 0，最低充值配置缺失；原硬编码虚构赠送档位已改为 PHP `system_group_data` 权威读取，旧充值首页响应契约已恢复。佣金转余额恢复 PHP 四账并以用户行锁、冻结额门禁和事务守恒加固；生产随机 schema 的冻结/并发/故障回滚断言全部通过，真实 3 用户佣金/冻结/可转聚合均为 0.00，开关与说明仍未复制。生产初始缺少的三个 `0082` 非唯一充值索引已在短锁/语句超时下幂等应用；带一次性查询参数的独立复核确认精确索引定义，6 行/已付 1/总充值 550.00/总赠送 0.00 全部不变，并识别出首次 DDL 后目录空结果是 Hyperdrive 读缓存而非回滚。随后临时 Worker 通过 Hyperdrive 在随机 schema 调用真实 `applyRechargePayment`，并发同回调得到 `paid + already-paid`、余额只增加一次且账单 1 条，错误金额/冲突交易号/重复订单全部拒绝；schema 自动删除，`public` 三表快照不变。再次复跑商品订单支付/取消完整场景，确认相同交易号并发幂等、不同交易号严格拒绝，支付/取消、余额/积分资金、outbox 故障和 0 元单全部收敛；所有临时 Worker 均已删除，主 Worker 保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。
- 2026-08-14 生产首单优惠审计：只读确认 3 个活跃用户均为 `is_first_order=0`，29 单中首单优惠单 0、首单与优惠券重叠 0，`newcomer_status`、`first_order_status`、折扣、封顶和新人时限六项配置全部缺失。随机隔离 schema 的真实服务端 quote 与建单核心确认预览/最终优惠均为 15 元，并验证封顶、与券互斥、订单/商品快照、取消不恢复、已支付历史/过期禁用、双连接并发单赢家和库存故障全回滚；`public` 快照不变，schema/Worker/一次性密钥均清理，临时 URL 为 404。主 Worker 仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批未发布。
- 2026-08-14 生产新人运营与注册赠礼审计：专用 Admin 服务以 16 键白名单、短事务、advisory lock 和锁内商品/SKU 复核替换配置、协议和活动目录；密码/微信注册把用户、标记、积分/整元余额、优惠券库存、用户券和领取证据合并到同一事务。生产只读确认 16 键、目录和历史赠礼证据全部为空，未写入或启用任何配置。正式 Hyperdrive 随机 schema 的 Admin 保存/替换/回滚、注册并发 exactly-once 和账本故障回滚全部通过；`public` 11 表全行指纹与 9 序列不变，schema、一次性密钥和临时 Worker 已删除且 URL 404，主 Worker 未发布。
- 2026-08-14 生产优惠套餐审计：只读确认套餐、关联项、`type=5` SKU/购物车/订单均为 0。正式 Hyperdrive 随机 schema 直接调用真实套餐购物车、建单、取消和退款服务，固定/任选规则、权威金额、免邮、并发最后限额单赢家、快照故障全回滚、部分/全额退款与不可退款门禁全部通过；`public` 行数和相关序列前后不变，schema、一次性密钥和临时 Worker 均删除，URL 404。主 Worker仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批未发布。
- 2026-08-14 生产优惠套餐 Admin 审计：临时 Worker 通过同一 Hyperdrive 在随机 schema 直接调用真实管理服务，固定保存、转任选、关系/活动 SKU 标识保留、移除项清理、标签/配送/表单字段往返、强制失败回滚、未来定时启用、主商品缺货拒绝/恢复和软删除全部通过。最终 `public` 套餐相关行/序列指纹不变，所有同前缀临时 schema 为 0，Worker 和一次性密钥删除；主 Worker仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，Admin 页面仅做本地桌面/390px 浏览器验收，本批未发布。
- 已通过 stdin 将 `DEBUG` 覆盖为 `0`，并分别生成、写入 256 位 `OPERATIONS_TOKEN` 与 `INTERNAL_CHAT_TOKEN`；值未打印、未落盘。远端 secret 列表确认三个名称均存在。
- 安全负向测试：GET `/_fix_admin` 与 GET `/_migrate` 返回业务状态 404；无令牌 POST `/_debug` 与 `/internal/chat_save` 返回 HTTP 403；未登录 `/ws/kefu` 返回业务状态 410000。没有调用迁移、种子、管理员写入或受保护内部写入。
- H5 production 部署为 `15330769-f7ef-4635-81f5-4e7b4e2dba4a`，Admin production 部署为 `00ac193e-be07-464e-8e77-b89295e9df7a`；两个生产别名和本次部署预览地址均返回 HTTP 200。H5 产物包含 `cinashop-auth` WebSocket 子协议，Admin 产物不再包含 `crmeb.com` 默认凭据提示。
- 支付宝密钥和安全管理员初始化 secret 未配置：无真实商户材料时保持支付宝不可用，避免伪配置；现有管理员密码也不会被自动改写。
- Supplier 新代码、财务/退款/outbox/普通与事业部分佣/事业部管理/收货奖励/付费会员/新人运营与注册赠礼/优惠套餐购买与运营/后台 ACL/商品管理/拆单履约、虚拟商品自动交付与卡密库存运营/告警/受控导出、门店/店员/配送管理、打印、供应商入驻/短信、附件/R2、抽奖、公众号、渠道码、旧批处理、小程序直播、对外 API、企业微信、公众号会员卡、员工小程序码，以及 2026-08-12 新增的系统表单下单、拼团支付/超时/退款状态机、店员/配送员扫码核销与相关前端仍未发布；相关 schema、导出审计表和 `so_verify_code` 索引已进入生产，但旧卡库存、源配置/目录和业务数据、账号、菜单规则及支付/小程序/打印/SMS/R2/微信资源仍未迁移。生产 Worker 继续保持已核验核心版本，避免暴露半可用入口。

## API-003 用户中心详细迁移审计（2026-08-28）

### 审计口径修正

此前 checklist 把“user 13”描述成地址、收藏、账单等 13 个业务域，逐路由复核后确认这是分组统计误读。修正 PHP 注释解析后，API-003 的权威范围是 13 条真正缺失的 `/api/user*` 精确合同：会员检测/激活表单 2 条，以及活动状态、客服扫码 GET/POST、客服会话摘要、个人中心、自资料、付款随机码、分享记录、分享口令、小程序推广码、推广海报 11 条。地址、收藏、账单、佣金、签到、积分、提现、发票和消息的大量合同在此前批次已有注册，不应重复实现，也不能因分组名相同而宣称它们完成。

路由审计器原先会把 PHP 注释中的 `Route::...` 当成合同。本批新增按原长度保留换行的 PHP 注释遮蔽器，能够跳过 `//`、`#`、`/* */`，同时不破坏字符串和源码行号；测试覆盖字符串内注释符与被注释路由。修复后排除 8 条伪合同：API 点赞 2、会员任务 1，Admin 文件读写 3，Supplier 核销 2。当前权威分母因此由 1,912 变为 1,904，而不是迁移代码凭空完成了 8 条路由。

### 会员等级安全审计

旧 PHP 的会员激活从配置读取表单，只把白名单资料写回用户并发放配置奖励，从不接受目标等级。迁移前 TypeScript 却接受请求体 `levelId` 并直接更新 `user.level`，任何已登录用户都能把自己提升到任意等级。这是本批最高风险缺陷，现已删除该输入：激活仅设置 `level_status=1`，可选资料严格映射 `real_name/sex/birthday/card_id/address/mark`；会员功能、激活开关、表单、积分、余额和优惠券配置从数据库快照读取。用户行、优惠券发行行和等级检测均在短事务内按固定顺序锁定；积分写 `user_bill.event_key=level_give_integral`，余额写 `user_money.type=level_add`，用户券和领取证据与库存扣减同事务。余额奖励保留 PHP 的整数截断语义，`2.75` 配置发放 `2.00`，避免迁移时静默改变财务结果。重复激活失败关闭，等级检测只根据服务端经验值升级。

生产 Hyperdrive 只读事实为 PostgreSQL 16.14、用户 3、已激活用户 0、可见等级 3、活动用户等级 0，激活积分/余额/券证据均为 0。9 个相关配置只有 `member_func_status=1` 存在，`level_activate_status`、激活表单和三类奖励配置均缺失，因此新代码当前会安全判定“无需/未开启激活”，不会在缺配置时发奖励。随机 schema 的真实服务验证首次激活成功、重复激活拒绝、资料越权字段被忽略、积分 `7→20`、余额 `10.25→12.25`、优惠券只发 1 张、库存只减 1、经验 `120` 依据服务端规则进入二级且两条历史等级记录存在，7 项断言全部为真。

### 个人中心与分享合同

新增个人中心服务和控制器后，9 条合同可执行：`/user/activity` 返回砍价/拼团/当前秒杀时段；`/user/record` 返回严格按当前 UID 限定、分页且安全签名图片引用的客服会话摘要；`/user` 聚合券、收藏、订单、充值/支出/提现、佣金、推广、等级、消息和访问统计；`/userinfo` 返回安全自资料；`/user/rand_code` 使用 Web Crypto 拒绝取模偏差的 6 位码并缓存 600 秒；分享在用户行锁内以最新 `user_bill` 实现 300 秒冷却；商品口令按 PHP 文本和 base64 商品 ID 生成；推广小程序码复用微信 access-token 刷新和图像大小门禁；推广海报读取 `spread_banner` 并回退 `routine_spread_banner`。复核中还发现最初把 `/user/record` 错接到 `/user/service/record` 的聊天正文选择器；两条 PHP 合同语义不同，现已拆分，避免“路由已匹配但响应错误”的假完成。

个人中心有意不复制两个 PHP GET 副作用：读取时生成 `bar_code`，以及满足阈值时自动把 `is_promoter` 改为 1。新接口只返回既有条码和计算出的 `spread_status`，身份变更必须走显式写流程。返回投影不包含 `pwd`、`account`、`uniqid`、`rand_code`、`add_ip`、`last_ip` 或 `clean_time`。生产 `public` 在单一 `SET TRANSACTION READ ONLY` 事务中用真实活跃用户和商品完成活动、个人中心、自资料、推广海报、客服会话摘要与商品口令烟测；6 类结构/敏感字段断言全部通过，个人中心返回 108 个兼容键，当前用户会话摘要 0 条，审计输出没有用户或消息 PII。随机 schema 另验证首次分享为 true、1 秒后重放为 false、数据库只有 1 条 `user_share` 证据，同一用户的 6 位付款码在 TTL 内复用；正式实现使用生产已配置的强一致 Upstash Redis，而不是最终一致的 KV，并以 `SET NX EX` 保证并发请求复用同一个赢家码。

旧 `GET/POST /api/user/code` 不具备可迁移的安全语义：调用方提供任意缓存键，GET/POST 都只检查存在性再写字符串 `0`；没有服务器签发且绑定目的/主体的一次性挑战、扫码者确认、回调验签、原子消费或重放账本。两条路由已精确注册并保持强制用户认证，但由 `userCodeUnavailable` 返回业务状态 501，计入“明确不可用”而不是可执行迁移。真正的扫码登录继续由 KEFU-001 建立完整挑战协议。

### Hyperdrive 隔离事故与最终状态

首次会员场景的播种直接使用了带启动级 `search_path` 的连接，Hyperdrive 没有保留该会话设置，导致 1 个固定审计用户、2 个固定等级、1 个固定券发行和 9 个固定配置误入 `public`；当时没有用户等级、积分/余额流水、用户券或领取证据。发现后立即停止场景，新增只接受严格固定 ID/标签的检查和清理入口，在单一事务内精确删除这些记录；遗留随机 schema 也按严格正则清理。随后所有隔离播种和校验都通过 `withTx` 执行 `SET LOCAL search_path`，并用随机 SQL 注释绕过 Hyperdrive 目录缓存。最终维护响应为临时 schema `before=[]/after=[]`，9 类 `public` 审计标记全部为 0。本轮后续一次原生 SQL `Date` 参数编码失败同样在 `finally` 删除 schema；改用显式 ISO 时间后完整场景通过。临时 Worker `cinashop-api003-user-level-audit` 每次均已删除，主生产 Worker仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布当前代码。

### 当前量化与未完成门禁

注释感知的静态审计现在为 PHP 1,904、Workers 1,272、精确匹配 580、可执行匹配 563、明确不可用 17、原始缺失 1,324、证据化退役 3、可执行缺口 1,321；精确/可执行覆盖为 30.5%/29.6%。`/api` 为 PHP 457、Workers 598、精确 210、可执行 208、不可用 2、可执行缺口 246；本批后 `/api/user*` 精确缺失为 0。119 个单元测试文件/689 项、双 TypeScript 配置、主 Worker 与 API-003 审计 Worker minify dry-run 均通过；主包为 2,383.27 KiB/gzip 589.41 KiB，审计包为 690.11 KiB/gzip 168.31 KiB。

API-003 仍不能标记整体完成：付款码只有签发端，TS 收银消费端尚未迁移；客服扫码登录等待 KEFU-001；生产缺微信小程序真实凭据和会员激活配置；旧 PC/UniApp 与五端浏览器 E2E、Linux Workers runtime、预发和正式发布都没有完成。下一批可进入 API-004 `/api/v2` 的真实客户端调用审计，同时保留这些门禁。

## API-004 `/api/v2` 首批兼容迁移审计（2026-08-28）

### 54 条权威缺口与客户端事实

迁移前 PHP `/api/v2` 共 58 条合同，Workers 只有抽奖 4 条精确匹配，因此缺口为 54。逐项扫描旧 `view/uniapp` 的 API 包装器、页面、组件和 store，以及新 `admin-ts`、`pc-ts`、`supplier-ts`、`uniapp-ts`、`kefu-ts` 后，结论不能简化成“v2 已废弃”：新五端只有 `uniapp-ts` 的 4 条抽奖仍直接使用 v2，但旧 UniApp 仍真实调用微信/小程序登录、发票、购物车、商品属性、DIY、优惠券、分销、客服记录、搜索和评价。促销商品/赠品两个包装器尚未发现页面调用，这只构成待退役证据之一，不能直接从 PHP 分母删除。

首批选择不依赖新增第三方凭据、且现有 TypeScript 服务已经具备主要状态机的 15 条合同：可选认证搜索列表、认证搜索清理、客服记录；用户发票列表/详情/保存/默认设置/默认读取/旧 GET 删除 6 条；订单补开发票/开票列表/开票详情 3 条；分销等级/等级任务 2 条；可选认证评价列表 1 条。鉴权边界逐条保持 PHP 的 `force=false/true`，评价适配器同时接受 v1 的 `:productId` 与 v2 的 `:id`，等级任务继续读取 PHP 实际使用的 query `id/level_id`。旧 GET 删除发票是有意保留的客户端兼容面，不作为新客户端推荐写法；v1 的 DELETE 合同继续存在。

### 发票合同、安全与 PostgreSQL 状态机

旧 PHP 发票详情调用 `getInvoice(id)` 时没有传 UID，已登录用户可按自增 ID 读取其他用户的开票抬头、税号、电话、地址和银行资料。新详情固定 `id + uid + is_del=0`，不存在或不属于当前用户时返回兼容空结构，不泄露记录是否存在。列表恢复 `header_type/type` 筛选、`is_default desc,id desc` 排序、页码和最多 100 条上限；v2 单独投影 `header_type/duty_number/drawer_phone/card_number/is_default/add_time` 等 snake_case，v1 继续返回现有 TypeScript 前端使用的 camelCase，避免修复旧端时回归新端。

保存恢复手机号、邮箱、企业电话、地址、银行和账号字段；手机号、个人/企业抬头和 15/17/18/20 位税号均在写入前验证，个人抬头会清空企业字段。相同 UID 下的 `name + drawer_phone` 查重、新增/编辑和默认切换由用户级 PostgreSQL advisory lock 串行化，不在持锁事务中调用外部服务。编辑、删除、默认设置全部再次按 UID 和有效状态限定；默认项只清理同一“抬头类型 + 发票类型”，与 PHP DAO 一致。删除也改为显式短事务，既保证隔离审计能强制 `SET LOCAL search_path`，也不依赖 Hyperdrive 不保证保留的启动级 schema 参数。订单补开发票继续使用既有订单发票服务的用户/订单/发票归属检查、订单级 advisory lock、退款状态门禁和重复申请阻断。

### 正式 Hyperdrive 证据

一次性 `cinashop-v2-compatibility-audit` Worker 绑定用户指定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产状态和合同读取均固定 `search_path=public`、`statement_timeout=30s`、`SET TRANSACTION READ ONLY`。PostgreSQL 16.14 当前有用户发票 2 条且均有效、订单发票 0、有效搜索历史 0、客服消息 3、有效分销等级 5、有效等级任务 0；真实用户上的发票列表、搜索列表、订单发票列表和商品评价四类调用都返回数组合同，抽样商品评价 2 条，审计输出不包含搜索词、发票资料或消息正文。

`user_invoice` 当前只有主键索引，针对不存在 UID 的发票列表计划执行 0.032ms、shared hit 7、read 0，表也只有 2 行，因此本批没有直接向生产添加投机索引；DATA-003 恢复真实数据后必须重跑该计划，并根据 `uid + is_del + is_default + id` 访问形状评估组合索引。随机 `codex_api004_*` schema 克隆生产 `user_invoice` 并创建独立临时序列，避免推进 `public` 自增序列；真实服务的新增、snake_case 投影、跨 UID 隔离、默认读取、重复拒绝和软删 6/6 通过，`public_state_unchanged=true`、临时 schema `0→0`。

验证过程透明记录了三个审计脚手架信号：首次把 Drizzle 事务句柄再次作为根连接开启事务，写场景在业务播种前以 `begin is not a function` 回滚；第二次证明 Hyperdrive 不保留自定义启动级 `search_path`，事务写入在临时 schema、非事务读取却回到 `public`，场景随后删除 schema；第三次连续调用时边缘返回瞬时 Cloudflare 1042。最终改为独立连接建 schema、所有写事务由服务执行 `SET LOCAL`、审计读取逐次用只读事务固定 schema、独立连接清理，并在实时 tail 下成功。成功隔离版本 `d1fedaa7-fa12-4ae0-9c31-ced25e50cfd2`，最终只读版本 `8d1dc88c-827d-4ebe-80c1-25a6f0a49e3c`；每次外层均删除 Worker，最终临时 Worker和 Secret均不存在，主 Worker未部署。

### 当前量化与剩余 39 条

静态审计现在为 PHP 1,904、Workers 1,287、精确匹配 595、可执行匹配 578、明确不可用 17、原始缺失 1,309、证据化退役 3、可执行缺口 1,306；精确/可执行覆盖为 31.3%/30.4%。`/api` 为 PHP 457、Workers 613、精确 225、可执行 223、不可用 2、可执行缺口 231；`/api/v2` 缺口从 54 降到 39。120 个单元测试文件/693 项、双 Worker TypeScript 配置、受影响 `uniapp-ts` 类型检查、主 Worker和审计 Worker minify dry-run均通过；主包 2,388.45 KiB/gzip 590.74 KiB，审计包 395.69 KiB/gzip 91.23 KiB。Windows runtime仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 39 条按依赖拆为：微信/小程序登录与手机号绑定 16；DIY/绑定/门店/换色/商品详情/城市 6；重置/列表/SKU/改数量购物车 4；新人/今日/可领优惠券 3；微信资料/分类资金明细/推广用户/推广收益与规则 5；促销商品/赠品/凑单 3；首页和关注状态 2。现有通用优惠券列表忽略 v2 的 UID、商品/品牌和排序条件，现有 v1 首页也不是 v2 响应的直接别名，不能为了降低路由缺口挂一个近似处理器。16 条认证合同需要真实微信凭据、code 一次性消费、手机号凭据解密、限流与重放保护，继续与 CORE-004 联合处理；其余按 API-004-DIY/CART/COUPON/USER/PROMO/HOME checklist 逐批完成。API-004 因此仍未完成。

## API-004-CART 四条购物车合同审计（2026-08-28）

### PHP 语义、旧客户端调用与修复边界

本批精确恢复认证 `POST /api/v2/reset_cart`、`GET /api/v2/cart_list`、`GET /api/v2/get_attr/:id/:type` 与 `POST /api/v2/set_cart_num`。PHP 的第二个 `get_attr` 路径参数虽然命名为 `type`，控制器实际把它当“是否回填购物车数量”的布尔标志；`productValue` 必须以逗号拼接后的 `suk` 为键，而不是 SKU `unique`。新适配器按 `suk` 建键，恢复 `product_id/product_stock/cart_num/small_image` 等旧端 snake_case 字段，同时兼容生产历史中 JSON 数组和逗号串两种 `attr_values` 存法；`productAttr[*].attr_value` 继续返回 `{attr,check:false}`。`storeInfo` 恢复自定义表单、预售/虚拟商品购物车按钮和价格类型，普通详情 SKU 也补回 `image/small_image`。

旧 PHP `resetCart` 在“目标规格购物车不存在”分支直接按客户端提供的 cart ID 更新，没有再次限定 UID、未支付、未删除、非立即购买和普通活动范围；`setCartNum` 查找已有行时也缺这些状态谓词，并可能把减法写成负数。新实现先以用户级 PostgreSQL transaction advisory lock 串行化同一用户的购物车写入，再在短事务中以 `FOR UPDATE` 锁定归属行，以 `FOR SHARE` 复核有效商品与普通 SKU，固定 `type=0/activity_id=0/store_id=0/is_pay=0/is_del=0/is_new=0/status=1`，数量只接受正整数且受 `SMALLINT` 与实时库存上限约束。换规格遇到目标行时原子合并并软删来源行；精确设置、增加、减少到零和空 `unique` 选首个 SKU 均保持 PHP 调用语义，但负数量、跨用户 ID、已支付/已删/立即购买行和失效 SKU 均失败关闭。事务内不调用 KV、支付或其他外部服务。

审计旧 v1 调用时还发现 `/api/cart/num` 的 PHP `type=2` 表示“传入商品 ID，服务端再找当前用户购物车 ID”，原 TypeScript 只接受 `id + cartNum`，会误把商品 ID 当购物车 ID且忽略旧字段 `number`。该兼容缺口一并修复，查找范围同样限定当前 UID 与有效普通购物车，最终修改仍由既有 owner check 和库存复核执行。v2 列表改成一次购物车查询、一次商品批量查询和一次 SKU 批量查询，不引入逐行商品/SKU N+1；等级价与有效付费会员价复用正式建单的整数分算法和相同开关/权益条件，`truePrice/vip_truePrice/price_type` 不再由展示接口另造一套浮点规则。

### 正式 Hyperdrive 只读与随机 schema 证据

一次性、摘要令牌保护的 `cinashop-v2-cart-compatibility-audit` Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产读取固定 `search_path=public`、`statement_timeout=30s` 与 `SET TRANSACTION READ ONLY`。PostgreSQL 16.14 当前 `store_cart` 共 27 行、有效普通购物车 2 行/2 个用户；71 个有效商品中只有 2 个商品有普通 SKU，共 2 行 SKU，普通商品属性为 0 行，另外 69 个有效商品没有任何普通 SKU。两条有效购物车的失效商品、缺失 SKU、非正数/超库存、重复 UID+商品+规格范围均为 0，普通 SKU 孤儿也为 0。真实购物车列表和真实有 SKU 商品的属性接口合同均通过，列表返回旧混合字段，`productValue` 实际以 `suk` 建键；当前生产抽样商品是单规格，因此 `productAttr=[]` 属于源数据现状而非读取异常。

`store_cart` 只有主键索引，整表连索引共 24,576 字节；不存在 UID 的完整列表谓词执行计划为顺序扫描加内存排序，执行 0.026ms、shared hit 1、read 0。当前仅 27 行时创建复合索引没有收益，本批没有改生产 DDL；但这也暴露生产次级索引与仓库初始迁移定义存在漂移。DATA-003 恢复真实购物车/规格数据后必须重新审计，并优先评估只覆盖有效普通购物车的部分索引 `(uid, add_time DESC, id DESC) WHERE type=0 AND activity_id=0 AND store_id=0 AND is_del=0 AND is_pay=0 AND is_new=0 AND status=1`，不能在小样本上预先宣称需要或直接创建。

随机 `codex_api004_cart_*` schema 克隆生产 `user/store_product/store_product_attr/store_product_attr_value/store_cart`，购物车使用 schema 私有序列，所有播种和读取都显式 `SET LOCAL search_path`。真实服务的初始列表、`productValue[suk]` 与属性结构、增加、换规格、创建目标规格后合并、跨 UID 拒绝、减至零软删，以及两条独立 Hyperdrive 连接同时给空规格购物车加一后收敛为单行数量 2，共 9/9 断言通过；最终三行测试购物车均软删，`public` 四张业务表行数前后不变，临时 schema `0→0`。首次部署版本 `ed72e01c-f43d-40a8-b9b4-75dade505f0e` 的三次连续边缘调用都在进入 Worker 前返回 Cloudflare 1042；改为低频单端点后，只读版本 `a176fda9-f24e-4641-8329-9119bc320203`、首轮合同/隔离版本 `c934c2a3-3a32-48ae-9206-e8055a1e7692`、扩展状态版本 `8c40974a-f9b7-4cb4-8b94-28c498453d68` 和最终并发版本 `40ec1799-f65f-46c7-b4ac-7660ca97711a` 均成功。每个临时 Worker 已删除，随机 schema 清理完成，主 `cinashop-api` 没有部署；独立部署列表复核生产仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。

### 当前量化与剩余 35 条

注释感知的静态审计现为 PHP 1,904、Workers 1,291、精确匹配 599、可执行匹配 582、明确不可用 17、原始缺失 1,305、证据化退役 3、可执行缺口 1,302；精确/可执行覆盖为 31.5%/30.6%。`/api` 为 PHP 457、Workers 617、精确 229、可执行 227、不可用 2、可执行缺口 227；`/api/v2` 精确缺口 `39→35`。121 个单元测试文件/698 项、双 TypeScript 配置、主 Worker 与 CART 审计 Worker minify dry-run均通过；主包 2,401.52 KiB/gzip 593.91 KiB，审计包 518.67 KiB/gzip 120.81 KiB。Windows runtime 仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 35 条为 AUTH 16、DIY 6、COUPON 3、USER 5、PROMO 3、HOME 2。CART 的精确静态缺口已归零，但生产 69/71 有效商品缺 SKU、商品属性 0、源 MySQL 未复制、旧 UniApp 页面已不在当前仓库、真实账号/真机/预发和正式发布均未完成，所以整个 API-004 和发布门禁仍不能勾选；下一批继续 API-004-DIY/COUPON/USER，AUTH 保持 CORE-004 的真实微信凭据与重放保护门禁。

## API-004-DIY 六条公开配置与城市合同审计（2026-08-28）

### PHP 权威语义与兼容实现

本批逐行核对 PHP `route/api.php` 的 v2 无需授权组、`v2/PublicController.php`、`DiyServices`、`CityAreaServices/Dao` 和 `CityArea` 模型，精确恢复 `GET /api/v2/diy/get_diy/:name?`、`bind_status`、`diy/get_store_status`、`diy/color_change/:name`、`diy/product_detail` 与 `cityList`。六条路由不挂认证中间件，与 PHP 的公开边界一致；没有把现有 v1 首页/导航或旧 `system_city` 近似别名成这些响应。源 `diy` 继续通过数据迁移 manifest 显式映射到目标 `system_dise`，不重新引入第二张运行时权威表。

默认 DIY 按 `status=1 + type=1` 读取，命名 DIY 按 `template_name` 精确读取；JSON 上限为 2 MiB，畸形 JSON 保持 `null` 而不是在 isolate 中无界解析。商品详情严格复刻 PHP `array_merge(default, array_intersect_key(saved, default))`：保存值可覆盖 19 个历史键，但未知键不会进入用户合同；商品分类则复刻 `array_merge(default, saved)`，保留合法扩展键。绑定、总门店、自提、导航、分类层级和商品视频开关统一读取现有 `SystemConfigService`，门店总开关缺失时按 PHP 默认 1、自提缺失按 0，返回仍是 `status/store_status/navigation/product_category_level/product_detail/product_video_status/product_category` 旧字段。旧 `get_thumb_water` 只在 `image_thumb_status` 开启时做提供商缩略图；生产该配置和 DIY 数据均不存在，本实现保留源媒体 URL，不伪造旧 OSS 变体，后续媒体迁移仍必须按私有 R2 合同验收。

`cityList` 接受旧微信导入地址的 `/省/市/区/街道` 形式，去掉一次 `北京市/北京市` 这类直辖市重复段，最多 8 段、每段最多 100 字。每段名称用参数化精确等值匹配，唯一 `LIKE` 模式只由已经确认的数字祖先 ID 生成，不允许用户 `%/_` 形成任意路径扫描；找到的目标和 `path` 祖先一次批量读取，所有祖先的一层 `children` 也只做一次批量查询，避免按返回行 N+1。缺地址返回“地址不存在”，首段未录入返回“地址暂未录入，请联系管理员”，均保持 PHP 业务失败信封。

### 正式生产只读与随机 schema 证据

摘要令牌保护的一次性 Worker `cinashop-v2-public-diy-compatibility-audit` 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产事务固定 `search_path=public`、`statement_timeout=30s` 和 `SET TRANSACTION READ ONLY`。PostgreSQL 16.14 当前 `system_dise=0`、有效首页 DIY=0、`type=3` DIY=0、重复 `template_name+type` 范围=0；`city_area=0`、根节点=0、最大层级=0、孤儿/自指=0。两表连索引分别占 32,768/24,576 字节，DIY 有 `system_dise_pkey/sd_template_type/sd_status_type`，城市有 `city_area_pkey/ca_parent/ca_path`。零行数据无法产生有意义的城市名称执行计划，本批没有向生产添加投机索引；完整城市从源库复制后应重跑名称/祖先计划，再决定是否需要名称索引。

本批 8 个相关配置中只有 `site_url` 存在，而且有 5 条历史值（最高优先值为 `https://cinashop-pc.pages.dev`，另有 4 条示例域名）；绑定、门店、自提、导航、分类层级、商品视频和缩略图配置均缺失。真实服务因此正确返回空首页/命名 DIY、`bind.status=false`、`store_status=0`、换色三个整数 0、商品详情/分类默认值以及空城市数组。该证据说明代码能在现有结构上读取并安全降级，但 `diy/city_area/system_config` 源数据尚未完成迁移，`site_url` 冲突仍归 DB-003 由运营确认，不能把默认响应记作内容迁移完成。

随机 `codex_api004_diy_*` schema 克隆生产 `system_dise/city_area/system_config`，所有播种和读取都在显式 `SET LOCAL search_path` 事务内完成。真实服务验证默认/命名 DIY、强制绑定、门店/自提、换色/导航/分类层级、商品详情未知键剔除、分类扩展键保留、四级城市链、重复直辖市段和缺失城市，共 10/10 断言通过；四级结果为“审计省/审计市/审计区/审计街道”，区级父项的一层 children 同时包含目标区和旁区。最终 `public` 三张表行数不变、`public_state_unchanged=true`、临时 schema `0→0`，审计版本 `87068c4f-6859-4240-8b28-8c930c987638` 和摘要变量随 Worker 一并删除。独立部署列表确认主 Worker 仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布本批代码。

### 当前量化与剩余 29 条

注释感知的静态审计现为 PHP 1,904、Workers 1,297、精确匹配 605、可执行匹配 588、明确不可用 17、原始缺失 1,299、证据化退役 3、可执行缺口 1,296；精确/可执行覆盖为 31.8%/30.9%。`/api` 为 PHP 457、Workers 623、精确 235、可执行 233、不可用 2、可执行缺口 221；`/api/v2` 精确缺口 `35→29`。122 个单元测试文件/702 项和双 TypeScript 配置通过；主 Worker minify dry-run 为 2,406.65 KiB/gzip 595.35 KiB，DIY 审计 Worker 为 371.74 KiB/gzip 84.56 KiB。Windows runtime 仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 29 条为 AUTH 16、COUPON 3、USER 5、PROMO 3、HOME 2。DIY 的精确静态缺口已归零，但生产 DIY/城市为空、权威配置未复制、旧 UniApp 页面已不在当前仓库，媒体 R2、真实账号/真机、预发和正式发布也未完成，因此 API-004-DIY 与整体 API-004 继续保持未勾选；下一批进入 API-004-COUPON/USER，AUTH 仍受 CORE-004 的真实微信凭据、一次性凭据和重放保护门禁。

## API-004-COUPON 三条优惠券合同审计（2026-08-28）

### PHP 权威语义、迁移列交换与只读边界

本批逐行核对 PHP `v2/activity/StoreCoupons.php`、`StoreCouponIssueServices`、DAO 与模型关系，精确恢复认证 `GET /api/v2/new_coupon`、可选认证 `GET /api/v2/get_today_coupon` 和 `GET /api/v2/coupons`。新人接口只读取新人券、空图片与 `add_time===last_time` 的首次展示标志；PHP 中“会员领取优惠券”调用已经注释，本实现不借兼容接口恢复隐含写入。今日券保持匿名/SVIP 可见 `receive_type in (1,4)`、普通登录用户只见 `receive_type=1`，按 Asia/Shanghai 当日 `add_time`、`sort desc,id desc` 最多 10 条；会员卡开关关闭或账户不是永久/未过期付费会员时均不得看到 SVIP 弹窗券。

数据迁移 manifest 有意把源 PHP `type`（0 通用、1 分类、2 商品、3 品牌）写到目标 `coupon_type`，把源 `coupon_type`（满减/折扣方式）写到目标 `type`，并把 `coupon_time/product_id/category_id/brand_id` 分别写到 `day/legacy_product_ids/legacy_category_id/legacy_brand_id`。原通用 `ActivityService.couponList()` 直接返回目标 camelCase 且忽略 UID、范围、计数和排序，不能别名。本批新增独立兼容投影，明确交换回源 `type/coupon_type`，恢复 30 余个 snake_case 字段、金额数值化、固定/领取后有效期、`used/is_use`、`products` 和 `[通用,分类,商品,品牌]` 四类计数；商品关系表存在时与编码范围对账，不一致沿用正式下单的失败关闭规则。

可领取条件保持 PHP 的启用/未删、剩余量或永久、领取窗口和使用窗口规则；`type=-1` 只看未来 24 小时结束的领取窗口。商品上下文一次读取商品、直接分类及其即时父级、品牌及其父级，再构造参数化范围条件；价格排序按源折扣方式计算，时间/默认排序继续叠加最终 `sort desc,id desc`。页面最多 100 条，新人券的历史无分页合同设置 1,000 条安全上限并在超过时失败，不允许无界内存响应。UID 领取记录、`store_coupon_product` 和四类计数并行批量读取；每券一件展示商品由单条 `LATERAL` 查询完成，没有逐券 N+1，也没有 `sql.raw` 拼接用户值。

### 正式生产只读与随机 schema 证据

摘要令牌保护的一次性 `cinashop-v2-coupon-compatibility-audit` Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产读取固定 `search_path=public`、`statement_timeout=30s` 和 `SET TRANSACTION READ ONLY`。PostgreSQL 16.14 当前 `store_coupon_issue=1`，但启用、手动领取、新人、SVIP 弹窗和当前有效模板均为 0；唯一模板的目标 scope 为 1。`store_coupon_user=4` 且孤儿为 0，`store_coupon_issue_user=0`、`store_coupon_product=0`，半开领取窗口、固定期缺结束时间和范围孤儿也均为 0。`member_card_status` 唯一值为 `1`。模板/用户券表连索引分别为 65,536/40,960 字节；生产现有模板索引为主键、`sci_claim_window/sci_scope`，用户券为主键和 `scu_uid_issue`。当前小样本的有效券计划是顺序扫描加排序，本批不凭一条模板创建投机索引；真实模板复制后应重跑领取窗口、UID 和 scope 计划。

真实用户、商品上的匿名列表、商品上下文列表、新人券、匿名今日券与登录今日券都返回兼容空结构，四类计数为 0，五项结构断言通过且未输出用户或商品标识。这证明新代码能直接读取生产 PostgreSQL 并在无可运营模板时正确降级；它不证明源优惠券数据已迁移。生产的 4 张历史用户券虽然都有现存模板引用，但两张无主键领取/商品范围证据表为空，而且没有启用模板，DATA-003/004 仍必须从源 MySQL 复制并做多重集、库存、领取窗口、范围和用户券对账。

随机 `codex_api004_coupon_*` schema 克隆生产模板、用户券、商品范围、商品/分类/品牌、用户和配置八张表。真实服务验证四类列表/计数均为 `[1,1,1,1]`，商品上下文仍匹配四类，精确商品券过滤只返回一条并恢复源 `type=2/coupon_type=2/product_id`，精确品牌页签按商品品牌及其即时父级返回一条；这有意修正 PHP 在 `type=3 + product_id` 分支丢失已派生品牌、转而错误检查 `product_id` 范围而使旧 UniApp 品牌页签为空的问题。已领券使用用户券起止日，四类券各返回一件适用商品；新人券只读且 `show=1`，今日券匿名 5、普通用户 4、永久 SVIP 5。11/11 断言全部通过，`public_state_unchanged=true`，临时 schema `0→0` 并删除。

生产隔离验证还发现并修复一处仅 PostgreSQL 执行时暴露的参数类型问题：批量样例商品 CTE 的独立 `VALUES ($1)` 被 postgres.js 推断为 text，与整数模板主键连接时报 `integer = text`，现显式转换为 `::integer`。首轮夹具 Date 参数序列化失败和定位该类型问题的事务都在创建 schema 的同一事务内回滚，后续 Worker 均在 `finally` 删除；一次调用收到边缘 1042 后，状态探针与初版隔离场景通过，加入品牌页签断言后的最终版本 `d1576fe4-0ff7-4c2f-902f-7412085c8011` 无重试错误完成全部 11 项断言。审计 Worker、摘要变量和随机 schema 最终均不存在；独立部署列表再次确认主 `cinashop-api` 仍 100% 运行 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有正式发布。

### 当前量化与剩余 26 条

注释感知的静态审计现为 PHP 1,904、Workers 1,300、精确匹配 608、可执行匹配 591、明确不可用 17、原始缺失 1,296、证据化退役 3、可执行缺口 1,293；精确/可执行/退役后有效覆盖为 31.9%/31.0%/31.1%。`/api` 为 PHP 457、Workers 626、精确 238、可执行 236、不可用 2、可执行缺口 218；`/api/v2` 精确缺口 `29→26`。123 个单元测试文件/709 项和双 TypeScript 配置通过；主 Worker minify dry-run为 2,419.33 KiB/gzip 599.08 KiB，COUPON 审计 Worker为 383.92 KiB/gzip 87.30 KiB。Windows runtime仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 26 条为 AUTH 16、USER 5、PROMO 3、HOME 2。COUPON 的精确静态缺口已归零，但生产没有启用/有效/新人/SVIP 弹窗模板，两张范围/领取证据表为空，旧 UniApp 页面已不在当前仓库，真实账号/预发/正式发布 E2E 也未完成，因此 API-004-COUPON 和整体 API-004 继续保持未勾选；下一批进入 API-004-USER，AUTH 仍受 CORE-004 的真实微信凭据、一次性凭据和重放保护门禁。

## API-004-USER 五条用户/分销合同审计（2026-08-28）

### PHP 权威语义、客户端证据与安全收敛

本批逐行核对 PHP v2 User/Agent 控制器、用户资金/佣金/提现服务及旧 UniApp API 包装器，新增认证 `POST /api/v2/user/user_update`、`GET /api/v2/user/wechat`、`GET /api/v2/user/money_list/:type`、`GET /api/v2/agent/agent_user_list/:type` 和 `GET /api/v2/agent/agent_info`。旧端确认 `user_update` 提交 `{userInfo}`；`user/wechat` 只有包装器，未发现当前页面直接调用；资金和推广页仍依赖路径 type、旧 snake_case 字段、`income/expend` 汇总、退款/提现状态文案及规则/收益轮播。

资料更新只接受 nickname/avatar/sex/language/city/province/country 白名单，在短事务内锁定当前 active 用户及其 routine 身份，同步核心昵称/头像、最后登录时间/IP和小程序完成标记，不允许客户端修改 UID、余额、积分、推广人或 openid。公众号刷新只接受一次性 OAuth code：服务端换取 openid、读取公众号订阅资料并以 OAuth 用户资料补全，再要求该 openid 已作为当前 UID 的 active `wechat` 身份存在才更新；客户端不能直接选择或占用其他账户 openid。缺配置、未绑定、身份不属于当前 UID 都失败关闭。

`money_list/:type` 恢复 0 全部余额、1 支出、2 收入、3 佣金、4 提现和 9 资金流六种旧合同；余额账批量读取退款/充值状态，佣金账批量读取提现状态，提现只返回 `extract/extract_money/extract_fail`，资金流只返回 type 1/7。所有列表都限定当前 UID、最多 100 行且不写资金。`agent_user_list/:type` 有意修复 PHP 控制器忽略路径参数、错误读取 query `type` 而使“已下单好友”页签失效的问题，type 1 现在精确筛选 `pay_count>0`；同时把 PHP `%H:%m` 中错误的月份占位修为真实分钟。`agent_info` 仅汇总当前 UID 的有效佣金收入，并以内连接 active 用户生成最多 10 条轮播，避免生产孤儿账留下空昵称或泄露无归属金额。

### 正式生产只读与随机 schema 证据

摘要令牌保护的一次性 `cinashop-v2-user-compatibility-audit` Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产读取固定 `search_path=public`、`statement_timeout=30s` 和 `SET TRANSACTION READ ONLY`。PostgreSQL 16.14 当前用户 3/active 3、微信身份 0，重复 active UID/channel 与微信孤儿均为 0；精确配置键和名称模式候选中都没有 WeChat/Routine AppID/Secret。余额账 0、资金流 0；佣金 7、提现 5、充值 6、退款 3 条分别全部是用户孤儿。推广用户 1 条、孤儿推广父级 0、已下单推广用户 0，分销协议 `type=2` 为 0。首个 active UID 的余额/支出/收入/佣金/提现/资金/推广列表都为空，佣金轮播经 active 用户内连接后也为空，规则和收益仍保持字符串合同。

`user_money`/`user_brokerage` 总关系大小分别为 24,576/81,920 字节；空余额账按 UID 倒序限 10 的计划为顺序扫描加排序。当前零行/小样本不支持投机增加索引，DATA-003/004 复制真实资金数据后必须重跑 UID、类型和时间窗口计划。尤其不能把 7/5/6/3 条孤儿账自动绑定给现有三个用户或直接删除：它们需要按源 MySQL 主键、UID、金额、订单/充值/提现关系和序列逐条对账。

随机 `codex_api004_user_*` schema 克隆用户、微信身份、余额、佣金、提现、充值、退款、资金流与协议九张表。真实服务完成 routine 资料、公众号资料、核心资料、外部身份不变、余额三类过滤、退款投影、佣金/提现/资金过滤、推广路径 type 和规则收益共 11/11 断言；合成计数为余额 3、佣金 4、提现 3、资金 2、推广 2、已下单推广 1、轮播 2。最终版本 `9b82c63c-f52c-4396-974e-1a6a2d624908` 返回 `public_state_unchanged=true`，临时 schema `0→0` 并删除，审计 Worker 和摘要 secret 也已删除。

隔离探针的前两次失败均发生在测试装置而非业务断言：第一次证实 Hyperdrive 不保证把连接启动级 `search_path` 保留给后续 autocommit 查询，第二次证实不能在显式外层事务数据库上再次调用依赖 `client.begin()` 的写服务。两次随机 schema 和 Worker 都在 `finally` 清理，`public` 没有合成写入；最终装置让写服务在限定 search path 的根连接中自行开启事务，读取使用显式事务级 `SET LOCAL`，完成全部断言和公共指纹核验。

### 当前量化与剩余 21 条

注释感知的静态审计现为 PHP 1,904、Workers 1,305、精确匹配 613、可执行匹配 596、明确不可用 17、原始缺失 1,291、证据化退役 3、可执行缺口 1,288；精确/可执行/退役后有效覆盖为 32.2%/31.3%/31.4%。`/api` 为 PHP 457、Workers 631、精确 243、可执行 241、不可用 2、可执行缺口 213；`/api/v2` 精确缺口 `26→21`。124 个单元测试文件/717 项和双 TypeScript 配置通过；主 Worker minify dry-run 为 2,431.47 KiB/gzip 602.58 KiB，USER 审计 Worker为 386.06 KiB/gzip 87.98 KiB。Windows runtime 仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 21 条为 AUTH 16、PROMO 3、HOME 2。USER 的精确静态缺口已归零，但生产微信身份、AppID/Secret、余额/资金流和分销协议为空，现有佣金/提现/充值/退款又全部是用户孤儿，旧 UniApp 页面已不在当前仓库，真实微信 OAuth、真实账号、预发和正式发布 E2E 均未完成，因此 API-004-USER 和整体 API-004 继续保持未勾选；下一批进入 API-004-PROMO，AUTH 仍受 CORE-004 的真实微信凭据、一次性凭据和重放保护门禁。

## API-004-PROMO 三条促销合同审计（2026-08-28）

### PHP 权威语义、客户端证据与收敛决策

本批逐行核对 PHP `route/api.php`、v2 `StorePromotions` 控制器、促销 Service/DAO、商品列表服务和模型访问器，恢复公开 `GET /api/v2/promotions/productList/:type`、公开 `GET /api/v2/promotions/give_info/:id` 与强制登录 `GET /api/v2/promotions/collect_order/product?promotions_id=`。旧 UniApp 源码只保留前两条 API 包装器，页面/组件未发现调用；编译产物因共享模块仍包含前两条 URL，但第三条 URL 不存在。这个证据说明当前 UI 依赖弱，却不足以退役 PHP 真实注册合同：促销规则仍参与商品、购物车和订单计价，因此选择恢复有边界的只读兼容接口，而不是从审计分母删除。

商品合同只接受当前时间窗内、`pid=0/type=1/store_id=0/status=1/is_del=0` 的平台父活动，支持促销类型 1～6、页码上限 1,000、每页上限 100、最多 200 个 active 活动和 5,000 个候选商品。参与范围精确恢复 1 全场、2 指定商品、3 排除整商品、4 品牌、5 商品标签；列表只保留上架、未删、审核通过、平台根商品和会员可见性。类型 1 价格按 PHP `bcdiv(discount,100,2)` 后 `bcmul(price,ratio,2)` 的两位截断语义计算；类型 1～4 返回 `promotions`，类型 5/6 分别返回 `activity_frame/activity_background`。赠品信息把父规则置于子阶梯之前，批量装配积分、券、赠品商品和普通 SKU；登录态凑单返回父规则及子阶梯，并对失效活动失败关闭。相较 PHP 原凑单实现未复核 active 状态、新实现有意阻止客户端用过期/停用 ID 浏览活动范围。

隔离场景第一次因 PostgreSQL 保留字列 `unique` 未加引号在夹具插入阶段回滚；修正后，第二次场景揭示一个真实的跨域缺陷：`StoreProductDao` 过去只用 `where.ids` 生成 CASE 排序，却因为搜索器缺少 `ids` 谓词而不产生 `id IN (...)`，所有显式商品范围都会静默扩散为全目录。统一商品搜索器现把 `ids` 参数化约束为正整数 `IN` 集合，空/非法集合失败关闭，同时保留原排序语义。该修复不仅服务促销，也修复推荐、关键词缓存复用等既有显式 ID 列表路径；PROMO 单测增加对应静态回归门禁。

### 正式生产只读与随机 schema 证据

摘要令牌保护的一次性 `cinashop-v2-promotion-compatibility-audit` Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产读取固定 `search_path=public`、`statement_timeout=30s/40s` 和 `SET TRANSACTION READ ONLY`。PostgreSQL 16.14 当前 `store_promotions=0`、`store_promotions_auxiliary=0`，父/子、active 平台父活动、活动/范围类型分布均为空；规则孤儿、辅助孤儿、辅助商品/券/SKU 孤儿均为 0。当前有 71 个可售平台商品，但品牌/标签商品关系为 0；促销主表/辅助表关系大小为 114,688/49,152 字节。active 活动计划命中 `sp_parent`，辅助范围计划命中复合索引；零行小表不支持新增索引。六类商品目录、赠品与凑单真实合同均按空数据返回兼容空结构，非法类型和非法赠品 ID 也失败关闭。

随机 `codex_api004_promo_*` schema 克隆促销、辅助、商品、商品关系、券、SKU 和用户七张表。真实服务验证全场/指定/排除/品牌/标签五类范围、85% 折扣截断、活动边框/背景、登录态四类凑单范围、父子阶梯、两级积分、赠券、赠品 SKU、过期赠品空对象与过期凑单拒绝共 12/12；六类商品目录长度为 `6/1/5/1/1/1`，赠品聚合为积分 2、券 1、商品 1。最终代码版本 `ada79730-c649-448c-bb25-431726bd1743` 返回 `public_state_unchanged=true`，临时 schema `0→0` 并删除；审计 Worker 和摘要 secret 已删除。两次失败探针均在事务回滚或 `finally` 后确认临时 schema 为 0，生产促销/商品指纹不变。

### 当前量化与剩余 18 条

注释感知的静态审计现为 PHP 1,904、Workers 1,308、精确匹配 616、可执行匹配 599、明确不可用 17、原始缺失 1,288、证据化退役 3、可执行缺口 1,285；精确/可执行/退役后有效覆盖为 32.4%/31.5%/31.5%。`/api` 为 PHP 457、Workers 634、精确 246、可执行 244、不可用 2、可执行缺口 210；`/api/v2` 精确缺口 `21→18`。125 个单元测试文件/725 项和双 TypeScript 配置通过；主 Worker minify dry-run 为 2,441.20 KiB/gzip 605.27 KiB，PROMO 审计 Worker为 969.20 KiB/gzip 175.06 KiB。Windows runtime 仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 18 条为 AUTH 16、HOME 2。PROMO 的精确静态缺口已归零，但生产没有任何促销规则/辅助范围或品牌/标签关系，旧 UniApp 页面调用缺失，源 MySQL 未复制，订单级促销叠加仍属于 API-006，真实账号、旧端、预发和正式发布 E2E 均未完成，因此 API-004-PROMO 与整体 API-004 继续保持未勾选；下一批进入 API-004-HOME，AUTH 仍受 CORE-004 的真实微信凭据、一次性凭据和重放保护门禁。

## API-004-HOME 两条首页合同与旧端关注合同审计（2026-08-28）

### PHP 权威语义、客户端证据与收敛决策

本批逐行核对 PHP `route/api.php`、v2 首页控制器、`StoreProductService`、`WechatUser` 查询以及旧 UniApp `api/public.js` 和首页关注组件。PHP v2 注册的是可选登录 `GET /api/v2/index` 与 `GET /api/v2/subscribe`；旧 UniApp 当前实际调用的却是 v1 `GET /api/subscribe`，该路由此前也未迁移。因此本批恢复三条精确合同：v2 首页只返回根字段 `info/benefit/likeInfo/subscribe/tengxun_map_key/site_name`，其中 `info` 只含 `fastList/bastList/firstList`；v2 关注接口匿名为 false，登录后只查询当前 UID 最新、未删除、`user_type=wechat` 的公众号身份；v1 关注接口保持旧组件的匿名 true，并在登录后查询当前 UID 最新未删除的任意来源身份。三条响应均为 `private, no-store`，避免把用户关注状态写入共享缓存。

PHP 的 `fastList` 读取 `pid>0` 的可见子分类，而既有 Workers v1 首页误取 `level=0/type=0` 根分类；该既有偏差一并修复。`fast_number/bast_number/first_number/promotion_number` 保持 PHP 的整数前缀语义，但增加 100 条服务端上限；精品、新品、促销和热门分别复用 `type=3/relation_id=3/4/2/1` 的权威推荐关系及商品会员可见性。既有 Workers 商品装饰还把预售压成两个状态，本批恢复 PHP `checkPresaleProductPay` 的四态：0 非预售、1 未开始、2 进行中、3 已结束。品牌和标签继续批量读取，不引入按商品 N+1。秒杀、砍价和拼团等运行中活动标签仍依赖 API-006，不因本批首页形状完成而被宣称已迁移。

### 正式生产只读与随机 schema 证据

摘要令牌保护的一次性 `cinashop-v2-home-compatibility-audit` Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产读取固定 `search_path=public`、短 statement timeout 与只读事务。PostgreSQL 16.14 当前有可见根分类 6、可见子分类 18、父级孤儿 0、自指分类 0、可售平台商品 71；旧 `is_hot/is_benefit/is_best/is_new` 标记和权威首页推荐关系均为 0，品牌/标签关系也为 0。六个相关配置只有一条启用且非空的 `site_name`（长度 8），四个数量配置及 `tengxun_map_key` 均缺失；`wechat_user` 总行数、active 公众号身份、已关注公众号身份及 UID 孤儿均为 0。分类查询因当前小表选择顺序扫描和排序，首页推荐关系查询命中 `spr_kefu_category_product` index-only scan；没有足够证据新增索引。

真实匿名与登录 v2 首页都返回精确六个根字段和三个 `info` 子字段，因生产配置/关系缺失，四类商品和快捷分类列表均为空；匿名首页 `subscribe=true`，登录首页为 false。独立调用中，匿名 v1/v2 关注分别为 true/false，真实登录账号的 v1/v2 都为 false，符合当前微信身份空集。这里的空首页内容是 DATA-001/配置运营缺口，不是迁移完成证据。

随机 `codex_api004_home_*` schema 克隆配置、分类、商品、推荐关系、品牌/标签和微信身份表。真实服务完成精确根形状、精确 `info` 形状、只返回子分类、精品、新品与预售四态、促销、热门、品牌/标签装饰、首页关注、v2 公众号身份选择、v1 旧组件差异和配置投影共 12/12 断言。最终代码版本 `5eb02811-8e80-438a-85ec-f5c6d62bbec5` 返回 `public_state_unchanged=true`，临时 schema `0→0` 并删除，审计 Worker 和摘要 secret 已删除。首次合同/隔离请求因审计 Worker 未提供 `CONFIG_KV` 绑定而在数据库动作前失败；补入只返回 miss 的内存 KV 后重跑通过。另一次 secret 更新遭遇 Cloudflare 控制面瞬时网络错误，对应请求为 403 且未进入数据库；这些探针都没有向 `public` 写入。

### 当前量化与剩余 16 条

注释感知的静态审计现为 PHP 1,904、Workers 1,311、精确匹配 619、可执行匹配 602、明确不可用 17、原始缺失 1,285、证据化退役 3、可执行缺口 1,282；精确/可执行/退役后有效覆盖为 32.5%/31.6%/31.7%。`/api` 为 PHP 457、Workers 637、精确 249、可执行 247、不可用 2、可执行缺口 207；`/api/v2` 精确缺口 `18→16`，另补回 v1 `GET /api/subscribe`。126 个单元测试文件/731 项和双 TypeScript 配置通过；主 Worker minify dry-run 为 2,443.49 KiB/gzip 605.68 KiB，HOME 审计 Worker为 978.94 KiB/gzip 177.70 KiB。Windows runtime 仍在 0 条断言前以 `workerd` 0xc0000005 失败，不能记为通过。

剩余 16 条全部属于 AUTH。HOME 的精确静态缺口已归零，但生产缺少四个数量配置、首页推荐关系、微信身份和地图 key，运行中营销标签仍属于 API-006，源 MySQL 未复制，真实微信、媒体、旧端、预发和正式发布 E2E 均未完成，因此 API-004-HOME 和整体 API-004 继续保持未勾选；AUTH 在取得真实微信凭据并完成一次性凭据、限流和重放保护前保持阻塞，下一批转入 API-005 `/api/pc`。

## API-005 `/api/pc` 22 条合同迁移审计（2026-08-28）

### PHP 权威语义、客户端使用与安全边界

本批逐行核对 PHP `route/api.php:571-604`、`app/controller/api/pc/*`、`app/services/pc/*`、旧 Nuxt PC 和当前 `view/pc-ts`。PHP 权威面共 22 条：4 条无登录路由、12 条可选登录读路由、6 条强制登录用户数据路由。旧 Nuxt 使用公司信息、微信 AppID/OAuth、banner、分类/商品/推荐、城市、二维码、购物车、资金、订单、收藏和售后；旧 `key/scan` 扫码块已被注释。新 `pc-ts` 已改用共享 v1 `/login` 、`/products`、`/cart/list`、`/user/balance`和 `/order/list` 等合同，没有继续暴露旧 PC 微信 OAuth UI。因此 22 条是迁移兼容面，不能因新客户端不再调用就直接删除。

`GET /pc/key` 生成一个未绑定请求方的缓存 key，`GET /pc/scan/:key` 在 key 被写入用户 `uniqid` 后可直接签发 token；旧 `wechat_auth` 又使用静态 OAuth state 且不校验一次性挑战。照搬会重新引入令牌窃取和登录 CSRF，所以三条路由精确注册为 501 `*Unavailable`，并指向已有 `/api/login`；`get_appid` 仅读取公开 AppID 和版本，保持可执行。这三条 501 是明确安全决策，不计入静态可执行覆盖；后续 CORE-004 必须以一次性挑战、扫码主体绑定、轮询授权、OAuth state/PKCE 或等价保护、限流和重放账本重建，不能只把 PHP 缓存逻辑换成 Redis。

### 兼容实现与迁移中发现的偏差

新 `PcCompatibilityService` 与独立控制器恢复了 PC banner、首页分类/商品、手机购买配置、付费会员/商品小程序码、商品列表/推荐/优品、城市树、订单支付轮询、公司/备案/友链、微信二维码和六条登录用户合同。购物车按 PHP 拆为 `valid/invalid`，余额 0/1/2、佣金 3、提现 4 复用已验证的旧账本投影，订单/收藏/售后返回旧 `list/count` 信封。六条个人数据路由全部 `force=true`，购物车、订单、收藏、流水和售后查询都以中间件 UID 作用域；PC 售后商品 POST 直接复用已有订单归属复核实现。小程序码只在 `product_phone_buy_url=2` 且存在真实小程序凭据时调用微信；H5 付费会员使用本地 SVG data URL，不写附件或暴露密钥。

审计同时确认共享商品列表并未等价迁移 PHP：`cid` 只查精确 relation ID，`sid` 和 `selectId` 未执行，`tid` 误用普通分类数组，`news` 误解为新品标签而不是时间排序，`type→status` 丢失，SVIP 用户仍被强制隐藏专属商品。本批修正为：`cid` 覆盖当前分类及 `path` 后代，`sid` 覆盖当前分类及直接子类，`tid` 精确叶子；`selectId` 先读 level 映射 `cid/sid/tid`；关键词强制 `pid=0`，`news→timeOrder`、`type→status`，PC 只返回 `product_type 0..3`，SVIP 身份放开专属可见性。这一修正也提高了共享 v1 `/products` 的 PHP 等价性。PC 订单搜索恢复订单号、姓名、手机、当前用户账号和商品名/关键词范围，同时保持根订单与售后状态的 PHP 分支。

### 生产 Hyperdrive 只读与随机 schema 证据

一次性 `cinashop-api005-pc-audit` Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。`/state` 和 `/contracts` 固定 `search_path=public`、设置短 statement timeout 并强制 `SET TRANSACTION READ ONLY`；`/isolated` 只在随机 `codex_api005_pc_*` schema 克隆表并播种合成数据。PostgreSQL 16.14 生产当前有可售商品 71、可见根分类 6，但 active `type=1/status=1` 分类关系 0、PC banner 0、`city_area` 0。17 个 PC 候选配置仅存在 `record_No/site_name/site_url` 3 个；微信开放平台 AppID、PC logo/友链/备案、微信二维码和小程序凭据都未就绪。生产还有开放购物车 2、可见订单 28、可见售后 3、商品收藏 1，余额流水 0。

真实公开合同在单一只读事务中返回商品 `count=71/page=5`；分类首页、banner、城市、四类推荐、优品和微信二维码为空，与当前数据/配置一致；不存在的订单状态为 false，倒计时受边界约束。该空结果是 DATA-001～006 与运营配置缺口，不是 PC 内容已完成的证据。本轮没有使用生产用户 token 调用六条个人数据 HTTP 路由，因此不宣称真实账号 E2E；其 UID 作用域由随机 schema 真实服务调用验证。

随机 schema 完成三级 `cid/sid/tid`、分类首页 `list/count`、PC banner、公司排序/logo、可展开城市、有效/失效购物车、余额流水、订单归属、收藏归属、售后归属、推荐标签、优品标签和付费会员 H5 二维码共 15/15 断言。最终 `public` 的商品/关系/分类/购物车/订单/售后/余额/收藏/配置九组指纹不变，临时 schema `0→0`，审计 Worker 删除后 URL 返回 404。第一次调度中 `/state` 已通过，但二次 secret 发布造成后续请求命中旧版本并返回 403，该 Worker 随即在 `finally` 删除，没有进入隔离写入场景。重跑改为首次发布一次性注入令牌摘要，全部通过后清理。

### 量化结果、测试与剩余门禁

注释感知静态审计现为 PHP 1,904、Workers 1,333、精确匹配 641、可执行匹配 621、明确不可用 20、原始缺失 1,263、证据化退役 3、可执行缺口 1,260；精确/可执行/退役后有效覆盖为 33.7%/32.6%/32.7%。`/api` 为 PHP 457、Workers 659、精确 271、可执行 266、不可用 5、可执行缺口 185。API-005 自身 22 条精确匹配、19 条可执行、3 条安全 501，静态缺口归零。127 个单元测试文件/737 项和双 TypeScript 配置通过；主 Worker minify dry-run 为 2,459.06 KiB/gzip 610.08 KiB，API-005 审计 Worker 为 684.39 KiB/gzip 169.71 KiB。主生产 Worker 仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布主 Worker。

API-005 仍不能标记整体完成：源 MySQL 未连接，active 分类关系、PC banner、城市和 14/17 候选配置未复制/确认；真实小程序 AppID/Secret 取码、安全 PC 微信登录、生产用户 token 六路由、旧 Nuxt 桌面/移动、新 `pc-ts`、预发、影子流量和正式发布都未验收。下一批可按 API-006 的 marketing/bargain/combination/seckill 子域继续，PC 登录与 API-004-AUTH 则继续受 CORE-004 的真实凭据、一次性消费、限流和重放门禁约束。

## API-006 营销/活动详细迁移审计（ACTIVITY 子批次，2026-08-29）

### PHP 权威面、旧客户端使用与缺口分组

本批对照 `route/api.php`、`StoreSeckill`、`StoreCombination`、`StoreBargain`、相应 service 及旧 `view/uniapp/api/activity.js` 和页面调用。API-006 在本批前共有 24 条精确静态缺口：秒杀 3、拼团 4、砍价 4、marketing 13。旧 UniApp 仍实际调用分享二维码、小程序码、拼团 banner/海报、砍价发起人/分享/海报，不能因新前端页面少就退役。本子批次精确收口其中 11 条：

- 秒杀：`GET /seckill/detail/:id/:time?`、`GET /seckill/detail_code/:id`、`GET /seckill/code/:id`。
- 拼团：`GET /combination/detail_code/:id`、`GET /combination/banner_list`、`GET /combination/poster_info/:id`、`GET /combination/code/:id`。
- 砍价：`GET /bargain/config`、`POST /bargain/start/user`、`POST /bargain/share`、`GET /bargain/poster_info/:bargainId`。

剩余 13 条是 marketing：新人 `product_list/detail/info/gift` 4 条，短视频列表/详情/商品、评论发布/回复/删除、评论关系和视频关系 9 条。这 13 条仍是待完成 checklist，不因 ACTIVITY 路由收口而并入“完成”。

### 兼容实现、安全边界与已修复偏差

H5 分享码使用校验过的 `site_url` 生成本地 SVG data URL；小程序码严格恢复 PHP 的 page/scene 映射，场景不得超过 32 bytes，仅在存在真实 `routine_appId/routine_appsecret` 时请求微信，返回内存 data URL 并限时缓存，不写入公开附件表或 R2 公开路径。公开 config/banner 与 H5 详情码保持可选登录；包含用户归属的小程序码、拼团/砍价海报、发起人和分享统计强制登录。拼团海报要求当前 UID 属于该团，砍价海报/发起人必须有实际参与记录，避免任意用户信息枚举。个性化响应统一 `private, no-store`。

砍价分享不复制 PHP 的响应后队列累加，而是在短事务中原子 `share+1` 后返回 post-increment 统计，订单统计只包含未删除活动订单。已有 `bargain/user/cancel` 只接受内部记录 `id`，而旧 UniApp 实际发送 `bargainId`；现在两者都支持且只能软删当前 UID 活动中的记录。旧我的砍价页需要的 `title/image/residue_price/pay_status/datatime` 和分页过去缺失，现已恢复，分页上限 100；帮砍列表补回 nickname/avatar。GET 列表对过期记录只做响应投影，不隐式修改数据。PHP 拼团 `detail_code` 还存在读错 id 和拼接 `type=3id` 的旧 bug，TS 按路径 id 和正确 `&` 组装，不复制已知错误。

需要特别区分“本批新增的 11 条精确合同”和“之前已被静态计为匹配的活动详情”。现有 `seckill/detail`、`combination/detail`、`bargain/detail` 在本批前就已注册，但 Workers 响应远比 PHP 简化；例如秒杀详情仍缺 PHP `storeInfo/reply/replyChance/replyCount`、已购数、收藏、配送/标签/保障、时段 `last_time/status` 与商品 SKU 信息。这些不会出现在“精确缺失路由”统计里，却是真实迁移缺口；已放入 API-006-ACTIVITY/CHECKOUT 的剩余响应与状态机门禁，是本项不勾选的另一原因。

### 生产 Hyperdrive 库存、合同和隔离状态机证据

一次性 `cinashop-api006-marketing-audit` Worker 绑定指定 Hyperdrive。生产目录审计固定 `search_path=public`、`SET TRANSACTION READ ONLY`、短 statement/lock timeout，只返回表/列/索引与非敏感计数。PostgreSQL 16.14 当前为：`store_seckill=1`、`store_seckill_time=3`、`store_combination=1`、`store_pink=2`、`store_bargain=1`、`store_bargain_user=4`、`store_bargain_user_help=0`；活跃秒杀/拼团/砍价均为 1，活跃团 1，活跃砍价参与 2，活动订单 7，已支付 3。生产只读真实 service 合同对 config/banner、秒杀/拼团 H5 码、发起人形状和有界列表 6/6 通过。

内容与配置缺口非常明确：`system_group=0`、`system_group_data=0`，所以 `routine_lovely` 和 `combination_banner` 均无数据；`routine_appId`、`routine_appsecret`、`share_qrcode`、`seckill_header_banner`、`bargain_subscribe` 均不存在有效值。这意味着小程序码当前安全返回空字符串，不是小程序分享已完成。marketing 数据面更严重：`store_newcomer=0`，而 PHP 短视频 9 条合同依赖的 `video` 和 `video_comment` 两表在生产完全不存在。因此 API-006-MARKETING 必须先补结构/源数据/私有媒体，不能先返回伪空结果再宣称迁移。

随机 `codex_api006_activity_*` schema 克隆 11 张必需表，使用真实 `ActivityJoinService` 验证砍价 config、拼团 banner、两类 H5 码、无凭据小程序码安全降级、拼团海报/归属拒绝、砍价发起人、海报/归属拒绝、分享原子统计、旧列表字段、取消归属及索引 DDL，14/14 通过。最终随机 schema 删除，11 组 `public` 业务表计数/主键和不变，临时 schema `0→0`。审计 Worker 每次都在 `finally` 删除，最终 URL 返回 404。早期两次隔离失败分别是在 Drizzle 事务上再开嵌套事务，以及 Hyperdrive 不保证传递启动参数 `search_path`；两次清理都成功且临时 schema 回到 0。最终方案在每个事务显式 `SET LOCAL search_path`，并让需要嵌套写事务的分享统计使用独立连接。

### 生产索引变更、量化结果与剩余门禁

审计发现生产 `store_bargain_user` 只有主键，与列表、发起、海报和取消的 `uid+bargain_id+status+is_del` 查询不匹配；活动订单统计也缺 `activity_id+type` 范围索引。外部 `0101_activity_compatibility_indexes.sql` 与 Worker 内嵌 `migration_0108` 现完全同步，且 schema 新建表定义也包含同名部分索引。经用户明确授权直接使用生产库后，一次性 Worker 以 3 秒 lock timeout、25 秒 statement timeout 应用 `sbu_uid_bargain_active` 与 `so_activity_type_visible`，同一 DDL 执行两遍幂等成功，11 组业务指纹不变，临时 schema 为 0。

注释感知静态审计现为 PHP 1,904、Workers 1,343、精确匹配 652、可执行匹配 632、明确不可用 20、原始缺失 1,252、证据化退役 3、可执行缺口 1,249；精确/可执行/退役后有效覆盖为 34.2%/33.2%/33.2%。`/api` 为 PHP 457、Workers 669、精确 282、可执行 277、不可用 5、原始缺失 175、可执行缺口 174；本子批次相对 API-005 精确/可执行各增 11。全量 128 个单元测试文件/744 项通过，双 TypeScript 配置通过；主 Worker minify dry-run 为 2,470.39 KiB/gzip 612.22 KiB，API-006 审计 Worker dry-run 为 1,519.22 KiB/gzip 269.29 KiB。Windows runtime 仍在 0 条断言前以 `workerd` 0xc0000005 失败，不记为通过。主生产 Worker 仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批未发布主 Worker。

API-006-ACTIVITY 仍不勾选整体完成：需从源 MySQL/运营补齐两组活动内容和小程序凭据，使用真实用户 token 与真实微信验证旧 UniApp，完成预发/影子流量并经明确批准后发布。API-006-MARKETING 的新人 4 条已在下一节收口核心代码与隔离证据；当前下一子批是仍受两表、源数据和私有媒体门禁的短视频 9 条。API-006-CHECKOUT 还必须另行审计活动资格、限购/库存、建单/支付、成团/失败、超时/取消/退款和奖励状态机。

## API-006 营销/活动详细迁移审计（MARKETING-NEWCOMER 子批次，2026-08-29）

### 精确路由、旧端调用和本批发现的假匹配

PHP 权威路由位于 `/api/marketing` 组：可选登录 `GET newcomer/product_list`、`GET newcomer/product_detail/:id`，强制登录 `GET newcomer/info`、`GET newcomer/gift`。旧 UniApp 的 `api/activity.js`、`api/store.js` 及新人列表、商品详情、首页新人模块、个人中心仍直接调用这四个带 `/marketing` 前缀的地址。Workers 此前已有较完整的 `StoreNewcomerService`，却只注册 `/api/newcomer/*`，所以业务代码存在并不等于 PHP 精确合同已迁移；本批新增四条原始路径，同时保留无前缀路径作为 TS 扩展别名，认证边界不变。

逐字段审计发现不能只加路由别名：列表过去按 `id asc`，PHP 是 `id desc`；未过滤 `store_product.is_verify=1`；`ot_price` 错误优先取活动表，而 PHP 选择活动 `price` 后合并基础商品关系，划线价来自基础商品。详情把 Drizzle camelCase 对象直接并入 `storeInfo`，旧端需要的 snake_case、品牌/描述/标签/保障、评价、配置均不完整；`productAttr` 被固定为空，`productValue` 又以 `unique` 为键，而旧 UniApp 用逗号拼接规格并按 `suk` 查表，因此多规格新人商品无法选择和下单。已购数也把子订单、已删除未付款单一并累计，`gift` 还错误携带只属于 `info` 的 `last_time`。

### 兼容恢复和安全边界

列表现按新人开关、专享开关、`is_newcomer`、注册时限和已支付新人单判断资格，分页限制为 1..100，按活动 ID 倒序，只返回未删除活动及已上架、未删除、审核通过的基础商品，活动价与基础商品划线价分离。详情保持 PHP 的可选登录浏览，但拒绝软删活动和不可售/未审核基础商品；返回旧端 snake_case `storeInfo`，活动 SKU 仍以 `type=7, product_id=store_newcomer.id` 读取并按 `suk` 建 `productValue`，价格取活动 SKU，库存取对应基础 `type=0` SKU 的实时值。规格维度来自基础商品并只保留实际参与活动的值；品牌、标签、保障、描述、收藏、最近评价/好评率、六项详情配置和顶级活动订单已购数均恢复。四条响应都设置 `private, no-store`，不让资格、收藏、礼包或用户券被共享缓存。

`info` 与 `gift` 继续保持 PHP 的差异：两者都只读配置和当前 UID 券，`info` 在新人总开关启用时返回协议及 `last_time`，`gift` 还要求注册时间等于最后登录时间且仍有专享资格，并且不返回协议和截止时间。没有恢复任何 GET 自动发券或写配置副作用。加入购物车和建单仍使用既有服务端资格复核、一件限购、活动/基础 SKU 对应和用户行锁内原子消费资格，不依赖展示响应。

### 生产 Hyperdrive 数据面与隔离合同证据

一次性 `cinashop-api006-marketing-audit` Worker 直接绑定用户指定的 Hyperdrive。生产盘点在 `search_path=public`、只读事务、3 秒锁超时和 25 秒语句超时下完成：PostgreSQL 16.14，`store_newcomer=0`、`store_product=71`、`store_product_attr_value=2`、用户 3、订单 29、用户关系 1；`newcomer_status/newcomer_limit_status/newcomer_limit_time`、注册积分/余额/券开关和值、首单开关/折扣/上限、`register_price_status` 共 13 个前台配置全部不存在有效值。生产已有 `store_newcomer_product_id`、`store_newcomer_active_id`、`store_newcomer_product_active` 三个索引，因此本子批无需生产 DDL。真实 `StoreNewcomerService` 的列表、info、gift 3/3 合同在只读事务中返回与关闭配置和空目录一致的安全空结构；这证明降级正确，不证明运营数据已迁移。

随机 `codex_api006_newcomer_*` schema 克隆 `cache`、新人目录、商品/属性/SKU/描述/品牌/标签/保障/关系/评价、用户/收藏/券/订单/配置共 16 张表，直接调用真实 service。合成场景验证 PHP 倒序与审核可见性、过期/已使用资格拒绝、未审核详情拒绝、`productValue[Red|Blue]`、基础 SKU `3/0` 实时库存、活动规格过滤、活动价 `9.90` 与基础划线价 `120.00`、品牌/描述/标签/保障/收藏/评价、六项详情配置、顶级订单已购数 `3`、info 的协议/截止时间和 gift 的字段排除，共 10/10 通过。清理后 16 张 `public` 表全行多重集指纹完全不变，临时 schema `0→0`；一次性密钥和 Worker 删除，URL 返回 HTTP 404。主 `cinashop-api` 始终保持 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。

### 量化、门禁和下一子批

注释感知静态审计现为 PHP 1,904、Workers 1,347、精确匹配 656、可执行匹配 636、明确不可用 20、原始缺失 1,248、证据化退役 3、可执行缺口 1,245；精确/可执行/退役后有效覆盖为 34.5%/33.4%/33.5%。`/api` 为 PHP 457、Workers 673、精确 286、可执行 281、不可用 5、原始缺失 171、可执行缺口 170；相对 ACTIVITY 子批精确/可执行各增 4。定向新人测试与既有新人测试 12/12、全量 129 个单元测试文件/750 项、双 TypeScript 配置通过；主 Worker minify dry-run 为 2,474.37 KiB/gzip 613.09 KiB，API-006 审计 Worker dry-run 为 1,573.72 KiB/gzip 280.81 KiB。Windows runtime 的既有 `workerd` 0xc0000005 环境故障仍不记为通过。

API-006-MARKETING-NEWCOMER 仍不勾选整体完成：源 MySQL 未连接，13 个前台配置、目录、`type=7` SKU、赠券和领取证据没有复制，生产无非空样本，也未使用真实用户 token 跑旧 UniApp/真机、预发或正式发布。下一个独立子批是短视频 9 条；生产完全没有 PHP 权威的 `video`、`video_comment` 两表，必须先恢复精确结构和迁移 manifest，明确视频/封面等媒体进入私有 R2 的对象键与签名读取边界，再实现列表/详情/商品、评论写入/回复/删除和关系状态机。

构建仍有两个信号：Admin/PC/Supplier 应用壳主包超过 1 MiB，需要后续继续按需引入和拆包；Workers runtime 测试池、隔离绑定与用例已经加入，但当前 Windows build 26200 即使已安装 VC++ x64 Runtime 14.51，最小无绑定 Worker 仍在加载测试前发生 `0xc0000005` 原生访问冲突，因此本轮只有 runtime 测试类型检查证据，不能声称 workerd 用例通过。项目当前锁定 Wrangler 4.122.0、`@cloudflare/vitest-pool-workers` 0.21.2、Vitest 4.1.10 和兼容的 Workers 类型包；下一步应在 Linux CI/另一台 Windows x64 主机复现并向 Cloudflare 提交最小案例，而不是继续把问题归因于 CinaShop 业务代码。

对于已经执行过旧迁移的环境，历史默认管理员密码不会被本次源码变更自动轮换，仍必须人工检查并更换。

## API-006 营销/活动详细迁移审计（MARKETING-SHORT-VIDEO 子批次，2026-08-29）

### PHP 运行时合同与“没有权威 DDL”的证据

PHP `route/api.php` 的 `/api/marketing` 组注册 9 条短视频合同：可选登录的列表、推荐详情、顶级评论、关联商品，以及强制登录的评论发布、回复列表、本人删除、评论关系和视频关系。旧 UniApp `view/uniapp/api/short-video.js` 仍逐条调用这些地址。控制器、`VideoServices`、`VideoCommentServices`、模型、DAO 与播放计数 Job 都存在且实际读写字段，因此不能把它们当作死代码退役。

但进一步证据推翻了上一子批“先恢复精确源表结构和 manifest”的假设：本地 `.version` 为 CRMEB-PRO v3.1.1，而本地 `public/install/crmeb.sql` 的 201 张表没有 `eb_video/eb_video_comment`；[CRMEB Pro v3.1.1 发布页](https://www.crmeb.com/ask/thread/51014)与[官方 v3.1 数据字典](https://doc.crmeb.com/pro_s/PRO_V3_1/16504)也没有两表定义。也就是说，发布包留下了可执行代码和客户端调用，却没有可复制的权威 DDL/源数据合同。本批据实际运行时读写字段创建保守的 Worker 兼容扩展：URL 采用 `varchar(2048)`，未知历史长度的描述、评论和逗号商品 ID 采用 `text`，不添加无法由源证据支持的外键或窄约束；两表不加入只对齐 PHP 201 张共享源表的数据迁移 manifest。

### 精确接口、媒体与状态机边界

新增 `ShortVideoService`、独立控制器与 9 条精确路由。列表按 `video_func_status`、`is_show=1/is_del=0/is_verify=1`、最大 10 条和 PHP 三类排序读取；恢复商品 ID 数组、可见商品数、站点名/logo、直播状态、用户点赞/收藏、上海时区日期和旧播放器临时字段，播放数通过 `waitUntil` 批量递增而不为每次播放制造 `user_relation` 唯一键冲突。推荐查询额外强制 `is_verify=1`，这是对 PHP 遗漏审核条件的有意安全修正。关联商品复用统一商品服务，只计算上架、未删、已审核商品，并恢复 `promotions={}` 与门店 `store_id`。

封面、视频、评论头像统一支持规范引用 `/api/assets/:id`，响应时用 `APP_KEY` 生成短时签名；历史 HTTPS URL 原样保留，不暴露 R2 对象键。所有 9 条响应都设置 `private, no-store`，包括为兼容旧客户端而保留的 GET 关系写入。当前上传服务仍只接受图片，且生产两表为空，所以这只是安全读取边界，不是视频媒体迁移完成证据；DATA-005 仍需取得真实对象和归属后迁入 `cinashop-assets`。

评论发布限制 500 个 Unicode 字符并拒绝控制字符；回复目标必须未删除且属于路径指定的同一视频，嵌套回复扁平到根评论。新实现不为旧兼容额外采集请求 IP 或推断城市，减少不必要 PII；删除只能由评论 UID 本人执行，并把视频评论计数非负回退一次。视频/评论的 `like|collect|share` 使用事务级 advisory lock、现有 `user_relation(uid,relation_id,type,category)` 唯一键和同事务非负计数更新，修复 PHP 检查后插入/删除再分离更新计数的竞态。

### 生产 PostgreSQL DDL 与随机 schema 证据

外部 `0102_short_video_compatibility.sql` 与 Worker 内嵌 `migration_0109` 字节等价，创建 `video` 18 列、`video_comment` 17 列，以及最新/默认/推荐列表、评论线程/归属 5 个部分索引。一次性 `cinashop-api006-short-video-audit` Worker 绑定用户指定的 Hyperdrive。生产写入前只读状态是 PostgreSQL 16.14、221 表/3,053 列/714 索引、短视频两表不存在、临时 schema 0。

先在随机 `codex_api006_short_video_*` schema 克隆配置、用户、关系、商品和直播间五张依赖表，应用同一 DDL 两遍并直接调用真实 `ShortVideoService`。12/12 断言覆盖审核可见性与排序、推荐模式专属过滤、规范媒体签名/历史 URL、关联商品审核过滤、推荐详情审核过滤、评论会员/回复投影、跨视频回复拒绝、嵌套回复扁平、本人删除、同一视频点赞的双连接并发 add/remove 收敛、评论关系与播放/评论精确计数。场景结束后五张 `public` 业务表逐行多重集摘要完全不变，临时 schema `0→0`。

隔离门禁通过后，生产事务设置 3 秒锁超时、25 秒语句超时、固定 `search_path=public` 和事务 advisory lock，执行同一 DDL 两遍均成功；最终索引复核又补上控制器默认 `order_type=0` 的 `sort DESC,id DESC` 部分索引，并用同一完整 DDL 再次幂等应用。最终生产为 223 表/3,088 列/721 索引/210 主键；两张新表合计 35 列、7 个含主键索引，均为 0 行。`system_config/user/user_relation/store_product/live_room` 的行数与逐行摘要执行前后完全一致。审计 Worker 删除后 URL 返回 404，随机 schema 为 0；主 `cinashop-api` 未部署。

### 量化结果与剩余门禁

注释感知静态审计现为 PHP 1,904、Workers 1,356、精确匹配 665、可执行匹配 645、明确不可用 20、原始缺失 1,239、证据化退役 3、可执行缺口 1,236；精确/可执行/退役后有效覆盖为 34.9%/33.9%/33.9%。`/api` 为 PHP 457、Workers 682、精确 295、可执行 290、不可用 5、原始缺失 162、可执行缺口 161；本子批精确/可执行各增 9。定向短视频与数据结构测试 40/40、全量 130 个单元测试文件/758 项、双 TypeScript 配置通过；主 Worker minify dry-run 为 4,465.06 KiB/gzip 840.54 KiB，审计 Worker为 1,221.79 KiB/gzip 214.88 KiB。Windows runtime 的既有 `workerd` 0xc0000005 环境故障仍不记为通过。

API-006-MARKETING-SHORT-VIDEO 仍不勾选整体完成：生产视频/评论为 0，没有权威源表、源行或媒体对象可复制，也没有后台短视频管理/视频上传合同；尚未用真实用户 token 跑旧 UniApp/真机、预发或影子流量，主 Worker未发布。下一批可转向 API-006-CHECKOUT 活动订单状态机；短视频真实内容与私有 R2 媒体作为明确数据/运营门禁继续保留，不能把安全空表解释为业务迁移完成。

## API-006 营销/活动详细迁移审计（CHECKOUT 活动订单状态机子批次，2026-08-29）

### PHP 权威语义与本批确认的迁移缺口

本批逐行对照 PHP `StoreCartServices`、`StoreSeckillServices`、`StoreBargainServices`、`StoreCombinationServices`、`StorePinkServices`、`StoreOrderCreateServices`、`StoreOrderSuccessServices`、`StoreOrderTakeServices`、`ProductCouponJob`、`OrderCreateAfterJob`、`StoreOrderRefundServices` 与 `StoreOrderDao::getBuyCount`。旧 UniApp 加购发送的是 `uniqueId`、`new/is_new`、`secKillId`、`bargainId`、`combinationId`、`storeIntegralId`、`newcomerId`，其中秒杀/砍价/拼团的 `unique` 属于 `store_product_attr_value(type=1/2/3, product_id=activity_id)`；Workers 此前只接受通用 `unique/type/activityId` 并要求 `type=0` 基础 SKU，因此旧端活动加购会失败。

更严重的是库存与价格层级。PHP 以活动 SKU 的 `suk` 关联基础 SKU，秒杀/拼团按活动 SKU 定价，建单同时扣活动主表、活动 SKU、基础 SKU和基础商品，未支付取消及未发货退款反向恢复这些层。原 Workers 按活动主表最低价计秒杀/拼团，只扣活动主表和基础库存；取消缺活动 SKU，退款除积分商品外也没有活动层回补，会造成多规格错价和活动 SKU 漂移。秒杀/拼团还缺 `once_num` 单笔限购与 `num` 累计限购的 PHP 语义；仅凭加购预检也无法阻止同一 UID 用不同幂等 key 并发绕过。砍价旧载荷的 `bargainId` 是活动 ID，不一定是参与记录 ID；历史完成态又同时存在 status 1 且已到最低价和 status 3 两种数据。

结算后置规则也有两个容易遗漏的边界。PHP 对所有 `type!=0` 营销订单把普通 `couponId` 静默清零，且除 PC 渠道外禁止营销订单使用 `offline`；原 Workers 会解析并核销秒杀/砍价/拼团的普通优惠券，也可能先创建订单再在线下支付入口报错。继续追踪支付/收货事件后确认：普通商品积分、实付返积分与分佣只在 `type=0` 结算，Workers 现有门禁一致；商品关联赠券仍由所有已支付商品订单触发，支付获得抽奖次数则只排除 `offline` 和 `type=8`，现有 outbox 逻辑也与 PHP 一致，无需误删营销订单的这些奖励。

### 实现收口与状态机边界

新增单一活动 SKU 解析器，以 `(activity_id,type,suk)` 严格映射 `(product_id,type=0,suk)`；同时接受旧活动 SKU unique、新基础 SKU unique，缺失或歧义一律失败关闭。购物车控制器恢复全部旧字段、PHP 优先级和 `cartId` 响应别名；加购与列表校验活动有效期/可见性、参与资格、四层库存和活动展示价，并把持久购物车规格规范化为基础 unique。

建单现以活动 SKU 作为秒杀/拼团权威价格及活动成本，活动名称、图片、赠送积分、固定运费和模板 ID 进入同源报价与不可变订单快照。秒杀/拼团读取 `once_num/num`；事务内先以 `hashtextextended('cinashop:activity-limit:type:uid:activityId')` 获取 advisory lock，再累计已支付订单与未删除未支付顶级订单，阻断不同 key 的竞态绕过。砍价同时按参与记录 ID或活动 ID定位当前 UID 唯一记录，兼容 status 1/3 但必须实际到最低价，主活动按购买件数而不是固定 1 扣减。

普通优惠券现对全部 `type!=0` 营销订单保持 `coupon_id=0/coupon_price=0`，不读取、不占用也不核销客户端提交的用户券；确认/计算兼容服务原本接收 `couponId` 却漏传给同源报价，本批同时补齐该字段，使普通订单确认页与最终建单继续使用同一张券，营销订单确认价则稳定为 0 券优惠。普通订单的首单/优惠券互斥、积分和运费报价路径不变。营销 `offline` 在建单服务内按 `from` 先验校验，非 PC 请求在订单 INSERT 和购物车认领前失败；支付服务及事务内 `offlinePay` 再做同一门禁，覆盖历史未支付订单和任何未来内部调用。收银台继续展示 PHP 原有的全局线下支付开关，最终是否允许由带渠道上下文的建单/支付入口权威决定。

创建对活动主表、活动 SKU、基础 SKU、基础商品四层分别使用带库存/配额谓词的原子 UPDATE；任何一层失败即回滚购物车认领和订单。取消从快照 ID 恢复四层库存/销量/配额，并恢复砍价参与记录；退款只沿用 PHP 的 `order.status=0` 未发货回库边界，但同样恢复四层。现有 `PinkLifecycleService/PinkTimeoutService` 已有未支付参团预留、团长行串行、支付激活、成团、超时失败、自动退款重试、发货门禁和退款后重新选主/重挂成员，本批复核后未另造平行状态机。支付过渡/outbox 的事务性和重放防护也由既有生产场景继续覆盖。

### 生产 Hyperdrive 数据审计与上线阻断

一次性摘要令牌 Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，所有生产读取固定 `search_path=public`、短 statement timeout 和只读事务。PostgreSQL 16.14 当前订单 29，其中普通/秒杀/砍价/拼团为 `22/2/2/3`；活动生命周期为秒杀未付/已付各 1、砍价未付/已付各 1、拼团未付 2/已付且已发货 1。购物车历史类型分布为普通/秒杀/砍价/拼团 `23/1/1/2`，当前有效未支付活动购物车为 0。

生产数据不能支持新状态机上线：`store_product_attr_value` 只有 2 行且全部 `type=0`，`type=1/2/3` 活动 SKU 为 0；秒杀 ID 7 为 `once_num=0,num=2,stock=quota=100`，拼团 ID 27 为 `once_num=0,num=0,stock=quota=100`，两项 active 配置都不满足 PHP 限购语义。7 个活动订单对应 6 个商品快照，6 个都没有 `activitySku`；其中 4 个是仍未支付、状态 0、未删除的订单，也全部缺活动 SKU 快照。新实现会安全拒绝不完整的新活动订单；缺快照历史单的可恢复性与处置方式由后续 CHECKOUT-DATA 子批逐行审计并补上严格兼容，不能据此发布主 Worker。另有 1 个已发货订单缺物流单号，是既有生产完整性缺口，不由本批改写历史状态。

### 隔离竞态、失败补偿与审计事故

真实 `StoreOrderCreateService` 场景在随机 PostgreSQL schema 中新增三类活动 SKU，活动 unique 与基础 `suk` 映射，并用不同活动价验证快照。秒杀并发库存只产生一个赢家且取消恢复四层；同 UID 两个购物车、不同 key、库存充足时仍只有一个订单，另一个明确被累计 `num=1` 拒绝；砍价以旧活动 ID 找到参与记录并恢复 status 3，携带一张有效普通用户券时订单仍为 `coupon_id=0/coupon_price=0.00`、用户券保持未使用；同一购物车以 H5 `offline` 建单明确被拒绝，目标 key 订单数为 0 且购物车 `is_pay=0`。拼团和积分取消也完整恢复，普通订单报价/建单、会员/券/积分/运费和支付后赠券原场景继续通过。

退款场景新增已支付未发货秒杀单，余额退款完成后基础商品、基础 SKU、活动 SKU、秒杀主表四层均从 `stock=9/sales=1` 恢复到 `stock=10/sales=0`，活动两层 quota 也从 9 恢复到 10；既有重复退款、失败回滚、超额/精确并发、纯积分、渠道金额绑定、佣金/供应商/拼团补偿、超时重投和客服决策全部通过。最终整套创建、支付/取消、退款场景的三个随机 schema 都 `schema_removed=true/public_state_unchanged=true`。

增强全行指纹时还发现测试夹具自身的隔离缺口：`member_right` 虽克隆到随机 schema，但 serial 默认仍绑定 `public.member_right_id_seq`，三次创建回放把生产序列从审计前的 3 消耗到 9，业务行没有变化。最终夹具把 `member_right` 纳入私有序列表；一次性修复 Worker仅在 `member_right` 精确为 1 行、max ID 1、固定全行摘要且序列精确为 9 时执行 `setval(...,3,true)`，首次错误的行数假设被前置条件拒绝且没有写入，收紧条件后恢复并读回 3。修复 Worker删除后 404。加入优惠券和线下支付门禁后的最终版本 `6db570d3-e641-4e79-888b-0437b8434dc3` 再次完成整套创建/支付取消/退款复验，三个随机 schema 均删除，生产活动/商品/购物车/订单/售后等表的全行摘要和所有公共序列前后完全相同，`member_right_id_seq=3→3`、临时 schema 0，审计 Worker删除后 URL 返回 404。最终成功前的一次边缘 `1042` 和一次错误认证头 403 都发生在场景入口之前，对应临时 Worker也均已删除。

### 验证结果与剩余 checklist

本地双 TypeScript 配置通过；130 个单元测试文件 761 项全部通过。Wrangler 4.122.0 主 Worker `deploy --dry-run --minify` 通过，体积 2,506.75 KiB/gzip 620.80 KiB；没有发布主 Worker。Windows Workers runtime 套件连续两次在 0 条断言前因 `workerd` 原生 `0xc0000005` 启动失败，按环境阻塞记录，不算通过；生产 Cloudflare 临时 Worker的真实运行结果提供了本批运行时证据。

API-006-CHECKOUT 的新订单代码和隔离状态机证据已经收口，但整体 checklist 仍不勾选。CHECKOUT-DATA 子批已继续证明本机没有可用源 MySQL/整库备份，并为缺快照历史单补齐拒付、取消和退款兼容；现存活动 SKU 与限购配置仍必须由源数据或运营确认，4 个未支付历史单仍需业务负责人批准实际取消。之后才能用真实旧 UniApp 用户、真实支付渠道、预发/影子流量验收，再经明确批准发布。不能伪造活动 SKU或猜测限购值。

## API-006-CHECKOUT-DATA 生产恢复性与历史订单处置审计（2026-08-29）

### 源数据可用性结论

本机当前进程没有 `SOURCE_MYSQL_URL`、MySQL/MariaDB 或其他源库连接变量；`cinashop` 与 `cinashop-php` 根目录均没有可用数据库 `.env`。PHP 仓库的 `eb_city_area.sql`、`eb_out_interface.sql` 和 `pc.sql` 只包含区域、Out API/PC 局部结构或数据，定向检查没有秒杀、砍价、拼团、活动 SKU、购物车或订单的业务 INSERT，不能充当整库备份。现有 `mysql-to-postgres.ts` 需要显式 `SOURCE_MYSQL_URL`，因此本轮没有可验证的源 MySQL 可供逐表回填。

生产查询仍只通过一次性摘要令牌 Worker 和 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行，事务设置 `search_path=public`、2 秒锁超时、20 秒语句超时和 `SET TRANSACTION READ ONLY`。投影不返回 UID、订单号、姓名、电话、地址或自由文本，只返回活动/商品 ID、稳定序号、状态、金额、SKU业务字段和聚合下界。最终只读结果的业务全行指纹 SHA-256 为 `3c6eca0625730aeb22c953525bf512acdeb244f5f4c5aa1f93d44700ea7e2d3f`；没有 DDL/DML。

### 当前活动、SKU 与限购证据

生产现存三项活动都指向商品 1：秒杀 7 为 `price=49.90,cost=0.00,once_num=0,num=2,stock=quota=100`；砍价 27 为 `price=99.90,min_price=59.90,cost=0.00,num=1,stock=quota=100`；拼团 27 为 `price=89.90,cost=0,once_num=0,num=0,stock=quota=100`。三者都只有一个可匹配的基础 SKU：`suk=默认,unique=sku00001,price=99.90,cost=0.00,stock=87,sales=63`，但活动 `type=1/2/3` SKU 仍为 0。

这个唯一基础 SKU 足以证明 `suk` 桥接不存在歧义，却不足以重建活动 SKU 全行：历史快照没有活动 SKU ID、成本、结算价、活动库存/配额或其他活动规格字段。现存活动主表可以提供展示价与总库存，但不能证明原活动 SKU 的逐规格配置。历史订单对单笔和累计限购只能给出下界 1，而且这些订单引用的是已删除活动 3/6/19/26，不是现存秒杀 7、拼团/砍价 27；因此不能用下界 1 猜写当前 `once_num/num`。

### 六个历史商品快照逐行结论

六行快照 JSON 均有效，但键形只有 `{product,sku}`，没有 `activitySku`；每行 `sku.suk=默认`、`sku.unique/订单行 sku_unique=sku00001`，都唯一匹配基础 SKU。`sku.price` 六行均为基础价 `99.90`，不是可靠活动成交价；好在每单都只有一行一件且优惠券、积分抵扣、促销抵扣均为 0，所以订单 `total_price/pay_price` 可证明各自实际成交金额。快照没有成本，不能证明历史活动成本。

| 稳定序号 | 类型 | 订单 activity 引用 | 解析后的活动主记录 | 支付/状态 | 商品总额 | 处置证据 |
| ---: | --- | ---: | ---: | --- | ---: | --- |
| 1 | 拼团 | 19 | 拼团 19 已不存在 | 未支付/状态 0 | 99.90 | 基础 SKU 唯一；活动层不可回填 |
| 2 | 拼团 | 19 | 拼团 19 已不存在 | 未支付/状态 0 | 89.90 | 基础 SKU 唯一；活动层不可回填 |
| 3 | 砍价 | 参与记录 3 | 唯一映射砍价 19，主记录已不存在 | 未支付/状态 0 | 59.90 | 参与记录 status 4；基础 SKU 唯一 |
| 4 | 秒杀 | 3 | 秒杀 3 已不存在 | 未支付/状态 0 | 49.90 | 基础 SKU 唯一；活动层不可回填 |
| 5 | 秒杀 | 6 | 秒杀 6 已不存在 | 已支付/未发货 | 49.90 | 退款只能恢复仍存在的基础层 |
| 6 | 砍价 | 参与记录 4 | 唯一映射砍价 26，主记录已不存在 | 已支付/未发货 | 59.90 | 退款只能恢复仍存在的基础层 |

四行历史活动购物车都已 `is_pay=1`，且 `activity_id=0`；它们只能证明当时使用基础 `sku00001`，不能补回活动 ID或限购。由此排除“把旧单映射到当前活动 7/27”方案：活动身份不一致，写入会污染当前库存和限购。

### 安全处置实现与隔离验证

所有未支付 `type=1/2/3` 订单现在在支付发起、余额事务、微信/支付宝/线下入口和最终支付回调事务中检查每个订单行的 `activitySku.id`、活动 SKU归属和活动主记录。历史缺快照单在任何资金/积分写入前返回“历史活动订单数据不完整，请取消后重新下单”；已支付幂等回放仍先按既有交易证据收敛。这个回调门禁意味着正式发布前仍必须先处置 4 个未支付单并确认没有在途渠道交易，不能把渠道已扣款后的回调拒绝当作客户处置方案。

取消只在三个条件同时成立时使用历史降级：订单类型为 1/2/3、活动主记录已不存在、快照为旧 `{product,sku}` 且基础 SKU ID可验证。事务仍恢复基础商品/SKU、购物车占用、积分/优惠券等现存资源；砍价参与记录唯一时恢复 status 3；不存在的活动主表/活动 SKU不伪造、不加到当前活动，并写 `用户取消历史失效活动订单并恢复现存占用资源` 状态。若活动主记录仍存在、快照是当前格式却缺 `activitySku`、基础 SKU不唯一或砍价参与记录不唯一，继续整单回滚并失败关闭。

已支付未发货退款采用同一证据边界：新订单继续要求并恢复基础商品、基础 SKU、活动 SKU、活动主表四层；只有已删除主活动的旧快照才恢复现存基础两层，退款资金、账本、累计金额和幂等证据仍走原统一事务。生产 Hyperdrive 随机 schema 实测历史拒付资金不变、历史取消完成且基础库存只恢复一次、状态证据写入；历史已支付退款首次 `completed`、重放 `already-completed`、余额 `10.00`、基础商品/SKU恢复且已删除活动保持不存在。原四层秒杀退款用例同时继续全部恢复，证明降级没有扩散到正常新订单。最终临时版本 `c9ca1f39-e693-4897-9527-8b1ed2649a81` 的创建、支付/取消、退款三个 schema 均删除且 `public_state_unchanged=true`；Worker 删除后 URL 返回 404/1042。主生产流量仍 100% 指向 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批未发布。

### 仍未完成的数据/发布门禁

- 现存秒杀 7、砍价 27、拼团 27 的活动 SKU 全行和秒杀/拼团限购必须来自源 MySQL、可信备份或运营明确配置；本轮没有猜写生产数据。
- 4 个未支付历史活动单已具备安全取消代码路径，但实际取消会改变客户订单和库存，仍需业务负责人明确批准，并应在主版本发布前完成且核对无在途支付。
- 2 个已支付历史活动单已具备可验证退款兼容，但没有自动发起退款或改写订单；是否退款继续遵循用户/客服业务决定。
- 真实旧 UniApp 用户、真实微信/支付宝/线下渠道、预发/影子流量、正式发布和发布后观察均未完成；正式发布仍需明确批准。

## API-004-AUTH / CORE-004 认证迁移详细审计（2026-08-29）

### PHP 权威合同、调用端与迁移前风险

PHP `route/api.php:437-469` 注册 16 条 v2 微信/小程序登录与绑定合同：`routine/auth_type`、`auth_login`、`auth_binding_phone`、`phone_login`、`binding_phone`，公众号 `wechat/auth_login`、`auth_binding_phone`，小程序 `routine_auth/silence_auth/silence_auth_login`，历史拼写错误 `auth_bindind_phone`，以及 `phone_silence_auth`、`wechat/auth`、`wx_silence_auth/wx_silence_auth_login`、`phone_wx_silence_auth`。旧 UniApp 的 `api/public.js`、`api/user.js`、`api/api.js`、登录/绑定组件、`libs/routine.js` 和 `App.vue` 仍调用这些合同；小程序使用 `auth_type→key→auth_login`，公众号只提交 `code/spread_spid`，多个绑定页仍把短信用途错误写成 `reset`。新 `uniapp-ts` 已使用 POST+Turnstile 短信流，但尚无真实微信社交登录 UI。

PHP 原实现把授权临时值放入两小时 MD5 缓存，未按用途绑定也不是一次性消费；短信仍共享 `code_<phone>` 命名空间，旧 GET `verify_code` 可签发未绑定手机号/用途的 nonce；AJCaptcha 路径可与短信流程混用。公众号 OAuth state 由客户端随机或固定生成，服务端不签发、不校验、不消费；小程序 session/手机号凭据也可在缓存期限内重放。迁移不能逐字复制这些弱点，因此旧客户端必须升级，无法在不降低安全边界的前提下做到完全透明兼容。

### 16 条精确合同与统一认证核心

本批精确注册全部 16 条 v2 路径，并新增 v1/v2 `POST /wechat/oauth_state`。小程序 `auth_type` 先用真实 `jscode2session` 解析服务端身份，再签发 15 分钟、来源网络绑定的一次性票据；`auth_login` 原子消费票据。手机号同时支持当前微信 `phone_code` 的服务端 `getuserphonenumber` 与旧 `encryptedData/iv`，旧格式在 AES 解密后还验证 `watermark.appid`；从不信任客户端直接提交的手机号。短信绑定只消费 `user_social_binding` purpose，不能拿注册、登录、重置、普通换绑验证码交叉使用。

公众号登录先原子消费 15 分钟、来源网络绑定的服务端 OAuth state，再交换 code；小程序登录 code、手机号 code 和公众号 OAuth code 分渠道做 SHA-256 摘要并以 Redis `SET NX` 全局占用 10 分钟，同一来源/渠道限制 30 次/分钟。provider 响应统一限制 8 秒和 32 KiB，只接受 JSON object，查询参数用 `URLSearchParams` 编码。临时社交身份、登录票据、state、旧 `session_key_uid` 均一次性消费；所有认证响应 `private, no-store`。社交身份与手机号在 PostgreSQL advisory lock 和短事务中确定性合并，拒绝跨渠道 openid、分裂 unionid、历史软删身份和手机号冲突；token 响应只返回 UID、昵称、头像、手机号、用户类型及 PHP 兼容别名，不返回密码摘要、账号或登录 IP。

旧 `GET /api/verify_code` 仅保留受限别名：必须在 query 明确提供 `phone+type` 并创建真实 Turnstile challenge，同时提示新客户端改用 POST，避免手机号进入 URL 日志。`GET /api/ajcaptcha`、`POST /api/ajcheck`、`GET /api/sms_captcha` 精确注册但返回 410 和迁移说明，未实现固定 200。Turnstile 核心继续校验服务端 Siteverify、action、cdata、hostname、时间窗和一次性 token，挑战绑定手机号、purpose 与 IP，验证码再按手机号/IP/全局频率限制并用 Redis GETDEL 消费。

### 生产 Hyperdrive 直接只读证据

用户明确授权直接使用生产数据库后，一次性 `cinashop-api004-auth-audit` Worker 绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。审计固定 `search_path=public`，使用 `REPEATABLE READ, READ ONLY`、30 秒 statement timeout、2 秒 lock timeout，只返回计数、配置存在性、索引与不可逆摘要，不返回手机号、openid、unionid、配置值或其他 PII/Secret。PostgreSQL 16.14 当前为用户 3、活跃用户 3、活跃且无手机号 0；`wechat_user` 总数/活跃数均 0，空 openid、孤儿、重复 openid、分裂 unionid 均 0；`sms_record` 总数/成功数均 0；临时认证 schema 为 0。

`routine_appId`、`routine_appsecret`、`wechat_appid`、`wechat_appsecret`、`store_user_mobile`、`store_user_avatar`、`verify_expire_time` 七个精确配置键均为 0 行，模糊候选配置名也为 0；`VERIFICATION_CODE_TIME` 短信通知模板不存在。生产 Worker Secret 清单只有 APP_KEY、DEBUG、内部/运维 token 与 Upstash Redis 两项，缺 Turnstile Secret、阿里云 SMS key/secret/sign/template 和微信凭据。`wechat_user` 的 openid/uid/unionid 相关索引以及 `sms_record` 的手机号/IP/结果时间索引均存在，本批不需要且没有执行生产 DDL。用户、微信身份、短信三组不可逆指纹在只读事务中获取；没有 DML/DDL。

审计临时 Worker 版本 `6382b911-31d4-4072-aec4-e7839e3598e3` 已在 `finally` 删除，删除后 URL 返回 404。主生产 Worker 始终保持 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布或切流。

### 量化验证与未完成门禁

注释感知静态审计现为 PHP 1,904、Workers 1,378、精确匹配 685、可执行匹配 662、明确不可用 23、原始缺失 1,219、证据化退役 3、可执行缺口 1,216；精确/可执行/退役后有效覆盖为 36.0%/34.8%/34.8%。`/api` 为 PHP 457、Workers 704、精确 315、可执行 307、不可用 8、原始缺失 142、可执行缺口 141；`/api/v2` 精确缺口为 0。本批相对前一批增加 20 个 PHP 精确匹配：16 条 v2 认证、旧 GET verify_code 和三条明确不可用 captcha 别名；新增 OAuth state 是安全扩展，不进入 PHP 匹配分子。

定向认证 16/16、全量 131 个单元测试文件/767 项、双 TypeScript 配置通过；主 Worker minify dry-run 为 2,524.86 KiB/gzip 624.84 KiB，认证审计 Worker为 50.11 KiB/gzip 18.78 KiB。Windows runtime 测试仍在加载断言前因 `workerd` 0xc0000005 原生访问冲突失败，测试数为 0，不能记为通过。

API-004-AUTH 与 CORE-004 仍不勾选整体完成：生产没有微信、短信和 Turnstile 凭据或非空社交/SMS 样本；旧 UniApp 必须先接入服务端 OAuth state、显式短信 purpose 和 Turnstile，错误使用 `reset` 的绑定页面必须修正；还需真实手机号/短信、微信开放平台/公众号/小程序真机、真实用户 token、预发/影子流量、正式发布和发布后观察。PC 与客服的扫码/OAuth 代码已在下一节按独立 CORE-004 子批重建，不再属于 501 缺口；但凭据、非空身份/客服数据、前端接入与远端 E2E 仍未完成，不能据此勾选整体完成。

## CORE-004-PC-KEFU 一次性扫码与开放平台 OAuth 迁移审计（2026-08-29）

### PHP 权威合同、调用端与迁移前风险

PHP PC 面精确注册 `GET /api/pc/key`、`GET /api/pc/scan/:key`、`GET /api/pc/get_appid`、`GET /api/pc/wechat_auth`；客服面有密码登录、`GET /kefuapi/key`、`GET /kefuapi/scan/:key`、`GET /kefuapi/config`、`GET /kefuapi/wechat`，用户端以认证 `GET/POST /api/user/code` 完成扫码确认。旧实现用 `md5(time+uniqid)` 生成一个缓存 key，并让同一个可见二维码 key 同时承担轮询 bearer；移动端把该 key 写入 `store_service.uniqid`，PC 又从 `user.uniqid` 读取，挑战没有 subject、audience、purpose、独立 poll secret 或可靠的一次性消费语义。旧 Nuxt PC 的 OAuth state 还是固定常量，扫码 UI 已注释；旧 UniApp 扫码页只实现客服文案，GET query 与 POST JSON 又使用同一 `code`。客服旧路径也没有在所有登录分支一致校验 `account_status`。这些弱点不能为兼容而复制。

新 `pc-ts` 目前只有密码/安全短信登录，新 `kefu-ts` 只有密码登录；本批没有伪造一个无法形成闭环的二维码页面。旧 Nuxt PC、新 PC、旧 UniApp 和新客服工作台都仍需接入下述新合同，故“后端可执行”不等于前端流程完成。

### Durable Object 扫码状态机

新增的扫码服务以随机 UUID 作为二维码公开 key，另生成 256 位私有 `poll_token`，DO 只保存其 SHA-256；挑战固定 `pc_user` 或 `kefu_agent` audience，状态严格按 `pending→scanned→approved→consumed` 推进并由 alarm 到期清理。创建和轮询分别使用 HMAC 后的来源 IP 做每分钟 20/180 次限制。认证用户通过 `GET /api/user/code` 首次扫码时绑定唯一 UID；客服 audience 还要求该 UID 唯一映射到启用、未删除且 `account_status=1` 的客服。`POST /api/user/code` 只允许同一 UID 批准，浏览器轮询必须额外提供二维码中不存在的 `X-Scan-Poll-Token`；错误 audience 不能消费批准，成功签发 token 后挑战只可消费一次。实现不再读写 `user.uniqid` 或 `store_service.uniqid`。

PC 的四条 PHP 精确合同现均可执行，并增加 `POST /api/pc/oauth_state`；客服新增可执行的 `key/scan/wechat` 和安全扩展 `POST /kefuapi/oauth_state`。PC 扫码成功后重新读取用户启用状态再发用户 token；客服则重新读取用户、客服删除/启用/账号状态及 UID 绑定再发客服 token，避免扫码后到轮询间的撤权竞态。

### 开放平台 OAuth 身份边界

开放平台 Web OAuth state 由服务端生成，15 分钟一次性、绑定来源 IP 与 PC/客服 audience；授权 code 按 SHA-256 占用 10 分钟并限制每 IP/audience 30 次/分钟。token 和 userinfo 响应均有 8 秒超时、32 KiB 上限，只接受对象 JSON 且必须取得 unionid。`wechat_open_app_id/wechat_open_app_secret` 直接从 PostgreSQL 精确读取，secret 不进入 CONFIG_KV 或响应。PC 只在校验后的 `user_type=pc` 身份上做确定性合并并重新验证账号；客服绝不自动创建账号，unionid 必须数据库级 `DISTINCT` 唯一映射到一个活跃用户，再唯一映射到一个活跃客服，任何分裂或歧义都失败关闭。

### 生产 Hyperdrive 只读审计与受控 DDL

一次性 Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，生产读取使用 `REPEATABLE READ, READ ONLY`、固定 `search_path=public`、30 秒语句超时和 2 秒锁超时，只返回计数、布尔配置存在性、索引及不可逆摘要。PostgreSQL 16.14 当前用户 3/活跃 3；`wechat_user` 总数/活跃/unionid/PC 身份均为 0，`store_service` 总数/活跃均为 0，旧两类 `uniqid` 扫码键均为 0；孤儿、分裂 unionid、多活跃客服绑定等指标也都是 0。后者只是因为表为空，不能充当真实身份或客服 E2E 证据。`site_name` 有唯一非空候选，而 `wechat_open_app_id` 与 `wechat_open_app_secret` 均为 0 行，因此当前生产开放平台登录会安全失败。

审计发现 `system_config` 缺少匹配精确读取顺序的复合索引，遂新增外部 `0103_system_config_lookup.sql` 与 Worker 内嵌 `migration_0110`：`(is_store,menu_name,sort DESC,id DESC)`。生产短事务固定 `search_path=public`、5 秒锁超时和 30 秒语句超时；首次应用及最终版本 `de92831f-b662-435e-bde3-2e7dda5b6803` 连续两次重复应用，执行前后均为 48 行、结构指纹均为 `796fd6f63ee478c5c919afc9140b235a`，每次精确读回同一索引定义，无 DML、无配置值返回。只读版本 `b318d80a-7979-4708-b11a-49d4545ad3a1`、首轮 DDL 版本 `4446f6ca-063e-43dd-a4fa-13dd8d012fa5` 和最终复核版本均已删除；最终 URL 返回 404。主生产 Worker 始终为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有部署或切流。

### 量化验证与未完成门禁

最新注释感知路由审计为 PHP 1,904、Workers 1,383、精确匹配 688、可执行匹配 670、明确不可用 18、原始缺失 1,216、证据化退役 3、可执行缺口 1,213；精确/可执行/退役后有效覆盖为 36.1%/35.2%/35.2%。`/api` 为 457/705、精确 315、可执行 312、不可用 3、缺失 142、可执行缺口 141；PC 22 条全部可执行，`/api/v2` 精确缺口为 0。`/kefuapi` 为 63/55、精确及可执行 51、缺失 12、退役 2、可执行缺口 10，有效可执行上限 83.6%。`ANY /kefuapi/ticket/[:appid]` 及 tourist 访客面仍是独立缺口，不能用扫码客服 token 绕过访客授权设计。

双 TypeScript 配置、定向 23/23、全量 132 个单元测试文件/771 项、PC 与 Kefu 生产构建均通过；主 Worker minify dry-run 为 2,541.75 KiB/gzip 629.14 KiB，审计 Worker为 94.09 KiB/gzip 24.03 KiB。新增 DO 完整状态转换 runtime 用例已通过类型检查，但 Windows `workerd` 仍在 0 条断言前以 `0xc0000005` 启动失败，不能记为 runtime 通过。

CORE-004 与 API-005 仍不勾选整体完成：生产没有开放平台 app id/secret、微信身份或客服账号，无法执行正向远端验证；旧 Nuxt PC 固定 state 与注释扫码 UI、旧 UniApp 扫码确认、新 `pc-ts/kefu-ts` 都尚未升级；真实浏览器/真机、真实用户/客服、预发、影子流量、正式发布与发布后观察均未完成。代码已消除旧缓存 bearer 和 501 缺口，但没有把这些外部与前端门禁伪装成完成。

## KEFU-TOURIST 游客安全内容与面单模板迁移审计（2026-08-29）

### PHP 权威合同、第一方调用与死路由结论

PHP 在 `route/kefu.php` 注册 8 条游客合同：`user`、`adv`、反馈 GET/POST、`order/:order_id`、`product/:id`、`chat`、`upload`；旧 Admin 客服 PC/移动组件实际调用这些合同。另有 `ANY /kefuapi/ticket/[:appid]` 指向 `Login/ticket`，但 111 行的 `app/controller/kefu/Login.php` 只定义 login、wechatAuth、getAppid、getLoginKey、scanLogin，既没有 `ticket()`，仓库也没有第一方调用。该路由已写入证据化退役清单，替代方向是认证用户现有客服会话合同；匿名会话必须另行定义签名访客票据，不能把一个不存在的 PHP 方法臆造成兼容实现。

旧游客实现不能原样迁移。`tourist/user` 匿名创建可猜的 9 位 UID，客户端可自行提交 `tourist_uid`；游客 chat/order/upload 又分别接收裸 API 用户 token 或客户端身份，旧 WebSocket 的 guest 方向与消息表 `is_tourist` 语义不一致。匿名反馈接受姓名、电话和正文却没有强一致频控；公开商品读取也没有强制未删除、上架和审核条件。当前 `ChatRoomDO` 只支持已认证用户和客服，且用户流固定 `is_tourist=0`，因此仅补四条 HTTP 路由无法形成安全游客实时闭环。

### 已恢复的四条身份无关合同

本批只恢复 `GET tourist/adv`、`GET/POST tourist/feedback`、`GET tourist/product/:id`。广告和反馈说明复用统一配置解析；公开商品新增 `is_del=0 AND is_show=1 AND is_verify=1` 权威门禁。匿名反馈兼容 PHP 的 `uid=0` 与 HTML 转义，但在写库前用 APP_KEY 对来源 IP 做 HMAC，DO 名不含原始 IP；每个来源每小时 5 次并叠加全局每小时 300 次强一致桶。四条公共响应均 `Cache-Control: no-store`。`tourist/user|order|chat|upload` 明确保留为缺口，下一步必须先完成短期签名访客会话、客服分配、订单/消息对象授权、R2 上传前缀和 WebSocket 协议，再补前端；没有生成随机 UID 或接受 API 用户 token 的临时兼容层。

认证 `GET /kefuapi/order/temp` 同批恢复。PHP 实际调用一号通 `v2/expr_dump/temp?com=...` 并由 PC/移动发货组件读取 `title/temp_id/pic/code`。新实现固定 `https://sms.crmeb.net/api/` 域和路径，carrier code 只允许有界字母数字、下划线、连字符，登录与模板响应均有 10 秒超时、32 KiB 上限、禁止重定向；Access/Secret 只来自 Worker Secret。该 GET 只读目录与已有不可逆面单签发 Queue/UNKNOWN 账本完全分离，不会因查询模板分配单号。

### 生产 Hyperdrive 与 Cloudflare 配置证据

一次性 Worker 直接绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，在 `REPEATABLE READ, READ ONLY`、固定 `search_path=public`、30 秒语句和 2 秒锁超时下只返回计数、布尔配置存在性、索引及结构指纹。PostgreSQL 16.14 当前商品 71、满足公开门禁 71；客服总数/活跃/在线均 0，反馈/匿名反馈/待处理均 0，客服会话/游客会话均 0，客服日志 3、游客日志 0。反馈与会话空集指纹均为 `d41d8cd98f00b204e9800998ecf8427e`，日志结构指纹为 `b0fd27713eca268241f89a78fbb1d4f2`。

`kf_adv`、`service_feedback`、`tourist_avatar` 以及 `config_export_open/id/temp_id/siid/to_name/to_tel/to_address` 全部为 0 行/无选中值；审计不返回任何配置值、反馈 PII 或聊天内容，也未执行 DML/DDL。主 Worker Secret 名单仍只有 APP_KEY、DEBUG、内部聊天/运维和两个 Upstash 项，`CRMEB_ONEPASS_ACCESS_KEY/SECRET_KEY` 不存在。因此四条游客内容合同会按当前空配置返回安全空值，而模板查询在生产明确失败关闭；这不是内容或第三方验收完成。临时审计版本 `e7e190c3-4454-4371-8cd0-d632fdcc23b2` 已随独立 Worker 删除，URL 返回 404；主生产 Worker 前后均为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，没有发布或切流。

### 量化结果、验证与剩余门禁

最新路由审计为 PHP 1,904、Workers 1,388、精确匹配 693、可执行匹配 675、明确不可用 18、原始缺失 1,211、证据化退役 4、可执行缺口 1,207；精确/可执行/退役后有效覆盖为 36.4%/35.5%/35.5%。`/kefuapi` 为 PHP 63、Workers 60、精确及可执行 56、原始缺失 7、退役 3、可执行缺口 4，有效可执行上限 93.3%。剩余四条精确为 `GET tourist/user`、`GET tourist/order/:order_id`、`GET tourist/chat`、`POST tourist/upload`。

双 TypeScript 配置、定向 21/21 和全量 133 个单元测试文件/778 项通过；主 Worker minify dry-run 为 2,545.81 KiB/gzip 630.16 KiB，审计 Worker minify dry-run 为 48.94 KiB/gzip 18.44 KiB。运行时仍受本机 Windows `workerd` 既有 `0xc0000005` 阻断，本批未把静态/Node 结果伪记为 Workers runtime 通过。KEFU-001～003 仍不整体勾选：生产没有客服账号、游客内容/面单配置或开放平台/一号通凭据，新 Kefu 工作台和旧 Admin 客服端尚未接入签名访客协议与新扫码/OAuth，真实 WebSocket、R2、第三方模板、浏览器/预发/发布验收均未完成。

## KEFU-VISITOR 签名游客会话与剩余四合同收口（2026-08-29）

### 旧 PHP 真实语义与迁移决定

对 `Common.php`、旧 Admin 客服页面、`appChat` 和 Swoole handler 逐项复核后，剩余四条并非同一种“游客权限”。`tourist/user` 在未登录时生成可猜的 9 位随机 UID 并交给客户端，真正匿名消息依靠客户端把该 UID 带进 WebSocket；`tourist/chat`、`tourist/order/:order_id` 和 `tourist/upload` 反而都解析裸 API 用户 token，其中 chat/order 读取登录用户的消息或订单，upload 也以登录 UID 做 100 次/日限制。把旧随机 UID 或客户端提交的 `tourist_uid` 原样恢复会允许身份冒用；把 visitor token 用于订单又会扩大匿名权限。因此新合同刻意拆开：`tourist/order` 只接受正常 `api` 登录并调用已有 UID 归属订单详情；`tourist/user/chat/upload` 使用独立、不可与用户/客服 token 混用的游客会话；另增加 `tourist/ws` 作为匿名实时闭环。旧客户端若仍把 API token 传给 tourist chat/upload，必须升级，服务端不提供弱兼容回退。

### 会话、客服分配与数据库边界

新增外部 `0104_kefu_visitor_session.sql` 与 Worker 内嵌 `migration_0111`。`kefu_visitor_uid_seq` 从 `1000000000` 起、上限为 PostgreSQL `INTEGER` 最大值，避免与当前用户 UID 空间碰撞并继续兼容旧消息表整数列。`kefu_visitor_session` 只保存随机 session UUID、visitor UID、权威 `service_id/kefu_uid`、SHA-256 token 摘要、非 PII 昵称/头像和创建/过期/最后活动/撤销时间；不保存原始 bearer、IP、消息或订单。24 小时 HS256 JWT 固定 issuer `cinashop-kefu-visitor`、audience `cinashop-kefu`、subject=session UUID，并同时复核签名、数据库摘要、UID、精确过期时间、撤销状态和唯一启用客服。创建前对 HMAC 后的来源执行 10 次/小时桶及 1,000 次/小时全局桶；短事务取得独立 advisory lock，在所有在线、启用且聊天 UID 唯一的客服中按当前活跃游客会话数和客服 ID 稳定选择。生产当前客服 0 行，因此不会生成无归属游客会话。

HTTP 使用 `X-Visitor-Token`，WebSocket 使用 `cinashop-visitor.<token>`；原始 token 在 Worker 中间件验签后即剥离，Durable Object 只收到 MD5 连接键、SHA-256 auth version、visitor UID 和绝对过期时间。正常用户继续使用 `cinashop-auth.<token>`，客服继续使用专用 kefu token，三种 token 域不互认。

### 实时、转接与 R2 对象作用域

实时角色从 user/kefu 两类扩为 registered user=1、kefu=2、visitor=3，主体分别命名为 `user:<uid>`、`kefu:<uid>`、`visitor:<uid>`。每个 socket attachment 增加不可变 `isTourist=0|1`；角色 1 只能为 0、角色 3 只能为 1，客服 socket 可按当前会话选择 0/1。数据库身份、目标、客服归属、advisory lock、消息插入、两向摘要、未读数、已读、在线状态、DO 投递和前端 reducer 全部同时匹配 UID 与 tourist flag，同一个数字 UID 也不能跨注册用户/游客命名空间串话。游客首次发送时才创建 `is_tourist=1` 客服摘要；游客历史只读取数据库会话所分配客服与该 visitor UID 的双向日志。

转接审计表增加 `is_tourist` 约束和 `(customer_uid,is_tourist,created_at,request_key)` 索引。游客转接在同一事务内锁定当前 visitor session、源/目标客服与两向会话，复制对应 `is_tourist=1` 历史、迁移摘要、更新 `kefu_visitor_session.service_id/kefu_uid`、删除源归属并写不可变审计；重放键同时绑定游客 flag。事务提交后，原客服、目标客服和 visitor DO 的事件也带作用域，旧 socket 会立即被权威数据库归属拒绝。

游客图片在读取 multipart 前执行每会话 30 次/日和全局 2,000 次/小时强一致限流，沿用 10.25 MiB 请求、10 MiB 文件、魔数/MIME 双校验。R2 键固定为 `attachments/visitor/<visitorUid>/<年>/<月>/<UUID>`，附件元数据为 `type=3/relation_id=<visitorUid>/module_type=4`，与用户 `module_type=3` 和客服 `module_type=2` 分离；消息落库前再次验证 owner，日志只保存规范 `/api/assets/:id`，响应才投影短时签名地址。

### 前端闭环

`view/uniapp-ts` 客服页在登录用户时保留 `/api/user/service/record`、用户 WebSocket和用户 R2 上传；未登录时创建或复用本地 visitor token，调用 `tourist/user`、`tourist/chat`、`tourist/ws` 和 `tourist/upload`。游客 WebSocket未连接时不会把消息错误回退到登录用户 REST 写接口。`view/kefu-ts` 同时加载 `is_tourist=0/1` 两页会话，切换命名空间时重建带 flag 的客服 socket；游客资料不调用用户详情、标签、订单或商品派生接口，只展示匿名会话身份，图片、消息与转接保持游客 flag。会话 reducer新增相同数字 UID 的跨作用域回归测试。

### 生产 DDL、指纹与临时资源证据

专用认证迁移 Worker 绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。随机 `codex_kefu_visitor_*` schema 先执行转接和游客完整 DDL，插入一条仅存在于临时 schema 的合成会话，验证首个 UID 精确为 `1000000000`，再执行同一 DDL第二遍并整笔回滚；最终 `schema_removed=true`。生产事务固定 `search_path=public`、3 秒锁超时、30 秒语句超时和迁移 advisory lock。首次提交后的即时元数据复核曾返回一次结构可见性误报；独立只读状态确认 DDL已完整原子提交而非部分结构。随后同一 DDL连续再应用两次均返回 `applied=true/business_fingerprint_unchanged=true`。

最终生产为 224 张表；新游客表 0 行、11 列、6 个约束、5 个索引，独立序列存在；`store_service_transfer.is_tourist`、检查约束和作用域索引均存在。执行前后客服 0、客服会话 0、客服日志 3、订单 29，`store_service/store_service_record/store_service_log/store_order` 行数与逐行摘要完全一致。状态/验证 Worker `cinashop-kefu-visitor-state-67dd06f6fd` 与 `cinashop-kefu-visitor-verify-f243641c76` 均已删除且 URL 返回 404；主生产 Worker仍 100% 使用 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布或切流。

### 最新量化结果与待完成 checklist

路由审计现在为 PHP 1,904、Workers 1,393、精确匹配 697、可执行匹配 679、明确不可用 18、原始缺失 1,207、证据化退役 4、可执行缺口 1,203；精确/可执行/退役后有效覆盖为 36.6%/35.7%/35.7%。`/kefuapi` 为 PHP 63、Workers 65、精确/可执行 60、原始缺失 3、退役 3、`actionableMissing=0`，退役后有效可执行覆盖为 100%。这表示有实现决策的客服路由缺口已清零，不表示客服业务数据或生产运行完成。

全量 134 个 Worker 单元测试文件/781 项、双 TypeScript 配置、Kefu 7 项 reducer/作用域测试与生产构建、UniApp 类型检查和主 Worker minify dry-run均通过；主包为 2,562.30 KiB/gzip 634.18 KiB。历史 Windows Workers runtime仍受 `workerd 0xc0000005` 阻断；现由提交 `b09c2c9bb823219f68f76ac40b4f25d2d46f15b3` 的 [GitHub Actions 33373018752](https://github.com/cinagroup/cinashop/actions/runs/33373018752) 在 Ubuntu 24.04/Node 24.14.1 真实 workerd 运行 1 文件/10 项并全部通过，其中两项覆盖 ChatRoomDO 非法握手拒绝、101 子协议、tagged attachment、驱逐/恢复、错误 token 不撤销和精确 token `4001` 撤销。`setOnline/setDisconnected` 在同 isolate 中替身以禁止测试访问 PostgreSQL，因此该证据关闭 WebSocket/DO runtime 缺口，不替代 Hyperdrive 消息持久化正向 E2E。

- [x] 完成剩余四条 PHP 精确合同的安全权限拆分、签名游客会话、客服分配、实时/未读/转接作用域和独立 R2 owner。
- [x] 在生产 PostgreSQL 16.14 随机 schema 验证 UID 序列、约束、重放和回滚，并对生产完整 DDL执行至少两次幂等复核；业务指纹不变，临时 Worker/schema 已删除。
- [x] 接入新 UniApp 未登录客服页和 Kefu 工作台游客会话；注册用户订单与游客 token 保持严格分离。
- [ ] 从源 MySQL 复制并人工复核客服账号/bcrypt 密码/UID 绑定、会话/消息、话术/分类和游客内容。生产当前客服与会话均为 0，3 条历史消息仍需来源对账。
- [ ] 以受限测试客服和匿名浏览器/真机验证创建限流、token 过期/撤销、WebSocket hibernation、图片 R2、未读、并发发送与游客转接；当前空客服数据无法提供正向生产 E2E。
- [x] 以 PC `/service` 替换旧 Admin 项目中面向顾客的 `appChat`，移除 URL bearer 与客户端自报 `tourist_uid`，接入签名游客会话并完成本地桌面/移动浏览器合同验收。
- [ ] 完成旧 `appChat` 生产退流与真实账号/游客兼容验收；补齐开放平台与面单配置/Secrets 后再验证扫码/OAuth和模板目录。
- [x] Linux runtime WebSocket/DO：真实 101 握手、hibernation attachment 驱逐/恢复与 token 撤销已由 Actions `33373018752` 通过；Windows `0xc0000005` 降为本机环境缺陷。
- [ ] 完成预发、影子流量、明确发布批准和发布后观察；主 Worker与前端当前均未发布。

## KEFU-PC 旧 appChat 安全替换审计（2026-08-29）

### 源客户端与协议结论

旧客户聊天入口不在商城 PC 工程，而是嵌在 `cinashop-php/view/admin/src/pages/kefu/appChat`。它本质上是面向顾客的公开聊天页，不是客服监管后台：匿名客户端自行生成/携带 `tourist_uid`，WebSocket URL 还会附带 token 查询参数。随机数字 UID 不能证明会话所有权，URL bearer 也会进入代理、访问日志和历史记录；因此这段实现不能原样搬运，也不能用旧合同兼容层继续接受客户端声明的游客身份。

新入口落在 `view/pc-ts` 的 `/service`。已登录用户继续读取 `/api/user/service/record`，通过 `/api/ws/kefu?type=1&to_uid=...` 与 `cinashop-auth.<token>` 通信，并只在 socket 不可用时调用注册用户 REST 发送；未登录用户创建或复用服务端签发的 visitor token，通过 `X-Visitor-Token` 调用 `tourist/user|chat|upload`，WebSocket 固定 `/kefuapi/tourist/ws` 与 `cinashop-visitor.<token>` 子协议。游客 URL 不含 token 或 `tourist_uid`，断线时明确失败而不会落入注册用户写接口。页面只按文本节点渲染普通消息，图片只接受消息类型 3，不使用 `v-html`；订单信息仍限定登录后的订单域。

### 代理、转接与浏览器验收

Vite 的 `/api`、`/kefuapi` 都启用 WebSocket 代理；Cloudflare Pages Functions 分别提供同源代理，并在上游返回 101 时直接保留 WebSocket 对象，避免把升级响应重建为普通 HTTP。注册用户 URL 中的 `to_uid` 由服务端会话选择；客服转接提交后，Durable Object 会把当前用户/游客 socket attachment 的 `toUid` 原子更新到新客服，PC 收到 `to_transfer` 后只更新界面身份，后续消息继续由数据库归属与更新后的 attachment 双重校验。

本地浏览器先用失败关闭合同返回“暂无客服人员在线，请稍后联系”：桌面和 390×844 移动视口均完整显示错误与“重新连接”，没有白屏、框架异常或控制台错误。随后用只接受 `/kefuapi/tourist/ws`、拒绝查询参数 token/`tourist_uid`、并要求 `cinashop-visitor.mock.visitor.token` 子协议的受控 WebSocket mock 做正向验证；服务端记录 `SOCKET_PROTOCOL_OK`，页面显示签名游客、在线客服与欢迎消息，合成文本点击发送后只回显一次，控制台仍为空。该结果证明前端合同和同源 WebSocket 路径，不代表生产真实客服、Hyperdrive 持久化或 R2 已做正向 E2E。

### 数据边界、验证与待完成 checklist

本批重新核查迁移工具所需连接条件：`SOURCE_MYSQL_URL=false`、`TARGET_POSTGRES_URL=false`，旧 PHP 根目录没有 `.env`，本机没有 3306 监听或 MySQL/MariaDB 服务。生产 PostgreSQL/Hyperdrive 已在上一批直接完成 `0104` 幂等 DDL与业务指纹复核，但源库不可达时无法可信复制客服账号、密码、UID 绑定、会话/消息、话术/分类和游客内容；本批未写生产业务数据、未部署主 Worker或前端。

路由量化保持 PHP 1,904、Workers 1,393、精确匹配 697、可执行匹配 679、明确不可用 18、原始缺失 1,207、退役 4、可执行缺口 1,203，覆盖为 36.6%/35.7%/35.7%；客服域 60/63 可执行，余下 3 条均有源证据退役，`actionableMissing=0`、有效覆盖 100%。Worker 双 TypeScript 配置、134 个单元测试文件/782 项、PC 生产构建和 Pages Functions 编译通过；新增客服 chunk 为 CSS 4.40 KiB/gzip 1.46 KiB、JS 10.83 KiB/gzip 4.78 KiB。PC 主入口仍为 1,099.76 KiB/gzip 365.76 KiB，是全局性能待办而非本批回归。Windows runtime 的 `workerd 0xc0000005` 仍未解决，但已由 Ubuntu Actions `33373018752` 的 ChatRoomDO 真实握手/hibernation/token 撤销覆盖替代为受支持主机门禁；生产客服数据、R2 与 Hyperdrive 正向流程仍未完成。

- [x] 完成旧 `appChat` 身份/传输/渲染审计，并在新 PC 同时接入注册用户和签名游客协议。
- [x] 保留 Pages/Vite WebSocket 升级，验证 URL 无 bearer/随机游客 UID，游客断线失败关闭且发送不双写。
- [x] 完成桌面、移动安全失败态和受控正向签名游客 WebSocket/消息单次回显浏览器验收。
- [ ] 取得只读源 MySQL 连接后运行 `schema-audit → plan → copy → verify`，由运营复核客服密码、UID 绑定、消息/会话和内容；当前连接条件缺失。
- [ ] 在生产补入受限测试客服后验证真实 visitor bootstrap、Hyperdrive 消息、WebSocket hibernation、R2、未读、转接、过期/撤销与限流；再完成旧页面退流、预发、影子流量和明确发布批准。
- [ ] 继续处理全局 1,203 个可执行路由缺口、PC 主包拆分、ERP 与移动端长尾；客服路由有效 100% 不等于全站迁移完成。

## CORE-004-PC-KEFU 扫码/OAuth 安全续审与三端登录闭环（2026-08-29）

### 生产 PostgreSQL 直接只读证据

用户明确授权直接使用生产数据库后，专用临时 Worker `cinashop-pc-kefu-login-audit` 仅绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。审计事务固定为 `REPEATABLE READ, READ ONLY`，只读取聚合计数、布尔配置存在性和索引元数据，不返回配置值、手机号、openid、unionid、token 或其他 PII/Secret，也没有执行 DML/DDL。PostgreSQL 16.14 当前用户 3、活跃用户 3；旧 `user.uniqid/store_service.uniqid` 扫码键均为 0；微信身份、活跃 unionid、PC 微信身份、客服账号和活跃客服均为 0；`codex_%` 临时 schema 也为 0。

`site_name` 有唯一非空候选，`wechat_open_app_id` 和历史数据库键 `wechat_open_app_secret` 均为 0 行。`system_config_lookup`、用户/微信身份/客服 UID 查询索引均存在，不需要新增生产 DDL。临时 Worker 已删除。空身份、空客服及缺 AppID/Secret 只证明功能会失败关闭，不能作为生产正向扫码或 OAuth E2E 证据。

### 扫码状态机、重试与失败关闭

上一节记录的 `pending→scanned→approved→consumed` 已被更完整的交付状态机取代：内部状态现在为 `pending→scanned→approved→issuing→delivered`。`issuing` 使用 30 秒租约并固定 token 签发时间；登录 token 先写强一致 token store，再在返回浏览器前持久化为 `delivered`。响应丢失或浏览器重试会重新交付完全相同的 token；签发失败只释放仍匹配的租约，不再提前删除已批准挑战。二维码仍只含公开 UUID，256 位 `poll_token` 只保留在浏览器闭包并通过 `X-Scan-Poll-Token` 发送，不进入 QR、DOM、URL 或日志。

创建/轮询继续执行来源级 20/180 次每分钟限制，移动端查看与批准另增加 UID+IP 组合的 30 次每分钟限制。PC 发 token 前重读用户启用状态；客服同时重读 `store_service.is_del=0/status=1/account_status=1`、正 UID、绑定用户存在/未删除/启用及 UID 唯一关系，HTTP 中间件与 WebSocket 会话继续复核。禁用绑定用户会立即使客服 token 失效，不能只凭有效客服 JWT 继续访问。

生产 token bucket 读取在 Redis 缺配置或网络异常时统一返回 HTTP 503，签发写入在缺配置、网络失败或非 `OK` 时同样失败关闭；API、Admin、Supplier、Kefu 与 Out 分别复核 token/type/uid，不能降级为只验 JWT。注销删除 bucket 也已采用同样的生产 503 语义。PC、UniApp、Kefu 与 Supplier 即使注销请求失败也会清除本机 bearer 并完成导航，但不再谎报服务端撤销成功，而会明确警告旧会话可能持续到过期；普通用户可改密或联系管理员，后台身份需由管理员禁用账号或重置密码，不能用新令牌再次注销来撤销已丢失的旧令牌。普通用户和客服成功主动退出会断开对应 token 的聊天连接；DO 对心跳以及消息、在线状态和转接三类被动下行，在发送前重新检查到期时间、Redis/访客会话和数据库身份，失效连接以 4001 关闭，因此休眠连接不能在 logout、TTL 到期、改密或禁用后继续收信。

普通用户数据库 `pwd` 仍是 PHP 兼容的 `md5(password)`；PHP `BaseServices::createToken` 实际写入的 JWT `auth` 是 `md5(user.pwd)`。密码、短信、微信、扫码与 OAuth 的 Worker 签发已统一为这一权威摘要，默认密码也不再跳过 auth 校验。早期 Worker 错签的 `auth=user.pwd` 只在当前 `tb_` bucket 精确匹配 token/type/uid 时临时接受；旧签发器退役后最多延续现有 API bucket 的 7 天加 60 秒，并应在发布观察期后删除兼容分支。

这不等于旧 PHP 会话无缝互通。PHP bucket 使用可配置 `REDIS_PREFIX + md5(token)` 和 PHP `serialize()`，Worker 使用 `tb_<md5(token)>` 与 JSON/Upstash；即使 `APP_KEY` 和 Redis 实例相同，两边也默认互相拒绝。正式切换必须二选一：全量鉴权切流并强制重新登录、禁止回退 PHP，或先实现并验证键名/序列化/TTL/撤销一致的双读或一次性迁移桥。当前未实现后者，混合鉴权流量是 P1 发布阻断。

### OAuth、Origin、Cookie 与 Secret 边界

全局 CORS 不再反射任意 Origin，只对 `ALLOWED_ORIGINS` 的精确来源返回 ACAO；生产扫码/OAuth 创建还按 audience 分别要求浏览器请求来源进入 `PC_AUTH_ALLOWED_ORIGINS` 或 `KEFU_AUTH_ALLOWED_ORIGINS`，客服入口不再继承 PC/H5 列表。服务端把目标名称、请求携带的精确 Origin、粗粒度 User-Agent 设备类别和 audience 固化到挑战，移动端批准前显示这些核对字段。旧 GET key 合同保留：浏览器省略 Origin 时只接受对应 audience 精确白名单内的 Referer origin；新 PC/Kefu 客户端使用 POST key 安全扩展，以可靠携带 Origin。

开放平台 state 除 audience 和白名单 Origin 外，再绑定随机 256 位浏览器 verifier。verifier 仅进入按 audience **及 state** 隔离的 `__Host-cinashop-pc-oauth-<state>` 或 `__Host-cinashop-kefu-oauth-<state>` Cookie，并设置 `HttpOnly; Secure; SameSite=Lax; Path=/`；并行标签页不再互相覆盖。Redis key 使用 state 与 verifier 摘要隔离，错误浏览器不能消费正确 state。callback 成功后清理对应 state Cookie，前端也先从地址栏移除 `code/state` 再处理结果。OAuth 必须经同源 Pages Function（或同站点自定义 API 域名），不能把 Kefu Pages 直接跨站请求 `workers.dev`，否则 Lax Cookie 不会随 callback fetch 发送。AppID 仍从精确 `wechat_open_app_id` 配置读取；AppSecret 现在只接受 Worker Secret `WECHAT_OPEN_APP_SECRET`。上一节“从 `system_config` 读取 AppSecret”的实现已经被取代，即使以后出现数据库同名行也不会使用。

这里的 Origin 和 User-Agent 不是客户端证明：非浏览器请求可伪造两者，攻击者也可能中继二维码诱导用户确认。因此这些值只用于浏览器跨站收敛和人工核对，不能被服务端当作设备认证。移动端现明确提示“仅在本人刚主动发起登录时确认”；生产上线仍需评估 Turnstile/边缘证明、异常挑战尝试预算和反二维码中继措施，不能把 allowlist 描述为密码学可信边界。

当前生产 `ALLOWED_ORIGINS` 配置 PC 与 H5 的精确 Pages 来源，`PC_AUTH_ALLOWED_ORIGINS` 只配置 PC Pages；`KEFU_AUTH_ALLOWED_ORIGINS` 刻意未设置。Kefu 尚无正式 Pages 项目和已批准生产 Origin，因此其扫码/OAuth 创建会真实返回 503，而不是继承 PC/H5 白名单；不得为临时可用而扩大 allowlist。生产 Worker Secret 清单也没有 `WECHAT_OPEN_APP_SECRET`，开放平台登录继续安全关闭。

### PC、Kefu 与 UniApp 三端闭环

新 PC 登录页已接入账号、短信、扫码三种模式和微信开放平台入口；扫码使用串行轮询，在切换 tab、组件卸载或过期时停止；成功回跳只接受站内路径，OAuth callback 会先清理 URL 中的 `code/state`。新 Kefu 登录页已接入密码、扫码和微信开放平台入口，请求携带同源凭据，扫码私有 secret 不进入 QR/DOM/URL，成功结果进入独立客服 auth store。PC 的 token/UID 与 Kefu 的 token/identity 已从 `localStorage` 改为当前标签页的 `sessionStorage`，模块初始化立即清除同名旧持久值，避免并行 OAuth 标签页出现 UI 身份和真实 bearer 错位；刷新当前标签页保留，新标签页不继承，关闭标签页也不等于服务端撤销，显式 logout 才会删除 bucket。`sessionStorage` 仍可被同源 XSS 读取，不能描述成 HttpOnly 防护。

UniApp 新增认证扫码确认页：未登录先进入登录并返回，批准前显示目标名称、精确站点、设备和剩余时间，并提供显式确认/拒绝；用户取消登录返回时会看到可重试入口，不再停在空白卡片。Supplier 浏览器 API 也已从直连 `workers.dev/supplierapi` 改为同源 `/supplierapi`，新增 Pages Function 和 Vite 本地代理；代码级 CORS 阻断已消除，但正式 Supplier Pages 项目、`WORKERS_API` 映射和部署验收仍未完成。

本地受控 mock 的既有真实浏览器回归覆盖 PC 1440×900、Kefu 桌面和 UniApp 390×844：PC/Kefu 均完成 pending→scanned 展示，二维码为 data URL 且 DOM 不含 `poll_token`；PC OAuth callback 清除参数后只跳转到 `/register`；移动端登录返回后显示 `CinaShop PC 商城`、`https://cinashop-pc.pages.dev` 与 `Windows · Chrome`，确认和拒绝终态均完成视觉回归。PC、Kefu 控制台无 error/warning；UniApp 只有框架依赖自身的 vue-router 弃用提示，没有应用错误、白屏或遮挡。

随后增强的状态化 Node mock 在内存中维护 `pending/scanned/approved/delivered/rejected`，按 key 绑定扫描与批准/拒绝，批准后重复交付同一 token/有效期，并验证 audience 隔离的 OAuth state+Cookie、错误 Cookie、跨 audience 和一次性消费。它仍使用每个 audience 固定的 challenge/poll token 和合成身份，进程重启即丢失，也不模拟 `issuing` 租约、DO 并发、Redis、真实 JWT、Hyperdrive、Origin/CORS、微信提供方或网络不确定性。本次协议自检与此前视觉回归是两层独立证据，均不能替代真实 Worker、微信和生产数据 E2E；同 audience 并行二维码标签页仍需真实实现回归。

### 最新量化、验证与上线门禁

最新注释感知路由审计为 PHP 1,904、Workers 1,395、精确匹配 697、可执行匹配 679、明确不可用 18、原始缺失 1,207、证据化退役 4、可执行缺口 1,203；覆盖为 36.6%/35.7%/35.7%。`/api` 为 315/457 精确、312 可执行、3 不可用、可执行缺口 141；`/kefuapi` 为 60/63 精确且全部可执行，余下 3 条均有证据退役，`actionableMissing=0`、退役后有效覆盖 100%。新增 POST key/OAuth 端点属于安全扩展，不改变 PHP 精确匹配分子。

仓库 schema audit 为源 201、目标 224、共享 201、缺源列 0、外部/内嵌迁移 224/224 且表/列/主键漂移 0。Worker 双 TypeScript 配置、135 个单元测试文件/787 项、PC/Kefu/Supplier 生产构建、Kefu 7/7 测试、UniApp 类型检查和 H5 构建、Supplier Pages Function 独立类型检查均通过；主 Worker minify dry-run 为 2,575.75 KiB/gzip 638.51 KiB。Windows runtime 仍在 0 条断言前以 `workerd 0xc0000005` 启动失败，不能记为 runtime 通过。

本地安全闭环完成不等于生产登录完成。主生产 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有部署主 Worker或正式前端；生产缺 `wechat_open_app_id`、`WECHAT_OPEN_APP_SECRET`、微信身份和客服账号，且没有源 MySQL连接可复制身份与客服数据。还需确定 Kefu 正式 Origin，配置同源 Pages proxy 与开放平台，迁移并人工复核真实身份/客服，明确“全量切流强制重新登录”或完成 PHP/Worker bucket 迁移桥，完成真实微信、真实账号、真机、Linux runtime、预发、影子流量、明确发布批准和发布后观察。Supplier 同源 proxy 虽已进入源码，正式 Pages 项目和映射同样未发布。技术债仍包括 Origin/UA 及二维码中继不具密码学客户端证明、每次扫码 RPC 使用 `blockConcurrencyWhile`，以及错误 poll secret 只有来源级限流、尚无挑战级尝试预算。

下一批路由缺口按第一方调用价值和现有可复用服务排序为：USER-CENTER-COMPAT 9 条（地址详情/默认、批量收藏、签到配置/记录/月历/提醒），DIY-HOME-WIDGETS 8 条，PUBLIC-ARTICLE 7 条。三批共 24 条；全部完成后全局可执行缺口预计由 1,203 降至 1,179，`/api` 由 141 降至 117。优先从 USER-CENTER-COMPAT 开始，因为新 UniApp 当前“设默认地址”调用了要求完整地址的保存接口，属于可复现功能缺陷，并且底层地址/收藏/签到服务大多已经存在。

## USER-CENTER-COMPAT 地址、收藏与签到详细迁移审计（2026-08-29）

### 九条 PHP 权威合同与实现边界

本批补齐九条强制登录的 PHP 精确合同：`GET /api/address/detail/:id`、`POST /api/address/default/set`、`POST /api/collect/all`、`GET /api/sign/config`、`GET /api/sign/list`、`GET /api/sign/month`、`POST /api/sign/user`、`GET /api/sign/remind/:status`、`GET /api/sign/calendar`。地址、收藏、签到合计 18 个个性化 handler 均显式返回 `Cache-Control: private, no-store`，避免用户数据进入共享缓存。它们不是简单的路由别名：地址要恢复旧 snake_case 响应和表单兼容，收藏要同时覆盖商品/视频与批量参数，签到要按上海自然日而不是 Worker 所在时区解释日历、月份和连续记录。

地址详情、保存、删除和设默认现在都以认证 UID 二次限定，不能凭地址 ID跨用户读取或修改。保存路径会归一化省/市/区/街道，处理直辖市重复段，校验或解析 `city_id`；设默认在用户级 advisory lock、候选行锁和同一事务内清除旧默认并设置新默认，避免并发后留下多条默认或无默认。新 UniApp 地址页不再用“完整保存”冒充设默认，也不再在缺少城市 ID 时默默丢弃该字段。底层 `BaseDao` 同时修复了 P0 作用域问题：`null`、数组、空对象和畸形过滤不再生成无条件读取；更新、删除和增减遇到无条件时直接失败关闭。

收藏兼容同时支持 `product`、`video`，接受旧端标量、数组、`id[]` 和逗号分隔批量载荷并限制批量上限。关系写入使用 `(uid,relation_id,type,category)` 显式唯一冲突目标和固定商品/视频锁序；商品日志只记录首次新增的关系，商品/视频收藏计数使用集合 SQL按当前关系重算，不再按请求条数盲加减。列表保留 `product_id`、`is_del`、`is_show`、`is_fail`、`promotions` 等旧端稳定字段，对可见商品再做真实目录与促销装饰；商品和视频分别保持作用域，删除也不会跨 category/type。PC 商品详情与收藏页已改为真实 add/del 和 `{list,count}` 合同，失败时不会伪造成功状态；UniApp 收藏页会清理旧页残留并读取真实计数。

签到兼容服务恢复配置、记录、月份汇总、签到、提醒偏好状态和日历，固定使用 Asia/Shanghai 日界线，月份接受 `YYYY-M`/`YYYY-MM` 且限制合理范围；有效 SVIP 只接受永久或未过期状态。用户查询只投影积分、连续签到和会员判断所需字段，不再读取/返回完整用户行；积分配置和冻结积分筛选按目标数据语义收紧。UniApp 签到页现在尊重功能开关、显示真实奖励并实际提交签到，不再用前端静态成功态代替服务端结果。

`GET /api/sign/remind/:status` 只恢复用户提醒偏好写入，不能视为签到提醒闭环。PHP 的真实投递链由 `SystemTimer` 中 `mark=sign_remind_time` 的任务触发，继续调用 `UserSignServices::userSignRemind()`，最终经 `notice.notice` 发送；Worker 的 `scheduled()` 当前只调用 `enqueueScheduledRun` 入队订单维护，全仓没有签到提醒的定时扫描、消费或通知发送实现。端点迁移与通知投递必须作为两项独立验收，后者是发布门禁。

### 生产 PostgreSQL 16.14 事实与六索引变更

用户授权直接使用生产数据库后，临时鉴权审计 Worker 绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。只读阶段使用 `REPEATABLE READ, READ ONLY`、固定 `search_path=public` 和有界超时，只返回聚合计数、布尔完整性指标和索引定义，不返回地址、手机号、用户资料、配置值或其他 PII/Secret。

生产地址共 5 行且有效 5 行，涉及 4 个 owner；默认地址 2 行，多默认 owner 为 0，但有地址而无默认的 owner 为 2。owner 孤儿为 4 行、3 个 distinct UID；5 行 `city_id` 全为 0，`city_area` 与 `system_city` 都是 0 行。因此当前目标库没有足够城市目录验证任何真实正向地址保存，不能把代码兼容解释成城市数据迁移完成。

`user_relation`、收藏关系和商品收藏各 1 行，四列重复为 0；关系 owner 孤儿 1、商品孤儿 0，现有收藏缺对应商品收藏日志 1。`user_sign` 为 1 行，同一上海自然日重复为 0，签到 owner 孤儿 1。地址、关系、签到三个域合并共有 5 个 distinct 孤儿 owner，三域共同 UID 为 0，说明不能用一条映射猜测覆盖全部孤儿。商品共 71 行，存储的收藏总数为 0、按关系计算的真实总数为 1；漂移商品 1、最大差值 1，商品收藏日志总数 0。

生产前五个目标索引已完成后，又新增唯一表达式索引 `us_uid_shanghai_day_uq`：`user_sign(uid, (((add_time::bigint + 28800) / 86400)))`，由数据库统一阻断 PHP/Worker跨运行时同一上海自然日重复签到。生产预检重复组为 0；受控迁移连续执行两次均返回 `indexCount=6`、`DML=false`、`businessRowsUnchanged=true`，随后精确读回表、表达式、键顺序、唯一性和访问方法。索引目录由 728 增至 729；六个 USER-CENTER 目标定义均已幂等复验。Worker 捕获该唯一索引触发的 SQLSTATE `23505` 并转换为稳定业务错误“今日已签到”，不会向客户端泄漏数据库异常。临时 Worker 已删除；主 Worker前后仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布应用代码或前端。

### 生产随机 schema 真实 service 证据

临时 Worker 在生产 Hyperdrive 的随机 schema 中直接调用真实地址、收藏和签到 service，最终地址 3/3、收藏 5/5、签到 5/5，共 13/13 断言通过。地址覆盖归属、默认切换和城市路径；收藏覆盖商品/视频、批量关系、日志与权威计数；签到覆盖上海日界线、奖励、重复行为，以及同一上海自然日不同秒由数据库唯一索引拒绝。每个顶层事务都显式执行 `SET LOCAL search_path`，不依赖连接 startup 参数；13 张 `public` 表的全行指纹前后完全一致，临时 schema 计数不变且最终删除，临时 Worker 在部署列表中确认不存在。

首轮 harness 因 Hyperdrive 未可靠保留 startup `search_path` 而失败，失败发生后随机 schema 安全清理，13 张 `public` 表无变化；修正为每个顶层事务显式设置本地 search path 后，完整 13/13 场景通过。这个过程是隔离装置修复，不是业务断言失败，也没有把合成数据写入 `public`。

生产孤儿、商品收藏计数和缺日志都没有自动修复。源 MySQL不可用时，删除孤儿、重绑 UID、补日志或改计数都会掩盖来源问题；即使一次性校正，旧 PHP若继续并行写关系而不采用同一计数/日志状态机，漂移仍会重新出现。签到数据库唯一性门禁已经关闭，但上线仍建议单运行时或统一锁序以减少冲突重试。

默认地址 partial unique 本批仍明确推迟，但 Worker 顺序已经为未来约束兼容：地址编辑在 `isDefault=1` 时先只更新普通字段，再由 helper 执行清旧→设新；`isDefault=0` 才直接把当前记录清零。剩余阻断来自旧 PHP仍先设新再清旧、只按裸地址 ID写入的越权风险、非事务写入，以及混合写流量尚未切走。必须先修 PHP，或把地址写入切到单一运行时后，才能安全增加 partial unique。收藏关系已有四列唯一索引，但商品/视频计数仍可能被 PHP 与 Worker并行更新写回覆盖。默认地址和收藏跨栈问题继续作为发布门禁，不能因签到唯一索引落地而一并标记完成。

### 路由量化、验证与未完成项

最新注释感知审计为 PHP 1,904、Workers 1,404、精确匹配 706、可执行匹配 688、明确不可用 18、原始缺失 1,198、证据化退役 4、可执行缺口 1,194；精确/可执行/退役后有效覆盖为 37.1%/36.1%/36.2%。`/api` 为 PHP 457、Workers 715、精确匹配 324、可执行匹配 321、明确不可用 3、原始缺失 133、退役 1、可执行缺口 132，对应覆盖 70.9%/70.2%/70.4%。本批九条合同全部精确且可执行，相对前一批把全局和 `/api` 可执行缺口各减少 9。

Worker 全量 137 个文件/808 项、USER-CENTER 两个文件 21/21，连同签到奖励边界共 27/27；双 TypeScript 配置、PC 生产 build、UniApp typecheck/H5 build 均通过。主 Worker minify dry-run 为 2,607.61 KiB/gzip 647.22 KiB。Windows runtime仍在进入断言前受 `workerd 0xc0000005` 阻断，但受支持的 Ubuntu workerd 已由 Actions `33373018752` 运行 1 文件/10 项通过；这只关闭通用绑定/Queue/DO/WebSocket runtime 门禁。生产随机 schema 真实 service 13/13 已补齐，但没有使用真实生产 token 执行地址、收藏和签到的正向 HTTP E2E。

- [x] 九条地址/收藏/签到 PHP 精确路由及强制认证边界已注册；18 个个性化 handler 均为 `private, no-store`，BaseDao 空条件读写已失败关闭。
- [x] PC 收藏、UniApp 地址/收藏/签到已接入新合同，并通过类型检查和生产构建。
- [x] 六个生产索引已幂等应用、独立复验且业务行/指纹不变；`us_uid_shanghai_day_uq` 已关闭跨 PHP/Worker同一上海自然日重复签到门禁，Worker将 SQLSTATE `23505` 转为“今日已签到”；临时 Worker 已删除，主 Worker未发布。
- [ ] 取得源 MySQL并迁移/复核 `city_area/system_city`，为现有五条 `city_id=0` 地址建立可解释映射；当前不能进行真实正向地址保存 E2E。
- [ ] 对 5 个 distinct 用户中心孤儿 owner 逐项确定源 UID，随后受控修复关系、签到、商品收藏计数和缺日志；同时解决 PHP 并行写造成计数再次漂移的问题。
- [x] 生产随机 schema 的真实 service 地址 3/3、收藏 5/5、签到 5/5 共 13/13 通过；包含同一上海自然日不同秒唯一性断言，13 张 `public` 表全行指纹不变，临时 schema/Worker 已清理。
- [ ] 以受限真实 token 在生产或预发完成地址、商品/视频收藏和签到正向 HTTP E2E。
- [x] 上海自然日签到数据库唯一性已通过生产索引、二次幂等迁移和随机 schema 同日不同秒断言关闭；仍建议签到单运行时或统一锁序。
- [ ] Worker 已改为普通字段更新后由 helper 清旧→设新；仍需修旧 PHP 裸地址 ID越权、非事务和先设新→清旧顺序，或切到地址单运行时，再评估默认地址 partial unique；当前未添加该约束。
- [ ] 解决收藏在 PHP/Worker跨栈并行写下的计数竞态，并完成切流或持续对账验证。
- [x] 已恢复 `sign_remind_time` 上海 10:25 定时扫描、可重试 Queue 消费和每日幂等站内信，生产随机 schema 已验证关闭偏好、不重复发送、扫描后签到、失败重试/恢复及上海日界线选择。
- [ ] 旧 PHP 同时尝试的短信与小程序订阅消息仍需通用 provider 投递账本、UNKNOWN/重试策略、真实凭据/模板和测试账户验收；生产当前对应模板、候选用户与 timer 均为 0。
- [x] 可选登录 `GET /api/diy/sign`（PHP `homeDiysignData`）已由 DIY-HOME-WIDGETS 服务端批次补齐；真实旧客户端 token/E2E 仍属于发布门禁。
- [ ] 继续补活动详情中秒杀/拼团/砍价装饰与水印兼容；这些跨域展示细节不能因本批收藏字段稳定而视为完成。
- [x] Linux/兼容主机 Workers runtime 已由 Ubuntu Actions `33373018752` 的 1 文件/10 项通过；Windows崩溃不再阻断该门禁。
- [ ] 完成预发、影子流量、明确发布批准和发布后观察；主 Worker与 PC/UniApp当前均未发布。

DIY-HOME-WIDGETS 八条服务端合同和 PUBLIC-ARTICLE 七条精确合同/本地 UniApp 接线现已收口；下一代码批次为 reply 4 条与仍被 UniApp 调用的社区合同。PUBLIC-ARTICLE 因生产内容与媒体均为空、切流/热点写策略和真实端 E2E 未完成而保持父项未勾选；USER-CENTER-COMPAT 同样继续等待源数据、默认地址/收藏跨栈门禁、签到提醒投递、真实 token 流程和发布证据。签到唯一性门禁已关闭，但仍建议单运行时/统一锁序。主 Worker 仍是旧版本，未发布本批代码。

## PRODUCT-REPLY-DETAIL 迁移审计（2026-08-30）

### 四条 PHP 权威合同与静态审计盲区

本批以 `cinashop-php/route/api.php`、`StoreProductReply` controller、`StoreProductReplyServices::getReplyInfo()`、`StoreProductReplyCommentServices`、DAO/model，以及旧 UniApp `goods_comment_con/comment_con.vue` 和 `api/store.js` 为权威，范围固定为四条强制登录合同：`POST /api/reply/comment/:id` 发布评价回复、`GET /api/reply/info/:id` 读取评价详情、`POST /api/reply/praise/:id` 点赞评价回复、`POST /api/reply/un_praise/:id` 取消评价回复点赞。公开可选登录的 `GET /api/reply/comment/:id` 已在此前批次存在，属于详情页依赖但不计入四条新增范围。

审计起点并不是简单的 4/4 缺失：其中三条 exact missing，`POST reply/praise/:id` 已被路由统计计为匹配，却错误连接 `ReplyController.praiseReply()`，实际按 `category=reply` 给评价主体点赞；旧端传入的却是 `store_product_reply_comment.id`，PHP 权威语义为 `category=comment`。因此旧静态统计会把一条不可互换的实现误判为已迁移。评价主体点赞的真实路径一直是 `reply/reply_praise/:id` 与 `reply/un_reply_praise/:id`；本批保留这两条，纠正 `reply/praise` 并补齐 `un_praise`，避免用路径存在代替行为等价。

PHP 详情返回 `reply/product/user/star/is_praise`：评价字段为 snake_case，`add_time` 按 Asia/Shanghai 格式化到秒，`suk` 复制 `sku`，`comment_sum` 只统计根回复，`star` 只取商品分与服务分平均值并向下取整；详情最后用读改写增加 `views_num`。PHP 发布回复只检查非空，直接插入 UID、评价 ID、内容和时间；回复点赞先在事务外读/改计数，再分开写关系，重复取消还可能把计数减为负数。公开回复列表会带一层 `children`、用户、等级、SVIP 与 `is_praise`，平台 UID 0 使用站点名称和方形 Logo。新实现保留客户端可观察字段和一层子回复合同，不复制并发丢更新、负计数或隐藏内容泄露。

### Worker 权限、事务和响应实现

四条精确路径现全部经过 `authMiddleware({force:true})`；公开列表继续 optional auth，但读取前先确认父评价 `status=1 AND is_del=0`，隐藏、未审核或已删评价不再泄露回复。详情以 `withTx` 锁定可见评价，使用原子 `views_num + 1`，返回值仍保留 PHP 的“增加前浏览量”观察时点；商品只投影旧四字段，用户只投影昵称、头像、等级和会员判断所需字段。图片 JSON、匿名昵称、等级开关、付费会员有效期、根回复计数、评价点赞关系、Asia/Shanghai 时间和 PHP 的两分平均星级均有显式映射；详情、回复列表和三条回复写响应均显式 `private, no-store`。

发布回复在读 body 前限制为 4 KiB，内容先 trim，再以 Unicode code point 而非 UTF-16 code unit 限 1,000 字符，并拒绝 NUL 和不安全 C0/DEL 控制字符；同一事务锁定可见父评价、确认用户仍启用后插入根回复及用户快照。回复点赞/取消点赞锁定回复并同时验证父评价可见，关系固定为 `type=like/category=comment`；添加使用现有 `type <> 'play'` 四列部分唯一索引幂等冲突目标，取消不存在关系也稳定成功，随后从关系表 `COUNT(*)` 重算回复 `praise`，计数不会为负。评价主体原 `category=reply` 状态机和兼容路径不变。

这改善了单 Worker 并发与重试，但不能神化成 PHP/Worker双写完全线性一致：旧 PHP没有相同行锁顺序和计数重算，在混合写流量下仍可能覆盖计数。正式切流前应选择回复/点赞单写运行时，或给旧 PHP补同一事务/锁序并建立持续对账；这一项继续作为发布门禁。

### 新 UniApp 详情闭环与既有字段漂移修复

`view/uniapp-ts` 新增类型化 `api/reply.ts` 和可到达的 `pages/goods/commentDetail`，覆盖详情、列表、回复发布、回复点赞/取消和评价点赞/取消。页面登录后并行加载详情与回复，显示商品、评价用户、等级/SVIP、星级、规格、图片、浏览/点赞/回复数，一层商家子回复，支持发布和两层点赞。写请求失败前不改变本地计数；评价级点赞在成功后更新，回复级点赞在成功后重新读取服务器权威列表。

同时修复此前新客户端的静默字段错误：商品详情与评价列表一直把服务端 `product_score/add_time` 当作 `productScore/addTime` 读取，导致星级回退默认值、时间格式无效。本批移除相关 `any/unknown` 读取，统一使用类型化 snake_case，并让两个评价入口都能进入详情页。UniApp `vue-tsc`、H5 和微信小程序生产构建均通过；尚未用真实 token、真机或旧 PHP golden response完成远端 E2E。

### 生产 Hyperdrive 只读数据事实

用户授权直接使用生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 后，一次性审计 Worker 采用两枚不同 Bearer 的 SHA-256 摘要、timing-safe 比较和 POST-only 端点。只读阶段固定 `REPEATABLE READ, READ ONLY`、`search_path=public,pg_temp`、短锁/语句超时，并验证未限定 `store_product_reply` 实际解析到 `public`。响应只返回聚合、缺表和索引状态，不返回评价内容、昵称、URL、UID、业务 ID、配置值或表指纹。

生产 PostgreSQL 为 16.14，`store_product/store_product_reply/store_product_reply_comment/user/user_relation/system_user_level/system_config` 7/7 表存在，审计前临时 schema 为 0。评价只有 2 条且均为 `status=1,is_del=0`；负点赞、负浏览、商品孤儿和评价点赞计数漂移均为 0，但两条评价的用户 owner 全部不存在。回复表为 0 行，评价点赞与回复点赞关系也均为 0，所以生产没有任何可用于回复发布/点赞的正向交互样本。四个显示配置键只存在 3 个；结合此前已经列出的生产配置可确定缺的是 `site_logo_square`。`user_relation` 非 play 部分唯一索引有效，回复评论表有 3 个索引；本批没有在 `public` 执行任何 DDL 或数据修复。

两条 owner 孤儿意味着详情仍能使用评价快照展示昵称/头像，但 `user.level_name/vip_status` 没有真实用户来源，也无法用现有生产 token访问这两条历史评价。不能凭空把评价 UID映射到当前 3 个用户，更不能为了构造 E2E向生产写合成回复或点赞；必须取得源 MySQL身份/回复/关系证据后受控映射。

### 随机 schema 真实 service、并发和清理证据

写验证仅发生在同一生产 PostgreSQL 的随机 `codex_product_reply_*` schema。场景取得单飞 advisory lock，失败关闭地确认七张表各自唯一 serial 主键列，克隆 `LIKE public ... INCLUDING ALL` 后为全部序列重绑定随机 schema；每个顶层事务把随机 schema 放在 `pg_temp` 前，并以 `current_schema()` 和 `to_regclass('store_product_reply')` 证明未逃回 public。场景直接调用真实 `ReplyService`，不是 SQL 替身。

最终 12/12 断言通过：旧详情形状、原子浏览量、隐藏父评价失败关闭、根/子回复列表与会员/平台装饰、回复发布、空白/控制字符/1,001 个 Unicode 字符拒绝、回复点赞重复添加幂等、双连接并发点赞收敛、重复取消非负、关系触发器故障全回滚、search path 隔离，以及 public 全行/序列前后指纹相同。七张 public 表在只读快照中以行数、最大键和全部列聚合摘要取指纹，相关 public 序列另取状态；随机 schema 在 `finally` 删除，临时 schema `0→0`。

第一轮两个独立 `secret put` 经 PowerShell管道写入了不可用哈希格式，双令牌门禁在数据库访问前返回 `audit unavailable`；改为一次 `secret bulk` 后只读审计成功。隔离场景首次把两个预期失败的 nested transaction 并发复用同一连接，导致 harness 的 `rollback_atomic` 假失败；schema 已先删除，日志明确 public 未变，改为串行验证两个失败目标后最终 12/12。一次性 `cinashop-product-reply-detail-audit` Worker、路由和 Secret随后删除；主生产 Worker仍为 100% `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有部署应用 Worker或 Pages。

### 路由量化、仓库验证和剩余门禁

三条新增 exact route注册后，全域静态审计为 PHP 1,904、TS 1,422、精确匹配 724、可执行匹配 706、明确不可用 18、原始缺失 1,180、证据化退役 4、可执行缺口 1,176，精确/可执行/退役后有效覆盖为 `38.0%/37.1%/37.2%`。`/api` 为 PHP 457、TS 733、精确 342、可执行 339、不可用 3、原始缺失 115、退役 1、可执行缺口 114，覆盖为 `74.8%/74.2%/74.3%`。分子只增加 3 而不是 4，正是因为错误语义的 praise 路径此前已被静态统计计为匹配。

最终仓库门禁为 Worker 双 TypeScript 配置通过、145/145 单元测试文件与 875/875 项通过，PRODUCT-REPLY-DETAIL 两个定向文件 14/14；主 Worker dry-run 为 4,754.29 KiB/gzip 899.17 KiB；UniApp 类型检查、H5 和微信小程序构建通过。Windows Workers runtime仍在 0 条断言前以 `workerd 0xc0000005` 启动失败，不能记为 runtime 通过，需在 Linux/兼容 CI补跑。

本批代码、生产只读审计、随机 schema 和本地前端已收口，但父项不能完成：生产仅有 2 条 owner 孤儿评价，回复与两类点赞关系均为空，且缺方形站点 Logo；源用户、回复和关系数据尚未复制，PHP golden response、真实 token、旧端/新端、H5/小程序/APP、预发、影子流量、主 Worker/Pages 发布及发布后观察全部未完成。下一代码批按 checklist 进入 API-008 门店/企业微信/内嵌 Admin，数据修复与发布门禁继续独立跟踪。

## API-008 门店/企业微信/内嵌 Admin 详细迁移审计（STORE-A 子批次，2026-08-30）

### PHP 权威合同、旧页面形状与本批边界

API-008 静态起点已精确拆成 73 条可执行缺口：store 12、work 10、`/api/admin` 51。已有 `GET /api/store/list` 和 `POST /api/store/order/writeoff` 不计缺口。本批只关闭 STORE-A 六条：公开 `GET /api/store/category`，以及强制登录的 `GET /api/store/delivery/info|statistics|data|order|list`；剩余门店订单 6、企业微信 10、内嵌 Admin 51 继续保持未完成。

审计以 `route/api.php`、`StoreDelivery`/`StoreOrder` controller、`DeliveryServiceServices`/`BranchOrderServices` 以及旧 UniApp `api/admin.js` 和 `pages/admin/distribution/index.vue` 为权威。旧配送首页需要 `info.avatar/nickname/phone/store_info`、统计 `unsend/send/send_price`、按日 `time/count/price` 和订单 `{data:{unsend,send},list}`；订单行继续提供订单号、收货信息、金额、数量、`cart_id` 以及 `_info[].cart_info.productInfo`。PHP 的按 UID 读取会任取一条活跃配送/店员身份，不能证明门店归属唯一；本批保留可观察响应形状，但不复制这种重复身份下的任意授权。

### Worker 实现、安全边界与性能索引

公开分类复用已有商品分类树并恢复 PHP 外层 `stationOpenMiddleware()`；审计同时发现既有 `store/list` 缺少同一营业开关，已一并修正。五条配送响应先经过站点开关和强制用户认证，并显式设置 `Cache-Control: private, no-store` 与 `Pragma: no-cache`。配送员读取只接受当前启用、未删除用户的活跃身份；请求指定门店时要求唯一 `type=1/relation_id=store_id` 关系且门店营业。配送员列表反向要求当前用户恰有一个活跃店员身份，再按该营业门店列活跃配送员；重复门店配送身份或重复店员身份均失败关闭。

PHP 时间 token 由 Worker 明确按 Asia/Shanghai 解释，覆盖今日、昨日、近 7/30 天、本周/上周、本月/上月、本年/上年、季度和两个显式日期；显式跨度最多 366 天。分页每页最多 100、offset 最多 10,000。配送订单固定当前 `delivery_uid`、已支付、未删除且退款状态 0/3，类型 1/2 分别映射状态 2/9；商品快照一次批量读取，单快照最多 256 KiB，畸形或超限 JSON 只降级为安全投影，不返回原始 JSON，也没有 N+1 或第三方 `fetch`。

原生产订单索引没有以 `delivery_uid` 为首列的路径，本批新增前向 `0107_store_mobile_delivery_index.sql` 与 schema 定义：`store_order(delivery_uid,status,add_time DESC,id DESC)`，局部谓词固定 `delivery_uid>0, paid=1, is_del=0, is_system_del=0, refund_status IN (0,3)`。迁移在 catalog 中校验表、btree、唯一/主键/约束/表达式/INCLUDE/有效性状态、四个键列和 `indoption=[0,0,3,3]`，并校验规范化谓词；同名异定义会失败关闭。生产首次建索引后的旧校验错误地期待 `pg_get_indexdef(index_oid,position,true)`返回 `DESC`，而 PostgreSQL 16 把方向编码在 `indoption`；实际索引一直有效，校验改为列名与 indoption 双证据后严格回读为 true。

### 生产 Hyperdrive、随机 schema 与临时资源证据

临时审计 Worker 仅绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。提交保留的审计入口使用三枚互异 Bearer 的 SHA-256 摘要、timing-safe 比较和 POST-only `/audit|apply-index|isolated-scenario`；生产只读事务固定 `REPEATABLE READ, READ ONLY`、`search_path=public,pg_temp` 和有界超时，只返回表/索引与聚合计数，不返回姓名、电话、地址、商品快照、用户/业务 ID、指纹或 Secret。

生产 PostgreSQL 为 16.14，`user/system_store/system_store_staff/delivery_service/store_order/store_order_cart_info` 六表齐全。配送身份、活跃配送身份、店员、可授权店员、已分配订单、状态 2/9 配送订单及所有重复/孤儿聚合当前全部为 0；因此生产不存在真实配送员 token 或旧页面正向样本。`delivery_service` 与 `system_store_staff` 各有 4 个索引，订单索引应用后为 15 个；历史购物车 `oid` 首列索引有效。最终 `so_delivery_mobile_active` 精确证据为键列 `delivery_uid,status,add_time,id`、`indoption=[0,0,3,3]`、局部谓词匹配、valid/ready/live=true，且非 unique/primary/exclusion/clustered/replica identity、无表达式/INCLUDE/自定义 options/附着约束。

写验证只发生在随机 `codex_store_mobile_delivery_*` schema：六表 `LIKE public ... INCLUDING ALL`，六个 serial 序列逐一重建并重绑定；每个顶层事务显式设置随机 schema 在 `pg_temp` 前，并用 `current_schema()`/`to_regclass('delivery_service')` 证明没有逃回 public。真实 `StoreMobileDeliveryService` 最终 12/12：资料形状、门店越权拒绝、上海日统计、按日聚合、待送/已送订单与计数、安全/畸形/超限快照、同店配送员列表、重复配送身份失败关闭、重复店员失败关闭、search path 隔离和 public 不变。六张 public 表全行指纹及相关序列前后完全相同，临时 schema `0→0`。因本机网络阻断 `workers.dev` TLS 且 Windows `workerd` 有既有 `0xc0000005`，最终一次性审计由临时 Cron 在 Cloudflare 内部触发并从结构化 tail 日志取证；Worker、Cron、路由和 Secret 随后删除，部署状态返回“不存在”。主 Worker没有发布。

### 路由量化、验证与剩余门禁

六条新增精确路由后，全域为 PHP 1,904、TS 1,428、精确匹配 730、可执行匹配 712、明确不可用 18、原始缺失 1,174、证据化退役 4、可执行缺口 1,170，精确/可执行/退役后有效覆盖为 `38.3%/37.4%/37.5%`。`/api` 为 PHP 457、TS 739、精确 348、可执行 345、不可用 3、原始缺失 109、退役 1、可执行缺口 108，对应 `76.1%/75.5%/75.7%`。相对 PRODUCT-REPLY-DETAIL，本批全局和 `/api` 可执行缺口均减少 6。

最终仓库门禁为 Worker 双 TypeScript 配置通过、147/147 单元测试文件与 887/887 项通过，STORE-A 两个定向文件 12/12；审计 Worker dry-run通过，主 Worker dry-run 为 4,772.98 KiB/gzip 903.00 KiB。Windows Workers runtime仍在进入断言前受既有 `workerd 0xc0000005` 阻断，不能记为 runtime 通过；提交推送结果另见本批交付记录。Cloudflare Workers 最佳实践直接影响本批实现：站点状态显式中间件、Hyperdrive、有界读取、无悬空 promise/全局可变状态、读取服务不调用第三方、个性化响应禁止缓存。

- [x] STORE-A 六条精确合同、旧页面主要响应形状、站点开关、强制认证和门店/身份唯一授权边界已实现。
- [x] `0107` 已在生产应用并通过列名、排序选项、谓词与完整 catalog 状态严格复验；购物车历史 `oid` 索引也可用。
- [x] 生产六表只读聚合与随机 schema 真实 service 12/12 完成，public 六表/六序列不变，临时 Worker/Cron/Secret/schema 全部清理。
- [ ] 生产门店、店员、配送身份和分配订单全为空；取得可信源数据并迁移后，以受限真实配送员/店员 token 补旧端 golden response 和 HTTP E2E。
- [ ] STORE-B 6、WORK 10、内嵌 Admin 51 仍未实现；其中外部写必须 Queue/outbox 化，Admin 必须有显式 ACL，不能因 STORE-A 完成而扩大授权。
- [ ] 主 Worker、UniApp/旧端切流、预发、影子流量、明确发布批准和发布后观察均未完成。

## API-008 门店订单详细迁移审计（STORE-B 子批次，2026-08-30）

### 六条权威合同与 PHP 风险复核

PHP `route/api.php:807-814` 的 STORE-B 权威范围固定为六条：`GET /api/store/refund/detail/:id`、`GET /api/store/order/detail/:id`、`GET /api/store/order/writeoff_info/:type`、`POST /api/store/order/cart_info`、`GET /api/store/order/delivery_info/:orderId`、`PUT /api/store/order/split_delivery/:id`。本批在 Hono 中逐条精确注册，全部显式经过 `stationOpenMiddleware()` 与强制用户认证；六个响应都设置 `Cache-Control: private, no-store` 和 `Pragma: no-cache`。现有新 UniApp 核销路径使用原生新合同，没有直接消费这六条旧门店包装接口；它们仍是 PHP 门店端兼容面，不能用“新端暂无调用”删去分母。

逐行复核 PHP `app/controller/api/store/StoreOrder.php` 后确认三类高风险行为，不能原样搬运。第一，`detail()` 只按全局订单自增 ID 读取，`refundDetail()` 先按全局退款 ID 换取单号，`deliveryInfo()` 只按全局订单号读取并返回姓名、电话和地址，三者都没有调用 `getStaffInfo()` 或追加当前门店；任一有效门店用户都可能跨店读取。`split_delivery()` 同样没有先绑定当前店员/门店，底层首次 `get(id)` 也不带 `store_id`。第二，`orderCartInfo()` 接受客户端 `auth` 且默认 `0`，而 PHP `WriteOffOrderServices::checkAuth/checkUserAuth` 对 `auth=0` 无条件授权；登录普通用户可借平台身份读取任意核销订单商品。第三，`auth=1` 只要求调用者是任意移动客服，没有校验该客服是否拥有目标订单会话；配送身份查找也允许先以 `store_id=0` 解析。上述问题在 Worker 中全部按实际后果关闭，而不是为了字段兼容保留旧越权面。

### 唯一店员、核销身份和详情投影

所有门店详情和拆单入口先解析当前用户唯一的活跃、已审核、未删除店员记录，再确认 owner 用户有效、所属门店营业且未删除；重复有效店员、重复作用域配置或孤儿关系全部失败关闭。订单详情、发货信息按 `order.id/order_id + staff.store_id` 联合限定，退款详情同时要求 `refund.store_id` 和其权威订单的门店/用户关系一致。PHP 原响应所需的订单、退款、状态、优惠和商品字段复用现有 Kefu/订单投影，但只解析有界 JSON 快照、不回传原始快照；读取服务没有第三方 `fetch`。

核销搜索只接受 `type=1` 客服或 `type=2` 配送员，`auth=0` 和其他类型直接拒绝。客服必须是唯一有效的 `customer=1` 移动客服，并由既有客服会话记录证明对该订单的可见性；“任意客服查看全站订单”的 PHP 行为被移除。配送员必须是有效配送身份并与订单 `delivery_uid/delivery_type` 匹配。12 位输入按核销码查单，其他输入按当前有效用户条码查找，结果最多 100 条；订单商品、核销次数、首图和次卡字段批量安全投影。

### 拆单履约状态机与安全差异

`PUT split_delivery/:id` 没有复制 PHP 的控制器事务薄壳，而是复用现有 `SupplierFulfillmentService.splitDelivery`。事务以 `expectedStoreId` 二次限定目标订单并锁定当前店员身份，随后取得订单结算锁和订单/商品行锁；所选商品、数量、已发/核销状态、拼团/预售条件、开放售后和配送员门店关系都在同一事务复核。成功时与拆单/发货数据一起写 `store_order_status(change_type=store_staff_split_delivery)` 和 `store_order_outbox(order.delivery.notice)`，避免数据库提交后通知丢失。

同步路径只接受手工快递、门店自配送和虚拟发货。PHP 默认 `express_record_type=2` 可能在请求内走电子面单/商家寄件，本实现要求这些能力进入已有可重试面单任务；第三方同城配送尚未接入时也明确拒绝，不能在请求内同步调用外部服务。这个差异是有意的安全/可靠性收紧，不是遗漏。重复提交继续由履约状态机、锁和现有任务账本收敛。

### 生产 Hyperdrive 审计与退款索引修复

用户明确授权直接使用生产数据库后，临时审计 Worker 只绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。提交保留的入口为 POST-only `/audit|isolated-scenario`，使用两枚互异 Bearer 的 SHA-256 摘要和 timing-safe 比较；生产读取固定 `REPEATABLE READ, READ ONLY`、`search_path=public,pg_temp`、短 lock/statement timeout，只返回表/索引和有界聚合，不返回姓名、电话、地址、条码、核销码、快照、业务 ID、指纹或 Secret。

生产 PostgreSQL 16.14 的 18 张依赖表全部存在，审计前后临时 schema 都为 0。`system_store_staff` 总行数、活跃已审核店员和可授权店员均为 0；门店订单、可发货订单和可核销订单均为 0，订单号/核销码重复组为 0。退款共 3 条且 3 条有效，订单孤儿和门店/用户归属错配均为 0。移动客服、门店配送身份、门店配置均为 0；重复客服、配送作用域、用户条码和配置组也均为 0。该结果证明现有少量退款结构一致，但不能替代真实店员、客服或配送员正向验收。

只读审计发现 `store_order_refund` 仅有 2 个索引，没有以 `store_order_id` 为首键的有效路径，而核销、开放售后门禁和拆单履约都会按该列读取。本批新增 `0108_store_order_refund_lookup_index.sql`，创建 `sor_store_order_id` 普通 B-tree，并严格验证 public 表/索引 schema、relkind、btree、非 unique/primary/exclusion、valid/ready/live、非 clustered/replica identity、无表达式/谓词/INCLUDE/自定义 options/附着约束，以及唯一键列 `store_order_id`、`indoption=[0]`；同名异定义会失败关闭。

迁移执行链复核还发现 STORE-A `0107` 和本批 `0108` 只有外部 SQL 文件，而生产 Worker 的 `_migrate` 运行时不能读取文件系统，原内嵌 `MigrationService` 只执行到旧内部 `0112`。本批新增共享的 STORE-A/STORE-B DDL 常量并纳入内部 `0113/0114`，外部文件与内嵌 SQL 先去注释/空白后必须逐字符一致；新环境运行 Worker 迁移不会再漏掉这两个索引。

首次生产创建事务只执行该索引 DDL；其紧随其后的跨事务状态检查没有立即放行，因此审计 Worker按设计报错而没有误报成功。独立完整 catalog 诊断随后证明目标定义从一开始就是精确有效的 `CREATE INDEX ... USING btree (store_order_id)`；再运行幂等升级时 before/after 均为 `exists=true, valid=true, indexCount=3`，退款表全行摘要和 serial 序列一致，`business DML=false`。最终只读审计的 `refund_order_index_ready=true`，其余店员、订单、购物车、客服、配送和配置索引也全部 ready。

### 随机 schema、量化和交付门禁

隔离写验证只发生在单次随机 `codex_store_mobile_order_*` schema，并使用 advisory lock 防止审计重入；18 张测试表/序列与真实服务运行后 schema 已删除，`temporary_schemas 0→0`，public 状态前后不变。真实服务场景 12/12：订单详情、退款详情、发货信息、跨门店 IDOR 拒绝、配送核销、客服会话绑定、`auth=0` 拒绝、拆单提交、状态审计/outbox、重复店员失败关闭、search path 隔离和 public 不变全部通过。临时 Worker、Cron、路由和 Secret 已删除，部署状态返回 Worker 不存在；主生产 Worker仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，本批没有发布主 Worker或 Pages。

最新注释感知路由审计为 PHP 1,904、Workers 1,434、精确匹配 736、可执行匹配 718、明确不可用 18、原始缺失 1,168、证据化退役 4、可执行缺口 1,164，覆盖为 `38.7%/37.7%/37.8%`。`/api` 为 PHP 457、TS 745、精确 354、可执行 351、不可用 3、原始缺失 103、退役 1、可执行缺口 102，对应 `77.5%/76.8%/77.0%`；相对 STORE-A，本批全局和 `/api` 可执行缺口均再减少 6。

仓库门禁为 Worker 双 TypeScript 配置通过、149/149 单元测试文件与 899/899 项通过，STORE-B 定向为 20/20；审计 Worker dry-run 为 845.16 KiB/gzip 159.55 KiB，主 Worker dry-run 为 4,806.26 KiB/gzip 909.20 KiB。Windows Workers runtime仍在 0 条断言前因既有 `workerd 0xc0000005` 启动失败，不能记为 runtime 通过。

- [x] STORE-B 六条 PHP 精确合同、旧响应主要形状、营业门禁、强制认证和门店归属已实现。
- [x] PHP 的跨店详情/发货/退款 IDOR、客户端 `auth=0` 平台旁路和任意客服全站核销可见性均已失败关闭。
- [x] 拆单复用结算锁、售后门禁、状态审计和通知 outbox；同步第三方/电子面单路径明确转入任务或拒绝。
- [x] 生产 18 表聚合、退款索引严格回读和随机 schema 12/12 完成，业务行/序列/public 不变，临时资源全清理。
- [ ] 生产缺门店店员、订单、移动客服、配送身份和配置正向样本；需可信源数据与受限真实 token 才能补 PHP golden response、旧端/新端 HTTP E2E。
- [ ] WORK 10、内嵌 Admin 51、主 Worker/Pages 发布、预发、影子流量、明确发布批准和发布后观察仍未完成。

## API-008 企业微信 JS-SDK 详细迁移审计（WORK-A 子批次，2026-08-30）

### PHP 权威合同与旧端风险

WORK-A 权威范围固定为 `route/api.php:821-824` 的两条公开 GET：`/api/work/config` 与 `/api/work/agentConfig`。PHP 控制器直接信任 query `url`，两路都调用 `WorkConfig::TYPE_USER_APP`；企业级 `config` 与应用级 `agentConfig` 实际共用数据库 `wechat_work_build_secret`，异常分别被吞成空数组或部分抛出。原 `buildJsSdkConfig/buildJsSdkAgentConfig` 返回 `url/nonceStr/timestamp/signature` 与 `appId` 或 `corpid/agentid`，并附 `jsApiList/openTagList/debug/beta`；本批保持这些可观察字段，生产 `debug` 改为 false。

旧 UniApp `api/work.js` 直接拼接 `work/config?url=` 和 `work/agentConfig?url=`，没有 `encodeURIComponent`，URL 自身的 `&` 会被拆成额外 query。`libs/work.js` 的 iOS 分支去掉 fragment，非 iOS 分支却可能把 `location.href`（含 `#`）传给 `agentConfig`；模块加载时还创建两个全局 Promise，可能把首个页面 URL/失败结果跨 SPA 页面复用。服务端 PHP 声明四个 JS API，而客户端实际传六个，额外使用 `sendChatMessage/shareAppMessage`。这些旧端问题没有通过放宽服务端签名规则掩盖；新服务统一签名去 fragment 的规范 URL，并返回六项实际使用列表。前端修复和企业微信真机验证继续作为发布门禁。

### 官方协议与 Cloudflare 边界

协议以企业微信官方[获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)及[JS-SDK 签名算法](https://developer.work.weixin.qq.com/document/path/90506)为准。企业与应用凭据分开调用 `GET /cgi-bin/gettoken`；企业 ticket 使用 `/cgi-bin/get_jsapi_ticket`，应用 ticket 使用 `/cgi-bin/ticket/get?type=agent_config`。两类 ticket 正常有效期均为 7,200 秒且有严格频率限制；签名原文固定为 `jsapi_ticket&noncestr&timestamp&url` 顺序，不做 URL encode，页面 URL 不含 `#`。access token和 ticket最长 512 字节，均只留在服务端。

Cloudflare 的最新 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与 [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) 文档直接约束本批：远端 PostgreSQL 仍只经 Hyperdrive；Secret 不写源代码、`wrangler.toml` 或数据库；provider fetch 只发生在请求上下文；响应采用流式有界读取；没有请求级全局可变状态或悬空 Promise；每个请求新建服务实例，临时签名响应禁止缓存。审计时最新可用 `@cloudflare/workers-types` 为 `5.20260830.1`、Wrangler `4.127.1`、Workers Vitest pool `0.22.0`；仓库仍分别为 `5.20260828.1`、`4.122.0`、`0.21.2`，本批核对最新声明但没有把依赖升级与两路迁移耦合，后续应在独立工具链升级批次处理。

### Worker 实现与有意安全差异

Hono 新增精确公开路由 `GET /api/work/config|agentConfig`，保持 PHP 无登录合同，但入口首先规范化 URL：最大 2,048 UTF-8 字节、必须 HTTPS、禁止 userinfo、移除 fragment，并要求 `URL.origin` 精确命中最多 32 项的 `WORK_WECHAT_ALLOWED_ORIGINS`。allowlist 未配置/格式错误返回真实 HTTP 503，非 HTTPS或未授权 Origin 返回 403；签名响应设置 `Cache-Control: private, no-store, max-age=0` 和 `Pragma: no-cache`。WORK-B 后续把该专用 Origin 接入 CORS，但只允许访问 `/api/work`，不会扩展到其他 API surface。

CorpID 和 AgentID仅从 `system_config` 的非秘密键读取并验证；企业级 `WECHAT_WORK_CORP_SECRET` 与应用级 `WECHAT_WORK_AGENT_SECRET` 只接受 Worker Secret。两路 access token 和 ticket使用包含 Secret SHA-256 指纹的分域 key，缓存值只含 provider credential与到期时间，不含原始 Secret；TTL最多 6,900 秒，提前留 300 秒刷新窗口。provider 请求固定 5 秒超时，响应流最多 16 KiB；`Content-Length`、JSON object、`errcode`、凭据长度和 `expires_in` 全部验证。票据端遇到 `40001/40014/42001` 只删除该域 token/ticket并重取一次，其他 HTTP/协议/传输/缓存错误统一记录无 Secret 的结构化字段并返回 503。每次签名使用 Web Crypto随机 nonce 和既有固定顺序 SHA-1 工具，不复用 nonce或签名响应。

这与 PHP 有三项有意差异：不再从数据库读取三类旧 Secret；不再为任意 HTTP/HTTPS URL签名；provider/配置失败不再伪装成 `200 + []`。两枚 Secret可由同一已核验的自建应用 Secret分别注入，但运行时仍保持不同绑定和 cache scope，便于后续最小权限与独立轮换。

### 生产 Hyperdrive 与随机 schema 证据

临时 `cinashop-enterprise-wechat-jssdk-audit` Worker只绑定生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。POST-only `/audit|isolated-scenario` 使用两枚互异 Bearer 的 SHA-256 摘要与 timing-safe 比较；第一次 `npm exec` 把 `--config` 误解析到主 Worker，但 Wrangler在任何 Secret写入前失败，主 Worker Secret清单及版本复核无变化。随后改用本地 Wrangler 可执行文件；一次请求在 Secret版本传播前按设计返回 `audit unavailable`，加入仅对 503 门禁的短重试后取得最终证据。所有临时 Worker版本和门禁 Secret均已删除。

生产只读事务固定 `REPEATABLE READ, READ ONLY`、`search_path=public,pg_temp`、30 秒 statement timeout和2 秒 lock timeout。PostgreSQL为 16.14，`public.system_config` 存在16列，五个依赖列齐全并由未限定表名解析到 public；临时 schema审计前为0。五个目标键 `wechat_work_corpid/wechat_work_build_agent_id/wechat_work_build_secret/wechat_work_user_secret/wechat_work_address_secret` 的 matching row、distinct key、重复组、空值行、有效 CorpID/AgentID及旧 Secret存在/非空计数全部为0。审计只返回存在性、计数与格式布尔，不返回配置值、CorpID、AgentID、Secret、行 ID或指纹。Wrangler另行只读列出的生产 `cinashop-api` Secret仍只有 `APP_KEY/DEBUG/INTERNAL_CHAT_TOKEN/OPERATIONS_TOKEN/UPSTASH_REDIS_TOKEN/UPSTASH_REDIS_URL`，两枚企业微信 Secret不存在；`wrangler.toml` 也有意不设置专用 allowlist，因此生产正向调用当前必然在 provider I/O前失败关闭。

隔离写入仅发生在随机 `codex_enterprise_wechat_jssdk_*` schema：克隆 `system_config` 后插入合成非秘密 CorpID/AgentID，顶层事务把随机 schema显式置于 `pg_temp` 前，真实 `EnterpriseWechatJsSdkService` 配合内存 KV和本地 provider模拟执行。最终13/13：search path隔离、企业配置字段、规范 URL、企业签名、新 nonce、应用身份、应用签名、新 nonce、两域 token/ticket缓存复用、缓存无 Worker Secret、非 allowlist Origin拒绝、缺 Secret 503和 public全行指纹不变；两次企业加两次应用的 provider总调用恰为4。返回成功前 `finally` 已验证临时 schema `0→0`；`public.system_config` 未变。

### 量化、验证与剩余门禁

两条 exact route加入后，注释感知静态审计为 PHP 1,904、Workers 1,436、精确匹配738、可执行匹配720、明确不可用18、原始缺失1,166、证据化退役4、可执行缺口1,162，覆盖为 `38.8%/37.8%/37.9%`。`/api` 为 PHP457、TS747、精确356、可执行353、不可用3、原始缺失101、退役1、可执行缺口100，对应 `77.9%/77.2%/77.4%`；相对 STORE-B，全局和 `/api` 可执行缺口均减少2。

WORK-A 代码与生产数据库/隔离协议证据可以勾选，但生产能力尚未启用：缺 CorpID、AgentID、两枚 Worker Secret和正式 H5 Origin；旧 UniApp URL编码、SPA URL选择与全局 Promise仍未修；没有企业微信真实租户/provider正向调用、真机、旧端/新端 golden response、预发、影子流量或发布后观察。主生产 Worker在本批前后始终为100%版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，未部署应用 Worker或 Pages。WORK-B本地读7条、WORK-C回调1条及内嵌 Admin 51条继续保持未完成。

仓库最终门禁为双 TypeScript配置通过，150/150个单元测试文件与906/906项通过，WORK-A两个定向文件14/14；审计 Worker dry-run为711.78 KiB/gzip 132.54 KiB，主 Worker dry-run为4,821.35 KiB/gzip 912.64 KiB。Windows Workers runtime仍在0条断言前因既有 `workerd 0xc0000005` 启动失败，不能记为 runtime通过；本批由生产 Cloudflare Worker + Hyperdrive随机 schema的13/13真实 service场景提供运行时证据。临时 Worker最终查询返回 Cloudflare code 10007（不存在），生产 Secret名称清单无新增，主 Worker版本未变。

- [x] 两条 PHP 精确合同、响应主要字段、企业/应用 ticket 分离、签名算法与六项实际 JS API列表已实现。
- [x] HTTPS Origin allowlist、URL规范化、两枚 Worker Secret、限时缓存、超时/限长、提前失效单次刷新和真实 HTTP失败关闭已实现。
- [x] 生产五键只读审计与随机 schema真实 service 13/13完成；public不变，临时 schema/Worker/Secret清零。
- [ ] 录入并复核 CorpID/AgentID，以 Worker Secret注入两枚凭据，批准专用 H5 Origin；取得真实租户后补 provider和真机 E2E。
- [ ] 修复旧 UniApp query编码、iOS/Android SPA签名 URL及模块级 Promise复用；新 UniApp已有WORK-B上下文/读取client，但两条JS-SDK配置client仍未恢复。
- [ ] WORK-B 的生产数据/页面/E2E仍未完成；WORK-C、主 Worker/Pages发布、预发、影子流量、明确发布批准和发布后观察仍未完成。

## API-008 企业微信群/客户本地读详细迁移审计（WORK-B 子批次，2026-08-30）

### 权威合同与旧实现安全审计

WORK-B 权威范围固定为七条 PHP GET：`/api/work/groupInfo`、`groupMember/:id`、`client/info`、`order/list`、`order/info/:id`、`product/cart_list` 与 `product/visit_list`。前两条位于旧 `ClientMiddleware` 外，但 `BaseWork` 仍假定中间件注入的请求宏存在；其余五条由 `ClientMiddleware` 直接相信 query `userid`，再按 CorpID + external user ID取客户，没有任何企业员工身份证明。旧订单详情按全局自增 ID读取，未追加客户 UID，构成直接 IDOR；群成员的其他群数量逐行查询且只按 `userid`，既有 N+1，也可能跨 CorpID计数；客户标签读取也没有绑定当前跟进员工。

旧 `ProductServices::getProductCartList()` 有一个需保留的特殊语义：无 `store_name` 时返回该客户购买过的商品，带搜索词时注释明确写着“搜索不局限加入购物车｜浏览”，会检索公开商品目录。本批保留这个兼容行为，因为只返回公开商品摘要；订单、客户资料、跟进标签和无搜索购买记录仍全部受客户 UID/员工关系约束。

### 可信员工上下文与最小权限边界

实现遵循企业微信官方[构造网页授权链接](https://developer.work.weixin.qq.com/document/path/91022)和[获取访问用户身份](https://developer.work.weixin.qq.com/document/path/91023)协议：`POST /api/work/context/challenge` 只接受精确 HTTPS `WORK_WECHAT_ALLOWED_ORIGINS`，回调地址必须同 Origin；服务端生成 256-bit state 与 verifier，只把 verifier摘要、Origin和五分钟到期时间写入 Upstash Redis，原 verifier进入 `__Host-cinashop-work-context-state` 的 `HttpOnly + Secure + SameSite=Lax + Path=/` Cookie。`POST /context/exchange` 原子 GETDEL state、校验 Cookie verifier、再以 code摘要执行五分钟 NX重放门禁；provider只接受返回内部 `userid` 的身份，OpenId-only外部联系人响应和 CorpID不一致均拒绝。challenge/exchange分别按 HMAC脱敏 IP限制为20/10次每分钟，请求体必须是最多4 KiB的 JSON。

换取的 HS256 JWT固定五分钟，issuer为 `cinashop-work-context`，`work-client` 与 `work-group` 使用不同 audience，claims只含 CorpID、员工 userid、本地目标 ID和客户 UID。签发时必须存在唯一活跃 `work_member`，客户上下文要求唯一未删除客户及当前员工唯一有效跟进关系，群上下文要求唯一活跃群且员工是群主或活跃内部群成员；每一次读取都会重新验证上述本地关系，因此员工停用、跟进撤销、客户删除或群权限变化会即时失败关闭。入口只接受标准 `Authorization: Bearer`，不接受 query token、external_userid、chat_id或客户端 UID作为读取授权。

专用 Work Origin 已接入全局 CORS中间件，但路径判定把“仅在 `WORK_WECHAT_ALLOWED_ORIGINS` 的来源”限制为 `/api/work`；同一来源不能因此跨域访问 `/adminapi`、订单或其他商城 API。这个边界符合 Cloudflare [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 中的最小权限与失败关闭要求。所有七条个性化响应均为 `private, no-store`，图片引用通过既有附件签名层返回。

### 七条读取的实现差异

`groupInfo` 和 `groupMember/:id` 先把 token目标与 path ID绑定；群统计单次聚合，成员分页最多100条，员工/客户、跟进标签及其他群计数批量加载，不再 N+1。其他群计数 JOIN `work_group_chat` 并绑定当前 CorpID和活跃群；客户标签只读取当前员工的跟进关系。`client/info` 只投影可用商城账户、组、用户标签、推广人和当前跟进标签；重复员工、客户、跟进或群成员关系全部返回服务不可用，避免任意选中一条。

订单列表、退款列表和订单详情均由上下文中的客户 UID派生；详情追加 `store_order.uid = client.uid`，关闭 PHP IDOR，且排除系统删除、用户删除、非平台顶级订单和不兼容退款类型。商品足迹按同一 UID聚合最新访问时间；购买记录无搜索时 INNER JOIN当前 UID的订单快照并去重，带搜索时保留 PHP公开目录检索语义。订单/退款商品快照批量读取并重签图片，没有逐订单查询。

新 UniApp 增加类型化 challenge/exchange和七条读取 client；请求工具支持显式 header与 `withCredentials`，Work Bearer只保存在调用方内存，不复用普通商城登录 token。当前仓库仍没有旧 `work/group`、`work/user`、`work/userInfo`、`work/order`、`work/orderDetail` 五个页面及 OAuth回跳编排，因此只能把 API client计为完成，不能把前端流程计为完成。

### 直接生产 PostgreSQL/Hyperdrive 审计

经用户明确授权，本批直接连接生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产审计运行于 `REPEATABLE READ, READ ONLY` 事务，固定 `search_path=public,pg_temp`、45秒 statement timeout、2秒 lock timeout、单连接；只返回表/列/索引及聚合计数，不返回 userid、external_userid、chat_id、UID、订单号、配置值、业务 ID、头像、电话或其他 PII，也不执行 DML/DDL。PostgreSQL为16.14，13张依赖表及所需列全部存在。

生产企业微信业务域当前为空：成员/活跃成员0，客户/活跃客户0，跟进/有效跟进0，群/活跃群0，群成员/活跃群成员0，群统计0；非空 `wechat_work_corpid` 与 `wechat_work_build_agent_id` 配置均为0。重复身份、孤儿关系和可见性异常聚合也全为0，但这是空表结果，不是正向数据质量证明。查询所需索引已有：成员 `(corp_id,userid)`、客户 `(corp_id,external_userid)`、跟进 `(userid,client_id,id)`、群 `(corp_id,chat_id)`、群成员 `(group_id,status,join_time,id)`、订单局部索引 `so_kefu_customer_orders` 和访问索引 `sv_kefu_recent`；没有证据支持新增生产索引，所以本批未执行生产 DDL。

### 生产 Hyperdrive 隔离服务证据

合成写入只发生在随机 `codex_work_context_*` schema。所有克隆、夹具和真实 service调用在 transaction-local `search_path` 下完成；这也验证了 Hyperdrive连接池不能依赖 session级 `search_path`。场景覆盖客户授权、客户订单列表/详情、他人订单拒绝、购买/访问商品、一次性 OAuth state、群授权与分页、今日新增/退群的 `join_time + status` 语义、错误群路径、跨 audience拒绝、撤销跟进即时失效，以及同一 external_userid 位于另一 CorpID时群数量不可见，共14/14通过。最终 `public` 11张指纹表未变化，临时 schema `0→0`，`schema_cleanup=dropped`；最终临时审计构件及两枚摘要 Secret随独立 Worker删除。

隔离调试曾暴露并修复四处只在权威对照或真实 PostgreSQL/Hyperdrive路径出现的问题：session级 `search_path` 不保证落到同一池连接，改为事务内 `SET LOCAL`；PostgreSQL要求 `SELECT DISTINCT` 排序列同时出现在投影中，商品查询增加内部 sort后再剔除；群数量需要显式绑定 CorpID；今日新增/退群必须像PHP一样都按 `join_time` 并分别限定状态。此前一次边缘请求返回 Cloudflare 1042，带 `global_fetch_strictly_public` 的同一构件重试通过；最终统计修正后的第一次调用又因两次独立 Secret部署尚未传播而在数据库访问前返回403，`finally`清理后改为一次 `secret bulk`，最终14项无重试错误完成。1042和403两次都不能记为通过。

### 量化、验证与剩余门禁

七条 PHP exact route与两条安全扩展加入后，注释感知路由审计为 PHP1,904、Workers1,445、精确匹配745、可执行匹配727、明确不可用18、原始缺失1,159、证据化退役4、可执行缺口1,155，覆盖为 `39.1%/38.2%/38.3%`。`/api` 为 PHP457、TS756、精确363、可执行360、不可用3、原始缺失94、退役1、可执行缺口93，对应 `79.4%/78.8%/78.9%`；相对 WORK-A，全局及 `/api` 的精确/可执行匹配各增加7，可执行缺口减少7，两条 context扩展不增加 PHP匹配分子。

仓库门禁为 Worker双 TypeScript配置、UniApp TypeScript、H5和微信小程序构建通过；企业微信/认证定向4文件23/23，全量151/151单元测试文件、911/911项通过。主 Worker dry-run为4,868.15 KiB/gzip922.36 KiB，审计 Worker为1,023.37 KiB/gzip184.22 KiB。Windows Workers runtime仍在0条断言前因既有 `workerd 0xc0000005` 启动失败，不能记为 runtime通过；真实Cloudflare Worker + 生产Hyperdrive随机 schema的14/14提供了本批运行时数据库证据。

WORK-B的代码、生产结构与隔离契约可以勾选，但生产能力仍不可用：业务表与CorpID/AgentID为空，`WORK_WECHAT_ALLOWED_ORIGINS` 和企业微信 Secret尚未配置，没有可换取 userid的真实租户/provider证据；五个旧Work页面、OAuth回跳、旧/新端 golden response、H5/小程序/APP真机、预发、影子流量、主 Worker/Pages发布及发布后观察均未完成。主生产Worker仍应保持100%版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；本批没有正式部署或切流。

- [x] 七条 PHP精确读取和两条一次性上下文扩展已实现，query身份、订单IDOR和跨CorpID群计数均失败关闭。
- [x] 内部员工OAuth、一次性state/code、双audience五分钟token、关系逐请求复核、Work-only路径CORS和有界限流已实现。
- [x] 生产13表/索引只读审计和随机schema真实service 14/14完成；没有生产业务DML/DDL，public不变，临时资源清零。
- [x] 新UniApp类型化API client、Worker/UniApp类型检查、H5/微信小程序构建、911项单元测试与两份dry-run完成。
- [ ] 录入并复核CorpID/AgentID、两枚Secret、正式Origin和真实Work数据，完成真实员工/客户/群/订单最小样本迁移与PHP golden response。
- [ ] 恢复五个Work页面与OAuth回跳，完成真机、预发、影子流量、明确发布批准、主Worker/Pages发布及发布后观察。
- [x] WORK-C0 的可信接收，以及 WORK-C1 的 `del_external_contact/del_follow_user` 关系 tombstone 代码与生产 Hyperdrive 隔离已在后续章节完成；C1 未启用/未发布，其他业务投影、真实租户回调、真实 Queue 平台重投与发布仍未完成。

## API-008 企业微信回调详细迁移审计（WORK-C 可信接收子批次，2026-08-30）

### PHP 权威链路与失效模式

精确权威路由是 `ANY /api/work/serve`：`route/api.php → Wechat::work() → WechatServices::workServe() → Work::serve() → EasyWeChat Work Server → WorkListener`。GET由旧SDK完成 URL验证，POST由SDK验签/解密后直接调用 listener。listener同步处理 `change_contact`、`change_external_chat`、`change_external_contact`、`change_external_tag` 和 `batch_job_result`；成员、部门、客户、群和标签的新增/更新会在回调HTTP请求内继续调用企业微信provider，再写本地多张表。添加客户还会同步触发欢迎语、自动标签和商城用户关联。

旧路径没有持久事件唯一键、事件账本、主体水位或事务outbox。同一个回调被企业微信重试时会再次执行；较旧的更新可以覆盖较新的删除/解散。更严重的是，通讯录、客户和群处理器普遍 `catch Throwable` 后把完整解密payload连同文件/行号写日志，随后仍由SDK返回成功；这既泄露成员/客户标识，也让暂时的provider或数据库失败变成不可恢复的静默丢事件。PHP客户删除会软删整个客户而不先复核其他跟进人，群更新按事件提示增减数量而不是以权威快照收敛，这些业务投影风险不能照搬。

### 协议边界与密钥管理

实现对齐企业微信官方[接收消息与事件](https://developer.work.weixin.qq.com/document/path/90238)和[回调配置](https://developer.work.weixin.qq.com/document/path/90968)协议：GET读取URL-decode后的`msg_signature/timestamp/nonce/echostr`，先计算`SHA-1(sort(token,timestamp,nonce,ciphertext))`，再解密并原样返回明文；POST只接受同一签名协议的XML包。43字符EncodingAESKey补`=`后必须精确解码为32字节，AES-256-CBC的IV取Key前16字节；由于企微协议的PKCS#7块大小是32而不是AES原生16，本实现关闭Node自动padding并手工验证1～32的每一个填充字节。明文必须满足`random16 + uint32BE(msg_len) + msg + receive-id`，尾部receive-id、明文`ToUserName`和数据库CorpID三者必须一致。

回调Token与EncodingAESKey不再从`system_config`读取，只接受`WECHAT_WORK_CALLBACK_TOKEN`和`WECHAT_WORK_CALLBACK_AES_KEY`两枚Worker Secret；CorpID继续是非秘密配置。主生产Worker当前没有这两枚Secret，`wechat_work_corpid`、旧`wechat_work_token`和旧`wechat_work_aes_key`非空计数也全部为0，所以即使未来误部署当前代码，入口也会在验签前503失败关闭，不能被当成已启用。

POST按流读取并在超过64 KiB时立刻cancel，不先把大包完整缓冲；拒绝DOCTYPE、ENTITY、stylesheet、未知XML实体、NUL和无效UTF-8。解密XML只投影22个协议白名单字段，`Content`等消息正文、外层签名、nonce、密文和完整XML都不落库。`ANY`注册用于精确覆盖PHP路由，运行时只允许GET/POST，其他方法带`Allow: GET, POST`返回405。验签/格式失败分别返回真实403/400，配置或持久化失败返回503，使企业微信继续重试；只有事件与outbox已同事务提交后，Queue投递失败才返回200并交给定时补偿。

### 事件账本、outbox与乱序水位

新增三张Worker扩展表：`work_callback_event`保存不可变的规范payload及状态，`work_callback_outbox`保存Queue投递租约和失败处置，`work_callback_watermark`保存每个脱敏主体的最高事件水位。`event_key = SHA-256(corpId || payloadHash)`；payload、subject也分别哈希，数据库唯一索引在并发重试下只保留同一事件/同一outbox。Queue body严格只有`action/outboxId/eventId/eventKey`四键，不携带CorpID、成员、客户、群、state或welcome code。

HTTP提交后立即尝试Queue；发送结果未知可重复投递，消费者以outbox行锁、租约和event唯一键收敛。五分钟Cron只投递不含业务数据的根消息，由Queue消费者扫描`PENDING/FAILED`和过期租约；Queue失败记录固定错误码而不记录payload。消费端按`subject_key_hash`取得PostgreSQL advisory transaction lock，以`event_time`为主序、`sequence_rank`为同秒消歧：删除/解散100，更新/编辑50，创建10；较旧或同秒低优先级事件标记`SUPERSEDED`。不认识的新消息/事件以及旧PHP空处理分支留痕为`IGNORED`，不会冒充业务投影已执行。

WORK-C0 刻意把当时的最终成功状态命名为`ORDERED`，而不是`PROCESSED/APPLIED`。后续 C1 只对 `del_external_contact/del_follow_user` 增加关系 tombstone；C2 又把管道 `status` 与业务 `projection_status` 物理分列，C1 结果迁为 `APPLIED/APPLIED_NOOP`，其余已识别但当时尚未实现的投影明确为 `REFRESH_REQUIRED`。C3～C7 后续已分别完成成员、部门、客户/follow/tags、群/群成员和企业客户标签 current 投影的代码、生产结构与隔离服务验收，详见本文件后续专章；`batch_job_result` 明确只审计为 `IGNORED`，不冒充目录对账。本段审计时尚缺的 C8 action outbox 与 payload 保留/脱敏策略已在 2026-08-31 后续专章完成代码、生产结构和隔离验收；Linux workerd 门禁也已由 Actions `33373018752` 关闭。WORK-C 父项仍因真实数据/租户、预发和发布闭环未完成而保持未勾选。

### 生产数据库与隔离场景证据

所有生产操作都通过Hyperdrive配置`9748c294e21c49a99579c9cef70102e0`执行。第一次只读审计在任何DDL前因审计SQL把静态表名数组错误渲染为列标识而500；诊断轮只返回脱敏错误`column work_callback_event does not exist`，两轮都未进入`/migrate`且临时Worker在`finally`删除。修正为静态`VALUES`后，从头完成`REPEATABLE READ, READ ONLY`审计：PostgreSQL 16，三张目标表/索引确实不存在，CorpID/旧Token/旧AES配置、成员、客户、跟进、群和群成员均为0。

随后应用外部`0109_work_callback_pipeline.sql`（Worker内嵌`migration_0115`）两遍；每遍都在短事务中固定`search_path=public,pg_temp`、5秒锁超时和45秒语句超时。结果为三表39列、10个含主键索引全部严格回读且三表均0行；`system_config/work_member/work_client/work_client_follow/work_group_chat/work_group_chat_member`逐行JSON哈希组成的全行指纹前后相同，没有既有业务DML。

随机schema在同一生产PostgreSQL/Hyperdrive引擎执行11/11：GET明文回显、重复事件/唯一outbox、Queue四键脱敏、首次处理/重复消费、较旧事件被压制、同秒解散优先创建、未知事件审计、Queue失败保留、伪造签名零写入和水位数量全部通过；最终状态为`ORDERED=3/SUPERSEDED=2/IGNORED=1/RECEIVED=1`，outbox为`COMPLETED=6/FAILED=1`，FAILED正是故意注入的Queue失败且证明未丢。随机schema与一次性Worker均删除，Cloudflare查询返回10007；主Worker仍为100%版本`9f1fd655-e60f-41c1-8280-738bc85d73ef`，正式Secret清单未新增，未发布应用Worker或Pages。

### 量化、验证与剩余门禁

`ANY /api/work/serve`加入后，注释感知路由审计为PHP1,904、Workers1,446、精确匹配746、可执行匹配728、明确不可用18、原始缺失1,158、证据化退役4、可执行缺口1,154，覆盖为`39.2%/38.2%/38.3%`。`/api`为PHP457、TS757、精确364、可执行361、不可用3、原始缺失93、退役1、可执行缺口92，对应`79.6%/79.0%/79.2%`。目标结构由224增至227，新增三张均是明确的Worker扩展；共享源表仍为201，不能用扩展表夸大源迁移。

WORK-C0 当时的仓库门禁为Worker双TypeScript配置通过，152/152个单元测试文件与921/921项通过，WORK-C定向文件10/10、连同迁移/定时任务/既有Work边界共4文件56/56；主Worker dry-run为4,914.35 KiB/gzip931.30 KiB，审计Worker为1,002.32 KiB/gzip177.95 KiB。Windows Workers runtime仍在0条断言前因既有`workerd 0xc0000005`启动失败，不能记为runtime通过；C0由真实Cloudflare Worker、生产Hyperdrive DDL和随机schema 11/11提供运行时证据，C1 的后续证据单列如下，不能混写成同一轮全量回归。

- [x] GET验证、POST有界读取/验签/解密、receive-id/CorpID绑定、白名单持久化与真实HTTP失败语义已实现。
- [x] 事件唯一账本、事务outbox、Queue脱敏、过期租约/Cron补偿、至少一次幂等和主体乱序水位已实现。
- [x] 生产三表DDL两遍幂等、既有业务全行指纹不变、随机schema 11/11及临时资源清零已完成。
- [x] C1 两类关系 tombstone 的代码、生产 `0110`/内嵌 `0116` 两遍、随机 schema 20/20、全行/owned sequence 指纹与资源清理已完成；仍未启用/未发布。
- [x] C1～C7 的关系 tombstone、provider 基础、成员、部门、客户/follow/tags、群/群成员和企业客户标签 current-state 均已完成代码、生产结构与随机 schema 验收；authority gate 全部关闭，主 Worker 未发布，真实租户/provider/源数据仍未验收。
- [x] 欢迎语、自动标签等远端写已进入独立 action outbox/Queue，并覆盖部分成功、UNKNOWN 不盲重发、人工审计与 payload 脱敏；禁止回到 HTTP 请求内同步调用。
- [ ] CorpID、两枚回调Secret、真实租户事件、旧PHP golden response、预发/影子流量、主Worker发布与发布后观察均未完成。

## WORK-C0～C8 子批次、PHP→TS 事件能力矩阵与首批投影边界（2026-08-30）

上一节记录的可信接收管道现在明确命名为 **WORK-C0**；其代码、生产 DDL、随机 schema 11/11 与资源清理证据原样保留，不回写成更大的完成声明。随后 **WORK-C1** 的关系 tombstone、**WORK-C2** 的投影运行时/provider 基础、**WORK-C3** 的成员 current 投影和 **WORK-C4** 的部门 current 投影也依次完成代码与生产 Hyperdrive 隔离，但均未启用、未发布。WORK-C 父项继续未完成：C1 只新增两类关系删除，C3/C4 只覆盖成员/部门，其他事件的 `ORDERED` 仍不表示客户、群、标签或远端副作用已经收敛。

后续工作拆成 C1～C8。**C1～C8 现已达到“代码/生产结构/随机 schema 验收完成，未启用/未发布”**：C1 的 20/20、C2 的 27/27、C3 最新隔离轮的 direct 11/11 与 service 33/33、C4 的 migration 4/4 与 direct-service 20/20、C5 的 migration 4/4、direct-service 12/12、current-context 6/6、C6 的 migration 6/6、projection 13/13、current-context 5/5、C7 的 migration 6/6、direct-service 13/13，以及 C8 的 18/18 动作/保留/人工处置证据见下。真实企微租户回调/provider 正向、源 MySQL 导入、主 Worker 切流和发布均不在子批次代码完成声明内。

### PHP→TS 事件能力矩阵

PHP 权威分发位于 `C:\cinagroup\cinashop-php\app\listener\wechat\WorkListener.php:29-67`。它在 callback HTTP 请求中同步分发五类 event；多数 create/update 分支会继续调用企业微信 provider，再写多张本地表。当前 TypeScript 消费器先统一排序，再将 C1 两类关系删除送入 tombstone 投影，C3～C7 分别把成员、部门、客户/follow/tags、群/群成员和企业客户标签送入各自三相/终止态 current 投影；`batch_job_result` 继续显式 `IGNORED`。欢迎语、自动标签、商城用户关联等远端副作用仍等待 C8，不能把 `ORDERED/REFRESH_REQUIRED` 当成副作用已完成。

| 企业微信事件 | PHP 权威能力 | 当前 TS/C0～C7 | 目标子批次与未完成门禁 |
|---|---|---|---|
| `change_external_contact / del_external_contact` | `WorkListener.php:160-164` 调 `WorkClientServices::deleteClient()`；旧实现先销毁共享 client，再 tombstone 指定员工 follow | C1 已按 `(CorpID, ExternalUserID, UserID)` 关系排序，只 tombstone 指定活跃 follow，并记 `APPLIED/APPLIED_NOOP`；不删除共享 client | 代码/生产 Hyperdrive 隔离完成；真实回调、启用和发布未完成 |
| `change_external_contact / del_follow_user` | `WorkListener.php:167-170` 调 `deleteFollowClient()`，只把匹配 follow 的 `is_del_user` 置 1 | 与上行共用 C1 关系终止状态机和原子终态 | 代码/生产 Hyperdrive 隔离完成；真实回调、启用和发布未完成 |
| `change_external_contact / add_external_contact` | `WorkListener.php:150-154` 调 provider 拉完整客户/follow；随后同步触发欢迎语、自动标签和商城用户关联 | C5 已以事务外 provider、client/profile+relationship 双层 fence、五张 current 表收敛完整客户/follow/tags；authority 仍关闭 | 本地权威快照已验收；C8 才做独立 action outbox 的远端副作用，真实租户/启用/发布未完成 |
| `change_external_contact / edit_external_contact` | `WorkListener.php:155-159` 调 provider 刷新客户、全部 follow/tags，并尝试商城用户关联 | C5 已定义 operation-specific `not_found`、429、跨 profile fence 迟到响应、多员工关系和 target-only 恢复终态 | 代码/生产 Hyperdrive 隔离完成；真实 provider、商城 UID 关联、启用和发布未完成 |
| `change_contact / create_user, update_user, delete_user` | `WorkListener.php:95-109` 调成员 service；create/update 需要完整成员资料和部门关系 | C3 已按三相事务外 provider、稳定 member identity、不可变 direct rename edge、成员/扩展/关系 current 表和 callback-authoritative delete 收敛；authority 仍关闭 | 代码/生产 Hyperdrive 隔离完成；真实租户、全量对账、启用和发布未完成 |
| `change_contact / create_party, update_party, delete_party` | `WorkListener.php:110-124` 调部门 service；更新需 provider 权威详情 | C4 已按三相事务外 provider、`(CorpID,DepartmentID)` 身份、父链/单根约束、负责人 current 与 callback-authoritative delete 收敛；authority 仍关闭 | 代码/生产 Hyperdrive 隔离完成；真实租户、全量对账、启用和发布未完成 |
| `change_contact / update_tag` | PHP 分支为空，`WorkListener.php:125-127` | C0 未把空分支冒充恢复 | 继续 IGNORED，除非后续有独立权威同步设计 |
| `change_external_chat / create, update, dismiss` | `WorkListener.php:190-208` 拉群详情或按事件更新/解散；旧更新存在按提示增减计数风险 | C6 已以 provider 完整群/成员快照和 callback-authoritative dismiss 收敛，禁止盲增减和硬删历史 | 代码/生产结构/隔离验收完成；真实租户、启用和发布未完成 |
| `change_external_tag / create, update, delete, shuffle` | `WorkListener.php:225-242` 调用户标签 service；`shuffle` 为空 | C7 已以远端字符串 tag/group、strategy scope、目录/组快照、omission tombstone 和 callback-authoritative delete 收敛；authority 仍关闭 | 代码/生产结构/隔离验收完成；真实租户、源标签导入、启用和发布未完成 |
| `batch_job_result / sync_user, replace_user, invite_user, replace_party` | PHP 四个分支全部为空，`WorkListener.php:71-82` | 保留 `JobType/JobId/ErrCode` 审计元数据并明确 `IGNORED`，不保存 `ErrMsg`，不冒充目录已同步 | 若未来需要全量对账，必须另建有游标、结果回读和可重放证据的 reconciliation 任务；不并入 callback completion |
| `text/image/voice/video/news/update_*` | PHP 仅列出空分支，`WorkListener.php:52-65` | 非本批业务投影事件 | 保持显式未迁移/IGNORED；不能用路由存在推导能力完成 |

### C0～C8 的精确边界

- **WORK-C0（已完成）可信接收、事务 inbox/outbox、Queue 与乱序水位**：只保留上一节已有证据，不宣称任何成员、部门、客户、follow、群、成员或标签已经刷新。
- **WORK-C1（代码/生产 Hyperdrive 隔离完成，未启用/未发布）外部联系人跟进关系 tombstone**：只实现 `del_external_contact` 和 `del_follow_user`；不调用 provider，不执行远端写，不创建客户或 follow。事件主体已改为关系级 `(CorpID, ExternalUserID, UserID)`，缺任一 ID 即失败关闭；同一事务唯一解析 client/follow、更新 `is_del_user=1`、推进关系水位并写 `APPLIED/APPLIED_NOOP`。不存在目标为幂等 no-op，重复活跃 client/follow 由生产 partial UNIQUE 和服务失败关闭共同拒绝。
- **WORK-C2（代码、生产 Hyperdrive 与真实 Cloudflare Queue 隔离完成，未启用/未发布）投影运行时与 provider 读取基础**：独立 `EnterpriseWechatProviderClient` 已按 `company-jssdk/agent/directory/external-contact` credential scope 隔离 token/cache，JS-SDK 已真正委托该 client；统一 5 秒超时、GET/POST、禁止重定向、有界请求/JSON、fatal UTF-8、同 isolate 跨 client 的失效 token 单次刷新、2xx operation-specific `not_found`、429/5xx/网络 `retryable`、裸 404/未知业务码默认 `terminal` 和 metadata-only 错误。`event.status` 与 `projection_status` 已分列；Work 严格四键/两键消息也已完成真实平台失败、自动重投、DLQ 归档、去重和真实 callback consumer 人工重放。
- **WORK-C3（代码、生产 Hyperdrive 结构与隔离服务完成，未启用/未发布）成员 current-state**：覆盖成员 create/update/delete、UserID 变更、扩展资料和部门关系全量替换；provider 在事务外读取，应用快照与水位在短事务内原子提交。rename 采用不可变 direct edge，最新事件污染失败关闭；完整证据见后续 C3 专章。
- **WORK-C4（代码、生产 Hyperdrive 结构与隔离服务完成，未启用/未发布）部门 current-state**：覆盖部门 create/update/delete、父子关系、负责人和排序；以 `(CorpID, DepartmentID)` 唯一身份与明确 tombstone 收敛，禁止无证据硬删历史或级联成员关系。完整证据见后续 C4 专章。
- **WORK-C5（代码/生产结构/隔离验收已完成，未启用/未发布）客户、follow 与 follow tags 权威快照**：add/edit 已穷尽 provider cursor并保留其他员工关系；关系级 direct fence、防跨 profile fence 迟到响应、目标 tombstone 恢复和 omission 不删除均已验证。client authority、真实租户/数据和发布仍关闭，详细证据见 C5 专章。
- **WORK-C6（代码/生产结构/隔离验收已完成，未启用/未发布）客户群和群成员**：按 `(CorpID, ChatID)` 稳定身份全量刷新群主/成员，dismiss 为终止态；旧 provider 响应、同秒或不可能更晚的 create/update 均不得复活已解散群，详细证据见 C6 专章。
- **WORK-C7（代码/生产结构/隔离验收已完成，未启用/未发布）企业客户标签与批量结果边界**：以 `(CorpID,StrategyID,remote string ID)` 保存 tag/group current-state；create/update/shuffle 在事务外读取标准或 strategy 权威目录，delete 由 callback 终止，组/全目录遗漏写 tombstone且保留历史。`batch_job_result` 只记有界元数据并维持 `IGNORED`，不把完成通知解释为同步收敛。详细证据见 C7 专章。
- **WORK-C8（代码/生产结构/隔离服务/Admin 处置面已完成，未启用/未发布）欢迎语、自动标签与商城用户关联**：三类动作已拆成独立 action outbox/Queue，覆盖部分成功、429、结果未知、人工处置、回调保留与脱敏；Linux runtime 已关闭，真实源数据、旧媒体素材、企业微信租户、预发、影子流量和发布批准仍未完成。

### 为什么首批只选 `del_external_contact` / `del_follow_user`

这两类事件是当前唯一可以不依赖 provider、又能安全落到既有明确 tombstone 字段的业务投影：现有 callback 白名单已经保存 `ToUserName`、`ExternalUserID` 和 `UserID`，而 `work_client_follow.is_del_user` 正是关系级终止标记。写入是单向的 `0→1`，天然适合重复投递、乱序和 Queue 重试；目标不存在也可以作为可审计 no-op，而不是补造一行默认值客户或 follow。

PHP 的两条删除分支不能原样复制。`C:\cinagroup\cinashop-php\app\services\work\WorkClientServices.php:335-349` 的 `deleteClient()` 在同一事务先销毁 `work_client`，再更新当前员工的 follow；`deleteFollowClient()` 则只更新关系，见同文件 `:360-370`。一个 `ExternalUserID` 可以同时被多名员工跟进，因此 `del_external_contact` 只证明特定 `(ExternalUserID, UserID)` 关系终止，不能证明共享客户已经从整个企业消失。C1 明确采用以下迁移决策：

1. 已以 `(CorpID, ExternalUserID, UserID)` 构造关系 subject/watermark；`EnterpriseWechatCallbackCrypto.ts:289-307` 现在要求 ExternalUserID 与 UserID 同时存在，定向单元测试证明不同员工不再互相压制。
2. 已以 `(corp_id, external_userid)` 唯一解析活跃 `work_client`；0 行为 no-op，歧义失败关闭，并由精确定义的 partial UNIQUE 阻止新的活跃重复。
3. 已以 `(client_id, userid)` 唯一解析活跃 follow；0 行为 no-op，歧义失败关闭；命中时只写 `is_del_user=1`，同样由 partial UNIQUE 阻止新的活跃重复。
4. **不得修改 `work_client.delete_time`，不得调用共享 client 的软删/硬删，也不得影响其他员工 follow。**
5. follow tombstone、`APPLIED/APPLIED_NOOP`、event/outbox 与关系水位已在同一事务提交；故障注入证明任何异常整体回滚，不会先推进 watermark。

### 已收口模型与剩余运行时缺口

- C1 已把外部联系人 subject 改为关系级，并让 `EnterpriseWechatCallbackService.claim()` 同时读取 `corpId/payload`；这两项不再是 C1 缺口。
- callback 白名单 `EnterpriseWechatCallbackCrypto.ts:9-45` 足够事件身份但不含 create/update 所需的完整业务快照；C3～C7 已分别通过事务外成员/部门/客户/群/标签 provider 回源完成，不能用数据库默认值伪造。
- 外部 `0110`/内嵌 `0116` 已建立两个活跃自然键 partial UNIQUE，当前生产活跃 client/follow 重复组均为 0。源 MySQL 当前不可用，无法证明未来导入数据也无重复；导入前必须先预检并 canonicalize/处置重复，否则唯一索引会显式拒绝，而不是静默任选一行。
- `work_member_relation`、`work_client_follow_tags` 是无稳定源键的历史 multiset；不能为了方便投影直接把既有导入证据改写成唯一 current-state。需要新 current 表或先做正式 canonicalization。
- `work_label` 没有远端字符串 tag/group ID；C7 不能把回调字符串 ID 强塞进本地 serial ID。
- callback 表的 CorpID 列容量为 64 字符，但运行时 `EnterpriseWechatCallbackService.config()` 当前通过 `isEnterpriseWechatCorpId()` 把已配置 CorpID 限制为 1～18 个安全字符，既有 Work 业务表也使用 18 字符。64 是存储容量，不代表运行时已允许更长 CorpID；放宽前必须统一验证和业务表边界。
- Work callback 与订单消息共用正式 Queue 的架构未变，但 C2 已用独立临时 source/DLQ/unarchived Queue 验证当前严格 validator、平台自动重投、持久归档和由真实 callback consumer 执行的人工 replay；故障从未注入共享 `cinashop-order`。正式主 Worker仍未发布，线上消费路径是否启用继续属于发布门禁，而不再是 C2 代码/平台语义缺口。
- `add_external_contact/edit_external_contact` 现已由 C5 在 authority/full-visibility 双 gate 下执行 provider 权威客户/follow/tags 快照，并定义 target-only tombstone 恢复与迟到响应重拉；生产 gate 仍关闭，不能把隔离通过写成线上已启用。

### C1 生产 Hyperdrive 隔离结果与执行记录

C1 现可标记为“代码/生产 Hyperdrive 隔离完成”，但仍是**未启用、未发布**。完成证据严格限定如下：

1. 生产 PostgreSQL 16 通过既定 Hyperdrive 将外部 `0110_work_callback_follow_projection.sql`（Worker 内嵌 `migration_0116`）连续应用两遍。C1 当时的 `wce_status_ck` 精确允许 `APPLIED/APPLIED_NOOP`；C2 随后把这些业务结果迁到独立 `projection_status`。新代码不再向 event 管道状态写入投影终态，但 expand 阶段的 event CHECK 仍精确兼容旧 writer 使用的 9 个状态，收窄需等新 Worker 100% 切换且旧 writer 退出后再执行。两个精确定义的 partial UNIQUE 分别为 `work_client(corp_id,external_userid) WHERE delete_time IS NULL AND external_userid<>''`，以及 `work_client_follow(client_id,userid) WHERE is_del_user=0 AND client_id>0 AND userid<>''`，目录回读同时确认两者 `indisvalid=true/indisready=true`。DDL 前活跃 client/follow 自然键重复组均为 0，应用后 `work_callback_event/outbox/watermark` 仍均为 0 行。
2. 随机 schema 在同一生产 PostgreSQL/Hyperdrive 引擎完成 20/20：既保留 C0 的明文验证、事件/Queue 幂等、乱序、同秒删除、未知事件、持久 Queue 失败和伪造签名零写，也覆盖关系级重复、只 tombstone 指定员工、另一员工旧事件不被压制、共享 client 不软删、不存在关系 `APPLIED_NOOP`、故障注入全事务回滚后可重试，以及状态约束/两个 partial UNIQUE 精确存在。
3. 所有相关 `public` 业务表与三张 callback 表前后全行多重集指纹一致，每条 owned sequence 的 `last_value + is_called` 一致；成功与故障路径的合成业务 DML 只发生在随机 schema，最终 schema 已删除。
4. 执行过程没有删去失败证据：首轮只读活跃重复预检 SQL 少一个右括号，在任何 DDL 前失败；次轮生产 DDL 已成功且表/索引回读正确，但随机 schema 的故障注入约束范围过宽，导致隔离断言失败；第三轮只修正测试 harness 后 20/20 全通过。随后把 callback 三表加入隔离阶段 public 指纹：首次临时 Worker 因 Secret 新版本传播延迟在 `/migrate` 前返回 403；等待八秒后的下一轮再次完成迁移两遍和 20/20。提交前独立复核又发现迁移阶段的完整指纹仍默认只覆盖业务表，`pipeline_state_unchanged` 对 callback 只比较存在性/行数；修正为迁移前后均覆盖业务表、callback 三表及其 owned sequence，并补索引 `indisvalid/indisready` 与状态集合精确检查后，最终生产重跑再次得到 `migration_passes=2`、`pipeline_state_unchanged=true`、`public_rows_and_sequences_unchanged=true`、`isolated_checks=20/20`。所有失败轮均完成随机 schema 与临时 Worker 清理，且均没有 `public` 业务 DML。
5. 最终临时 Worker 删除后 Cloudflare API 返回 code 10007、workers.dev URL 返回 404；主 Worker 前后仍为 100% 版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`，正式 Secret 名称集合未变化，没有部署或切流。
6. 最终代码门禁为 Worker 双 TypeScript 配置通过、152/152 个测试文件与 923/923 项通过；注释感知路由审计仍保持上文 PHP 1,904、Workers 1,446、精确/可执行 746/728 等数值不变，主 Worker与审计 Worker dry-run 均通过。Windows Workers runtime 仍在 0 条断言前以既有 `workerd 0xc0000005` 退出，因此不能记为本地 runtime 通过。

### C2 provider 基础、双状态机与真实 Queue/DLQ 结果

C2 现可标记为“代码、生产 Hyperdrive 与真实 Cloudflare Queue 隔离完成”，但仍是**未启用、未发布**。边界与证据如下。

1. **PHP 权威行为复核**。旧配置确有 `user/address/build` 三类 Secret，但成员、部门、客户、群和标签读取几乎都默认走 `TYPE_USER_APP(build)`；Work token cache key 包含原始 Secret、TTL 没有提前刷新，也没有 `40001/40014/42001` 单次重取。callback 线程同步执行 provider、数据库写和欢迎语/远端标签，HTTP 404/429/5xx、网络错误及非零 `errcode` 没有稳定分类；多数异常被记录/压成空数组后仍确认回调。删除/不存在语义也彼此矛盾，因此这些失败行为不作为迁移规范。权威读端点则保留：成员/部门为 GET `user/get`、`department/get|list`，客户为 GET `externalcontact/get`，群和企业标签为有界 POST `groupchat/get`、`get_corp_tag_list`。
2. **四域 provider client**。`EnterpriseWechatProviderClient` 固定 provider origin和只读 endpoint，不接受调用方 URL；credential scope 为 `company-jssdk`、`agent`、`directory`、`external-contact`。现有两枚 Secret 只供 JS-SDK/应用身份，新增 directory/external-contact Secret 必须按最小权限注入且当前生产仍为空，不允许静默复用应用 Secret。token KV key 使用 `scope + CorpID + AgentID + Secret` 的 SHA-256 指纹，值只含 token/过期时间，TTL 最多 6,900 秒并提前 300 秒；同一 isolate 的模块级 singleflight 让不同 client 实例先共用只广播纯 token/错误元数据的 deferred，leader 在登记后仍于自己的请求栈做 KV generation 复核、必要时删除和刷新，follower 不接管 leader 的 I/O Promise。同步 barrier 的确定性回归把修复前两个 client 的 `tokenRequests/deletes/refreshGets=2/2/2` 收敛为 `1/1/1`，两调用得到同一新 token；失败广播也只请求 token 一次，follower 重建独立 metadata-only Error。它只是 same-isolate best-effort，跨 isolate/POP 仍可能重复，不能宣称 exactly-once。JS-SDK 已实际委托该 client，不是保留两套实现。
3. **HTTP 与失败契约**。所有请求均禁止重定向，并由 5 秒 AbortController 覆盖 fetch 和流式 body；POST 请求最多 64 KiB，响应按端点 16～512 KiB、绝对最多 1 MiB，`Content-Length` 和实际流同时限制，UTF-8 fatal 解码且 JSON 必须是 object。`errcode` 只接受 JSON number safe integer；缺失、`null`、字符串码和成功 envelope 缺 credential/TTL 都按 provider envelope 不可用的 `-2/retryable` 处理。仅 2xx 的 operation-specific code 可为 `not_found`：成员 `60111`，部门 `60003/60123`，客户 `40096/84061`，群 `40050/86003`，以及仅带 tag/group 过滤条件时的标签 `40068`；裸 HTTP 404、无过滤标签 `40068` 和普通未知业务码为 `terminal`。408/425/429/5xx、网络/超时、provider `-1/45009/45011` 为 `retryable`，HTTP 状态优先，因此 `429/500 + not-found body code` 仍保留 Retry-After/重试。`40001/40014/42001` 只在 2xx 时删除当前 scope cache并重取一次；已知凭据/权限问题为 `configuration`。`Retry-After` 最多记录 900 秒。异常不保存 URL/query/body、provider 文本、token、Secret 或业务标识，client 也不在内存循环业务重试。
4. **CorpID 边界**。callback、JS-SDK、Work context 和 provider 现共用 1～18 个 `[A-Za-z0-9_-]` 字符的验证器，与既有业务表一致；`work_callback_event.corp_id varchar(64)` 仍只是存储容量，C2 没有宣称运行时已放宽。
5. **双状态迁移**。外部 `0111_work_callback_projection_state.sql` 与内嵌 `migration_0117` 新增 `projection_status` 并回填旧状态。新运行时代码只写 `RECEIVED/PROCESSING/ORDERED/FAILED/DEAD` 五种管道状态；数据库处于 expand 阶段，`event.status` CHECK 暂时精确允许这五态加旧 writer 的 `APPLIED/APPLIED_NOOP/SUPERSEDED/IGNORED` 共九态，待新 Worker 100% 发布且旧 writer 全退出后另做 contract。`projection_status` 精确允许 `PENDING/PROCESSING/REFRESH_REQUIRED/APPLIED/APPLIED_NOOP/SUPERSEDED/IGNORED/FAILED/DEAD`。C1 的业务结果迁入 projection 列，非 C1 的已识别事件明确变为 `ORDERED + REFRESH_REQUIRED`，未知事件为 `ORDERED + IGNORED`。C1 迁移也增加前向 guard：发现 projection 列后不再短暂恢复旧混合约束。
6. **生产 Hyperdrive DDL**。PostgreSQL 16 经生产 Hyperdrive 连续执行 C0/C1/C2 DDL 两遍后，callback event 为 20 列；两个 CHECK 的目录证据均为 `convalidated=true`、`connoinherit=false`、`conkey` 精确目标列且完整规范表达式相等，`wce_projection_status_time` 也精确验证同 schema/table、btree、三列顺序、有效/ready/live、非唯一且无 predicate/expression。第二遍两个 constraint OID 和 index OID/relfilenode 均保持不变。三张 callback 表前后仍为 0 行，活跃 client/follow 重复组均为 0，`pipeline_state_unchanged=true`、完整业务行与 owned sequence 指纹不变。
7. **随机 schema 27/27**。同一生产 Hyperdrive 引擎先种入九种 legacy event 状态，精确验证 `RECEIVED→RECEIVED/PENDING`、`PROCESSING→PROCESSING/PROCESSING`、`ORDERED→ORDERED/REFRESH_REQUIRED`、四种旧业务终态归一到 `ORDERED + 同名 projection`，以及 `FAILED/DEAD` 双列同名；第二遍所有九行 `ctid/xmin`、两个 constraint OID 与 index OID/relfilenode 均不变，证明 DDL 是物理 no-op。场景同时保留 C0/C1 的明文验证、重复、乱序、同秒终止、伪造签名零写、Queue 失败、关系级 tombstone/no-op和故障全事务回滚。最终 event/projection 精确组合为 `ORDERED/APPLIED=3`、`ORDERED/APPLIED_NOOP=1`、`ORDERED/REFRESH_REQUIRED=3`、`ORDERED/SUPERSEDED=2`、`ORDERED/IGNORED=1`、`RECEIVED/PENDING=1`；outbox 为 `COMPLETED=10/FAILED=1`。随机 schema 删除且 public 指纹不变。
8. **真实 Queue/DLQ**。只创建专用 `cinashop-work-c2-audit-source`、`cinashop-work-c2-audit-dlq`、`cinashop-work-c2-audit-unarchived` 和临时 Worker，未向共享 `cinashop-order` 注入故障。source 设置 `max_retries=1`：严格四键 `processWorkCallbackOutbox` 在同一 source message ID、同一 canonical body SHA 下精确记录失败 attempts `1,2` 后转入 DLQ；严格两键 `dispatchWorkCallbackOutbox` 直接投 DLQ。两条消息均被现有 classifier 归档为 `ALLOW`；outbox 重复归档收敛至 `occurrence_count=2`。人工 replay 是新投递/attempts 1，body SHA 不变，并实际调用 `consumeWorkCallbackQueueMessage → EnterpriseWechatCallbackService`；只处理一次后得到 event `ORDERED`、projection `REFRESH_REQUIRED`、outbox `COMPLETED`、`attempt_count=1`、watermark 1，归档收敛 `REPLAYED/replay_count=1`；dispatch 人工收敛 `RESOLVED`。生产 227 张表中 13 张关键表的行指纹和 12 条相关序列前后完全一致。
9. **审计器自身修正记录**。早期 Queue 校验曾把 PostgreSQL `jsonb` 对象键重排误判为 public 变化，比较器已改为字段规范化排序。独立复核随后发现初版 C2 曾把生产 event CHECK 过早收窄为五态，会与仍在线的 C1 writer 冲突；立即恢复 expand 九态并重新部署审计 Worker。最终复核又拒绝了“只抽取状态字面量”的伪精确约束判断和第二遍对 `RECEIVED/PENDING` 的无效同值 UPDATE：现在完整校验 `convalidated/connoinherit/conkey/表达式`，并以 `ctid/xmin` 证明零重写。最终生产 DDL 两遍、27/27 随机 schema、只读终态和真实 Queue 全部在最新代码上重新执行，没有沿用旧证据，也没有任何未审计的 public 业务 DML。
10. **资源与线上保持不变**。两个随机 schema 均删除；两个临时 Worker及一次性 Secret 已删除，两个 workers.dev URL均返回 404；三条临时 Queue已从账户列表删除。正式 `cinashop-order` 仍为 1 producer/1 consumer，正式 `cinashop-order-dlq` 与 `cinashop-order-dlq-unarchived` 仍为 0/0。主 `cinashop-api` 未部署本批代码，正式 Secret名称仍只有 `APP_KEY/DEBUG/INTERNAL_CHAT_TOKEN/OPERATIONS_TOKEN/UPSTASH_REDIS_TOKEN/UPSTASH_REDIS_URL`，没有切流。
11. **最终代码门禁与明确限制**。Worker 双 TypeScript 配置通过，153/153 个测试文件与 939/939 项单元测试通过；注释感知路由审计仍为 PHP 1,904、TS 1,446、精确/可执行 746/728、可执行缺口 1,154。主 Worker、callback audit 与 Queue audit 的 minify dry-run 分别为 2,762.25/686.92、695.81/138.76、711.56/144.04 KiB（upload/gzip），并精确回显生产 Hyperdrive ID；没有部署主 Worker。`git diff --check` 无错误，工作区没有一次性 bearer/token 文件。Windows runtime 套件仍在加载任何测试前因 `workerd 0xc0000005` access violation 退出，输出为 `Test Files no tests / Tests no tests`，不能算 runtime 通过；需在 Linux 或受支持主机补上 workerd 双真实请求、Queue ack/retry 与流式超限证据。

### 尚未解除的凭据、Queue 与启用边界

Work DLQ 的严格 validator 已允许 `processWorkCallbackOutbox` 与 `dispatchWorkCallbackOutbox` 重放，并有单元测试和真实专用 Cloudflare Queue 证据。C2 故意让四键 outbox 在 source Queue attempts `1→2` 失败后转 DLQ，同时把两键 dispatch 直接送入 DLQ；两者均归档为 `ALLOW`，outbox 重复归档去重后人工 replay 为新 attempts 1，并由真实 callback consumer 只处理一次。临时资源已全部删除；任何后续故障验证仍必须使用专用临时 Queue，禁止注入共享 `cinashop-order`。

企业微信 credential 出现在固定 provider URL 的 query string。仓库现显式设置 `[observability.traces] enabled=false`；在注入任一 `WECHAT_WORK_*` provider Secret 或启用任何投影前，发布流程必须回读 exact Script Settings 并确认 traces 仍关闭。未来若要开启 traces，必须先通过 Script Settings API 设置并回读 `observability.redact_query_string=true`；字段缺失或为 false 都是部署阻断，不能只相信本地 Wrangler 配置或 dry-run。

C1 的随机 schema 和 mock Queue 场景不需要真实企微凭据；合成 Token/AES Key 只验证协议和本地状态机。要证明真实租户把 `del_external_contact/del_follow_user` 回调送到 Worker，仍需要正确 CorpID、`WECHAT_WORK_CALLBACK_TOKEN`、`WECHAT_WORK_CALLBACK_AES_KEY`、可访问的预发回调 URL 和真实测试租户。C2～C7 的 provider 正向/真实不存在主体语义还需要最小权限的通讯录/客户联系 Secret；当前 `WECHAT_WORK_CORP_SECRET` 不能在未确认权限范围前默认复用。429、5xx和网络中断必须用确定性 mock 验证，不应为测试故意打满真实租户配额。C8 的欢迎语/自动标签正向验收还需要相应应用权限、测试客户和明确的外部副作用批准。

生产 `public` 只允许 C1～C7 前后的只读审计和上述受控 DDL；合成业务 DML 仍严格限定随机 schema。C1～C7 验收完成不等于真实企微租户/provider 正向、源数据迁移、主 Worker 发布或 C8 完成。

### 主 Worker 启用前的三个硬阻塞

1. **源数据自然键阻塞**：源 MySQL 当前不可用，无法预检未来导入批次。导入任何 `work_client/work_client_follow` 数据前必须检查并处理活跃 `(corp_id,external_userid)` 与 `(client_id,userid)` 重复；否则生产 partial UNIQUE 会按设计显式阻断导入，不能临时删除约束或任选重复行。
2. **副作用与发布阻塞**：C7 已完成标签目录 current-state 并明确 batch completion 只审计不冒充对账；C8 欢迎语/自动标签/商城用户关联 action outbox、真实租户验证和发布闭环仍缺，主 Worker不能只启用本地投影而遗漏外部副作用终态。
3. **query-string 可观测性阻塞**：当前必须保持 traces 关闭并回读 exact Script Settings；未来只有在 Script Settings API 已设置且回读 `observability.redact_query_string=true` 后才允许开启 traces。任何缺失、false 或无法回读都阻断 provider Secret 注入和投影启用。

## WORK-C3 成员 current-state 迁移详细审计（2026-08-30）

### 审计结论与完成边界

WORK-C3 现可标记为**代码、生产 Hyperdrive 结构与隔离服务验收完成**，但不是生产能力启用或 WORK-C 整体完成。完成范围只包括成员 `create_user/update_user/delete_user` 的 current-state schema、三相处理、身份/乱序/重命名状态机、生产 DDL 幂等和同一 PostgreSQL 引擎随机 schema 的真实 Drizzle/callback service 场景。成员 authority 仍关闭，本批没有部署主 Worker，也没有向 `public` 写入成员业务行；在 C3 验收时，C4 部门以及 C5～C8 尚未完成，C4 随后完成的独立证据见下一专章。

所有生产数据库核验均通过用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。审计输出只包含结构、聚合、布尔断言、请求 ID 和全量 digest，不返回 CorpID、UserID、手机号、邮箱、姓名或其他成员身份/PII。合成成员只存在随机 schema，最终均已删除。

### PHP 行为复核与有意不兼容

旧 PHP 只作为行为证据，不作为安全规范。`C:\cinagroup\cinashop-php\app\listener\wechat\WorkListener.php:90-137` 在成员 callback 中捕获 `Throwable`、记录完整 payload 后仍确认回调；这会同时隐藏失败并扩大 PII 日志面。`WorkMemberServices.php:250-308` 的 update/rename 依赖同步 provider，旧/新 UserID 身份搬移缺少稳定 identity 与跨事件 fence；`:316-386` 的 create 同样在回调链同步读取 provider；`:394-407` 对成员、扩展资料和关系执行硬删。批量写入 `:108-203` 会以默认值覆盖部分字段、默认部门并按本轮响应替换关系，扩展资料只在字段出现时写；`:211-224` 的页数公式使用 `ceil($maxCount / $sumCount)`，也不能作为可靠全量对账游标。

新实现因此明确不复制以下旧行为：不在 callback HTTP/数据库事务内等待 provider；不把异常吞掉后伪装成功；不记录完整 provider/callback payload；不因成员 GET 的 `60111` 直接 tombstone；不以缺失字段或数据库默认值拼造完整成员；不硬删 legacy 导入表，也不把 UserID 当作可安全改写的永久主键。

### current 表、三相处理与授权失败关闭

`0112_work_member_current_projection` 新建四张 Worker-owned 表：`work_member_current` 保存稳定生成 identity 与当前成员快照，`work_member_identity_alias` 保存 UserID 世代、latest-seen 与 rename edge，`work_member_other_current` 保存扩展资料，`work_member_relation_current` 保存完整部门关系。旧 `work_member/work_member_other/work_member_relation` 保持只读 legacy/import 证据；C3 不修改其行、MVCC 或 owned sequence。current 表对 CorpID/UserID 小写规范、生命周期、状态/enable、完整资料、uint32 排序、关系唯一性、外键和部分索引均有精确 PostgreSQL 约束。

处理顺序严格分成三段：短事务 claim 并推进 alias latest-seen/lease，事务外调用 directory provider，再以短事务复核 lease、subject、watermark、alias closure 和 current fence 后原子应用。`delete_user` 由 callback 权威确认，完全不构造 provider client；非删除事件只有完整 provider 快照才能写业务，成员 `60111` 同时可能表示不存在或超出应用可见范围，因此只进入 refresh/retry 语义而不删除。可选字段按 presence 区分“省略并保留旧值”与“显式空/0/空数组并清除”；部门、排序和负责人数组必须结构完整才做全量关系替换。

authority 未验证时，非删除成员事件只写持久 fail-closed overlay 并以专用标记停放 outbox，Queue 明确 ACK；删除仍可立即 tombstone。启用后 dispatcher 才会优先重放停放事件。Work context 先查 current/alias，只有完全不存在时才允许 legacy fallback；存在任何 unresolved/pending/deleted/current 与 alias fence 不一致都会拒绝授权。当前短期 dispatch drain 有界，但完整通讯录全量对账、长期积压容量、延迟指标和人工批量重放仍是启用前缺口。

### 不可变 direct rename edge 与提交前 P1 修复

初版 rename 已有稳定 member identity、advisory lock closure、target-first 合并、删除 tombstone 和多跳 lineage，但最终独立审查在提交前发现一个 P1：resolved-forward 的边顺序曾使用 alias 可变的 `last_*`。例如 `B→C@20` 已解析后，历史 UserID `B` 的 later event `@50` 会推进 `last_*`；若随后收到 `A→B@30`，旧判断可能把 50 当成 `B→C` 的边时间并错误合并 A/C，尽管真实 direct edge 20 早于 30。该缺陷在主 Worker 发布前被发现，旧实现未切入生产业务流量。

最终模型把两种 fence 物理分义：`last_*` 只表示可前进的 latest-seen；`link_*` 表示不可变 direct rename edge。pending edge 反向保存在 target `UNRESOLVED` alias，resolved edge 正向搬到 source `RENAMED` alias；`canonical_userid` 永远指向 immediate next，不把 `A→B→C` 压平为 `A→C`。finalize 在任何 alias 写入前冻结整条 edge plan，再把 target 上的 pending fence 逐边搬到对应 source；严格要求 direct edge 单调递增、resolved hop member identity 相同、terminal current/alias 一致。历史 UserID 若出现 `last > link`，表示 rename 后又有事件或 UserID 复用歧义，运行时以 `callback_member_resolved_rename_reused` 失败关闭，不得用 later event 覆盖或替代 edge。

由于生产已应用且必须保持 `0112` 字节不变，修复通过前向 `0113_work_member_resolved_rename_fence` 完成。新 CHECK 要求 `RENAMED` 必有 link，ACTIVE/DELETED 仍不得有 link；`wmia_guard_renamed_link_0113` trigger 禁止已进入 `RENAMED` 的 alias 再修改 CorpID、UserID、canonical、生命周期或 link 三元组，只允许 latest-seen/member linkage 等不改变 direct edge 的更新。迁移若发现任何旧 `RENAMED` 行会直接报错，明确拒绝从可变 `last_*` 猜测历史 edge；本次生产预检为 0 行，因此没有回填或猜测。

### 生产 0112/0113 与只读终态证据

生产 `0112` 请求 `a2d6fe43-1dbe-4d4c-8b02-eeee49eb5abe` 将 exact migration 连续执行两遍并完成 9/9 断言；四张 current 表、64 列、16 个总索引和 31 个约束落地，四表业务行均为 0。legacy 三表 digest 前后均为 `1b9e7efced974351d58cff26850103e811d209ddeaa456034a5e7c348c3a2ae8`，没有改写既有成员证据。

最终 `0113` 生产请求为 `2efcfb4e-ac21-4d69-827c-c7ebc46534a1`，迁移连续两遍且 10/10 检查通过。完整 `public` 231 张表、209 条序列的 digest 前后均为 `50c18bb8e9fa52b50ed89df5d7755541c4c940d5d0f23faed5dd5ad3f878c306`；legacy 3 表/1 序列 digest 前后仍为 `1b9e7efced974351d58cff26850103e811d209ddeaa456034a5e7c348c3a2ae8`；四张新 current 表迁移前后均为 0 行。迁移只改变精确约束、guard function/trigger 与列注释，没有生产业务 DML。

迁移后只读请求 `4fc11cd7-5667-469a-9d55-6c9534fab9a4` 确认 `0109`～`0113` 全部 ready，`wmia_guard_renamed_link_0113` function 与 trigger 的 exact shape ready，callback 三表和成员 current 四表均无异常业务行，临时审计 schema 数量为 0。该只读终态是最终生产证据，不以早期临时 Worker轮次代替。

### 最新随机 schema 隔离验收

最新隔离请求 `47cf8ff5-2447-4105-8b0d-8ab4ba4325a0` 在同一生产 PostgreSQL/Hyperdrive 引擎、随机 schema 内执行 exact migrations 两遍，最终验证 101 个迁移对象；7 张既有/种子稳定表和 6 条稳定序列在第二遍保持物理稳定。`0112` catalog/约束负向 22/22、`0113` 旧/新状态预检 2/2、`0113` guard 负向 6/6、直接 SQL 状态机 11/11、真实 Drizzle/`EnterpriseWechatCallbackService` 场景 33/33 全部通过。

direct 场景覆盖稳定 ID、create/update/delete、显式 optional clear、关系替换、大小写/uint32拒绝、rename、链式/target-first/乱序和 contamination fail-closed；service 场景覆盖 authority 停放/重放、provider 在事务外、删除零 provider、`not_found/incomplete` 不写业务、lease/fence、跨主体 rename/update/delete、身份冲突全事务回滚、旧响应、pending branch、stale lineage，以及 resolved-forward update/delete 与 later-event 污染负向。最终随机 schema 删除，`public` 231 表/209 序列 digest 保持不变，没有真实企业微信网络请求。

仓库最终门禁为两套 TypeScript 配置通过、155/155 个测试文件与 960/960 项单元测试通过、`git diff --check` 无错误。注释感知路由审计仍为 PHP 1,904、TS 1,446、精确/可执行匹配 746/728、可执行缺口 1,154，证明 C3 完成没有改变整体仅 39.2% 静态覆盖的事实。主 Worker 与 C3 审计 Worker 的 Wrangler dry-run 分别为 5,145.26/965.40 KiB、1,721.88/291.19 KiB（upload/gzip），都精确绑定指定 Hyperdrive；dry-run 没有部署主 Worker。一次性审计 Worker 在最终只读复核后已删除，公开 URL 返回 404、Cloudflare API 返回 `10007 Worker 不存在`，三组一次性 token 已从会话内存清除且没有写入仓库文件。

执行记录保留了失败而不是把它们计为通过：早期 real PostgreSQL 暴露过 audit JSON 参数类型、generated identity 被错误带入 UPDATE，以及独立 target 身份可能被 rename 合并的问题；分别通过显式 PostgreSQL 类型、剔除 generated `id`、target 独立身份冲突回滚修复。随后最终审查又发现上述可变 last-fence P1，增加 `0113`、不可变 direct edge、数据库 guard 与污染负向场景后，重新取得本节所列最终生产/隔离请求；旧轮次不作为最终通过证据。

### 仍未解除的 C3 启用与整体迁移阻塞

- 生产没有真实企业微信成员数据、可用 CorpID/AgentID、directory Secret、callback Token/AES Key或已确认 full-visibility 的应用权限；全部 provider 场景使用确定性 mock，企业微信网络调用为 0。真实正向成员、真实 `60111`、权限范围和 Script Settings/traces 仍需专门验收。
- 没有完整通讯录周期性全量扫描/对账、持久 reconciliation 游标、积压容量测算、延迟告警或大批量人工回放演练；C3 current 增量状态机完成不能替代这些运维闭环。
- C4 部门、C5 客户/follow/tags、C6 群/群成员、C7 企业客户标签与 C8 action outbox 随后均已完成代码、生产结构与隔离验收。WORK-C父项和整体 PHP→Cloudflare迁移仍因真实数据/租户与发布闭环保持未完成。
- Windows Workers runtime 仍在执行任何断言前因 `workerd 0xc0000005` 崩溃；受支持主机门禁已由 Ubuntu Actions `33373018752` 的 Queue/Cron/DO/WebSocket 1 文件/10 项关闭，Hyperdrive 业务服务证据仍以各子批随机 schema 为准。
- 本批没有部署或切流主 Worker/Pages。真实租户回调、provider网络验收、预发、影子流量、明确发布批准与发布后观察全部仍待完成。

## WORK-C4 部门 current-state 迁移详细审计（2026-08-31）

### 审计结论与完成边界

WORK-C4 可标记为**代码、生产 Hyperdrive 结构与隔离服务验收完成**，但不能标记为生产能力启用、真实部门数据迁移完成或 WORK-C 整体完成。本批只覆盖 `create_party/update_party/delete_party` 的部门 current-state schema、三相处理、父树/负责人/乱序状态机、生产 expand-only DDL 幂等和同一 PostgreSQL 引擎随机 schema 的真实 callback service 场景。department authority 继续关闭；主 Worker 与 Pages 均未发布，本批没有向生产 `public` 写入部门业务行。

所有生产数据库核验都通过用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行。审计输出只包含目录计数、聚合、布尔断言、请求 ID 与完整表/序列 digest，不返回 CorpID、DepartmentID、UserID、姓名或负责人等业务标识。合成部门只存在随机 schema，最终均已删除。生产 legacy `work_department` 为 0 行，因此本批只能证明结构和状态机，不得把“没有历史样本”写成“真实历史部门已经迁移”。

### PHP 行为复核与有意不兼容

旧 PHP 只作为行为证据。`C:\cinagroup\cinashop-php\app\listener\wechat\WorkListener.php:90-137` 在 callback 请求中同步分发部门 create/update/delete，捕获 `Throwable` 后记录完整 payload 并仍返回；失败可能被 ACK 掩盖，日志也扩大业务标识暴露面。`WorkDepartmentServices.php:162-180` 的 create 先按 `(ToUserName, Id)` count 再 insert，安装 SQL `public/install/crmeb.sql:124-136` 却只有自增 `id` 主键、没有 `(corp_id,department_id)` 唯一键，因此存在并发重复；create 还把排序写入不存在于 legacy schema 的 `sort`，而表列实际拼为 `srot`，并漏写 provider 的 `name_en` 和 `department_leader`。`:190-198` 的 update 即使读取 provider 也只更新名称；`:206-208` 直接硬删。全量 `authDepartment()`（`:77-117`）只 list/upsert 本轮响应，使用 `srot` 并触发成员任务，但不 tombstone 响应中消失的部门，也没有完整游标、根/环/孤儿或删除收敛证明。

新实现有意不复制这些行为：不在 callback HTTP 或数据库事务内等待 provider；不使用检查后插入；不以默认空值拼造完整快照；不把 provider 读取的“不存在/不可见”直接解释为删除；不硬删 legacy 导入表；不级联猜测子部门或成员关系；不把负责人声明当作 Work 授权。旧表继续只保存未来导入证据。

### 三张 current 表、三相状态机与目录读取

`0114_work_department_current_projection` 新建三张 Worker-owned 表：16 列的 `work_department_current` 保存 `(corp_id,department_id)`、生命周期、完整快照和事件 fence；9 列的 `work_department_projection_fence` 保存 latest-seen/lease 与 exact callback fence；6 列的 `work_department_leader_current` 保存有序负责人声明。三表共有 3 个主键和 10 个表索引，另在 20 列的 `work_callback_event` 上增加六列复合唯一约束 `wce_department_ref_uq`；current/fence 均以六列 exact FK 绑定 callback 事件。迁移为 expand-only，不新增 sequence，不修改 legacy `work_department`。

处理顺序严格分为三段：短事务按 `(CorpID,DepartmentID)` claim 并推进 latest-seen，事务外调用 directory provider，再以短事务复核 lease、subject、watermark、callback/current/fence 后原子应用。create/update 只有在 provider 返回完整部门快照时才写 ACTIVE；`60003/60123` 只进入 refresh/no tuple，不能证明删除。`delete_party` 由已验签 callback 权威 tombstone 目标部门且完全不构造 provider client，同时清空目标负责人；它不会级联 tombstone 子部门、删除成员关系或修改 legacy 行。旧响应必须被 exact fence supersede，较新 create/update 才能显式复活。

父部门可以 child-first 以 `UNRESOLVED` placeholder 落地，随后由父事件补齐。数据库和服务共同拒绝自父、跨 Corp 父节点、环、超过 256 条父边及同 Corp 第二个 ACTIVE root；排序接受企业微信 uint32 范围。目录只返回 current=fence=callback 完全一致、资料完整且从 ACTIVE root 到目标整条 ancestor closure 均 ACTIVE 的节点，UNRESOLVED/DELETED 父节点下的后代失败关闭。authority-off fallback 的提交前审查还发现过“先查 current 是否存在、再查 legacy”的双语句快照竞态；最终改为 `current_state + legacy_rows + LEFT JOIN sentinel` 单条 PostgreSQL 语句，使全局和指定 Corp 两种读取都在同一快照内失败关闭。负责人只是目录数据；未来授权仍必须解析同 Corp 的 ACTIVE member/alias。

### 生产只读基线与失败记录

DDL 前只读请求 `43e37f83-fa8c-47a6-938f-cfdc110bfb2a` 确认：legacy `work_department` 与 `work_callback_event` 均为 0 行，三张 C4 表尚不存在；非法 department/Corp/identity/order、自然键重复、无根/多根、孤儿、环、负责人 JSON 空白/非法/非数组均为 0，输入校验能力可用，临时审计 schema 为 0。这只说明当前生产没有可审计样本，不是源数据迁移证据。

首个随机 schema 请求 `8abed223-bfdf-4f77-9540-8b9952ffcb1f` 在 `c4_migration_first` 以 `P0001` 失败，finally 删除随机 schema，生产 `public` 未改变。诊断请求 `47667834-f50e-414b-8a4a-f920ac25b77c` 报告 `wdc_active_tree_idx` 定义不兼容；进一步请求 `89e7a6ed-2fd7-459a-ace6-a8feebad751f` 返回实际键 `corp_id,parent_department_id,sort_order,department_id`、`indoption='0 0 3 0'` 且 predicate 相等。根因是 `pg_get_indexdef(index_oid,column_no,true)` 的逐列结果不包含 `DESC`，排序方向由 `pg_index.indoption` 编码。最终 exact guard 因而比较纯列名与 `x.indoption::text`，对 active tree 要求精确 `0 0 3 0`，同时保留 unique/primary/predicate/NULL shape 检查。失败和诊断轮不计入通过结果。

### 随机 schema 真实 PostgreSQL 验收

最终隔离请求 `4c00e71c-d0e9-4d64-9cde-bef1d61e378c` 在同一生产 PostgreSQL/Hyperdrive 引擎的随机 schema 内把 exact migration 执行两遍。migration 4/4 证明对象 OID/relfilenode 稳定、投影 tuple 的 `ctid/xmin` 在第二遍稳定、callback/current 行和序列稳定且没有 C4 sequence；最终验证 49 个迁移对象。

direct-service 20/20 覆盖 child-first placeholder、父节点补齐、uint32 排序、负责人全量替换、provider not-found refresh/no tuple、callback-authoritative tombstone/负责人清空、子部门与成员边保留、旧响应 supersede、显式复活、ACTIVE ancestor closure、两个 Corp 复用同一 department ID、第二个 root 的 service 与数据库 unique 拒绝、环和跨 Corp 父 FK。目录计数在删除前为 2、删除后为 0、复活后为 2；另一租户同 ID 为 1且原租户仍为 2。provider 全部为确定性 mock，企业微信网络调用为 0。断言结束后随机 schema 被删除，生产既有 231 表/209 序列 digest 仍为 `50c18bb8e9fa52b50ed89df5d7755541c4c940d5d0f23faed5dd5ad3f878c306`。

### 生产 0114 与终态目录证据

正式生产请求 `b07498c2-08fe-49fe-8092-4e3e5fd0e8d8` 在 `public` 应用外部/内嵌字节完全一致的 `0114_work_department_current_projection` 两遍，并完成 10/10 断言：legacy 行/MVCC与 legacy sequence 不变；所有既有 public 表行/MVCC digest 不变；所有既有 sequence 值不变；没有新 sequence；三张 C4 表没有业务行；第二遍对象 OID/relfilenode 与 tuple `ctid/xmin` 稳定；三表均为 permanent ordinary table。legacy 表/序列 digest 前后都是 `f703fe570ea3a667e7996f51f5a2b1ad92c1caa61e211d45f9eb6df3f1255f00`；既有 231 表/209 序列 digest 前后都是 `50c18bb8e9fa52b50ed89df5d7755541c4c940d5d0f23faed5dd5ad3f878c306`。三张表应用前不存在、应用后行数均为 0，`business_rows_written=false`，迁移对象数为 51。

终态只读请求 `90ecdeec-8ab8-47df-b54f-5e4824df5c77` 确认 C4 complete=true，callback/current/fence/leader 行数均为 0；列数分别为 20/16/9/6，相关约束 31，callback+C4 索引 16，invalid index 0；unresolved/active/deleted/parked/inactive-parent/leader 聚合均为 0，临时 schema 为 0。为取得全 `public` 精确目录总数，临时审计 Worker 仅以一次性 read secret 重建一次并立即删除；最终只读结果为 234 表、3,235 列、776 索引、221 主键、209 序列，临时 schema 为 0。删除后 workers.dev POST 探针返回 404；主 Worker 从未部署。

### 工程门禁、资源清理与审查余项

仓库结构审计已修正对动态 `%I.static_table` 和独立 `src/migrations/*.ts` 内嵌迁移模块的识别，最终报告 source 201、target 234、shared 201、target-only 33、外部/Worker 234/234、列/主键漂移 0。外部与内嵌 `0114` 精确相等，SHA-256 为 `a7b999451e055f287ab94b7ae85261b8a962379a0b80d0af35b98eaa64daba96`。最终门禁为两套 TypeScript 配置通过、C4 定向 5 文件 64/64、全量 158 文件 975/975、注释感知路由审计 PHP/TS 1,904/1,446 与精确/可执行 746/728；主 Worker和临时审计 Worker minify dry-run分别为 2,945.16/719.26 与 830.33/158.18 KiB（upload/gzip），均精确指向指定 Hyperdrive且没有部署。`git diff --check` 无错误。Windows runtime 仍在任何断言前因 `workerd 0xc0000005` 退出，不能记为 runtime 通过。

独立最终代码与迁移设计审查没有剩余 P0/P1。保留两个非阻断 P2：目录/callback 单测仍有源码和 mock 断言，真实随机 PostgreSQL 已覆盖主要状态但未来可继续扩充递归 SQL 负向；`0114` 每次执行都会对空的 `work_callback_event` 取得 `ACCESS EXCLUSIVE`，本次不阻断，但未来若频繁运行全量 migration，应改成仅在缺少约束时加锁并二次检查。临时审计 Worker、一次性 Secret 和会话内 token 均已删除/清空，仓库未写入 bearer、数据库 URL 或 secret 值。

### 仍未解除的 C4 启用与整体迁移阻塞

- 生产 legacy/current 部门均为 0 行；没有源 MySQL、真实历史树或正式导入批次，不能宣称真实部门数据已迁移。未来导入前还需以同一约束预检 Corp/identity/重复/root/orphan/cycle/leader JSON。
- department authority 继续关闭。生产没有可用 CorpID/AgentID、directory Secret、callback Token/AES Key或已确认 full-visibility 的应用权限；真实 provider 正向、`60003/60123` 的租户语义、真实 callback 和 Script Settings/traces 均待验收。
- `work_member_relation_current` 目前没有指向 department current 的 FK，这是明确延期；完整通讯录周期性扫描、reconciliation 游标、积压容量、延迟指标、告警和人工批量回放也未完成。
- C5 客户、全部 follow 与 tags 权威快照、C6 群/群成员及 C7 企业客户标签随后已完成代码、生产结构与隔离验收；C8 远端副作用/发布仍未完成。WORK-C 父项与整体 PHP→Cloudflare 迁移保持未完成。
- Windows runtime、真实租户/旧端 E2E、预发、影子流量、明确发布批准和发布后观察全部仍待完成；本批没有部署或切流主 Worker/Pages。

## WORK-C5 客户、跟进人与跟进标签 current-state 详细审计（2026-08-31）

### 审计结论与严格完成边界

WORK-C5 现可标记为**代码、生产 Hyperdrive 结构与随机 schema 真实服务验收完成**，但不能标记为生产能力启用、真实客户数据迁移完成或 WORK-C 整体完成。本批覆盖 `change_external_contact` 的 `add_external_contact`、`edit_external_contact`、`del_external_contact`、`del_follow_user`：前两者通过 provider 权威完整响应收敛客户 profile、全部跟进关系与每关系标签；后两者只把目标员工关系写为 callback-authoritative tombstone。client authority 与 external-contact full-visibility gate 继续关闭，主 Worker/Pages 未发布，生产五张新表没有业务行。

所有生产数据库操作都只通过用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行。生产 `public` 仅接受 expand-only `0115` 和幂等复验，没有插入合成客户、员工、标签或 callback。合成 DML 只发生在随机 `codex_work_client_current_*` schema，finally 删除后再比较完整 `public` 目录；审计响应只返回计数、布尔断言、摘要和请求 ID，不返回 CorpID、ExternalUserID、UserID、姓名、备注、手机号或标签文本。

### PHP 权威行为与迁移中拒绝复制的缺陷

旧入口 `C:\cinagroup\cinashop-php\app\listener\wechat\WorkListener.php:145-176` 在 callback 处理栈内同步调用 `WorkClientServices`，外层捕获全部 `Throwable`、记录完整 payload 后仍继续 ACK。`WorkClientServices.php:254-330` 的 add/edit 同步拉 provider，随后又同步触发欢迎语、自动标签和商城用户关联；三个远端/跨域副作用分别吞异常，因此“本地快照成功、欢迎语失败、标签部分成功、用户关联未知”等组合没有持久终态、幂等键或可靠重放。

`saveOrUpdateClient()`（`:381-467`）还有多个不能原样迁移的问题：provider 未返回 callback 对应员工时会人工补一条只有 `userid/createtime/tags=[]` 的 follow，制造并不存在的关系；没有 latest-seen、事务 lease 或关系级乱序 fence；异常只写日志并返回可能不存在的 `$clientId`。`deleteClient()`（`:335-354`）会销毁共享客户记录，再 tombstone 一个员工关系，错误地把单关系删除推导成全客户删除；`deleteFollowClient()` 虽只更新目标关系，但同样没有乱序保护。

全量同步 `authGetExternalcontact()`（`:66-239`）把成员分页和 provider cursor 同时推进：存在 `next_cursor` 时仍递增成员页，容易把上一批成员的 cursor 与下一批成员混用。批量更新客户时条件只有 `external_userid`、漏掉 CorpID；同一 ExternalUserID 跨租户可被串改。follow 数据先按 external userid 暂存，再逐条覆写；没有 callback/direct provenance，也不 tombstone provider 响应中消失的关系。标签写入路径不一致：callback add/edit 会先删后写，批量同步只有 `tags` 非空才删除旧标签，权威空集可能留下陈旧标签。旧安装结构也没有足够自然键和 fence 约束阻止这些并发结果。

新实现有意不在 callback HTTP 或 PostgreSQL 事务内调用 provider，不伪造缺失 follow，不用一条员工删除销毁共享客户，不把 provider `not_found` 当删除，不因一次快照遗漏就删除其他员工关系，也不在 C5 内执行欢迎语、远端标签写或商城用户关联；这些副作用继续留给 C8 的独立 action outbox。

### 五表模型、封闭结构与 provider 解析合同

`0115_work_client_current_projection.sql` 新建五张 Worker-owned 表：

- `work_client_current` 保存 tenant-scoped ExternalUserID、profile 完整性、生命周期、商城 UID 可空关联和最后已应用 profile 事件；
- `work_client_projection_fence` 只保存 add/edit 的 client-wide latest-seen profile fence；
- `work_client_follow_current` 以 `(corp_id,client_id,userid)` 保存 ACTIVE/DELETED 关系、`DIRECT/SNAPSHOT` provenance、完整 follow 字段和事件 tuple；
- `work_client_follow_projection_fence` 保存四类 direct callback 的每关系 latest-seen，确保员工 B 的新事件不会压掉员工 A 尚未应用的旧事件；
- `work_client_follow_tag_current` 以稳定 `type/tag_id/group/name` 摘要和 `sort_order` 保存每关系权威标签集合，个人标签 `type=2` 允许没有 `tag_id`。

五表共 77 列、39 个约束、13 个总索引和一条 `GENERATED ALWAYS AS IDENTITY` sequence。client/follow/fence 通过 exact callback 六元组 FK 绑定 `work_callback_event`；所有 FK 都是 `ON DELETE RESTRICT`。迁移的最终 guard 不只检查对象存在：还要求精确列、主键、FK metadata、CHECK metadata、约束/索引名字闭集、B-tree key 顺序与 `indoption`、partial predicate、unique/primary/null shape、有效状态、identity ownership，并拒绝额外 constraint/index、RLS、policy、rule 或用户 trigger。外部 SQL 与 Worker 内嵌副本逐字相等，SHA-256 为 `2b4c4790aa35f1264f0923e297692740e52e35e89f0cda9f15b97abf976b2853`。

provider parser 明确限定最多 32 页、每页 500 个 follow、总计 5,000 个 follow、20,000 个 tag、每 follow 256 个 tag、20 个 remark mobile、16 层 JSON、64 KiB external profile 和 4 MiB 聚合 canonical 数据。每页必须返回相同 profile，重复 follow、重复 tag、cursor 循环、跨页 profile 漂移、畸形 UTF-8/类型/长度均失败；缺失或 `null` 的 tags 按 provider 权威空集处理，非数组则拒绝。callback 对应关系必须真实存在于完整 provider 结果，绝不人工补造。`40096/84061` 只产生 `REFRESH_REQUIRED`；429/5xx/网络/超时保留可重试分类；两个删除事件零 provider 调用。

### 三相并发状态机、tombstone 与迟到响应

phase 1 在短事务中取得 tenant+client advisory lock，创建稳定 UNRESOLVED client identity，并分别推进关系 direct fence 与 add/edit profile fence；authority 未开启时 add/edit 以 `client_projection_disabled` 持久停放，删除仍可立即写目标 tombstone。phase 2 在所有数据库事务外穷尽 provider cursor。phase 3 重新取得同一 client lock、关系 subject lock并复核 callback lease、watermark、direct/profile exact fence，随后在一个短事务内 upsert profile/follow、批量 replace tags 和完成 callback/outbox。

profile 与关系 fence 分离解决多员工语义：员工 B 的新 profile 事件不会让员工 A 尚未处理的 direct 事件永久丢失；没有 direct callback 的关系可由完整 provider 快照以 `SNAPSHOT` provenance 引入；已有 direct fence 的非目标关系只在其 ACTIVE row 与 direct tuple 完全一致且严格更旧时刷新字段，并保留 direct provenance。另一员工快照不得复活 callback-authoritative tombstone；快照遗漏也不删除任何非目标关系。只有目标员工较新的 add/edit 可恢复其 tombstone。客户只有在 profile 已完整且所有已知 follow 都非 ACTIVE 时才转为 INACTIVE；单条关系删除从不等价于全客户删除。

最终代码复核新增了两道竞态防线。第一，phase 1 把“provider 拉取开始前观察到的 profile fence event id”带到 phase 3；如果 provider 响应期间有更新 profile fence 越过，旧响应以可重试 `callback_client_snapshot_drift` 回滚，下一次在新 fence 后重新拉取。这样既允许不同员工的较旧 direct 事件在重拉后应用，又不会让已经在途的旧 provider 响应覆盖更新快照。第二，phase 3 已判定旧删除 `SUPERSEDED` 时不再执行 C1 legacy compatibility tombstone，避免 current fence 拒绝了旧事件、legacy 行却仍被误删。

### current-first 授权与目录读取

Work context 对客户身份采用 current-first、identity-scoped fail-closed：先取得与 callback writer 相同的 client advisory lock，存在任何 current footprint 就绝不回退同 ExternalUserID 的 legacy 行。current client 必须 ACTIVE、profile/provider 完整、current=profile fence=callback 六元组完全一致且 callback 为 add/edit 的 `ORDERED + APPLIED/APPLIED_NOOP`；当前员工 follow 必须 ACTIVE、字段/tags 完整、callback 已应用，并满足 `DIRECT` 时等于 direct fence、`SNAPSHOT` 时没有 direct fence。标签在同一客户事务快照内按 0～255 全量读取，不再在授权完成后换连接补查。

成员 current 身份锁现在持续到整个客户授权快照完成，关闭“成员刚被 tombstone、旧检查刚通过、仍签出 token”的 TOCTOU。签发的 5 分钟 JWT 固化 `client_projection_source=current|legacy`；旧 token 缺该字段、target id/uid 改变、legacy/current 来源翻转、authority 关闭或任一 fence 漂移都要求重新授权。员工 UserID 统一小写，与 C3 member alias 规则一致。

Admin summary/client list 在 client authority 开启时只读 exact current/fence/callback 闭包；关闭时 current sentinel 与 legacy page 位于同一 PostgreSQL statement snapshot，出现 current footprint 就返回空且说明 `client_current_authority_disabled`，不会在两个 READ COMMITTED 语句之间泄漏 stale legacy。最终复核还修复了越界页 count：eligible total 与 page 分离但仍在同一语句，`page` 超过末页时返回空 list 和真实总数，不再错误返回 0。

### 生产 Hyperdrive 迁移、隔离验收与失败记录

DDL 前只读请求 `ba0c8e72-d5f9-4541-9410-8d14ba0cd180` 确认生产为 234 表/209 序列，legacy `work_client/work_client_follow/work_client_follow_tags` 全为 0 行，五张 C5 表不存在，临时 schema 为 0，目录 digest 为 `de881e71fe0980a500b8563eb83cf6a63faf5f877091cf919c9321731fac4ee1`。空表只能证明当前无可审计样本，不是客户数据已迁移。

首次正式迁移请求 `cceea909-1d2c-4056-9118-707de99e2bcf` 将 exact `0115` 连续执行两遍：`234→239` 表、`209→210` 序列，目标对象和五表空 tuple 第二遍稳定，legacy 三表行/MVCC不变，表/序列增量精确为 `+5/+1`，39 个约束通过，target metadata digest 为 `e74ce06d0f983f1e9c4646534a4af18e70acf7352e62bea6dc4f7fe4875c43d8`。加入封闭表面和 exact index predicate/sort guard 后，请求 `b53c5f91-e85d-46dd-83c7-13aa4e9bad45` 在已存在对象上再执行两遍，仍为 239/210、五表 0 行、legacy MVCC不变、metadata digest 相同，证明增强校验与生产实物一致而非只在字符串测试中通过。

终态只读请求 `f7b5618b-51e0-4ad6-8c95-d33fe9935787` 确认 239 表/210 序列、57 个目标 relation/constraint/index 对象，legacy/current 八张相关表全为 0 行、临时 schema 为 0，完整目录 digest 为 `373aa9bd034ba49a601fe3c96be50d4104b46e5434011324329c1b62b3e29dea`。由 C4 的 3,235 列/776 索引/221 主键加 C5 精确增量可得当前为 3,312 列/789 索引/226 主键。

最终随机 schema 请求 `c44dc50e-a6b5-497d-b3ab-2359f5f2b994` 在同一生产 PostgreSQL 引擎内通过 migration 4/4、direct service 12/12、current context 6/6，共 22/22。direct 场景覆盖初始全快照、关系删除、跨关系乱序、旧目标 supersede、只有目标可复活、快照遗漏不删除、每关系 direct fence、最新 profile、非目标 direct provenance、跨 profile fence 的在途旧响应拒绝并重拉、标签 replace 不累积；context 覆盖 current token、current client/remark/tags、员工大小写归一和 authority-off current footprint 拒绝。临时 schema 删除，`public` catalog digest 保持 `373aa9…`。

失败轮次全部保留而不计入通过。早期隔离运行先后暴露：审计连接的 `search_path` 组合不合法；`requireClientScopeById` 的 seed 查询在显式事务/目标 schema 外；tags 在授权事务之后另开连接读取，存在混合快照。三者分别通过单 schema search path、seed+lock+reload 同一事务、tags 同一锁/事务修正。最终代码复核又发现上述 provider-response fence 和 superseded legacy delete 两个并发缺口，增加真实 PostgreSQL负向后才取得最终 22/22。一次重跑因新增并发场景改变最终资料种子，旧 context 固定值断言失败；finally 已先删除随机 schema，随后修正测试期望并完整重跑成功，没有把该失败轮算作通过。

### 工程门禁、资源清理与剩余阻塞

最终 `data:schema-audit` 为 source 201、target 239、shared 201、target-only 38、源列缺口 0、外部/Worker 239/239、表/列/主键漂移 0。两套 TypeScript 配置通过；C5 相关 4 文件 33/33、全量单元测试 159 文件/984 项通过。主 Worker minify dry-run 为 3,036.19 KiB/gzip 733.43 KiB，精确绑定指定 Hyperdrive且只 dry-run；最终 C5 审计 Worker实际隔离包为 1,017.38/200.77 KiB。临时 Worker、一次性 Secret 与随机 schema 均已删除，workers.dev 探针返回 404，主 Worker从未部署本批代码。Windows runtime 仍在 0 个测试/0 条断言前因 `workerd 0xc0000005` 启动失败，只能记环境失败；后续 Ubuntu Actions `33373018752` 已关闭受支持主机门禁。

剩余门禁如下：

- 生产 legacy/current 客户、follow、tags 均为 0 行；没有只读源 MySQL、正式导入批次或运营抽样，不能宣称真实历史客户已经迁移。导入前仍需预检 Corp/ExternalUserID/UserID、自然键重复、孤儿、字段长度、remark mobiles JSON、tag 类型/位置和 legacy/current 映射。
- 生产没有可用 CorpID/AgentID、external-contact Secret、callback Token/AES Key或已确认 full-visibility 的应用权限；所有 provider 场景均为确定性 mock，企业微信网络调用为 0。client authority 保持关闭，启用前必须回读 Script Settings 证明 traces 关闭或 query-string redaction 已明确开启。
- C5 没有建立商城 UID 自动关联，也没有完整客户 reconciliation 游标、全量扫描、积压容量、延迟/漂移告警和人工批量重放；这些不能由 callback 增量状态机替代。
- C6 客户群/群成员、C7 企业客户标签和 C8 欢迎语/自动标签/用户关联 action outbox 随后已完成代码、生产结构与隔离验收；真实租户发布仍未完成，WORK-C 父项保持未勾选。
- 真实 callback/provider 正向与 operation-specific not-found、旧端 E2E、预发、影子流量、明确发布批准和发布后观察全部待完成；Linux runtime 已独立关闭。本批没有部署或切流主 Worker/Pages。

## WORK-C6 客户群与群成员 current-state 详细审计（2026-08-31）

### 审计结论与严格完成边界

WORK-C6 现可标记为**代码、生产 Hyperdrive 结构与随机 schema 真实服务验收完成**，但不能标记为生产能力启用、真实群数据迁移完成或 WORK-C 整体完成。本批覆盖 `change_external_chat/create|update|dismiss`：create/update 在 PostgreSQL 事务外读取 provider 的完整群与成员快照，dismiss 完全由 callback 授权且零 provider 调用。group authority 和 external-contact full-visibility gate 保持关闭，主 Worker/Pages 未发布，生产三张新表没有业务行。

所有生产数据库操作只通过用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行。生产 `public` 仅接受 expand-only `0116` 和幂等复验；没有插入合成 CorpID、ChatID、UserID、成员资料或 callback。合成 DML 严格位于随机 `codex_work_group_chat_current_*` schema，finally 删除后比较完整 public catalog。审计 API 只返回计数、摘要、布尔断言和请求 ID；一次性 token 只驻留 PowerShell 进程内存，临时 Worker/Secret 已删除并由 workers.dev 404 探针确认。

### PHP 权威行为、迁移缺口与拒绝复制的缺陷

旧入口 `C:\cinagroup\cinashop-php\app\listener\wechat\WorkListener.php:195-207` 在 create/update callback 内同步读取 provider 群详情；dismiss 直接进入本地删除路径。`WorkGroupChatServices.php` 的 update 根据 `UpdateDetail` 盲增/盲减 `member_num`，没有用 provider 完整成员集合替换，重复、乱序或丢失 callback 都会永久漂移；群资料不同路径也不能保证完整保存 `admin_list/status`。`dismissGroupChat()` 会硬删群成员和群记录，销毁历史证据。`WorkGroupChatMemberServices.php` 虽能按一次成员列表更新/标记离群，但没有 tenant-scoped current identity、latest-seen fence、provider-response crossing fence 或解散终止态。

新实现不复制这些缺陷：不使用 `UpdateDetail` 推算人数，不把 provider `not_found` 推导为解散，不在 callback HTTP 或数据库事务内等待 provider，不硬删成员，不允许普通 create/update 覆盖 dismiss，也不在 C6 执行欢迎语、自动标签、商城用户关联等远端副作用。

### 三表模型、封闭 DDL 与完整快照合同

`0116_work_group_chat_current_projection.sql` 新建三张 Worker-owned 表：

- `work_group_chat_current` 以 `(corp_id,chat_id)` 唯一标识群，保存 `UNRESOLVED/ACTIVE/DISMISSED` 生命周期、完整性、群主/公告/admin JSON/provider status、当前人数、累计有证据的离群次数和最后事件六元组；
- `work_group_chat_projection_fence` 保存 group-wide latest-seen，完整 provider 响应在返回时必须再次与它相等；
- `work_group_chat_member_current` 保存 `ACTIVE/LEFT/DISMISSED`、成员类型、join/invitor/nickname/name/state、left time 和最后事件六元组，稳定自然键为 `(corp_id,group_id,userid)`。

三表共 53 列、26 个约束、11 个总索引、3 个主键和 2 条 `GENERATED ALWAYS AS IDENTITY` sequence。group/fence/member 全部通过 exact callback 六元组 FK 绑定 `work_callback_event`，父子 FK 均 `ON DELETE RESTRICT`。最终 guard 校验精确列/默认值/identity mode、主键与 FK key 顺序和动作、CHECK metadata、约束/索引名字闭集、B-tree key/降序/partial predicate、valid/ready/live 状态，并拒绝额外 constraint/index、RLS、policy、rule 或用户 trigger。外部 SQL 与 Worker 内嵌副本逐字相等，外部文件 SHA-256 为 `30a88f1daaee16023d0ceb4c517f9796707898e0f47981539b213090fbef5eb4`。

provider parser 要求 `errcode=0` 且 `group_chat` 同时显式包含 chat/name/owner/create_time/notice/admin_list/member_list/status；最多 2,000 成员、64 管理员，字符串、控制字符、整数范围和聚合 JSON 大小均受限。员工 UserID 统一小写，外部联系人 ID 保留 provider 大小写；群主和管理员必须真实存在于 employee member 集合，重复成员/管理员、跨 ChatID、结构缺失或畸形类型均拒绝。缺字段和 provider not-found 只返回 `REFRESH_REQUIRED`，429/5xx/网络/配置/终止错误保留原分类；dismiss 不构造 provider client。

### 三相状态机、tombstone 与终止态

phase 1 在短事务中取得 `work-group-chat:${corpId}:${chatId}` advisory lock，创建稳定 UNRESOLVED identity并推进 latest-seen fence；phase 2 在事务外读取 provider；phase 3 重取同一锁并要求返回前观察的 fence 仍完全相等，再在一个事务中替换群资料和成员集合。完整快照里消失的 ACTIVE 成员写为 `LEFT` 并增加 `departed_member_count`；重复快照不会重复计数，成员重入恢复 ACTIVE 但不会抹除历史离群计数。

dismiss 的 sequence rank 是终止级别，专用比较器先比较“是否终止”再比较时间，因此即使异常 create/update 带更晚 wall-clock，也不能压过 dismiss。dismiss 把仍活跃成员写为 `DISMISSED`、保留群资料与全部历史行；后续任何 create/update 在 phase 1 即 `SUPERSEDED`。generic callback watermark 已有不可能更晚普通事件时，dismiss 仍进入专用 group fence并把 generic watermark收敛到终止事件。provider not-found/incomplete 只推进 seen fence并保持 current 快照不变，使 current-first 读取因 fence 不一致而失败关闭，直到后续完整快照或 dismiss 收敛。

### current-first 上下文与 Admin catalog

Work context 的群授权采用 current-first、identity-scoped fail-closed。存在任何 current footprint 就不回退相同 `(CorpID,ChatID)` 的 legacy 行；current 群必须 ACTIVE、profile/members 完整，且 current=fence=callback 六元组完全一致，callback 必须是 `event/change_external_chat/create|update` 的 `ORDERED + APPLIED/APPLIED_NOOP`。群主或仍 ACTIVE 的 employee member 才能读取。JWT 固化 `group_projection_source=current|legacy`；来源翻转、authority 关闭、成员离群、群解散或 fence 漂移都会要求重新授权。

详细审计发现授权事务结束后详情/成员查询曾再次使用裸 Hyperdrive 连接：生产默认 public 时不显眼，但随机 schema 明确读到了 public 空表，也留下 callback 在授权后、读取前解散群的 TOCTOU。最终实现把 token 复核、member identity lock、group lock、source/fence/callback 复核以及群详情/成员/员工 current/客户 current 补充读取收拢到同一 `withTx`；`SET LOCAL search_path`、授权和读取快照同生共死。员工资料在 current 群不再读取 legacy `work_member`，而是仅在 member current authority 开启时读取完整 ACTIVE `work_member_current`；外部联系人资料沿用 C5 current-first sentinel。

Admin summary/group/member 列表在 group authority 开启时只读 exact current/fence/callback 闭包，并校验 `msg_type/event_type/change_type`；关闭时 current sentinel 与 legacy count/page 位于同一 PostgreSQL statement snapshot，出现 current footprint 即返回空并说明 `group_chat_current_authority_disabled`。成员目录还拒绝跨租户重复 current identity id 的歧义，不把多租户行合并到同一页。

### 生产 Hyperdrive 迁移与最终证据

DDL 前只读请求 `58d9c8f8-8365-4ff9-87b2-4cd3b8edeac1` 确认生产为 239 表/210 序列，legacy `work_group_chat/work_group_chat_member` 均 0 行，C6 三表不存在，临时 schema 为 0，catalog digest 为 `373aa9bd034ba49a601fe3c96be50d4104b46e5434011324329c1b62b3e29dea`。空表只证明当前没有可抽样的群历史，不能声明数据迁移完成。

先行随机 schema 请求 `52a55d69-36eb-41d2-a56f-df5747f21305` 证明 exact 0116 双跑、26 约束/11 索引/40 对象和初版状态机 12/12；随后生产迁移请求 `0801ed9e-8de7-48c3-b760-cd01cbf6a03f` 将 0116 连续执行两遍：`239→242` 表、`210→212` 序列，表/序列增量严格 `+3/+2`，第二遍对象 OID/relfilenode/定义与空 tuple 不变，legacy 两表行/MVCC 指纹不变，target metadata digest 为 `500f78ae3654668907e4b107b6ad8e63d8ef62b51ab653d6cbe41179a848d8a5`。

迁移后的首轮只读请求 `89b98cad-3f0b-4f1c-903c-4d20d688b943` 和代码收尾后的最终只读请求 `47a6ea28-ab38-48a7-a726-b59b702c6804` 均确认 242 表/212 序列、40 个 C6 对象、legacy/current 五张相关表全 0 行、临时 schema 0；最终完整 catalog digest 为 `3644b23ffd1d71c241bfe72e048c82c01ac526a4e7c6048e56ded63e7f508117`。由 C5 的 3,312 列/789 索引/226 主键加 C6 精确增量可得当前 3,365 列/800 索引/229 主键。

最终随机 schema 请求 `d5102e38-ac68-4e72-8282-8980276426d8` 在同一生产 PostgreSQL 引擎通过 migration 6/6、projection 13/13、current context 5/5，共 18/18。覆盖初始全快照、omission tombstone、离群只计一次、重复 no-op、重入不抹历史、旧事件、provider response crossing newer fence、not-found refresh-only、同秒 dismiss、异常更晚 update、解散保留成员历史、单群单 fence、解散后旧 token、current 详情/员工资料、authority-off 和非群成员失败关闭。随机 schema 删除且 public catalog digest 保持 `3644b23f…`。

失败轮次未计入通过：PKCE 测试 verifier 使用非十六进制夹具导致 challenge 被拒；上下文最初安排在 not-found fence 之后而按设计失败关闭；最后 Hyperdrive 随机 schema 暴露详情/成员裸连接读取 public 的事务边界缺口。三者分别通过合法 verifier、先正常读取再推进 refresh-only fence、群授权与读取同事务修正后完整重跑。一次 Cloudflare 边缘 `1042` 没有进入应用响应，重试后取得确定性应用断言；所有失败轮均先由 finally 删除随机 schema/Worker，不冒充成功证据。

### 工程门禁、资源清理与剩余阻塞

最终 schema audit 为 source 201、target 242、shared 201、target-only 41、源列缺口 0、外部/Worker 242/242、表/列/主键漂移 0。两套 TypeScript 配置通过；C6 定向 3 文件 57/57，全量单元测试 160 文件/991 项通过。最终审计 Worker dry-run 为 1,630.44 KiB/gzip 273.38 KiB；临时 Worker、一次性 Secret 与随机 schema 均已删除，workers.dev 探针返回 404。主 Worker从未部署本批代码。Windows runtime 仍在 0 个测试/0 条断言前因 `workerd 0xc0000005` 启动失败；后续 Ubuntu Actions `33373018752` 已关闭受支持主机门禁。

剩余门禁如下：

- 生产 legacy/current 群和群成员全部为 0 行；没有源 MySQL、正式导入批次或运营抽样，不能宣称真实历史群已迁移。导入前仍需预检 CorpID/ChatID/UserID、自然键重复、孤儿、成员类型、群主/admin 成员关系、字段长度和 legacy/current 映射。
- 生产没有可用 CorpID/AgentID、external-contact Secret、callback Token/AES Key或已确认 full-visibility 的应用权限；provider 场景是确定性 mock/direct service，企业微信网络调用为 0。group authority 保持关闭，启用前必须回读 Script Settings 证明 traces 关闭或 query-string redaction 已明确开启。
- 仍缺完整群 reconciliation 游标、全量扫描、积压容量、延迟/漂移告警、人工批量重放以及 operation-specific provider not-found 的真实租户语义。
- C7 企业客户标签 current-state 与 C8 欢迎语/自动标签/商城用户关联 action outbox 已完成代码、生产结构与隔离验收；真实发布闭环尚未完成，WORK-C 父项保持未勾选。
- 真实 callback/provider 正向、旧端 E2E、预发、影子流量、明确发布批准和发布后观察全部待完成；Linux runtime 已独立关闭。本批没有部署或切流主 Worker/Pages。

## WORK-C7 企业客户标签 current-state 与批量结果边界详细审计（2026-08-31）

### 审计结论与严格完成边界

WORK-C7 可标记为**代码、生产 Hyperdrive 结构与随机 schema 真实服务验收完成**，但不能标记为 authority 已启用、真实企业标签数据已迁移、批量同步已对账或 WORK-C 整体完成。本批覆盖 `change_external_tag/create|update|delete|shuffle`：create/update/shuffle 在 PostgreSQL 事务外读取企业微信标准企业标签或 strategy 标签权威目录；delete 完全由已验签 callback 授权且零 provider 调用。`batch_job_result/sync_user|replace_user|invite_user|replace_party` 继续明确 `IGNORED`，只保留有界 `JobType/JobId/ErrCode` 审计元数据，不保存 provider `ErrMsg`，也不把“批任务完成通知”解释为本地目录已经收敛。

所有生产数据库操作只通过用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行。生产 `public` 只接受 expand-only `0117_work_external_tag_current_projection.sql` 和第二遍幂等复验；没有插入合成 CorpID、StrategyID、GroupID、TagID、名称或 callback 行。合成 DML 严格位于随机 `codex_wtag_audit_*` schema，最终删除后比较完整 public catalog。`WECHAT_WORK_TAG_CURRENT_AUTHORITY` 和 external-contact full-visibility gate 均保持关闭，主 Worker/Pages 未发布。

### PHP 行为、协议复核与迁移决策

旧 `WorkListener.php:225-242` 的 create/update 会进入 `UserLabelServices::authWorkLabel()` 回源，delete 直接删除本地 `user_label/work_label` 证据，shuffle 分支为空。旧写路径未把所有更新绑定 CorpID，update 只回写 `tag_id` 而没有可靠更新名称/排序；旧表以整数 serial `work_label.id/group_id` 作为本地身份，不能承载 provider 的字符串 tag/group ID。组删除还会连带删子标签，但 provider 不保证为每个子标签另发 callback；硬删会使历史和重放证据永久丢失。

新实现不复制这些缺陷。remote ID 全程保持 1～128 字节字符串并与 legacy serial 隔离；标准企业标签使用 `get_corp_tag_list`，`StrategyId>0` 使用 `get_strategy_tag_list`。create/update callback 只提供稀疏身份，因此必须读取权威快照；带 tag ID 只收一个 tag，带 group ID（包括有 `Id` 的 shuffle）只收一个组，无 `Id` 的 shuffle 收完整 strategy/catalog。响应最多 1,000 组、3,000 标签，严格拒绝重复 ID、缺字段、控制字符、越界整数、跨 scope 响应和错误 JSON。operation-specific provider `not_found` 与不完整响应只返回 `REFRESH_REQUIRED`，不推导删除；只有已验签 delete callback 可以生成终止 tombstone。

### 三表模型、封闭 DDL 与 current-first 目录

`0117` 新建三张无 sequence 的 Worker-owned 表：16 列 `work_external_tag_group_current`、17 列 `work_external_tag_current` 和 11 列 `work_external_tag_projection_fence`。自然键分别为 `(corp_id,strategy_id,group_id)`、`(corp_id,strategy_id,tag_id)` 与 `(corp_id,strategy_id,subject_type,remote_id)`；组/标签保存 `ACTIVE/DELETED`、完整性、provider 名称/排序/创建时间、delete time 和 callback 六元组。标签到组、三表到 `work_callback_event` 均为精确 FK 且 `ON DELETE RESTRICT`。

三表合计 44 列、25 个约束、8 个总索引（含 3 个主键索引）、0 条 sequence、36 个 relation/constraint/index 闭合对象。迁移验证精确列类型/长度/default/nullability/collation、主键/FK key 顺序与动作、CHECK 集、索引定义/唯一性/access method/valid-ready-live 状态，并拒绝额外 constraint/index、RLS、policy、rule 或用户 trigger。外部 SQL 与 Worker 内嵌副本逐字一致，由 `MigrationService.migration_0123` 纳入全量迁移。

Admin 标签目录采用 current-first、整库 sentinel fail-closed。只有 tag authority 与 external-contact full-visibility 同时为 `verified` 时，才返回 tag/group 都是 ACTIVE、snapshot complete、各自 exact callback 六元组闭合，且 callback 为 `ORDERED + APPLIED/APPLIED_NOOP + event/change_external_tag/create|update|delete|shuffle` 的行；输出保留字符串 tag/group ID 和 `strategy_id`。任一 gate 关闭时，current 三表任一有 footprint 就在同一 PostgreSQL statement snapshot 返回空和 `external_tag_current_authority_disabled`，绝不回退 legacy `work_label`；只有三表及 fence 完全为空时才允许旧目录读取。

### 三相状态机、shuffle 与终止态

所有事件按 `(CorpID,StrategyID)` 取得 catalog-wide advisory lock。phase 1 在短事务内写 direct fence；phase 2 在事务外调用 provider；phase 3 重取同一锁并要求 direct fence 完全一致，再原子应用快照。provider 响应穿越较新 direct callback 时必须 `SUPERSEDED`。相同业务快照可推进 event provenance 但返回 `APPLIED_NOOP`；较旧事件不得覆盖当前值。

组快照中遗漏的既有 ACTIVE 子标签写为 DELETED；完整 catalog shuffle 中遗漏的组和标签均写 tombstone。组 delete 会 tombstone 仍 ACTIVE 的全部已知子标签，因为 provider 的组删除不为每个子标签补 callback；所有行保留，不做硬删。delete 使用终止 sequence rank，优先级高于普通 create/update 的 wall-clock，因此异常更晚 update 也不能复活已删除 tag/group。标准目录和 strategy 目录以独立 `strategy_id` 隔离，同名 remote ID 不串写。

### 生产 Hyperdrive、随机 schema 与失败记录

最终完整流程的只读基线请求 `130f95bc-da42-460c-bc6e-6a5acc8300d1` 确认生产为 242 表/212 序列、三个 C7 表不存在、legacy `work_label/user_label` 均 0 行、临时审计 schema 为 0，完整目录 digest 为 `3644b23ffd1d71c241bfe72e048c82c01ac526a4e7c6048e56ded63e7f508117`。空 legacy 表只能证明当前无可抽样标签，不是源标签已迁移。

迁移前最终流程的隔离请求 `b00145af-4859-4be7-9271-686d1b174b44` 把 exact `0117` 连续执行两遍：migration 6/6 验证三表创建、对象 OID/relfilenode/定义和空 tuple 第二遍稳定、约束/索引/对象总数精确；direct-service 13/13 覆盖初始组/标签、组快照 omission tombstone、业务 no-op、旧 direct 事件、provider response crossing newer fence、not-found refresh-only、tag 终止、组删除级联且保留历史、全 catalog shuffle、strategy 身份隔离、current 目录闭包、authority-off sentinel 和历史行保留。随机 schema 删除，`public_catalog_unchanged=true`，目录 digest 仍为 `3644b23f…`。提交前门禁复核又补齐 external-tag disabled outbox 的停放/恢复条件、投影终止错误的 DEAD 分类以及“tag authority + full visibility”双读 gate；最新代码隔离请求 `77880ce2-f0d2-4f32-98fb-2eb33c9c963c` 重新取得相同 6/6+13/13、临时 schema 删除和 `public_catalog_unchanged=true`，此时生产目录 digest 为迁移后的 `fc652c6d…`。

生产迁移请求 `33694887-eaec-4f96-bc2c-43ed4307510d` 将 `0117` 连续执行两遍：`242→245` 表、序列保持 212，三个投影表均 0 行；第二遍对象与 tuple 不变，legacy 行/MVCC 指纹不变，表增量精确 `+3`、sequence 增量 `0`，25 个约束、8 个索引、36 个闭合对象全部匹配，target metadata digest 为 `900f0fa96a3f1ed2ba953e1d7438a46a62fba1830743a39bd24ee9171769b98f`。最终只读请求 `24a0de31-42fc-4a24-8203-b59ef7b3c9b9` 确认 245 表/212 序列、三个新表全 0 行、临时 schema 0，完整目录 digest 为 `fc652c6dc5100e89c8acad31682a27ec05f4b82784312fc37f45854fab2aff13`。

失败轮次没有计入通过。首轮隔离因随机 schema 名 64 字节超过 PostgreSQL 63 字节限制而在任何生产 DDL 前中止；次轮暴露目录读取没有复用 `SET LOCAL search_path`；第三轮又证明 raw 审计连接经 Hyperdrive multiplex 后可能读到旧 checkpoint，而应用事务内 current 目录已看到新状态。最终把 schema 名缩短、目录读取放入同一 request transaction、checkpoint 改为显式顺序短事务后重新取得上述 6/6+13/13。每次失败都由条件门禁阻止 `/migrate`，finally 删除 Worker/schema并回探 404；生产直到最终全绿流程才执行 DDL。

### 工程门禁、checklist 与剩余阻塞

最终 `data:schema-audit` 为 source 201、target 245、shared 201、target-only 44、源列缺口 0、外部/Worker 245/245、表/列/主键漂移 0。两套 TypeScript 配置通过；C7 定向 3 文件 41/41，全量单元测试 161 文件/1001 项通过；`git diff --check` 无错误。C7 审计 Worker dry-run 为 1,356.35 KiB/gzip 221.40 KiB；主 Worker minify dry-run 为 3,171.73 KiB/gzip 751.94 KiB并精确回显指定 Hyperdrive，均未部署主 Worker。临时 Worker、随机 schema 和一次性 token 已删除，workers.dev 回探 404。Windows runtime 仍在 0 条断言前因 `workerd 0xc0000005` 失败；后续受支持的 Ubuntu workerd 门禁已由 Actions `33373018752` 的 1 文件/10 项关闭。

- [x] 建立远端字符串 tag/group 与 strategy 隔离身份，完成标准/strategy provider 快照、create/update/delete/shuffle 投影、omission tombstone 和终止态。
- [x] 完成 exact `0117` 外部/内嵌迁移、生产双跑、随机 schema 6/6+13/13、current-first 目录和 authority-off fail-closed。
- [x] 对 `batch_job_result` 保持显式 `IGNORED`，只保存有界 `JobType/JobId/ErrCode`，不保存 `ErrMsg` 或假报目录同步成功。
- [ ] 取得只读源 MySQL 后复制/映射真实 legacy 标签并由运营抽样；生产 legacy/current 标签均为 0 行，不能宣称历史标签已迁移。
- [ ] 使用最小权限 external-contact Secret 和测试租户验证标准/strategy 正向、真实 `40068`、组删除、shuffle 及权限范围；启用前回读 Script Settings，确认 traces 关闭或 query-string 已可靠脱敏。
- [x] WORK-C8 代码与结构：欢迎语、自动标签、商城用户关联已进入独立 action outbox/Queue，覆盖部分成功、429、结果未知、人工处置与审计终态；生产 expand-only DDL、随机 schema 和 Admin 脱敏处置面已完成。
- [ ] WORK-C8 发布闭环：完成真实源数据/旧媒体迁移、企业微信测试租户、预发、影子流量、明确发布批准和发布后观察；Linux runtime 已独立关闭。

## WORK-C8 欢迎语、自动标签与商城用户关联 action outbox 详细审计（2026-08-31）

### 审计结论与严格完成边界

WORK-C8 现可标记为**代码、生产 Hyperdrive 结构、随机 schema 真实服务场景和 Admin 脱敏人工处置面完成**，但不能标记为企业微信远端能力已启用、真实业务数据已迁移、主 Worker/Admin 已发布或 WORK-C 整体完成。本批只关闭 PHP `WorkClientServices::createClient()/updateClient()` 后置的三类副作用：新增客户欢迎语、渠道码自动标签和按 unionid 关联商城 UID。每个动作独立收敛，任一动作失败不回滚已完成动作，也不把回调管道的 `ORDERED/APPLIED` 冒充远端已经成功。

所有生产数据库操作只通过用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行。生产 `public` 只接受 expand-only `0118_work_contact_action_outbox.sql` 及第二遍幂等复验；没有插入合成 CorpID、客户、回调、欢迎码、标签、unionid 或人工处置行。合成 DML 只在随机 `codex_work_action_*` schema 中执行并最终级联删除。`WECHAT_WORK_CONTACT_ACTION_AUTHORITY` 与 C0～C7 authority/full-visibility gates 均保持关闭，主 `cinashop-api` 和 Admin Pages 均未部署。

### PHP 权威行为与迁移风险

旧 `WorkClientServices::createClient()` 先同步保存客户，再依次触发 `work.welcome`、`work.label` 和 `work.user`；三段异常各自捕获后只写日志，因此天然是部分成功。`updateClient()` 只再次尝试商城用户绑定。`WelcomeSendListener` 从 `State=channelCode-<id>` 解析渠道码，自定义欢迎语优先，否则按员工关系/默认欢迎语回退，递增 `client_num`、替换 `##客户名称##`、解析媒体后调用 `send_welcome_msg`；注释和协议都要求 WelcomeCode 约 20 秒内单次使用。`ClientLabelListener` 解析渠道 `label_id` 后调用 `mark_tag`。`ClientBindUserListener` 按 unionid 取第一条微信用户 UID，没有歧义或现有 UID 冲突保护。

旧实现没有事务投递记录、动作级幂等键、租约、确定性重试、结果未知状态或人工对账。欢迎语媒体解析还会读取本地路径/URL并即时上传，迁移到 Worker 后若照搬会扩大 SSRF、任意下载、超时和临时素材过期风险；因此新实现不抓取旧 URL，只接受已经物化的 `media_id/pic_media_id`。URL-only 旧素材明确进入 `DEAD/welcome_media_not_materialized`，等待受控素材迁移和人工关闭，不静默丢附件或发送残缺消息。

### 动作模型、Queue 与结果未知语义

`work_contact_action_outbox` 为每个 `(event_id, action_type)` 保存一条不可变意图，动作键与原 payload SHA-256 固定，Queue 正文严格只有 `{action, actionId, actionKey}`。三个动作分别是 `WELCOME_SEND`、`AUTO_TAG`、`CLIENT_UID_LINK`；状态集合为 `PENDING/ENQUEUING/ENQUEUED/PROCESSING/RETRYABLE/SUCCEEDED/SKIPPED/EXPIRED/UNKNOWN/DEAD/CLOSED`。动作在 C5 客户投影的同一短事务中创建，渠道 `client_num` 只在欢迎动作首次插入时递增一次；外部 provider I/O 全部在数据库事务之外执行。

欢迎语 deadline 固定为 callback `received_time + 20` 秒，入队已经超时则直接 `EXPIRED`。网络中断、响应无法解析、HTTP 408/425/5xx、企业微信 `41051`，以及远端调用后本地成功状态无法确定，均进入 `UNKNOWN`，不自动重发单次欢迎码。标签的明确 429/忙码使用有界退避；网络/响应结果未知同样进入 `UNKNOWN`，只有管理员对账并明确承担重复副作用风险后才能重试。代码复审进一步修复了两个关键窗口：远端调用成功后的本地落库异常不再被 provider catch 误判为已知失败；任何过期的欢迎语/标签 `PROCESSING` 租约，即使 Queue 先于 Cron 重投，也会直接转为 `UNKNOWN` 而不是再次调用 provider。

商城 UID 关联不调用企业微信：动作保存 unionid 摘要，处理时重新锁定当前客户并比较摘要，只连接 `wechat_user.is_del=0` 且商城用户有效的唯一 UID。零匹配在 7 天窗口内最多 12 次有界重试，最终 `SKIPPED`；多个不同 UID 或既有 UID 冲突进入 `DEAD`，绝不取数据库“第一条”。客户已失效、unionid 缺失或已被更新时幂等跳过。

### 审计、保留与人工处置

`work_contact_action_audit` 保存管理员 ID、UUID request key、请求摘要、from/to 状态、理由、风险确认和可选 provider 参考号摘要，不自动复制客户标识、欢迎码、标签或动作 payload；人工理由仍是运营输入，页面明确要求不得填写个人信息或凭据。数据库触发器禁止更新/删除人工记录，并禁止修改动作身份、原 payload 摘要和 deadline。Admin 新增 `GET /adminapi/work/contact_action` 与 `POST /adminapi/work/contact_action/:id/decision`，继续受 `enterprise_wechat.view/manage` 服务端权限强制约束；列表不返回 PII，处置只允许 UNKNOWN 确认成功、非欢迎语 UNKNOWN/DEAD 明示风险后重试，或 UNKNOWN/DEAD 关闭。现有 `/operations/work` 页面已接入状态/类型筛选、脱敏台账和三类不可变处置表单。

callback 白名单 payload 新增 `payload_retained_until/payload_redacted_time`。默认保留 30 天；只有 callback inbox 为 `ORDERED`、callback outbox 为 `COMPLETED`，且所有动作均为 `SUCCEEDED/SKIPPED/EXPIRED/CLOSED` 时才删除 WelcomeCode、UserID、ExternalUserID 等原 payload，只保留消息/事件/变更类型与时间。`UNKNOWN/DEAD` 会阻止脱敏，直到人工对账关闭，避免先删掉唯一对账证据；已收敛动作本身立即把 payload 清成空对象，但保留原摘要。

### 生产 Hyperdrive、随机 schema 与失败记录

最终迁移前只读基线请求 `32edde36-acc4-4152-ad45-87b18e2a092a` 确认 PostgreSQL 16、245 表/212 序列、两个 C8 目标表不存在、临时 schema 为 0。渠道码、欢迎语、欢迎语关系、媒体、微信 unionid、current 客户、add/edit callback、WelcomeCode、callback outbox 全部为 0；这只证明 expand-only DDL 和空库默认安全，不是历史业务已迁移或正向数据质量证明。

生产迁移请求 `2be55bfe-9519-46e7-8218-0e26945b3fa1` 将同一 `0118` 连续执行两遍：245→247 表、212→214 序列，两个动作表均 0 行；第二遍动作/保留元数据与 tuple 不变，既有九张相关业务表 MVCC 指纹不变，表/序列增量精确 `+2/+2`。闭合对象精确为 18 个约束、10 个索引、2 个用户触发器、2 个 `search_path=pg_catalog` 保护函数和 4 项 callback 保留元数据；动作/保留 metadata digest 分别为 `3eaf3d949c6ad6454f133a165ef33d5ace3af7ad163d410a5e6624303456425b` 与 `da2ba253ff0d98bcd1347827bc9f9c3d40658ae00bce9b7abe03a474c6973382`。迁移后只读请求 `194bf6a2-5ea7-473b-99cd-1f2da88d6a47` 确认两表存在且仍为 0 行、临时 schema 为 0。

最新代码隔离请求 `c2b83e22-16a6-47b4-8762-aecffd25d2f9` 在迁移后的生产引擎中把 exact DDL 再执行两遍并构造 4 个 add-contact 事件、12 个独立动作。18/18 断言覆盖：引用型 Queue、同一欢迎动作并发单 provider 调用、部分成功、终态重放无 provider 调用、标签 UNKNOWN 风险重试、过期 provider 租约 UNKNOWN 且不重发欢迎语、unionid 歧义、欢迎码过期、URL-only 旧媒体关闭、人工审计精确/不可变、回调脱敏/阻断、渠道计数一次和商城 UID 唯一关联。最终状态为 `SUCCEEDED 4/SKIPPED 5/EXPIRED 1/CLOSED 1/DEAD 1`，provider mock 调用为欢迎语 1、标签 2，人工处置 3、脱敏 callback 3；随机 schema 删除后 `public_catalog_unchanged/public_business_rows_mvcc_unchanged/public_action_metadata_unchanged=true`，临时 schema 回到 0。最终只读请求 `cc2a1fcc-071f-4acc-a83a-543e5a1ab34d` 再次确认生产动作表 0 行。

失败轮次没有计入通过，也没有触发生产迁移：首轮复合随机 `search_path` 被安全校验拒绝；次轮用早于 callback 接收时间的保留截止值时，`wce_payload_retention_ck` 正确阻止非法测试数据；一次边缘返回非 JSON 错误页、一次迁移前只读请求瞬时失败，脚本都在 `/migrate` 前停止。每轮 finally 都删除临时 Worker，最终 workers.dev 回探均为 404；临时随机 schema 最终均为 0。

最终仓库 `data:schema-audit` 为 source 201、target 247、shared/complete 201、source-only/缺源列 0、target-only 46；外部迁移与 Worker 内嵌迁移均为 247 表，表/列/主键漂移 0。双 TypeScript 配置通过，C8 定向 3 文件 46/46、全量单元测试 162 文件/1,007 项通过，Admin 生产构建 2,425 modules 通过；企业微信页面 chunk 为 JS 18.02 KiB/gzip 6.59 KiB、CSS 4.19 KiB/gzip 1.16 KiB。主 Worker minify dry-run 为 3,216.15 KiB/gzip 762.29 KiB，C8 审计 Worker为 982.68 KiB/gzip 179.29 KiB，两者均精确绑定指定 Hyperdrive且只 dry-run。Windows runtime 再次在 0 个测试/0 条断言前因 `workerd 0xc0000005` 启动失败；随后新增无生产 Secret、`contents:read` 且固定 Actions SHA 的 Ubuntu 24.04 门禁，提交 `8c4280f95e31521d50b24657645fb330299c7921` 的 [GitHub Actions 33368811307](https://github.com/cinagroup/cinashop/actions/runs/33368811307) 在 Node 24.14.1 下真实运行 workerd，1 文件/8 项全部通过。前两轮分别暴露旧 Cron `4→13` 合同与非法 outbox fixture、以及 test helper 不回显 retry delay/悬挂测试 PG 客户端；均修正后才计通过。随后提交 `b09c2c9bb823219f68f76ac40b4f25d2d46f15b3` 的 [Actions 33373018752](https://github.com/cinagroup/cinashop/actions/runs/33373018752) 把门禁扩展到 1 文件/10 项并通过，新增 Kefu ChatRoomDO 非法握手和真实 101/hibernation/token 撤销覆盖。扩展过程四个失败 run `33371796477/33372190812/33372516131/33372696791` 分别暴露跨 DO I/O 对象、辅助器非 upgrade 请求、pair 双重接受和无真实 peer 被驱逐四类测试夹具错误；没有计为通过、没有访问生产 PostgreSQL，也没有部署主 Worker/Admin。

该 Linux 安装还暴露出 `drizzle-orm <0.45.2` 的 [CVE-2026-39356](https://github.com/advisories/GHSA-gpj5-g38j-94v9) 高危标识符转义漏洞。仓库生产代码没有调用 `sql.identifier()`，现有 `sql.raw()` 标识符来自静态常量或已校验的 `search_path`，未发现攻击者输入到动态标识符的可利用路径；仍将生产 ORM 精确升级到 `0.45.2`，开发 CLI 升到 `0.31.10`，并为 Drizzle/Vitest 分别解析兼容的 esbuild 版本。新版收紧的泛型 `from()` 类型在 `BaseDao` 以 PostgreSQL 表安全上转处理，未放宽 DAO 的公开读写类型。升级后 `npm ls` 为有效树，双 TypeScript 配置、schema audit 与全量 162 文件/1,007 项单测通过，主 Worker minify dry-run 为 3,224.31 KiB/gzip 764.19 KiB 且仍精确绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`；`npm audit --omit=dev` 为 0，并已加入 Linux 硬门禁。提交 `deeb62efa49c1e00ff25ae4e90322b54bca0c713` 的 [GitHub Actions 33371016049](https://github.com/cinagroup/cinashop/actions/runs/33371016049) 一次通过 locked install、生产依赖审计与真实 workerd 1 文件/8 项。完整开发依赖审计仍有 4 个 moderate，全部局限于已弃用的 `drizzle-kit → @esbuild-kit → esbuild 0.18` 本地开发服务器链；最新稳定 CLI 尚未移除它，npm 建议的自动修复会倒退到 `drizzle-kit 0.18.1`，因此不冒充已清零，也不把该链打入生产 Worker。

### 工程门禁、待完成 checklist 与发布顺序

- [x] 审计 PHP 三个 listener 的输入、部分成功语义、20 秒欢迎码、标签和 unionid 关联风险。
- [x] 完成 exact 外部 `0118`/内嵌 `migration_0124`、动作/审计表、不可变触发器、callback 保留与生产双跑。
- [x] 三类动作独立建账、引用型 Queue、短事务租约、429 退避、UNKNOWN 不盲重发和动作 payload 收敛后清除。
- [x] unionid 唯一 UID 关联、歧义/冲突失败关闭、30 天 callback 脱敏与 UNKNOWN/DEAD 对账证据保留。
- [x] Admin PII-free 台账、服务端 view/manage 权限、确认成功/风险重试/关闭 API 与响应式处置页面。
- [x] 生产 PostgreSQL 16 expand-only 双跑、迁移前后只读审计，以及最新随机 schema 18/18 服务断言；生产业务行和动作行未被测试污染。
- [x] 修复 Drizzle ORM 高危 CVE，生产依赖官方 npm 审计为 0，并把生产依赖审计加入 Linux CI；4 个开发期 moderate 已隔离并显式记录。
- [ ] 取得只读源 MySQL/正式备份后迁移并抽样真实 `work_channel_code/work_welcome/work_welcome_relation/work_media/wechat_user`；当前生产均为 0 行。
- [ ] 把 URL-only 欢迎语附件通过受控下载、类型/大小校验和最小权限素材上传预先物化为可发送 media ID；禁止 Worker 在 callback 热路径抓取任意 URL。
- [ ] 配置测试租户 CorpID、AgentID、external-contact Secret、callback Token/AES Key、full-visibility 权限和正式 Origin；回读 Cloudflare Script Settings 确认 traces 关闭或 query-string 已可靠脱敏。
- [ ] 用真实测试客户验证 add/edit callback、20 秒欢迎语、标签、唯一/歧义 unionid、真实 429/41051/权限错误与 Admin 对账，不使用生产客户制造故障。
- [x] Linux/受支持主机 Workers runtime：Ubuntu 24.04、Node 24.14.1、workerd 1 文件/13 项已由 Actions `33380831249` 通过，含 R2 写读列删、Queue ack/retry/DLQ，以及 ChatRoomDO 真实握手/hibernation/token 撤销；Windows `0xc0000005` 只保留为本机环境缺陷。
- [ ] 经明确批准部署主 Worker/Admin，按 C0→C8 依赖顺序启用 client/tag/full-visibility/contact-action gates，先预发和小流量，再观察 Queue 延迟、UNKNOWN/DEAD、欢迎码过期、标签 429、UID 歧义和 callback 保留积压；准备关闭 gate 的回滚方案。
- [ ] 完成旧端/新端 golden response、真机、影子流量、业务/安全批准和发布后观察后，才能勾选 WORK-C 父项。

## SIGN-REMIND-TIME 定时扫描与站内信闭环详细审计（2026-08-31）

### PHP 权威语义与迁移边界

旧 PHP 的真实调用链已逐文件复核：`SystemTimer` 的 `sign_remind_time` 分支调用 `UserSignServices::userSignRemind()`；安装数据把它定义为 type 4、cycle `10/25`，即每天上海时间 10:25。服务选择 `is_del=0/status=1/sign_remind=1` 的用户，再排除当天已签到者，并触发 `notice.notice`。`NoticeService::signRemindTime()` 会依次尝试短信 `SIGN_REMIND_TIME`、`SystemMsgJob` 站内信和小程序订阅消息；旧 listener/job 会捕获并吞掉异常，既没有每日幂等键，也无法证明部分成功后的重放结果。

本批完成的是可在现有生产资源上安全关闭的站内信闭环，不把缺凭据的外部副作用冒充完成。短信和小程序订阅消息被保留为单独 checklist：后续必须建立 provider 级持久账本、请求身份、明确成功/可重试/UNKNOWN/DEAD 状态及人工对账，再接入真实凭据和模板。主 Worker没有部署，因此生产用户没有收到本批合成或真实提醒。

### Worker 调度、Queue 与幂等设计

Cron 仍每 5 分钟触发，但只有名义时间换算为 Asia/Shanghai 10:25 时才新增 `sign_remind_time` 根任务，其余 287 个时点不写这一根消息。扫描在短事务中按 `user.uid` 主键游标分页，每页 80，只选择正常、未软删、已开启偏好且目标上海自然日没有 `user_sign` 的用户；Queue 消息只含 `userId`、`scheduledAt/runId` 与整数上海日编号，不含手机号、模板正文或其他 PII。满页 continuation 与候选合计不超过 Cloudflare Queue 单批上限。

消费端先拒绝损坏的 run/day/user 合同和跨日迟到消息，再与签到写路径共用 namespace `731623` 的用户级 transaction advisory lock；锁内重新检查用户状态、删除状态、提醒偏好和当天签到，关闭“扫描后用户关闭偏好或完成签到仍被提醒”的窗口。站内信事件键固定为 `sign_remind_time:<shanghaiDay>:<uid>`，复用既有 `system_message.event_key` 与 `smsg_event_key_uq`，`INSERT ... ON CONFLICT DO NOTHING` 后复核赢家的 mark/UID；因此 Queue 至少一次投递、发送结果未知后的重试和 DLQ 人工重放都不会新增第二条。模板从 `system_notification.mark=sign_remind_time` 读取；缺失、系统通道关闭或用户不再符合条件均显式跳过，重复模板和事件键冲突则失败并进入 30/60/120 秒、最高 900 秒的有界重试。provider/Queue I/O 均在数据库事务外，DLQ 只归档可重放的引用消息。

### 生产 Hyperdrive 事实与随机 schema 验收

临时审计 Worker版本 `821b4d66-f159-47a9-9128-ffc91831e273` 精确绑定用户指定的 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。`public` 审计使用 `REPEATABLE READ, READ ONLY`、`search_path=public`、20 秒 statement timeout和2秒 lock timeout，仅返回聚合计数/布尔结构：PostgreSQL 16.14；提醒开启的正常用户 0、当天未签到候选 0、`sign_remind_time` 模板 0（站内信/SMS/routine 启用均0）、旧 timer 行0、历史签到站内信0；`system_message.event_key` 列和 `smsg_event_key_uq` 唯一索引均存在。零样本证明目标库尚未导入/配置该能力，不是生产正向验收通过。

同一生产 PostgreSQL 引擎的随机 `codex_sign_reminder_*` schema 使用真实 `SignReminderService` 通过 10/10：非 10:25 不扫描；8 个合成用户中精确选出 `[1,6,7,8]`；首投递创建；重复投递返回 `already-created`；扫描后关闭偏好返回 `preference-disabled`；扫描后签到返回 `already-signed`；制造重复模板使真实消费失败且第2次 Queue attempt 请求60秒重试、没有 ack；修复模板后重试创建；最终只有 UID 1/8 两条消息、两个不同事件键且模板正确渲染。随机 schema 删除后同前缀 schema 为0，`public` 历史提醒仍为0，临时 Worker随后删除。第一次审计请求因只读 SQL 把保留字 `window` 用作别名而在任何随机 schema DDL前失败；修正为 `bounds` 后完整重跑，失败轮不计入通过。

### 工程门禁与剩余阻塞

实现提交为 `59dafb5d4e3f671f48b90a16fd0acae0d62d1142`。本地全量单元测试 163 文件/1,014 项、双 TypeScript、schema audit source 201/target 247/shared 201/零缺口/247↔247 零漂移、生产依赖官方 npm 审计0和 `git diff --check` 通过；主 Worker minify dry-run为3,230.70 KiB/gzip765.97 KiB并精确绑定目标 Hyperdrive，但没有部署。Ubuntu 24.04.4、Node 24.14.1/npm11.11 的 [GitHub Actions 33379089255](https://github.com/cinagroup/cinashop/actions/runs/33379089255) 已通过 locked install、生产依赖审计0和真实 workerd 1文件/11项，其中新增断言证明只有上海10:25才多出签到根任务。Windows本机仍在进入断言前因既有 workerd `0xc0000005` 崩溃，不计为代码失败。

严格剩余边界：生产缺提醒用户、timer和通知模板，无法做真实 token/真实用户正向站内信验收；SMS与小程序订阅消息尚未实现 provider 账本；源 MySQL、旧 PHP并行写切流、默认地址/收藏跨栈问题、五端 E2E、预发、影子流量、明确发布批准及发布后观察仍未完成。因此本批只勾选签到提醒“扫描+Queue+站内信”子项，USER-CENTER-COMPAT父项和正式发布继续保持未完成。

## TEST-002 Workers 真实运行时覆盖审计（2026-08-31）

### 覆盖边界与隔离性

TEST-002 现可严格标记为完成：`@cloudflare/vitest-pool-workers` 启动真实 workerd，并在单一隔离运行时中覆盖 Cron、Queue ack/retry/DLQ、KV、R2、Durable Object 持久化/并发和 WebSocket hibernation。`wrangler.test.toml` 的 Hyperdrive 指向不可连接的 `127.0.0.1:1`，KV 使用全零本地 ID，Queue 使用 `cinashop-order-runtime-test`，新增 R2 bucket 名为 `cinashop-assets-runtime-test`；配置不包含生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、生产 KV ID、生产 Queue 或生产 R2 bucket，因此这些断言不能读写生产资源。

R2 断言在本地 binding 中写入小型文本对象及 HTTP/custom metadata，随后验证正文、metadata、前缀 list、delete 和删除后 get=null。DLQ 断言使用 Cloudflare 测试运行时创建真实 `MessageBatch`：归档成功后出现精确 explicit ack 且无 retry；模拟 PostgreSQL 归档失败后不 ack、只出现 retry marker。每条 retry 的精确 60 秒延迟仍由普通单元测试校验，因为 Cloudflare 当前测试 helper 只暴露 retry marker；生产 DLQ 的 PostgreSQL 持久化、不可变记录和人工重放另有生产引擎/随机 schema 审计，TEST-002 不重复连接生产数据库。

其余运行时断言覆盖：非提醒 Cron 生成13个可重放根任务、上海10:25额外生成签到根任务；legacy Queue 消息明确 ack、支付 outbox 数据库失败不 ack并 retry；KV 写读隔离；SequenceDO 在 isolate eviction 后恢复 SQLite 序列并发分配64个无重复ID；ChatRoomDO 拒绝非法升级、完成真实101握手、恢复 tagged WebSocket attachment并按 token 撤销；扫码登录 DO 覆盖拒绝、受众隔离、签发租约和固定 token 重投。它证明运行时 binding 与关键交付语义在受支持 Linux 主机可执行，不等于生产发布、真实 Hyperdrive/R2 数据链或全仓 TEST-001 已完成。

### 验证证据与未完成项

实现提交 `1e9c0ea86c60e3d5837a6c1be1f001bb0b5c3342` 在本地通过双 TypeScript 检查、`git diff --check` 和全量单元测试163文件/1,014项。Windows 本机仍在0个测试/0条断言前因 workerd `0xc0000005` access violation 启动失败，并伴随沙箱对 Wrangler日志目录的 EPERM；该结果只记录为主机环境缺陷，不计为测试通过或代码回归。

[GitHub Actions 33380831249](https://github.com/cinagroup/cinashop/actions/runs/33380831249) 在 Ubuntu 24.04.4、Node 24.14.1/npm 11.11 上从锁文件安装125个包，生产依赖审计为0漏洞，真实 workerd 最终为1文件/13项全部通过；日志同时出现归档成功事件和第2次尝试归档失败时 `retryDelaySeconds=60`，证实 DLQ 两条分支均实际进入。主 Worker、Pages和任何生产资源均未部署或修改。

在 TEST-002 收口时，TEST-001 仍保持未完成：当时的 workflow 只负责 locked install、生产依赖审计与 Workers runtime，没有同时执行 Worker全量单测/类型、五端构建、Kefu专项、schema drift、PHP→TS route audit和 secret scan；route audit 还依赖本机旧 `cinashop-php` 源树。下一节记录后来如何固定权威输入并独立关闭 TEST-001；不能把较早的 TEST-002 成功追溯解释为当时已经完成全仓 Linux CI。

## TEST-001 全仓 Linux CI 与旧 PHP 权威快照详细审计（2026-08-31）

### 审计结论与权威输入

TEST-001 现可严格标记为完成：`.github/workflows/workers-runtime-linux.yml` 已从单一 runtime job 扩展为 8 个并行 job，覆盖 Worker静态/单测、真实 workerd、Admin、PC、Supplier、Kefu、UniApp和全历史 secret scan。所有 Node job 都固定 Ubuntu 24.04、Node `24.14.1`，并在安装前显式断言 bundled npm 精确为 `11.11.0`；依赖一律使用各项目 `package-lock.json + npm ci`。checkout/setup-node 都固定完整 Action commit SHA，workflow权限只有 `contents: read`，不注入生产 Secret、不连接生产 Hyperdrive/R2/Queue，也不执行部署。

CI 原先无法运行 schema/route audit，因为旧 `cinashop-php` 只存在于本机相邻目录，远端仓库没有可取得的受控 revision。本批没有伪造 clone URL，也没有把7.3 MiB原始安装 SQL或PHP业务源码复制进新仓库；而是生成两份最小权威快照。`legacy-schema-authority.sql` 只保存201张源表的列名和主键形状，头部固定原 `crmeb.sql` SHA-256 `0096d86464b81935106311e4bb4092b647ab3acaf2bab0febe5695f8f66c593a`。`legacy-route-authority.json` 保存六个路由面的1,904条解析后注册、行号/控制器目标，以及6个路由文件和5个退役证据文件的行数与SHA-256；不保存数据库行、配置值或凭据。

本机存在PHP源树时，route audit 会重新解析全部路由并对整个快照做确定性相等比较，任一源文件/路由/行号/目标/SHA变化都会要求显式审计后再生成；单测也逐个复算11个文件和原安装SQL摘要。CI无源树时才使用已版本化快照，退役决策仍必须命中带SHA和行数的证据文件。真实源与快照模式最终都得到PHP 1,904、TS 1,448、精确匹配746、可执行728、不可用18、原始缺失1,158、退役4、可执行缺口1,154，精确/可执行/有效可执行覆盖为39.2%/38.2%/38.3%；快照只让门禁可重复，不提高迁移覆盖率。

### 最终 Linux 门禁证据

实现由提交 `48a9d396aa7ca825a94096398532be685b659ce4`、无源单测修复 `853634b709b0e4257464b068b82421a92b93ee07` 和非空secret扫描修复 `c8363f7af8c9a8f7bc57c8607983ff0b5b931dbd` 收敛。[GitHub Actions 33385492677](https://github.com/cinagroup/cinashop/actions/runs/33385492677) 最终8/8 jobs通过：

- Worker静态门禁：locked install、生产依赖官方npm审计0、双TypeScript配置、164文件/1,017项单测全部通过；schema audit为source201/target247/shared201/sourceGaps0，外部专用迁移与Worker内嵌迁移的externalOnly/workerOnly/columnDrift均0；route audit从仓库内权威快照运行并输出上述1,904/1,448/746/728结果。
- Worker真实运行时：生产依赖审计0，workerd 1文件/13项通过，继续覆盖Cron、Queue ack/retry/DLQ、KV、R2、DO和WebSocket hibernation。
- 五端矩阵：Admin、PC、Supplier生产构建通过；Kefu 1文件/7项测试及生产构建通过；UniApp类型检查、H5和微信小程序两种构建均通过。矩阵为`fail-fast:false`，一个端失败不会遮蔽其他端证据。
- Secret scan：Gitleaks精确固定为8.29.0，Linux x64发布资产下载后校验官方SHA-256 `39e07ad810336fd0ae80d0bd61c60d0521f628173e7583583b5df4a38738522c`，再在`fetch-depth:0`的runner主机工作树执行；最终日志明确为68 commits scanned、no leaks found。两个全局allowlist都同时要求精确rule、精确path和精确整行，只放行测试中的固定32字节十六进制会话夹具，以及PEM header删除正则；没有按目录、扩展名或宽泛secret关键词放行。

### 失败轮次与严格边界

首轮 [Actions 33384233967](https://github.com/cinagroup/cinashop/actions/runs/33384233967) 的7个job成功，但Worker单测有2项仍直接打开仓库外PHP文件，结果为162文件/1,015项通过、2项ENOENT失败，schema/route步骤随即跳过；该轮不计通过。修复后 [Actions 33384971116](https://github.com/cinagroup/cinashop/actions/runs/33384971116) 表面8/8成功，但Docker action内的Gitleaks日志显示`0 commits scanned`，因此仍被拒绝为完成证据。第三轮改为runner主机上安装checksum-pinned二进制后才得到68提交的非空扫描。两轮失败/无效证据都没有访问生产数据库、部署Worker/Pages或改动Cloudflare资源。

TEST-001 的完成只表示每次相关代码推送都能在受支持Linux主机重复执行这些工程门禁。它不证明旧/新端浏览器golden response、真机、真实账号、支付/微信/短信/企微回调、生产数据迁移、性能告警、预发、影子流量或发布后观察；TEST-003、REL-001～004及各业务父项继续保持未完成。当前路由可执行覆盖仍只有38.2%，CI通过绝不能解释为整体迁移完成。

## TEST-003 性能与可观测性详细审计（2026-08-31）

### 审计结论与 Cloudflare 能力边界

TEST-003 不能整体勾选。仓库侧的可重复合同已经完成，但生产侧仍缺三个不同层次的证据：原生指标与 PostgreSQL 统计基线、可送达且有 owner 的真实告警、候选发布后的观察窗口。Cloudflare 当前官方能力可以直接提供这些原生数据：Hyperdrive 的 `hyperdriveQueriesAdaptiveGroups` 有 query/connection latency、event status、bytes/cache status，`hyperdrivePoolSizesAdaptiveGroups` 有 open/available/waiting/max pool；Queues 有 backlog、oldest message、lag/retry和 `outcome=dlq`；Durable Objects 有 invocation/subrequest/storage和 p99 memory；R2 有 operation action/status。应用日志只补业务域和安全状态机结果，不能取代这些平台指标。

Workers Logs 官方明确区分对象日志与字符串：`console.log({field: value})` 才会把字段独立索引，旧代码大量 `console.log(JSON.stringify({...}))` 只得到 message文本。本批新增统一 `cinashop_operational_v1` 对象日志器并清除生产源码中的所有直接 `console.log/warn/error`；`audit:observability` 递归扫描366个 `src/**/*.ts`，只允许日志器本身调用 console。日志器只接受标量、有限数值和低基数事件/操作名，禁止 `authorization/body/content/cookie/credential/email/error/message/password/payload/phone/query/secret/token/url`、任何 `id/*Id/*Uid` 标识字段及覆盖固定 `schema`；异常只映射为类名代码，绝不记录原始 message/stack，因为数据库驱动和provider异常可能夹带连接串、SQL参数、PII或远端响应正文。CI还用TypeScript AST检查每个日志调用，拒绝标识字段、computed/spread对象，防止未被单测执行的分支绕过合同。

`wrangler.toml` 现在显式固定 `[observability] enabled=true/head_sampling_rate=1` 和 `[observability.logs] enabled=true/invocation_logs=true`。fetch traces仍为false：企微provider当前把凭据放在query string，在已部署候选上证明redaction前不得为了trace覆盖扩大泄露面。HTTP中间件不记录raw path/query/headers/body/UID，只把路径归入login/payment/refund/print/waybill/R2六个低基数关键域；关键域每次请求、所有5xx和超过1秒的其他请求产生final status+duration事件。全局未知异常不再输出message/stack。支付/退款callback、payment outbox、Queue/DLQ、Work callback/action、签到、短信、R2、DO聊天、打印、面单、物流和异步访问记录全部改为同一对象合同；打印/面单UNKNOWN或DEAD、DLQ落盘、R2补偿失败使用error等级，busy/deferred/retry使用warn，provider body和任务payload不进入日志。

### 机器可读指标、阈值与 CI 门禁

`workers-ts/audit/observability-policy.json` 固定Worker、Hyperdrive、R2和三条Queue的生产身份，并定义14个信号、10个域和首响规则：Hyperdrive错误率/平均延迟/pool waiter；Queue backlog/oldest和DLQ transition/unarchived backlog；DO错误率/p99内存；R2 internal error；登录拒绝/5xx；支付callback；退款UNKNOWN/DEAD；打印和面单UNKNOWN/DEAD。主要阈值为：Hyperdrive平均查询250ms/15m warning、1s/5m critical，任一waiter warning/5个critical；主Queue backlog 100或oldest60秒warning、1,000或300秒critical；任何DLQ transition或unarchived backlog即critical；DO p99内存96MiB warning、120MiB critical；R2任一internalError critical；支付处理失败、退款UNKNOWN超过15分钟、打印/面单任一UNKNOWN/DEAD均critical。低流量域同时要求绝对计数，避免只用比例制造噪声。

`npm run audit:observability` 不只是JSON语法检查：它精确验证Hyperdrive/三条Queue ID、release配置100%日志采样、trace关闭、27个必需关键事件、10个策略域、对象console实现、366个生产源文件无旁路日志、每个调用点无标识字段/对象展开，以及生产基线中6个明确阻塞。该命令已加入Linux `worker-static` job，和双TypeScript、全量单测、schema/route audit一起阻断提交。日志单测覆盖九类关键路径分类、对象字段可索引、敏感/标识/保留schema/嵌套/NaN/原始异常消息拒绝、最终HTTP成功状态和通用5xx；定向测试14/14通过。完整运行手册在 `workers-ts/OBSERVABILITY.md`，策略阈值以JSON为权威，文档不得自行漂移。

实现提交 `beb2071b397eb316ee8cb5592656b3dceb7ed1a3` 已推送至main。[GitHub Actions 33393069797](https://github.com/cinagroup/cinashop/actions/runs/33393069797) 最终8/8 jobs成功：Worker生产依赖审计0、双TypeScript、165文件/1,031项单测；observability输出14信号/10域/27必需事件/366生产源文件/6发布阻塞；schema输出source201/target247/shared201/sourceGaps0/externalOnly0/workerOnly0/columnDrift0；route输出PHP1,904/TS1,448/精确746/可执行728；真实workerd 1文件/13项；Admin、PC、Supplier、Kefu和UniApp构建矩阵通过，Kefu 7/7；固定checksum的Gitleaks对70个提交完成非空全历史扫描且no leaks found。Windows本机workerd仍在0条断言前以`0xc0000005`启动失败，不计为代码回归；主Worker、Pages和临时审计Worker均未因该CI发布。

### 生产只读事实与新发现的发布阻塞

本轮没有创建、修改或删除生产资源，只通过Wrangler读接口核验现状，并把结果固化到 `audit/production-observability-baseline.json`。Hyperdrive `9748c294e21c49a99579c9cef70102e0` 确认为 `cinashop-pg`，origin connection limit 60、query cache开启。三条Queue ID分别为主队列 `7c5d03145eb541cbbb3695fad3925d70`、DLQ `886e026a32c74359b2b40407f4def8d6`、归档失败终端队列 `ec0ef96ffcd3429da48500cdf90ca532`。主队列实际消费者是`cinashop-api`，batch10、max wait2秒、max retries3、失败进入DLQ，配置与仓库第一段consumer一致。

但生产没有仓库配置中的第二段consumer：`cinashop-order-dlq`当前消费者数为0。生产100%流量仍指向2026-08-09版本 `9f1fd655-e60f-41c1-8280-738bc85d73ef`；版本详情有Hyperdrive、CONFIG_KV、ORDER_QUEUE和四个DO namespace，却没有`ASSETS_BUCKET`，也没有`ORDER_DLQ_NAME` plain variable。也就是说，仓库中的DLQ→PostgreSQL归档、归档失败再入`cinashop-order-dlq-unarchived`和私有R2附件代码尚未上线；只看bucket/queue“资源存在”会错误高估生产迁移进度。该事实现在列为REL-001前置P0，主Worker未经明确发布批准仍不会被本审计改动。

用户已授权直接使用生产数据库，但当前唯一安全路径需要部署一个受随机令牌保护的临时Workers endpoint。沙箱明确拒绝了创建公开端点的副作用；普通沙箱请求在任何上传前因文件/网络权限失败，提权部署未执行。随后只读查询Cloudflare返回`cinashop-production-observability-audit`不存在（code10007），证明没有残留Worker或version。因此本轮没有读取生产PostgreSQL `pg_stat_database/pg_stat_activity/pg_stat_user_tables/pg_stat_statements`，也没有取得四类任务状态的新基线。仓库保留的audit harness强制`SET TRANSACTION READ ONLY`、`search_path=public,pg_temp`、5秒statement/500ms lock timeout，只返回聚合统计且不返回SQL/参数/业务值；它仍需用户在知情后明确批准临时公开端点，或改用既有私有service/operations入口。

### 待完成 checklist 与完成标准

- [x] TEST-003A：统一对象日志、HTTP关键域/慢请求、关键状态机事件、14信号策略、运行手册、全源码旁路扫描、CI命令和本地测试。
- [ ] TEST-003B：通过获批私有观测入口或明确批准的临时审计端点，取得Hyperdrive/Queue/DO/R2原生指标、Queue实时backlog/oldest以及PostgreSQL聚合统计；记录低流量基线和四类任务UNKNOWN/DEAD，不返回SQL、参数或PII。
- [ ] TEST-003C：选择Cloudflare Notifications或获批OTLP/Logs平台，配置真实通知destination、policy ID、owner和升级链；逐条用无真实资金/物流副作用的信号验证warning/critical送达与ack。
- [ ] TEST-003D：发布精确候选后确认DLQ consumer、R2/DLQ bindings和对象字段实际生效，观察Hyperdrive/Queue/DO/R2/登录/支付/退款/打印/面单窗口并基于真实基线调优；企微query string redaction未证明前继续关闭traces。

只有A～D全部有生产证据后才能勾选TEST-003父项。策略文件、绿色单测或“资源已经创建”都不能替代实际部署、通知送达和观察窗口。

## 完成定义

一个业务域只有同时满足以下条件才可标为“完成”：旧新路由/权限/状态机映射齐全，数据迁移可重复且校验通过，关键并发与失败恢复有集成测试，前端真实流程通过，预发 Cloudflare 和第三方回调有远端证据。源码中存在接口或页面不等于迁移完成。
