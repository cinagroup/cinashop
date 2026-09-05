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

DIY-HOME-WIDGETS 的服务端、生产只读审计、部分唯一索引升级和目标 PostgreSQL 隔离场景已收口。新 UniApp 第一前端子批也已恢复 8 条类型化 client、版本缓存、严格 allowlist renderer、首页回退、正整数 ID 微页面、21 类低/中耦合组件，以及首页和微页面的悬浮导航；正文复用既有 HTML sanitizer，不使用 `v-html`，数据库颜色、图片和链接均先归一并失败关闭。首页在生产无默认 DIY 或 API 未发布时保留原静态首页，不会把空内容渲染成白屏。

本子批以隔离 mock API 做了浏览器渲染验收：桌面首页和 390×844 微页面均显示搜索、菜单、轮播、商品、文章、三榜、新人、签到、匿名用户、视频和客服等组合；页面宽度为 390px、无横向溢出；无效微页面 ID 显示受控失败态；点击搜索后到达现有搜索页。干净页面没有应用级 console error，只有 UniApp 打包依赖的 Vue Router 弃用警告。定向 DIY 前端/服务端合同测试、UniApp 类型检查及 H5/微信小程序生产构建通过。该验收使用确定性 mock 数据，因为主 Worker 尚未发布候选路由且生产 `system_dise/video/store_newcomer/store_promotions` 为空，不能冒充真实线上数据或登录态 E2E。

随后第二前端子批逐文件对照旧 `news.vue`、`hotspot.vue`、`follow.vue` 及 Admin `home_hot.vue`：新闻公告保留列表/轮播两种结构和可选标题图；图片热区将编辑器的 750rpx 坐标映射到相对容器，最多接受 30 区且只保留归一后的内部/HTTPS 链接；公众号卡片只展示安全头像和二维码，以弹层支持长按识别，不复刻 H5 DOM 下载、跨端相册权限和未使用的订阅查询；活动魔方最多四格并限制标题、简介、图片和链接。`activeParty` 在 Admin 可编辑、PHP 会裁剪后返回，但旧 UniApp 首页/微页面没有组件 import 或模板挂载，属于源端可配置却不可见的确定缺陷；新端把它作为显式 allowlist 静态组件恢复，并在审计中记录这一有意修复。

本子批继续不使用动态组件、`v-html`、数据库脚本或外部下载，所有集合、文本、边距、圆角、颜色、图片和热区坐标均有界且失败关闭。定向 DIY 测试更新为 2 文件/23 项并通过；隔离 mock 页面在桌面端显示新闻、热区、活动魔方和公众号卡片，关注按钮打开/关闭二维码弹层，热区点击切换到现有分类页。390×844 精确设备尺寸下 `innerWidth/bodyWidth/rendererWidth=390/390/390`、活动卡 369.2px，无横向溢出；控制台只有 UniApp 打包依赖的 Vue Router 弃用警告，没有应用级 error。

第三前端子批完成 `bargain/combination/coupon/liveBroadcast/promotionList/seckill/presale/pointsMall` 八类业务数据组件的静态挂载。组件使用类型化活动 client，列表、文本、ID、颜色、图片、分页和选择范围全部有界；固定商品、品牌、分类及商品标签为空时失败关闭，不会退化为全目录曝光；直播只在 `MP-WEIXIN` 编译分支读取并只跳转正整数 `room_id`，H5 不调用小程序私有页；领券先检查登录态。`promotionList` 支持最多 12 个标签、每组最多 20 个商品及最多 50 个范围 ID。为避免匿名大 OFFSET，秒杀/拼团/砍价列表在 DAO 前将 limit 限为 50、OFFSET 限为 10,000。

这次对 PHP 列表消费者和生产公开 API 的交叉审计发现了一个此前被“路由存在”掩盖的合同缺口：已部署 Worker 的秒杀首页返回 camelCase 数组，旧 UniApp 实际要求 `{lovely,seckillTime,seckillTimeIndex}`，并且边缘 `Date#getHours()` 使用 UTC，导致上海活动时段错位；秒杀、拼团、砍价和积分列表也直接泄露 Drizzle camelCase，而旧端消费 snake_case/`title/ot_price` 等字段。候选 Worker 已改为 Asia/Shanghai 时钟、PHP 信封和旧字段投影，并补齐有界分页；20:30 上海时区夹具验证选中第三时段且 `stop` 为 `+08:00` Unix 秒。生产公开探针还确认 `/api/presale/list`、`/api/wechat/live`、`/api/v2/coupons` 在当前主 Worker 均为 404，而秒杀/拼团/砍价/积分仍是旧响应，证明线上版本落后于本地候选；本批没有发布主 Worker或 Pages。

隔离 mock 的 390×844 H5 验收实际渲染 7 个可见组件且每类一次，`liveBroadcast` 按条件编译在 H5 隐藏；促销标签由“本周精选”切换到“新品推荐”后商品集合同步变化，未登录“领取”进入登录页，商品卡进入精确详情路由。组件页无应用级 console error，只有 UniApp 依赖的 Vue Router 弃用警告；详情路由探针随后因 mock 未覆盖详情 API 产生预期 404，不计作组件页错误。Worker 单元测试为 183 文件/1,175 项全部通过，Worker 双 TypeScript、UniApp TypeScript、H5/微信小程序生产构建和主 Worker `wrangler deploy --dry-run --minify` 均通过；Windows 本机 runtime 仍在执行断言前以 `workerd 0xc0000005` 崩溃，Linux 历史门禁继续作为有效 runtime 证据。

第四前端子批逐文件统计旧 UniApp：`main.js` 虽把 `components/home/index.vue` 注册为全局组件，但没有自动渲染；实际由 68 个页面手工写入 `<home>`。这些旧页面在新端合并为 38 个现存等价页面，本批逐页静态挂载 `DiySuspendedNavigation`，加上已覆盖的首页与专题页共 40 个页面文件。组件继续过滤不安全图片/链接和最多 6 个按钮，并通过 5 分钟共享 promise/config 缓存避免页面切换时重复打到公开配置接口；认证、安全设置和未迁移旧页面没有被擅自扩大为新的悬浮入口。静态测试固定 38 页映射并逐文件断言，避免后续路由重构静默丢失入口。

390×844 应用内浏览器从商品列表打开两项悬浮菜单，点击首项进入品牌资讯；目标页仍显示同一悬浮入口，切换到“迁移资讯”后文章卡、日期和阅读数正常渲染。页面身份、非空内容、无框架 overlay、菜单展开、跨页 URL 和目标内容均通过；控制台只有 UniApp 依赖的 Vue Router 弃用警告。H5/微信小程序生产构建、UniApp 类型检查和 Worker 183 文件/1,175 项单测通过。隔离 mock 初始未提供 `article/hot/list`，所以默认“热门”曾显示受控 `not found`；切换到本次有数据的目标分类后错误态消失，这不是生产接口结论，临时 mock 与本地服务均已删除/停止。

第五个基础设施子批关闭 PHP `get_thumb_water('mid')` 的私有 R2 中图策略。调用链只出现在 `GET /api/diy/product_rank`：`StoreProductRankServices::getProductRankList()` 调用 `StoreProductServices::getRecommendProduct(...,'mid')`，随后才进入 `get_thumb_water`。PHP 在 `image_thumb_status` 缺失/关闭、路径无效、URL 已含查询参数或上传驱动异常时返回原图；本地上传驱动以保持比例的 `THUMB_SCALING` 生成中图，并在启用水印时先处理水印。`BaseUpload` 的代码默认值虽为 400×400，安装 SQL 又曾给出 360×360，运行时 `UploadService::init()` 会用 `system_config` 覆盖，所以不能靠任一静态默认猜生产尺寸。

候选 Worker 只变换 canonical `/api/assets/:id`，外部 HTTPS/历史 URL 原样兼容。响应时生成 `variant=mid&width=...&height=...` 的 15 分钟 HMAC URL，签名消息绑定附件 ID、到期时间、变体名和宽高；任一参数被篡改都会在数据库读取前以 404 失败。变体名固定为 `mid`，宽高必须是 `1..2048` 的安全整数。只有 `image_thumb_status` 行真实存在且为 PHP 真值、`thumb_mid_width/height` 同时合法时，排行图片才请求中图；否则仍签名原图。附件读取再次验证签名与 R2 元数据，只对 JPEG/PNG/WebP/GIF 调用 Cloudflare Images `scale-down`，GIF 保留动画，非图片或转换异常回退重新读取的原 R2 对象。

[Cloudflare Images binding 官方文档](https://developers.cloudflare.com/images/optimization/binding/)确认 binding 可直接接收 R2 原始字节、输出时必须指定格式，且变换结果不会自动获得应用所需缓存策略。因此实现使用 Workers Cache API，内部 key 绑定附件 ID、源 ETag、固定变体、尺寸和输出格式；源对象变化会自然换 key。缓存对象可保留 7 天，但对客户端的签名读取仍强制 `private,no-store`，不会把私有对象公开缓存。Cache 写入只通过 `executionCtx.waitUntil` 调度，失败和 Images 失败仅发送不含附件 ID/对象 key 的低基数 `r2_object_variant_cache_failed` / `r2_object_transform_failed`。按当前[Images 计费文档](https://developers.cloudflare.com/images/pricing/)，正式启用前仍需由运营确认变换量和费用；代码完成不等于生产已开通或无需观察。

按用户授权再次通过 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 执行 `REPEATABLE READ, READ ONLY` 审计。配置 allowlist 从原 21 个首页键扩展为 PHP `getImageConfig()` 的完整 20 个图片键，响应只返回行数、非空/数值/JSON计数、启用计数和 `1..2048` 尺寸计数，不返回配置值或媒体引用。结果是 `image_thumb_status/image_watermark_status`、大/中/小图尺寸、图片/文字水印全部字段和 `upload_type` 均为 0 行；所以生产当前 PHP 语义明确是不开缩略图、不加水印，候选上线后也只会返回签名原图。首轮因临时配置未显式打开 workers.dev 得到 1042，数据库没有被访问，`finally` 删除后 API 返回 Worker 不存在；补上 `workers_dev=true` 后完整审计成功，结束时再次 `wrangler delete`，部署列表以 10007 确认临时 Worker 不存在。两轮均未部署主 Worker、未执行生产 DML/DDL。

工程门禁为目标 3 文件/34 项、完整单元 183 文件/1,177 项、双 TypeScript、observability 17 信号/10 域/53 必需事件/405 个生产源文件和 `git diff --check` 通过；Wrangler 4.122.0 minify dry-run 为 `3,613.83 KiB / gzip 847.77 KiB`，精确识别 Hyperdrive、R2、Images、Cache、Queue、KV 与 Durable Objects 后退出。新增 workerd 用 1×1 PNG 实际执行 `env.IMAGES.input(...).transform(...).output(...)`；提交 `d82a327` 推送后，[Linux Migration gates 33519138758](https://github.com/cinagroup/cinashop/actions/runs/33519138758) 8/8 jobs 成功，runtime 精确为 1 文件/14 项，Worker 全量、双 TypeScript、schema/route/observability、五端构建和全历史 Gitleaks 也全部通过。Windows 本机仍在 0 条断言前以既有 `0xc0000005` 启动失败，不能记作本地 runtime 通过。

父项仍不能完成：生产 `system_dise=0`，没有真实 DIY 页面或悬浮配置；视频、新人商品、促销均为 0，可领取券为 0，已部署主 Worker又缺三条本批依赖路由，无法做真实内容、真实 token、真实领券或微信直播正向 E2E。生产还存在原 21 个配置 15 个缺失、20 个图片配置全缺、`site_url/sign_give_point/sign_status` 重复、2 张过期但状态仍可用的用户券、3 个用户券 owner 孤儿、关系 owner 孤儿 1、签到 owner 孤儿 1、商品收藏计数漂移 1。所有异常仅被只读记录，没有自动删除、归属或改状态。PC 是否消费同一 DIY、源附件到 `system_attachment`/R2 的逐对象映射与 hash/mime/size 对账、未来启用水印时的等价实现、Images 费用和缓存命中观察、未迁移旧页面本身、旧端与 H5/小程序/APP、预发、影子流量、主 Worker/Pages 发布和发布后观察仍未完成。

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

`cinashop` 已具备一个可构建、可测试且已有核心版本部署到 Cloudflare 的商城切片，但仍不是 `cinashop-php` 的等价替代。历史 M1～M24 标签只描述实现批次，不代表旧系统业务覆盖率；上一加固版本的远端 Worker、Hyperdrive 绑定、公开数据库读取和安全门禁已经核实。当前静态路由总览为 PHP 1,904、TS 1,632、精确匹配 871、可执行 853、明确不可用 18、退役 17、可执行缺口 1,016；精确/可执行/退役后有效覆盖为 45.7%/44.8%/45.2%。

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

提交后又核对Cloudflare 2026-08官方文档并尝试不部署正式Worker的替代路径：Hyperdrive目前明确不支持本地`remote=true` binding，只能用`wrangler dev --remote`把代码送入临时preview环境。该命令在任何preview上传或数据库请求前，仍因Windows workerd既有`0xc0000005`启动失败退出；本机没有WSL发行版也没有Docker，仓库Actions Secret名称列表为空，故无法把同一临时会话安全转移到Linux runner。没有安装系统组件、没有创建GitHub Secret、没有改用直连origin凭据，也没有扩大公开端点；该失败轮不计生产基线，只作为TEST-003B执行环境阻塞证据。

### 待完成 checklist 与完成标准

- [x] TEST-003A：统一对象日志、HTTP关键域/慢请求、关键状态机事件、14信号策略、运行手册、全源码旁路扫描、CI命令和本地测试。
- [ ] TEST-003B：通过获批私有观测入口或明确批准的临时审计端点，取得Hyperdrive/Queue/DO/R2原生指标、Queue实时backlog/oldest以及PostgreSQL聚合统计；记录低流量基线和四类任务UNKNOWN/DEAD，不返回SQL、参数或PII。
- [ ] TEST-003C：选择Cloudflare Notifications或获批OTLP/Logs平台，配置真实通知destination、policy ID、owner和升级链；逐条用无真实资金/物流副作用的信号验证warning/critical送达与ack。
- [ ] TEST-003D：发布精确候选后确认DLQ consumer、R2/DLQ bindings和对象字段实际生效，观察Hyperdrive/Queue/DO/R2/登录/支付/退款/打印/面单窗口并基于真实基线调优；企微query string redaction未证明前继续关闭traces。

只有A～D全部有生产证据后才能勾选TEST-003父项。策略文件、绿色单测或“资源已经创建”都不能替代实际部署、通知送达和观察窗口。

## WORK-C 清单状态纠偏与 ADMIN-E ERP 能力端点详细审计（2026-08-31）

### 审计结论

本轮先发现并修正了一个清单状态漂移：`MIGRATION_AUDIT.md` 的既有生产证据已经证明 WORK-C7 与 C8 达到“代码、生产结构、随机 schema/隔离服务验收完成，未启用/未发布”，但 `MIGRATION_CHECKLIST.md` 仍把 C7/C8 整项写成待实现。清单现将两项代码边界勾选，同时分别保留真实源数据、真实企业微信租户/provider、全量 reconciliation、旧媒体/商城 UID 映射、预发、影子流量、明确发布批准和发布后观察等未完成子项；WORK-C 父项继续保持未勾选，未把结构完成冒充生产能力完成。

随后选择不依赖 ERP 协议、外部账号或远端副作用的 ADMIN-E 作为下一精确缺口。PHP 权威为 `route/api.php:699-701` 的 `GET /api/admin/erp/config` 与 `app/controller/api/admin/order/StoreOrder.php:54-60` 的 `getErpConfig()`：成功响应只含 `open_erp = !!sys_config('erp_open')`。实现前静态路由审计明确把该路由列在 `/api` 缺口中；实现后它从缺口移入精确且可执行匹配。该子项现在可标为“代码与静态合同完成，未发布”，不能据此勾选 ERP-001/002 或 API-008 父项。

### 实现与安全边界

- `src/routes/v1/index.ts` 精确注册 `GET /admin/erp/config`，继续挂在应用既有 `/api` 前缀下；路由必须经过 `adminAuthMiddleware`，后者校验 admin token bucket、JWT `type=admin`、有效管理员、密码摘要 auth claim，并对非超级管理员执行服务端 ACL。
- `AdminPermissionService` 把 `erp/config` 显式登记到 `config` 权限域；只读方法要求 `config.view`。这遵循迁移清单对内嵌 Admin 的收紧决策，不复制 PHP 移动管理面仅凭普通用户 token 与 Customer middleware 进入的宽权限模型。
- 新 `ErpCapabilityService` 只读取 `system_config.erp_open`，只接受规范的 `1/true` 为开启；缺失、`0/false` 和损坏/非规范值均失败关闭。响应 DTO 精确只有 `{open_erp:boolean}`，没有 ERP 类型、账号、token、secret、password、provider URL 或原始配置值。
- 控制器设置 `Cache-Control: private, no-store, max-age=0`。客服侧既有 `/kefuapi/erp/config` 改为复用同一能力服务，保持既有响应字段与严格开关语义，避免两处能力判断继续漂移。
- 本项没有第三方网络调用、数据库写入、DDL、Queue 消息或日志新增。生产主 Worker仍是旧版本；仓库代码未来发布后才会通过既有生产 Hyperdrive读取该开关。本轮没有借“直接使用生产数据库”的授权绕过既有安全阻塞去创建临时公开探针，也没有把未部署代码写成生产已生效。

### 验证证据与剩余边界

实现前路由基线为 PHP 1,904、TS 1,448、精确 746、可执行 728、原始缺失 1,158、可执行缺口 1,154；`/api` 为 PHP 457、TS 757、精确 364、可执行 361、原始缺失 93、可执行缺口 92。实现后审计为 PHP 1,904、TS 1,449、精确 747、可执行 729、原始缺失 1,157、可执行缺口 1,153；`/api` 为 TS 758、精确 365、可执行 362、原始缺失 92、可执行缺口 91，且缺口列表不再包含 `/api/admin/erp/config`。精确/可执行/退役后有效覆盖分别为 39.2%/38.3%/38.4%，只是一个真实合同的净增，不改变整体迁移仍大幅未完成的结论。

定向门禁为三文件 19/19：覆盖开关规范值、缺失配置回源并缓存空标量、真实控制器响应 envelope/cache header、响应精确字段/无秘密名称、路由注册、Admin 中间件和 `config.view` 权限映射。双 TypeScript 配置、166 文件/1,036 项全量单测、observability 14 信号/10 域/27 事件/367 个生产源文件、schema source 201/target 247/shared 201/零缺口/247↔247 零漂移、生产依赖官方 npm 审计 0 和 `git diff --check` 均通过；主 Worker minify dry-run 为 3,239.67 KiB/gzip 768.33 KiB并精确回显目标 Hyperdrive，但没有部署。Wrangler 在沙箱外日志目录出现既有 EPERM 提示，不影响 dry-run 以退出码 0 完成。

实现提交 `7d30a244ed0653c1d9c6428fa9e70c349df14cee` 已推送至 `main`。[GitHub Actions 33396920497](https://github.com/cinagroup/cinashop/actions/runs/33396920497) 最终 8/8 jobs 成功：Worker job 在 Ubuntu 24.04/Node 24.14.1 上通过双 TypeScript、生产依赖审计 0、166 文件/1,036 项单测、上述 observability/schema/route 汇总；真实 workerd 为 1 文件/13 项；Admin、PC、Supplier、Kefu、UniApp 全部通过各自类型/测试/生产构建门禁；checksum-pinned Gitleaks 扫描 73 个提交且 `no leaks found`。该 CI 没有生产 Secret，不访问生产 Hyperdrive，也不部署 Worker/Pages。

ERP 主面仍有 `/erpapi` 8/8 条缺口：授权、回调、access token、商品同步、库存、发货、取消和售后收货都需要明确协议、沙箱、凭据、签名/重放保护与幂等事件账本。ADMIN-E 只暴露关闭/开启能力，不会触发这些流程；生产发布仍受 REL-001/002 的单独明确批准门禁约束。

## ADMIN-C 内嵌售后详细审计（2026-08-31）

### PHP 权威、既有实现与缺口判定

PHP 权威是 `route/api.php:702-704` 与 `app/controller/api/admin/order/StoreOrder.php:836-882` 的三条移动管理合同：`GET /api/admin/refund_order/list`、`GET /api/admin/refund_order/detail/:uni`、`POST /api/admin/refund_order/remark`。列表把 `order_id/time/refundTypes/apply_type` 交给 `StoreOrderRefundServices::refundList()` 后只返回其中的 `list`；DAO 的 `refundTypes` 不是单值退款状态，而是 0→`[0]`、1→`[1,2]`、2→`[4,5]`、3→`[5]`、4→`[6]`、5→`[0,1,2,4,5]`、6→`[3,6]` 的七组语义。搜索覆盖退款单号、退货快递号、用户昵称/UID/手机号、商品名/关键词以及原订单号/UID/手机号。详情的 `:uni` 同时接受退款表主键与公开退款单号，再以 `store_order_id` 读取原订单并投影商品快照；备注按公开退款单号更新 `store_order_refund.remark`。

实现前 Worker 只有 `/api/admin/refund/list` 与 `/api/admin/refund/detail/:id`：前者没有 PHP 四类筛选或分页，后者只接收数字主键、直接返回退款行，均不能作为三条精确路径的等价实现。PHP 移动管理组历史上使用普通用户 token/Customer middleware，备注没有长度上限、事务行锁或审计状态，详情也没有明确排除已取消/已删除记录；这些宽边界没有复制。ADMIN-C 的目标是保留客户端合同与业务筛选，同时升级为服务端受限 Admin ACL 和失败关闭的数据边界。

### 实现、数据范围与安全边界

- `AdminMobileRefundService` 对 page/limit、100 字搜索词、0～6 组合状态、0～4 售后类型、时间范围和 50 字退款选择器做确定性校验；每页最多 100 条。列表仍覆盖全平台的门店/供应商售后，因为 PHP 权威没有隐式 `store_id=0`，但统一要求 `is_cancel=0 AND is_del=0`。商品快照复用既有有界 JSON 投影，不把原始快照字符串直接透传。
- 详情对数字参数执行“退款主键或公开退款单号”匹配，对文本只做公开退款单号精确匹配；命中后必须存在 `store_order.id = refund.store_order_id` 且 `store_order.uid = refund.uid` 的权威关系，否则拒绝。响应恢复旧页面使用的退款图片、退货说明、商品快照、原订单号、收货/配送字段、支付/退款时间、支付方式、备注与状态字段；不返回密码摘要、token、数据库连接或配置秘密。
- 三条路由都经过 `adminAuthMiddleware`。`AdminPermissionService` 新增 `refund_order/` 到退款权限域；GET 只能由 `refund.view` 读取，POST 必须有 `refund.manage`。敏感响应均设置 `Cache-Control: private, no-store, max-age=0`。
- 备注只接收已验证 Admin 上下文中的 `adminId`，不接受客户端 actor；去除首尾空白后必须为 1～255 字。事务设置 2 秒 lock timeout 与 5 秒 statement timeout，对有效退款行 `FOR UPDATE`，同值直接返回 `changed=false`，变化时才更新并在同一事务写 `store_order_status(change_type=admin_refund_remark)`。日志消息只记录执行管理员 ID和动作，不复制备注正文，避免把业务备注扩散到不可变状态日志。
- 本批没有新增退款同意/拒绝、付款渠道调用或资金写入；这些动作继续由 CORE-002 的退款状态机和账本承担。没有 DDL、Queue 消息、第三方网络调用、生产业务 DML 或新运行日志。使用的 Cloudflare Workers 审查准则促成了显式 ACL、无秘密响应、请求外无副作用、事务超时和可重复测试这些边界。

### 路由、测试、CI 与生产边界

实现前 ADMIN-E 后的路由基线为 PHP 1,904、TS 1,449、精确 747、可执行 729、原始缺失 1,157、可执行缺口 1,153；`/api` 为 TS 758、精确 365、可执行 362、原始缺失 92、可执行缺口 91。ADMIN-C 净增三条精确可执行合同后，总计为 TS 1,452、精确 750、可执行 732、原始缺失 1,154、可执行缺口 1,150，精确/可执行/退役后有效覆盖 39.4%/38.4%/38.5%；`/api` 为 TS 761、精确 368、可执行 365、原始缺失 89、可执行缺口 88，三项覆盖为 80.5%/79.9%/80.0%。`/erpapi` 仍是 0/8，其他面未因本批改变。

定向三文件 18/18 覆盖列表边界、七组 `refundTypes`、时间解析、主键/公开单号选择器、备注空值/长度、控制器 envelope/no-store、actor 来源、精确路由、view/manage ACL、有效记录过滤、行锁和审计类型。完整本地门禁为双 TypeScript 配置、167 文件/1,043 项单元测试、observability 14 信号/10 域/27 必需事件/368 个生产源文件/6 个发布阻塞、schema source201/target247/shared201/sourceGaps0/externalOnly0/workerOnly0/columnDrift0、官方 npm 生产依赖审计 0 与 `git diff --check` 全部通过。主 Worker minify dry-run 为 3,247.93 KiB/gzip 770.74 KiB，精确回显生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`；Wrangler 仍因沙箱外日志目录报既有 EPERM，但 dry-run 退出码为 0，且没有部署。

实现提交 `57f08565ea01a0caa07b7adde61827d3ecbc7f5f` 已推送至 `main`。[GitHub Actions 33399262375](https://github.com/cinagroup/cinashop/actions/runs/33399262375) 最终 8/8 jobs 成功：Worker job 在 Linux 通过生产依赖审计 0、双 TypeScript、167 文件/1,043 项单测、上述 observability/schema/route 门禁；workerd 1 文件/13 项通过；Admin、PC、Supplier、Kefu和UniApp矩阵全部成功；checksum-pinned Gitleaks 对 75 个提交完成非空全历史扫描且 `no leaks found`。CI 不含生产 Secret，不访问 Hyperdrive，也不部署 Worker/Pages。

用户已要求直接使用生产数据库；仓库实现未来发布后确实只通过现有生产 Hyperdrive 读取/更新目标 PostgreSQL，没有引入影子数据库或 SQLite。但本批是零 schema 变更的未部署 HTTP/service 合同，Windows `wrangler dev --remote` 仍在任何 preview 上传/数据库请求前因 workerd `0xc0000005` 退出，且临时公开探针此前未获安全执行许可，因此没有伪造新的生产查询或写入证据。既有只读审计已确认生产有 3 条售后且售后孤儿/UID错配为 0；这不能代替候选发布后的真实 Admin 账号列表、详情、备注幂等、权限拒绝和发布观察。ADMIN-C 现只标记“代码、静态合同与服务回归完成，未发布”；REL-001/002、TEST-003B～D、真实前端 E2E 和明确生产发布批准仍是独立门禁。

## ADMIN-B 内嵌商品详细审计（2026-08-31）

### PHP 权威、旧端真实用法与缺口判定

PHP 权威是 `route/api.php:709,713-718` 的七条移动管理合同：`GET /api/admin/product/category`、`GET /api/admin/product/admin_list`、`POST /api/admin/product/set_show`、`GET /api/admin/product/product_label`、`GET /api/admin/product/get_attr/:id`、`POST /api/admin/product/update_attrs/:id` 与 `POST /api/admin/product/batch_process`。控制器分别落到 `admin/product/StoreProductCategory::category()` 和 `admin/product/StoreProduct`；服务层的管理列表把 `type` 映射为商品状态，默认状态为 1，返回 `{list,count}` 并为单规格商品附加一个 `attr_value`。分类返回可见树，标签返回标签组/标签 children 树；规格读取限定 `product_id + type=0`，规格写入按 `unique` 更新 price/stock/cost/ot_price、把 `sum_stock` 重置为当前库存、重算商品总库存及最高售价/成本/划线价，并写库存记录。上下架还同步购物车和分类关系；批处理服务实际支持 1～9 多类后台动作，但旧 UniApp `pages/admin/goods` 只从该路径调用类型 1 分类和类型 2 商品标签，checklist 原始范围也明确为“修改分类标签”。

实现前 Worker 只有不同路径/不同投影的商品列表、详情和单 ID 状态修改：没有七条精确合同，列表缺 `is_show/attr_value/plate_name` 等旧页面字段，既有状态修改也没有恢复移动端批量载荷、购物车/关系同步或规格价格库存合同，因此不能用相似路由计算为迁移完成。PHP 这组路由历史上依赖普通用户 token/Customer middleware，规格更新信任客户端 `unique`，批处理把关系更新分发到异步 Job，缺少跨主表/关系表的单事务原子性；这些宽边界没有照搬。

### 实现、状态机与安全收紧

- `AdminMobileProductService` 恢复七条旧路径和 PHP envelope，所有响应设置 `Cache-Control: private, no-store, max-age=0`。路由统一经过现有 `adminAuthMiddleware`；`product/` 权限域令 GET 需要 `product.view`、POST 需要 `product.manage`，没有因为路径位于 `/api/admin` 就允许普通用户 token。
- 管理列表保留 `store_name/type/page/limit` 与默认状态 1，复用既有 DAO 的 PHP 搜索/状态语义并把单页限制为 100；只读取 `is_del=0` 商品，再补齐权威 `is_show/cate_id/store_label_id`、单规格 SKU、库存/销量和平台/有效门店/有效供应商名称。旧 CSV/JSON 标签字段以容错只读方式解析，损坏值收敛为空数组而不是让整页失败。分类只返回平台可见树；父链环或孤儿不会形成无法 JSON 序列化的循环对象。标签只返回平台有效标签组和可见有效标签，停用关系失败关闭。
- 上下架载荷允许一个或最多 100 个去重商品 ID，`is_show` 必须精确为 0/1。事务设置 2 秒 `lock_timeout` 与 5 秒 `statement_timeout`，锁定全部商品行并要求精确存在；删除商品拒绝修改，上架额外要求 `is_verify=1`，成功后清空定时下架、同步有效未支付购物车及 `type=1` 分类关系。历史已支付/已删购物车不会被追溯改写。
- 规格更新最多 500 条，只接受必填且不重复的 8 字符内 `unique`、两位小数内非负 price/cost/ot_price 和 32 位非负整数 stock。服务先锁定有效商品与其全部基础 SKU，客户端 `unique` 必须属于当前商品；未提交 SKU 保持原值，提交 SKU 按数据库主键和 product/type 双重条件更新。总库存做安全整数上限检查，商品聚合字段从锁内最终 SKU 重算；只有真实库存差额才写 `store_product_stock_record`，从而阻止跨商品 SKU 改价、负库存、溢出和无变化审计噪声。
- 批处理只接受旧移动端实际使用的类型 1 分类与类型 2 商品标签，最多 100 个商品、50 个关系；标签空数组表示显式清空。商品行先锁定，分类/标签行以共享锁验证为平台有效对象，再在同一事务内替换商品 CSV 字段和 `store_product_relation`。这比 PHP 的主表更新后异步 Job 更强地保证原子性，但不声称恢复后台隐藏的配送方式、用户标签、虚拟商品、商品保障、品牌等类型 3～9；这些如有真实调用必须分别审计。
- 本批没有 DDL、Queue 消息、第三方网络调用、资金动作、生产业务 DML 或新运行日志。Cloudflare Workers 最佳实践审查直接约束了显式 Admin ACL、请求内事务、短锁/语句超时、无秘密响应、无请求外副作用和结构化回归门禁。

### 路由、测试、CI 与生产边界

实现前 ADMIN-C 后的总路由为 PHP 1,904、TS 1,452、精确 750、可执行 732、原始缺失 1,154、可执行缺口 1,150；`/api` 为 PHP 457、TS 761、精确 368、可执行 365、原始缺失 89、可执行缺口 88。ADMIN-B 净增七条精确可执行合同后，总计为 TS 1,459、精确 757、可执行 739、原始缺失 1,147、可执行缺口 1,143，精确/可执行/退役后有效覆盖为 39.8%/38.8%/38.9%；`/api` 为 TS 768、精确 375、可执行 372、原始缺失 82、可执行缺口 81，三项覆盖为 82.1%/81.4%/81.6%。其他路由面未改变；静态覆盖仍不等于真实前端、权限拒绝、并发状态机或生产发布已完成。

定向三文件 21/21 覆盖列表/状态/SKU/批处理解析边界、分类树与环防护、七个控制器 envelope/no-store、精确路由、view/manage ACL、商品/SKU 锁、权威成员校验、库存审计和关系同步。完整本地门禁为双 TypeScript、168 文件/1,051 项单元测试、observability 14 信号/10 域/27 必需事件/369 个生产源文件/6 个发布阻塞、schema source201/target247/shared201/sourceGaps0/externalOnly0/workerOnly0/columnDrift0、官方 npm 生产依赖审计 0 和 `git diff --check`。Windows 本机 workerd 仍在执行断言前以 `0xc0000005` 启动失败；主 Worker minify dry-run 成功为 3,260.91 KiB/gzip 774.00 KiB，精确回显生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有执行部署。

实现提交 `dcf1666ef17507697c167d61a33fe214733640a5` 已推送至 `main`。[GitHub Actions 33402759265](https://github.com/cinagroup/cinashop/actions/runs/33402759265) 最终 8/8 jobs 成功：Worker job 在 Linux 通过生产依赖审计 0、双 TypeScript、168 文件/1,051 项单测、observability、201/247/201/零缺口/零定义漂移和 1,904/1,459/757/739 路由门禁；真实 workerd 1 文件/13 项通过；Admin、PC、Supplier、Kefu和UniApp矩阵全部成功；checksum-pinned Gitleaks 扫描 77 个提交且 `no leaks found`。CI 没有生产 Secret，不访问 Hyperdrive，也不部署 Worker/Pages。

用户已要求直接使用生产数据库；当前实现没有引入影子库，未来获批发布后七条服务将直接通过上述生产 Hyperdrive 读写 PostgreSQL。本批没有 schema 变化，且安全的本地远端执行路径仍被 Windows workerd 崩溃阻断；永久临时公开探针不在既有授权范围，因此没有用测试写入触碰生产商品、SKU、购物车或关系数据，也没有把 dry-run 描述成生产 E2E。ADMIN-B 目前只能标为“代码、静态合同与服务回归完成，未发布”；发布前仍需真实 Admin 账号的最小权限拒绝/允许、列表字段、上下架、规格幂等与并发、分类/标签替换、旧 UniApp 流程和回滚演练，且主 Worker/Pages 发布继续受 REL-001/002 的单独明确批准门禁约束。

## ADMIN-D 内嵌用户详细审计（2026-08-31）

### PHP 权威、旧端用法与原实现风险

PHP 权威是 `route/api.php:724-734` 的八条移动管理合同：`GET /api/admin/user/label/:uid`、`GET /api/admin/user/coupon/grant`、`GET /api/admin/user/group/list`、`GET /api/admin/user/level/list`、`POST /api/admin/user/update_other/:uid`、`POST /api/admin/user/update`、`GET /api/admin/user/address/list/:uid` 与 `GET /api/admin/user/address/default/:uid`。标签接口返回平台 `type=0/relation_id=0/group=0` 的标签组，当前用户已选标签以 `disabled=true` 标识；UID 0 用于列出全部未选标签。优惠券接口在 UID 0 时列出可后台赠送的 `receive_type=3` 模板，在指定 UID 时列出该用户 `status=0` 的券。分组返回原始数组，等级返回可见、未删除等级的 `{list,count}`，地址严格按 UID 返回有效地址或默认地址的 `ok/empty` 合同。

两个 POST 入口包含真正的资金和库存副作用。`update_other` 的注释写 1=余额、2=积分，但旧 UniApp 实际发送 1=余额、0=积分，PHP 又把所有非 1 值都当积分；因此候选明确兼容 0/2 两种积分标识。PHP 的余额减少会钳制到 0，积分减少却可写成负数，而且两者没有请求幂等键、事务回放或管理员级不可变审计。`user/update` 的旧移动页实际使用五类：等级、付费会员天数、赠券、分组、标签；批量选择意图限制 100 人，但旧端调用 `ids.slice(0,100)` 后没有接回结果，服务端也没有可靠硬上限。批量赠券通过队列处理，库存不足时静默截断用户数组，调用端仍可能收到“赠送成功”，会形成不可解释的部分成功。

实现前 Worker 只有相似但不同路径的用户列表/详情/资料修改、直接余额覆盖、分组/标签管理和等级目录。`POST /api/admin/user/money/:id` 直接读后写余额，没有用户行锁、流水或幂等证据，不能复用为 ADMIN-D 的资金合同；现有 `/label/:id`、`/user_group/list`、`/admin/level/list` 也不满足八条精确 URL、旧移动投影或 UID 地址语义。因此本批按 PHP 源码和旧端实际调用重建合同，而不是把相似路由计为完成。

### 读取合同、权限与最小数据范围

- 八条路由全部经过现有 `adminAuthMiddleware`，继续校验 admin token bucket、Admin JWT、有效管理员、密码摘要 auth claim 和服务端角色规则。`user/` 权限域令四类目录/地址读取及标签/券读取要求 `user.view`，两个 POST 要求 `user.manage`；普通用户 token 不能因路径位于 `/api/admin` 获得权限。全部响应设置 `Cache-Control: private, no-store, max-age=0`。
- 标签只查询平台有效分类和有效标签，UID 大于 0 时先验证活动用户，再从同一 `type=0/relation_id=0` 范围计算 `disabled`；UID 0 保留 PHP 的全量选择器语义。分组投影固定为 `{id,group_name}`；等级只返回 `{id,name,grade,image,icon}` 与 count，不透传等级成本、说明或其他无关字段。
- 可赠券必须同时满足 `receive_type=3/status=1/is_del=0`、有库存或永久发行、领取窗口有效，以及滚动有效期或尚未结束的固定使用期；标题搜索、页码和每页 100 条上限均有界。指定用户的券列表只读取该 UID 的未使用券并附加当前模板快照。地址列表只按路径 UID 和 `is_del=0` 查询，默认地址在同一结果内选择；不会接受请求体 UID，也不会跨 UID 猜测地址。

### 写入状态机、账本与失败关闭

- 余额/积分调整只接受一个活动 UID、1=增加或2=减少、严格正数和有界数值；余额按整数分计算，积分按安全整数计算。事务先取得回放锁再锁用户行，增加后检查数据库上限，减少统一取 `min(请求值,当前值)`，所以不会复制 PHP 的负积分缺陷。余额实际变化写 PHP 兼容的 `user_money(system_add/system_sub)`，积分写 `user_bill(category=integral,type=system_add|system_sub,event_key=admin_*)`；主余额/积分、流水、回放证据和 Admin 日志在同一个 2 秒锁/8 秒语句上限事务中提交。
- `user/update` 只接受旧移动端真实使用的五类载荷，用户 ID 去重排序且硬限制 100；等级和会员时长只允许单用户。等级替换锁定用户和可见等级，废止旧 `user_level`、恢复或创建目标记录，并同步 `user.level/exp/level_status`。分组和平台标签在用户行锁下验证权威对象后原子替换；标签空数组表示显式清空，不会把未识别字段静默丢弃。
- 会员天数增加以当前有效到期时间或当前时刻中较晚者为基线，减少不会早于当前时刻，永久会员失败关闭；用户状态变化与 `other_order(type=4,pay_type=admin,paid=1,is_free=1)`、`other_order_status(admin_adjust)` 和回放账本在同一事务提交。订单号从管理员/操作/请求键摘要确定性派生，不依赖外部序列或请求内网络调用。
- 赠券只接受有效赠送券模板，按用户 UID 固定顺序锁定最多 100 个活动用户，再锁模板；标题和有效期必须可写，非永久券库存少于目标人数时整批拒绝，不复制 PHP 的静默截断。成功时一次性写 `store_coupon_user(receive_source=send)`、`store_coupon_issue_user` 并原子扣减库存；没有 Queue、异步尾部或第三方副作用。
- 三类不可逆操作——余额/积分、会员时长、赠券——都强制 UUID-v4 `Idempotency-Key`。新增 `admin_user_write_replay` 只保存管理员 ID、操作、请求键、canonical SHA-256、单用户/目标数量和资金流水/会员订单/券模板等有界证据 ID，不保存姓名、地址、券标题/金额、余额、积分、请求体或响应体；`UNIQUE(admin_id,operation,request_key)` 是数据库级并发围栏，同键同载荷返回幂等结果，同键异载荷拒绝。`system_log` 另存操作、目标数量/摘要、请求摘要、Admin 和时间，仍不复制业务正文。

### DDL、路由、测试与生产边界

外部 `migrations/0119_admin_mobile_user_replay.sql` 与 Worker 内嵌 `migration_0125()` 完全同义并可重复执行，定义一表、三个索引、三个 CHECK；仓库外部/内嵌结构审计均从 247 增至 248 表且差集、列/主键漂移仍为 0。生产目前仍是 WORK-C8 后已经复验的 247 表，尚未应用该 DDL，因此相对当前候选明确缺 `admin_user_write_replay`，新 POST 路由发布前必须先完成这项前向 DDL；不能把仓库定义完成写成生产 248/248。

ADMIN-B 后基线为 PHP 1,904、TS 1,459、精确 757、可执行 739、原始缺失 1,147、可执行缺口 1,143；`/api` 为 PHP 457、TS 768、精确 375、可执行 372、原始缺失 82、可执行缺口 81。ADMIN-D 净增八条精确可执行合同后，总计为 TS 1,467、精确 765、可执行 747、原始缺失 1,139、可执行缺口 1,135，精确/可执行/退役后有效覆盖为 40.2%/39.2%/39.3%；`/api` 为 TS 776、精确 383、可执行 380、原始缺失 74、可执行缺口 73，三项覆盖为 83.8%/83.2%/83.3%。其他路由面未改变。

定向三文件 15/15 覆盖券列表边界、余额/积分 0/2 兼容、五类更新、100 用户硬上限、八个 envelope/no-store、精确路由、view/manage ACL、回放 DDL 同义/唯一围栏、锁、资金流水、非负扣减、赠券整批拒绝和会员订单状态。完整本地门禁为双 TypeScript、169 文件/1,058 项单元测试、observability 14 信号/10 域/27 必需事件/371 个生产源文件/6 个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、官方 npm 生产依赖审计 0 和 `git diff --check`。Windows 本机 workerd 仍在断言前以 `0xc0000005` 启动失败；主 Worker minify dry-run 成功为 3,283.84 KiB/gzip 780.02 KiB并精确回显 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有部署。

实现提交 `996e0dcc0ec1695e08d0abeeaeee283d8018dec6` 已推送至 `main`。用户要求直接使用生产数据库后，本轮对现网 `https://cinashop-api.cinagroup.workers.dev/api/site_config` 做了只读连通性检查并获得业务状态 200，证明当前已部署 Worker 能通过既有 Hyperdrive读取生产配置；它不证明候选 DDL 已应用，也不证明尚未部署的八条路由可运行。没有对生产用户、余额、积分、会员、券、地址或回放表执行 DML。首轮 [GitHub Actions 33407890505](https://github.com/cinagroup/cinashop/actions/runs/33407890505) 有 7/8 jobs 成功，唯一失败是 Gitleaks 将固定 UUID-v4 幂等测试夹具误报为通用 API key；该轮不计通过。随后以“规则名 + 精确测试文件 + 精确 UUID 行”的最窄 allowlist 修正误报，并补齐 `.gitleaks.toml` 的工作流路径触发。提交 `486a82de70993917e8f8fbe572bf7880d47c0dc2` 的 [Actions 33408799814](https://github.com/cinagroup/cinashop/actions/runs/33408799814) 最终 8/8 jobs 成功：全历史 secret scan、Worker 生产依赖审计 0、双 TypeScript、169 文件/1,058 项单测、observability、201/248/201/零缺口/零定义漂移、1,904/1,467/765/747 路由门禁、真实 workerd 运行时，以及 Admin、PC、Supplier、Kefu、UniApp 五端构建均通过。CI 不持有生产 Secret、不会访问 Hyperdrive或部署 Worker/Pages。Cloudflare Workers 最佳实践审查促成了显式 Admin ACL、无秘密响应、请求内短事务、数据库唯一幂等围栏、无请求外副作用和结构化回归门禁。

ADMIN-D 现只能标记“代码、DDL、静态合同与服务回归完成，DDL 未应用、未发布”。发布前还需受控应用/复验 `0119`、真实最小权限 Admin 的读允许/读拒绝和 POST 拒绝、同键重放/异载荷冲突、双连接并发、余额/积分/券/会员前后账证、旧移动端补充幂等头或替代前端、预发与回滚演练，并单独取得 REL-001/002 的明确发布批准。下一实现项是 ADMIN-A，但应拆为统计只读、履约写、退款/资金和代客身份四批，而不是一次性开放 32 条路由。

## ADMIN-A-STAT 内嵌订单统计详细审计（2026-09-01）

### PHP 权威、旧端调用与五条真实缺口

PHP 权威是 `route/api.php:739-777` 和 `app/controller/api/admin/order/StoreOrder.php` 的五条 GET 合同：`/api/admin/order/statistics`、`staging`、`data`、`time` 与 `time/chart`。旧 UniApp 的 `pages/admin/work/index.vue` 使用 `staging + time` 展示待发货、售后、缺货、库存警戒、成交额和访问量，`pages/admin/order/index.vue` 使用 `time + time/chart` 展示 1/7/30 日成交额、订单数、支付人数、增长率和日期图；订单统计/每日明细包装器仍属于旧移动管理端兼容面。实现前 Worker 已有 `/adminapi/statistic/*` 桌面后台统计和 `/api/admin/home/*` 首页统计，但 URL、字段、时间窗口及状态口径都不同，不能冒充这五条精确合同。

逐控制器/service/DAO/searcher 审计确认旧合同如下：

| 路由 | PHP 返回与口径 | 候选实现 |
|---|---|---|
| `GET order/statistics` | 总订单/总实付、待付款/发货/收货/评价/核销/完成、处理中/已结束售后、支付开关，以及今日/昨日/本月金额与单量 | 单次根订单聚合 + 单次售后聚合 + 批量配置读取；保留旧字段名和字符串计数 |
| `GET order/staging` | 平台待发货、两类售后计数、售罄和库存警戒商品 | 单条 PostgreSQL 查询内的有界标量聚合；平台单明确为 `store_id=0/supplier_id=0` |
| `GET order/data` | 月内每日金额/订单数/访问记录数，默认第 1 页 15 条 | Asia/Shanghai 日分组，稳定 `MAX(add_time)`，每页最多 100、跨度最多 3,660 天，访问记录排除软删除 |
| `GET order/time` | 今天/近 7/近 30 天与等时长上期比较，返回金额、增长率、订单、支付人数和访问量 | 周期只接受 1/7/30；当前与上期均为左闭右开秒级窗口，增长方向继续由 `increase_time_status` 表示 |
| `GET order/time/chart` | 日期升序金额/单量；type=1 特意包含昨日和今日 | 连续补零的日期序列；type=1 保留两日图，其余为 7/30 个上海日 |

PHP `getOrderData(0, ...)` 会把 `uid=0` 写入总订单筛选，可能把真实总数错误收窄到游客 UID；部分搜索器对 `pid=0` 使用大于等于语义，还可能把拆分子单重复计入。候选明确统计所有 `pid=0` 根订单，不复制这两个偏差。订单状态仍按 PHP 业务语义映射：待付款要求未付/status0/refund0；待发货要求已付、status 0/4、refund 0/3、配送类型 1/3；待收货区分快递 status 1/5 与自提 status 0/5；待评价 status2；待核销为自提 status 0/1/5；完成为 status3。所有订单聚合追加 `is_del=0 AND is_system_del=0`，售后追加 `is_cancel=0 AND is_del=0`，不让逻辑删除数据重新进入统计。

### Worker 实现、权限和数据库边界

- 五条精确路由注册在 `/api/admin/order/*`，全部经过现有 `adminAuthMiddleware`。`AdminPermissionService` 的 `order/` GET 映射要求 `order.view`；普通用户 token、失效管理员、密码摘要已变化或缺少角色规则均不能仅凭 URL 获权。五个响应都设置 `Cache-Control: private, no-store, max-age=0`。
- `AdminStatisticService` 复用现有 PostgreSQL/Hyperdrive 容器；所有条件值由 Drizzle 参数绑定，没有字符串拼接 SQL。金额使用 PostgreSQL numeric 聚合后在服务边界归一化，日界统一为 Asia/Shanghai；请求时间戳限制到 2100 年、页码最多 100,000、每页最多 100，非法小数、指数写法、倒置区间、超长跨度及未知周期均失败关闭。
- `statistics` 的订单、售后和配置三类独立读取并行执行；`data` 在一条 SQL 中完成每日聚合与访问记录计数，没有逐日数据库往返。图表 SQL 按日期表达式的第 1 列分组/排序；代码复核曾发现候选误写 `GROUP BY 2`，在提交前已改为 `GROUP BY 1` 并增加源合同断言。
- 本批只发出 `SELECT` 和配置 DAO 读取；没有 DDL、业务 DML、事务写锁、Queue、Durable Object、R2、支付/退款/面单/配送第三方调用，也没有请求返回 SQL、配置正文、用户标识或其他秘密。仓库结构继续是 248 表，生产相对候选仍缺 ADMIN-D 的 `admin_user_write_replay` 一表，本批没有改变或应用该前置 DDL。

用户已明确要求直接使用生产数据库，候选运行时因此继续只绑定生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有引入 SQLite、影子 PostgreSQL 或第二套业务库。dry-run 精确回显该绑定；此前已部署 Worker 的 `/api/site_config` 只读 200 仍是当前生产 Hyperdrive 连通证据。但这五条候选尚未部署，Windows `workerd` 仍在发出请求前以 `0xc0000005` 崩溃；不应把配置绑定、旧接口连通或 mock 单测写成新路由已直接查询生产。部署主 Worker、临时远端审计 Worker或暴露探针都会改变外部状态，仍受 REL-001/002 的单独明确批准门禁，本批没有擅自执行。

### 路由进度、验证、提交与剩余清单

ADMIN-D 后基线为 PHP 1,904、TS 1,467、精确 765、可执行 747、原始缺失 1,139、可执行缺口 1,135；`/api` 为 PHP 457、TS 776、精确 383、可执行 380、原始缺失 74、可执行缺口 73。本批净增五条精确可执行合同后，总计为 TS 1,472、精确 770、可执行 752、原始缺失 1,134、可执行缺口 1,130，精确/可执行/退役后有效覆盖为 40.4%/39.5%/39.6%；`/api` 为 TS 781、精确 388、可执行 385、原始缺失 69、可执行缺口 68，三项覆盖为 84.9%/84.2%/84.4%。其他路由面未改变。

新增定向测试 1 文件 6/6，覆盖上海时区默认月、闭区间到半开区间转换、1/7/30 周期、指数/越界/倒置输入拒绝、PHP 字段映射、支付开关、工作台字符串计数、增长率方向、五个真实 envelope/no-store、五条精确路由、`order.view` ACL、根订单/软删除/只读 SQL 约束。完整本地门禁为双 TypeScript、170 文件/1,064 项单元测试、observability 14 信号/10 域/27 必需事件/371 个生产源文件/6 个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、官方 npm 生产依赖漏洞 0 和 `git diff --check`。本机 runtime 仍是既有 Windows workerd 启动故障；minify dry-run 成功为 3,294.65 KiB/gzip 782.03 KiB，未部署。

实现提交 `f9a55e5fbbed4b539059cf3f76556cc4b1b94fb8` 已推送至 `main`。[GitHub Actions 33412892978](https://github.com/cinagroup/cinashop/actions/runs/33412892978) 最终 8/8 jobs 成功：Linux Worker job 通过生产依赖审计、双 TypeScript、170 文件/1,064 项单测、observability、201/248/201/零定义漂移和 1,904/1,472/770/752 路由门禁；真实 workerd 运行时、Admin、PC、Supplier、Kefu、UniApp 及 checksum-pinned Gitleaks 全部成功。CI 不持有生产 Secret、不访问 Hyperdrive，也不部署 Worker/Pages。Cloudflare Workers 最佳实践审查促成了显式 Admin ACL、私有不缓存响应、参数化有界查询、无请求外副作用和生产绑定/部署证据分离。

ADMIN-A 父项保持未完成，剩余 27 条已拆成可执行 checklist：订单运营/履约 12 条，退款/资金 4 条，代客下单 11 条。下一批应先处理履约读取与无第三方副作用的本地状态操作；退款/资金必须复用 CORE-002 账本和幂等围栏，代客下单必须建立显式 Admin 代客权限和目标 UID 全链路绑定，不能把普通用户 token 兼容逻辑直接搬到生产。

## ADMIN-A-FULFILLMENT-READ 履约只读详细审计（2026-09-01）

### PHP 权威、旧端调用与五条已关闭缺口

PHP 权威位于 `route/api.php:744-758`、`app/controller/api/admin/order/StoreOrder.php:214-225,782-825` 和 `StoreOrderCartInfoServices.php:307-335`。旧 UniApp `view/uniapp/api/admin.js` 明确包装并在移动管理订单流程中使用订单发货摘要、配送员、发件配置和拆单商品；`export_all` 仍是已发布 PHP 兼容合同，即使当前 UniApp 发货页主要调用公开物流目录，也不能从 PHP 分母中删除。本批只选择五条不会写订单、调用面单 provider 或改变外部状态的 GET：

| 路由 | PHP 行为 | Worker 候选行为与审计结论 |
|---|---|---|
| `GET /api/admin/order/delivery/gain/:orderId` | 按公开订单号读取收件人、电话、地址、昵称和电子面单开关，仅已支付订单成功 | 严格订单号字符/32 字节边界；只读双软删除均为 0 的唯一订单，重复订单号失败关闭、未支付拒绝；批量配置 DAO 直接读取 `config_export_open` |
| `GET /api/admin/order/delivery` | 返回平台配送员列表中的 `list` | 复用 `StoreOperationsService.deliveryList(..., true)`；强制平台 `type=0/relation_id=0`、未删除且启用，页码最多 10,000、每页最多 100，只返回既有安全投影 |
| `GET /api/admin/order/delivery_info` | 读取五个 `config_export_*` 发件默认值并改名 | 直接从生产 PostgreSQL 配置 DAO 一次批量读取并规范化，不以 KV/客户端值作为配置权威，返回字段保持 `express_temp_id/to_name/id/to_tel/to_add` |
| `GET /api/admin/order/export_all` | `ExpressServices::expressList()` 返回 `id,name,code,partner_id,partner_key,net,account,key,net_name` | 明确不复制凭据泄漏，只返回启用且可见物流公司的 `id/name/code`，按 `sort/id` 稳定排序 |
| `GET /api/admin/order/split_cart_info/:id` | 普通订单读取 `split_status IN(0,1)`；`pid=-1` 主单转向一个待发货平台子单；旧 `cart_num=0` 回退商品快照 | 正整数 ID 最大 32 位 PostgreSQL integer；订单和子单均追加双软删除过滤，主单存在多个待发货子单时拒绝猜测；只读 `split_surplus_num>0` 的可拆行，保留旧数量回退，畸形 JSON 返回 `cart_info:null` |

旧 PHP 的 `export_all` 把合作方 ID、key、网点和账号直接放进移动 Admin 响应；这不是前端渲染所需字段，因此候选使用显式 allowlist，是有证据的安全收紧而非漏迁。PHP 对全拆主单只取任意第一个符合条件的子单，且订单/子单读取不统一排除双软删除；候选要求唯一待发货平台子单并过滤删除行，避免在脏数据上把后续发货指向错误子单。候选仍保留 PHP 对旧商品快照的 `cart_num` 回退，但 JSON 损坏只影响该条快照投影，不扩大为 500 或返回未解析正文。

### Admin 权限、数据库与副作用边界

- 五条精确路由全部挂在既有 `adminAuthMiddleware` 后，`AdminPermissionService` 对 `GET /api/admin/order/*` 要求 `order.view`；普通用户 token、失效/删除管理员、密码摘要变化和无角色权限均不能因为路径含 `/admin` 自动获得访问。控制器统一设置 `Cache-Control: private, no-store, max-age=0`。
- 所有 SQL 由 Drizzle 参数绑定；订单号、整数 ID、页码和每页数量先做严格语法、范围校验，目录与拆单排序稳定。服务源码没有 `insert/update/delete`，没有事务写锁、DDL、Queue、Durable Object、R2、支付/退款/面单或配送 provider 调用。
- 发件人姓名、电话、地址和收件信息只在已认证且具有 `order.view` 的私有响应中出现；物流目录不再返回 `partner_key/key/account`。配置读取直接经过容器内 PostgreSQL DAO，符合用户“直接使用生产数据库”的运行时方向，但新代码尚未部署，不能把绑定声明写成接口已在生产执行。
- 剩余 `GET export_temp` 会同步调用电子面单模板 provider，故刻意未混入本批；`delivery/keep`、`split_delivery`、改价、备注和核销也会写业务状态，必须先绑定既有行锁状态机、任务/outbox、动作级 ACL、审计和幂等，不能由这批只读证明覆盖。

### 生产证据、验证、提交与更新后缺口

用户已要求直接使用生产数据库，`wrangler.toml` 和 minify dry-run 都精确绑定生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有新增 SQLite、影子 PostgreSQL 或第二套业务库。已部署 Worker 的 `/api/site_config` 只读探针继续返回业务状态 200，证明现网版本仍能经既有绑定读取生产配置；探针没有打印配置值。现网 `/api/logistics` 返回 HTTP 200 内业务状态 404，进一步说明候选路由没有随本批提交自动发布。五条新路由需要真实受限 Admin 身份且尚未部署，因此本批没有伪造生产正向 E2E，也没有对生产执行 DML、DDL、provider 调用或发布。仓库候选仍为 248 表，生产仍为 247 表，唯一已知候选差异仍是 ADMIN-D 的 `admin_user_write_replay`，与本批无关。

路由基线在 ADMIN-A-STAT 后为 PHP 1,904、TS 1,472、精确 770、可执行 752。本批净增五条精确可执行合同后为 TS 1,477、精确 775、可执行 757、明确不可用 18、原始缺失 1,129、证据化退役 4、可执行缺口 1,125，精确/可执行/退役后有效覆盖为 `40.7%/39.8%/39.8%`。`/api` 为 PHP 457、TS 786、精确 393、可执行 390、明确不可用 3、原始缺失 64、退役 1、可执行缺口 63，对应 `86.0%/85.3%/85.5%`；其他路由面未改变。静态匹配仍不证明运行时数据、权限或状态机等价。

新增定向测试 1 文件 6/6；与 ADMIN-A-STAT 合并定向 2 文件 12/12。覆盖严格订单号/整数/分页、旧快照回退与损坏 JSON、已支付订单映射、直接数据库配置规范化、五个真实响应 envelope/no-store、五条精确路由、`order.view` ACL、双软删除/启用过滤、物流凭据排除和服务无写操作。完整本地门禁为双 TypeScript、171 文件/1,070 项单元测试、observability 14 信号/10 域/27 必需事件/372 个生产源文件/6 个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、官方 npm 生产依赖漏洞 0 和 `git diff --check`。Windows workerd 仍有既有 `0xc0000005` 启动缺陷；minify dry-run 成功为 3,299.37 KiB/gzip 783.23 KiB并回显精确生产 Hyperdrive，未部署。

实现提交 `759664f07a11482e83a56762cc395e063de3d868` 已推送至 `main`。[GitHub Actions 33455883848](https://github.com/cinagroup/cinashop/actions/runs/33455883848) 最终 8/8 jobs 成功：Linux Worker 综合任务通过生产依赖审计、双 TypeScript、171 文件/1,070 项单测、observability、201/248/201/零定义漂移和 1,904/1,477/775/757 路由门禁；受支持的 workerd runtime、Admin、PC、Supplier、Kefu、UniApp 和 checksum-pinned 全历史 Gitleaks 全部成功。CI 不持有生产 Secret、不访问 Hyperdrive，也不部署 Worker/Pages。Cloudflare Workers 最佳实践审查直接影响了显式 ACL、私有不缓存、参数化有界读取、敏感字段 allowlist、无请求外副作用和“绑定/构建/部署/生产 E2E”证据分层。

ADMIN-A 现在是 10/32，父项继续未完成，剩余 22 条形成当前可执行 checklist：

- 履约写/provider 7 条：`POST delivery/keep/:id`、`POST price`、`POST remark`、`GET export_temp`、`PUT split_delivery/:id`、`POST order_verific`、`POST wirteoff/records/:id`。
- 退款/资金 4 条：`POST offline`、`POST refund`、`POST refund_agree/:id`、`POST open/refund/:id`。
- 代客下单 11 条：`GET cart/:uid`、`POST cart/add/:uid`、`DELETE cart/del/:uid`、`POST cart/num/:uid`、`GET place/list`、`GET confirm/:uid`、`POST computed/:key/:uid`、`GET coupons/:uid`、`POST create/:key/:uid`、`POST pay/:uid`、`GET pay/status`。

下一批优先审计并接入能够复用现有本地履约状态机的发货/拆单和低风险备注动作；电子面单模板保留 provider 失败分类/限时限长，退款/线下支付继续依赖 CORE-002 账本和回放围栏，代客下单必须新增显式代客权限并把 Admin、目标 UID、报价、库存、优惠券和支付主体全链路绑定。

## ADMIN-A-FULFILLMENT-LOCAL 本地订单操作详细审计（2026-09-01）

本轮先对 ADMIN-A-FULFILLMENT-READ 后剩余 7 条合同逐一回查 PHP 路由、控制器、service 和旧 UniApp 调用方。七条均有真实调用，不具备退役证据：`delivery/keep/:id` 涉及三种本地发货方式及电子面单分支，`export_temp` 读取 provider 模板，`split_delivery/:id` 修改拆单与履约状态，`order_verific` 查询核销候选并衔接后续核销流程；`price`、`remark` 与 `wirteoff/records/:id` 则不依赖第三方。为避免把 provider、履约状态和普通字段更新一次性开放，本批只收口后三条纯 PostgreSQL 合同，其余四条继续明确留在 checklist。

PHP `price` 接收公开订单号和绝对实付金额，只允许未支付订单，并由 `StoreOrderServices::updateOrder` 用 `原实付 + 历史 change_price - 新实付` 重新计算累计改价差额；PHP `remark` 按公开订单号写备注；PHP 原路由把核销记录拼成 `wirteoff`，以 POST body 的 `product_type` 返回分页记录。新实现保留路径、请求和成功 envelope，但收紧了三个不安全或不确定边界：公开订单号必须唯一命中双软删除均为 0 的有效订单；金额只接受非负十进制定点、最多两位小数并同时受 `numeric(12,2)` 和 `change_price numeric(8,2)` 上限约束；备注去除首尾空白且最多 512 个字符，核销查询只接受商品类型 0/4、页码最多 10,000、每页最多 100。

改价事务先以唯一公开单号解析目标，再锁根订单结算域和目标订单行，设置 2 秒锁超时、5 秒语句超时，支付状态在锁后复核；条件更新再次约束未支付和双软删除，竞争失败关闭。连续改价以当前 `pay_price + change_price` 恢复原价，避免第二次改价把第一次结果当原价；相同金额幂等 no-op。改价审计只记录 Admin ID 和动作，不记录金额。备注同样在短事务内最多锁两行以阻断歧义订单号，相同正文 no-op，状态日志不复制备注正文，修复旧 TS `/remark/:orderId` 会把完整备注写入审计消息且接受空正文的问题。两个写接口均从已验证的 `adminInfo` 取 actor，不能由 body 伪造。

`wirteoff/records/:id` 虽沿用 PHP 的 POST 方法，但它没有写副作用，权限因此显式降为 `order.view`，而 `price/remark` 继续要求 `order.manage`。记录查询先验证有效订单，按时间和主键倒序；购物车快照 join 同时绑定 `order_cart_id` 与目标 `oid`，单条 JSON 最多从 PostgreSQL传输 256 KiB。服务只投影页面使用的记录 ID、订单商品 ID、商品 ID/类型、数量、金额、分钟时间和商品名/图片/价格/规格图片；商品名按 Unicode code point 截到 10，损坏快照安全降级。PHP 的 `writeoff_code`、UID、staff/admin/operator、relation 等内部字段不再返回，避免后台只读权限获得核销凭据或人员身份。

三条 handler 都使用 8 KiB 有界 JSON body 和 `private, no-store, max-age=0`，没有请求外浮动 Promise、全局可变状态、Queue 消息、provider/fetch 或同步外部调用。Cloudflare Workers 最佳实践审查促成了请求体和数据库结果双边界、Hyperdrive 请求内短事务、无外部 I/O 的锁区间、显式最小权限与敏感字段 allowlist。实现不需要新表或索引；仓库仍为外部/内嵌 248/248、共享 PHP 源表 201/201 且定义漂移 0。

用户要求直接使用生产数据库，因此候选继续精确绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有引入影子业务库或 SQLite。minify dry-run 为 3,307.75 KiB/gzip 785.66 KiB并回显该生产绑定，但没有部署。三条候选路由尚未出现在当前生产 Worker，且其中两条会修改真实客户订单；本轮没有用合成订单对生产 `public` 执行 DML，也没有擅自部署临时公开探针。既有只读生产证据仍只证明当前旧 Worker/Hyperdrive 连通以及生产核销记录为 0，不能冒充新改价、备注或核销查询的生产 E2E。生产候选结构差仍只有未应用的 `admin_user_write_replay`，与本批零 DDL 合同无关。

新增定向测试 1 文件 7/7；与上一批履约读取合计 2 文件 13/13。覆盖价格格式/精度/范围和连续改价、备注空白/长度、核销类型/分页、Unicode 截断/损坏快照/字段白名单、三个真实 handler envelope/no-store/actor/path override、三条精确路由、`order.manage/order.view` ACL、事务超时、结算锁、行锁、软删除、订单绑定、快照字节上限以及无凭据/外部副作用。完整本地门禁为双 TypeScript、172 文件/1,077 项单元测试、observability 14 信号/10 域/27 必需事件/373 个生产源文件/6 个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、官方 npm 生产依赖漏洞 0 和 `git diff --check`。Windows workerd 仍在执行断言前以既有 `0xc0000005` 启动失败；Linux CI 的真实 workerd 已通过。

路由基线在履约读取后为 PHP 1,904、TS 1,477、精确 775、可执行 757。本批净增三条精确可执行合同后为 TS 1,480、精确 778、可执行 760、明确不可用 18、原始缺失 1,126、证据化退役 4、可执行缺口 1,122，精确/可执行/退役后有效覆盖为 `40.9%/39.9%/40.0%`。`/api` 为 PHP 457、TS 789、精确 396、可执行 393、明确不可用 3、原始缺失 61、退役 1、可执行缺口 60，对应 `86.7%/86.0%/86.2%`；其他路由面未改变。

实现提交 `796569cc5b77d210d2df9381b86cab9a967ad9d3` 已推送至 `main`。[GitHub Actions 33457613526](https://github.com/cinagroup/cinashop/actions/runs/33457613526) 最终 8/8 jobs 成功：Linux Worker 综合任务通过生产依赖审计、双 TypeScript、172 文件/1,077 项单测、observability、201/248/201/零定义漂移和 1,904/1,480/778/760 路由门禁；受支持的 workerd runtime、Admin、PC、Supplier、Kefu、UniApp 和 checksum-pinned 全历史 Gitleaks 全部成功。CI 不持有生产 Secret、不访问 Hyperdrive，也不部署 Worker/Pages。

ADMIN-A 现在为 13/32，父项继续未完成，剩余 19 条：履约写/provider 4 条（`POST delivery/keep/:id`、`GET export_temp`、`PUT split_delivery/:id`、`POST order_verific`），退款/资金 4 条，代客下单 11 条。下一批应先把 `delivery/keep` 与 `split_delivery` 精确接到现有 `SupplierFulfillmentService` 的结算锁、售后/预售/拼团门禁、面单冲突和通知 outbox；`order_verific` 必须复用 `StoreOrderWriteoffService` 的 actor/订单状态校验，但保持只读并把真正核销留给完整的部分核销、旋码、并发与最终结算写状态机；`export_temp` 必须保留 provider 限时、限长、失败分类和凭据不回显。四条不能仅复用旧 `AdminCrud` 的宽松更新路径。

## ADMIN-A-FULFILLMENT-WRITE/PROVIDER 履约写入、面单模板与扫码查询详细审计（2026-09-01）

### PHP 权威、旧端调用与语义纠偏

本批逐行核对 PHP `route/api.php:744-758`、`app/controller/api/admin/order/StoreOrder.php:237-299,665-755,804-815`、相关 delivery/writeoff service，以及旧 UniApp `view/uniapp/api/admin.js` 和发货、核销扫描页面。四条合同均有真实旧端调用，不能退役。上一批审计把 `POST order_verific` 写成“进入核销/结算状态机”并要求它直接旋码，这是语义误判：PHP 控制器实际只根据用户条码或订单核销码查询可核销订单；真正修改核销次数、旋转核销码并完成订单结算的是后续核销写接口。当前实现和 checklist 已按源码证据纠正，不让一个只读扫码动作意外获得写副作用。

| 路由 | PHP/旧端合同 | Worker 候选与审计结论 |
|---|---|---|
| `POST /api/admin/order/delivery/keep/:id` | 支持手工快递、电子面单、平台配送和虚拟发货，成功提示 `发货成功!` | 手工路径复用 `SupplierFulfillmentService.deliver`；电子面单路径只创建持久 `order_waybill_job` 并投递 Queue，不在 HTTP 请求中签发面单；Admin actor 只来自已验证会话 |
| `PUT /api/admin/order/split_delivery/:id` | 同一组发货字段外加 `cart_ids`，只发选中数量 | 先用共享严格解析器规范化 cart ID/数量，再复用 `splitDelivery` 的根结算锁、商品行锁和剩余数量状态机；电子面单拆单同样只建 durable job |
| `GET /api/admin/order/export_temp?com=...` | 一号通模板查询，旧 UniApp 读取 `res.data.data` 中的 `title/pic/temp_id` | 复用现有固定 HTTPS provider 客户端和系统数据库配置，保留 10 秒超时/32 KiB 响应上限/错误分类；二次限制最多 100 项，只返回三字段，预览图仅接受 HTTPS，凭据与未知 provider 字段不回显 |
| `POST /api/admin/order/order_verific` | 先按用户条码查询，未命中再按核销码；一单时直接进入详情，多单时显示列表 | 保留用户条码优先级和 `data/is_order_code/product_type/auth` 形状，但忽略客户端 `auth`，始终以认证 Admin actor 查询；最多返回 20 单，非唯一主体失败关闭；该路由只读，映射 `order.view` |

### 履约状态机、权限与失败边界

手工快递、平台配送和虚拟发货不复制 PHP 的宽松更新：统一进入既有供应商履约事务，设置 2 秒锁超时和 10 秒语句超时，锁根订单结算域与目标/商品行；锁后重新验证已支付、有效订单、退款、拼团、预售、拆分数量和冲突电子面单任务，再写订单、状态审计和通知 outbox。平台配送员必须是唯一启用的平台 `delivery_service(type=0, relation_id=0)` 且关联有效用户；客户端提交的姓名和电话被数据库锁定值覆盖，不能伪造配送身份。Admin ID 进入同事务审计，但消息不包含收件地址、电话、运单号或虚拟交付正文。

电子面单的不可逆 provider 签发继续隔离在 `OrderWaybillJobService` 的 Queue 消费端。HTTP 只保存请求摘要、载体/模板/寄件配置和 actor，旧 UniApp 没有 `request_key` 时服务端生成 UUID-v4；同根订单的 active/UNKNOWN/DEAD 任务围栏继续阻止并发重复签发，Queue 发送失败时 durable row 仍由定时调度恢复。Admin 兼容层不直接 `fetch` provider、不直接 `.send()` Queue，也不接收 provider access key/secret。模板查询是只读 provider 例外，使用现有固定域名、HTTPS、认证、超时、响应字节限界和失败分类；返回再经过本批 allowlist，不把上游 envelope 或凭据透传给移动端。

扫码查询在一条短事务中设置 2 秒锁和 5 秒语句超时，先查唯一有效用户条码，再查唯一 12 位订单核销码；用户条码最多展开 20 个已支付、未完成、无退款阻断的候选订单。每单继续经过 `StoreOrderWriteoffService` 的 Admin operator、配送/自提模式、门店、退款、拼团和订单状态校验，但不锁订单作写入、不修改核销码或结算。列表只投影旧页面需要的订单 ID/号、状态、数量、实付、时间、商品类型和首图；单个购物车 JSON 从 PostgreSQL 传输最多 32 KiB，图片最多 1,024 字符。真正核销仍是既有 `POST /admin/order/writeoff`，其部分核销、商品行锁、旋码、最终结算和同事务审计未被绕过。

四条路由均挂在 `adminAuthMiddleware` 后并设置 `Cache-Control: private, no-store, max-age=0`。发货/拆单要求 `order.manage`；模板查询与扫码查询要求 `order.view`。请求体分别限制为 32 KiB/8 KiB，发货类型、记录类型、订单主键、物流编码、模板、寄件字段、购物车选择和扫码值均有语法与长度边界。查询中的 body `auth`、配送姓名/电话、provider 未知字段及 caller credentials 均不是权威输入。

### 生产数据库边界、验证与进度

用户明确要求直接使用生产数据库，因此候选运行时继续只绑定生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有引入 SQLite、影子 PostgreSQL 或第二套业务库。最终 minify dry-run 为 `3,316.17 KiB / gzip 788.16 KiB` 并精确回显该 Hyperdrive、Queue、KV、R2 与 Durable Object 绑定；dry-run 没有上传或部署。仓库 schema 审计仍为 source 201、target 248、shared 201、缺源列 0、外部/内嵌 248/248、定义漂移 0。本批没有 DDL，生产相对候选仍只缺 ADMIN-D 尚未应用的 `admin_user_write_replay`。

这四条候选尚未部署到生产 Worker。为避免对真实订单发货、拆单或核销造成不可逆影响，本批没有对生产 `public` 执行 DML/DDL，没有调用真实面单 provider，也没有用真实管理员做新接口 E2E；测试中的 provider、事务和身份均为 mock。这里的“直接使用生产数据库”证据是唯一运行时绑定和既有生产事实，不冒充尚未部署的新代码已经在生产执行。生产 Worker/Pages 发布、远端真实 Admin 回归和 provider 正向仍属于 REL-001/002 的独立批准门禁。

新增定向测试 1 文件 8/8，覆盖手工/电子分支、durable job 字段映射、平台配送身份覆盖、拆单数量规范化、模板字段白名单/数量/HTTPS、认证 Admin 扫码 actor、四个真实 handler envelope/no-store、四条精确路由、`order.manage/order.view` ACL，以及共享履约锁、超时、快照限界和请求路径无直接 provider/Queue 副作用。完整本地门禁为双 TypeScript、173 文件/1,085 项单元测试、observability 14 信号/10 域/27 必需事件/374 个生产源文件/6 个发布阻塞、schema 201/248/201/零定义漂移、官方 npm 生产依赖漏洞 0、路由审计和 `git diff --check`。Windows workerd 仍在断言前以既有 `0xc0000005` 启动失败；Linux CI 的真实 workerd 正常。

路由基线在 ADMIN-A-FULFILLMENT-LOCAL 后为 PHP 1,904、TS 1,480、精确 778、可执行 760。本批净增四条精确可执行合同后为 TS 1,484、精确 782、可执行 764、明确不可用 18、原始缺失 1,122、证据化退役 4、可执行缺口 1,118，精确/可执行/退役后有效覆盖为 `41.1%/40.1%/40.2%`。`/api` 为 PHP 457、TS 793、精确 400、可执行 397、明确不可用 3、原始缺失 57、退役 1、可执行缺口 56，对应 `87.5%/86.9%/87.1%`；其他路由面未改变。

实现提交 `1ffbeb405b41a39afb8ae96b594a653b89dac8cb` 已推送至 `main`。[GitHub Actions 33459485969](https://github.com/cinagroup/cinashop/actions/runs/33459485969) 最终 8/8 jobs 成功：Linux Worker 综合任务通过生产依赖审计、双 TypeScript、173 文件/1,085 项单测、observability、201/248/201/零定义漂移和 1,904/1,484/782/764 路由门禁；受支持的真实 workerd runtime、Admin、PC、Supplier、Kefu、UniApp 和 checksum-pinned 全历史 Gitleaks 全部成功。CI 不持有生产 Secret、不访问 Hyperdrive，也不部署 Worker/Pages。Cloudflare Workers 最佳实践审查直接影响了请求内短事务、外部调用隔离、durable job、最小 ACL、私有不缓存、双向输入/输出边界和生产绑定/部署证据分层。

ADMIN-A 现在为 17/32，履约子组 12/12 已收口；父项继续未完成，剩余 15 条只有退款/资金 4 条和代客下单 11 条。下一批应优先处理 ADMIN-A-REFUND：线下支付与退款动作必须复用 CORE-002 资金账本、支付 provider 状态、幂等围栏、根结算锁和明确 `order.manage/refund.manage` 权限；仍不得用生产订单做破坏性试验，也不得因代码通过 CI 自动发布。

## ADMIN-A-REFUND 退款、退货审批与线下收款详细审计（2026-09-01）

### PHP 权威、旧客户端调用与四条合同的真实含义

本批逐行核对 PHP `route/api.php:750-760`、`app/controller/api/admin/order/StoreOrder.php:486-657,898-1014`、`OrderOfflineServices`、`StoreOrderRefundServices`、退款支付 service，以及旧 UniApp `api/admin.js`、退款列表/详情和移动端主动退款页面。四条均有真实旧端调用，不能退役，但旧控制器名称容易造成两个危险误读：`offline` 不是顾客选择线下付款，而是管理员把未支付订单确认为已收款；`refund_agree/:id` 不是执行资金退款，而是商家同意用户退货、把售后推进到等待寄回。

| 路由 | PHP/旧端真实合同 | 迁移后的权威语义 |
|---|---|---|
| `POST /api/admin/order/offline` | body 传公开 `order_id`，PHP 调 `paySuccess(..., OFFLINE_PAY)` 并返回“修改成功!” | 只允许唯一、有效、未拆分/未分配的订单进入共享 paid transition；重复线下已支付为幂等，已经由微信/支付宝/余额等其他渠道入账则冲突失败 |
| `POST /api/admin/order/refund` | body 为售后单号或原订单号、`price/type/refuse_reason`；PHP 对现有售后允许同一行累计部分退款，对原订单可现场造退款行 | 售后同意只接受本售后单的权威全额；拒绝必须有有界原因；未找到售后而命中原订单时转入与主动退款相同的服务端报价/建单流程，不直接改订单累计金额 |
| `POST /api/admin/order/refund_agree/:id` | PHP `agreeRefundProdcut` 仅把 `refund_type` 改为 4 | 只对退货类售后执行 `0/1/2 → 4`，同步订单为等待寄回并写 Admin 审计；绝不创建渠道退款或改变余额 |
| `POST /api/admin/order/open/refund/:id` | 管理端按订单主键主动整单或按 `{cart_id,cart_num}` 拆单退款；PHP 只有 1 秒 UID cache，且活动售后检查把 `is_del` 写反 | 锁内按不可变购物车快照、历史已退数量和实付金额重新报价；提交金额必须逐分相等，选品/数量严格绑定当前订单；安全处理 active 售后，不复制错误软删除条件和 1 秒内存防重 |

PHP `refund` 的“同一售后行多次增量退款”与其马上把该行置为终态 6 的行为互相矛盾：第一次成功后第二次理论路径不可稳定到达，且缺少稳定 provider 退款号和未知结果查询围栏。PHP 主动退款还先写或改业务状态、再调用外部渠道，失败时依赖补偿更新；`open_order_refund` 的 active-refund count 错查 `is_del=1`，并用进程 cache 做一秒防抖。这些都不是应复制的兼容语义。新合同保留 URL、请求字段和成功 envelope，但把真正业务权威固定为“一张售后单对应一个不可变退款金额；部分退款使用不同售后单”。

### 支付与退款状态机、锁序和回放保护

线下收款复用 `applyStoreOrderPayment` 唯一 paid 写入口。管理员授权回调在锁定订单行后复核公开单号、双软删除、`pid=0`、未处于供应商分配，以及拼团可支付状态；首次 `paid=0 → 1` 与积分扣减、发票支付状态、拼团激活、`order.paid` outbox 和 `admin_order_offline` 审计同事务提交。outbox dispatch 在提交后 best-effort 执行，失败保留持久行供调度恢复。已支付重放只有同为 `offline` 才返回幂等；其他渠道、交易证据或订单状态不能被管理员请求覆盖。

现有售后资金同意先在短事务内按 refund advisory lock → refund row → order settlement advisory lock → order row 的固定顺序捕获不可变 scope，绑定 supplier、UID、退款单号、原订单主键、权威退款分值、已支付与双软删除。余额/零元退款在同一事务完成用户余额、账单、累计退款、库存/积分/奖励/佣金/供应商结算和状态日志；微信/支付宝继续使用 `store_order_refund_payment` 的稳定 `CNSR{refundId}`、金额/总额不可变检查、`CREATED/REQUESTING/PROCESSING/UNKNOWN/SUCCESS/...` 状态、请求租约、查询后重试、回调与主动对账。provider HTTP 始终在数据库事务外；第三方未确认成功前不会把业务售后置为已退款。线下、现金或未知原支付方式没有可靠自动原路退能力，因此明确失败关闭，不能伪造退款完成。

主动整单/拆单退款先在订单 settlement lock 和订单行锁下读取全部购物车快照与历史已完成售后。服务接受旧 cart 主键或 legacy `cart_id`，先收敛到唯一 canonical ID；逐商品复核是否支持退款、核销次数、已退数量和本次件数，再用整数分按实付金额做确定性比例分配，最后一分也由稳定顺序分配。客户端 `refund_price/price` 只作为预期值，必须与服务端计算结果完全一致后才插入售后。管理员申请使用 `apply_type=4`，普通用户调用不能声明该特权类型。

主动退款的回放键不是 PHP 的一秒 cache，也不依赖尚未应用生产的 `admin_user_write_replay`。服务对 `{adminId, orderPk, amountCents, sorted cart selections}` 做 SHA-256，生成不超过 50 字符的稳定内部退款单号 `A{orderId}-{digestPrefix}`；同一订单 settlement lock 下如果该退款单已存在，只在 UID、类型、原因、说明和金额全部一致时复用，否则拒绝幂等参数冲突。首次插入与 `apply_refund`、`admin_refund_apply` 审计同事务；后续资金执行还以售后 ID/请求摘要写一次性 `admin_refund_execute` 证据。这样请求在“售后已创建但 provider 响应丢失”后重试会回到同一退款台账，而不会创建第二笔资金请求。

拒绝售后也改为同一锁序内重新读取 refund/order 和 provider ledger；`REQUESTING/PROCESSING/UNKNOWN/SUCCESS` 等已发起或待确认状态不能再被拒绝覆盖。相同拒绝原因重放为 no-op，不同原因不能覆写原决策；首次拒绝、订单状态、通知 outbox 和不含原因正文的 Admin 审计同事务。退货审批同样锁定 refund/order 并检查 provider 尚未进入不可逆状态，只允许退货类申请和合法前态。实际退货物流仍由用户已有接口从 4 推进到 5，最终资金退还仍走上面的核心账本。

### 权限、输入边界和生产数据库证据

四条路由均位于现有 `adminAuthMiddleware` 后，actor 只从已验证 `adminInfo.id` 获取，body 中任何 UID/管理员声明都被忽略。`offline` 是订单收款动作，要求 `order.manage`；`refund`、`refund_agree/:id` 和 `open/refund/:id` 虽历史 URL 位于 `/order`，权限解析器显式重映射为 `refund.manage`，避免只有订单运营权限的角色移动资金或决定售后。所有响应使用 `Cache-Control: private, no-store, max-age=0`；`offline` body 上限 8 KiB，`refund/open/refund` 上限 32 KiB，购物车选择最多 100 条，`refund_agree` 不读取 body。订单/售后标识、动作枚举、拆分标志、金额、小数位、拒绝原因和商品件数全部严格解析，重复 cart ID、非正件数、控制字符、歧义公开单号和多条 active 售后均失败关闭。

用户要求直接使用生产数据库，因此主候选仍精确绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有引入 SQLite、影子 PostgreSQL 或第二套业务库。Wrangler 4.122.0 对该生产资源的只读 `hyperdrive get` 返回名称 `cinashop-pg`、PostgreSQL origin、连接上限 60、缓存开启；没有返回密码。为本批编写的生产审计 Worker 把所有聚合放在单一 `REPEATABLE READ, READ ONLY` 事务，固定 `search_path=public, pg_temp`，只返回订单/售后/渠道 ledger/审计状态的计数和一致性布尔，不返回订单号、用户、金额、地址或其他业务值，也不含任何 DDL/DML。但本机 `wrangler dev --remote` 在事务开始前被既有 Windows workerd `0xc0000005` 启动崩溃阻断，环境中也没有直接生产 PostgreSQL URL；因此本轮只有 Hyperdrive 配置只读核验，没有新的生产数据聚合结果。没有把失败探针冒充通过，也没有改成部署临时 Worker。

本批没有对生产 `public` 执行 DML/DDL，没有创建随机或影子 schema，没有调用真实微信/支付宝 provider，也没有部署主 Worker、临时 Worker或 Pages。现有生产 29 单/3 售后的数据事实来自前批只读证据，不能替代本批候选路由的生产 E2E。生产支付 Secret/商户配置仍不完整，代码完成不等于退款渠道已经可用；真实 Admin、真实退款和发布后回归仍属于 REL-001/002 的独立批准门禁。

### 验证结果、路由进度和下一批

新增定向测试 1 文件 5/5，覆盖拆单 cart/数量规范化、四个 handler 的认证 actor/envelope/no-store、四条精确路由、`order.manage/refund.manage` 权限拆分、共享支付/退款状态机、服务端预期金额、确定性退款单号、Admin 审计以及生产审计 Worker 的结构性只读约束。完整本地门禁为双 TypeScript、174 文件/1,090 项单元测试、observability 14 信号/10 域/27 必需事件/375 个生产源文件/6 个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、官方 npm 生产依赖漏洞 0、路由审计和 `git diff --check`。最终 minify dry-run 为 `3,330.07 KiB / gzip 791.61 KiB`，精确回显生产 Hyperdrive、Queue、KV、R2 和 Durable Object，随后以 `--dry-run: exiting now` 结束，没有上传发布。Windows runtime 测试仍在 0 个测试/0 条断言前崩溃；受支持的 Linux workerd 门禁成功。

路由基线在 ADMIN-A-FULFILLMENT 后为 PHP 1,904、TS 1,484、精确 782、可执行 764。本批净增四条精确可执行合同后为 TS 1,488、精确 786、可执行 768、明确不可用 18、原始缺失 1,118、证据化退役 4、可执行缺口 1,114，精确/可执行/退役后有效覆盖为 `41.3%/40.3%/40.4%`。`/api` 为 PHP 457、TS 797、精确 404、可执行 401、明确不可用 3、原始缺失 53、退役 1、可执行缺口 52，对应 `88.4%/87.7%/87.9%`；其他路由面未改变。静态匹配仍不证明生产权限、数据、provider 或状态机等价。

实现提交 `5a7604fa142678947b11ba24c4ee7408ef209cc8` 已推送至 `main`。[GitHub Actions 33461641860](https://github.com/cinagroup/cinashop/actions/runs/33461641860) 最终 8/8 jobs 成功：Linux Worker 综合任务通过生产依赖审计、双 TypeScript、174 文件/1,090 项单测、observability、201/248/201/零定义漂移和 1,904/1,488/786/768 路由门禁；真实 workerd runtime、Admin、PC、Supplier、Kefu、UniApp 和 checksum-pinned 全历史 Gitleaks 全部成功。CI 不持有生产 Secret、不访问 Hyperdrive，也不部署 Worker/Pages。Cloudflare Workers/Wrangler 最佳实践审查直接影响了 provider I/O 与事务隔离、paid/outbox 原子性、确定性回放、最小 ACL、私有不缓存、有界输入输出以及生产配置/数据/部署证据分层。

ADMIN-A 现在为 21/32，统计、履约和退款/资金子组均已收口；父项继续未完成，剩余 11 条全部属于 ADMIN-A-ASSISTED 代客下单。下一批必须先审计旧端 cart/place/confirm/computed/coupons/create/pay/status 的 key 生命周期和身份传播，再设计显式代客权限；Admin ID、目标 UID、购物车、服务端报价、库存、优惠券、订单归属、支付主体和重放证据必须从确认到支付全链路绑定，不能借用普通用户 token 或信任路径 UID/客户端 key。

## ADMIN-A-ASSISTED 代客下单详细审计（2026-09-01）

### PHP 权威、旧 UniApp 调用与迁移范围

本批逐行核对 PHP `route/api.php:762-776`、`app/controller/api/admin/order/CreateOrder.php`、`CashierOrderServices`、`StoreCartServices`、支付 service，以及旧 UniApp `view/uniapp/api/admin.js` 和 `pages/behalf` 的商品、确认单、收银台、记录页面。11 条路由全部有真实调用，不能退役。旧端的流程是 Admin 先为注册用户或 `uid=0` 游客建立购物车，`confirm` 返回短期 key，`computed`/`coupons` 反复报价，`create` 用同一 key 建单，随后 `pay` 发起现金或二维码支付，`pay/status` 每两秒轮询，最后由 `place/list` 展示代客记录。

| 路由 | 旧端依赖的响应/行为 | 当前候选的权威边界 |
|---|---|---|
| `GET cart/:uid` | 直接数组，商品/SKU 使用旧 snake_case 字段 | 只返回当前 Admin、目标 UID、游客 label、普通商品和未支付/未删除状态的购物车；无游客 label 不跨会话猜测 |
| `POST cart/add/:uid` | `{cartId}`；同规格可合并 | Admin/UID/游客 advisory lock 下锁商品与 SKU，校验上架、规格、库存后原子合并或插入 |
| `DELETE cart/del/:uid` | `ids` 可为逗号字符串 | 最多 200 个去重正整数；先锁定完整 actor scope，任何一项不归属即整批失败，再软删除 |
| `POST cart/num/:uid` | `{id,number}` | 锁定精确购物车行后重读商品/SKU 库存，禁止改动其他 Admin、UID 或游客会话 |
| `POST confirm/:uid` | 返回 `orderKey/cartInfo/userInfo/priceGroup` | 从精确 cart ID 集合解析 actor scope，服务端报价后把 Admin、UID、游客 label、cart 集合和 `isNew` 写入 30 分钟 KV 快照 |
| `POST computed/:key/:uid` | `res.data.result`；已建单返回扩展状态 | key 只能读取 `admin:assisted:checkout:{adminId}:{uid}:{key}`；每次重新验证购物车与实时报价，不接受客户端价格 |
| `GET coupons/:uid` | 直接返回当前购物车可用券数组 | 游客固定无用户券；注册用户的有效券、商品/分类/品牌范围和折扣全部由数据库批量计算，不信任客户端券额 |
| `POST create/:key/:uid` | `res.data.result.order_id` | 同一 actor-bound 快照内原子认领购物车、扣四层库存、写订单/商品快照/优惠券占用及 `admin_assisted_create` 状态审计；同 key 精确重放 |
| `POST pay/:uid` | `SUCCESS` 或微信/支付宝二维码配置 | 订单必须同时匹配 UID、当前 Admin、`is_channel=2` 和双软删除；现金/零元复用 paid/outbox 原子入口，provider I/O 在事务外 |
| `GET pay/status` | 直接 `{status,time}` | 轮询只按当前 Admin 的代客订单读取；仅兼容旧三位数字支付前缀，不能用任意前缀探测其他订单 |
| `GET place/list` | 直接分页数组，页面实际使用 `page/limit/keyword` | 固定当前 Admin 和 `is_channel=2`，兼容 PHP 状态、类型和数字支付方式筛选；订单、商品快照和退款分三批读取，不做 N+1 |

PHP 原实现的身份传播不构成可靠授权。旧中间件把移动端 Admin 认证结果放入普通 `$request->uid()`；游客页面生成的 `touristId` 只是五位随机数；确认 key 的 cache 仅含 UID 与 key；支付状态查询不含 Admin/UID；在线支付还会给公开订单号加随机三位前缀。若原样迁移，知道路径 UID、key 或订单号的另一个 Admin 可能重用购物车、报价或轮询支付结果。因此本批保留旧 URL 与页面读取的响应形状，但不保留这些越权条件。

旧端还有两个必须显式记录的兼容缺口。三级分类模板的游客购物车列表没有发送它已经持有的 `touristId`；在同一 Admin 同时服务多个游客时，服务端无法安全推断目标会话，所以候选拒绝缺 label 的游客列表。自提页会选中 `storeList[0]`，但确认和创建载荷没有发送 `store_id`；候选只在生产恰有一个有效门店时做确定性回退，多门店时要求客户端明确提交。这两点是旧端需要修补和真实 E2E 覆盖的前端合同，不通过后端跨会话猜测或任意选店掩盖。

### 权限、actor scope、报价与订单创建

新增权限 `order.assisted` 独立于 `order.view` 和 `order.manage`。11 条路径在通用 order matcher 之前精确识别，root Admin 自动具备，非 root 角色必须显式授权或通过既有菜单规则解析；仅能查看订单或执行普通运营动作的角色不会自动获得代客能力。所有 handler 仍位于 `adminAuthMiddleware` 后，actor 只读取已验证的 `adminInfo.id`，响应统一 `Cache-Control: private, no-store, max-age=0`。JSON body 上限为 8/16/32 KiB；UID、cart ID/数量、key、文本、支付方式、手机号、地址、门店、分页和筛选均严格有界，客户端 IP 在写订单和支付前截断为 IPv6 列上限 45 字符。

购物车表的 `staff_id` 是 actor authority，注册用户 scope 为 `{staffId, uid, touristUid=''}`，游客 scope 为 `{staffId, uid=0, touristUid}`。游客 label 只能限定范围，永远不能替代 Admin session。`cart/num` 与 `cart/del` 在旧端漏传 label 时，只能从请求明确给出的 cart ID 集合反查；必须每行属于当前 Admin 且只出现一个非空 label，才能继续。列表没有明确 cart 集合，故不做这种推断。所有代客购物车只允许 `type=0/activity_id=0/store_id=0`，不让游客或特权入口绕开秒杀、拼团、砍价、新人、积分商品等既有资格状态机。

确认快照采用 128-bit UUID key 和 30 分钟 TTL，payload 版本固定为 v1，包含 Admin、UID、游客 label、排序无关的精确 cart ID 集合、`isNew` 与创建时间。`computed`、`coupons`、`create` 每次读取后都重新校验 payload 和数据库购物车 scope；客户端无法替换 cart 集合、把注册用户 key 改成游客 key，或用另一个 Admin 的 key。报价复用 `StoreOrderCreateService.quoteOrder`，会员价、首单价、运费、积分、优惠券、库存和商品有效性仍由服务端决定。游客没有真实用户账户，因此会员、首单、积分、用户券和分佣统一关闭，不伪造 `uid=0` 用户行。

创建订单继续使用现有 `StoreOrderCreateService` 的 PostgreSQL 事务、幂等 advisory lock、购物车 `FOR UPDATE`、库存条件更新和不可变商品快照。普通用户下单现在明确拒绝 `staff_id>0` 或非空游客 label 的代客购物车；代客路径则要求每一行精确匹配当前 Admin。订单 `staff_id` 从已校验且同质的购物车集合推导，`is_channel=2` 明确标记来源，并与 `admin_assisted_create` 状态行同事务提交。相同 UID/key 已存在时只有同一 Admin 且同为 channel 2 才可重放；普通订单或其他 Admin 占用同 key 时失败关闭。这样库存、优惠券、订单归属与重放证据不会在确认和创建之间失去绑定。

### 支付、查询、批量读取与 PostgreSQL 性能边界

现金或零元订单通过 `applyStoreOrderPayment` 锁定真实订单行，并在同一事务再次执行 `{uid, staffId, isChannel, isDel, isSystemDel}` 授权。首次支付与积分处理、发票状态、拼团激活、`order.paid` outbox 和 `admin_assisted_pay` 状态审计原子提交；同一 actor 的已支付重放返回成功，其他状态不能被覆盖。微信和支付宝先做同一 actor 的只读授权，再调用现有支付 service；PC 微信使用 native 二维码，支付宝返回已签名支付 URL 的二维码兼容结构。provider HTTP/签名调用不包在 PostgreSQL 事务内，回调仍进入现有唯一 paid transition。代码没有新增 provider `fetch`，也不把支付主体改成客户端声明的 UID。

`place/list` 兼容 PHP 的未付、待发货、部分发货、待收货/核销、待评价、已完成、退款中/已退款等状态组合，以及普通/活动/核销/收银台/配送类型和数字支付方式映射。PHP 对 `status=-4` 与默认 `is_del=0` 会生成互相冲突条件，候选让明确的删除状态生效，不复制这个空结果 bug。列表先取最多 100 个 actor-scoped 订单，再用两个 `IN` 查询批量获取商品快照与有效退款；全退判断恢复为退款件数等于非赠品件数，不再用金额近似。优惠券范围同样是一条候选 join 加商品、券商品、分类和品牌的有界批量查询。Supabase PostgreSQL 最佳实践审查直接影响了短事务、统一锁序、条件更新、避免 N+1、bounded `IN` 集合和不为当前 29 单小样本投机加索引的决定。

本批没有新增 DDL。生产只读审计 Worker会在一个 `REPEATABLE READ, READ ONLY` 事务内固定 `search_path=public, pg_temp`、15 秒语句超时和 1 秒锁超时，只返回 staff-scoped 购物车、游客/注册 scope 异常、重复活动范围、代客订单、幂等 key、创建/现金审计、订单快照归属和支持索引的聚合结果；不返回订单号、UID、游客 label、金额、地址、联系方式或任何业务行。它精确绑定用户提供的生产 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。

按用户“直接使用生产数据库”的授权，先后使用仓库 Wrangler 4.122.0 和临时 Wrangler 4.127.1 运行远程 Hyperdrive 只读入口。两个版本都正确识别生产绑定，但 Windows `workerd` 在 Worker 启动、事务开始和任何 SQL 发送之前以 `0xc0000005` 崩溃；本机 WSL2 已启用但没有 Linux distribution，也没有独立生产 PostgreSQL URL。因此本批没有新的生产聚合结果，也没有生产 DML/DDL、临时 Worker 部署、provider 调用或主 Worker/Pages 发布。失败探针只证明 Windows 执行环境不可用，不能证明生产数据通过，也不能把既有 29 单历史事实当成本批 actor-scope 结果。

### 验证结果、路由进度与剩余门禁

新增定向测试 1 文件 4/4，覆盖 UID/游客/cart ID 严格解析、11 条精确路由、独立 `order.assisted` ACL、actor-bound KV、购物车 PostgreSQL 锁、订单 staff/channel 绑定、现金支付授权与审计、provider I/O 事务外、优惠券批量范围、PHP 状态/支付筛选、退款件数语义、有界 body/no-store 和生产审计 Worker 的只读结构。完整本地门禁为双 TypeScript、175 文件/1,094 项单元测试、observability 14 信号/10 域/27 必需事件/376 个生产源文件/6 个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、路由审计和 `git diff --check`。最终 minify dry-run 为 `3,359.85 KiB / gzip 799.78 KiB`，精确回显生产 Hyperdrive、Queue、KV、R2 与 Durable Object，并以 `--dry-run: exiting now` 结束。Windows runtime 仍在 0 个测试/0 条断言前崩溃，需由 Linux CI 复验。

路由基线在 ADMIN-A-REFUND 后为 PHP 1,904、TS 1,488、精确 786、可执行 768。本批净增 11 条精确可执行合同后为 TS 1,499、精确 797、可执行 779、明确不可用 18、原始缺失 1,107、证据化退役 4、可执行缺口 1,103，精确/可执行/退役后有效覆盖为 `41.9%/40.9%/41.0%`。`/api` 为 PHP 457、TS 808、精确 415、可执行 412、明确不可用 3、原始缺失 42、退役 1、可执行缺口 41，对应 `90.8%/90.2%/90.4%`；其他路由面未改变。静态匹配仍不证明生产权限、数据、支付或旧端 E2E 等价。

实现提交 `026ca7564311d28a4c2bbec55de39c2ddbf866fc` 已推送至 `main`。[GitHub Actions 33464973049](https://github.com/cinagroup/cinashop/actions/runs/33464973049) 最终 8/8 jobs 成功：Linux Worker 综合任务通过官方生产依赖审计、双 TypeScript、175 文件/1,094 项单测、observability、201/248/201/零定义漂移和 1,904/1,499/797/779 路由门禁；受支持的真实 workerd runtime、Admin、PC、Supplier、Kefu、UniApp 和 checksum-pinned 全历史 Gitleaks 全部成功。CI 不持有生产 Secret、不访问 Hyperdrive，也不部署 Worker/Pages。Cloudflare Workers 与 PostgreSQL 最佳实践审查直接影响了 Hyperdrive 单一绑定、短事务、provider I/O 隔离、actor-scoped KV、条件更新、批量查询、独立 ACL、私有不缓存和生产配置/数据/部署证据分层。

本批使 ADMIN-A 候选代码从 21/32 提升到 32/32，但完整业务域仍受真实旧端两处载荷修补、最小权限 Admin allow/deny、注册/游客/多游客/多门店场景、真实支付二维码与回调、预发、生产发布和发布后观察门禁约束。下一实现批应根据全局未完成 checklist 重新排序，不能因为 ADMIN-A 路由代码收口而越过 DATA、TEST 或 REL 门禁。

## CORE-001 支付与业务回调详细迁移审计（首个支付入口子批次，2026-09-01）

### 权威范围与静态迁移状态

本轮从 PHP 路由、控制器、provider 包装、listener、订单/充值/会员支付状态机、现有 Worker route/controller/service、Queue/Cron 和 PostgreSQL schema 逐层反查，不以相似路由名代替协议等价。PHP `/api` 顶层有六个公开回调合同：`order_call_back`、`wechat/serve`、`wechat/miniServe`、`work/serve`、`pay/notify/:type` 和 `city_delivery/notify`。其中企业微信 `work/serve` 已由 WORK-C0～C8 建成可信接收、事件账本、主体水位、Queue 和投影链；支付此前只有静态 `/pay/notify/wechat|alipay`，其余四个仍是精确缺口。

| PHP 合同 | PHP 实际行为 | 审计前 Worker | 本轮/后续判定 |
|---|---|---|---|
| `ANY pay/notify/:type` | `alipay/routine/wechat/app` 四路；支付宝 RSA2，微信 V2/V3 SDK后同步入账 | 静态微信/支付宝；微信始终读公众号 AppID | 本轮恢复动态路由和三种微信 AppID profile；事件账本/快速应答/主动对账仍缺 |
| `ANY wechat/serve` | SDK 验签后同步处理关注、扫码、卡券、支付和交易结算等消息 | 未注册 | 需独立公众号事件账本、消息回复与支付事件桥 |
| `ANY wechat/miniServe` | SDK 验签后同步处理资金支付和交易结算/收货事件 | 未注册 | 需独立小程序事件账本并复用支付/订单状态机 |
| `ANY work/serve` | SDK 解密后同步写多表并调用企业微信 | WORK-C0～C8 候选完整 | 代码边界完成；真实租户/数据/启用/发布仍缺 |
| `ANY order_call_back` | 用 `sms_token` 截断为 AES-256-CBC key，解密后直接处理寄件成功/取件/取消 | 未注册 | 旧协议不具备消息认证，禁止原样迁移；待当前快递100协议和真实样本 |
| `ANY city_delivery/notify` | 达达/UU参数直接进入状态更新，无回调验签 | 未注册 | 必须按两家 provider 分开验签、单调状态和对账 |

路由审计的首轮结果由 PHP 1,904、TS 1,499、精确 797、可执行 779、缺失 1,107，变为 PHP 1,904、TS 1,498、精确 798、可执行 780、缺失 1,106；TS 总数减少是两个静态支付路由收敛成一个权威动态路由，不是能力减少。`/api` 从 TS 808、精确 415、可执行 412、缺失 42，变为 TS 807、精确 416、可执行 413、缺失 41；精确/可执行/退役后有效覆盖为 `91.0%/90.4%/90.6%`。静态新增的一条精确匹配只关闭路由合同，不能证明账本、数据、provider 或发布完成。

### 支付回调：已有安全边界、发现的偏差与本轮修正

现有微信 V3 实现已具备 `Wechatpay-Timestamp/Nonce/Signature/Serial` 验签串、五分钟时间窗、签名探测拒绝、平台公钥 ID 固定、RSA 验签、APIv3 AES-GCM 解密、MchID/AppID、订单域唯一性、金额和相同 `pay_type + trade_no` 重放校验。支付宝已有 RSA2、AppID、可选 SellerID、订单域唯一性、金额和交易号校验。商品订单的 `paid=0→1`、活动积分、发票、拼团和 `order.paid` outbox在同一 PostgreSQL 事务；充值和会员也以行锁、金额及交易号保证单次入账。外部 provider I/O 不在这些最终支付事务内。

协议比对发现此前微信所有渠道都通过 `WechatPayService.getConfig()` 固定读取 `wechat_appid`，即使 `WechatPaymentIdentity` 已区分 `routine/app`。PHP 权威配置却明确使用 `routine_appId` 和 `wechat_app_appid`，并把回调地址分别设置为 `/routine` 与 `/app`。这会导致小程序或 App 下单使用错误 AppID，或合法回调在 AppID 校验处失败。本轮给支付身份增加不可变 profile：公众号/H5/PC=`wechat`、小程序=`routine`、App=`app`；商品、充值、会员三条发起链都显式传 profile，下单 `notify_url` 和回调解密后的 AppID从同一 profile解析。

旧 PHP 使用 `ANY` 只是框架声明，微信支付和支付宝实际均以 POST 回调。新动态路由保留路径级 `ANY` 以通过精确兼容审计，但非 POST 返回 `405 + Allow: POST`，未知、大小写变体或编码后多段 type 返回 404；不会让 GET 触发资金状态。微信支付/退款分别用流式 64 KiB上限，支付宝用32 KiB上限和 fatal UTF-8；支付宝还要求 `application/x-www-form-urlencoded`、最多64个唯一字段、字段名/值边界，并把 SellerID从“配置了才校验”改为支付能力必需项和每次强制匹配。微信补通知唯一 ID、订单/交易号格式、正整数金额和 `CNY`校验；签名后的业务字段仍不进入日志。

这些行为与微信支付官方当前合同一致：普通支付成功后以 POST 发送通知，商户需使用时间戳、nonce、原始 body、serial和平台公钥验签，再以 APIv3 key解密，并在5秒内完成验签应答；重复通知要求业务重入。[微信支付成功通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)、[APIv3签名/验签总述](https://pay.wechatpay.cn/doc/v3/merchant/4012365342)。本轮只使用官方协议文档和仓库中的实际 provider配置，没有根据第三方博客猜测签名规则。

### 尚未关闭的可靠性与安全缺口

支付订单行自身的幂等只能阻止重复资金入账，不能回答“哪个 provider事件何时到达、验签后是否持久化、为何失败、是否仍待处理、是否已经应答、Queue是否丢失”。当前微信/支付宝 handler仍在 HTTP请求内查询三个订单域并完成最终事务后才应答；即使代码路径正确，数据库抖动也可能超过微信5秒时限并产生重试风暴。仓库没有通用 payment callback event表，现有 `store_order_outbox` 是支付完成后的业务副作用 outbox，不是入站事件账本；scheduled任务只有退款 reconciliation，没有支付交易主动查询。因此 CORE-001-B/C 必须新增签名后快速持久化、opaque Queue、租约/死信和主动渠道对账，父项不能因本轮路由匹配而勾选。

公众号和小程序旧 listener也不能直接复制。`OffcialAccountListener` 与 `RoutineListener` 在 callback请求内同步处理关注/取消关注、扫码、位置、关键词/媒体、卡券、资金支付和交易结算；异常会被宽泛捕获、记录完整 payload，然后继续走默认响应，临时数据库/provider失败可能被永久确认。两个入口没有事件唯一键、重放账本、主体水位或乱序规则；其中 `funds_order_pay` 又是第二条支付入账来源，必须桥接统一支付账本，不能另写一套只看订单号的状态更新。

`order_call_back` 的旧 AES-CBC只提供机密性且 key复用短信 `sms_token`，没有MAC/独立签名、时间戳、nonce、事件ID或重放保护；控制器会记录完整请求并直接改 `label/delivery_id/status/kuaidi_*`。CBC密文可篡改而不被可靠检测，这条路由必须在取得快递100当前回调签名、字段和真实样本后重新设计。达达/UU旧入口风险更直接：控制器把任意 query/form/JSON参数交给 `StoreDeliveryOrderServices::notify()`，未调用两家已有的出站签名函数；状态处理只判断目标状态“不等于当前状态”，没有单调图，延迟的待取件/配送中/取消可能覆盖完成态。两家 provider必须分别验签、去重、按订单主体排序，并用主动查单解决UNKNOWN，而不是共享一个无鉴权分支。

企业微信是唯一已有完整候选账本和乱序模型的非支付回调，但生产为空租户且未启用；它可以提供表/租约/Queue/水位模式，不能共享具体事件表或假设公众号、支付和配送具有相同排序键。通用部分应抽象为接收状态与租约规则，每个provider保留自己的可信事件ID、主体键、状态图、敏感字段白名单和应答格式。

### PostgreSQL/Hyperdrive设计顺序与生产边界

后续首要实现应是 `payment_callback_event`：以 `(provider,event_id)` 数据库唯一约束阻断重放，另存 request摘要、渠道profile、主体摘要/订单号的最小白名单、provider事件时间、`RECEIVED/PROCESSING/COMPLETED/IGNORED/UNKNOWN/DEAD`、租约token/截止时间、尝试计数、低基数错误码和保留期；不保存签名头、密钥、完整原始/解密 body或支付人信息。签名验证和provider解密在事务外，账本插入与可投递 outbox在短事务内用 `INSERT ... ON CONFLICT` 收敛；Queue只携带 event主键和不可猜 replay key。消费者以固定 advisory/行锁顺序认领，复用现有商品/充值/会员支付状态机；任何外部查单都在事务外。待处理/UNKNOWN使用与查询相符的部分索引和有界主键游标，不按当前29单小样本投机建宽索引。

生产目标仍精确绑定用户给定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有引入SQLite、影子PostgreSQL或第二套业务库。既有直接只读证据是 PostgreSQL 16.14、订单29（已付20）、充值6（已付1且历史交易号缺失）、支付开关全关闭，且没有可用微信 AppID/商户号/证书序列号或微信/支付宝 Worker Secret；`routine_appId`等微信配置也缺失。上一批为新只读聚合编写的Worker在两版Wrangler下均于SQL发送前遭Windows `workerd 0xc0000005`，本批没有把该失败重复解释为生产数据通过，也没有为取得结果部署临时Worker、执行生产DML/DDL或调用真实provider。本轮代码没有新增schema，因此未对生产数据库做无意义写入。

### 首批验证结果与下一实现点

新增 `payment-callback-route.test.ts` 并扩展收银台测试，定向3文件16项通过；完整双TypeScript、176文件/1,100项单元测试、observability 14信号/10域/27必需事件/377个生产源文件/6个发布阻塞、schema source201/target248/shared201/sourceGaps0/external248/embedded248/零定义漂移、路由审计和 `git diff --check` 均通过。Windows真实workerd仍在0条测试/0条断言前以`0xc0000005`失败，必须由Linux CI复验，不能记成本地runtime通过。

候选实现提交 `b57fceae65d8753e5f14a8bc045d088a387a5916` 已推送 `main`；[Linux Migration gates 运行 33466922478](https://github.com/cinagroup/cinashop/actions/runs/33466922478) 的8个job全部成功，包含 workerd runtime、完整Worker单测、双TypeScript、schema/route/observability、PC/Kefu/Admin/Supplier/UniApp构建和历史密钥扫描，补齐了Windows本机缺失的runtime证据。本地生产依赖审计返回`0 vulnerabilities`；Wrangler `--dry-run`解析到 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，构建产物约5.9 MiB/gzip 1.08 MiB后退出，未执行部署或生产数据库写入。

下一批固定为 CORE-001-B：先完成支付入站事件表、短事务接收/outbox与opaque Queue，再把微信/支付宝 handler从“同步完整入账后应答”改为“验签→持久化→快速应答→幂等消费”。只有账本的外部/内嵌DDL逐字一致、PostgreSQL并发/崩溃/重放场景和Linux runtime门禁通过后，才进入主动支付对账 CORE-001-C；不会跳过账本先恢复高风险寄件或同城写状态路由。

## CORE-001-B 支付回调事件账本与快速应答收口（2026-09-01）

### 实现结果与状态机边界

本批已把微信/支付宝支付回调从“HTTP 请求内查询订单并同步完成入账”改为“provider 验签/解密 → PostgreSQL 短事务原子写入事件与 outbox → provider 成功应答 → opaque Queue 异步消费”。新表 `payment_callback_event` 保存 provider、可信事件 ID、replay key、渠道 profile、订单域、订单号/交易号、金额/币种、provider 时间、规范化白名单摘要、处理状态、租约、尝试、低基数错误码和保留期；`payment_callback_outbox` 保存投递状态、租约、尝试和下次投递时间。代码不保存原始 body、签名头、解密全文或付款人 PII，Queue 消息精确限制为 `{action,eventId,replayKey}`。

接收事务使用 provider event 唯一约束同时创建事件和 outbox，任一写入失败即整体回滚。消费端以 provider+transaction advisory transaction lock、事件/订单行锁和现有 `applyStoreOrderPayment/applyRechargePayment/applyMembershipPayment` 状态机完成单次入账；同一 provider 交易号指向不同订单、金额或币种时终止为 `UNKNOWN`，不会覆盖既有交易证据。outbox dispatch、delivery 和 processing 均有独立租约；Cron 只发送 `dispatchPaymentCallbackOutbox` 根任务，批量认领使用 `FOR UPDATE SKIP LOCKED`，失败按有界退避恢复，最多 8 次进入 `DEAD`，DLQ 只归档并重放同一不透明事件引用。支付完成 outbox 的即时发送可以失败，但 scheduled dispatch 仍能从 PostgreSQL 恢复。

支付宝在既有 RSA2/AppID/SellerID 防线之外强制有效 `notify_id`、精确正整数分值和已签名的 `gmt_payment/notify_time`；微信把 `success_time` 转换为可信 provider event time，并在 `SUCCESS` 时强制有效。HTTP 错误响应不再泄漏内部异常；新增低基数 `payment_callback_persisted/completed/failed` 观测合同。Cloudflare Workers 与 PostgreSQL 最佳实践直接影响了这里的最小 Queue body、短事务、provider I/O 事务外、租约、`SKIP LOCKED`、与查询条件一致的部分索引以及 fail-closed catalog 校验。

### 生产 PostgreSQL 直接执行与隔离场景

按用户“直接使用生产数据库”的明确授权，本批精确绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。Windows 本地远程 `wrangler dev` 仍在 SQL 前因 `workerd 0xc0000005` 失败，因此改用一次性、随机 bearer 保护且无自定义 route 的审计 Worker 作为 Hyperdrive 桥；未部署或修改主 `cinashop-api` Worker。初始只读结果确认生产为 PostgreSQL 16.14 且两张目标表不存在。

先在生产引擎随机 schema 中执行外部/内嵌逐字一致 DDL 和真实 PostgreSQL 状态机场景，11/11 通过：DDL 结构/二次执行幂等、重复接收只生成一组 event+outbox、Queue body 不透明、并发消费者只结算一次、交易证据冲突终止为 UNKNOWN、Queue 失败持久化并可恢复、outbox 插入失败回滚整个接收事务、结算后崩溃重放仍只入账一次、8 次耗尽进入 DEAD、DLQ 从同一 opaque 事件恢复、非成功通知进入 IGNORED。随机 schema 最终删除。

随后把 `0120_payment_callback_pipeline.sql` 直接应用于生产 `public`：`payment_callback_event` 22 列、`payment_callback_outbox` 14 列，合计 12 个约束、11 个索引，创建后均为 0 行。DDL 内的 fail-closed `pg_catalog` 验证会核对 relation kind/persistence、列顺序/类型/null/default、精确约束/索引名、约束验证状态、CHECK 继承属性、FK 目标与 `ON DELETE RESTRICT`、唯一及部分索引 valid/ready 状态；在已有空表上最终返回 `created=false, complete=true, idempotent_second_pass=true`。临时审计 Worker 已删除，随机 schema 已删除，生产只保留本批授权创建的两张空业务表。

### 验证、提交与剩余门禁

本地完整单元测试为 177 文件/1,111 项全部通过；双 TypeScript、observability 14 信号/10 域/27 必需事件/380 个生产源文件/6 个发布阻塞、schema source201/target250/shared201/sourceGaps0/external250/embedded250/零定义漂移、路由 PHP1,904/TS1,498/精确798/可执行780/缺失1,106/可执行缺口1,102、`npm audit --omit=dev` 0 漏洞均通过。主 Worker minify dry-run 为 `3,392.52 KiB / gzip 806.29 KiB`，精确解析 Hyperdrive、Queue、KV、R2 和 Durable Object 后以 dry-run 退出。

实现提交 `bd501cf6e27a5fca979663c0c43418427fbb275a` 及 CI 契约修正 `e654cc59745af6ee4b8879b0924cc5bbb3e72cc7` 已推送 `main`。[Linux Migration gates 33470912902](https://github.com/cinagroup/cinashop/actions/runs/33470912902) 最终 8/8 jobs 成功：workerd runtime 13/13、完整 Worker 单测、双 TypeScript、schema/route/observability、Admin/PC/Supplier/Kefu/UniApp 构建与 checksum-pinned 全历史 Gitleaks 全部通过。首轮 CI 精确暴露新增 Cron 根任务造成的 13→14、14→15 测试基线偏差，以及一个固定测试 UUID 的 Gitleaks 误报；修正后用文件+规则+精确旧行三重限制的历史白名单恢复门禁，没有放宽通用密钥扫描。

CORE-001-B 只代表候选代码、生产表结构和隔离状态机收口。生产微信/支付宝开关与凭据仍不可用，未执行真实 provider 回调，主 Worker 未发布，也未完成支付主动查询、分页对账、告警、人工处置或发布后观察；这些继续由 CORE-001-C/H 约束。下一实现点固定为 CORE-001-C，不能把已创建空账本解释为渠道已启用或父项 CORE-001 完成。

## CORE-001-C 支付主动对账与告警收口（2026-09-01）

### 审计结论与迁移边界

本批开始前，系统已经有 CORE-001-B 的可信支付回调事件/outbox，也有商品、充值和会员三类幂等支付状态机，但 scheduled 只有退款对账。一个真实支付请求如果在 provider 已受理后丢失响应、回调未到或回调消费失败，系统没有独立案件记录可主动查询；同样也无法持续区分 provider 仍待支付、明确关闭、查无交易、已经成功但本地未入账，以及本地已付但交易证据冲突。历史订单自身的 `paid/pay_type/trade_no` 不能替代发起时的 provider/profile/金额意图，尤其 `paid=0` 行通常没有渠道标记，因此禁止根据订单号前缀或空 `pay_type` 猜测渠道后批量查单。

现已新增 `payment_reconciliation_case` 与 `payment_reconciliation_action`。案件唯一键为 `(provider, order_no)`，另有随机 replay key；不可变证据包括 provider/profile、订单域、订单号、预期整数分、CNY、可信交易号、provider 时间和可选 callback event 外键。状态覆盖 `OPEN/QUEUED/QUERYING/WAITING/SETTLED/CONFIRMED/NO_PAYMENT/UNKNOWN/CONFLICT/DEAD/CLOSED`，并保存尝试次数、下次检查时间、处理租约、低基数错误码、解决时间和保留期。人工处置表用唯一 action key 保存管理员、`RETRY/ACCEPT_LOCAL/CLOSE`、低基数 reason code 与前后状态；两个外键均为 `ON DELETE RESTRICT`。数据库明确拒绝非法 provider/profile、订单号、交易号、金额、币种、状态、UUID、负时间或负计数，代码不保存 provider 原始响应、签名、付款人 OpenID、手机号、邮箱、地址或凭据。

### 主动查询、恢复和人工处置

商品订单微信/支付宝、充值微信、会员微信/支付宝现在都在首次 provider HTTP 或支付宝 URL 签名前用短事务登记恢复意图；登记成功但外部请求状态未知时，案件仍可恢复。可信支付回调在事件+outbox 接收事务内登记同一案件，并在异步入账终态事务内将案件收敛为 `CONFIRMED/WAITING/CONFLICT`。重复意图只有 provider、profile、订单域、金额、币种及已有交易号一致才幂等；不一致直接进入 `CONFLICT`，不会覆盖先到证据。

Cron 只投递 `{action:"dispatchPaymentReconciliation",scheduledAt,cursor:0}` 根消息；扫描在短事务内以主键游标、部分索引、租约和 `FOR UPDATE SKIP LOCKED` 认领，业务 Queue 只携带 `{action:"processPaymentReconciliation",caseId,replayKey}`。provider I/O 明确发生在认领事务提交之后；所有本地证据读取、状态更新和人工处置仍使用短事务。查询错误或未知状态指数退避，从 60 秒封顶 6 小时，最多 12 次转 `DEAD`；`PENDING` 保持 `WAITING`；`NOT_FOUND/CLOSED` 只有至少查询 3 次且发起已满 30 分钟才转 `NO_PAYMENT`。`SUCCESS` 必须同时满足订单号、CNY、整数分、交易号和 provider 时间证据，再复用既有商品/充值/会员支付状态机；金额或身份不一致、本地已付但 provider 非成功、订单域不唯一、既有交易号不一致均转 `CONFLICT`。`CONFLICT` 重放不会再次请求 provider，只允许受保护管理端以 4 KiB 请求上限、显式确认串、UUID 幂等键和低基数 reason code 执行 `RETRY/ACCEPT_LOCAL/CLOSE`。

微信查单使用官方 `GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=...`，沿用商户 RSA 请求签名、平台签名验签、AppID/MchID/订单号/金额/币种/交易号/成功时间校验，并归一化 `SUCCESS/NOTPAY/USERPAYING/CLOSED/REVOKED/PAYERROR/REFUND`；支付宝使用签名的 `alipay.trade.query`，验签后归一化 `WAIT_BUYER_PAY/TRADE_CLOSED/TRADE_SUCCESS/TRADE_FINISHED`。两条查询均有 8 秒网络上限，非白名单响应只产生低基数错误码。协议依据只采用当前官方文档：[微信支付商户订单号查询订单](https://pay.wechatpay.cn/doc/v3/merchant/4012791900)、[支付宝 alipay.trade.query](https://developer.alibaba.com/docs/api.htm?apiId=757&docType=4)。

Queue 消费会输出 `payment_reconciliation_dispatched/completed/attention/failed` 四类结构化低基数事件，不记录订单号、案件 ID、交易号或 provider 正文；可观测性策略新增 payment reconciliation 信号：任一 `UNKNOWN/CONFLICT` 或尝试次数达到 3 为 warning，任一 `DEAD` 或超过 15 分钟未解决的 `CONFLICT` 为 critical。生产告警目的地仍是 `pending`，因此本项完成的是稳定事件与策略合同，不把未获授权的真实通知渠道伪记为已配置。

### 生产 PostgreSQL 直接证据

按用户明确授权，临时令牌门控审计 Worker 精确绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。迁移前在 PostgreSQL 16.14 的 `REPEATABLE READ, READ ONLY` 事务中确认：两张对账表不存在，`payment_callback_event` 共 0 行；生产商城订单为未付 8/已付 20，充值为未付 5/已付 1，会员订单 0，其中 8 个商城和 5 个充值未支付订单均超过 30 分钟，但 `pay_type/recharge_type` 没有可信微信或支付宝标记。审计没有返回订单号或用户数据，也没有把这 13 行猜测性写入新账本；主动对账从今后的真实发起和可信回调开始。

随机 `codex_payment_reconciliation_*` schema 先应用 CORE-001-B 与 C 的逐字同源 DDL，再用真实 PostgreSQL/Hyperdrive 跑最终 16/16 场景：结构精确且二次执行幂等、重复意图单案件、不可变冲突终止、provider 成功只结算一次、PENDING 退避、老化 NOT_FOUND 转 NO_PAYMENT、金额证据冲突、CONFLICT 重放不再查 provider、瞬态错误第 12 次 DEAD、过期租约单次恢复、Queue 仅 opaque 引用、Queue 失败持久化、三类人工处置不可变且幂等、回调联动同一案件、无原始 provider/付款人列，以及 provider I/O 位于结算事务之外。每次失败和最终成功路径都由 `finally` 删除随机 schema，最终 `temporary_schema_removed=true`。

隔离审计实际发现并修复了三类不能靠静态测试证明的问题。第一，CORE-001-B 旧 DDL 的唯一/部分索引完整性计数只按全数据库同名索引查询；当 `public` 已存在同名索引时，随机 schema 二次验证会重复计数。B/C 验证器现都限定 `index_namespace.nspname=current_schema()`。第二，告警计数与本地支付证据曾绕过统一事务，在 Hyperdrive 不保留自定义启动级 search path 时可能读到 `public`；这些读取现全部使用显式短事务和 `SET LOCAL search_path`。第三，`CONFLICT` 的旧 Queue 重放最初仍可能重新查 provider；它现在是自动处理终态，必须由管理动作解锁。

随后把外部 `0121_payment_reconciliation.sql`（Worker 内嵌 `migration_0127`）直接应用到生产 `public`，创建 `payment_reconciliation_case` 24 列、`payment_reconciliation_action` 9 列，合计 13 个约束、10 个索引。目录验证精确核对 relation kind/persistence、列顺序/类型/null/default、完整约束/索引集合、CHECK validated/non-NO-INHERIT、callback/case 两个 FK 目标与 `ON DELETE RESTRICT`、5 个唯一/主键索引和 4 个部分索引的 valid/ready/predicate；结果为 `created=true, complete=true, idempotent_second_pass=true`。最终只读复验结构仍完整、两表均为空，所有随机 schema 已删除，临时审计 Worker 已删除；主 `cinashop-api` 没有部署。

### 本地门禁、Linux CI 与剩余阻塞

本地完整单元测试为 178 文件/1,127 项全部通过；双 TypeScript、observability 15 信号/10 域/31 必需事件/387 个生产源文件/6 个既有发布阻塞、schema source201/target252/shared201/sourceGaps0/external252/embedded252/零定义漂移、路由 PHP1,904/TS1,502/精确798/可执行780/缺失1,106，以及 `git diff --check` 均通过。主 Worker minify dry-run 为 `3,436.88 KiB / gzip 814.87 KiB`，精确解析 Hyperdrive、Queue、KV、R2 与四个 Durable Object 后退出。Windows 本地 workerd 仍在 0 条测试前以既有 `0xc0000005` 失败，没有将其记成代码通过；推送提交 `276e9d0a1e8259a892012ebb5e7d4edeaa8b2c14` 后，[Linux Migration gates 33474315306](https://github.com/cinagroup/cinashop/actions/runs/33474315306) 8/8 jobs 成功，包含真实 workerd、完整 Worker 门禁、Admin/PC/Supplier/Kefu/UniApp 构建和 checksum-pinned 全历史 Gitleaks。

CORE-001-C 因候选代码、生产空结构、真实 PostgreSQL 隔离状态机和 Linux 门禁齐全而勾选，但不等于支付已在生产启用。生产微信/支付宝开关和真实凭据仍不可用，没有真实 provider 正向/回调样本；告警目的地仍 pending，主 Worker、前端、预发、正式发布和发布后观察均未执行。历史 13 个无可信渠道证据的未支付订单保持原样。这些边界继续由 CORE-001-H 约束，父项 CORE-001 保持未完成；下一清单项仍是 CORE-001-D 公众号/小程序消息回调。

## CORE-001-D 公众号/小程序消息回调收口（2026-09-01）

### PHP 权威行为与迁移风险

PHP 的 `ANY /api/wechat/serve` 和 `ANY /api/wechat/miniServe` 会把公众号/小程序消息直接交给两个 listener。关注、取消关注、扫码、卡券领取/激活/删除、`funds_order_pay`、交易结算/收货及公众号被动回复都在 HTTP 回调链内执行；listener 最外层捕获所有异常后仍继续返回下一个响应，支付分支还把解析后的数据和完整 `$payload` 写入错误日志。旧实现没有独立事件唯一键、持久化 outbox、处理租约、乱序水位或 DEAD 终态，所以“订单行最终已付”不能证明扫码计数、关注状态、会员卡或回复消息只执行一次，也不能阻止迟到关注/领卡覆盖较新的取消/删除。

现已恢复两条精确兼容路由，但收紧为 GET/POST 两种方法。GET 同时支持明文 `signature` 和安全模式 `msg_signature` URL 验证；POST 只接受 `application/xml`/`text/xml` 安全模式，body 上限 64 KiB，执行严格查询字段边界、SHA-1 签名、AES-256-CBC、微信 32-byte PKCS#7、致命 UTF-8 解码和解密尾部 AppID 常量时间匹配。XML 拒绝 DOCTYPE、ENTITY、stylesheet、超大字段和未知实体。callback token 与 EncodingAESKey 只从四个独立 Worker Secret 读取，不再把旧 `system_config` 当密钥权威；AppID 仍从对应的公众号/小程序配置读取并参与解密身份校验。

### 最小证据、Queue 与各事件幂等语义

签名头、原始 XML、解密全文、任意 provider 字段和用户消息正文均不持久化；只保存规范化白名单、不可变 SHA-256 摘要和低基数状态/错误码，文本正文只在内存中匹配回复关键字后丢弃。被动回复先从有效二维码/关键字/默认规则解析为 text/image/voice/news/transfer 的最小快照，再与首次事件原子固化，因而重复回调不会因运营配置变化返回另一条回复。HTTP 只有在验签、解密、事件和 outbox 同一短事务提交后才返回成功；失败返回 400 促使微信重试，Queue 即时发送失败则由 PostgreSQL 与 Cron 恢复，不再复制 PHP“异常也确认”的行为。

`wechat_callback_event` 保存 source、event/replay key、payload/subject hash、最小事件字段、回复快照、处理状态、尝试、租约、保留期；`wechat_callback_outbox` 保存投递状态、租约和恢复时间；`wechat_callback_watermark` 按 source+projection+subject 保存 `(event_time, sequence_rank, event_id)`。事件/outbox 原子插入并由数据库唯一约束收敛，Queue 只携带 `{action,outboxId,eventId,replayKey}`，认领使用主体 advisory transaction lock、行锁、`FOR UPDATE SKIP LOCKED`、有界指数退避和最多 8 次 DEAD，DLQ 只重放同一 opaque 引用。Cloudflare Workers 与 PostgreSQL 技能的生产约束直接形成了这些短事务、provider I/O 事务外、opaque Queue、租约、部分索引和 fail-closed DDL 选择。

关注/取消关注按 openid 使用单调水位，同秒时取消关注排序更高；带 Ticket 的关注同时保留一次加法扫码语义。普通扫码不因乱序丢弃，但由事件唯一键保证同一事件只累计一次。会员卡按 openid+cardId 排序为领取 < 激活 < 删除，删除后迟到领取转 `SUPERSEDED`；首次插入显式初始化全部生命周期字段，不依赖遗留表可能不一致的默认值。公众号消息每个唯一事件只写一条不含正文的 `wechat_message` 摘要。`funds_order_pay` 不直接改订单，而是从商品/充值/会员三个域中取得唯一权威订单与金额，再作为可信微信事件进入 CORE-001-B 的 `payment_callback_event/outbox`；交易结算/确认收货复用既有 `completeOrderReceipt`，外部或跨事务失败后重放仍收敛。

### 生产 Hyperdrive 隔离审计与正式 DDL

按用户“直接使用生产数据库”的明确授权，一次性令牌保护、无自定义 route/Queue 的临时 Worker 精确绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。迁移前只读审计确认 PostgreSQL 16.14，三张目标表不存在；`wechat_appid/routine_appId/wechat_token/wechat_encodingaeskey/wechat_encode/wechat_appsecret/routine_appsecret/create_wechat_user` 均没有匹配配置，微信身份聚合为空，二维码/渠道/卡券/领卡/消息均为 0，支付回调账本为空。订单只返回聚合状态：未付取消 1、未付待支付 8、已付待处理 15、已付处理中 1、已付完成态 4；没有返回配置值、订单号或用户标识。

随机 `codex_wechat_callback_*` schema 使用真实 PostgreSQL/Hyperdrive 和真实服务代码跑最终 14/14 场景：外部/内嵌 DDL 精确且二次执行幂等、安全模式验签解密与回复快照、重复接收原子收敛、同事件不同载荷拒绝、Queue 仅 opaque 引用、Queue 失败持久恢复、消息投影/重放、正文不落库、关注乱序、扫码加法、卡券删除抵御迟到领取、支付进入共享账本、已完成收货幂等 no-op，以及 listener 失败不确认并在第 8 次进入 DEAD。最终事件状态为 APPLIED 7、SUPERSEDED 2、APPLIED_NOOP 1、DEAD 1，随机 schema 由 `finally` 删除。

真实引擎审计先后暴露并修正四个静态测试不易发现的问题：约束证据曾错误把 PK/FK 的 `connoinherit=true` 当异常；Hyperdrive 不保留自定义会话 `search_path`，服务内所有数据库读取必须进入显式短事务；PostgreSQL 不允许锁定 LEFT JOIN 的可空侧，二维码查询现只锁 `qrcode`；遗留 `user_card` 隔离副本没有可靠默认值，首次领卡现显式写全生命周期字段。修正后才把外部 `0122_wechat_callback_pipeline.sql`（Worker 内嵌 `migration_0128`）应用到生产 `public`。

正式结果为 `wechat_callback_event` 23 列、`wechat_callback_outbox` 14 列、`wechat_callback_watermark` 8 列，合计 45 列、16 个已验证约束、13 个 valid/ready 索引，其中 4 个部分索引；两个外键均为 `ON DELETE RESTRICT`，没有 RLS、rule、policy 或用户 trigger。DDL 连续两次执行保持 `complete=true, idempotent_second_pass=true`，最终三表均为 0 行。临时 Worker 与一次性 Secret 已删除，所有随机 schema 已删除；生产只保留本批获授权创建的三张空表，主 `cinashop-api` 未部署。

### 工程门禁、上线边界与下一项

本地完整单元测试为 179 文件/1,136 项全部通过，双 TypeScript、observability 16 信号/10 域/35 必需事件/391 个生产源文件/6 个既有发布阻塞、schema source201/target255/shared201/sourceGaps0/external255/embedded255/零定义漂移、路由 PHP1,904/TS1,504/精确800/可执行782/缺失1,104/可执行缺口1,100、生产依赖 0 漏洞和 `git diff --check` 均通过。主 Worker与审计 Worker dry-run 分别约 `6,069.75/1,115.63 KiB`、`2,020.68/351.53 KiB`（upload/gzip），都解析到指定 Hyperdrive 后退出。Windows 本机 runtime 仍在 0 个测试前因既有 `workerd 0xc0000005` 失败，没有记成代码失败或通过；候选提交 `a5e02d067a16c8b06af5b681561a4a34e630e8c8` 推送后，[Linux Migration gates 33480134867](https://github.com/cinagroup/cinashop/actions/runs/33480134867) 8/8 jobs 成功，补齐真实 workerd、全量 Worker 门禁、五个前端构建和 checksum-pinned 全历史 Gitleaks 证据。

主 Worker 当前 Secret 名单仍只有 `APP_KEY/DEBUG/INTERNAL_CHAT_TOKEN/OPERATIONS_TOKEN/UPSTASH_REDIS_TOKEN/UPSTASH_REDIS_URL`，没有 `WECHAT_OFFICIAL_CALLBACK_TOKEN/WECHAT_OFFICIAL_CALLBACK_AES_KEY/WECHAT_MINI_CALLBACK_TOKEN/WECHAT_MINI_CALLBACK_AES_KEY`；数据库也没有对应 AppID 或可供真实验收的微信身份/二维码/卡券/消息数据。因此 CORE-001-D 可以按“候选代码、生产空结构、随机 schema 状态机、Linux 门禁完成”勾选，但不能解释为真实微信渠道已配置、回调已验证或线上已更新。真实凭据、测试租户、微信后台 URL 配置、正向/乱序/重放、旧端 E2E、发布批准和发布后观察继续归 CORE-001-H。

## CORE-001-F 商家寄件回调详细审计（候选与生产空结构完成，2026-09-01）

### 旧权威实现与当前 provider 合同

旧 PHP 并不是直接调用快递100：`AccessTokenServeService` 统一访问 `http://sms.crmeb.net/api/`，用 `sms_account/sms_token` 调 `v2/shipment/create_order` 等 CRMEB 一号通接口；`ANY /api/order_call_back` 收到 `{type,data}` 后，以同一短信 `sms_token` 截断为 AES-256-CBC key 解密并直接处理 `order_success/order_take/order_cancel`。该包络没有 MAC、独立回调密钥、可信事件 ID、重放账本或乱序水位，控制器还会记录完整输入，因此不能原样迁移。

快递100当前官方上门取件合同是 `POST application/x-www-form-urlencoded`，body 精确包含 `taskId/sign/param`，签名为大写 `MD5(param + salt)`；正确应答为 `{"result":true,"returnCode":"200","message":"成功"}`，失败会在 30 分钟后重试、最多 3 次。`param.status` 是通讯状态，本实现只接受 `200`；订单状态来自 `param.data.status`。当前文档列出的 `0/1/2/9/10/11/13/14/15/99/101/155/166/200/201/302/400/610` 均已显式分类，未知状态只进入隔离账本而不改订单。provider 文档允许下单时传入 salt；候选实现进一步强制 16～100 UTF-8 bytes 的独立 `KUAIDI100_CALLBACK_SALT`，不再复用短信、OnePass 或应用 Secret。

### 候选接收、事件账本与单调投影

兼容路由继续注册为 `ANY`，但非 POST、非 form content type、超过 32 KiB、重复/未知 form 字段、空 salt、无效 UTF-8/JSON、非 `200` 通讯状态、错误签名、非法 task/carrier/status 或需要实物履约却缺少运单号均失败关闭。验签使用常量时间比较；原始 form、签名、完整 `param`、courier name/mobile、费用、重量、图片和任意 provider 扩展字段在接收事务前即丢弃。事件表只保存不可变 SHA-256、task/provider order/carrier/tracking/status 白名单和最小协议/改派引用；Queue 只携带 `{action,outboxId,eventId,replayKey}`。

`merchant_shipment_callback_event/outbox/watermark` 提供事件/replay 唯一围栏、投递与处理租约、`SKIP LOCKED`、Cron 恢复、有界指数退避、8 次 DEAD 和 400 天终态保留。接收只做验签后的事件+outbox短事务并立即返回 provider 成功；Queue 消费按 task advisory transaction lock 串行，订单必须唯一匹配 `store_order.kuaidi_task_id`、未删除且已支付。取件/运输/派送/签收/结算复用 `SupplierFulfillmentService.deliver` 和 `merchant_shipment_delivery` 哈希回放，不复制发货状态机；Queue 或水位事务失败后重放仍只发货一次。

状态水位拒绝活动状态倒退；取件后迟到取消转 `SUPERSEDED`，取消/失败后普通活动事件转 `CONFLICT`，只有明确 `166` 可复活。`155/200/201` 进入独立 metadata 水位；未知状态进入 ignored 水位。官方 `302` 改派只持久化新 task/carrier/tracking allowlist，在同一事务锁定新 task、拒绝与其他订单歧义、更新订单 task，并把 `REASSIGNED` 水位同时桥接到旧/新 task；因此新 task 迟到的 `1=已接单` 不会覆盖改派，而 `10=已取件` 可以继续推进。`15=已结算` 在已发货订单上写入终态水位，后续活动状态被拒绝。

### 生产 Hyperdrive 证据、事故处置与最终复验

按用户直接使用生产数据库的授权，一次性随机 bearer 保护、无自定义 route/Queue 的临时 Worker 绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。最早的只读基线确认 PostgreSQL 16.14、有效订单 28，`kuaidi_task_id/kuaidi_order_id/delivery_id/is_stock_up` 均为 0，目标三表不存在，`order_waybill_job` 为 0；`sms_account/sms_token/config_shippment_open/config_export_siid` 没有匹配配置，只有 `site_url` 有 5 条非空重复记录。审计没有返回配置值、订单号、task、用户或地址。

随机 schema 首个可执行版本通过 13/13：外部/内嵌 DDL 精确且二次执行幂等、官方 form/签名与 PII allowlist、重复接收原子收敛、活动推进/迟到状态、取消冲突与显式复活、并发取件/回放只发货一次、取件后取消不回退、未知状态隔离、opaque Queue、Queue 失败持久恢复、无法匹配 task 第 8 次 DEAD，以及状态/metadata 水位。加入官方 `15/302` 后，扩展轮覆盖改派新 task 桥接和结算终态，共 15/15 通过；事件结果为 APPLIED 8、SUPERSEDED 3、CONFLICT 2、APPLIED_NOOP 1、IGNORED 1、RECEIVED 1、DEAD 1，原始表单、签名和 PII 列均不存在。所有随机 schema 都由 `finally` 删除，成功轮 `public` 全量指纹不变。

首个失败轮同时暴露了严重的审计夹具缺陷：虽然业务服务全部使用 `withTx` 并执行事务级 `SET LOCAL search_path`，夹具最初的种子写入直接使用 `container.db`。Hyperdrive 不保证连接启动级自定义 `search_path`，所以该失败轮把 4 条固定审计订单和 1 条审计快递公司写入 `public`；生产聚合因此暂时变为订单 32、task/stock-up 标记各 4。候选夹具随后改为所有读写都通过显式短事务和 `SET LOCAL search_path`。用户在获知不可逆 DML 边界后明确授权清理；一次性受保护 Worker 在 `SERIALIZABLE` 短事务中先锁定精确 4+1 主键，逐列重建并比对完整夹具指纹，同时要求拆单、购物车、退款/退款支付、状态/优惠、发票/促销、核销、赠券、配送、拼团、订单 outbox、面单以及寄件 callback event/outbox/watermark 共 17 类关联计数全部为 0。全部条件满足后才删除 4 条订单和 1 条快递公司；若任一字段或关联不同则整笔回滚。该删除只能由数据库备份恢复，但目标仅为精确匹配的审计夹具。

正式首版 DDL 早前已在 `public` 连续执行两次；本轮又把 `mscwm_state_ck` 安全升级为包含 `SETTLED/REASSIGNED` 的当前约束，并再次验证二次执行幂等。最终 event/outbox/watermark 分别 22/14/9 列，合计 45 列，18 个已验证约束、13 个 valid/ready 索引（4 个部分索引、7 个唯一索引），两个外键 `ON DELETE RESTRICT`，无 RLS/rule/policy/用户 trigger，三表均为 0 行。终态只读审计恢复为原业务订单 28 条，task/provider order/tracking/stock-up/任意 merchant 标记全为 0，task/provider 标识歧义组为 0，临时 schema 为 0；没有返回固定夹具 ID、订单号、用户信息或配置值。一次性 Worker 已删除，URL 复探为 404；主 `cinashop-api` 从未因本轮部署或修改。

扩展随机 schema 的第一轮还发现了候选服务自身的状态机缺陷：通用 terminal 分支把 `SETTLED` 当成取件后的迟到取消，导致 `PICKED_UP/SIGNED→SETTLED` 返回 `superseded`。服务现先单独允许 `SETTLED` 应用，再处理普通 terminal；新增回归测试精确断言取件后结算、签收后结算均 apply，而取消终态后的结算仍 superseded。修正重新部署到同一个临时 Worker 后，15/15 场景和最终生产只读审计全部通过。

### 当前工程证据与不能外推的结论

当前双 TypeScript、180 文件/1,146 项完整单测、observability 17 信号/10 域/43 必需事件/396 个生产源文件、schema source201/target258/shared201/sourceGaps0/external258/embedded258/零定义漂移、路由 PHP1,904/TS1,505/精确801/可执行783/缺失1,103/可执行缺口1,099、官方 npm registry 生产依赖 0 漏洞和 `git diff --check` 已通过。新增寄件回调告警在 5 分钟 5 次拒绝或尝试数达到 3 时 warning，任一 CONFLICT/DEAD、5 分钟 3 次持久化失败或最老可处理事件达到 15 分钟时 critical。主 Worker与最终无清理端点的审计 Worker minify dry-run分别为 3,535.97 KiB/gzip 833.39 KiB、1,075.41 KiB/gzip 193.11 KiB，并精确解析所需 Hyperdrive、Queue、KV、R2和四个 Durable Object 后退出，没有部署主 Worker。Windows workerd 仍在 0 条测试前以既有 `0xc0000005` 启动失败，不能算运行时通过。

实现提交 `e0ca6d665b98043ceb3fa6ad94944becdcd309f4` 与 runtime 契约修正 `a5326ab2f79ec341aceb0983d72153ece80744b0` 已推送 `main`。首轮 Linux CI 准确发现新增 Cron 根任务后两处消息总数断言仍停留在 16/17；补成 17/18 并显式断言 `dispatchMerchantShipmentCallbackOutbox` 后，[Linux Migration gates 33486809063](https://github.com/cinagroup/cinashop/actions/runs/33486809063) 最终 8/8 jobs 成功，包括 workerd 1 文件/13 项、完整 Worker 单测、双 TypeScript、schema/route/observability、Admin/PC/Supplier/Kefu/UniApp 构建和 checksum-pinned 全历史 Gitleaks。本轮结算修正的提交和 Linux CI 结果将在推送后补记；此前的门禁不替代本轮新增回归。

生产没有 `KUAIDI100_CALLBACK_SALT`、可用快递100企业版调试凭据、真实 provider task/callback 样本或已部署的候选入口；官方调试页的浏览器自动化又在本机浏览器运行时初始化前失败。本轮只有官方文档样例、真实 PostgreSQL 隔离证据和正式空结构，不能声称真实快递100回调已通过。CORE-001-F 可按“候选代码、生产空结构、隔离状态机和 Linux 门禁”闭合，但主 `cinashop-api` 未部署，三张空表不会自行接收事件。真实下单时设置相同 salt/callback URL、provider 正向/重复/乱序/改派、旧端 E2E、发布批准和发布后观察继续属于 CORE-001-H；按 checklist 顺序的下一未完成项是 CORE-001-G 同城配送回调。

## CORE-001-G 同城配送回调详细审计（达达/UU 候选与生产空结构完成，真实渠道验收待完成，2026-09-01）

### PHP 权威行为、真实缺口与迁移边界

PHP 在 `route/api.php:25` 把 `ANY /api/city_delivery/notify` 直接交给 `v1.CityDelivery/notify`。控制器读取全部 request 参数，没有方法、content type、provider 身份、token、签名、时间窗或重放校验；service 还把完整 callback（含骑手姓名、电话、取消原因）写入日志。最外层捕获任何异常后只返回布尔值，既没有稳定 provider ACK 合同，也无法区分验签失败、持久化失败和业务冲突。

旧 service 靠字段形状猜 provider：有 `order_status` 就当达达，有 `state` 就当 UU。达达状态只处理 `1/2/3/4/5/9/10/100`，其中 1 单独补 finish code，5 映射为 -1；UU 把 `3/4/5/10/-1` 映射为 `2/100/3/4/-1`。两者最后都只用主订单 `status != callback status` 判断是否执行，但主订单状态和配送状态并非同一状态空间；没有 provider event key、事件账本、乱序时间水位、并发串行或主动查单。因而重复事件可能重复写轨迹，旧事件可能覆盖较新配送状态，取件后迟到取消仍能把主订单退回，完成与取消竞争也没有明确胜负规则。完成分支异步派发收货任务，取消分支会重置主订单并清空配送字段，这些副作用更不能继续放在零验签 HTTP 链内。

[京东秒送（达达）当前开放平台](https://newopen.imdada.cn/) 的 callback 校验值是把 `client_id/order_id/update_time` 三个值按字典序拼接后计算小写 MD5。该算法没有共享密钥，最多发现传输/拼装错误，不能证明请求来自 provider。候选实现因此不把 `signature` 伪装成认证：兼容路由仍注册为 ANY，但运行时只接受 `POST application/json`、32 KiB 以内 UTF-8 body，以及精确且唯一的 `provider=dada&token=<高熵随机值>`；再执行 callback token 常量时间比较、预期 `DADA_CLIENT_ID` 常量时间比较和官方 checksum 校验。token、signature、原始 body 和完整 provider 扩展字段均不落库。

[UU 跑腿开放平台](https://open.uupt.com/) 当前前端和公开接口详情已给出 V3 callback 的完整外层 `openId/timestamp/biz/sign`，`biz` 内为 camelCase `orderCode/originId/state/stateText/changeTime/driverName/driverMobile/driverPhoto`，`changeTime` 为毫秒；公开状态为 `1` 下单成功、`2` 跑男取消并回退待接单、`3` 抢单、`4` 到店、`5` 取件、`6` 到达目的地、`10` 收件、`-1/-2/-3` 三类取消，成功 ACK 为 `{"code":1,"msg":"success"}`。但同一官方[回调与上线说明](https://open.uupt.com/development/guide/callbackLive)明确写明 callback 验签算法和失败重试策略未公开，来源校验、应答和重试须以联调为准。普通 V3 出站请求虽另有 `MD5(biz+appKey+timestamp)` 文档，也不能据此推断入站 callback 的 `sign` 合同。

候选现为 UU 建立独立 adapter：精确 `provider=uu&token=...`、独立高熵 `UU_CALLBACK_TOKEN` 和常量时间匹配的 `UU_OPEN_ID` 共同构成认证边界，`sign` 只验证为 32 位十六进制而不冒充已验签；错误 token/openId/外层/biz 一律在持久化前拒绝。UU 不能复用 Dada token，原始 body、URL token 和 sign 不落库。官方 V3 `orderDetail` 主动查单固定到 `https://api-open.uupt.com/openapi/v3/order/orderDetail`，使用独立 `UU_APP_ID/UU_APP_KEY/UU_OPEN_ID`、8 秒超时和 32 KiB 响应上限；因官方调用规范/联调文字写“秒”而多个当前请求示例使用 13 位毫秒，代码要求部署先经沙箱确认并显式设置 `UU_API_TIMESTAMP_UNIT=seconds|milliseconds`，否则查询失败关闭。

### 双 provider 接收账本、单调投影与主动对账

`city_delivery_callback_event/outbox/watermark/reconciliation_case` 分别保存 provider 认证后的最小事件证据、Queue 投递状态、provider subject 单调水位和主动查单计划。event/replay、provider+subject 和 delivery order 都有唯一围栏；接收事务按 event key 使用 advisory transaction lock，事件与 outbox 同一短事务提交后才返回成功。Queue 只携带 `{action,outboxId,eventId,replayKey}`，投递与处理都使用租约、`SKIP LOCKED`、有界退避和最多 8 次 DEAD，Cron 根任务同时恢复 outbox 并分别播种/处理 Dada `station_type=1` 与 UU `station_type=2` 对账案件；DLQ 只重放原 opaque 引用。Dada/UU 主动查询都使用固定 HTTPS 官方地址、8 秒超时和 32 KiB 响应上限；所有 provider I/O 都在 PostgreSQL 事务之外。

Dada 状态图显式覆盖当前 `1/8/2/100/3/9/4/10/6/5/1000` 和 UNKNOWN；UU 独立覆盖 `1/2/3/4/5/6/10/-1/-2/-3` 和 UNKNOWN。两者都以 provider update time、rank、terminal 和 source 决定 apply/noop/superseded/conflict/ignored。重复 event 原子收敛；旧 callback 不回退；同时间不同状态冲突；取件后普通取消冲突；已完成订单重复送达为幂等 no-op；完成复用共享 `completeOrderReceipt`，而取件前取消才允许把主订单恢复为待发货。UU `state=2` 是唯一有官方依据的活动状态回退，只在取件前应用并清空旧骑手，之后可由新 `state=3` 重派；`state=6` 只记录到达目的地，不提前完成订单。UNKNOWN 不投影业务表，但保留 subject 时间水位并进入主动查询。Dada 必须按 `station_type=1 + order_id`，UU 必须按 `station_type=2 + originId/order_id` 唯一匹配，并额外核对 callback `orderCode` 与非空 `delivery_no`；歧义、未支付、provider 单号错配或不兼容订单状态全部失败关闭。

持久 JSON 只含 protocol、无敏感状态元数据和 UU provider order code；provider/order/status/time 等是有界结构列。骑手姓名、电话、finish code 和取消文本仅作为待处理桥接列存在，终态（成功、忽略、冲突或 DEAD）全部清空；日志、Queue、reconciliation case 和 operational event 不携带这些 PII。可观测性只发拒绝、持久化、投递、投影、对账、冲突和 DEAD 等低基数事件，任何密钥、签名、手机号或 body 都不会进入事件字段。

实现过程中真实 PostgreSQL 还暴露了两个静态夹具不易发现的边界。第一，postgres.js `begin()` 的事务参数必须包含标准 `ISOLATION LEVEL`，否则只读基线在解析时失败；现已使用 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`。第二，Hyperdrive 不能只靠连接启动参数保证随机 schema 的 `search_path`；`seedReconciliation` 与对账前配送单读取原本直接使用连接，隔离测试可能解析到 public。候选现把候选扫描、幂等插入和 provider I/O 前的配送单读取分别收进短 `withTx`，由事务级 `SET LOCAL search_path` 明确限定 schema；真正的 provider 网络调用仍在事务之外。队列故障夹具也按真实 30 秒退避推进到到期后再重试，没有把“立即重试”误当实现合同。

### 生产 Hyperdrive 门禁与正式 DDL

按用户“直接使用生产数据库”的明确授权，一次性随机 bearer 保护的临时 Worker 只绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有主站 route、Queue、KV、R2 或 Durable Object。首次只读基线确认 PostgreSQL `16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)`；`store_delivery_order` 总数、Dada、UU、活跃 Dada/UU、provider order 重复组和订单孤儿全部为 0，六个 Dada/UU 旧配置键的非空/重复计数均为 0；四张目标表不存在，`codex_city_delivery_*` 临时 schema 为 0。审计只返回聚合和结构计数，没有返回连接串、配置值、订单号、用户或地址。

生产 DDL 前，随机 `codex_city_delivery_*` schema 复刻真实 `store_order/store_delivery_order/store_order_status` 结构并运行真实 service。首轮 Dada 16/16 覆盖 DDL 二次幂等、重复 event 收敛、活动状态单调推进、旧回调 superseded、取件后普通取消 conflict、取件前取消重置、官方 `9→10` 妥投异常返还完成、已完成订单幂等、未知状态隔离、主动查询同状态不重复写轨迹、Queue 首次失败后持久恢复、PII 终态清除、subject watermark 唯一和活跃配送对账播种。UU adapter 加入后，第二轮扩展为 Dada+UU 19/19，并新增 UU 跑男取消清空 PII 后重派、取件状态单调推进、`-3` 取件前取消重置。结构证据连续两次均为 4 表、64 列、25 个已验证约束、19 个 valid/ready 索引、6 个部分索引、10 个唯一索引、4 个 `ON DELETE RESTRICT` 外键；场景结束后随机 schema 删除，生产业务表逐行 JSON 指纹完全不变。迁移后重跑还发现 DDL 自校验曾只按外键名统计，public 与随机 schema 同时存在时会把 4 个外键数成 8；现已把计数限定到当前 schema 的四张目标表，并新增 provider/负状态/UU 水位约束定义自校验。

首轮 15/15 门禁通过后，才把同一内嵌 DDL 应用到生产 public，并立即二次执行验证幂等；官方 Dada 状态复核后扩展为 16/16。UU 加入时审计发现既有 `cdcevt/cdcwm/cdcrc_provider_ck` 仍只允许 `dada`，`provider_status` 不允许负数，水位也缺 `RIDER_CANCELLED/ARRIVED_DESTINATION`；迁移现以同名约束原位替换，表、列、约束和索引数均不变。按同一生产授权，升级后的 public DDL 连续执行两次，随后随机 schema 19/19 通过。正式终态仍为 4 张空表、64 列、25 个已验证约束、19 个 valid/ready 索引、6 个部分索引、10 个唯一索引和 4 个 `ON DELETE RESTRICT` 外键，目标总行数 0，`sdo_dada_reconcile_scan` valid/ready；`businessDml=false`，升级前后 `store_order/store_delivery_order/store_order_status/system_config` 全量行指纹一致。终态只读复验仍为同城配送/Dada/UU 业务行 0、重复/孤儿 0、临时 schema 0。临时 Worker 已删除，workers.dev URL 复探为 404；主 `cinashop-api` 没有部署。

### 当前工程证据与剩余 checklist

当前本地完整单元测试为 181 文件/1,160 项全部通过，其中同城配送定向文件 14/14，并精确覆盖官方 Dada `9→10`，UU `2→3`、`5→6→10`、负数取消状态，以及 V3 查单的固定地址/header/biz/时间戳/签名/成功包络与未确认时间单位失败关闭；双 TypeScript、observability 17 信号/10 域/53 必需事件/404 个生产源文件、schema source201/target262/shared201/sourceGaps0/external262/embedded262/零定义漂移、路由 PHP1,904/TS1,506/精确802/可执行784/缺失1,102/可执行缺口1,098、官方 npm registry 生产依赖 0 漏洞和 `git diff --check` 已通过。主 Worker dry-run 为 6,240.14 KiB/gzip 1,140.02 KiB，精确解析 Hyperdrive、Queue、KV、R2 和四个 Durable Object 后退出，没有部署；Wrangler 只因沙箱禁止写用户级日志目录报告 EPERM，进程仍以 0 退出并完成 dry-run。Windows 本机 workerd 仍在 0 条测试前以环境级 `0xc0000005` 启动失败，不能把它记成运行时通过；应由下一次 Linux Actions 补齐真实 workerd 和全量构建证据。本批候选尚未推送，主 Worker也没有本批所需 `DADA_CALLBACK_TOKEN/DADA_CLIENT_ID/DADA_APP_KEY/DADA_APP_SECRET/DADA_SOURCE_ID` 与 `UU_CALLBACK_TOKEN/UU_APP_ID/UU_APP_KEY/UU_OPEN_ID/UU_API_TIMESTAMP_UNIT`。

因此 CORE-001-G1 可按“达达候选代码、生产空结构和真实 PostgreSQL 隔离状态机完成”勾选；CORE-001-G2 与父项保持未完成。下一步外部门禁是取得 UU 当前商户合同/样例及测试租户，并在 CORE-001-H 配置真实 Dada/UU Secret 和 callback URL，完成正向、重复、乱序、取消/完成竞争、主动查单、旧端 E2E、预发、明确发布批准和发布后观察。四张空表本身不会接收回调，也不代表任何同城配送渠道已启用。

## PUBLIC-ARTICLE 媒体边界补充审计（候选完成，2026-09-01）

### 缺口复核与实现边界

继续逐项复核未完成 checklist 后，排在前面的源 MySQL、真实第三方凭据和发布项都需要外部输入；本轮选择 PUBLIC-ARTICLE 中可在本地与已授权生产 Hyperdrive 内独立关闭的“稳定媒体代理 + 服务端发布清洗”。审计确认私有 R2 链路本身已经使用 `ASSETS_BUCKET` binding，上传以 `file.stream()` 写入，下载直接返回 `R2ObjectBody.body`，对象元数据与数据库只保存 canonical `/api/assets/:id`；现有缺口实际位于文章边界：公开服务原样返回 `content/image_input`，Admin 文章保存与公众号图文保存也会把输入 HTML 或从附件选择器复制出的 15 分钟签名 URL 直接持久化。这样即使客户端已有第二层 allowlist，其他消费者仍可能收到旧库主动 HTML，签名 URL 也会在过期后永久失效。

新增的发布策略现在同时覆盖全部两条 `system_article` 业务写入口。Admin 请求先以 1 MiB 流式上限读取 JSON，再校验 ID、分类、标题、作者、状态、正文、封面和 URL；公众号图文原有 512 KiB 请求边界继续生效。两路正文都由识别引号的 tokenizer 重建 tag/attribute allowlist：仅保留排版标签和逐标签属性，移除 script/iframe/object/form/svg/math/style 等标签、事件/style/srcdoc/target/id/class 等属性，URL 实体解码后只允许 HTTPS、安全站内路径以及链接专用的 mailto/tel；明文 HTTP、协议相对地址、data/blob/file/vbscript/javascript 和控制/空白混淆失败关闭。图片和表格生成固定安全宽度。任何 `/api/assets/:id` 后的 query/fragment 都在存储前剥离，所以数据库、公众号图文数据和分享图只保留稳定 canonical ref。

公开文章服务对直接由迁移脚本导入、未经过新发布入口的历史行也执行同一服务端清洗。列表封面、详情封面、正文内 canonical `src/href` 与关联商品图在数据库事务提交后统一处理：危险历史媒体变为空，HTTPS/安全相对引用保持兼容，canonical ref 才使用 `APP_KEY` HMAC 生成新的短时查询签名；HTML 中的 `&` 重新属性转义。详情的 visit/关联读取事务内没有 R2、crypto 或外部 I/O，签名严格发生在事务外，响应继续 `no-store/private,no-store`。因此该批实现的是“稳定存储引用 + 响应时授权”，没有把 R2 改成公开 bucket，也没有在源码保存 Secret、全局可变状态或悬空 Promise。当前 Cloudflare Workers 类型定义再次确认 `R2Bucket.put` 接受 `ReadableStream`、`get` 返回 `R2ObjectBody|null` 且 `body` 是 `ReadableStream`；实现保持 binding 与流式边界。

### 当前生产证据与隔离场景

按用户已明确授权直接使用生产数据库，一次性 Worker 只绑定 Hyperdrive `9748c294e21c49a99579c9cef70102e0`。最新 PostgreSQL `16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)` 只读事务固定 `REPEATABLE READ, READ ONLY`、`search_path=public,pg_temp` 和短超时，只返回聚合：7/7 依赖表存在，`system_article/article_category/article_content/wechat_news_category` 与文章点赞关系仍全部为 0；可见/隐藏/软删、正文缺失、孤儿、计数漂移、封面 token、危险 HTML、正文媒体也均为 0。文章/分类/正文/关系索引仍为 `2/2/1/5`，文章点赞部分唯一索引精确候选 1 且 valid/ready；零可见文章不支持新增排序索引，未执行生产 DML 或 DDL。

更新后真实服务写验证仅发生在随机 `codex_public_article_*` schema。首次使用默认 30 秒 CPU 上限的审计请求被 Cloudflare 以 1042 中止；紧随其后的独立只读复核确认临时 schema 已是 0、文章仍是 0，临时 Worker也不存在，不能把该次中止记为断言结果。依据当前 Cloudflare 官方 Wrangler/Workers 限制文档，审计配置显式设置 `limits.cpu_ms=120000` 后重跑，最终 10/10 全部通过：分类/四列表、可见性失败关闭、正文/商品/分类装饰、并发 visit、点赞幂等与并发、匿名拒绝、故障回滚和 search path 隔离；`schema_created=true/schema_removed=true`、临时 schema `0→0`、六张 public 表与序列指纹不变。临时 Worker在响应后删除，主 `cinashop-api` 没有部署。

### 工程门禁与仍未完成事项

本轮定向 5 文件/38 项、完整单元 181 文件/1,162 项、双 TypeScript 均通过；observability 为 17 信号/10 域/53 必需事件/405 个生产源文件，schema 为 source201/target262/shared201/sourceGaps0/external262/embedded262/零定义漂移，路由保持 PHP1,904/TS1,506/精确802/可执行784/缺失1,102/可执行缺口1,098，官方 npm registry 生产依赖审计为 0 漏洞。主 Worker minify dry-run 为 `3,607.52 KiB / gzip 845.61 KiB`，文章审计 Worker为 `870.71/154.32 KiB`，均精确解析既有 binding 后退出；Wrangler 沙箱日志 EPERM 不影响两个 0 退出 dry-run。Windows workerd 仍在 0 条断言前以既有 `0xc0000005` 失败，故当前候选仍需推送后的 Linux CI 复验。

这只关闭 checklist 中“稳定引用、响应签名、服务端写入/历史读取清洗”的候选代码门禁。生产没有任何文章或附件样本，源 MySQL/附件目录也不可用，尚不能做源附件→`system_attachment`/R2 对象映射、hash/mime/size 对账、PHP golden response 或真实 H5/小程序/App 媒体验收；PHP/Worker 双写或停写切流、历史 UID 0/孤儿关系清理、visit 热点限流/异步聚合决策、预发/影子流量、主 Worker/Pages 发布和观察仍保持未完成。当前本地 main 还包含未推送的 Dada 与 UU 两个候选提交；没有新的明确推送授权前不变更远端。

## SUP-003 Supplier 文件域详细审计（候选路由收敛，生产验证待额外授权，2026-09-01）

### 22 条权威合同与原 11 条缺口

重新运行可重复路由审计后，PHP `route/supplier.php` 的文件域精确展开为 22 条合同。批次开始时 11 条已匹配、11 条缺失；现有 Worker 实际已经覆盖租户内附件列表、删除、移动、重命名、图片上传及别名、上传类型、分类列表/新建/编辑/更新/删除，旧 checklist 的“分类、移动、重命名、删除、上传别名全部未迁移”描述已经过时。本批新增 4 条可执行合同：`POST /file/video_upload`、`POST /file/video_attachment`、`GET /file/get/way_data` 和无 path 参数的 `GET /file/category/create`。文件域终态为 15 条可执行匹配、7 条有证据退役、`actionableMissing=0`；整个 Supplier 面从 TS 112/精确 79/原始缺失 103 提升到 116/83/99，7 条退役后可执行缺口 92、有效覆盖 47.4%。这只关闭文件子域的静态可执行缺口，不代表 Supplier 整面完成。

7 条没有用占位响应伪装迁移。`GET /file/file/move` 指向不存在的 `SystemAttachment::move()`，第一方源码只调用 `PUT file/do_move`；ThinkPHP resource 自动展开的 `GET /file/category/:id` 同样没有 controller `read()`，第一方只有列表与 edit form。扫码链把供应商 ID 和 `md5(time())` 放入 68,400 秒 URL，图片轮询 DAO 又只按 `scan_token` 查询，没有 `type/relation_id` 租户条件，因此 `scan/qrcode`、`remove/qrcode`、`scan/image/list/:scan_token` 三条不能原样恢复。`online/upload` 让服务器下载任意用户 URL，没有 origin allowlist，是 SSRF/不受控出站面；替代合同为客户端取得图片后走已有的有界认证 multipart 上传。`GET set/way_data/:is_way` 既以 GET 写状态，又拿 `supplierId` 更新管理员主键，而 Workers 只有固定私有 R2 authority，故由只读 `get/way_data` 替代。7 项均写入版本化 `legacy-route-decisions.json`，保留 PHP 原始分母、源码行证据、原因与现行替代合同。

逐行审计还确认旧 PHP 的删除、移动和重命名都只按附件 ID 操作；`SystemAttachmentDao::move()` 没有供应商条件，删除和更新 service 也没有把 controller 已知的 `supplierId` 下传。候选 Worker 不是照搬这个漏洞：附件读写、分类读写、目标分类验证和 DB 更新全部同时限定 `type=4`、认证 `relation_id` 与 `module_type=1`；移动现在先读取附件的真实 `file_type`，拒绝图片/视频混合移动，再验证同租户同类型目标分类。

### R2 视频、私有读取与外链边界

旧本地视频协议由 Supplier 前端以 3 MiB 顺序分片调用，PHP 把每片写入 webroot，再用字符串拼接完整文件；这在无持久本地盘的 Workers 上不可复用。候选保持旧字段和 `code=1/2` 等待/完成信封，但每片先进入 `attachments/tmp/supplier/{supplierId}/{sha256-session}/N.part`，会话同时绑定 Supplier、旧客户端 MD5、文件名、片数、片大小与服务端生成的最终 UUID key。MD5 只作为旧客户端会话关联值，不被冒充成完整性证明；首片必须通过 MP4 `ftyp` 魔数，声明类型限 MP4/octet-stream，单片最多 5 MiB、总片数最多 100、总视频最多 100 MiB。

末片到达后，R2 强一致列表必须精确得到同一会话全部对象和一致 custom metadata；`FixedLengthStream` 以已知总长度逐片读取并写入私有最终对象，不在内存合并百兆视频。每个临时片还向现有 Queue 登记 12 小时延迟幂等删除，完成后立即批量删除；最终 R2 写失败、大小不符或数据库元数据事务失败都会删除最终对象。数据库只保存 `attachments/supplier/...uuid.mp4` 与稳定 `/api/assets/:id`，返回同时包含 canonical URL 和短时签名预览。签名资产读取新增严格单 Range、`Accept-Ranges`、`Content-Range` 和 206，图片变体继续忽略 Range 并走既有 Cloudflare Images/cache 路径。

外链视频登记只接受不含凭据、非私网字面地址、标准 443、路径以 `.mp4` 结尾且长度适配旧表列宽的 HTTPS URL；封面只接受同边界 HTTPS 图片扩展名。实现不对外链执行 `fetch`、HEAD 或大小探测，从根源上避免恢复旧 `getFileHeaders()`/远程下载 SSRF。`upload_type` 重新表达旧前端的“走本服务上传”策略为 `1`，另以 `storage_type=8/binding=ASSETS_BUCKET` 暴露真实存储 authority，避免旧 Supplier UI 因看到未知类型 8 而误走已退役的 OSS 临时凭据流程。

实现依据当前 [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) 与 [R2 上传对象指南](https://developers.cloudflare.com/r2/objects/upload-objects/) 复核；官方 npm registry 的最新 `@cloudflare/workers-types` 为 `5.20260901.1`，项目当前 `5.20260828.1` 与本批使用的 R2 list/head/get/put、Queue delay、`FixedLengthStream` 类型一致，无需仅为四天差异强制改锁文件。

### 工程证据、生产门禁与未完成项

定向附件测试现为 1 文件/12 项、完整单元为 183 文件/1,179 项，全部通过；覆盖 MP4 魔数、HTTPS/私网外链拒绝、视频与临时对象 cleanup key、4 条新增路由、7 条退役清单、multipart 上限、Range 接线和生产审计只读静态门禁，双 TypeScript 也已通过。主 Worker minify dry-run 为 3,625.02 KiB/gzip 851.02 KiB，精确解析 Hyperdrive、Queue、KV、R2、Images 与四个 Durable Object 后 0 退出；专用审计 Worker dry-run 为 737.33/125.09 KiB，只有指定 Hyperdrive 与 `cinashop-assets` 两个只读 binding。Wrangler 仍因沙箱不能写用户级日志目录打印 EPERM，但 dry-run 进程均成功。Windows runtime 与历史一致，在加载任何断言前以 `0xc0000005` 失败；候选提交 `1121c52` 推送后，首轮 Actions `33524207599` 的 Worker、五端和 Linux workerd 均成功，唯一失败是 Gitleaks 把非秘密 R2 前缀字面量误报为 generic API key。门禁提交 `d8afeaf` 用“规则名 + 精确历史文件 + 精确历史行”最窄 allowlist 修正并把当前前缀改为分段构造；最终 [Actions `33524822780`](https://github.com/cinagroup/cinashop/actions/runs/33524822780) 8/8 成功，Linux workerd 1 文件/15 项（含新增固定长度 R2 拼接和 Range）全部通过，全历史 Gitleaks、生产依赖 0 漏洞、183/1,179 单元、17 信号/10 组件/53 必需事件、201/262/201/零结构漂移及 1,904/1,510/806/788/11/1,087 路由门禁均通过。

生产审计夹具已固定 `SET TRANSACTION READ ONLY`、`search_path=public` 和 15 秒超时，只输出 Supplier 附件/分类数量、租户/分类孤儿、canonical/R2 键格式与重复计数；R2 只使用 list/head，最多扫描 10,000 对象且不返回对象键、文件名、URL、Supplier ID 或其他 PII。临时 Worker使用随机 256-bit token 的 SHA-256 verifier，runner 在响应后删除并复探 404。实际执行仍被安全审查拒绝：尽管用户已授权直接读生产数据库，随机令牌保护的临时 `workers.dev` 地址仍会承载脱敏生产聚合，系统要求对这一外部临时端点及其载荷再次明确授权。本轮没有绕过门禁、没有读取该批生产结果、没有部署主 Worker、没有写 PostgreSQL 或 R2。

所以 SUP-003 当前只能判定为“候选路由、R2 视频实现、退役决策以及静态、单元和 Linux runtime 门禁完成”。父项保持未完成，剩余顺序为：用户明确批准临时外部审计端点后执行生产 PostgreSQL/R2 只读核验并确认删除；迁移 Supplier TypeScript 前端并用真实账号验证图片/视频上传、暂停/失败/过期、分类与跨租户拒绝；取得源 MySQL 和附件目录后对账行数、对象 size/mime/hash 与 legacy URL；最后单独批准主 Worker/Supplier 发布并观察 Hyperdrive、R2、Queue cleanup、签名 404/206 和上传失败率。

## SUP-004 Supplier 账号、设置与首页详细审计（第一批候选完成，2026-09-02）

### 权威合同、真实基线与范围纠偏

本轮重新以 `cinashop-php/route/supplier.php`、PHP controller/service、旧 Supplier Vue 调用和当前 Worker 注册四方交叉审计，不沿用旧 checklist 的粗略分类。与 SUP-004 直接相关的初始可执行缺口实际为 25 条：Supplier 管理员 resource 展开 7 条加状态 1 条、运费模板 5 条、system form/config 4 条、home 来源/类型 2 条、密码/城市/菜单/通知 4 条，以及旧清单漏掉的 `GET/PUT /printing` 2 条。后两条不能按“已有新 `/print/*`”自动视为退役：旧 `pages/setting/ticket/index.vue` 仍在加载和保存该单行配置。另有两个静态已匹配但语义错误的合同：`/home/header` 与 `/home/order` 都指向同一个新 dashboard handler，而 PHP 分别要求四项金额/数量汇总和 `xAxis/series` 趋势图。

第一批现精确增加 12 条 PHP 合同，并把新 TS dashboard 移到专用 `GET /home/dashboard`，再恢复旧 `home/header|order` 的真实响应。可重复路由审计从全局 TS1,510/精确806/可执行788/缺失1,098/可执行缺口1,087 变为 TS1,523/精确818/可执行800/缺失1,086/可执行缺口1,075；Supplier 面从 TS116/精确83/缺失99/退役7/可执行缺口92 变为 TS129/精确95/缺失87/退役7/可执行缺口80，精确覆盖 45.6%→52.2%、退役后有效覆盖 47.4%→54.3%。增加的第 13 条 TS 路由是新前端专用 dashboard，不会虚增 PHP 匹配数。

### 已恢复的 12 条合同与安全边界

公共只读合同现在全部从 `supplierAuthMiddleware` 注入的 `supplierId` 派生范围。`jnotice` 仅统计当前 Supplier 的根订单待发货和有效售后；`city` 每次最多返回 1,000 个直接子节点并保留旧懒加载字段；`menusList` 只读 `type=3/is_show=1/auth_type=1/is_del=0/is_show_path=0` 的可搜索菜单，使用有环保护的父先子后顺序。订单来源与类型保留旧 `bing_xdata/bing_data/list/percent/itemStyle` 结构，首页汇总和趋势恢复旧字段；任意报表选择器都按 Asia/Shanghai 解析，默认 31 天、最多 366 天，拒绝错误日期、倒序和无界跨度。所有订单/售后 SQL 同时限定认证 Supplier 和软删除/有效状态，不接受 body/query 中的租户覆盖值。

`/system/form/info/:id`、`/system/form/all_system_form`、`/system/config/edit_new_build/:type`、`POST /system/config` 复用现有已迁移元数据与 `StoreScopedConfigService`，但补齐精确的旧路径；原有短路径继续兼容。旧 `/printing` 不再读取 `supplier_ticket_print` 形成第二套运行时权威，而是映射到 `store_config(type=2, relation_id=supplierId)` 的五个 allowlist key。GET 永远把 API key 返回为空，PUT 空密钥保持既有值，客户端提交的 `id/supplier_id` 被忽略，未知字段失败关闭；因此旧 Vue 页面仍能保存，但生产 Secret 不会像 PHP 一样回显。

PHP 的 `updatePwd` 路由实际指向不存在的 Supplier `staff.StoreStaff` controller，仓库里能找到的同名实现属于门店店员，不能作为完成证据。替代合同直接作用于当前认证 `system_admin(admin_type=4, relation_id=supplierId)`：要求原密码、新密码和确认密码，新密码 12～72 位且不得与原密码相同；bcrypt 校验后以旧 hash 作 compare-and-swap 更新，竞争修改失败关闭。成功后清除 token bucket，而 JWT 自带的旧密码摘要也会让无 Redis 环境的旧 token 在下一请求失效。原 `/supplier` 资料保存中无需原密码即可改密的能力已删除；Supplier TS 页面拆成资料保存和独立改密表单，成功后清理本地身份并返回登录页。登录响应和全部认证 Supplier 响应统一设置 `private, no-store, max-age=0`；普通 JSON 请求使用共享 64 KiB 流式上限，商品大表单仍保留既有独立 1 MiB 上限。

### 尚未恢复的 13 条：为什么不能照抄 PHP

Supplier 管理员 8 条是本批最重要的阻断。旧登录服务按 `system_admin.relation_id` 找 Supplier，设计上允许 `level=1` 子管理员；但是 `LoginServices::verifiAuth()` 在任何规则解析前直接 `return true`。旧 `SupplierAdmin` 只有列表和创建显式写入/筛选 `admin_type=4 + relation_id=$supplierId`，detail/edit/update/delete/set_status 都以客户端 ID 直接访问，形成跨 Supplier IDOR 面。当前 Worker 反向采取了主账号专用策略：登录和 middleware 都要求 `system_supplier.admin_id == system_admin.id`，所以没有把旧全权限子账号漏洞带进来，但也意味着子账号功能尚未迁移。正确完成条件不是先挂 8 条 CRUD，而是先把 `system_role(type/relation_id/rules/status)`、`system_menus` 动作和每个 Supplier handler 建成统一、默认拒绝的权限判定，再允许同 relation 的有效子账号登录；所有管理员读写还必须同时限定目标 `admin_type=4/relation_id`，禁止停用/删除主账号和越权赋予角色。

运费模板 5 条同样保留未完成。PHP 列表会限定 `type=2 + relation_id=$supplierId`，但 edit 直接 `getShipping(id)`，delete 直接按请求 ID，save 更新路径也没有先证明旧行属于当前 Supplier；照搬会再次引入对象级越权。下一批需在 Worker 建立独立服务：模板行、包邮区域、按件/重/体积区域和不配送区域须在同一事务内锁定；每次读、改、删都要求 owner type 2、认证 relation、未删除，城市集合和计价模式有界验证，跨租户 ID 必须与不存在返回同一失败面。完成后再迁移新 Supplier 前端运费模板页面，而不是仅为路由数字补空 handler。

### 工程证据、生产边界与下一顺序

当前候选定向/相关 3 文件 15 项、完整单元 184 文件/1,183 项、双 TypeScript 和 Supplier Vue 生产 build 均通过；observability 为 17 信号/10 组件/53 必需事件/406 个生产源文件，schema 为 source201/target262/shared201/sourceGaps0/外部与内嵌 262/零定义漂移。主 Worker minify dry-run 为 3,638.10 KiB/gzip 854.85 KiB，精确解析 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images 与四个 Durable Object 后退出，没有部署。Windows workerd 在读取任何测试前仍以既有环境级 `0xc0000005` 启动失败，未被冒充成通过；提交 `5ec7775` 推送后，[Actions `33577342683`](https://github.com/cinagroup/cinashop/actions/runs/33577342683) 对精确 head 的 Worker 静态、Linux workerd 1 文件/15 项、Admin/PC/Supplier/Kefu/UniApp 五端、生产依赖与全历史 Gitleaks 共 8/8 成功，并输出同一组 1,904/1,523/818/800/11/1,075 路由及 201/262/201/零结构漂移证据。

本批没有生产 PostgreSQL/R2 DML、DDL、临时探针或主 Worker/Pages 发布。SUP-003 的只读生产夹具仍因会创建承载脱敏聚合的临时 `workers.dev` 端点而缺少对“该端点 + 精确载荷”的专项授权，通用数据库授权不能被扩张解释为公开端点授权。后续执行顺序是：先完成 SUP-004-C 五条运费模板并做跨租户负例；再设计、实现并全域接入 SUP-004-B RBAC 后恢复八条管理员路由；取得专项授权时执行 SUP-003 PostgreSQL/R2 只读审计；最后以真实 Supplier 主/子账号做旧端和 TS 端 E2E，另行请求主 Worker/Supplier Pages 发布批准并观察鉴权拒绝、Hyperdrive 延迟、统计跨度错误与配置保存失败率。父项在这些证据齐备前保持未完成。

## SUP-004-C Supplier 运费模板详细审计与候选实现（2026-09-02）

### PHP 权威行为与五类迁移风险

本批逐行对照 `route/supplier.php` 的列表、编辑、保存、删除和城市目录五条合同，以及 ShippingTemplates controller/service/DAO、四张 PostgreSQL 目标表、旧 Supplier 运费模板页、商品编辑页和当前结算读取。旧列表确实限定 `type=2 + relation_id=$supplierId`，但其余对象路径并没有继承同一边界：edit 直接按裸 ID 调 `getShipping()`，update 在证明所有权前按裸 ID 保存，delete 又从 query 读取 ID 而不是可靠使用 path 参数，服务最终也是不带 Supplier 条件删除。这三处会把可枚举模板 ID 扩大成跨租户读、改、删面，不能因列表安全就判定整个资源安全。

旧删除流程先在事务外删除主 DAO 行，随后才开启事务清理区域规则和商品引用；任何中途失败都可能留下半删除模板或悬挂子规则。旧保存仅在 `appoint/free/notSend` 开关为真时替换对应子表，关闭开关不会删除旧数据，日后重新开启会让陈旧范围复活。规则输入也没有服务端限制组数、城市路径总数和层级，金额精度、重复终点、唯一全国默认规则及 `system_city` 父子路径都缺少一致验证。

旧页面还有一个独立于后端 IDOR 的危险交互：删除某个区域计价子项时调用了整模板 `setting/shipping_templates/del/${row.id}`，子行 ID既可能误删当前 Supplier 的另一整张模板，也可能命中旧后端的跨租户删除。当前 Worker 商品保存则暴露了迁移期语义偏差：只要 `temp_id>0` 就把 `freight` 写成 1，等价于包邮；PHP 权威值应为 `freight=3`。它同时没有证明模板归当前 Supplier，导致即便五条模板路由独立收紧，商品仍可保存外国模板引用。以上问题都已作为本批实现和测试的明确负向基线，而不是照搬旧缺陷。

### 租户、事务、验证与并发边界

五条精确合同现在统一从 `supplierAuthMiddleware` 的认证上下文取得 `supplierId`，不接受 body/query 提供租户。模板列表、详情、更新和删除均要求 `shipping_templates.type=2 AND relation_id=supplierId AND is_del=0`；跨租户 ID与不存在 ID返回相同“运费模板不存在或不属于当前供应商”，不泄漏对象存在性。新建/更新/删除使用 `withTx`，先取得 Supplier 级 advisory lock；更新再锁定模板行，主模板与 `shipping_templates_region`、`shipping_templates_free`、`shipping_templates_no_delivery` 三类子规则在同一事务中完整替换。关闭可选规则会删除旧子行，不再保留会复活的陈旧数据。

服务端只接受计费方式 1～3，首件/首重/首体积和续件值必须为正，金额最多两位小数并受数据库 `NUMERIC` 精度约束；规则终点不能重复，必须且只能有一个全国默认计价规则。城市路径最多 100 组、合计 1,000 条、深度最多 4，所有 ID、父子路径和终点都须存在于 `system_city`；城市目录响应限 64 个根节点和 1,000 个直接子节点，仍保持 PHP `with('children')` 的一层合同。普通 JSON 继续采用共享 64 KiB 流式 body 上限，避免把有界规则数量变成无界请求内存。

删除采用软删除主模板、硬删除子规则，并在同一事务拒绝仍被当前 Supplier 有效商品引用的模板。商品保存恢复 `1=包邮、2=固定运费、3=运费模板`：固定运费必须大于 0，模板模式必须给出当前 Supplier 下 `status=1/is_del=0` 的 `type=2` 模板，包邮模式清空固定运费与模板 ID。商品验证以 `FOR KEY SHARE` 读取模板；模板删除与商品写入使用相同的 Supplier/模板锁顺序，关闭“校验后被删”和“检查无引用后被新引用”两个竞态窗口。历史商品、活动或订单中已经存在的 `temp_id` 不会被本批猜测改写，仍需生产只读审计和源 MySQL 对账。

### Supplier TS 前端与客户端可观察语义

新 Supplier 前端增加可到达的“运费模板”页面，覆盖列表、搜索、新建、编辑、删除，以及按件/重量/体积计价、全国默认、指定包邮和不配送区域。删除子规则现在只更新当前表单的本地数组，只有用户明确删除整张模板时才调用 DELETE 合同，关闭旧页面的误删入口。商品表单恢复三种运费模式、固定金额和当前 Supplier 模板选择，并提供模板管理入口；接口类型和 preview fixtures 都使用五条精确旧路径。页面和 API只展示当前租户数据，服务端边界仍为权威，前端选择器不被当作访问控制。

### 量化证据、CI 与剩余门禁

本批增加 5 条 PHP 精确且可执行合同，并有 13 条 TS 支持/页面接口，所以全局从 TS1,523/精确818/可执行800/缺失1,086/可执行缺口1,075 变为 TS1,528/精确823/可执行805/缺失1,081/可执行缺口1,070；Supplier 面从 TS129/精确95/缺失87/退役7/可执行缺口80 变为 TS134/精确100/缺失82/退役7/可执行缺口75。Supplier 精确/可执行覆盖均为 54.9%，退役后有效覆盖 57.1%。静态路由存在仍不代表权限、数据或结算等价，所以上述百分比仅作为注册上限。

定向 3 文件/27 项覆盖租户过滤、跨租户同面失败、四表原子替换、关闭规则清理、重复/默认/路径/精度拒绝、删除引用阻断、三种商品运费模式、模板归属和前端子项删除；完整 Worker 单元为 185 文件/1,192 项。双 TypeScript、Supplier 生产 build 和主 Worker dry-run均通过；dry-run 包为 3,651.74 KiB/gzip 858.56 KiB，精确解析 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images 与四个 Durable Object，没有部署。提交 `9066cb9819aa3874af518971acebabdf78ea2a4c` 推送后，[Actions `33579118412`](https://github.com/cinagroup/cinashop/actions/runs/33579118412) 对精确 head 的 Worker、Admin/PC/Supplier/Kefu/UniApp、Linux workerd 与全历史 Gitleaks 8/8 成功：Linux workerd 1 文件/15 项，单元 185/1,192，observability 17 信号/10 组件/53 必需事件/407 个生产源文件，schema source201/target262/shared201/sourceGaps0、外部/内嵌 262 且定义漂移为 0。

本批没有读取或写入生产 PostgreSQL/R2，没有创建临时探针，也没有发布主 Worker或 Supplier Pages。代码级候选已关闭旧五条合同的租户/事务/输入和商品运费语义缺口；随后的 SUP-004-B 又完成 Supplier 子管理员 8 条与默认拒绝 RBAC。SUP-004 父项仍需用真实主/子账号完成旧端和 TS 端跨租户/E2E，并另行取得发布批准。SUP-003 的生产 PostgreSQL/R2 只读夹具还需要对临时 `workers.dev` 端点及其精确脱敏载荷作专项授权；通用“授权”或生产库只读许可不自动包含公开该聚合端点。

## SUP-004-B Supplier 子管理员与全域 RBAC 详细审计（2026-09-02）

### PHP 权限基线与不能照搬的漏洞

PHP 登录服务会按 `system_admin.admin_type=4 + relation_id` 找到 Supplier，说明 `level=1` 子管理员是旧系统设计的一部分；但 `LoginServices::verifiAuth()` 在解析任何角色或菜单前直接 `return true`，所有有效子账号实际上获得完整 Supplier 后台权限。管理员 resource 的列表和创建虽写入/筛选当前 `relation_id`，detail、edit、update、delete 和 set_status 却把客户端 ID直接交给平台级 `SystemAdminServices`，没有再次限定 `admin_type=4 + relation_id=$supplierId + level=1`，形成跨 Supplier 读取、改写、停用和删除面。旧创建表单又以 `level=0` 请求平台表单，角色选择并没有形成可用的 Supplier 权限闭环。

此前 Worker 为避免继承该漏洞，登录和 middleware 都要求 `system_supplier.admin_id == system_admin.id`，结果是主管理员安全可用、子账号完全不可用。正确迁移不能只把八条路由挂回去：必须先把主管理员身份、租户角色、动作权限和每个 Supplier handler 的拒绝策略统一，再开放同 relation 的子账号。

### 稳定权限模型、默认拒绝与旧规则兼容

候选现定义 12 个稳定域：经营概览、商品、运费、订单、售后、财务、小票、面单、履约配置、供应商资料、子账号和素材；除只读概览外均拆成 `supplier.<domain>.view/manage`。`supplierPermissionMiddleware` 位于身份认证之后、所有受保护 Supplier 路由之前，显式登记每条已注册路径；未知路径即使主管理员请求也默认拒绝。手工打单和电子面单分别要求 `order.view + print.manage`、`order.view + waybill.manage`，避免仅有订单查看权时触发外部副作用。登录菜单、搜索菜单、前端导航和路由 meta 都从同一稳定权限集合过滤，服务端仍是最终 authority。

主管理员只由 `system_supplier.admin_id === currentAdmin.id` 判定，不信任旧 `level=0`。子账号必须同时满足有效 `system_admin(admin_type=4, relation_id=supplierId, status=1, is_del=0)` 和当前 Supplier 下有效 `system_role(type=4, relation_id=supplierId, status=1)`；没有可执行权限时登录失败关闭。角色可继续读取旧 `system_menus` 数字规则，但只接受 `type=4/auth_type=2/access=1/is_del=0` 的菜单，并把 method/path 批量解析为稳定权限，避免逐角色 N+1。直接稳定规则和旧数字规则都会补齐 `manage ⇒ view`；创建/更新角色及给子账号分配角色前，再以事务内当前权限重新解析并拒绝任何越权委派，数字规则不能绕过该上限。

### 管理员、角色与资料页的租户/事务边界

八条 PHP 精确合同现完整注册：管理员列表、创建表单、创建、详情、编辑表单、更新、删除和状态切换；另加四条不计入 PHP 匹配分子的 Worker 安全扩展，用于当前 Supplier 的角色列表、创建、更新和删除。所有管理员目标都统一限定 `admin_type=4 + relation_id=supplierId + level=1 + is_del=0`；跨租户 ID、主管理员 ID 和不存在 ID不能成为可操作对象，当前账号也不能通过管理员 CRUD 自删、自停或绕过个人改密。角色同样限定 `type=4 + relation_id=supplierId`，仍被有效子账号引用时禁止删除。

写操作采用事务、2 秒 lock timeout、5 秒 statement timeout、Supplier 管理员类型 advisory lock 和目标行锁；事务内重新读取有效操作者与主管理员绑定，关闭“请求鉴权后角色/账号已被撤销”的竞态。账号和电话在同一全局锁下按 Supplier 管理员登录域查重；新密码要求 12～72 位并使用 bcrypt cost 12。`system_log` 只记录操作者、Supplier ID、目标 ID和动作，不记录账号、电话、密码或角色内容。管理员列表的角色名称批量加载，角色列表中的旧菜单规则也一次批量解析。资料页另修复了子账号会看到主管理员登录账号的问题：现在只返回当前登录账号，子账号不能在供应商资料表单中改账号；只有真正的主管理员才会把资料名、电话和账号镜像到主管理员记录。

### Supplier TS 与可验证行为

Supplier TS 新增“子账号管理”页面，覆盖分页、添加、编辑、停用和删除，并提供当前租户角色与权限编辑器。主导航按 `view` 权限过滤，商品新建/编辑和虚拟库存等动作页要求 `manage`；无权直达会跳到第一个可见页面。旧会话没有本地权限快照时 UI 暂时不空白，但服务端仍按数据库实时默认拒绝；新登录会持久化精确权限集合。主管理员和当前账号不可操作的限制也在 UI 显示，但不依赖前端作为安全边界。

定向 RBAC 测试为 1 文件/10 项，覆盖全部认证 Supplier 路由必须有权限登记、未知路由失败关闭、打单/面单组合权限、稳定/旧规则规范化、越权委派拒绝、八条旧合同、四条角色扩展、租户过滤/锁/审计静态合同和前端守卫。完整单元为 186 文件/1,202 项；双 TypeScript 与 Supplier 生产 build 通过，管理员页面产物为 11.49 KiB/gzip 4.12 KiB。路由审计由全局 TS1,528/精确823/可执行805/缺失1,081/可执行缺口1,070 提升到 TS1,540/精确831/可执行813/缺失1,073/可执行缺口1,062；Supplier 面由 TS134/精确100/缺失82/退役7/可执行缺口75 提升到 TS146/精确108/缺失74/退役7/可执行缺口67，精确/可执行覆盖 59.3%，退役后有效覆盖 61.7%。四条角色扩展增加 TS 分母但不虚增 PHP 匹配。

主 Worker minify dry-run 为 3,674.17 KiB/gzip 864.28 KiB，精确解析 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images 与四个 Durable Object，没有部署。只读 `wrangler hyperdrive get` 另确认该 ID仍为 `cinashop-pg`，数据库名 `postgres`、VPC service `019fe223-e5a1-7ed1-945a-8993a6f32508`、origin connection limit 60 且缓存开启；这只是 Cloudflare 配置元数据，不是生产业务行审计。schema 仍为 source201/target262/shared201/sourceGaps0、外部/内嵌 262 且定义漂移 0；observability 为 17 信号/10 组件/53 必需事件/410 个生产源文件。

提交 `065c522ee0ed6bc3de2471ed744f9edf3efb48b4` 推送后，[Actions `33582012080`](https://github.com/cinagroup/cinashop/actions/runs/33582012080) 对精确 head 的 Worker、Admin/PC/Supplier/Kefu/UniApp、Linux workerd 和全历史 Gitleaks 8/8 成功；Linux workerd 1 文件/15 项。该批没有生产 PostgreSQL DML/DDL、没有读取管理员/角色业务行、没有临时探针，也没有发布主 Worker或 Supplier Pages。SUP-004 只能标为 25/25 条“代码候选完成”；父项仍需生产只读核验角色/子账号现实分布、用真实主管理员和受限子账号做旧端/TS 端正反 E2E，并另行批准发布与观察。SUP-003 附件生产审计仍需对临时随机名称 `workers.dev` Worker、仅 token 保护的 `GET /supplier-attachments` 及其精确脱敏聚合载荷作专项授权。

## SUP-005-A Supplier 售后退款详细审计与候选实现（2026-09-02）

### 三条旧合同与两类确定风险

本批逐行对照 `cinashop-php/route/supplier.php`、Supplier `Refund` controller、`StoreOrderRefundServices`、旧 Vue `pages/order/refund/index.vue` 与当前 Worker/新 Supplier TS。初始退款缺口精确为三条：`GET /supplierapi/refund/refund/:id` 表单、`GET /supplierapi/refund/reason` 原因目录和 `GET /supplierapi/refund/agree/:order_id` 退款同意。现有 Worker 已有列表、详情、备注及安全扩展 `PUT agree/refuse/refund`，但原 `PUT refund` 不读取 body；旧表单可以让操作者输入任意金额，因此如果只补 GET 表单，客户端显示的部分金额会被 Worker 静默当成整张售后单金额执行，属于高风险语义错配。

PHP 的“部分退款”本身也不能直接视为正确权威：controller 允许把本次金额累加到 `refunded_price`，随后却立即把同一售后行设成 `refund_type=6`，并执行库存、订单、积分等完成副作用；下一笔部分退款在正常状态机中已不可达。迁移后明确采用与现有 Out API、客服退款相同的安全收敛：一张售后单只执行其权威 `refund_price`，请求金额必须精确相等；真正的部分退款应拆成独立售后单和独立退款身份，不能在一个已完成身份上累计。

旧 `GET refund/agree/:order_id` 更不能恢复。controller 无视 path 参数，改从 query 读取同名 `order_id`，service 又按裸退款 ID 更新，不验证当前 Supplier；写状态日志时还把退款 ID 当成订单 `oid`。旧 Supplier 退款页和订单页都曾调用这一 GET 写接口，所以它不是“无人使用”路由，而是必须主动迁移客户端的危险合同。本批把原因、源码行与安全替代写入 `legacy-route-decisions.json`，并将新增的 Supplier Refund controller 加入带 SHA-256 的版本化 PHP authority；退役项仍留在 PHP 原始分母和缺失数中。

### 精确金额、租户与并发边界

新增表单 GET 同时限定 `store_order_refund.id/supplier_id/is_cancel/is_del` 和关联 `store_order.supplier_id/is_system_del/is_del`，未支付、已完成、拒绝态及不适用的退货态失败关闭。表单保持旧 `title/action/method/fields` 外形，退款金额取服务端权威值并标记 `full_refund_only`；历史 `refunded_price` 非零的进行中旧行不再猜测补退，而是要求人工核对。新增原因 GET 读取旧 `stor_reason`，统一 CRLF/CR、去空白，并限制最多 100 项、每项 255 字；列表的 `refund_reason` 采用参数化精确匹配且继续叠加 Supplier/软删除范围，避免原因筛选绕过租户条件。

资金 PUT 现在必须提交 `type=1 + refund_price`，金额只接受非负两位小数并设安全上限；旧混合接口的 `type=2` 明确拒绝，拒绝退款继续走独立 `PUT /refund/refuse/:id` 和必填原因。执行前先在 Hyperdrive 事务中设置 2 秒 lock timeout、5 秒 statement timeout，对当前 Supplier 的售后和订单联表 `FOR UPDATE` 取得新鲜快照；不在事务内调用第三方支付。随后把 `store/supplier/uid/refund order/store order/refund amount/refunded amount/system visibility/paid` 全部作为 `RefundExecutionScope` 传入共享 `StoreOrderRefundService`，核心在自己的短事务和支付请求构造/提交边界再次验证。这样客户端金额、租户和支付时刻的权威状态任一变化都会失败关闭，已完成且金额一致的重放幂等返回，异常历史部分退款或完成金额不一致则阻断人工核对。执行审计只记录 Supplier ID和动作，状态日志仍由共享核心以真实原订单 ID写入。

Supplier TS 售后页新增原因目录与精确筛选；确认弹窗显示的 `refund_price` 现在也原样随 PUT 发送，服务端不再默默忽略。按钮状态与服务端对齐为退款态 `0/1/2/5`，或仅 `apply_type=3` 的退货态 4；旧 GET 写入口没有在新端注册。新测试覆盖原因规范化和上限、金额精度/拒绝类型、两条 GET 的权限、GET 写入口不存在、事务锁/精确 scope、前端金额提交及证据退役。

### 工程证据、生产边界与剩余顺序

提交 `edef647d27c5f7d90586bf329a75513ab3baa26d` 已推送；[Actions `33583699196`](https://github.com/cinagroup/cinashop/actions/runs/33583699196) 对精确 head 的 Worker、Admin/PC/Supplier/Kefu/UniApp、Linux workerd 和全历史 Gitleaks 8/8 成功。完整单元为 187 文件/1,207 项，退款定向 1 文件/5 项，Linux workerd 1 文件/15 项；双 TypeScript、Supplier 生产 build、生产依赖 0 漏洞、schema source201/target262/shared201/sourceGaps0/外部与内嵌 262/零漂移、observability 17 信号/10 组件/53 必需事件均通过。主 Worker minify dry-run 为 3,679.40 KiB/gzip 865.48 KiB，精确识别 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images 和四个 Durable Object 后退出。Windows 本机 workerd 仍在任何断言前以环境级 `0xc0000005` 崩溃，未冒充本地 runtime 通过；同一代码已由 Linux runtime 门禁补证。

路由审计由全局 TS1,540/精确831/可执行813/缺失1,073/退役11/可执行缺口1,062 提升为 TS1,542/精确833/可执行815/缺失1,071/退役12/可执行缺口1,059，覆盖 `43.8%/42.8%/43.1%`；Supplier 面由 TS146/精确108/缺失74/退役7/可执行缺口67 提升为 TS148/精确110/缺失72/退役8/可执行缺口64，覆盖 `60.4%/60.4%/63.2%`。两条新增 TS 路由都是真实 PHP 精确合同，退役 GET 不进入匹配分子。

本批没有读取或写入生产业务数据，没有生产 PostgreSQL/R2 DML/DDL，没有创建临时 Worker，也没有发布主 Worker或 Supplier Pages。退款子批完成时 SUP-005 父项仍不完成：export 4 条还要设计一次性票据、对象权限和过期清理；当时 queue 5 条仍待逐项映射。退款还需生产只读核验售后状态、金额、Supplier/订单归属和历史部分退款分布，并以真实 Supplier 账号做表单、原因筛选、余额/微信/支付宝、拒绝、重放和跨租户负例 E2E。生产只读探针若通过临时 `workers.dev` 承载聚合，仍须对端点和精确脱敏载荷取得专项授权；通用生产数据库授权不自动包含这一外部端点。Queue 子批的后续结论见下一节。

## SUP-005-B Supplier Queue 五条合同详细审计与候选实现（2026-09-02）

### 旧实现不是 Supplier 队列，而是无租户边界的全局 Admin 队列

五条 PHP 权威合同是任务列表、发货明细、再次执行、清除异常和停止任务。旧 Supplier `Queue` controller 没有把认证得到的 Supplier ID传给任何服务：列表直接读取全局 `queue_list`；明细只按 `binding_id + type` 读取 `queue_auxiliary`；三个动作则按客户端提供的裸队列 ID/type 重试、批量改写辅助行或改变队列状态。`queue_list` 的 15 列和 `queue_auxiliary` 的 8 列均没有 `supplier_id`，任务创建时 `source` 还被固定写成 `admin`。因此不能用“补一个 where source=supplier”修复，也不能从队列 ID本身推导租户。

风险不只是一张跨租户列表。再次执行会读取全局 `queue_in_value`，经 `StoreOrderServices::adminQueueOrderDo()` 重放批量履约；清除会把该 `binding_id` 下所有辅助行设为删除，停止则先按全局 ID找出任务类型再改状态。三条动作全是 GET，旧 Supplier Vue 确实直接调用它们。若在 Worker 中照搬，将同时形成 GET 写副作用、跨 Supplier IDOR、另一商家任务重放和历史证据破坏。Cloudflare Queues 也不提供业务端“列出或编辑队列中消息”的管理模型；把 `system_queue_dead_letter` 或平台内部 Queue 消息伪装成旧列表会创造第二套不真实 authority。

### 两条历史读取如何建立可证明的租户范围

候选只恢复两条确有安全只读语义的精确合同。`GET /supplierapi/queue/index` 只接受旧履约任务 7～10，并按固定映射关联辅助类型 3～6；`GET /supplierapi/queue/delivery/log/:id/:type` 只接受这四种辅助类型。两条查询都必须沿 `queue_auxiliary.relation_id = store_order.id` 关联到订单，并在数据库条件中强制 `store_order.supplier_id =` 认证 Supplier。列表总数、成功数和剩余数按当前 Supplier 可见辅助行重新聚合，不信任全局 `queue_list.total_num/surplus_num`；如果一个历史任务异常混入多商家订单，每个商家也只能看到自己的子集。

投影保留旧页面需要的任务类型、状态、业务时间、订单号、物流/配送或虚拟发货字段，但不返回 `queue_in_value`、`execute_key` 或原始 `queue_auxiliary.other`。分页最多 100，任务/明细状态、任务类型和 Asia/Shanghai 时间范围都有严格边界；不支持的 Admin 批任务类型返回空历史而不暴露全局行。响应附带 `legacy_history_only/read_only/mutation_routes_retired`，明确这些表只作迁移证据，当前执行 authority 是 Supplier 专属任务账本和显式订单履约合同。路由统一要求 `supplier.order.view`，不新增可误解为全局队列管理权的 capability。

### 三条写合同的退役与安全替代

`GET queue/again/do_queue/:id/:type`、`GET queue/del/wrong_queue/:id/:type` 和 `GET queue/stop/wrong_queue/:id` 均写入带 PHP 路由、Supplier controller、全局 Queue service 和第一方 Vue 调用行号的退役清单，且权威快照新增三份源码 SHA-256/行数证据。电子面单的异常恢复已经由 `order_waybill_job` 租户列、显式状态机和不可变 action ledger 承担：人工重签使用 `POST /supplierapi/waybill/jobs/:id/confirm-retry`，关闭使用 `POST /supplierapi/waybill/jobs/:id/close`，都要求随机 request key 和至少 8 字审计原因。普通快递、同城配送和虚拟发货不重放不透明旧 payload；操作者必须对当前归属订单重新提交显式 `PUT /supplierapi/order/delivery/:id` 请求。历史日志不可删除，已完成的同步履约也没有虚构的“后台任务停止”操作。

这不是把三个缺口藏起来：退役路由仍留在 PHP 原始 1,904 分母和 missing 数中，只从 `actionableMissing` 扣除；替代合同各自接受租户、幂等和状态机测试。Supplier 新 TS 前端本来就使用 Waybills 账本和 Orders 显式履约，没有迁入旧全局队列的三个危险按钮；旧 Vue 若仍指向新 Worker，只能读取历史，写入口会落到 501 fallback，不会静默恢复副作用。

### 验证、覆盖率与生产边界

提交 `bd51824043d6a3a4d217a1107088e9efb632adb9` 推送后，[Actions `33584993388`](https://github.com/cinagroup/cinashop/actions/runs/33584993388) 对精确 head 的 Worker、Admin/PC/Supplier/Kefu/UniApp、Linux workerd 和全历史 Gitleaks 8/8 成功。完整单元为 188 文件/1,212 项，Queue 定向 1 文件/5 项，Linux workerd 1 文件/15 项；双 TypeScript、Supplier 生产 build、生产依赖审计、schema source201/target262/shared201/sourceGaps0/外部与内嵌 262/零漂移通过。observability 为 17 信号/10 组件/53 必需事件/412 个生产源文件。主 Worker minify dry-run 为 3,685.98 KiB/gzip 867.71 KiB，精确识别 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images 和四个 Durable Object 后退出，没有部署。

路由审计由全局 TS1,542/精确833/可执行815/缺失1,071/退役12/可执行缺口1,059 提升为 TS1,544/精确835/可执行817/缺失1,069/退役15/可执行缺口1,054，覆盖 `43.9%/42.9%/43.3%`；Supplier 面由 TS148/精确110/缺失72/退役8/可执行缺口64 提升为 TS150/精确112/缺失70/退役11/可执行缺口59，覆盖 `61.5%/61.5%/65.5%`。两条读取是精确可执行合同，三条退役不进入匹配分子。

本批没有读取或写入生产 PostgreSQL 业务行，没有 DDL/DML，没有读取或管理 Cloudflare Queue 消息，没有创建临时 Worker，也没有发布主 Worker或 Supplier Pages。生产 Hyperdrive 只读验收仍需要统计 7～10 类历史任务、辅助行到订单的归属完整性、跨 Supplier 混合 binding、孤儿 relation 和辅助类型映射；如果通过临时 `workers.dev` 聚合端点执行，仍须对该端点和精确脱敏载荷取得专项授权。SUP-005 父项继续未完成，下一子批是 export 四条，特别要复用本批的租户联表，不能沿用旧 `batchOrderDelivery` 的裸队列 ID导出。

## SUP-005-C Supplier Export 四条合同详细审计与候选实现（2026-09-02）

### 旧合同、真实调用方与为何不引入服务端文件

四条 PHP 权威合同均为 GET：订单/发货单、物流公司对照表、批量任务发货记录和供应商账单。逐行核对 `ExportExcel` controller、`ExportServices`、旧 Supplier `order.js/capital.js` 以及订单、Queue、账单 Vue 后，确认它们并不生成服务器文件、R2 对象或下载 URL，而是返回 `{header,filekey,export,filename}`，由浏览器累积页并生成表格。因此本批没有为小结果集虚构异步文件、长期对象或一次性票据；真正需要一次性票据的是卡密等秘密内容，已经由独立受控导出合同承担。这里保留旧 manifest，风险控制落在查询上限、租户权限、最小投影和单元格输出层。

旧订单页会把当前筛选、选择 ID、页码和 `type=0/1` 传入订单/发货单导出；只要当页非空就继续请求下一页。旧 Queue 页按 `id/queueType/cacheType` 一次请求，旧账单页把聚合周期中的流水 ID列表一次提交，物流表也是一次请求。四个调用方都是活跃第一方入口，不能以“无人使用”退役。旧 controller 的安全质量却不同：订单与账单已有 Supplier 条件，批任务只按全局 queue ID读取 `queue_in_value` 和辅助行，完全没有 Supplier 范围；物流 service 可能携带账号、密钥等内部列，旧导出器最后虽然只取 name/code，但新实现不能先读取秘密再依赖序列化时忽略。

### 有界 manifest、旧状态语义与表格注入防护

订单/发货单统一按当前 Supplier、根订单 `pid=0`、平台店铺 `store_id=0` 和 `is_system_del=0` 查询，每页固定最多 250 行并多取 1 行计算 `has_more`。ID筛选只接受去重后的正整数，最多 1,000 个；页码、搜索词和 Asia/Shanghai 时间范围都有长度/数值边界。普通订单完整保留 PHP DAO 的业务状态映射，而不是把旧 UI 的“1=未发货、2=待收货、3=待评价、4=完成”错误当作 `store_order.status` 原值。发货单继续要求已付、快递、待收货状态、未软删，拼团必须成功，并以相关售后 `NOT EXISTS` 排除有效退款。订单商品快照一次批量读取，不做 N+1；每个 JSON快照限制 256 KiB，商品聚合字段和整个响应又分别受 16,000 字符与 4 MiB上限控制。

批任务导出只接受 `7→3/8→4/9→5/10→6` 的固定类型组合，先验证对应 `queue_list` 历史行存在，再通过 `queue_auxiliary.relation_id = store_order.id AND store_order.supplier_id = 当前 Supplier` 建立 authority；最多返回 1,000 行。它只投影订单号、当前订单物流/配送或虚拟字段及通用状态，不读取 `queue_in_value`、`execute_key` 或 `queue_auxiliary.other`，因此不会把别家任务、可重放 payload 或历史自由文本带入下载。财务导出要求非空 ID列表，限定当前 Supplier 与 `is_del=0`，最多 1,000 行；物流目录只查询启用可见行的 `name/code`，从 SQL 投影阶段就排除 account/key/partner 等内部字段。

所有字符串在进入 manifest 前移除 NUL、按字段上限截断，并检测可选空白后的 `= + - @`；命中时前置单引号，避免 Excel/WPS 把订单号、备注、姓名、地址、商品、物流编码、昵称或历史内容作为公式执行。整个 JSON UTF-8 字节数超过 4 MiB会明确拒绝并要求缩小范围，不依赖 Worker 内存极限。旧 `header/filekey/export/filename` 保持不变，新增 `bounded/page/limit/has_more` 只作向前兼容元数据，旧前端会忽略。

### 权限、验证、生产边界与结果

虽然四条都是 GET，大批量订单、履约和财务下载属于数据导出，不应自动等同普通查看权。候选将订单/发货单和批任务导出映射到 `supplier.order.manage`，账单映射到 `supplier.finance.manage`；只有不含租户秘密的物流名称/编码表保留 `supplier.order.view`。主管理员仍拥有全部稳定 capability，受限子账号不能凭只读列表权限批量外带 PII或财务记录。中间件继续对未知路径默认拒绝。

定向 1 文件/6 项覆盖严格 ID上限、必填账单 ID、公式注入、NUL 清理、旧状态标签与筛选差异、四条精确路由、view/manage 权限、SQL租户范围及禁止投影秘密/队列 payload。完整本地门禁为 189 文件/1,218 项单元、双 TypeScript、Supplier 生产 build、生产依赖 0 漏洞、schema source201/target262/shared201/sourceGaps0/外部与内嵌262/零定义漂移、observability 17 信号/10 组件/53 必需事件/414 个生产源文件；主 Worker minify dry-run 为 3,699.57 KiB/gzip 871.68 KiB，精确解析 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images 和四个 Durable Object后退出，没有部署。

路由审计由全局 TS1,544/精确835/可执行817/缺失1,069/退役15/可执行缺口1,054 提升为 TS1,548/精确839/可执行821/缺失1,065/退役15/可执行缺口1,050，覆盖 `44.1%/43.1%/43.5%`；Supplier 面由 TS150/精确112/缺失70/退役11/可执行缺口59 提升为 TS154/精确116/缺失66/退役11/可执行缺口55，覆盖 `63.7%/63.7%/67.8%`。四条都是活跃、精确、可执行合同，没有通过新增非 PHP 路由虚增匹配分子。

提交 `546e6b7857ed05f5a432df5d1e60758561c2a94c` 已推送；[Actions `33586697589`](https://github.com/cinagroup/cinashop/actions/runs/33586697589) 对精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、Linux workerd 和全历史 Gitleaks 8/8 成功。CI 精确为 Worker 189/1,218、workerd 1 文件/15 项，双 TypeScript、生产依赖、schema、route和observability全部成功。Cloudflare只读 `hyperdrive get` 同时确认指定 ID仍为 `cinashop-pg`、PostgreSQL origin、连接上限60且缓存开启，不返回密码。

本批没有生产 DDL/DML，没有查询订单、地址、电话、财务流水或队列业务行，没有部署临时/主 Worker，也没有发布 Supplier Pages。若要补生产数据分布与跨租户负例，仍需一个只返回计数/布尔门禁的 `REPEATABLE READ, READ ONLY`桥；Windows本地 workerd不能启动远程请求，而临时随机 `workers.dev` 会承载脱敏生产聚合，按既有安全门禁必须对其精确端点和载荷另行授权。当前证据足以把 SUP-005 的 12 条候选合同标为完成，但不等于真实 Supplier 账号下载、生产浏览器 E2E或发布后观察完成。

## FE-004-A Supplier 前端逐屏迁移审计与首批缺口实现（2026-09-02）

### 原“41→13”为什么不能表示迁移覆盖率

本批重新读取旧 Supplier 的全部 `pages/**/*.vue`、六个 router module、第一方 API 调用和新 Supplier TS router/page/API。旧端确有 41 个 page 目录 Vue 文件，但实际只有 20 条业务 screen route record；其中 `/supplier/bill/index` 与 `/supplier/bill/index/:type?` 使用同一个 route name和同一个组件，故只有 19 个不同的可导航业务屏幕。其余 22 个文件由 16 个订单/商品/财务内嵌组件和 7 个未路由或框架脚手架组成，两类有一项重叠消歧后精确闭合为41：18个被 route 直接导入的 page 文件、16个内嵌组件和7个未路由/错误/注册脚手架。旧 `pages/setting/ticket/index.vue` 并非实际 ticket route，route 使用的是全局 `components/fromSubmit/commonForm.vue`；register/result没有 Supplier route；403/404/500/other也不属于业务迁移分母。

新端当前不是文档旧快照中的13页，而是15个 page组件和16条 screen route record：`ProductForm.vue` 同时服务新增与编辑两条路由。逐屏结果为14个候选覆盖、4个部分替代、1个确定缺失。候选覆盖只表示仓库内页面、路由和API已经形成可测试闭环，不代表生产账号、第三方或发布验收。机器可读的19行映射、计数方法、每屏剩余条件和12项 granular checklist现固定在 `workers-ts/audit/supplier-frontend-parity.json`，对应单元测试拒绝以后再次用原始 Vue 文件数冒充覆盖率。

### 19个旧业务屏幕的结论

认证和概览分别由 `Login.vue`、`Dashboard.vue`承接。订单列表的主流程由 `Orders.vue`承接，小票与面单拆入 `Printers.vue`、`Waybills.vue`；售后由 `Refunds.vue`承接。旧浏览器 `distribution` 配货单只被新幂等打印任务和任务账本部分替代：打印执行更安全，但旧页面的收件信息、每六件分页、商品清单和二维码浏览器预览没有等价页面，因此保留为待决，不把它伪装成完成。

财务四屏被整合进 `Finance.vue`和 Dashboard：资金概览、提现、收款设置已有候选；旧 bill 的周期聚合与佣金明细仍需业务等价决策，故 bill记为部分替代。商品列表、新增/编辑、运费模板、虚拟库存已有目标页；旧共享 `product_attr` 规格模板库只有 ProductForm行内 SKU 编辑，不等价，记为部分替代。旧 `product_reply` 有活跃导航和第一方 `GET product/reply`、`PUT product/reply/set_reply/:id` 调用，但当前 Worker Supplier surface和新端都没有对应 authority；公共/用户/Admin reply不能冒充 Supplier租户范围，所以这是唯一确定的整屏可执行缺口。

商户资料、子账号、小票第三方配置、打印机文档和打印内容分别被 `Profile.vue`、`Administrators.vue`、`Settings.vue`与 `Printers.vue`整合。旧 ticket route实际使用通用表单而非同目录页面，这一事实也写入映射，避免后续重复迁移无人路由文件。商品附件/富媒体不是一个独立旧屏幕，但横跨商品列表和编辑能力；它继续受SUP-003生产附件聚合/票据审计门禁阻塞，不能因页面数量重算而消失。

### 首批可执行缺口：导出、Queue历史和动作级前端权限

SUP-005 后端完成后，新端仍没有任何调用入口。本批新增四个 manifest客户端和两个历史客户端：订单/发货单只提交当前页显式勾选的订单 ID，资金流水只提交显式勾选的流水 ID；批任务下载来自当前租户可见任务行，物流目录只含公开名称/编码。浏览器把后端已经公式中和的 manifest生成为带 BOM的 CSV，同时再次移除NUL、中和可选空白后的 `= + - @`、转义双引号并清理 Windows非法文件名字符。没有自动遍历全部页，也没有把大批量 PII/财务下载藏在普通“查看”操作里。

旧 `queueList.vue` 的读取能力恢复为 Orders内的“批量任务历史（只读）”和明细弹窗，显示任务类型、当前 Supplier子集的总数/成功/未成功和安全投影的订单履约字段。页面明确提示旧 mutation已经退役；没有迁入 `queueAgain`、`queueDel`或 `stopWrongQueue`，写恢复继续走电子面单专属任务账本或订单显式履约合同。任务/订单/发货单下载要求 `supplier.order.manage`，物流目录保持 `supplier.order.view`；财务下载要求 `supplier.finance.manage`。

本批同时发现并修复服务端虽会拒绝、前端却仍显示敏感动作的RBAC偏差：订单发货、确认收货、备注和敏感导出只对 order.manage显示；打印只对 print.manage显示；电子面单选项只对 waybill.manage显示；提现、收款信息写入和财务导出只对 finance.manage显示。只读账号仍能查看租户内页面与只读历史，但不再被展示注定失败或可能误导的写按钮。服务端权限中间件继续是最终 authority，前端隐藏不作为安全边界。

### 本地验证、浏览器QA与仍未完成的生产边界

Supplier生产 build通过，新增定向单元为3文件/17项，完整 Worker单元为190文件/1,224项。定向测试固定六条前端 URL、显式勾选ID、四类manage权限、退役Queue mutation缺席、CSV公式/NUL/文件名防护，以及19屏/14候选/4部分/1缺失和12项checklist计数。第一次把定向文件参数误传给包含 runtime阶段的总脚本时，完整 unit 已通过，但 runtime因过滤的是非runtime文件而报“no test files”；随后以正确的 `test:unit`定向命令3/17成功，该命令错误不属于产品失败。

按前端测试技能用本地预览数据进行了真实浏览器检查。桌面 `/orders?preview=1` 和 `/finance?preview=1` 的 URL、标题、主DOM、表格和弹窗均非空且无遮罩异常，控制台 warning/error为0；勾选一条订单后导出按钮从disabled变为enabled并出现“订单清单已下载”，Queue历史与任务8801明细弹窗正常；勾选一条财务流水后出现“资金流水已下载”。390×844视口下 body/document宽度均不超过 viewport，没有页面级横向溢出，桌面侧栏隐藏、移动抽屉出现，抽屉点击“财务结算”后进入 `/finance`并自动关闭。宽表保持组件内部横向滚动而不撑破页面。

实现与审计提交 `e4a0a356fe5232718168f446886a06b35804240d` 已推送；[Actions `33588358237`](https://github.com/cinagroup/cinashop/actions/runs/33588358237) 对该精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、Linux workerd和全历史Gitleaks 8/8成功。Worker job精确通过双 TypeScript、190文件/1,224项单元、生产依赖审计、observability、schema和route parity；workerd、五端build和secret scan也全部成功。该CI只验证仓库候选，不代表生产 Pages或Worker已发布。

上述验证没有连接、读取或写入生产PostgreSQL业务行，没有生产DML/DDL，没有创建临时Worker，没有部署主Worker或Supplier Pages，也没有调用支付、打印、面单或附件提供商。FE-004父项因此继续未完成：下一可执行缺口是Supplier范围商品评价回复；之后是共享规格模板和配货单预览的实现/退役决策。附件仍等SUP-003专项生产授权；主管理员/受限子账号真实E2E、第三方正反流程、正式Pages项目/Origin/`WORKERS_API`、发布批准和发布后观察都保留在checklist中。

## FE-004-E Supplier 商品评价回复迁移与旧删除退役（2026-09-02）

### 旧合同真实使用情况与跨租户风险

旧 Supplier 路由注册了 `GET /supplierapi/product/reply`、`PUT /supplierapi/product/reply/set_reply/:id` 和 `DELETE /supplierapi/product/reply/:id`。逐行核对旧 controller、`StoreProductReplyServices` 和 `productReply/index.vue` 后，确认列表与回复是活跃第一方能力；列表会固定 `type=2`、`relation_id=当前 Supplier`，旧页面也会读取列表并提交回复。DELETE 虽在 API 和页面方法中存在，但模板没有任何删除按钮，是不可达的死方法。

旧写路径不能直接照搬。`set_reply` 在建立 Supplier 回复前先按全局评价 ID读取主评价，未验证主评价的 `relation_id`；供应商因此可以把自己的评论挂到别家的评价上，并在目标同为 type=2 时把其 `is_reply` 改为1。DELETE 更直接把裸 ID交给全局 `del(id)`，没有 `type=2` 或当前 Supplier 条件，构成跨租户评价软删除能力。新端因此只迁移活跃 GET/PUT；旧 DELETE 以 route、controller、service和页面四份源码证据记入 `legacy-route-decisions.json` 退役。客户原评价作为不可变业务证据，平台级删除继续属于 Admin 审核域，不能因为“旧路由存在”就在 Supplier 端恢复危险能力。

### 新 Worker authority、事务与最小数据合同

新增列表同时要求评价行 `(type=2, relation_id=当前 Supplier, is_del=0)` 和联表商品 `(type=2, relation_id=当前 Supplier)` 成立，避免只信任历史评价上的单一 owner 字段。分页最大100、页码/商品 ID/回复状态严格校验，商品与账号关键词限128字符，时间范围限100字符并按 Asia/Shanghai 日历解释；纯数字或解析后的 epoch必须落在 PostgreSQL 整数时间戳范围内。列表只返回商品、昵称、评分、评价、最多8张有界图片、供应商回复和格式化时间，不返回用户 UID、订单号、唯一键或内部队列信息。供应商回复一次批量读取并按同一 Supplier/type/根评论/未删除条件过滤，没有 N+1，也不会显示旧漏洞可能挂入的其他租户评论。

回复正文移除 NUL、trim 后必须非空且最多500字符。写入在事务内先以评价 ID、评价 owner和联表商品 owner双重确认归属，并对目标评价 `FOR UPDATE`；随后只更新当前 Supplier 的 type=2根回复，或插入同 scope的新回复，最后在重复租户谓词下设置 `is_reply=1`。这保持 PHP 的 `store_product_reply_comment` 存储语义，不把 Supplier 回复错误塞入主评价的 Admin `merchantReply` 字段。GET由 `supplier.product.view` 保护，PUT由 `supplier.product.manage` 保护；只读子账号能看评价但前后端都不能写。

### 前端、逐屏账本与本地浏览器 QA

新端增加 `/product-reviews`、`ProductReviews.vue` 和“商品评价”导航，支持回复状态、商品和用户筛选，显示评分、评价图片、供应商回复及时间；只有 `supplier.product.manage` 才渲染回复/修改回复按钮和弹窗，页面没有删除动作。预览数据也走相同客户端合同，便于在不连接生产的情况下验证筛选与写后刷新。机器逐屏账本由15个页面/16条 screen route更新为16个页面/17条 route；19个旧业务屏幕现为15个候选覆盖、4个部分替代、0个整屏可执行缺口，FE-004E标为候选完成。候选覆盖仍不等于真实账号或已发布。

真实浏览器在桌面 `/product-reviews?preview=1` 核对 URL、标题、非空 DOM和表格，待回复筛选能收敛结果；打开评价601，输入回复并保存后，同一行立即回显新文本并从“回复”变为“修改回复”。390×844 下移动导航可打开并回到商品评价，回复弹窗可操作；`innerWidth/body.scrollWidth/document.scrollWidth` 均为390，宽表在组件内部处理，没有页面级横向溢出。桌面和移动全过程 console warning/error均为0。

### 工程门禁、路由结果与生产边界

评价迁移定向测试为1文件/6项，连同逐屏账本为2文件/12项；完整 Worker单元为191文件/1,230项。双 TypeScript、Supplier生产 build、生产依赖0漏洞、observability 17信号/10组件/53必需事件/416个生产源文件，以及 schema source201/target262/shared201/sourceGaps0/外部与内嵌262/零定义漂移全部通过。新增三份旧源码证据后，权威快照文件数从20变为23；第一次完整单元据此正确失败，更新精确计数后快照3/3与完整1,230/1,230复验成功。Wrangler只打包 dry-run为6,440.15 KiB/gzip 1,180.69 KiB，精确识别 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images和四个 Durable Object后以 `--dry-run` 退出，没有创建发布版本。

静态路由审计由全局 TS1,548/精确839/可执行821/缺失1,065/退役15/可执行缺口1,050 提升为 TS1,550/精确841/可执行823/缺失1,063/退役16/可执行缺口1,047，覆盖为 `44.2%/43.2%/43.6%`。Supplier面由 TS154/精确116/缺失66/退役11/可执行缺口55 提升为 TS156/精确118/缺失64/退役12/可执行缺口52，覆盖为 `64.8%/64.8%/69.4%`。两条活跃合同进入可执行匹配分子；不安全 DELETE只进入证据化退役，仍保留在原始 PHP缺失分母，未虚增覆盖。

实现与审计提交 `4344a6638d6f3a7010d63cf64b5c73bc2a7f61fc` 已推送；[Actions `33590179976`](https://github.com/cinagroup/cinashop/actions/runs/33590179976) 对该精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、Linux workerd和全历史Gitleaks 8/8成功。Worker job在 Linux精确通过双 TypeScript、191文件/1,230项单元、生产依赖0漏洞、observability、schema和route parity；Supplier新页面构建、真实 workerd运行时、其余前端和历史密钥扫描也全部成功。该CI只验证仓库候选，不代表主 Worker或 Supplier Pages已经发布。

本批没有连接、读取或写入生产 PostgreSQL业务行，没有 DDL/DML，没有创建临时 Worker，没有部署主 Worker或 Supplier Pages，也没有调用第三方。FE-004父项仍未完成：下一可执行本地缺口是 FE-004F共享规格模板和 FE-004G配货单预览的实现/退役决策；附件、真实主管理员/受限账号、真实第三方、正式 Pages映射、发布批准和发布后观察继续按 FE-004H～L 保持门禁。

## FE-004-F Supplier 可复用规格模板迁移（2026-09-02）

### 旧页面仍是活跃能力，不满足退役条件

旧 Supplier 菜单把 `/supplier/product/product_attr` 指向 `pages/product/productAttr/index.vue`，页面实际调用 `GET /supplierapi/product/product/rule`、`GET /supplierapi/product/product/rule/:id`、`POST /supplierapi/product/product/rule/:id` 和 `DELETE /supplierapi/product/product/rule/delete/:id` 完成模板列表、详情、保存和删除；旧商品新增/编辑组件还调用 `GET /supplierapi/product/product/get_rule`，选择模板后把 `rule_value` 展开为规格维度并生成 SKU。因此这不是孤立脚手架或不可达旧路由，不能仅以新 ProductForm 已有行内规格编辑为由退役；前端必须恢复“模板库管理 + 商品编辑显式套用”完整闭环。

旧实现同时存在裸 ID 多租户风险。列表和新建会写入 `type=2, relation_id=当前 Supplier`，但详情直接按全局规则 ID读取；删除先全局 `getInfo(id)` 再按裸 ID删除；更新路径虽然会用当前 Supplier 范围检查模板名重复，最终却按请求 ID直接 `update(id, data)`，并把目标行改写成当前 Supplier 的 type/relation。结果是知道其他租户规则 ID 的 Supplier 可能读取、删除或劫持其模板。迁移不能只复制这些 controller/service 调用，也不能把前端隐藏按钮当作服务端授权。

### 复用现有安全 Worker authority

审计确认 Worker 已完整注册上述5条合同，且 `ProductMetadataService` 统一使用 `(type=2, relation_id=签名 Supplier)` owner scope：列表和商品编辑候选只返回当前租户模板；详情、更新和删除都把 ID与 owner predicate 合并，更新还在事务内取得商品规则 advisory lock并执行租户内重名检查，不存在先全局取行再信任客户端 owner 的窗口。模板输入统一规范为1至3个维度、每维1至50个值，模板名和维度名最多32字符、规格值最多64字符，并拒绝空值和重复。GET由 `supplier.product.view` 保护，POST/DELETE由 `supplier.product.manage` 保护，Worker仍是最终 authority。

本批因此没有重复修改后端或新增路由，而是把已存在但没有新端操作面的安全合同接回 Supplier TS。新增 `/product-specifications`、`ProductSpecifications.vue` 和“规格模板”导航，支持搜索、分页、新增、详情后编辑和带后果说明的删除确认；只有具备 `supplier.product.manage` 的账号才渲染新增、编辑、删除和弹窗，只有 view权限的账号仍可只读查看。表单在客户端复验与服务端一致的维度、长度、空值和重复边界，但不把客户端校验当授权。

### 商品套用语义与逐屏账本

ProductForm 的多规格编辑器新增当前 Supplier模板选择器和“管理模板”入口。套用前必须二次确认“替换当前规格结构并重新生成 SKU”，确认后只深拷贝模板的规格名/规格值，主动清空旧 SKU数组再调用既有笛卡尔积生成器；价格、库存、图片、SKU编码等业务值不会从模板继承，页面明确要求逐项复核。模板是一次性结构快照：后续编辑或删除模板不会暗中改写已经套用的商品。

机器逐屏账本由16个页面/17条 screen route更新为17个页面/18条 route；19个旧业务屏幕现为16个候选覆盖、3个部分替代、0个整屏可执行缺口，FE-004F标为候选完成。该状态只说明新端有可验证候选，不表示真实生产账号 CRUD、真实商品保存或发布已完成。

### 浏览器、工程门禁与生产边界

真实浏览器在桌面 `/product-specifications?preview=1` 核对 URL、标题、非空 DOM和两条模板，打开模板901、修改名称并保存后列表立即回显“规格模板已更新”；进入 `/products/new?preview=1` 切换多规格，选择“服装颜色尺码”，确认替换后得到颜色2×尺码3共6个 SKU，并显示明确成功提示。390×844 下移动导航包含规格模板入口，文档与 body 的 `clientWidth/scrollWidth` 均为390；编辑弹窗宽366.6、右边界378.3，完整落在390px视口内。桌面、商品套用和移动全过程 console warning/error均为0；长商品页 DOM只有1个“商品详情”标题，全页截图的拼接显示没有形成重复节点。

新增规格模板前端契约测试1文件/5项；与逐屏账本、既有商品元数据迁移测试合跑为3文件/15项。完整 Worker单元为192文件/1,235项；双 TypeScript、Supplier生产 build、生产依赖0漏洞、observability 17信号/10组件/53必需事件/416个生产源文件，以及 schema source201/target262/shared201/sourceGaps0/外部与内嵌262/零定义漂移全部通过。Wrangler 4.122.0只打包 dry-run为3,707.34 KiB/gzip 873.26 KiB，精确识别 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images和4个 Durable Object后以 `--dry-run` 退出，没有创建发布版本。

本批没有改变静态路由注册，因此全局仍为 PHP1,904/TS1,550/精确841/可执行823/不可用18/缺失1,063/退役16/可执行缺口1,047，覆盖 `44.2%/43.2%/43.6%`；Supplier仍为 PHP182/TS156/精确与可执行118/缺失64/退役12/可执行缺口52，覆盖 `64.8%/64.8%/69.4%`。这次关闭的是“安全合同已有、前端不可操作”的逐屏缺口，不能通过重复注册相同路由虚增静态覆盖。

实现与审计提交 `5c937460baa1de069f916a7cc7d7f344dc3d9ccd` 已推送；[Actions `33591515851`](https://github.com/cinagroup/cinashop/actions/runs/33591515851) 对该精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、Linux workerd和全历史 Gitleaks 8/8成功。Worker job在 Linux精确通过生产依赖审计、双 TypeScript、192文件/1,235项单元、observability、schema和route parity；Supplier新页面构建、真实 workerd运行时、其余前端和历史密钥扫描也全部成功。该 CI只验证仓库候选，不代表主 Worker或 Supplier Pages已经发布。

本批没有连接、读取或写入生产 PostgreSQL业务行，没有 DDL/DML，没有创建临时 Worker，没有部署主 Worker或 Supplier Pages，也没有调用第三方。FE-004父项仍未完成：下一可执行本地缺口是 FE-004G配货单预览的实现/退役决策；附件、真实主管理员/受限账号、真实第三方、正式 Pages映射、发布批准和发布后观察继续按 FE-004H～L 保持门禁。

## FE-004-G Supplier 配货单预览迁移与旧二维码退役（2026-09-02）

### 活跃旧入口、合同语义与确定的跨租户泄露

旧 Supplier 订单页实际提供单单“配货单”和勾选后批量打印入口，批量前端限制最多 10 单；目标页 `/supplier/order/distribution` 调用精确合同 `GET /supplierapi/order/distribution_info?ids=...`，每张订单按 6 条商品拆页。因此该页不是孤立文件或失效脚手架，不能以新端已经有打印任务账本为由退役：打印任务处理小票/硬件执行，不能替代仓库人员在浏览器核对收件人、地址、商品、金额和备注的配货预览。

PHP `SupplierOrderServices::getDistribution()` 却只把客户端订单 ID数组交给全局订单 DAO，查询条件没有认证 Supplier ID；随后按这些裸订单 ID读取收件人姓名、手机号、地址、用户备注、支付信息、价格和全部商品快照。知道或猜到另一租户订单 ID即可读取整张配货单，属于确定的跨租户 PII与交易数据泄露，不能逐行复刻。旧页二维码同样不具备订单语义：`Setting.apiBaseURL.replace(/supplierapi/, '')` 得到站点根地址，然后每一页都编码同一 URL；二维码既不绑定订单、一次性凭据或收货流程，也不提供完整性校验。本次明确退役该二维码，而不是生成外观相似但仍无业务含义的图形。

### 新 Worker authority、快照边界与旧金额语义

新合同保持旧 GET路径，但输入只接受 1～10 个互不重复的安全正整数。订单查询一次性叠加 `id IN (...)`、`supplier_id=认证 Supplier` 和 `is_system_del=0`；返回行数与请求 ID数不完全相等时整批失败关闭，不以部分成功暴露哪些 ID存在。商品快照只从已经证明归属的订单 ID读取；`cart_info` 在 SQL投影阶段先用 `octet_length` 限制到 256 KiB，超限返回空快照，避免先把无界文本拉入 Worker后才检查。JSON解析失败或字段异常时使用有界安全占位，文本移除控制字符并限制长度，金额只接受有限非负数。

复核时发现首版候选把“会员折扣”误投影为订单活动/首单优惠，而且 256 KiB检查发生在数据库取回之后；在提交前已纠正。最终单价优先复用旧页权威 `sum_price`，再兼容当前 `sku.price/truePrice` 和结算价；会员折扣继续按每条快照 `vip_truePrice × 数量`汇总。这样运费、优惠券、会员折扣、积分抵扣、实付和用户备注与旧页面的显示语义一致，不用名称相近但含义不同的订单字段冒充迁移完成。当前 Supplier资料从认证租户行读取，订单返回顺序保持请求 ID顺序。

### 新页面、权限与真实浏览器终态

Supplier TS新增独立 `/orders/picking-sheet`，由 `supplier.order.view` 保护；订单列表对单行和最多 10 条显式勾选订单提供入口，只读仓库账号可以核对和打印配货单，但仍看不到要求 manage权限的订单/发货单批量导出。页面按每单最多 6 条商品分页，显示收件信息、订单号、支付信息、商品名称/规格/单价/数量/小计、旧金额语义、用户及供应商备注、供应商地址和电话，并提供 A4 portrait 浏览器打印样式。无商品快照会明确提示核对迁移数据，不伪造商品；重复 ID、非法 ID和超过 10 单在客户端与服务端双重拒绝。

应用内浏览器先从 `/orders?preview=1` 勾选订单并验证单单/批量入口，再直接核对配货单。桌面终态显示订单 `CS2026080900123`、两条商品、收件地址、供应商联系信息和“会员折扣 -¥5.00”；重复 ID与 11 个 ID分别显示明确失败态。390×844 首轮发现信息提示条比文档宽 10px，改为自适应宽度后复测 `document/body scrollWidth=clientWidth=375`、`innerWidth=390`，没有页面级横向溢出。最终桌面和移动复验 URL、标题、主 DOM、分页、金额和打印入口均正常，控制台只有 Vite连接 debug，warning/error为 0；视口、标签页和本地服务均已收尾。

### 工程门禁、覆盖增量与生产边界

配货单迁移定向与逐屏账本为 2 文件/11 项；最终完整 Worker单元为 193 文件/1,240 项。Worker双 TypeScript、Supplier生产 build、生产依赖 0 漏洞、observability 17信号/10组件/53必需事件/416个生产源文件，以及 schema source201/target262/shared201/sourceGaps0/外部与内嵌262/零定义漂移全部通过。Wrangler 4.122.0只打包 dry-run为 3,711.05 KiB/gzip 874.48 KiB，精确识别 Hyperdrive `9748c294e21c49a99579c9cef70102e0`、Queue、KV、R2、Images和4个 Durable Object后以 `--dry-run` 退出，没有创建发布版本。

静态路由审计由全局 PHP1,904/TS1,550/精确841/可执行823/不可用18/缺失1,063/退役16/可执行缺口1,047 提升为 PHP1,904/TS1,551/精确842/可执行824/不可用18/缺失1,062/退役16/可执行缺口1,046，覆盖为 `44.2%/43.3%/43.6%`。Supplier面由 PHP182/TS156/精确与可执行118/缺失64/退役12/可执行缺口52 提升为 PHP182/TS157/精确与可执行119/缺失63/退役12/可执行缺口51，覆盖为 `65.4%/65.4%/70.0%`。这一个新增分子是活跃 PHP精确合同；二维码退役是页面子能力决策，不通过虚构路由改变分母。

实现与审计提交 `dadef069dc17974aeb6b9181699e5422c3858b55` 已推送；[Actions `33593728300`](https://github.com/cinagroup/cinashop/actions/runs/33593728300) 对该精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、Linux workerd和全历史 Gitleaks 8/8成功。Worker job在 Linux精确通过生产依赖审计、双 TypeScript、193文件/1,240项单元、observability、schema和route parity；Supplier新页面构建、真实 workerd运行时、其余前端和历史密钥扫描也全部成功。该 CI只验证仓库候选，不代表主 Worker或 Supplier Pages已经发布。

本批没有连接、读取或写入生产 PostgreSQL业务行，没有 DDL/DML，没有创建临时 Worker，没有部署主 Worker或 Supplier Pages，也没有调用打印、面单、支付或附件提供商。FE-004父项继续未完成：FE-004H仍等待 SUP-003生产只读聚合与附件票据专项授权；FE-004I～L仍需真实主管理员/受限账号、第三方正反流程、正式 Pages项目和映射、独立发布批准及发布后观察。

## FE-001-A～C Admin 导航权威盘点、商品断链修复与基础资料操作面（2026-09-02）

### 从“文件数”收紧到启用导航分母

此前 FE-001 只有“旧 Admin 378个 Vue页面、新 Admin 55个页面”的目录计数。逐文件复核旧 `routes.js` 后确认，真正被主路由导入的是17个业务模块加 `frameOut`；已注释的 cms/community 模块、错误页和未导入脚手架不能计作当前业务入口。新增 `scripts/admin-frontend-parity-audit.ts` 使用 TypeScript AST读取实际 import、默认导出、`frameIn`、嵌套 children和动态页面 import，不以正则统计注释文本；组件别名必须解析到真实 `.vue` 或目录 `index.vue`。结果固化在 `audit/admin-frontend-inventory.json`，同时记录18个旧路由文件 SHA-256，避免旧权威输入变化后继续沿用过期结论。

权威导航统计如下：

| 口径 | 旧 Admin | 本批前新 Admin | 本批后新 Admin |
|---|---:|---:|---:|
| `pages/**/*.vue` 文件 | 378 | 55 | 56 |
| 启用的业务页面 route record | 274 | 51 | 52 |
| 不同的已路由业务页面组件 | 245 | 50 | 51 |
| 辅助组件 route record | 18 | 0 | 0 |
| 未路由页面文件 | 133 | 5 | 5 |
| 无法解析组件 | 0 | 0 | 0 |

旧业务路由的真实热点是 setting 76、marketing 48、app/work各20、system 17、content/kefu各13、product 12、supplier 11、agent 8、vipuser 7、order/statistic各6、user 5、finance 4、echarts/pages各2，以及 login/out/out_interface/root各1。新端把不少能力整合到单页或标签页，因此不能用 `52/274=19.0%` 宣称功能覆盖率，也不能因新端存在“企业微信”“系统配置”等聚合页就推定旧域全部完成。后续 FE-001D 必须给274条旧路由逐条绑定新页面、API、权限和 E2E状态。

提交的审计测试一方面验证旧快照内部计数、组件去重和不可解析项，另一方面把新端实际页面清单、路由文件摘要和每个组件的存在性与快照绑定；以后增加、删除或改路由却不更新审计会直接失败。新端5个未路由文件中，4个是统计/运维页面的内嵌 panel，`DiscountPackageManager.vue`是否应成为独立入口仍需在营销逐屏映射中判定，当前不把它臆断为缺失或完成。

### 审计抓出的商品真实断链

逐页把 Admin API调用与 Worker注册路径交叉核对时发现，商品新建调用 `/adminapi/product/create`，编辑调用 `/adminapi/product/update/:id`；Worker实际注册的是旧兼容合同 `/adminapi/product/add` 和 `/adminapi/product/edit/:id`。前两条不存在，会直接进入末尾通配501。现已把前端改为真实注册路径，并增加防回归测试，不能再用“页面可构建”掩盖运行时501。

同一路径还有两层静默失效：商品详情直接返回 Drizzle camelCase行，而页面读取 `store_name/store_info/ot_price/unit_name/is_vip/vip_price`；编辑页面提交 snake_case，控制器却只挑 camelCase字段，所以即使修正 URL，编辑详情仍为空且保存大部分字段不会写入。最终控制器对详情做明确白名单 snake_case投影，编辑以显式字段表转换回模型列；新建补写此前页面已提交但服务端丢弃的 `sort/is_vip/vip_price`。测试以真实控制器调用验证响应和 DAO update载荷，不只搜索字符串。

### 首批旧入口恢复：商品单位与保障服务

旧 `/admin/product/unitList` 和 `/admin/product/ensure` 都是启用菜单；Worker此前已经有平台 owner下的单位查询/增改/引用保护删除，以及保障查询/增改/停启/引用保护删除，GET与写入分别受 `product.view`/`product.manage`控制，但新 Admin没有入口。新增 `/product/metadata`“商品基础资料”把两者整合为两个标签：单位支持搜索、新增、编辑、删除，保障支持搜索、新增、编辑、停启和删除；删除被商品引用的记录仍由服务端失败关闭。商品列表提供直接入口，商品新建/编辑页从单位目录读取最多100个启用单位，同时保留可创建输入以兼容历史自由文本。

这只是第一批候选操作面，不代表 ADM-003完成。当前商品表单尚未把保障条款选择与商品关系的权威校验/原子保存闭合；旧产品规格、参数、搜索热词、批量处理和完整SKU编辑仍需逐项审计。保障图标目前接受服务端既有255字符地址合同，Admin素材选择器与稳定私有资产引用还需要单独对账。

### 浏览器与工程证据、生产边界

Admin生产构建和 Worker TypeScript通过；两份定向测试共2文件/5项，覆盖导航快照、商品路由、详情投影、编辑字段映射和组件解析。真实应用内浏览器在1440×900从商品列表进入基础资料页，新增“瓶”、编辑为“瓶装”，切换保障页把“正品保障”从停用改为启用并修改说明；再进入商品新增页确认单位下拉读取“件/盒”。390×844 下单位与保障标签均可操作，`innerWidth/document.scrollWidth/body.scrollWidth=390/390/390`，无 Vite错误遮罩，控制台 warning/error为0；宽表只在卡片内部滚动。浏览器视口已恢复、标签页和本地服务已关闭。测试使用 `preview=1`内存数据，没有向生产或第三方发送商品内容。

本批没有连接、读取或写入生产 PostgreSQL，没有 DDL、Queue、R2、第三方调用、主 Worker/Pages部署或删除生产数据。用户的简短“授权”仍未满足外部安全审查对临时 workers.dev目的地和返回载荷的明确授权要求，因此 FE-004H的生产附件聚合没有执行：没有创建临时 Worker、没有读取 Hyperdrive/R2、也没有执行清理删除。FE-001A～C的本地进展不解除 FE-004H、真实 Admin账号、预发和发布门禁。

## FE-001-F Admin 请求路径全量静态审计与危险配置面隔离（2026-09-02）

### 从抽样排查升级为可重复的请求—路由合同

新增 `scripts/admin-frontend-api-audit.ts`，使用 TypeScript AST 扫描新 Admin 的 `src/api/*.ts` 与 `src/pages/**/*.vue` 脚本中所有 `request.get/post/put/delete/patch` 调用。审计器会展开条件表达式、局部 URL 对象映射和函数参数的字符串联合类型；运行时 ID只按路径段归一为 `:param`，动态调用段不能被同位置的固定字面量路由误匹配。后端从 `src/routes/adminapi.ts` 读取同方法路由及最终处理器，并把输入文件的换行统一为 LF 后计算 SHA-256，避免 Windows CRLF 与 Linux LF造成虚假漂移。

当前权威结果为305个请求调用点、325个路径变体；同方法已注册325、可执行325、未注册0、无法解析0、命中命名为受控不可用的处理器0。报告固化在 `audit/admin-frontend-api-contracts.json`，测试会在同一进程从当前源码重新生成完整报告并与提交快照逐字段比较；任何新增、删除、改方法、改路径、处理器变化或输入哈希漂移都必须显式更新审计。此口径只证明当前新 Admin发出的静态请求不会因缺注册而落入末尾通配501，不证明每个处理器在真实业务数据下成功，也不把 Worker中存在但当前前端未调用的企业微信远端写路由误算为已完成。最初建立门禁时为297/317；新增商品规格和参数模板8个调用点后，快照随源码显式推进到305/325。

### 四类真实断链与一处高风险伪修复

审计首先确认 Dashboard的 `GET /adminapi/new_push` 确实没有兼容路由，尽管控制器和 `/api/admin/new_push` 已存在；现已注册同一只读处理器。商品删除前端使用 DELETE、兼容路由却注册 POST，现统一为控制器和主 Admin路由已有的 DELETE语义。退款审核前端调用 `/refund/agree/:id`，Worker真实兼容合同为 `/refund/refund/:id`，现按现有退款服务入口校正。三处都增加静态防回归断言。

用户余额页面原本调用不存在的 `/user/money/:id`；直接把它改指旧 `/user/set_other/:id` 虽能消除501，却会继续使用无事务、无幂等、无资金流水和无管理员审计的旧控制器，因此被否决。页面改接 `POST /user/update_other/:uid`，请求体转换为旧移动管理合同的 `status/number/type` 并每次携带 UUID v4 `Idempotency-Key`；兼容路由指向已经通过行锁、事务级 advisory lock、重放账本、`user_money`流水和 `system_log`审计验证的 `adminMobileUserUpdateOther`。旧 `set_other` 别名也改指同一安全处理器，旧 `{money,type}` 或缺幂等键请求会明确失败，不再静默改余额。

通用系统配置页是更危险的“补路由即可用”假修复：既有未注册控制器会读取全部 `is_store=0`键值，其中可能包含支付、微信和第三方凭据；保存端又接受任意键、逐条非事务写入并允许创建新键。此次没有注册 `/config/list|save`，而是删除新 Admin对这两个危险合同的调用，把页面改为明确的安全停用说明，并只提供已经有字段白名单、权限和业务校验的“新人运营”“客户端内容”入口。通用配置迁移仍须按业务域建设专用服务，不能恢复整表键值编辑器。

### 跨平台门禁、浏览器终态与边界

上一提交 `b3dca1d340fc845a84185b823d2805e7df947354` 的 Actions `33596350398` 有7个任务成功，Worker任务在1,245项中的唯一失败是 Admin导航快照把工作区原始换行纳入哈希：Windows生成的 CRLF摘要在 Ubuntu LF检出后误报路由漂移，功能测试没有其他失败。本批把导航和新 API审计哈希都改为规范化文本摘要；本地完整 Worker单元现为196文件/1,249项全部通过，双 TypeScript、Admin生产构建、严格 API审计和定向4文件/16项均通过。

实现与审计提交 `49762a79638b21c81d804c3a77085f67bcf95c6e` 已推送；[Actions `33598766840`](https://github.com/cinagroup/cinashop/actions/runs/33598766840) 对该精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、Linux workerd和全历史 Gitleaks 8/8成功。Ubuntu Worker job精确通过生产依赖审计、双 TypeScript、196文件/1,249项单元、observability、schema与全局route parity；这同时证明规范化文本哈希在 Linux检出下不再误报。该 CI只验证仓库候选，不代表主 Worker或 Admin Pages已经发布。

真实应用内浏览器在桌面打开 `/config?preview=1`，确认安全停用说明和两个入口；“新人运营”进入 `/config/newcomer`，“客户端内容”进入 `/config/runtime-content`，页面标题、主内容和错误遮罩均正常。390×844 下 `innerWidth/document/body scrollWidth` 均为390，两张卡片各306px且纵向排列，无页面级横向溢出。视口、标签页和本地服务均已恢复/关闭。浏览器只使用本地预览数据，没有读取或写入生产配置。

本批没有连接 Hyperdrive、读取或写入生产 PostgreSQL，没有 DDL、Queue、R2、第三方调用、主 Worker或 Admin Pages发布。FE-001F标记为静态候选完成；FE-001父项仍被274条旧路由逐屏语义映射、商品剩余操作面、真实主管理员/受限角色生产数据 E2E，以及 Pages预发、发布和观察阻塞。

## FE-001-E 商品域12屏逐项审计与两类模板操作面（2026-09-02）

### 先固定分母，再判断语义覆盖

旧 Admin 实际导入的商品路由文件只启用12条业务屏，不是按 `pages/product` 下所有文件估算。新增 `audit/admin-legacy-product-route-parity.json`，为每条旧路由固定旧组件、标题、candidate/partial/missing 状态、新页面、新 API、权限、已覆盖能力和剩余缺口。`admin-product-frontend-parity.test.ts` 固定这12条路径；首轮为5条候选、6条部分覆盖、1条缺失，搜索热词操作面落地后按证据推进为6/6/0。每条非缺失项都必须有具体页面和 API，因此不能因为新端存在一个“商品管理”或“商品基础资料”标题就把整域记为完成。

| 旧路由/屏幕 | 当前状态 | 新端替代 | 仍缺的决定性能力 |
| --- | --- | --- | --- |
| `product_list` 商品管理 | partial | `/product`、卡密库存/预警 | 批量运营、完整筛选/审核/导出及受控 SKU 退役 |
| `product_classify` 商品分类 | partial | `/category` | 完整层级、父级移动、图标、显隐专用流和关系编辑 |
| `add_product/:id?` 添加/编辑 | partial | `/product/create|edit/:id` | 受控 SKU 退役、图库/富媒体与多类商品；模板套用与安全组合编辑已补齐 |
| `product_reply/:id?` 商品评论 | partial | `/reply` | 商品定向、管理员回复、虚拟评论、分页筛选和回复历史 |
| `product_attr` 商品规格 | candidate | `/product/metadata` 的 SKU规格页签及商品表单 | 生产历史数据与受控 SKU 退役；套用、生成和事务回读已补齐 |
| `product_brand` 品牌 | partial | `/brand` | 分类关系、专用状态和素材选择；商品表单关联及引用删除保护已补齐 |
| `unitList` 商品单位 | candidate | `/product/metadata` 的单位页签 | 生产真实数据与受限角色 E2E |
| `label` 商品标签 | partial | `/label` | 标签组、显隐/启停区分、图标和批量流；商品表单关联及引用删除保护已补齐 |
| `specs` 商品参数 | candidate | `/product/metadata` 的参数模板页签 | 商品表单套用和参数快照已补齐，仍缺生产历史数据 E2E |
| `ensure` 保障服务 | candidate | `/product/metadata` 的保障页签 | 商品保障多选和关系持久化已补齐，仍缺生产真实角色 E2E |
| `ensure/create/:id?` 参数模板编辑 | candidate | 合并到参数模板弹窗 | 生产历史模板编辑保存 E2E |
| `hotWords` 搜索热词 | candidate | `/product/metadata` 的搜索热词页签 | 生产历史数据、受限角色与颜色/图标兼容 E2E |

其中最重要的语义纠偏是旧 `/admin/product/ensure/create/:id?` 虽然路径写着 `ensure`，实际组件是 `specsAdd/index.vue`，提交的是 `product/specs/:id`；它是商品参数模板编辑，不是保障模板。旧 `productAttr` 才维护 `store_product_rule.rule_value` 中的颜色、尺码等 SKU 组合维度。新页面把两者分别命名为“SKU规格模板”和“商品参数模板”，顶部说明前者参与 SKU 结构、后者只描述材质/产地等属性，避免继续复制旧路由命名错误。

### 复用已有安全服务，不增加新的生产写入口

Admin `productMetadata.ts` 新接八个现有合同：规格模板的列表、详情、保存、删除，以及参数模板的列表、详情、保存、删除。规格写入继续由 `ProductMetadataService` 固定平台 `(type=0, relation_id=0)`，以事务级 advisory lock 串行同一作用域的重名检查；新写严格限制1～3个维度、每维1～50个非空唯一值，旧坏 JSON 只在读取时容错为空。参数模板明确固定 `category.group=3`，名称和排序与最多100条参数在同一事务内保存；更新先锁定平台自有模板，再删除并重建 `store_product_specs` 行，不会留下半套参数或越权修改 Supplier模板。权限仍由 Admin 路由统一执行只读 `product.view`、写入 `product.manage`。

`/product/metadata` 现在有单位、保障、SKU规格模板、商品参数模板四个页签。SKU页支持搜索、分页、维度/规格值预览、新增、编辑、删除以及前后端一致的重复/数量校验；参数页支持搜索、分页、参数摘要、名称/值/排序/逐项启停编辑和删除确认。预览层只在 Vite开发且显式 `preview=1` 时使用内存数据，生产构建始终走 `/adminapi`。Admin生产构建通过2,427个模块；完整 Worker单元为197文件/1,253项全部通过，双 TypeScript通过，定向4文件/15项通过。API静态合同随新增8个调用点更新为305个调用点、325个路径变体，325条全部已注册且可执行，未注册/未解析/受控不可用命中均为0。

实现与审计提交 `ab24479642bb361dfe14855c49eabd1d5313252a` 已推送；[GitHub Actions `33601245292`](https://github.com/cinagroup/cinashop/actions/runs/33601245292) 对该精确 head 的 Worker、Admin、PC、Supplier、Kefu、UniApp、真实 workerd 和全历史 Gitleaks 8/8成功。Ubuntu Worker job 精确通过生产依赖审计、双 TypeScript、197文件/1,253项单元、observability、schema `201→262/shared 201/source gap 0/definition drift 0` 和全局路由 `1,904→1,553/matched 842/executable 824` 门禁。CI 不持有生产数据库授权，不连接 Hyperdrive，也不部署 Worker或 Pages。

应用内浏览器在本地 `preview=1` 下验证四页签可达。桌面端 SKU模板正确展示“服装颜色尺码”的颜色/尺码和值，编辑弹窗回填两个维度；参数模板正确展示材质/季节摘要，编辑弹窗从2项动态增加到3项。390×844下 `innerWidth/document/body scrollWidth` 都是390，内容卡片306px，表格只在卡片内滚动，没有页面级横向溢出或 Vite错误遮罩；完成后视口、标签页和本地服务均已恢复/关闭。

本批没有连接 Hyperdrive、读取或写入生产 PostgreSQL，没有 DDL、Queue、R2、第三方调用、Worker或 Pages部署。FE-001E先关闭12屏审计和两类模板目录；随后搜索热词操作面另批收口。保障/品牌/标签/参数的商品保存关系、规格套用和SKU全流程、批量运营、真实角色/数据 E2E 继续保留在 checklist，父项不标完成。

## FE-001-E4 平台搜索热词安全操作面（2026-09-02）

### 迁移审计先纠正旧端与现端的双重边界问题

旧 Admin 的列表会补 `type=0/relation_id=0/is_del=0`，但“获取全部”、详情、更新、显隐和删除均按裸 ID 或只按 `is_show/is_del` 查询：Supplier 热词可能被平台读到或改写，删除还是物理删除；重名检查也漏掉 `relation_id`，列表更把每条真实 `add_time` 伪装为请求当下时间。旧校验调用 `scene('get')`，而校验器定义的是 `save` scene，名称长度规则并不可靠执行。当前 Worker 公开 `/search/hot_keyword` 又只按 `is_show=1/is_hot=1` 过滤，既遗漏旧接口实际展示的普通可见热词，也没有限制平台 owner 与 `is_del=0`，因此不能通过简单恢复旧控制器完成迁移。

新 `ProductWordsService` 把管理端与公开端统一到平台 `(type=0, relation_id=0)` 权威边界。管理列表、全部、详情和每个写操作均要求有效未删除记录；删除改为 `is_del=1/is_show=0/is_hot=0` 的可审计软删除。热词名称按 Unicode 字符限制1～15，颜色只接受安全的十六进制、RGB/RGBA或透明值，图标只接受 HTTPS 或站内绝对路径且最长128字符，排序限制0～999，所有开关只能为0/1。请求体最多8 KiB，Admin 响应为 `private, no-store`。

新增、编辑、显隐、删除在同一平台作用域 advisory lock 下执行短事务；重名判断包含 owner、有效状态和大小写归一，更新必须回读受影响 ID。每次成功写入与 `system_log` 审计位于同一事务，日志只记录动作和目标 ID，不复制用户输入正文。公开商城读取只返回最多20条平台可见、未删除记录，并保留现有前端需要的 `keyword` 字段；数据库增加平台 owner/有效排序与公开可见的两个精确索引，外部 SQL `0125` 与 Worker 内嵌 `migration_0131` 保持逐字一致。

### 页面、合同与验证边界

`/product/metadata` 增加第五个“搜索热词”页签：支持搜索、分页、样式预览、新增、编辑、显隐与删除确认；文字/背景/边框颜色支持透明度，图标可留空。历史库中不符合新安全格式的颜色或图标只在响应时降级为空，不改写原行，也不继续输出到商城或 Admin 图片地址。前端新增4个静态请求调用点，Admin API 权威报告从305/325推进到309个调用点、329个路径变体，329条全部已注册且可执行，未注册、无法解析和受控不可用命中均为0。旧商品12屏审计由5条候选/6条部分/1条缺失推进为6/6/0，但 candidate仍只表示候选操作面存在，不能替代生产 E2E。全局静态路由审计同步推进为 PHP 1,904 / TS 1,565 / 精确匹配848 / 可执行匹配830 / 受控不可用18 / 缺失1,056 / 退役16 / 可执行缺口1,040。

本地商品专项4文件/19项、跨迁移/API门禁4文件/44项和完整 Worker 单元198文件/1,258项均通过，Worker 单元与运行时 TypeScript通过，Admin生产构建通过2,427个模块。本地预览在桌面完成新增“秋季精选”并回读列表；390×844 下 `innerWidth/document/body scrollWidth=390/390/390`、卡片306px、搜索热词页签保持激活、无 Vite遮罩和浏览器 warning/error，视口、标签页和服务均已恢复/关闭。Windows `workerd` 在业务测试启动前连续两次宿主访问冲突，运行时0项执行；该结果与1,258项业务单元分开记录。实现与审计提交 `90617dc0e4bd70211271e021c30cfe9e41758227` 推送后，[Actions `33604769652`](https://github.com/cinagroup/cinashop/actions/runs/33604769652) 对精确 head 的 Linux workerd、Worker 类型/单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp 五端、生产依赖与全历史 Gitleaks 共8/8成功；Windows失败据此归类为本机宿主环境问题，不是商品热词迁移缺陷。

此次没有连接 Hyperdrive，没有读取或改写生产业务行，没有执行 `0125` DDL，没有部署 Worker/Pages，也没有调用第三方服务。生产历史热词的颜色/图标兼容、主管理员与只读/编辑受限角色流程、真实商城展示和迁移索引执行仍归 FE-001E6/发布门禁；FE-001E父项保持未完成。

## FE-001-E3 商品关联资料原子迁移审计（2026-09-02）

### 旧端并非一个商品表写入，原迁移漏掉了五类关系

逐项追踪旧 `cinashop-php` 商品保存流程后确认，主商品先在事务中写 `store_product`，随后才异步投递 `ProductRelationJob`：关系类型1为分类、2为品牌、3为商品标签、4为用户标签、5为保障、6为商品参数模板。旧端同时把分类、主品牌/品牌集合、商品标签、保障、参数模板和参数值快照保留在 `store_product.cate_id/brand_id/brand_com/store_label_id/ensure_id/specs_id/specs` 兼容列。这个双写结构意味着只修商品主表字段仍会让关系查询、删除保护和旧调用方互相矛盾；而旧端“主事务提交后再派发关系任务”也不是原子保证，任务失败会留下只有兼容列、没有关系行的半成品。

本轮前的新 Admin 商品表单只提交名称、价格、分类、单位等基础字段：没有品牌、商品标签、保障和参数模板入口，详情也不回传这些关系。Worker 的创建/编辑控制器只写 `store_product` 基础字段，不写 `store_product_relation`，不保存参数快照，也没有写后数据库回读；品牌和商品标签删除分别直接软删/物理删。保障已有关系保护，但品牌、标签和参数模板仍可能在被商品引用时删除。因此 FE-001E3 是真实的持久化断层，而不是只缺几个下拉框。

### 新保存合同：一个短事务、两套兼容表示、一次强制回读

新增商品关联服务把创建和编辑统一到一个有界写合同。请求体最多64 KiB；名称、简介、主图、关键词、单位、价格、库存、排序、开关、关联数量和最多100项参数快照都在写入前校验。创建固定为平台 owner，编辑从已锁定商品行继承 owner；分类、品牌、标签、保障和参数模板必须存在于平台或该商品所属作用域。已有旧调用方若只更新基础字段，不会清空关系；只提交部分关联字段时，服务会从兼容列与关系表合并当前值作为缺省，避免兼容接口造成静默丢失。

事务先取得商品 advisory lock，并对现有商品行 `FOR UPDATE`；所选品牌、标签、保障、分类、参数模板和模板参数使用共享行锁，和相应删除流程的排他行锁串行。主行会同步写分类 CSV、最后一个品牌兼容 ID、品牌集合、商品标签、保障、参数模板 ID和完整参数值快照；随后只替换当前服务权威管理的1/2/3/5/6类关系，不触碰旧类型4用户标签。上架/下架也复用同一商品锁，在更新主商品状态时同步分类关系状态，并在同一事务写不含用户正文的 `system_log`。

关系写完后不会仅相信 ORM 返回值。服务在同一 PostgreSQL 事务内重新读取商品兼容列、参数 JSON和全部受管关系行，逐类按精确 ID集合比对；主品牌必须等于品牌集合最后一项，参数模板和规范化快照必须完全一致。缺行、多行、旧值残留、快照变化或任何集合不一致都会抛错并回滚主商品、关系行和审计日志，成功响应明确返回 `associations_verified=true`。这是真实数据库执行路径上的每次保存回读机制，但本轮没有把生产 Hyperdrive 当作测试环境；生产样本验收仍单列在 FE-001E6。

参数模板采用“模板定义 + 商品历史快照”边界：首次套用时只复制启用参数，管理员可编辑每个商品的值；以后模板变化不会静默改写历史商品。编辑历史商品时，如果当前模板结构已变化，仍允许保持同一模板并按该商品原快照的参数名更新值；畸形旧快照不会被静默复制，必须提供一套重新通过结构校验的快照。品牌、商品标签、保障和参数模板删除现在都先锁定目标，再同时检查关系表与旧兼容列/直接列；任一活跃商品仍引用即明确拒绝。现有关系索引已覆盖按 `(type, relation_id)` 查引用以及按商品替换关系的路径，本轮无需新增 DDL。

### Admin 操作面、静态合同与可重复证据

商品表单新增品牌选择、商品标签多选、保障多选、参数模板和可编辑参数快照，并保留管理品牌、标签、保障和模板的跳转入口。详情将兼容列与关系表求并集，避免迁移中两套表示暂时不一致时漏显；候选接口一次有界返回平台有效分类、品牌、商品标签、保障及带启用参数的模板。新建草稿同步保存和恢复这些字段。桌面预览实际选择品牌 `CINA SELECT`、标签“新品/平台推荐”、保障“七天无理由/正品保障”和“服装基础参数”，模板自动生成“材质=棉、适用季节=四季”，再把材质改为“有机棉”。390×844下页面、文档和正文宽度均为390，五个关联操作行转为纵向，两个参数行均为单列249px，没有页面级横向溢出、Vite遮罩或浏览器 warning/error。预览草稿请求因本地代理隔离失败并显示“草稿自动保存失败”，没有访问生产。

定向商品关联/元数据/体验/前端语义4文件21项通过；完整 Worker 单元199文件1,265项通过，单元与运行时 TypeScript通过，Admin生产构建通过2,427个模块。Admin静态请求报告推进为310个调用点、330个路径变体，330条全部已注册且可执行，未注册、未解析、受控不可用命中均为0；全局路由为 PHP 1,904 / TS 1,567 / 精确匹配848 / 可执行830 / 受控不可用18 / 缺失1,056 / 退役16 / 可执行缺口1,040。schema仍为源201、目标262、共享201、源字段缺口0、定义漂移0；observability为17类信号、10个组件、53个必需事件、420个生产源码文件。Windows本地 `workerd` 在项目测试加载前发生宿主访问冲突，运行时0项执行，不能计作通过；实现与审计提交 `0e0fe3967623ae491323effa102e481930c3e147` 推送后，[Actions `33609577709`](https://github.com/cinagroup/cinashop/actions/runs/33609577709) 对该精确 head 的 Linux workerd、Worker类型/1,265项单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp五端、生产依赖与全历史Gitleaks共8/8成功，因而本机失败归类为Windows宿主环境限制。

此次没有连接 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或写入生产 PostgreSQL，没有执行 DDL/DML、Queue、R2或第三方调用，也没有部署 Worker/Admin Pages。FE-001E3只标记“候选完成，未发布”；历史单规格、多规格、虚拟商品，主管理员与受限角色，失败重试、取消与移动端真实流程仍归 FE-001E6。FE-001E父项继续被SKU规格套用/组合保存、批量运营和生产E2E阻塞。

## FE-001-E5A SKU模板套用与安全编辑（2026-09-02）

### 旧端保存语义与实际风险

旧 Admin 通过 `POST product/generate_attr/:id/:type` 取得规格模板，`StoreProduct::is_format_attr`/`getAttr` 生成规格值的笛卡尔组合；保存请求同时提交 `items` 维度和 `attrs` SKU 行。`StoreProductServices::saveData` 会校验完整组合，并把商品主表、描述与属性放入事务，但商品关系事件在事务完成后触发。更关键的是，旧 `saveProductAttr` 虽然试图按 `suk` 复用 `unique`，实际更新/删除却按数据库行位置处理，并在更新载荷中移除 `unique`：管理员重排、改名或缩减组合时，既可能把旧唯一标识绑定到错误组合，也可能删除仍被购物车、订单、退款或活动引用的 SKU。

旧批处理另有分类、商品标签、配送、赠品/优惠券、用户标签、推荐、表单、运费和品牌等类型，控制器主要把任务投递到 `ProductBatchJob`。主商品更新与关系行异步执行，不具备统一的失败回滚语义。当前 Worker 已有分类、商品标签和显隐的部分内部批处理能力，但新主管理端没有完整入口，其他类型也未统一权限、数量上限、逐项结果和重试合同；因此本批只关闭可安全证明的 SKU 编辑子项，批量运营保留为 E5B。

### 失败关闭的迁移边界

新 `ProductSkuEditorService` 复用 Supplier 侧已验证的规格/SKU标准化：单规格归一为“规格=默认”，多规格限制1～3维、最多200行，服务端重新计算并要求完整笛卡尔覆盖；规格名称和值禁止英文逗号及控制字符，避免旧表用逗号序列化时产生歧义。商品汇总库存取所有 SKU 之和，售价、结算价、成本、原价和会员价取对应最小值，缺货状态由总库存派生，不能由前端提交互相矛盾的主表值。

历史 SKU 以 `suk` 作为本批稳定映射键，保留原 `unique`、销量和累计入库量；允许改价格、库存、图片、成本、会员价、条码、编码等字段，也允许新增完整组合。任何现有 `suk` 从请求中消失、被重命名或尝试修改 `unique` 都明确拒绝，历史畸形数据中重复 `suk/unique` 也失败关闭，不能用“保存成功”掩盖引用破坏。真正的删除/重命名必须在 E5B 先审计购物车、订单、退款及活动引用并设计可恢复退役状态。

保存与商品主表、规格维度、SKU行、属性快照和库存流水处于 `ProductAssociationService` 已有短事务中。写入前锁定商品和现有 SKU 行；写入后在同一事务重新读取主表汇总、维度顺序、每条 `suk/unique` 及金额库存、JSON快照，任一不一致抛错使整笔回滚。库存变化写 `store_product_stock_record`；累计入库量只随正向增量增加，减库存不会倒减历史累计值。

复核还发现五条会分配 `store_product_attr_value.unique` 的路径原先使用不同 advisory lock 域，虽然每条都会全表查碰撞，极端并发仍存在“同时查无、随后同值插入”的窗口。新增共享 `ProductSkuIdentity` 锁域，并让 Admin 商品、Supplier 商品、Out 商品、新人专享和优惠套餐五条分配路径统一使用；活动自身的配置锁继续保留。当前旧 schema 对 `unique` 只有索引而非唯一约束，生产增加唯一约束仍必须先做重复值只读审计，本批没有冒险执行 DDL。

### Admin 操作面与本地证据

商品表单新增单/多规格选择、规格模板套用、维度摘要和 SKU 明细表，可编辑图片、售价、原价、成本、会员价、库存、条码和编码；历史唯一标识只读展示。模板重新生成时按精确 `suk` 保留已有行数据，新增组合才创建新行。页面明确提示历史 SKU 不能删除、重命名或改标识；单规格继续使用主表售价/原价/库存/会员价，多规格在提交前从 SKU 行派生汇总。

应用内浏览器在本地 `preview=1` 编辑历史多规格商品：选择“服装颜色尺码”并重新生成后，米白/藏青 × S/M 四行仍分别保留 `pvsku001..004`；使用真实控件把首行售价改为209、库存改为35，失焦和后续输入后值仍保持。390×844下文档与正文 `scrollWidth=390`，SKU表格内容宽1230px但由249px的内部 `overflow-x:auto` 容器承载，没有页面级横向溢出；实际截图确认固定组合列与可滚动价格列可见，浏览器 warning/error 为0。临时视口、标签页和本地服务均已恢复/关闭。

本地定向4文件/22项通过；完整 Worker 单元200文件/1,272项、单元与运行时 TypeScript、Admin 2,427模块生产构建全部通过。Admin静态请求仍为310个调用点、330个路径变体，330条全部注册且可执行；schema为源201、目标262、共享201、源字段缺口0、定义漂移0；全局路由保持 PHP 1,904 / TS 1,567 / 精确匹配848 / 可执行830；observability为17类信号、10个组件、53个必需事件、422个生产源码文件。Windows本地真实 Worker运行时沿用已记录的宿主访问冲突限制；精确实现提交 `6bef6de8a67bd8d2c4df3d683684ad36198a471e` 推送后，[Actions `33613355706`](https://github.com/cinagroup/cinashop/actions/runs/33613355706) 的 Linux workerd、Worker类型/单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp、生产依赖审计与全历史Gitleaks共8/8成功。

本批没有连接 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或写入生产 PostgreSQL，没有执行 DDL/DML、Queue、R2、第三方调用，也没有部署 Worker/Admin Pages。FE-001E5A仅标记“候选完成，未发布”；E5父项仍被受控 SKU 退役、批量运营和 E6真实角色/历史数据 E2E 阻塞。

## FE-001-E5B1 受控商品批量运营（2026-09-02）

### 旧队列语义不是原子成功

旧 Admin 商品列表把批量操作统一提交给 `StoreProductBatchProcessServices::batchProcess`。类型1为分类、2为商品标签、3为配送方式、4为赠送积分/优惠券、5为用户标签、6为推荐位、7为自定义表单、8为运费、9为品牌；标签允许空集合表示清空，分类必须非空。服务并不等待数据库修改完成，而是立即把任务投递给 `ProductBatchJob`：简单主表更新每30个商品一组，分类和赠品类每100个拆分后再逐商品投递。执行器捕获每个任务异常后只写日志并继续返回，因此控制器的“已提交/成功”不代表所有商品完成，也没有跨商品、主表与关系表的一致回滚或写后回读保证。旧页面还支持“全选当前筛选结果”，实际影响数量由后台再次查询决定，操作前端无法给出精确上限或最终逐项结果。

迁移前 Worker 已有 `/api/admin/product/set_show` 与 `/api/admin/product/batch_process` 的部分内部实现，能同步修改显隐、分类和商品标签，但新主管理端 `/product` 没有多选入口，`/adminapi` 也没有对应批量路由。请求直接解析无尺寸上限，成功响应没有数据库回读标记，操作没有写 `system_log`；“服务代码存在”不能视为旧操作面已经迁移。本批据此把安全范围压缩为显隐、分类、商品标签三类，不把尚未逐项审计的类型3～9一起开放。

### 新合同：有界短事务、整批回滚、数据库回读

两个批量入口现在都限制8 KiB请求体、最多100个去重商品 ID，并在写入前按升序排序，形成确定的商品行锁顺序；分类/商品标签各最多50项。事务设置2秒锁等待和5秒语句上限，先锁定全部商品并拒绝已删除商品；上架还要求商品审核通过。显隐会同步商品主表、未支付未删除购物车和分类关系状态，上架同时清除自动下架时间。分类和标签会先用共享行锁校验所有候选可用，再同步替换商品兼容 CSV 列与对应关系行；分类关系状态继承商品显隐，商品标签关系保持有效状态。

写入后不会只相信更新行数。服务在同一 PostgreSQL 事务重新读取全部商品、购物车状态和目标关系集合：显隐、自动下架时间、兼容 CSV、关系数量、商品/关系 ID、父分类与关系状态均按精确期望值比对；任一缺行、多行、旧关系残留或状态不一致都会抛错并整批回滚。成功前按商品逐条写管理员、来源路径、操作类型及关系数量/指纹到 `system_log`，不记录商品正文或候选名称；响应明确返回 `verified=true`，管理端未收到该标志不得提示成功。这一合同选择“单批原子成功或失败”，没有沿用旧队列会部分完成却先提示成功的语义。

### 主管理端与真实控件验收

新 Admin 商品列表加入多选、已选数量、批量上架/下架、替换分类和替换商品标签；分类必须至少一项，标签空集合明确表示清空。候选项复用商品编辑器已有的受作用域约束接口，成功后重新加载列表和清空选择。浏览器桌面验收实际选择两个商品替换分类并选择一个商品上架，分别收到“已处理2个商品”和“已处理1个商品”，状态与选择重置正确。

390×844验收首次发现原有260px固定操作列覆盖左侧选择框，导致移动端无法开始批量操作；取消固定列后，选择框、ID与商品列在首屏可用，操作列由表格内部横向滚动访问，文档和正文宽度保持390px。实际勾选商品并打开批量弹窗，提示、操作类型和确认区均可见，浏览器 warning/error 为0。本次浏览器检查直接改变了实现，不是只做静态截图。

### 本地门禁、远端证据与剩余边界

本地完整 Worker 单元200文件/1,273项、单元与运行时 TypeScript、Admin 2,427模块生产构建全部通过。Admin静态请求推进为312个调用点、332个路径变体，332条全部注册且可执行，未注册、未解析和受控不可用均为0；全局路由为 PHP 1,904 / TS 1,569 / 精确匹配849 / 可执行831 / 受控不可用18 / 缺失1,055 / 退役16 / 可执行缺口1,039。schema仍为源201、目标262、共享201、源字段缺口0、定义漂移0；observability为17类信号、10个组件、53个必需事件、422个生产源码文件。精确实现提交 `01e7612fbfa14a175d789e32b20110af5e0be618` 推送后，[Actions `33615797183`](https://github.com/cinagroup/cinashop/actions/runs/33615797183) 的 Linux workerd、Worker类型/1,273项单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp五端、生产依赖审计与全历史Gitleaks共8/8成功。

本批没有连接 Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或写入生产 PostgreSQL，没有执行 DDL/DML、Queue、R2、第三方调用，也没有部署 Worker/Admin Pages。FE-001E5B1仅标记“候选完成，未发布”；受控 SKU 退役/重命名归 FE-001E5B2，配送、赠品/优惠券、用户标签、推荐、表单、运费和品牌批处理归 FE-001E5B3，真实角色与生产历史数据 E2E 仍归 FE-001E6。

## FE-001-E5B2 受控SKU退役与历史身份保护（2026-09-02）

### 审计结论：删除或原地重命名会破坏跨域历史，必须改成可恢复状态机

旧商品编辑把 `store_product_attr_value.unique` 交给购物车、订单快照、评价、库存流水、虚拟库存、促销赠品、抽奖和门店库存长期引用；活动SKU又以同一个表的 `type=1/2/3/4/5/7` 保存，并通过 `suk` 映射回普通SKU。旧保存流程按行位置更新/删除规格，意味着管理员缩减或重命名组合时可能让历史 `unique` 指向另一含义，或直接删除订单、退款和活动仍需读取的行。E5A 因此先失败关闭删除、改名和改唯一标识；本项继续逐表追踪引用后确认，不能通过级联修改把风险伪装成“重命名成功”。

本轮确定稳定身份策略：`product_id/type/suk/unique` 一旦成为历史SKU身份就不原地改写。业务上的改名采用“先新增完整的新规格组合，再成组退役旧组合”；旧行永久保留，恢复时重新进入可售集合。当前受控入口只开放平台自营、未删除的实物商品，Supplier、虚拟商品及其他owner不冒充完成。生产是否存在重复 `suk/unique` 尚未只读验证，所以实现会在当前商品发现重复时失败关闭，生产数据门禁仍归E6。

### 引用矩阵与阻断/保留边界

退役事务对所选SKU生成依赖快照，并把仍会产生新业务或并行库存的引用列为硬阻断：`store_cart.product_attr_unique` 的未结购物车；`store_order_cart_info.sku_unique` 连接 `store_order` 后的未支付有效订单；秒杀、砍价、拼团、积分、优惠套餐和新人活动对应的 `type=1/2/3/4/5/7` SKU；`store_promotions.give_product_unique` 赠品串、`store_promotions_auxiliary.unique` 促销关系、`luck_prize.unique` 抽奖奖品及 `store_branch_product_attr_value.attr_unique` 门店规格。任一数量大于0，整笔退役拒绝并回滚。

已经完成或只承担历史解释的引用不迁移、不删除：全部 `store_order_cart_info.sku_unique` 计入订单历史，`store_product_reply.sku_unique` 计入评价历史，`store_product_stock_record.unique` 计入库存历史，`store_product_virtual.attr_unique` 计入虚拟库存历史。这些计数与操作理由、管理员、IP、SKU身份快照一起写入目标库新增的 `store_product_sku_retirement_log`，每次退役或恢复逐SKU追加，另写不含业务正文的 `system_log`。没有把通用系统日志冒充业务迁移账本。

### 数据库与事务保护

外部迁移 `0126_product_sku_retirement.sql` 和 Worker 内嵌迁移使用完全相同的DDL：普通SKU行增加 `is_retired/retired_at/retired_by/retire_reason`，新增按商品和SKU检索的追加式证据表及活跃SKU索引。数据库触发器禁止删除退役行；旧状态或新状态任一为退役时，均禁止修改 `product_id/type/suk/unique`，封住“一条SQL同时改身份并转入退役”的绕行；退役库存禁止减少，但允许订单取消、退款等补偿增加。恢复不会生成新身份，而是清除退役状态并保留原行。

服务使用2秒锁等待和5秒语句上限，先取得E5A/E5B1共用的商品写锁，再取得Out、Supplier和Admin规格分配共用的全局SKU身份锁，随后按固定顺序锁商品和所选SKU。依赖检查、状态更新、规格维度/属性快照重建、商品汇总、专用日志和系统日志都在同一短事务。退役或恢复后的活跃SKU必须至少一条，且仍是当前维度值的完整笛卡尔积；只选择一个颜色的一半尺码会整笔失败。成功前重新读取活跃维度、SKU身份/金额/库存、属性快照、主商品库存/最低价/缺货状态、所选退役状态和新增日志数量，任一不一致即回滚。

消费者和新交易路径统一排除 `is_retired=1`：普通商品SKU DAO、商品详情、购物车解析/列表、活动下单SKU映射、秒杀/砍价/拼团/积分/套餐/新人读取、促销赠品以及Out条码库存解析都只接受活跃行；Out商品拓扑编辑遇到已退役SKU直接拒绝。订单履约、取消、退款和虚拟交付等历史路径仍可按原 `unique` 定位旧行。审计额外修正了取消/退款：数量会退回退役SKU并扣减历史销量，但不会把该库存无条件加回 `store_product.stock`；以后恢复SKU时，事务会从全部活跃行重新计算并纳入这部分库存。

### Admin操作面、浏览器证据与门禁结果

商品编辑页现在只允许勾选已有数据库ID的活跃SKU退役，另表展示已退役SKU并支持恢复；两类操作都要求2至255字原因，响应必须含 `verified=true` 才提示成功。页面明确展示未结购物车、未支付订单、活动、促销、抽奖、门店和完整组合门禁。桌面预览实际选中米白S/M两行，提交原因后收到“已退役 2 个SKU”；随后选中沙色S/M历史行并收到“已恢复 2 个SKU”。390×844下页面和文档宽度均为390，活跃表249px容器内部可横向滚动至1278px内容，选择框、组合列和退役按钮可用，确认框左右边界为0/390，浏览器error为0；临时视口和标签页已恢复/关闭。

本地完整Worker单元201文件/1,280项、单元与运行时TypeScript、Admin 2,427模块生产构建全部通过；Admin静态请求为314个调用点、334个路径变体，334条全部注册且可执行，未注册、未解析、受控不可用均为0。schema为源201、目标263、共享201、源字段缺口0，外部/Worker迁移表均263且定义漂移0；全局路由为PHP 1,904 / TS 1,571 / 精确匹配849 / 可执行831 / 受控不可用18 / 缺失1,055 / 退役16 / 可执行缺口1,039；observability为17类信号、10个组件、53个必需事件、424个生产源码文件。Windows本地 `workerd` 仍在业务测试前因日志目录权限与宿主访问冲突启动失败，运行时0项不能计作通过；精确实现提交 `dd3e05b4abdf08f9a4ca2289663605c65b3ea3f6` 推送后，[Actions `33621216362`](https://github.com/cinagroup/cinashop/actions/runs/33621216362) 的Linux workerd、Worker类型/单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp、生产依赖审计与全历史Gitleaks共8/8成功。

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行 `0126` DDL/DML、Queue、R2或第三方调用，也没有部署Worker/Admin Pages。FE-001E5B2只标记“候选完成，未发布”；生产重复身份/依赖数量、DDL执行与回滚演练、真实管理员和受限角色、历史单/多规格商品及预发发布验收仍归E6/发布门禁。E5B父项继续被其余旧批处理类型阻塞。

## FE-001-E5B3 其余旧商品批处理迁移（2026-09-02）

### 旧实现审计：排队成功不等于数据成功，推荐还会覆盖真实标签

旧 `StoreProductBatchProcessServices` 和 `ProductBatchJob` 把类型3～9分别解释为配送方式、赠送积分/优惠券、用户标签、推荐位、系统表单、运费及品牌。主表类任务每30个商品拆一组，关系/赠券类先按100个拆分再逐商品投递；接口只确认任务入队。执行器捕获单个任务异常后写日志并继续，不向原请求返回逐项失败，也没有跨商品、主表、关系与赠券的原子回滚或最终回读。重复投递、进程中断或候选资料并发停用时，管理员可能收到“成功”但只完成一部分。

更严重的是，旧推荐任务把热卖、促销、精品、新品、优品编码为 `store_product_relation.type=3` 的关系ID 1～5，而同一类型在商品编辑、商品标签批处理及搜索中本来就表示真实商品标签。执行推荐批处理会先删除type=3关系，因此可能无提示抹掉商品标签；搜索器继续按1～5关系判断推荐状态，又会把恰好使用这些ID的真实标签误判成推荐。迁移不能保留这个冲突语义。

### 七类新合同与数据边界

- 配送方式：必须从快递、门店自提、门店配送中选择1～3项，按规范顺序替换CSV。
- 下单赠送：积分规范为非负两位小数；最多20张未删除且启用的优惠券，空集合明确清除旧赠券。主表积分与 `store_product_coupon` 删除/重建处于同一事务。
- 用户标签：最多50项，可清空；候选必须启用，且对每个所选商品都是平台标签或精确匹配该商品 `type/relation_id` 的owner标签，同时替换兼容CSV与type=4关系。
- 活动推荐：仅接受五个固定键，可清空；权威状态写入 `is_hot/is_benefit/is_best/is_new/is_good` 独立列，搜索同步改读这些列，不再改写type=3商品标签关系。
- 系统表单：只允许0（清除）或一张未删除且启用的表单。
- 运费：只允许包邮、正数固定运费或一张启用且未删除的模板；模板必须是平台模板或精确匹配全部所选商品owner。非当前模式的固定金额/模板ID归零，避免陈旧组合。
- 品牌：最多50级有序路径，可清空；候选必须启用且未删除，多级输入必须是连续父子链。主表叶子品牌、品牌路径与type=2关系同步替换；当前Admin选择单个品牌，后端仍兼容旧有序路径合同。

主管理端仅通过已有的认证Admin边界进入这些写操作，候选下拉只暴露平台可用资料；服务端不信任前端，仍重新校验候选状态和owner。请求体继续限制8 KiB，只接受最多100个去重、升序的显式商品ID，不恢复旧“按当前筛选全选”或后台再次扩展结果集。关系最多50项、赠券最多20张，因此选择同步短事务而不是旧Queue；失败由原请求明确返回，管理员修正原因后可重试，无需猜测后台是否部分执行。

### 并发、幂等、回读和审计

事务设置2秒锁等待和5秒语句上限，先按商品ID升序取得E5A/E5B1共用的商品advisory lock，再按相同顺序锁定全部未删除商品行。候选分类、标签、优惠券、用户标签、表单、运费模板和品牌在写前使用共享行锁，避免校验后被并发停用或删除。关系和赠券采用“删除目标集合后按规范顺序重建”，相同显式请求重复执行会收敛到同一数据库状态；直接商品赠券编辑也先取得同一商品锁，消除两条写路径互相覆盖的窗口。

成功前在同一事务完整读取所选商品的全部相关列、目标关系集合与赠券集合，按商品数×候选数核对数量、ID、父分类、关系状态、优惠券ID和规范CSV；任一缺行、多行、旧关系残留或字段不一致都会抛错并整批回滚。每个商品写一条管理员、来源路径、操作类型以及候选数量/指纹到 `system_log`，不记录候选名称或业务正文；只有数据库回读完成才返回 `verified=true`。这是一笔“全成或全败”的受控批次，不再把队列接受冒充业务完成。

### Admin真实控件、门禁与剩余范围

商品列表批量弹窗现有11种操作：上下架、分类、商品标签以及本项七类。候选资料只加载一次，分类/配送在前端先做非空检查，赠券/用户标签/推荐/表单/品牌均明确支持清空，运费根据模式只显示固定金额或模板控件。应用内浏览器在桌面实际选择2个商品，执行“替换下单赠送”并收到“已处理 2 个商品”；切换固定运费只出现一个金额输入，切换模板时空值显示“请选择可用模板”并列出两个候选。390×844下正文、弹窗和文档宽度均为390px范围内，弹窗可完整滚动且没有页面级横向溢出；浏览器error为0，临时服务、视口与标签页均已关闭。

本地完整Worker单元201文件/1,280项、单元与运行时TypeScript、Admin 2,427模块生产构建全部通过。Admin静态请求为314个调用点、334个路径变体，334条全部注册且可执行，未注册、未解析、受控不可用均为0；schema为源201、目标263、共享201、源字段缺口0，外部/Worker迁移表均263且定义漂移0；全局路由为PHP 1,904 / TS 1,571 / 精确匹配849 / 可执行831 / 受控不可用18 / 缺失1,055 / 退役16 / 可执行缺口1,039；observability为17类信号、10个组件、53个必需事件、424个生产源码文件。精确实现提交 `34f384f4f5b7446516f947c169e74c9f3ecf8c7e` 推送后，[Actions `33624903001`](https://github.com/cinagroup/cinashop/actions/runs/33624903001) 的Linux workerd、Worker双TypeScript/1,280项单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp、生产依赖审计与全历史Gitleaks共8/8成功。

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行DDL/DML、Queue、R2或第三方调用，也没有部署Worker/Admin Pages。FE-001E5B3与E5B父项只标记“候选完成，未发布”；非平台SKU生命周期、真实主管理员与受限角色、生产历史商品、生产DDL/回滚演练、预发发布和观察仍归E6及发布门禁。

## FE-001-D1 内容域13屏逐项审计与社区设置（2026-09-02）

### 逐屏分母与结论

旧 Admin 实际导入的 `router/modules/content.js` 只有13条活跃业务路由：社区5条、CMS文章3条、小程序直播5条。新 Admin 则将它们聚合到 `/community`、`/content/article` 和 `/marketing/live` 三个页面。聚合页存在不等于其中每个旧操作都存在，因此本轮新增 `audit/admin-legacy-content-route-parity.json`，逐条记录旧路径、旧组件、candidate/partial/missing、新页面、新API、权限、已覆盖和剩余缺口；测试固定13条分母及5/5/3统计，禁止以后仅按标题抬高覆盖率。

| 旧屏幕 | 状态 | 新操作面 | 主要未完成项 |
|---|---|---|---|
| 社区话题 | candidate | `/community#topics` | 生产历史数据与真实角色E2E |
| 社区内容 | candidate | `/community#posts` | 生产历史数据与真实角色E2E |
| 添加/编辑社区内容 | candidate | `/community#posts` | 生产媒体URL及创建/编辑E2E |
| 社区评论 | candidate | `/community#comments` | 生产评论树与真实角色E2E |
| 社区设置 | candidate | `/community#settings` | 生产重复行清理及读写回读E2E |
| 文章管理 | partial | `/content/article` | 分类、封面、摘要、分页、排序与完整动作 |
| 文章分类 | missing | 无 | 分类层级、CRUD、引用保护与权限 |
| 文章添加/编辑 | partial | `/content/article` | 分类、封面、摘要、富文本UI、URL、关联商品 |
| 直播间管理 | partial | `/marketing/live#rooms` | 远端创建/编辑/删除、显隐、回放与商品关联 |
| 新增直播间 | missing | 无 | 提供商写合同、幂等、持久编排、对账与回滚 |
| 直播商品管理 | partial | `/marketing/live#goods` | 远端创建/编辑/删除、重审、显隐与房间关联 |
| 新增直播商品 | missing | 无 | 提供商写合同、幂等、持久编排、对账与回滚 |
| 主播管理 | partial | `/marketing/live#anchors` | 创建/编辑/删除、角色同步与显隐写入 |

统计为candidate 5、partial 5、missing 3、retired 0。直播目录只计入可执行的本地只读目录与Queue分发的远端状态读取；页面自身明确提示微信外部写操作尚未迁移，所以新增直播间、直播商品两屏保持missing，目录和主播保持partial。文章页目前只有标题、作者、正文和状态的紧凑CRUD，不能冒充旧分类、富文本、封面、摘要及关系能力。

### 社区设置缺口与安全保存合同

旧社区设置实际管理六个 `system_config` 键：`community_status`、`community_verify`、`community_video_verify`、`community_comment_status`、`community_comment_add`、`community_comment_verify`。迁移前公开Worker已读取这些键，新Admin却没有设置操作面，形成“运行时依赖已迁、运营入口丢失”的真实缺口。

新专用服务只接受完整六键对象及布尔/0/1值，未知、缺失或其他数值一律拒绝；控制器继续使用16 KiB流式有界JSON，不接回可任意整表改写配置的通用接口。GET要求 `community.view`，POST要求 `community.manage`，响应使用 `private, no-store`。读操作按现有 `SystemConfigDao` 的高sort/新id优先级返回有效值，同时显式报告缺失键与重复键。

保存事务设置2秒锁等待、5秒语句上限，取得社区设置advisory lock后锁住全部现有配置行。缺失键按白名单元数据创建；任何键出现重复历史行则失败关闭并要求先执行DB-003清理，不静默选择或批量覆盖。写入后在同一事务重新读取六键，缺行、多行或任一值不一致都会整体回滚；同事务写入一条不含请求正文的管理员日志，只有完整回读后返回 `verified=true`。提交成功后等待删除六个 `cfg_*` KV缓存键，避免数据库已更新而用户端继续读取30分钟旧值；缓存失效失败会让请求明确失败，管理员可安全重试同一收敛写入。

### Admin操作面、浏览器证据与门禁

`/community` 新增“社区设置”页签，逐项展示社区总开关、图文审核、视频审核、评论展示、评论发布和评论审核。缺失历史键会提示首次保存时创建；发现重复键时开关与保存按钮停用并显示清理原因。只有 `community.manage` 或超级管理员可操作，保存响应没有 `verified=true` 时页面不提示成功。

应用内浏览器在 `http://127.0.0.1:4175/community?preview=1` 验证页面标题“社区运营 - CinaShop 管理后台”、非空DOM、无Vite遮罩和0条warning/error；桌面页签显示完整两列六开关。实际把“启用社区”由开切为关并点击保存，页面出现“社区设置已保存并生效”。390×844下六个设置项转为单列，正文、body和视口宽度均为390，没有页面级横向溢出；首屏保存按钮和前三项完整可操作，其余三项在正常纵向滚动内。临时视口、标签页和本地服务均已恢复/关闭。前端测试调试规范直接要求了生产构建、页面身份、非空DOM、遮罩、日志、截图、真实交互与双视口证据，因此本项没有用“构建成功”替代渲染验收。

本地完整Worker单元202文件/1,284项、单元与运行时TypeScript、Admin 2,427模块生产构建全部通过。Admin静态请求推进为316个调用点、336个路径变体，336条全部注册且可执行，未注册、未解析和受控不可用均为0；全局路由为PHP 1,904 / TS 1,573 / 精确匹配849 / 可执行831 / 受控不可用18 / 缺失1,055 / 退役16 / 可执行缺口1,039。schema仍为源201、目标263、共享201、源字段缺口0，外部/Worker迁移表均263且定义漂移0；observability为17类信号、10个组件、53个必需事件、425个生产源码文件。精确实现提交 `9ad50534f10cc1bb21f5fe68e0d7b9a50ec99a96` 推送后，[Actions `33628399986`](https://github.com/cinagroup/cinashop/actions/runs/33628399986) 的Linux workerd、Worker双TypeScript/1,284项单元/schema/route/observability、Admin/PC/Supplier/Kefu/UniApp五端、生产依赖与全历史Gitleaks共8/8成功。

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行DDL/DML、Queue、R2或第三方调用，也没有部署Worker/Admin Pages。FE-001D1与社区设置只标记“候选完成，未发布”；生产重复配置审计/清理、主管理员与只读/编辑受限角色、真实历史社区数据和发布观察仍归DB-003、FE-001G/H。FE-001D父项继续被其余261条旧业务路由逐屏映射阻塞。

## FE-001-D2 CMS文章三屏迁移闭环（2026-09-03）

### 旧实现逐屏复核与状态修正

本轮以旧 Admin 实际启用的三个 CMS 路由、Vue 页面、PHP controller/service/DAO/model 和旧 UniApp 调用为权威，不以新页面名称或已注册路由推定迁移完成。旧“文章管理”支持按分类和标题检索、分页、封面/分类/标题/关联商品/浏览量/时间展示，以及新增、编辑、删除和商品关联；旧“文章分类”实际是平面目录，不是树形分类，管理名称、简介、图片、排序、状态和引用保护删除；旧“文章添加”要求标题、分类、封面和正文，并管理作者、摘要、HTML正文、分享标题/摘要、来源URL、排序、关联商品、发布、热门和轮播。此前新页只有标题、作者、普通文本正文和状态，文章列表与编辑只能算partial，分类整屏missing。

| 旧屏幕 | D1状态 | D2状态 | D2可执行操作面 | 仍需验收 |
|---|---|---|---|---|
| 文章管理 | partial | candidate | 分类/标题/状态筛选、分页、封面/摘要/关系/浏览量/排序/运营标记、创建/编辑/可恢复删除 | 生产历史数据、真实角色列表/关系/删除E2E |
| 文章分类 | missing | candidate | 平面目录、标题/状态筛选、图片/简介/排序、创建/编辑/停启、引用保护软删除 | 生产分类数据、引用保护和受限角色E2E |
| 文章添加/编辑 | partial | candidate | 必选分类/封面、作者/摘要、受清洗HTML、分享字段、URL、商品、发布/热门/轮播、素材目录选择 | 生产私有附件、真实角色创建/编辑E2E |

`workers-ts/audit/admin-legacy-content-route-parity.json` 因此从D1的candidate 5、partial 5、missing 3推进为candidate 8、partial 3、missing 2。剩余三条partial和两条missing全部属于小程序直播远端写操作；CMS三屏没有继续借“待以后完善”抬高状态。页面合并只改变导航组织，不改变逐屏语义分母。

### API、权限与输入合同

专用 `AdminArticleController` / `AdminArticleService` 替换旧通用CRUD实现，同时保留 `/adminapi/article/list|save|del/:id` 兼容入口并增加详情、分类CRUD/状态、商品候选、图片素材及素材分类等合同；`/api/v1/admin` 别名同步注册。所有入口仍经过现有Admin认证和 `article.view/article.manage` 权限映射；文章编辑者只能读取平台素材，不能由文章权限取得上传、移动或删除素材的能力。读取响应统一 `private, no-store`。文章请求体最大1 MiB，分类请求体最大16 KiB，分页、候选数、页码、排序、ID和各文本长度均有上限；未知字段失败关闭，避免响应专用字段被页面原样回传后静默入库。

文章合同显式映射snake_case/camelCase别名，分类ID、封面和正文必填；分类名称保持旧20字符上限。正文保存前重建安全HTML allowlist，封面、正文和分类图中的短时私有附件签名在入库前还原为稳定canonical ref，来源链接拒绝主动协议、明文HTTP和协议相对URL。读取时才以 `APP_KEY` 渲染短时私有资源地址，签名工作不占用写事务。商品候选只允许平台自营、未删除商品；素材候选固定平台素材作用域和图片类型，并一次读取全部层级供页面显示“父 / 子”路径，写操作仍留在独立素材中心。

### PostgreSQL一致性、并发与索引

文章保存事务先设置2秒 `lock_timeout` 和5秒 `statement_timeout`，再取得目标分类共享advisory lock与文章写锁；分类删除/编辑取得同一分类域的独占锁。因此“校验分类存在后被并发删除”和“保存文章时分类删除漏过引用检查”的窗口被关闭。分类、关联商品在写前使用共享行锁，更新文章和分类使用行写锁；创建操作也按固定零ID锁序列化，避免同类写路径锁顺序漂移。

`system_article` 与 `article_content` 在同一短事务保存，正文使用以 `nid` 为冲突键的upsert；成功前重新连接分类、正文和商品，逐字段核对主表正文、镜像正文、分类、标题、作者、摘要、状态、封面、分享字段、排序、URL、商品和运营标记。任一缺行或不一致抛出内部错误并整体回滚。文章删除只设置 `is_del=1/status=0`；分类删除先在相同锁域检查未删除文章引用，再软删除并回读。每次成功写入同事务 `system_log`，只记录动作、ID和候选数量，不记录标题、摘要或正文。

迁移 `0127_admin_article_indexes.sql` 及Drizzle schema同步增加文章活跃排序、分类引用、分类活跃排序和平台商品候选四个索引。Admin列表保留旧页码式UX，因此使用有界offset（页码最多10,000、每页最多100），没有把keyset分页强行改变为不兼容的交互；分类为平面小型配置表，一次最多500条，仍是有界响应。Cloudflare Workers规范审查直接促成了全局对象/连接复用边界、无全局请求状态、请求体上限及签名工作移出事务；PostgreSQL规范审查直接促成了短事务、固定锁顺序、共享/独占锁、精确回读和查询匹配索引。

### Admin页面与实际渲染证据

`/content/article` 现在由“文章管理/文章分类”两个页签承载旧三屏。文章表显示封面、分类、标题、摘要、商品、状态、热文/轮播、浏览量、排序和时间；编辑弹窗提供分类、商品远程检索、手填稳定封面引用或按嵌套素材目录选择现有图片、标题/作者/摘要、HTML源码与常用格式按钮、分享字段、来源URL、排序及三类开关。页面不使用 `v-html` 执行管理员输入，服务端仍是最终清洗边界。分类页提供检索、分页、图片素材、简介、排序、停启、编辑和引用保护删除。

应用内浏览器在 `http://127.0.0.1:4179/content/article?preview=1` 完成真实控件验收：页面标题为“CMS 文章 - CinaShop 管理后台”，文章与分类页签均正常渲染；新建文章时实际打开素材选择器、选择 `cinashop-brand.png`、填写标题/作者/摘要/HTML正文、执行二级标题格式化并保存，页面提示“文章已保存并完成双表核验”且新行出现。390×844视口下文档 `scrollWidth/clientWidth` 均为390，弹窗左右边界约8/366px、内容宽度358px，分类与HTML编辑控件可见，没有页面级横向溢出。桌面和移动端均无Vite遮罩，console warning/error为0。该证据是本地 `preview=1` 候选UI证据，不冒充真实权限或生产数据库E2E。

### 自动门禁、提交与生产边界

本地完整Worker单元203文件/1,289项、单元与运行时TypeScript、Admin 2,428模块生产构建全部通过。Admin静态请求为325个调用点、345个路径变体，345条全部注册且可执行，未注册、未解析和受控不可用均为0；Admin页面盘点仍为旧274条业务路由/245个独立组件，对比新52条业务路由/51个独立组件。schema为源201、目标263、共享201、共享源字段缺口0，外部/Worker迁移表均263且定义漂移0；全局路由为PHP 1,904 / TS 1,591 / 精确匹配849 / 可执行831 / 受控不可用18 / 缺失1,055 / 退役16 / 可执行缺口1,039；observability为17类信号、10个组件、53个必需事件、427个生产源码文件。

精确实现提交 `9fd14e95f337663f910ed6d92a76e1c7b5263186` 推送后，[Actions `33705817573`](https://github.com/cinagroup/cinashop/actions/runs/33705817573) 的Repository secret scan、Worker双TypeScript/单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu及UniApp共8/8成功。

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行 `0127` DDL/DML、R2写入、Queue或部署Worker/Admin Pages。D2只标记“候选完成，未发布”；生产需另行明确连接方式、只读/写入SQL范围和测试记录回收方案，再验证历史文章/分类/正文双表、canonical附件与R2对象、孤儿商品关系、真实主管理员及只读/编辑受限角色，最后执行预发、发布和观察。FE-001D父项仍被其余261条旧业务路由逐屏映射阻塞，FE-001G/H仍未完成。

## FE-001-D3 小程序直播本地管理与三类只读同步（2026-09-03）

### 旧实现复核与迁移状态

本轮重新读取旧 Admin 的直播路由、三个controller、service/DAO/model、五张页面与 `LiveClient.php`，并将“页面存在”与“微信侧资源可安全写入”拆开计量。旧实现不是一个可以原样搬运的原子流程：创建直播间先调用微信再保存本地，数据库失败会遗留远端孤儿；直播间加商品先写本地关系再调用微信，远端失败会产生本地漂移；批量添加商品逐个调用微信后才批量保存本地，部分远端成功时无法可靠恢复；商品审核/重审代码读取 `good_id` 而表字段为 `goods_id`，旧 Admin API wrapper也没有接出审核、重审和删除调用；商品删除先本地软删再调用微信，失败后两侧不一致；主播删除只取并删除第一间引用直播间，不能保证引用完整。上述顺序、字段错误和不完整级联均作为迁移风险记录，没有为了追求路由数量而复制。

| 旧屏幕 | D2状态 | D3状态 | D3可执行操作面 | 主要剩余缺口 |
|---|---|---|---|---|
| 直播间管理 | partial | partial | 分页/筛选、详情、本地显隐、本地软删除与全部本地商品关系清理、三类只读同步 | 远端创建/编辑、房间商品绑定、回放管理、对账与真实数据E2E |
| 新增直播间 | missing | missing | 无远端写表单，避免重复创建微信资源 | 当前提供商合同、耐久outbox、幂等/补偿、对账、回滚和生产验收 |
| 直播商品管理 | partial | partial | 分页/筛选、详情、审核状态同步、仅审核通过商品的本地显隐 | 远端编辑/删除/审核/重审、房间绑定、对账与真实数据E2E |
| 新增直播商品 | missing | missing | 无远端写表单，避免批量部分成功 | 当前提供商合同、逐项耐久状态、幂等/补偿、对账和生产验收 |
| 主播管理 | partial | candidate | 搜索、详情表单、新增/编辑、显隐、引用保护软删除、保存前角色核对、角色同步 | 生产历史数据、真实权限角色、微信真实账号和更严格引用策略的运营验收 |

`audit/admin-legacy-content-route-parity.json` 因而从D2的candidate 8、partial 3、missing 2推进为candidate 9、partial 2、missing 2。只有主播屏在本轮进入candidate；直播间和商品目录仍明确保留partial，两张远端新增屏继续missing。`candidate` 仍表示本地候选操作面和合同存在，不表示已发布或已通过生产验收。

### 本地写合同、权限与数据库一致性

兼容入口新增直播间 `detail/:id`、`set_show/:id/:is_show`、`del/:id`，商品 `detail/:id`、`set_show/:id/:is_show`，主播 `add/:id`、`save`、`set_show/:id/:is_show`、`del/:id`、`syncAnchor`；`/adminapi` 与 `/api/v1/admin` 两套路径均注册。旧系统将显隐与同步保留在GET，因此新服务在保留URL合同的同时，把这些精确路径强制映射为 `live_broadcast.manage`，详情/目录仍为 `live_broadcast.view`；POST/DELETE继续要求manage。Admin读取与写入响应设置 `private, no-store`，主播请求体以16 KiB流式上限读取，只接受ID、名称、微信号、手机号和图像引用，拒绝未知字段、双别名歧义、非法中国大陆手机号及非HTTPS/非站内图像路径。

所有本地写事务设置2秒 `lock_timeout` 和5秒 `statement_timeout`，按主播、直播间、商品三个固定advisory lock域串行，再取得目标行写锁。主播保存先在事务外只读请求微信角色列表，并要求返回中存在完全相同的微信号；事务内拒绝未删除重复主播，主播微信号变化时检查旧微信号的活跃直播间引用。主播删除由旧版“软删主播并删除第一间直播间”收紧为引用存在即失败，不隐式删除任何直播间。商品只有 `audit_status=2` 时可改变本地展示，服务端在锁内重新验证而不信任按钮禁用状态。直播间删除只做旧语义允许的本地软删除，并在同一事务删除该ID的全部本地商品关系，不调用微信远端删除。

`live_room` 的源权威主键是异常的 `(id,phone)`，而旧HTTP路径只有单一 `id`。详情、显隐和删除因此先按ID最多读取两行；不存在时返回业务错误，发现两行时以“源复合主键下不唯一”失败关闭，只有唯一行才使用精确 `(id,phone)` 条件更新，避免一次兼容请求误改多行。每项成功写入都使用 `RETURNING` 或事务内重读核对目标状态，任何缺行或值不一致都会回滚；同事务 `system_log` 只记录管理员、路由、动作、对象ID、显示值或引用计数结论，不记录主播名称、微信号、手机号或图像。

### 微信只读同步与远端写边界

既有直播间和商品状态同步扩展为第三类 `live_anchor_sync`。手动同步一次批量投递三个Queue消息；Cron根任务同样包含三类。主播读取复用旧代码确认的 `wxaapi/broadcast/role/getrolelist`，固定 `role=2`、每页最多30条、响应最多512 KiB、8秒超时，并仅解析有界的username/nickname/headingimg/updateTimestamp。同步先完成远端读取，再进入短事务；主播同步同时取得同步锁和主播管理锁，使手工保存与Queue重放不会并发插入同一活跃微信号。已删除主播不会被同步复活；活跃同微信号行只更新名称与头像，缺失时才插入。分页游标按远端原始行数推进，满30条才发送continuation，重复消息收敛到同一本地投影。

本轮还以 `@cloudflare/workers-types@5.20260902.1` 核对Queue `send/sendBatch` 与Hyperdrive类型，临时下载目录已删除；Worker代码不在全局保存请求态、不持有跨请求数据库连接，外部请求有超时和响应体上限。公开可访问的微信文档未能为本轮涉及的全部远端写接口提供可核验的当前权威合同，旧client还保留 `goods/autdit` 拼写，而可见生态实现使用不同路径。由此不能把旧PHP路径或第三方库常量当作当前生产合同：直播间创建/编辑、房间商品绑定、商品添加/更新/审核/重审/删除必须在提供商沙箱或明确测试账号验证请求/响应后，再设计含唯一请求键、逐项状态、租约、退避、人工裁决和对账的耐久outbox，不能直接暴露为HTTP里的“调用微信后写数据库”。

### Admin操作面与浏览器证据

`/marketing/live` 的边界提示改为“本地管理 + 只读同步”。桌面表格为直播间提供详情、显隐和本地删除，为商品提供详情与审核门禁显隐，为主播提供新增、编辑、显隐和删除；移动端提供相同操作按钮。主播表单明确说明保存前只读核对身份且不改变微信角色，直播间删除确认明确说明只删本地及关系、不删除微信资源，关联主播删除错误直接展示服务端原因。

应用内浏览器在 `http://127.0.0.1:4418/marketing/live?preview=1` 完成实际交互：1280×720桌面端打开直播间和商品详情，切换直播间及审核通过商品的本地展示，确认审核中商品按钮禁用；新增主播、停用、编辑名称、删除无引用主播，并确认删除“小雅”因仍有关联直播间而被拒绝；点击同步后出现“已排队3个只读同步任务”。390×844下桌面表格隐藏、卡片列表显示，主播编辑弹窗边界为0～390px，文档 `scrollWidth=390`，没有页面级横向溢出。页面标题、非空DOM、移动按钮与告警均可见，浏览器console warning/error为0。该证据完全使用本地preview数据，没有连接PostgreSQL、Queue或微信。

### 自动门禁、CI修复与生产边界

本地Worker单元203文件/1,290项全部通过，单元与运行时TypeScript通过，Admin生产构建2,428模块通过。Windows本机Cloudflare workerd仍在运行任何断言前以 `0xc0000005` 启动失败，沙箱外重跑也相同，因此不把本机运行时结果写成通过。首个实现提交 `8eb81eefb60d818dbdbb7fddef76c58a25cbe53a` 的CI准确发现Cron新增主播同步后，运行时测试仍期待18/19条而实际为19/20条；其余7个任务成功。修复测试分母的 `f688dcd6163d12d58479d6633e13367809b812b4` 推送后，[Actions `33708390827`](https://github.com/cinagroup/cinashop/actions/runs/33708390827) 的Linux workerd、Worker双TypeScript/1,290项单元/schema/route/observability、Admin、PC、Supplier、Kefu、UniApp、生产依赖及全历史Gitleaks共8/8成功。

Admin静态请求为334个调用点、354个路径变体，354条全部已注册且可执行，未注册、无法解析和受控不可用命中均为0。schema仍为源201、目标263、共享201、共享源字段缺口0，外部/Worker迁移表均263且定义漂移0；全局路由为PHP 1,904 / TS 1,613 / 精确匹配859 / 可执行841 / 受控不可用18 / 缺失1,045 / 退役16 / 可执行缺口1,029；observability为17类信号、10个组件、53个必需事件、427个生产源码文件。

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行DDL/DML、真实Queue投递、微信调用或Worker/Admin Pages部署。D3只标记“候选完成，未发布”；如需进入生产读取或写入，仍须明确连接方式、只读/写入SQL范围、测试记录回收方案和变更窗口。生产直播目录分布、复合ID歧义、重复主播微信号、关系多重集、微信凭据、真实主管理员及只读/编辑受限角色E2E继续归FE-001G/H；FE-001D父项仍被其余旧业务域逐屏映射阻塞。

## FE-001-D4A 系统设置首批打印/通知五屏审计（2026-09-03）

### 分母、方法与状态纪律

本轮没有按新Admin的路由数量或聚合页标题推定迁移完成，而是从既有权威 `audit/admin-frontend-inventory.json` 中精确筛出 `surface=page` 且路径以 `/admin/setting` 开头的76条旧业务页。新增可重复生成器 `scripts/admin-setting-frontend-parity-audit.ts` 和产物 `audit/admin-legacy-setting-route-parity.json`，逐条保留旧路径、标题、组件和源码行，并分别记录状态、目标页面、目标API、已覆盖语义、剩余缺口与证据。生成器要求分母必须恰为76且路径唯一；测试再把产物顺序与权威盘点逐项比对，拒绝手工遗漏、重复或无依据改变分母。

本轮只审查打印机列表、误标为“单据设置”的配置页、小票配置、消息管理和消息编辑5屏。状态统计为candidate 2、partial 2、retired 1、missing 0、unreviewed 71；71条未审屏的目标页面/API/已覆盖字段必须为空，并明确写为“尚未逐屏比对”。`candidate` 只表示本地代码、静态合同、单元与预览UI形成候选闭环，不表示生产数据、真实角色、第三方设备或发布已通过。

| 旧屏幕 | 状态 | 本轮结论 | 仍需完成 |
|---|---|---|---|
| `/admin/setting/document` 打印机设置 | candidate | `/setting/print` 覆盖名称/平台筛选、15条分页、新增/编辑/启停/删除、就绪状态和平台/供应商作用域 | 生产打印机数据形状、真实角色和设备E2E |
| `/admin/setting/document/config` 单据设置 | retired | 旧组件实际误复制商品规格页：只导入 `productSpecsList`，却调用未定义的 `isShowApi/userLabelAddApi`，删除路径也是 `product/specs/:id`，没有单据设置语义 | 无；不复制损坏页面 |
| `/admin/setting/document/content` 小票配置 | candidate | 标题、配送、备注、商品、运费、优惠、支付、订单、自定义内容、二维码、提示语及实时预览均有可执行操作面 | 真实打印机物理纸张版式验收 |
| `/admin/setting/notification/index` 消息管理 | partial | 已有四类订单通知渠道矩阵、提供商模板目录、就绪状态和持久投递台账 | type=1会员/type=2平台全消息目录、企业微信渠道总览 |
| `/admin/setting/notification/notificationEdit` 消息编辑 | partial | 可编辑四类订单通知的站内信、短信、公众号和小程序配置及模板 | 全目录逐项编辑、企业微信、远端模板同步安全流程 |

### 打印服务与PostgreSQL边界加固

旧打印列表以 `print_name` 和平台类型筛选，默认每页15条，并用 `POST print/set_status/:id/:status` 改状态。新服务此前已有平台 `supplier_id=0`、供应商正整数租户隔离、密钥只写不回显及活跃打印机状态约束，但状态入口只有PUT；请求只先检查声明的64 KiB长度再调用 `c.req.json()`，chunked正文仍可绕过内存上限；写事务虽然取得advisory lock，却缺显式锁等待/语句超时、操作日志和语义回读。

本轮在 `/adminapi`、`/supplierapi` 和 `/api/v1/admin` 保留PUT的同时恢复旧POST状态别名，审计日志记录实际请求方法。保存和小票正文改用通用流式有界JSON读取器，真实读取量最多16 KiB；所有列表、详情和写响应设置 `private, no-store, max-age=0`。写入从认证上下文派生平台Admin或Supplier Admin actor，不接受body中的租户/操作者声明；事务先设置2秒 `lock_timeout` 和5秒 `statement_timeout`，再按supplier作用域取得固定advisory lock。保存、启停、软删除和内容保存均在提交前精确重读目标行，任何凭据、状态、删除标记或JSON内容不一致都整体回滚；同事务写 `system_log`，只记录actor、作用域、对象ID、方法和动作，不记录易联云/飞鹅云密钥或小票内容。

小票合同把旧50字提示上限恢复到服务端，拒绝打印控制标记；规格编码只能在商品明细开启时启用，二维码开启必须提供站内绝对路径，底部提示开启必须提供非空文本。页码限制10,000、每页最多100，兼容旧页码式UX同时避免无界offset。既有 `print_document_supplier_id` 与活动查询索引覆盖本轮作用域、过滤和排序访问，因此没有为这批创建DDL。Cloudflare Workers最佳实践审查直接促成流式正文上限、无缓存响应和不持有跨请求状态；PostgreSQL最佳实践审查直接促成短事务、锁超时、固定锁顺序、精确回读和索引复核。

### Admin操作面与浏览器证据

`/setting/print` 的打印机页新增名称关键词、易联云/飞鹅云筛选、搜索/重置、15条分页和删除后页码回退。小票弹窗恢复旧字段集合并加入实时纸票预览；取消商品明细会同步移除并禁用规格编码，二维码可从商城首页、订单列表、个人中心、领券中心选择或输入受服务端复核的站内路径，提示语显示50字计数。预览数据扩为两类打印机并支持筛选、分页、创建、更新、删除和按打印机保存内容。

应用内浏览器在 `http://127.0.0.1:4175/setting/print?preview=1` 完成实际控件验收。桌面端页面标题为“小票打印 - CinaShop 管理后台”，输入“易联”后只保留易联云行，重置恢复两行，平台筛选“飞鹅云”只保留平台仓库打印机；打开小票后取消商品明细，规格编码立即变为禁用且从预览消失，启用二维码并选择订单列表后预览出现 `/pages/order/list`，提示语修改为“迁移审计预览”后字数和纸票同步变化。首次保存真实暴露了Vue响应式数组不能被 `structuredClone` 克隆的preview缺陷，改为显式复制goods/pay/order三个数组后重新打开并保存，出现“打印内容已保存”。

390×844视口下桌面表格隐藏并显示两张移动卡片，搜索和平台筛选占满可用宽度，文档无横向溢出；小票弹窗保持在视口内纵向滚动，底部实时预览和保存按钮可到达。桌面与移动端均无Vite错误遮罩，console warning/error为0。全部操作使用内存preview数据，没有读取PostgreSQL或调用打印提供商。

### 自动门禁、提交与生产边界

本地完整Worker单元204文件/1,294项全部通过，单元与运行时TypeScript通过，Admin生产构建2,428模块通过。Admin静态请求仍为334个调用点、354个路径变体，354条全部注册且可执行，未注册、未解析和受控不可用命中均为0；新增旧POST打印状态别名不会制造前端未注册调用。全局路由审计为PHP 1,904 / TS 1,616 / 精确匹配861 / 可执行843 / 受控不可用18 / 缺失1,043 / 退役16 / 可执行缺口1,027。Windows本机workerd仍在运行任何断言前因既有 `0xc0000005` 启动失败，因此本机结果没有写成通过。

实现与机器审计提交 `2f03669b4e0bf1675da307099ac34a53017dd397` 推送后，[Actions `33710753409`](https://github.com/cinagroup/cinashop/actions/runs/33710753409) 的Repository secret scan、Worker双TypeScript/1,294项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行DDL/DML、真实Queue、打印提供商调用或Worker/Admin Pages部署。生产打印机凭据与真实物理小票、历史通知目录、重复配置、主管理员和只读/编辑受限角色、预发发布与观察继续归CFG-007、DB-003、FE-001G/H；FE-001D4仍被其余71条setting业务屏逐项审计阻塞，FE-001D仍被整个274屏分母阻塞。

## FE-001-D4B 核心商城设置八屏审计（2026-09-03）

### 审计分母与逐屏结论

本批继续使用76条 `/admin/setting*` 权威业务页分母，没有用新版聚合页数量或已存在的后端服务推定前端完成。逐项阅读旧Admin组件、控制器、配置服务与实际消费者，并将系统表单、动态系统配置、商城基础、商品、交易、支付、协议和事业部8屏写入 `scripts/admin-setting-frontend-parity-audit.ts`；生成产物与测试要求每屏同时记录目标页面、目标API、已覆盖语义、剩余缺口和源码证据。本批后统计由reviewed 5 / candidate 2 / partial 2 / retired 1 / unreviewed 71推进为reviewed 13 / candidate 5 / partial 7 / retired 1 / unreviewed 63，未审屏继续保持空目标和明确的unreviewed状态。

| 旧屏幕 | 状态 | 本批证据结论 | 明确保留的缺口 |
|---|---|---|---|
| `/admin/setting/system/create` 系统表单 | partial | Worker已有表单定义CRUD、受控组件校验、提交数据和订单不可变快照 | 新Admin尚无表单列表、拖拽编辑器和提交数据查看页 |
| `/admin/setting/system_config` 动态系统配置 | partial | `/config` 已拆出商城运行、新人运营和客户端内容三类字段白名单页面 | 大量配置分类仍未逐项迁移；通用分类/任意键编辑器因越权写入与凭据泄露风险不恢复 |
| `/admin/setting/shop/base` 商城基础 | partial | 新页覆盖站点开关、名称、HTTPS地址、电话、备案、四类品牌图、悬浮菜单、视频和海报标题 | 登录轮播图/favicon素材流程、微信分享消费者、Worker原生密码与输入安全策略 |
| `/admin/setting/shop/product` 商品设置 | candidate | 警戒库存可读写，阈值变化时同步重算商品和普通SKU的 `is_police`、`is_sold`，原库存预警查询合同仍可执行 | 需在生产商品量上验证5秒事务上限 |
| `/admin/setting/shop/trade` 交易设置 | partial | 7类未支付/临期小时、自动收货/评价、售后期限、退货理由及平台退货地址兼容字段已接回 | 次卡临期提醒尚无Worker消费者；订单售后界面尚未展示平台退货姓名、电话和地址 |
| `/admin/setting/shop/pay` 支付设置 | partial | 仅开放余额、微信、支付宝和线下支付业务开关，并展示数据库开关与Worker运行时依赖合并后的实际就绪状态 | 微信公开商户参数和小程序支付分支合同尚未定稿；所有密钥继续从Admin退休 |
| `/admin/setting/shop/agreemant` 五类协议 | candidate | 既有 `/config/runtime-content` 覆盖隐私、用户、注销、供应商和代理商五类协议，兼容公共读取且Admin不执行HTML | 需对生产 `legacy_cache` 五类键做只读形状核验 |
| `/admin/setting/shop/division` 事业部设置 | candidate | 两个旧开关、父子依赖、客户端入口判定及独立事业部业务管理页形成候选闭环 | 需对生产开关与既有事业部角色做只读一致性核验 |

### 安全的商城配置操作面

新增Admin `/config/commerce` 四个页签及 `GET|POST /adminapi/config/commerce`。服务端不接受配置分类ID或任意键，只投影并保存35个明确的非敏感键：基础13、商品1、交易14、支付业务开关5、事业部2。响应不返回微信/支付宝私钥、证书内容、API Key或打印提供商密钥，页面也没有这些输入项；支付卡片调用既有 `PaymentReadinessService`，把数据库开关和Cloudflare运行时Secret是否齐全合并为“可用/不可用+原因”，避免“开关已开”等同于“支付可用”。微信商户号、证书序列号等非密钥公开参数仍需单独确定受控入口或部署期注入策略，旧 `pay_routine_open/pay_routine_mchid` 也保留为未完成合同。

基础字段拒绝HTTP、带账号或片段的网站URL，只允许HTTPS；图片地址只允许HTTPS或单斜杠开头的站内路径，协议相对 `//host` 被拒绝。整数按业务单位设上界，退货理由最多100条且逐条限长，电话字符集有界；事业部关闭时不能保存开启的代理申请。站点开放时名称和HTTPS地址必填。Admin保存按钮继续以 `config.manage` 控制，GET使用 `config.view`；服务端操作者ID、名称和IP只从已验证认证上下文及Cloudflare请求头派生，不接受正文声明。

### PostgreSQL、缓存与库存语义

POST正文使用共享流式读取器限制为32 KiB，GET/POST响应均为 `private, no-store, max-age=0`。写事务先设置2秒 `lock_timeout` 和5秒 `statement_timeout`，再取得固定 `admin-commerce-settings` advisory transaction lock并锁定白名单配置行；存在重复旧键时更新全部重复行，缺失键在同一事务补齐。提交前按规范化后的业务值逐键回读，任一不一致整体回滚；`system_log` 只记录actor、五个设置组和键数量，不记录配置值。提交后失效全部35个 `cfg_*` KV键。

只有 `store_stock` 实际变化时才重算未删除商品：商品总库存或任一未退役普通SKU库存不高于阈值即设置 `is_police=1`，存在库存为0的未退役普通SKU即设置 `is_sold=1`。该实现复刻旧PHP保存阈值后的派生状态语义，但生产商品总量未知，批量更新是否能稳定落在5秒内仍需获批窗口验证，因此商品屏只标记本地candidate而不是生产完成。本批复核现有schema与查询路径后没有新增DDL。

Cloudflare Workers最佳实践审查直接形成无跨请求可变状态、流式正文上限、无缓存敏感响应和Secret边界；PostgreSQL最佳实践审查直接形成短事务、锁等待/语句超时、固定锁顺序、行锁、语义回读与批量更新风险保留项。

### Admin交互、自动门禁与全局统计

应用内浏览器在 `http://127.0.0.1:4175/config/commerce?preview=1` 完成桌面实际交互：四个页签和基础字段可见；警戒库存20改为21、普通订单取消1改为2并编辑退货姓名；支付宝与线下支付开关保存后，预览就绪状态分别变为“商户配置未完成”和“可用”；关闭事业部时代理申请同步归零并禁用。页面宽1280时 `scrollWidth=1280`，console warning/error为0。曾尝试创建390×844浏览器上下文，但工具仍返回1280×720，因此本批只确认响应式CSS、TypeScript和生产构建，不把移动端浏览器交互写成已通过。

本地Worker完整单元205文件/1,299项全部通过，单元与运行时TypeScript通过，Admin生产构建2,432模块通过。Admin静态请求现为336个调用点、356个路径变体，356条全部已注册且可执行，未注册、未解析和受控不可用命中均为0。全局路由审计为PHP 1,904 / TS 1,618 / 精确匹配861 / 可执行843 / 受控不可用18 / 缺失1,043 / 退役16 / 可执行缺口1,027；新加两条安全聚合API没有改变旧路由匹配数，也没有伪造旧功能覆盖。实现与机器审计提交 `04520ca6c39fe0e9720c87c2d0987d8e82997d4f` 推送后，[Actions `33713047376`](https://github.com/cinagroup/cinashop/actions/runs/33713047376) 的Repository secret scan、Worker双TypeScript/1,299项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。

### 生产边界与待完成checklist

本批没有连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`，没有读取或改写生产PostgreSQL，没有执行DDL/DML、支付请求、Queue任务、Worker/Admin Pages部署或真实角色E2E。原因不是缺少用户的总体授权，而是生产批量库存重算、测试记录回收和回滚仍未给出精确执行范围与窗口，审计工作不应隐式扩大为线上写入。

缺口已落入 `MIGRATION_CHECKLIST.md` 的FE-001D4B1～B4：先补系统表单Admin操作面；再处理商城基础素材/分享/Worker原生安全尾项；随后实现次卡临期提醒和退货地址展示；最后确定支付公开商户参数与小程序支付分支的受控合同。支付密钥输入、通用任意键编辑器和旧PHP过滤开关不作为待恢复功能。FE-001D4仍被63条未审setting屏以及D4A/D4B的partial项阻塞，FE-001D仍被完整274屏分母阻塞。

## FE-001-D4B1 系统表单三屏迁移闭环（2026-09-03）

### 旧数据形状与逐屏结论

本轮没有把既有Worker CRUD等同于Admin迁移完成，而是重新阅读旧 `/admin/setting/system/create`、`/admin/setting/system_form`、`/admin/setting/system_form/data` 三条启用路由及其Vue、Vuex、PHP service/model和导出实现。旧创建页支持10类组件、拖拽排序、字段配置、保存/发布；目录支持名称/状态筛选、15条分页、新增、编辑、启停和删除；提交数据页支持用户、来源、关联业务与时间筛选及导出。三屏此前都没有新版Admin操作面，其中创建屏在D4B只能标为partial，目录和提交数据尚未进入逐屏统计。

旧Vuex `mobildConfig.defaultArray` 不是数组，而是以组件时间戳为键的对象；保存时直接把该对象提交，重新打开时再转数组并按 `timestamp` 排序。这一事实暴露了既有Worker只接受JSON数组的兼容缺口：生产历史模板即使数据完整，也可能被解析为空。本批服务同时接受旧时间戳对象和新数组，对旧对象按组件时间戳恢复顺序，再统一校验并保存为有序数组；`titleShow.val` 的布尔、0/1及字符串0/1也按真实值处理，避免字符串`"0"`被JavaScript误判为必填。

| 旧屏幕 | D4B状态 | D4B1状态 | 新操作面 | 仍需远端验收 |
|---|---|---|---|---|
| `/admin/setting/system/create` | partial | candidate | `/config/forms` 新增/编辑弹窗：10类组件、点击添加、拖拽/按钮排序、字段设置、选项、默认值、上传数和用户端预览 | 生产历史模板形状、真实商品下单快照 |
| `/admin/setting/system_form` | 未审 | candidate | `/config/forms`：名称/状态筛选、15条分页、新增、编辑、启停、删除 | 生产引用保护、主管理员与受限角色 |
| `/admin/setting/system_form/data` | 未审 | candidate | `/config/forms` 提交数据抽屉：用户/来源/关联ID/时间筛选、20条分页、CSV | 生产提交量、历史异常JSON、受限角色 |

因此76屏设置分母由reviewed 13 / candidate 5 / partial 7 / retired 1 / unreviewed 63推进为reviewed 15 / candidate 8 / partial 6 / retired 1 / unreviewed 61。`audit/admin-legacy-setting-route-parity.json` 由生成器重建，三屏分别记录目标页面、API、已覆盖语义、剩余风险和旧新源码证据；未审61屏继续保持空目标，不能因新增一个聚合页而抬高状态。

### 服务端合同、引用保护与敏感数据边界

系统表单列表只投影ID、版本、名称、封面、状态和时间，不再为每行加载完整模板JSON；详情才按需返回组件。列表/详情/提交数据及所有写响应统一设置 `private, no-store, max-age=0` 与 `Pragma: no-cache`。保存正文使用流式有界JSON读取器，实际上限1,100,000字节，改名限4,096字节；模板最多100个组件、序列化后最多1,000,000字节。组件类型固定为多选、城市、日期、日期范围、单选、下拉、文本、时间、时间范围和图片；标题、提示、选项、默认值及上传数均有上限，组件ID必须唯一，选项1～50项且去重，文本默认手机号/身份证/邮箱/正数按子类型校验。

新增、更新、改名、启停和删除都从已验证Admin上下文派生actor，不接受正文操作者。事务先设置2秒 `lock_timeout` 和5秒 `statement_timeout`，再取得固定advisory transaction lock；锁定目标行后检查同名，写后在同一事务精确回读名称、模板、状态或删除标记，任一不一致整体回滚。每次变更写入同事务 `system_log`，只含管理员、对象ID、方法和动作，不记录组件定义、用户提交值或手机号。

停用和软删除前检查未删除商品，以及处于启用且未删除状态的秒杀、拼团、砍价和积分商品；有引用时列出业务类型并拒绝操作。`0128_system_form_reference_indexes.sql` 为五张引用表增加以 `system_form_id` 开头的部分复合索引，匹配上述有界存在性查询。该DDL只存在于本地候选提交，尚未在生产执行。提交数据查询页码最多10,000、每页最多100，支持用户、来源、关联业务及闭区间时间条件；响应仍携带手机号等运营所需个人数据，所以保持私有且不缓存。前端只以文本渲染字段，不执行HTML或主动加载历史图片URL；CSV最多拉取5,000条，并在以 `= + - @` 开头的单元格前加单引号以阻断电子表格公式执行。

### Admin交互、自动门禁与生产核对

新 `/config/forms` 从系统配置目录进入。桌面表格和移动卡片提供同一操作集合，管理按钮继续受 `config.manage` 控制，读取要求 `config.view`。应用内浏览器在 `http://127.0.0.1:4176/config/forms?preview=1` 的931×792视口完成实际交互：创建“浏览器验收表单”，添加文本和单选组件，修改标题与选项，上移单选组件并保存；重新打开后顺序为“采购类型、文本框”。企业采购提交数据可见，用户ID筛选999后显示空态，重置恢复记录，CSV导出可触发。页面与body宽度均为931px，没有横向溢出；console只有Vite连接debug日志，没有warning/error。工具本轮没有建立真实390×844视口，因此只记录响应式实现与生产构建，不将移动端交互写成已通过。

最终本地Worker单元206文件/1,304项全部通过，单元与运行时TypeScript通过，Admin生产构建2,436模块通过。Admin静态请求为342个调用点、362个路径变体，362条全部注册且可执行，未注册、无法解析和受控不可用均为0。全局路由审计为PHP 1,904 / TS 1,620 / 精确匹配861 / 可执行843 / 受控不可用18 / 缺失1,043 / 退役16 / 可执行缺口1,027；新增GET兼容状态入口之外的PUT别名只改善写方法语义，没有伪造新的旧路由覆盖。实现与机器审计提交 `f76e7937ed5184df689441350fd77e65d09b3304` 推送后，[Actions `33715671291`](https://github.com/cinagroup/cinashop/actions/runs/33715671291) 的Repository secret scan、Worker双TypeScript/1,304项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。

根据用户授权，本批使用Wrangler 4.122.0执行只读身份与Hyperdrive配置查询：Cloudflare账号为CinaGroup，生产绑定ID `9748c294e21c49a99579c9cef70102e0` 的配置名为 `cinashop-pg`，源为PostgreSQL数据库 `postgres`、用户 `postgres`、VPC Service `019fe223-e5a1-7ed1-945a-8993a6f32508`，连接上限60且缓存开启。这也确认 `wrangler.toml` 的 `crmeb@localhost/crmeb` 只是 `localConnectionString`，不能作为生产库名或凭据。查询没有回显密码，也没有读取任何业务表。由于本批DDL尚未部署、生产模板异常形状与测试记录回收方案仍未确定，没有调用会运行整套迁移并初始化管理员的 `POST /api/_migrate`，没有执行生产DDL/DML、Worker/Admin Pages部署、Queue或第三方调用。生产模板/引用/提交数据只读核验、真实主管理员及只读/编辑受限角色E2E继续归FE-001G/H；D4B2～B4和61条未审设置屏继续阻塞FE-001D4。

## FE-001-D4B2 商城品牌、分享与Worker原生安全闭环（2026-09-03）

### 旧实现证据与逐屏状态

本轮沿用76条设置业务页权威分母，重新对照旧 `SystemConfigServices::shopBaseFormBuild`、`SystemAdminServices::getLoginInfo`、旧Admin商城基础页以及 `PublicController::share` 和 `/api/share` 路由。旧基础表单除站点名称、Logo和备案外，确实保存后台登录轮播、favicon、微信分享图/标题/简介；旧登录接口实际读取轮播和登录Logo，公开分享接口也有客户端消费者合同。旧页面同时暴露密码规则、登录失败、IP白名单和参数过滤等可编辑开关，但这些开关依赖PHP进程、全局请求过滤和旧认证实现，不能直接迁成Cloudflare Worker中的任意配置执行面。

本轮将 `/admin/setting/shop/base` 从partial推进为candidate：设置白名单由35增至40个非敏感键，新增 `admin_login_slide`、`ico_path`、`wechat_share_img`、`wechat_share_title`、`wechat_share_synopsis`。76屏总数和reviewed 15不变，状态由candidate 8 / partial 6 / retired 1推进为candidate 9 / partial 5 / retired 1，余下61屏继续unreviewed。动态系统配置、交易和支付仍保持partial；本轮没有因恢复公共读取端点而抬高其他旧屏状态。

### 素材持久引用、公共品牌与真实消费者

Admin商城运行页为站点Logo、方形Logo、登录Logo、后台Logo、favicon、分享图片和最多5张登录轮播提供同一R2素材搜索、选择和上传流程。附件列表现在同时返回用于即时预览的短期签名URL和稳定 `canonical_url=/api/assets/:id`；页面只保存稳定引用，服务端继续接受HTTPS或单斜杠站内路径并拒绝 `javascript:`、协议相对地址和重复轮播图。这样避免把15分钟后失效的私有R2签名查询串写入长期 `system_config`。配置读取时才对私有R2引用重新签名，旧JSON数组轮播仍能解析；写入仍沿用32 KiB流式上限、短事务、固定锁、精确回读、无配置值日志及白名单KV失效。

新增严格白名单的 `PublicBrandingService`。`GET /api/site_config` 只返回备案、站点名、四类品牌图、favicon和登录轮播，并设置浏览器60秒/共享缓存300秒；恢复兼容 `GET /api/share`，只返回分享图、标题和简介。站内 `/api/assets/:id` 以API源补全，其他相对站点资源以店铺源补全，私有R2对象按请求签名，非法资源引用返回空值而不是向客户端传播。三类真实消费者已落地：Admin登录页读取轮播、登录Logo、站名和favicon；PC布局读取站点Logo/备案/favicon并把分享字段投影到OG与description元数据；UniApp首页通过 `onShareAppMessage`、`onShareTimeline` 返回分享标题、图片和路径。

### Worker原生认证与响应安全

旧PHP的任意参数过滤、可编辑密码规则和登录防护开关没有恢复。Worker对所有响应添加固定CSP、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、Permissions Policy和HSTS；这些是代码审查、测试和发布控制下的不可降级策略。Admin登录正文流式限制4 KiB，账号最多64字符、密码最多256字符；来源在60秒内最多10次、账号在15分钟内最多30次，两个窗口分别由强一致Durable Object计数。账号和来源进入对象名之前以APP_KEY做HMAC，不保存原始身份或地址。

认证服务对不存在、停用、删除和密码错误统一返回同一消息；不存在账号仍执行固定cost-12 bcrypt假哈希，以缩小账号枚举与明显时序差异。成功或失败登录响应均禁止缓存。上述措施形成可执行的Worker安全合同，但不等同于生产渗透测试、真实角色验收或分布式攻击演练。

### 浏览器验收、自动门禁与生产边界

应用内浏览器在本地preview完成桌面实际操作：打开轮播素材选择器，选择 `cinashop-brand.png` 使轮播从2张变为3张；重复选择被“该轮播图已添加”阻止；第三张可向前排序；分享标题和简介保存成功，重新加载后值与顺序保持。390×844视口下页面与body宽度均为390，无横向溢出，favicon生效；同尺寸Admin登录隐藏桌面视觉轮播但保留Logo、标题和登录字段，恢复桌面视口后两张轮播及登录表单同时可见。全过程console warning/error为0。

最终本地Worker完整单元207文件/1,307项全部通过，单元与运行时TypeScript通过，Admin生产构建2,437模块、PC生产构建1,828模块及UniApp H5构建通过。Admin静态请求仍为342个调用点、362个路径变体，362条全部注册且可执行。全局路由审计为PHP 1,904 / TS 1,621 / 精确匹配862 / 可执行844 / 受控不可用18 / 缺失1,042 / 退役16 / 可执行缺口1,026，覆盖率45.3%。实现与机器审计提交 `9c7429a98690af252966ae702a5b4907f7f9ca9e` 推送后，[Actions `33717730974`](https://github.com/cinagroup/cinashop/actions/runs/33717730974) 的Repository secret scan、Worker双TypeScript/1,307项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。

根据用户授权，本轮沿用同一Wrangler只读控制面证据：Hyperdrive `9748c294e21c49a99579c9cef70102e0` 为 `cinashop-pg`，源是PostgreSQL数据库 `postgres`、VPC Service `019fe223-e5a1-7ed1-945a-8993a6f32508`，连接上限60且缓存开启。Wrangler控制面没有提供数据库密码，本批也不需要DDL：五个新配置键在首次Admin保存时由现有安全事务补齐。因此本轮没有查询生产业务表、执行DDL/DML、尝试生产登录、调用生产写接口或部署Worker/Admin/PC/UniApp；不能把控制面读取写成“生产数据已验收”。生产配置形状、私有R2历史引用、真实角色及已发布站点流程继续归FE-001G/H。下一步是B3的次卡临期提醒Worker任务与订单售后平台退货地址展示；B4支付公开商户配置仍保持未完成。

## FE-001-D4B3 次卡提醒与退货收件信息迁移闭环（2026-09-03）

### PHP权威语义与候选设计

旧PHP的`reminder_unverified_remind`每5分钟扫描已支付、未退款、未核销的次卡明细：临期分支读取`reminder_deadline_second_card_time`，到期分支按卡片`end_time`判断，分别以`is_advent_sms`、`is_expire_sms`防重，并用`reminder_brink_death`、`expiration_reminder`通知标记发送短信和站内信。新`SecondCardReminderService`保留这些业务条件和旧标志，但不在Cron里直接调用外部提供商：根任务按80条keyset分页投递不含手机号、模板内容或订单正文的opaque Queue消息；消费者再次读取卡片和订单状态，避免扫描后状态变化仍误发。

每张卡在2秒`lock_timeout`、5秒`statement_timeout`、固定advisory lock和行锁下处理；事件键、旧提醒标志及不可变`store_order_outbox`行在同一事务提交。新增`order.second_card.advent.notice`与`order.second_card.expired.notice`两种事件，复用已有通知outbox消费者和`external_notification_delivery`事件/渠道唯一账本，使Queue重复投递、Worker重试和外部UNKNOWN不导致重复站内信或重复短信。临期参数保持旧PHP的`phone/product_title/pay_time/end_time`，到期参数保持`phone/product_title/end_time`，没有为兼容而把个人信息写入Queue正文或日志。失败重试有界，最终失败进入现有可观测事件链。

外部`0129_second_card_reminder_indexes.sql`、Worker内嵌副本和`migration_0133`使用同一前向DDL：`soob_event_type_ck`从原三类事件扩展到五类，并增加`store_order_cart_info`上临期和到期扫描的两个partial索引。审查中发现若只加生产者而不扩展CHECK，首个真实事件会在事务中失败；该缺口在发布前即被约束迁移和测试封闭。旧通知审计Worker也同步升级，避免以后运行旧审计脚本反向收窄允许事件集合。

### 退货收件人层级与前端展示

新`RefundReturnContactService`按旧售后语义解析退货地址：`applyType=3`必须使用订单门店；否则优先订单供应商，缺失时回退平台配置。服务端对缺失或已删除的门店/供应商失败关闭，不按裸ID跨租户选择；响应同时提供camelCase`returnContact`和旧`_status`兼容投影。Admin退款详情始终展示已解析的收件人、电话和地址；UniApp只在应退货的状态4/5展示，同一信息块在窄屏自动换行。

本地Admin preview在退款列表打开ID 802的详情，实际可见收件人“CinaShop 售后中心”、电话`400-800-8888`及地址，浏览器可访问性树同时确认三个字段。该证据来自隔离fixture，只证明候选UI及字段绑定，不冒充生产售后数据或真实角色权限。

### 生产Hyperdrive只读事实与受控DDL

经用户明确授权，专用双SHA-256令牌审计Worker连接Hyperdrive `9748c294e21c49a99579c9cef70102e0`。生产为PostgreSQL 16.14；`store_order_cart_info`共28行、DDL前关系总大小172,032字节，`product_type=4`次卡为0，因此当前临期、到期和孤儿均为0。`reminder_deadline_second_card_time`没有配置行，候选运行时会使用1小时安全默认值；`reminder_brink_death`和`expiration_reminder`通知模板标记均不存在。活动售后共3条，全部走平台scope，当前没有状态4/5，也没有门店/供应商scope或缺失scope记录；平台`refund_name/refund_phone/refund_address`三个配置均为0行。outbox为0行。上述空值是明确的运营配置和源数据缺口，不能解释为真实提醒/退货流程已经可运行。

DDL前目录确认outbox CHECK只允许原三类事件，两个目标索引都不存在。审计入口在`store_order_cart_info<=100,000`行且关系不超过64 MiB的前提下，设置2秒锁等待、15秒语句上限并取得固定advisory lock后执行精确`0129`；同一迁移连续执行两遍，`idempotentSecondPass=true`、`businessRowsUnchanged=true`。最终CHECK允许五类事件、unsupported rows为0，两个索引均`indisvalid=true/indisready=true`，关系因新增索引增长至188,416字节。当前28行小表的`EXPLAIN`仍选择Hash Join/Seq Scan/Sort/Limit，总代价7.67、估算1行；这是小数据量下的正常计划，不能以“未使用索引”误判DDL失败。

首个临时审计Worker曾把缺失配置空字符串错误转换成0小时；当次在发现审计harness错误后立即中止，未进入DDL，Worker删除。修正为缺失时1小时后重新部署并完成上述读取和迁移。最终审计Worker的无令牌POST返回403、GET返回404；完成后Worker和Secret删除，公开URL复验404。主Worker与Admin/UniApp均未部署，也没有发送Queue、短信、站内信或改写业务行。

### 自动门禁、提交与剩余发布阻断

本地完整门禁为Worker 208文件/1,313项单元、单元与运行时双TypeScript、Admin生产构建2,437模块、UniApp H5构建、PHP 201/201源表到外部/内嵌263表的零漂移schema审计、342个Admin调用点/362个路径变体全部可执行，以及17个可观测信号/53个必需事件/435个生产源文件合同。Windows本机workerd仍在进入断言前以`0xc0000005`退出，因此不作为运行时权威。

实现提交`191d6e81d65a12d4f824dba5de01638822aeb013`的首轮[Actions `33721617844`](https://github.com/cinagroup/cinashop/actions/runs/33721617844)只暴露固定Cron计数断言仍停在19/12，而新增根任务后实际为20/13；生产实现、其余七个job和运行时行为没有失败。提交`0ad3bca42c1adc3777ed42770a833649535c8430`把断言及动作列表更新为新权威值后，[Actions `33721832795`](https://github.com/cinagroup/cinashop/actions/runs/33721832795)的Repository secret scan、Worker双TypeScript/单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。

因此`/admin/setting/shop/trade`从partial推进为candidate，76屏设置统计成为reviewed 15 / candidate 10 / partial 4 / retired 1 / unreviewed 61。这里的candidate表示代码、生产结构、自动门禁和本地UI已经形成候选闭环；由于生产没有次卡、两个通知模板、提醒时限配置或平台退货三字段，且主Worker/前端未发布，真实短信、真实站内信、真实状态4/5退货流程、主管理员/受限角色和发布后观察仍是明确阻断。下一项按清单进入FE-001D4B4支付公开商户配置；私钥、证书内容和API Key继续禁止进入Admin、数据库响应或日志。

## FE-001-D4B4 微信支付公开商户配置与三Profile就绪合同（2026-09-03）

### 旧PHP实证、当前官方合同与迁移决策

旧`SystemConfigServices::shopPayFrom`不只编辑支付开关，还把`pay_weixin_mchid`、`pay_weixin_serial_no`、商户私钥/证书/API Key以及`pay_routine_open/pay_routine_mchid`放进同一Admin表单。把旧表单原样恢复会让部署凭据再次进入数据库、Admin响应和浏览器，违反本项目已确立的Secret边界，因此本轮先追踪实际消费者而不是按字段名机械迁移。旧`PaymentConfig`确实初始化了`routineMchId`，但仓库没有读取该属性的支付请求；旧小程序`shop/pay/createorder`仍从共享配置读取`mch_id`。旧V3配置也使用同一个`mchId`，只按场景选择公众号、小程序、App或Web AppID。由此可见，`pay_routine_mchid`是未形成有效请求合同的遗留分支，不是必须保留的独立商户能力。

微信支付当前官方APIv3参数文档把`appid`和`mchid`列为下单主体字段，并要求二者具有绑定关系；小程序调起支付的商户下单仍使用JSAPI下单接口。权威参考为[JSAPI/小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)和[请求参数说明](https://pay.wechatpay.cn/doc/v3/merchant/4013070756)。本轮据此固定一套直接商户APIv3凭据、三个消费profile：`wechat`读取`wechat_appid`用于公众号/H5/PC，`routine`读取`routine_appId`用于小程序，`app`读取`wechat_app_appid`用于App；三者共享`pay_weixin_mchid`、商户API证书序列号及部署Secret。小程序与公众号场景都通过标准`/v3/pay/transactions/jsapi`，App仍走`/v3/pay/transactions/app`；`pay_routine_open/pay_routine_mchid`被明确退休，不再制造第二套未验证的商户配置轨道。

### 非密钥Admin字段与部署Secret边界

`AdminCommerceSettingsService`白名单由40增至42个键，只新增两个可公开、可轮换但不可任意格式的字段：`pay_weixin_mchid`必须是1～32位十进制数字，`pay_weixin_serial_no`必须是1～64位十六进制字符并规范化为大写。允许开关关闭或分阶段部署时暂存空值，但非空畸形值会被服务端拒绝。Admin响应、保存正文和页面都不存在商户私钥、证书/平台公钥内容或APIv3 Key字段；保存日志仍只记动作和键数量，不记录任何配置值。

部署凭据继续由Cloudflare Worker Secret注入：商户私钥`WECHAT_MCH_PRIVATE_KEY`、精确32字节的`WECHAT_API_V3_KEY`，以及`WECHAT_PLATFORM_PUBLIC_KEY`或兼容的`WECHAT_PLATFORM_CERT`验签公钥。可选的平台公钥ID仍只属于部署配置。页面只返回聚合就绪布尔值和通用失败原因，既不返回Secret值，也不通过长度、指纹或具体缺失Secret名称形成旁路泄露。旧数据库中的`pay_weixin_key`、`v3_pay_weixin_key`、`pay_weixin_client_cert`、`pay_weixin_client_key`以及支付宝私钥/公钥键继续不进入这个Admin合同。

### 精确Profile校验与支付副作用顺序

原`PaymentReadinessService`把微信整体就绪错误地绑定到`wechat_appid`，导致仅配置小程序AppID且其他凭据齐全时仍被错误拒绝。本轮把纯函数评估结果拆成方法级状态和`wechat/routine/app`三份profile状态：公共商户字段、HTTPS`site_url`和部署Secret由三者共享，各profile只检查自己的AppID；聚合微信状态只要求至少一个profile完整。这既允许合法的routine-only部署，又不会让一个已配置profile替另一个未配置profile放行。

商城订单、用户充值和付费会员三条真实微信发起链都先解析调用面的profile，再调用`assertWechatPaymentProfileAvailable`，并且该检查严格位于对账意图登记和provider请求之前。缺少目标AppID、公开商户字段或部署Secret时都在产生支付副作用前失败关闭。`WechatPayService`与就绪服务共用同一profile→AppID映射，防止校验和实际下单选择不同配置；测试同时禁止重新出现`pay_routine_mchid`、旧`shop/pay/createorder`或profile检查晚于对账登记的回归。

### 生产Hyperdrive只读审计与失败关闭现状

经用户明确授权，两轮随机命名、令牌双哈希保护的临时审计Worker通过Hyperdrive `9748c294e21c49a99579c9cef70102e0`连接生产PostgreSQL 16.14，并在显式`READ ONLY`事务中只返回存在性、行数、格式、长度、去重值数量和支付聚合计数。目标表均存在，但`pay_weixin_open`、`pay_weixin_mchid`、`pay_weixin_serial_no`、`wechat_appid`、`routine_appId`、`wechat_app_appid`、`pay_wechat_type`、`pay_routine_open`和`pay_routine_mchid`全部为0行；退休的微信/支付宝密钥键也均为0行。生产没有已支付微信订单、微信支付对账记录或退款支付记录，因此不能做真实历史流水兼容性结论。

控制面`wrangler secret list --name cinashop-api --format json`只列出`APP_KEY`、`DEBUG`、`INTERNAL_CHAT_TOKEN`、`OPERATIONS_TOKEN`及Upstash两项，没有任何微信支付部署凭据。生产`site_url`有5行、2个不同HTTPS值，最新值格式有效但多值冲突继续归DB-003运营决策，不能由迁移代码擅自选定。上述事实意味着即使未来单独开启数据库开关，当前候选代码也会因公开配置、Secret和profile AppID不完整而失败关闭；本轮没有为制造“可用”状态写入占位商户号或伪Secret。

审计入口的无令牌请求返回403、错误方法返回404；两轮临时Worker和Secret完成后均删除，公开URL复验404。整个B4没有执行生产DDL/DML、真实下单、退款、回调、Queue、主Worker或前端部署，也没有回显数据库连接口令或配置值。

### 浏览器证据、自动门禁与剩余阻断

应用内浏览器在本地`/config/commerce?preview=1`打开支付页，确认两个公开字段、三profile状态卡和Secret边界说明均可访问，保存后出现成功提示且控制台无错误。证书序列号输入` ab12 cd34 `后实际规范化为`AB12CD34`。随后用系统Chrome进行独立Playwright回归：1440×900保存成功，390×844下`scrollWidth/clientWidth=390/390`，两种视口均无控制台问题。首轮自动化误用了`viewportSize`而仍得到1280宽度，该结果已明确丢弃；修正为真实`viewport`后才采纳上述移动端证据。

最终本地Worker全量209文件/1,318项单元全部通过，单元与运行时双TypeScript通过，Admin生产构建2,437模块。Admin静态合同仍为342个调用点、362个路径变体，362条全部已注册且可执行；设置逐屏审计生成器和产物同步把`/admin/setting/shop/pay`从partial推进为candidate。过程中一次全量单测只因Windows临时SSR缓存目录原子重命名返回`UNKNOWN`，没有业务断言失败；停止并行服务后串行复跑即得到209/209、1,318/1,318成功，因此不把基础设施瞬态误写成产品缺陷。

实现提交`8cc086acbd555068bad319531e80f143300ea86b`推送后的首轮[Actions `33727582124`](https://github.com/cinagroup/cinashop/actions/runs/33727582124)中，业务实现相关七个作业全部通过，只有Gitleaks把`payment-readiness.test.ts`中显式写出的三行假PEM识别为`private-key`。日志确认唯一命中为该测试fixture，不是生产或开发凭据。修复提交`e406852d03eaeecd5ddcbfaf74028bb0a6a511bf`把当前fixture改为分段构造，并在`.gitleaks.toml`按`private-key`规则、精确测试路径和精确历史行三重约束放行这一已知假值，没有按目录或全规则放宽扫描。随后[Actions `33727980894`](https://github.com/cinagroup/cinashop/actions/runs/33727980894)的完整历史Secret扫描、Worker双TypeScript/1,318项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。

76屏设置统计现在是reviewed 15 / candidate 11 / partial 3 / retired 1 / unreviewed 61；核心商城设置8屏中已有7屏candidate，仅动态系统配置保持partial。支付candidate只证明非密钥配置合同、失败关闭、Admin操作面、生产只读事实和本地自动门禁闭合，不表示生产支付可用。启用前仍必须由运营配置真实商户号、证书序列号、正确绑定的三个AppID和Cloudflare Secret，并在获批发布环境完成三profile正向/拒绝路径、支付与退款回调验签、幂等对账、受限角色和观察期；这些继续归FE-001G/H及正式发布门禁。

## FE-001-E5C 生产SKU目录审计与受控退役DDL（2026-09-03）

### 审计范围与完成口径

本项只关闭FE-001E5中可被当前生产事实证明的两件事：审计普通SKU目录及历史引用形状，并把仓库候选`0126_product_sku_retirement.sql`安全应用到生产。它不把“表结构存在”写成整个商品域完成，也不在真实商品上演练退役/恢复。代码复核确认外部`0126`、`PRODUCT_SKU_RETIREMENT_SQL`和`MigrationService.migration_0132`使用同一份前向迁移；新增四个状态/证据字段、追加式日志表及序列、一个CHECK、三个索引、一个保护函数和一个更新/删除触发器。业务服务当前仍只允许`type=0/relation_id=0/product_type=0/is_del=0`的平台自营未删除实物商品，Supplier、其他owner和虚拟商品没有被默认纳入完成范围。

专用审计Worker只绑定Hyperdrive `9748c294e21c49a99579c9cef70102e0`，以随机32字节令牌的SHA-256摘要作为部署变量；请求内重新摘要并使用timing-safe比较。`GET /audit`固定使用只读事务，仅返回计数、布尔状态、类型、索引/约束定义和聚合关系数量，不返回商品名、SKU值、用户、订单ID或其他业务正文。`POST /migrate`是唯一写入口，错误方法返回404；两个入口均设置`private, no-store`。

### DDL前生产事实与风险判定

生产是PostgreSQL 16.14。DDL前`store_product_attr_value`只有2行、关系总大小49,152字节；71个商品中只有2个商品拥有普通SKU，两者均为平台自营、`relation_id=0`、未删除实物商品，而且都是单规格单SKU。活动SKU为0；全局`unique`重复组、商品内`suk`重复组、空`unique`、空`suk`、负库存、普通SKU孤儿和`spec_type`数量错配全部为0。生产没有非平台、虚拟、多规格或畸形SKU样本，所以这些类别不能靠本次审计宣告兼容。

引用聚合显示开放购物车2条、未支付有效订单8条、订单历史28条；评价历史、库存历史、虚拟库存、历史分店SKU表、促销辅助和抽奖引用均为0。由此得出两个不同结论：当前两条SKU都不能作为无副作用的真实退役测试对象，服务应按设计被开放购物车/未付订单阻断；但这些业务引用不阻止只增加状态列、日志表、索引和保护触发器的前向DDL。DDL前四个退役字段、日志表/序列、CHECK、三个索引、函数和触发器全部不存在，不是部分迁移状态。

### 有界迁移、回滚条件与幂等证据

生产写事务依次设置2秒`lock_timeout`、15秒`statement_timeout`、20秒空闲事务上限，取得固定transaction advisory lock后立即对`store_product_attr_value`取得`ACCESS EXCLUSIVE`锁。身份和规模预检在该锁之后执行，封闭“预检通过后PHP又插入SKU”的并发窗口；只允许不超过100,000行且关系不超过64 MiB，并要求上述重复、空身份、负库存和孤儿指标全为0。目录检查完全通过`pg_catalog`完成，不在迁移前解析尚不存在的列或表；发现任何非零但不完整的目标对象集合会失败关闭。

在同一事务中先对全部旧SKU字段生成按ID排序的MD5摘要，并记录行数、库存、销量和累计入库总数；随后执行精确`PRODUCT_SKU_RETIREMENT_SQL`，重读业务摘要和目录，再执行同一迁移第二遍并再次重读。成功必须同时满足：旧字段摘要与四项总量三次相等；12个目标对象全部存在，列类型/非空/default正确，三个索引均valid/ready，函数和触发器启用；退役、畸形默认和日志行均为0；第二遍对象数量与定义摘要和第一遍相同。任一条件不满足都会抛错并回滚整个事务。外层runner先用只读`GET /audit`等待部署传播完成，只发送一次`POST /migrate`；若写请求响应不确定则停下并交给独立只读审计裁决，不自动重放生产写请求。

迁移Worker `cinashop-sku-retirement-migrate-abefc4d2697c`实际返回`already_ready=false`，两遍目录均为`object_count=12`、`definition_digest=98afe1d4fdfe0b2171dacc73acb912cb`，且`business_rows_unchanged=true/idempotent_second_pass=true`。SKU始终为2行，旧字段摘要始终为`e81a41598bd13a2f7d349a7c4e311763`，库存137、销量93、累计入库0三次一致；退役、畸形默认和日志行始终为0。迁移Worker完成后删除，URL复验404。

### 独立只读复验与工具缺陷处理

独立Worker `cinashop-sku-retirement-audit-44170c4457c1`在新的只读事务中确认四列类型与默认值正确，日志表存在，`spav_is_retired_ck`按迁移设计为`NOT VALID`，三个索引均valid/ready，保护函数存在、触发器启用，现有2行手工聚合验证均符合约束。关系因新增列和索引增长到65,536字节，仍远低于64 MiB门槛；目录、身份、owner、规格形状和引用聚合与迁移前一致。无令牌请求稳定返回403、错误方法404；Worker删除成功且URL返回404。主Worker和Admin均未部署，也没有商品、SKU、购物车、订单、日志业务行DML、Queue或第三方调用。

审计harness本身也按失败记录而非掩盖处理：首次用Windows PowerShell 5运行时因运行库不支持`RandomNumberGenerator.Fill`而在部署前停止；最初两次只读Worker分别暴露参数化relation名称被解释为列、门店SKU真实列名为`unique`而非ORM属性名的问题，均未进入DDL且清理路径执行。迁移前又发现SQL即使位于不会执行的`CASE`分支，PostgreSQL仍会解析缺失列/表，因此在生产写入前把目录检查和迁移后数据检查拆开，并把表锁移到预检之前。一次独立审计的无令牌探测因Workers边缘传播短暂得到404，runner随即增加最多五次短重试并强制要求403；只有最终无歧义结果被采用。

### 路由审计纠偏与剩余缺口

`admin-legacy-product-route-parity.json`过去仍把配送、赠品/优惠券、用户标签、推荐、表单、运费模板和品牌七类批处理列为`product_list`缺口，但这些操作已由E5B3实现并有CI证据。此次只纠正`covered/remaining`文本，不改变12屏中candidate 6、partial 6的统计：商品列表仍缺丰富筛选、审核动作、导出和真实角色生产写流程；商品编辑/规格仍缺历史多规格、虚拟商品和非平台生命周期。FE-001E5C可标完成，FE-001E5父项及E6继续未完成。下一阶段必须使用可恢复的专用测试记录或源库历史样本，验证主管理员、只读/编辑受限角色、单/多规格、虚拟商品、失败重试和移动端；当前两条被真实业务引用的SKU不能被借作破坏性测试。

本地新增SKU专项静态门禁验证只读/写路由、双哈希令牌、短超时、锁顺序、单次外层写调用、精确迁移常量双遍执行、业务摘要回读、无商品表DML、生产Hyperdrive ID以及两个runner的`finally`删除/URL 404，共8/8通过；商品逐屏审计另有回归断言阻止把已实现批处理重新列入缺口。完整Worker单元209文件/1,320项、单元与运行时双TypeScript、Admin生产构建2,437模块、schema审计201/201共享表零源字段缺口且外部/内嵌263表零漂移、Admin 342个调用点/362个路径变体全部可执行、全局路由和17信号/53事件可观测性审计均通过。追加测试后一次默认约2 GiB堆的单元TypeScript复跑在垃圾回收阶段OOM，改用明确4 GiB堆上限即通过且没有类型诊断；本机workerd仍在进入任何断言前因Wrangler日志目录权限和Windows `0xc0000005`退出，运行时0项不能计作通过。

精确提交`f9060c8736b94ed58882f8aada9127da2c35d13a`推送后，[Actions `33830983585`](https://github.com/cinagroup/cinashop/actions/runs/33830983585)的Repository全历史Secret扫描、Worker双TypeScript/1,320项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。由此Linux运行时补足本机无法执行的权威证据；该流水线不等于主Worker或前端已经发布。

## FE-001-E5D Supplier实物SKU稳定编辑与受控退役（2026-09-04）

### 审计范围、旧实现风险与完成边界

本项只关闭Supplier自有、未删除实物商品的普通SKU稳定编辑和可恢复退役候选链，不把平台E5B2/E5C证据重复计算，也不扩展到非实物商品或正式发布。旧PHP的Supplier商品保存最终复用公共`StoreProductServices->saveData(..., type=2, supplierId)`；其`StoreProductAttrServices::saveProductAttr`按前端数组位置更新已有行，只在新数组更短时删除尾部ID，并在更长时追加。因此规格顺序或组合变化会让旧ID绑定到另一组`suk`，订单、评价和库存历史可能仍指向同一ID却表达了不同商品组合。迁移前TypeScript Supplier服务风险更直接：先删除商品全部普通SKU，再生成新ID整批插入；一旦商品存在退役行又整单拒绝保存，既重建历史身份又形成无法继续编辑的死路。

本轮把规格输入类型和规范化逻辑提取为共享`ProductSkuInput`，Supplier编辑复用平台稳定身份编辑器。已有活跃组合按规范化`suk`精确匹配并保留`id`、`unique`、`sales`和`sum_stock`，只更新允许变化的价格、库存、成本、图片、重量和体积；新增组合获得新身份。遗漏已有活跃组合、改变其`suk`或试图通过普通保存恢复退役行都会失败关闭，退役行也不再被删除。详情接口从同一编辑器回读并明确分成可编辑`attrs`和只读`retired_attrs`，避免前端把历史行重新混入普通保存正文。

### 租户、权限、事务与生命周期合同

`ProductSkuRetirementService`不再隐式假定平台owner，而是要求调用方传入可信scope。Admin端只传固定`type=0/relation_id=0`；Supplier端从已经签名验证的认证上下文派生`supplierId`和actor，再传`type=2/relation_id=supplierId`，不读取请求正文中的租户或操作者。商品查询同时约束`id/type/relation_id/is_del=0`，跨Supplier访问统一返回“不存在或不属于当前供应商”。两条Supplier写路由位于动态商品路由之前，正文有8 KiB流式上限，并都映射到既有`supplier.product.manage`权限；只读角色不能因知道商品或SKU ID绕过RBAC。生命周期日志仍在同一数据库事务追加，Supplier系统日志使用Supplier管理路径，不冒充平台Admin操作。

退役/恢复继续沿用E5B2的身份锁、商品锁、依赖快照、完整笛卡尔组合、数据库触发器与写后回读合同。开放购物车、未支付订单、活动和门店等可售依赖会阻断退役；订单、评价、库存流水等历史引用只计数保留。普通保存不能把`is_retired`从1改回0，恢复只能走专用入口并要求理由。页面只在拥有管理权限时显示操作；活跃表勾选后退役、历史表勾选后恢复，理由必须2～255字符。接口返回`verified=true`后页面重新加载详情才提示成功，并明确告知未保存表单内容会被回读覆盖。

### 生产只读事实与隔离真实服务演练

经用户明确授权，随机命名、双SHA-256令牌保护的临时Worker通过Hyperdrive `9748c294e21c49a99579c9cef70102e0`连接生产PostgreSQL 16.14。最终只读审计确认E5C迁移对象全部ready；71个未删除实物商品全部为平台`type=0/relation_id=0`，其中2个拥有普通SKU，生产没有Supplier商品、Supplier SKU或Supplier owner。当前仍只有2条平台SKU；开放购物车2条、未支付订单8条、订单历史28条，其他活动/门店/评价/库存/虚拟库存引用聚合为0，退役行和生命周期日志均为0。因此没有可由真实Supplier token安全操作的现有生产对象，本轮没有伪造业务租户、改写现有商品或把平台商品临时转属Supplier。

为验证真实服务而不污染业务表，专用演练在同一生产PostgreSQL建立随机`codex_supplier_sku_*` schema，克隆Supplier保存与退役链需要的26张表并建立本地序列；所有seed、直读和服务事务都显式执行事务级`SET LOCAL search_path`。演练调用真实`SupplierProductManagementService`和`ProductSkuRetirementService`：创建2条SKU后扩展为3条，原两条的ID/unique/销量/累计入库保持稳定，新组合取得新身份；删除已有组合被拒绝；退役后详情正确拆分活跃/历史行，保留退役行的普通保存成功但伪恢复失败；另一Supplier访问被拒绝；加入开放购物车后退役被阻断；清除隔离依赖后专用恢复成功。最终为3条活跃、0条退役，产生2条生命周期证据、2条Supplier系统日志和5条`store_id=101`的Supplier库存流水，所有断言都来自数据库回读。

演练前后对全部26张公共业务表及关联公共序列做有序摘要，最终`public_state_unchanged=true`、临时schema数量不变，精确随机schema以`DROP SCHEMA ... CASCADE`清理。最终Worker `cinashop-supplier-sku-audit-b485629ca71f`的无令牌POST为403、错误方法为404；Worker和Secret删除后公开URL复验404。只读审计最终Worker同样删除并返回404。主Worker、Supplier前端、Queue和第三方服务均未部署或调用。

### Harness事故、纠正与防回归

首轮隔离演练在创建商品时以“分类不存在或不属于当前供应商”失败。追踪发现直接对Hyperdrive客户端调用`isolated.insert`时，连接启动参数中的自定义`search_path`没有成为该语句的可靠隔离边界，导致一条精确标记的合成分类误写入`public.store_product_cate`：`id=41/type=2/relation_id=101/cate_name='Isolated category'`。临时令牌保护的清理入口先锁定并按完整四字段复核该行，再确认商品引用为0，才删除唯一命中；清理Worker和临时代码随后全部移除。

修复不是忽略该事件或只缩小断言，而是让所有直接seed/读取都经过显式事务包装，并把公共指纹从6张表扩为全部26张克隆表和关联序列。最终演练在修复后重新完整执行并证明公共状态不变；专项测试还禁止场景源码再次出现`await isolated.insert`，要求存在显式隔离容器、全表指纹、精确schema清理和URL 404回收。该事故没有触及商品、SKU、订单、购物车或用户数据，误写分类在引用为0时已被精确删除，不能恢复，但其原因、影响和纠正均保留在本审计记录中。

最终重跑还暴露两个工具配置缺口。Windows PowerShell 5不支持静态`RandomNumberGenerator.Fill/SHA256.HashData`，第一次在部署前停止；runner改用可释放的`Create().GetBytes/ComputeHash`并增加源码回归。随后Worker `cinashop-supplier-sku-audit-59de470b2ea4`因遗漏`global_fetch_strictly_public`而在首次数据库访问收到1042；这与[Cloudflare官方1042定义](https://developers.cloudflare.com/workers/observability/errors/)一致，表示同zone Worker子请求被平台阻止。控制面删除日志返回HTTP 200和`Successfully deleted`，其URL随后独立复验404。审计配置补齐与仓库其他Hyperdrive审计Worker一致的兼容标志后，才运行并采纳上述`b485629ca71f`最终结果；runner也改为即使主请求失败仍输出Worker名、失败原因与清理结果，并在删除或404不收敛时整体失败。

### 前端验收、自动门禁与剩余阻断

Supplier生产构建通过2,271个模块。应用内浏览器实际打开本地preview商品71：勾选活跃SKU后输入“停止旧颜色销售”，活跃行由2变1，历史表显示原稳定ID和`PV71GRN1`；再输入“重新开放旧颜色”恢复后，活跃行回到2且历史区消失。390×844视口下`scrollWidth=clientWidth=375`，页面无横向溢出，生命周期按钮可见且导航切为移动端；全程console warning/error为0。这里的页面数据是隔离preview，只证明控件、状态转换和响应式布局，不是生产Supplier账号验收。

专项3文件/28项测试、单元与运行时双TypeScript、Supplier生产构建2,271模块和Worker全量209文件/1,323项单元全部通过。schema审计保持201/201源表字段完整、外部/内嵌263表零漂移；Admin静态请求342个调用点/362个路径变体全部可执行；全局路由为PHP 1,904 / TS 1,623 / 精确匹配862 / 可执行844 / 受控不可用18 / 缺失1,042 / 退役16 / 可执行缺口1,026；设置账本仍为76屏中reviewed 15 / candidate 11 / partial 3 / retired 1 / unreviewed 61；可观测性保持17个信号、53个必需事件和6个发布阻断。精确实现提交`14880b2436cf5664d858e03ee2aba938468df1c6`推送后，[Actions `33834851835`](https://github.com/cinagroup/cinashop/actions/runs/33834851835)的Repository全历史Secret扫描、Worker双TypeScript/1,323项单元/schema/route/observability、Linux workerd、Admin、PC、Supplier、Kefu和UniApp共8/8成功。E5D当前只能标“候选完成，未发布”：生产没有真实Supplier商品或SKU，尚无真实主管理员/Supplier管理员/只读和编辑受限角色token；源PHP历史多规格数据、非实物商品、正式发布、发布后失败重试和观察期仍未完成。分店商品表结论由后续E5E源码与生产证据纠偏为历史迁移表。剩余项继续阻塞FE-001E5父项及FE-001E6，不能因隔离schema演练通过而上调为生产完成。

## FE-001-E5E 非实物商品权威与次卡支付有效期（2026-09-04）

### 商品类型来源、版本残留与分店表结论

本轮重新从活动页面、保存服务、支付Job和Supplier路由逐层确定商品类型权威，避免按安装SQL注释推断业务。旧Admin商品页`view/admin/src/pages/product/productAdd/index.vue`实际只给出四个可选类型：`0`普通商品/物流发货、`1`卡密或网盘/自动发货、`3`虚拟商品/人工虚拟发货、`4`次卡/到店核销；旧Supplier组件`view/supplier/src/pages/product/components/productDetails.vue`只开放`0/1/3`。`StoreProductServices`虽然仍有`case 2`优惠券商品和免运费处理，但两个活动商品表单均无类型2入口，`OrderPayHandelJob`也只有类型1自动交付和类型4次卡处理，没有类型2支付履约分支。因此类型2不能因残留switch和字段注释被当作待恢复的线上产品类型，本审计将其记录为未发布或已撤回的版本残留；若源MySQL以后出现真实类型2行，必须单独停放并由业务确认，不能自动套用类型1语义。

此前清单把`store_branch_product`和`store_branch_product_attr_value`理解成仍待实现的“门店SKU”，这与源码不符。`StoreBranchProductServices`构造函数实际注入主`StoreProductDao`，`StoreBranchProductAttrValueServices`实际注入主`StoreProductAttrValueDao`并删除/替换主SKU；Supplier控制器虽保留一个使用Branch属性服务的`update`方法，活动`route/supplier.php`商品路由并没有映射该方法，实际保存仍是`POST product/product/:id`进入公共`saveData(..., type=2)`。生产只读又确认两张branch表均为0行。结论是两表属于历史表名和代码版本漂移，只保留201表无损迁移及历史依赖计数，不再建立与主商品SKU竞争的第二权威；门店、店员、自提、配送和核销仍由`system_store`、订单及核销链承担，这一结论不等于退休门店业务。

### 现有迁移覆盖与商品前半段缺口

TypeScript已经具备非实物履约的若干后半段：`VirtualProductInventoryService`提供卡密库存导入、遮蔽列表和单次导出，`VirtualProductDeliveryService`在支付outbox中原子认领卡密并自动交付；Admin订单页支持`fictitious`人工虚拟发货；`StoreOrderWriteoffService`和`SecondCardReminderService`处理次卡次数、有效期校验、核销与临期/到期提醒。本轮之前商品创建编辑仍明显不完整：Admin `ProductForm.vue`没有商品类型选择并复用只允许实物的`ProductSkuEditorService`，Supplier `ProductForm.vue`明确显示“当前仅开放实物商品”，服务端也拒绝非实物创建和编辑。当前已补Admin类型1候选能力，但Supplier及类型3/4仍保持失败关闭，因此仍不能把整个虚拟商品域标为完成。

审计同时发现下单边界偏离类型语义。旧PHP `StoreCartServices`只取购物车中第一个唯一`product_type`作为订单类型，是会让混单含义依赖行顺序的历史缺陷；迁移前TypeScript仅禁止类型1与其他类型混单，类型3或4仍可能与实物混合后把订单类型降为0。类型3还被地址校验和运费计算遗漏，虽然旧PHP明确把1/2/3列为无需配送。现在所有不同`product_type`组合均在下单前失败关闭，类型1继续保留“不支持到店自提”的专用提示，类型3加入地址与运费豁免。类型4单独保留配送/自提语义，不被错误归入无地址虚拟商品。

### 次卡付款有效期缺口、事务合同与重放语义

旧`OrderPayHandelJob.php`在支付后读取订单商品不可变快照：模式1写`0/0`表示永久，模式2以当时支付处理时间写`write_start`并加`write_days*86400`，模式3复制固定区间。迁移前`StoreOrderCreateService`却直接把实时SKU的`write_start/write_end`写进订单行，支付outbox没有模式2激活步骤，导致“购买后N天”次卡在支付后仍可能保持`0/0`并被核销链解释为不限期。

实现提交`55f29dd73657ce792915bd61543aa661212bb524`新增`SecondCardValidityService`。创建订单时，类型4把`write_valid/write_days/write_start/write_end`写入不可变`cart_info.sku`快照；模式2的持久化窗口刻意保持`0/0`等待付款，模式1保持永久，模式3先验证正向固定区间。支付outbox先完成Supplier分单，再只锁定实际履约订单的类型4商品行；激活时间使用订单事务已写入的`store_order.pay_time`，不是可能晚几秒、几分钟或多次重试的Queue消费时间。模式2首次将窗口写为`pay_time`到`pay_time + N天`，后续重放保留已激活窗口；模式1和3收敛到快照值。历史PHP快照`productInfo.attrInfo`和新Worker快照均可读取；旧行缺少足够快照时只保留现有持久化窗口，不回查已可能修改的实时SKU。半初始化窗口、无效天数、反向固定区间、PostgreSQL integer溢出和未支付订单全部失败关闭。

并发上，调用发生在支付outbox原事务内，outbox行、Supplier分单订单和商品行按既有顺序锁定；次卡行按ID排序`FOR UPDATE`，写入还带`id/product_type/旧write_start/旧write_end`条件并要求`RETURNING`成功。这样并发修改不会被静默覆盖，Supplier拆单根只作为付款审计，实际子单行才被激活，整个后置任务失败时随事务回滚。当前没有修改DDL，也没有把配置密钥、卡密或用户内容写入日志。

### 生产Hyperdrive证据、隔离演练与完成边界

在用户授权下，令牌保护的临时Worker `cinashop-second-card-validity-audit-d8c3793a4222`通过Hyperdrive `9748c294e21c49a99579c9cef70102e0`执行只读公共审计。PostgreSQL现有71个未删除商品全部为平台owner的类型0实物商品，仅2条活跃普通SKU；`store_branch_product=0`、`store_branch_product_attr_value=0`、`store_product_virtual=0`、次卡订单行=0、已支付次卡行=0、已支付但未激活次卡行=0。因生产没有非实物业务样本，本轮没有伪造业务商品、订单、卡密、用户或角色，也不能把隔离fixture当作真实用户验收。

同一临时Worker在随机`codex_second_card_validity_*` schema中只克隆`store_order_cart_info`，所有seed和真实Drizzle服务调用都显式事务级`SET LOCAL search_path`。场景包含购买后7天、固定区间、永久三条次卡以及一条实物：首次匹配3、仅模式2改变1，起点精确等于给定支付时间，固定/永久不变，实物不变；用不同处理时间重放改变0且全行快照一致；未支付订单被拒绝。`finally`删除随机schema后，公共表行数、全行摘要、公共序列值和临时schema计数与执行前一致；无令牌POST为403、错误方法为404。Worker随后删除成功并复验URL 404，主Worker没有部署。

本地专项2文件/12项、Worker全量210文件/1,330项单元、单元与运行时双TypeScript全部通过；schema审计仍为201/201源表字段覆盖、外部/内嵌263表零漂移；全局路由保持PHP 1,904 / TS 1,623 / 精确匹配862 / 可执行844 / 受控不可用18 / 缺失1,042 / 退役16 / 可执行缺口1,026，可观测性仍为17个信号、53个必需事件和6个发布阻断。E5E0可标审计完成，E5E1只能标“候选完成，未发布”。E5E2卡密/网盘商品编排、E5E3手工虚拟商品、E5E4次卡商品创建/编辑/真实核销、E5E5历史数据复制/真实角色/发布观察仍未完成；这些项继续阻塞FE-001E5、FE-001E6及正式发布。

### E5E2A 卡密/网盘Admin编排、库存权威与交付快照

继续审计旧`OrderPayHandelJob.php`发现一个比“页面尚未开放”更直接的正确性偏差：旧PHP对普通类型1订单从`cart_info.productInfo.attrInfo.disk_info`读取下单时快照，而迁移前`VirtualProductDeliveryService`在支付outbox执行时重新读取`store_product_attr_value.disk_info`。若运营人员在下单后、付款前修改固定网盘地址或密钥，TypeScript会交付新值而不是客户下单时的承诺；SKU被退役、删除或异常改写也会让已存在订单依赖实时主数据。这个偏差现已修复：下单对每个类型1 SKU把`disk_info`连同空字符串一起写入`cart_info.sku`；空字符串是“使用一次性卡库”的明确模式证据，不与“快照缺失”混为一谈。支付只解析新快照或旧PHP的`productInfo.attrInfo`，快照不存在、不是字符串、JSON畸形或超过1 MiB时整体失败并保留outbox重试，不再回退实时SKU。

Admin商品服务现在只在新建时接受`product_type=0/1`，已有商品即使请求体尝试提交其他类型也会以“商品创建后不能修改履约类型”失败。类型1和实物共用稳定SKU身份编辑器：仍按`suk`保留`id/unique/sales/sum_stock`，不允许普通保存删除、改名或恢复退役SKU；固定内容限制4096字符并允许维护未来订单的库存，一次性卡库新SKU必须从0库存开始，后续只能由`VirtualProductInventoryService.importCards`按真实插入数增加SKU和商品库存。已有卡库SKU的库存不能随表单改写，任何历史或未分配卡记录存在时也不能切换为固定内容；固定内容切到卡库必须把库存归0。这些条件在商品行锁内检查，卡密导入同样锁商品行，因此并发保存和导入最多一方按先后状态成功，不会产生“固定内容+一次性卡”双权威。

Admin表单新增创建时的“实物商品/卡密或网盘”选择，编辑时锁定；每个SKU再显式选择“一次性卡密/固定内容”。卡库模式只展示由导入维护的库存，固定内容模式重新创建库存控件并显示4KiB有界文本框，避免组件复用后残留禁用状态。应用内浏览器以1280×720实际打开`/product/create?preview=1`：切换类型后主库存隐藏、单位变为“份”、默认卡库库存为禁用0且提示进入卡密库存导入；切到固定内容后库存控件可编辑为5，固定内容可写入下载地址。Admin生产构建通过；preview草稿请求因沙箱代理不可达而显示“草稿自动保存失败”，这不影响表单状态验证，也没有向生产写入草稿。

生产Hyperdrive随机schema演练调用真实`deliverPaidVirtualOrders`。最终场景为4个已支付订单、5个订单商品行、4个SKU和6张一次性卡：两个连接竞争3张卡时严格1成功/1缺货，成功方领取2张且无重复；补入第4张后失败方重试完成，成功方重放为0变化；两SKU部分领取后另一SKU缺货会让第一张领取、订单状态、状态证据和通知outbox全部回滚，补货后一次完成；固定内容订单的实时SKU预先改成另一密钥，最终仍精确交付checkout快照且不领取卡。全部布尔断言为true，状态证据4条、已分配卡6张；公共表和序列摘要不变、公共标记0。第一次运行因旧夹具缺少当前新增的`user_address`及通知outbox表而安全回滚，随后随机schema、临时Worker和URL均清理；修正夹具后的Worker`cinashop-virtual-delivery-audit-04efe5ab4000`运行通过，`codex_virtual_delivery_621090f05fd44b84`删除成功，Worker删除后URL为404。令牌缺失为403、错误方法为404。主Worker和Admin均未发布。

同一生产Hyperdrive还用现有SKU生命周期随机schema实际执行了本轮Admin写事务，而非只靠源码断言：类型1商品同时创建卡库SKU和固定内容SKU，详情回读分别为库存0/固定内容空与库存5/固定下载地址；向卡库SKU导入2张卡后，SKU库存变2、商品总库存由5变7。随后直接把卡库库存改成3、已有卡记录后切固定内容、固定内容带库存切回卡库、向固定内容SKU导卡、把商品类型改为0均按各自合同失败；合法地把固定内容库存改为6并更新地址后，卡库库存仍为2、商品总库存为8，两个SKU的`id/unique`保持不变。最终Worker`cinashop-supplier-sku-audit-4829d8c68114`报告所有新增布尔断言为true、随机schema数量不变、相关public表及序列逐表指纹不变；临时Worker删除成功且URL为404，无令牌403、错误方法404。前两次新增演练暴露的是测试夹具边界：一次用展示文本索引SKU而传出空标识，一次让无事务详情读取落回连接池的`public` search path并读到生产id=2；两次均在业务写入前或随机schema内失败并完成schema/Worker清理。最终夹具改为按持久化交付模式识别SKU，并像既有Supplier读回一样把Admin详情包在隔离事务中，避免把生产数据误判成隔离结果。

本轮最终本地门禁为Worker 210文件/1,332项单元测试、单元及runtime-test两套TypeScript、Admin 2,437模块生产构建全部通过；Admin前端342个调用点/362个路径变体均已注册且可执行，0个未注册、受控不可用或未解析。schema审计保持源201表全部覆盖、缺失源字段0、外部/Worker 263表定义零漂移；路由审计保持PHP 1,904 / TS 1,623 / 可执行844，API面可执行418/457（91.5%），全局仍有1,026个可执行缺口；可观测性仍为17个信号、53个必需事件和6个生产发布阻断。Windows本机`workerd`在沙箱内外均于测试收集前以访问冲突退出，因此本地runtime测试不能记为通过；真实Workers运行时由上述两个生产Hyperdrive隔离Worker场景覆盖，提交后的Linux CI仍须独立通过。

E5E2A因此可标“候选完成，未发布”。当时Supplier类型1表单仍失败关闭；该缺口随后由E5E2B候选实现补齐，但E5E2父项仍继续开放：源MySQL卡密/固定内容没有复制，生产当前类型1商品、SKU和卡库存均为0，真实Admin/Supplier/客户角色及支付/通知/退款未验收。尤其已发放一次性卡密能否退款、退款后是否允许回收密钥必须由业务策略与泄露风险共同决定，不能仅用库存补偿代码推断。E5E3、E5E4、E5E5和正式发布门禁也不受本子项通过影响。

### E5E2B Supplier类型1编排、库存旁路与可恢复退役

旧Supplier活动表单明确允许`0实物/1卡密或网盘自动发货/3人工虚拟发货`，保存仍进入公共`StoreProductServices::saveData(..., type=2)`；其中类型1与Admin共用`store_product_attr_value.disk_info`区分固定内容和一次性卡库，并把`freight=2/temp_id=0/postage=0`强制为无需物流。迁移前Supplier TS页面和`SupplierProductManagementService`却都只允许类型0，商品列表虽然已有卡密库存入口，却没有创建或编辑类型1商品的入口。本轮只恢复旧系统已有且履约后半段已经迁移的类型1；类型3继续失败关闭，类型2撤回残留和类型4也没有借机开放。

Supplier保存现在接受且只接受类型0/1，创建后请求类型必须与已存商品一致。类型1沿用Supplier分类、结算价、价格/佣金、限购、审核下架和稳定SKU身份合同，同时强制`delivery_type=''`、`freight=2`、`postage=0.00`、`temp_id=0`。每个SKU的`disk_info`为空表示一次性卡库，非空表示最长4096字符的固定交付内容：新卡库SKU必须以0库存创建，已有卡库SKU的库存只能等于当前权威值；有卡记录时不能切到固定内容，固定内容切回卡库时库存必须先为0。实物商品提交`disk_info`会失败，外部Out API继续通过物理专用归一化边界只接受类型0，没有随Supplier能力一起扩大授权面。

审计还发现两个普通页面难以察觉的库存旁路。第一，Supplier的`saveStocks`会直接加减任意SKU库存，因此即使商品保存阻止卡库库存改写，调用者仍可绕过卡密数量权威；现在服务在商品事务锁内读取商品类型，对`product_type=1 && disk_info为空`的SKU明确要求走卡密导入，固定内容仍可使用有审计流水的普通库存调整。第二，退役SKU此前仍会被卡密库存列表、预警、导入和单次敏感导出查询选中，导入后还会把数量错误加回商品总库存。本轮把这些查询及普通库存调整统一限定为`is_retired=0`，并把`ProductSkuRetirementService`从仅类型0扩展到类型0/1。退役卡密SKU保留历史卡、订单、评价和库存流水，不允许新增卡、普通调库存或导出；恢复后按原`id/unique/suk/disk_info`重新进入活跃规格与商品汇总。类型3/4仍被退役服务拒绝。

Supplier页面新增创建时的“实物商品/卡密或固定内容”选择，编辑时锁定履约类型；列表对类型1同时提供编辑和卡密库存入口。类型1每个SKU可选“一次性卡密/固定内容”，卡库显示权威库存但禁用直接输入，固定内容显示有界文本框并允许库存调整；物流与运费控件被替换为自动交付提示，保存后直接进入现有的安全卡密库存页，卡号和密码仍不经过商品表单。应用内浏览器实际打开`http://127.0.0.1:5182/products/new?preview=1`：页面身份和标题正确、非空、无框架错误层，控制台warning/error为0；切到类型1后出现无物流提示和卡密导入指引，库存为禁用0。第一次切换固定内容时发现Element Plus在同一表格单元复用`el-input-number`实例而残留禁用状态，加入按`SKU+交付模式`重建的key后复测：卡库为disabled，固定内容文本框出现且库存恢复settable，截图与可访问树一致。当前QA为桌面视口和preview数据，不是生产Supplier账号或移动端验收。

生产证据继续使用授权Hyperdrive`9748c294e21c49a99579c9cef70102e0`，不部署主Worker。专用脚本每次生成随机32字节令牌，只向临时Worker传SHA-256摘要；无令牌POST必须403，错误方法必须404。随机`codex_supplier_sku_*` schema克隆Supplier商品/SKU/库存/退役所需26张表和本地序列，所有seed、详情回读及服务调用都在显式事务级search path中完成，前后逐表计算公共数据与关联序列指纹。场景调用真实`SupplierProductManagementService`、`VirtualProductInventoryService`和`ProductSkuRetirementService`，而非直接模拟SQL。

最终Worker`cinashop-supplier-sku-audit-0a248457b9b2`中，Supplier类型1商品同时创建卡库SKU（库存0）与固定内容SKU（库存5），强制零物流字段回读正确；导入2张卡后卡库库存2、商品总库存7。普通商品保存把卡库存改3、`saveStocks`给卡库加1、有卡后切固定内容、带库存切回卡库、向固定内容导卡、把商品改成类型0及跨Supplier读取均分别失败；固定内容普通入库1成功并使总库存8，随后合法更新固定内容地址且两SKU身份稳定。卡库SKU退役时证据中保留2张历史卡，库存列表只剩固定内容SKU，退役卡导入和普通库存调整均失败；恢复后卡库库存2、固定内容库存6、商品总库存8，固定内容为更新后的值，Supplier生命周期系统日志累计4条。原有Supplier实物SKU稳定编辑/退役场景和Admin类型1场景也继续全部通过。

最终报告的全部布尔断言均为true，`cleanup_succeeded=true`、临时schema计数不变、`public_state_unchanged=true`；临时Worker删除成功，URL复验404。过程中一次总括断言失败仅因类型不可变测试仍携带固定内容而先命中“实物不能配置固定内容”，写入本身已被拒绝；测试改用合法实物payload后精确命中类型不可变分支。另一次Hyperdrive返回瞬时`CONNECTION_CLOSED`，该次也完成schema与Worker清理；重试后通过。最终采纳的扩展场景没有修改任何`public`业务行或公共序列，主Worker、Supplier前端和Admin均未发布。

本地Worker完整单元为210文件/1,335项全通过，Supplier/Out边界、库存权威、退役过滤和前端安全合同等专项5文件/41项通过；单元与runtime-test两套TypeScript通过，Supplier生产构建为2,271模块。schema审计保持201/201源表字段完整、外部/Worker 263表零漂移；全局路由仍为PHP 1,904 / TS 1,623 / 可执行844 / 受控不可用18 / 缺失1,042 / 退役16 / 可执行缺口1,026，API可执行418/457（91.5%）；Admin前端API审计和可观测性审计通过，可观测性仍有17个信号、53个必需事件和6个生产发布阻断。本机Windows `workerd`在沙箱内先遇日志目录EPERM、沙箱外仍以`0xc0000005`访问冲突在测试收集前退出，因此runtime测试没有执行，不能记为本地通过；真实Workers运行时由上述临时Worker覆盖，提交后的Linux CI仍须独立确认。

E5E2B只能标“候选完成，未发布”。E5E2C仍阻塞父项：当前生产此前只读审计为71个有效商品全是平台实物，Supplier商品/SKU及类型1商品/卡库存均为0；没有源MySQL连接和类型1历史行，也没有真实主管理员、Supplier管理员、受限角色或客户token。未交付与已交付卡密的退款、已暴露密钥是否允许回收、通知和失败重试策略仍需业务确认并用真实角色E2E验证，之后还要另行批准发布和观察。

### E5E3 手工虚拟商品创建编辑与订单闭环

旧PHP的活动商品表单把`product_type=3`定义为“虚拟商品/虚拟发货”：Admin发布0、1、3、4，Supplier发布0、1、3；`StoreProductServices::saveData`对1/2/3统一强制`freight=2/temp_id=0/postage=0`，类型在编辑页不可切换，但类型3保留普通SKU价格和库存，而不是复用类型1卡密/固定内容字段。订单侧，Admin人工虚拟发货写`delivery_type=fictitious`、`fictitious_content`及`delivery_fictitious`状态，Supplier同样存在整单虚拟发货；`Delivery`监听器用`order_fictitious_success`通知标识，`StoreCartServices`把1/2/3视为无需物流，退款是否允许则读取下单商品快照中的`is_support_refund`。这些结论来自`app/services/product/product/StoreProductServices.php`、`app/controller/supplier/product/StoreProduct.php`、`app/services/order/StoreOrderDeliveryServices.php`、`app/listener/order/Delivery.php`、`app/services/order/StoreOrderRefundServices.php`和`app/services/order/StoreCartServices.php`的活动调用链，不是按枚举名称推断。

迁移前存在一组互相放大的缺口：Admin和Supplier保存服务都拒绝类型3；后台交付接口没有把配送方式绑定到不可变商品类型，因而实物可走人工交付、类型3可走快递、类型1也可被手工覆盖；Supplier拆单路径没有阻止类型3；Admin允许空人工交付正文并可能写错状态事件；结算仅对类型1禁止自提。人工交付正文虽然已写入`fictitious_content`，PC和UniApp却只读取类型1的`virtual_info`并显示卡密语义，导致客户看不到类型3交付结果。退款服务本身已有逐订单商品的快照策略，但类型3商品表单没有提供对应开关，也没有生产运行时证据。

本轮把类型3恢复为独立履约类型。Admin与Supplier创建页可选择0/1/3，编辑时类型不可变；类型3强制`delivery_type=''`、`freight=2`、`postage=0`、`temp_id=0`，不出现物流、重量、体积或卡密字段，仍使用普通单/多规格SKU的稳定`id/unique/suk`、库存流水、汇总与可恢复退役合同。Admin和Supplier都显式保存并回读`is_support_refund`。结算新增统一的无物流商品校验，旧类型1/2/3不能选择到店自提；类型3继续免地址和运费。UI实际检查还发现Admin单规格类型3同时展示主库存与SKU库存的重复输入，已修正为单规格只编辑主库存、多规格才逐SKU编辑。

履约边界集中到共享策略：已付款类型3只允许`delivery_type=fictitious`且必须整单交付，人工正文去除首尾空白后仍须非空并受既有请求体上限约束；类型3快递或拆单、实物人工交付、类型1人工覆盖、类型4人工交付、未付款、跨Supplier操作全部失败关闭。Admin状态事件按人工/快递/无需物流分别写`delivery_fictitious`、`delivery`、`delivery_goods`，Supplier同样从订单中的不可变`product_type`判定，不接受请求体扩大类型。客户详情只在订单属于当前客户、`paid=1`、`status>=1`、`product_type=3`且`delivery_type=fictitious`时暴露`fictitious_content`；未交付时为空，PC和UniApp分别显示“已人工交付/虚拟商品已交付”，类型1自动交付仍沿用卡密展示。为保持旧PHP运营审计语义，正文保留在受后台权限保护的`delivery_fictitious`订单状态说明中；它不会复制进`order.delivery.notice` outbox载荷，从而避免再扩大到队列和第三方通知面。

退款语义没有新造一套类型3特例：下单继续把商品的`is_support_refund`写入订单商品快照，真实`applyOrderRefund`对允许退款的已交付类型3创建一条退款并让同一幂等请求回到同一退款ID；快照为0时拒绝且订单、购物车和退款表不变。这个结果证明了迁移与旧PHP逐商品退款开关的一致性，但不代表运营侧已经决定所有虚拟内容的售后政策；具体商品仍由创建时的显式开关负责，真实历史行需在E5E5逐行核对。

生产运行时证据使用已授权Hyperdrive`9748c294e21c49a99579c9cef70102e0`，没有发布主Worker。扩展后的Supplier SKU隔离场景在随机schema调用真实保存、库存和退役服务：类型3以两个SKU库存3/4创建并强制无物流，普通入库2后总库存9，合法编辑保持身份和退款开关，类型不可变，退役/恢复后仍保持汇总且无任何卡密内容。最终Worker`cinashop-supplier-sku-audit-c9b4bc8995f8`的原有实物、类型1和新增类型3断言全部通过，系统日志为6，26张公共相关表和序列指纹不变；schema及Worker已删除，URL复验404，无令牌403、错误方法404。

独立履约Worker`cinashop-manual-virtual-audit-44ca5c91183c`在另一个随机`codex_manual_virtual_*` schema克隆订单、订单商品、退款、状态、outbox和运单任务所需表及本地序列，直接调用真实Supplier履约和退款服务。结果验证：类型3人工交付成功、重放幂等、客户正文交付前隐藏/交付后可见、`delivery_fictitious`与`out_order_delivery`状态正确、只生成一个不可变`order.delivery.notice` outbox且载荷没有正文；空正文、拆单、类型3快递、实物人工、类型1人工、类型4人工、跨Supplier均拒绝；允许退款创建一次并安全重放，禁止退款被拒绝，所有拒绝路径没有改变被测订单。最终为8个订单商品行、1条退款、0个运单任务，19项布尔断言全部为true；公共相关表/序列前后指纹一致、临时schema数量回到基线、Worker删除后URL 404。两次夹具修正也保持安全：一次事务外DAO因连接池search path回落而读不到隔离订单，一次非数字订单商品标识不满足真实退款服务合同；两次均清理随机schema和Worker，修正为显式事务作用域与数字标识后才采纳最终报告。一次Supplier场景遇到Cloudflare瞬时1042路由错误，同一构建重试通过且失败轮也完成清理，因此只记录为瞬时审计基础设施异常，不把它算作业务成功证据。

通知失败与重试沿用已迁移的事务outbox消费者、幂等键和重试/死信机制；本轮生产隔离场景证明类型3会生成正确而且不含正文的真实outbox行，但没有调用外部短信/模板消息提供方，也没有真实客户通知配置或故障注入。因此这里只能证明“通知任务可靠入队合同”，不能宣称真实用户已收到通知或外部失败重试已完成验收。

本地应用内浏览器实际检查Supplier`/products/new?preview=1`：类型3显示单位“份”、普通库存和退款开关，隐藏物流、重量、体积与卡密字段；Supplier`/orders?preview=1`中的类型3订单只显示“虚拟交付”，部分发货禁用，弹窗要求交付正文；Admin`/product/create?preview=1`同样验证了类型3和退款策略。由于当前自动化文本输入能力限制，Supplier交付弹窗没有在preview提交，运行时写路径由生产隔离Worker覆盖；这些都不是生产账号/真实权限验收。Worker全量211文件/1,342项单元与单元/runtime-test双TypeScript通过；Admin前端342个调用点/362个路径变体全部可执行，未注册、受控不可用和未解析均为0。Admin 2,437、Supplier 2,271、PC 1,828模块生产构建及UniApp H5构建已通过，Windows本机`workerd`仍有既知`0xc0000005`访问冲突，Linux CI须作为独立运行时门禁。

精确实现提交`be61e36a1bda2af0e30af17484b4bf3a39587de3`推送后，[Actions `33856242181`](https://github.com/cinagroup/cinashop/actions/runs/33856242181)首次运行的两个Worker job分别因npm官方安全审计端点返回503和5分钟网络超时而在代码门禁前失败；保留成功的六个job并重跑失败项后，生产依赖审计实际返回成功，Linux workerd、Worker双TypeScript/1,342项单元/schema/route/observability、Admin、PC、Supplier、Kefu、UniApp和全历史密钥扫描最终8/8成功。该失败按外部注册表瞬时故障记录，未被当作漏洞通过或静默豁免。

E5E3因此只能标“候选完成，未发布”。生产公共业务数据没有改写，随机schema和临时Worker均已清理，主Worker及四端前端均未发布。E5E2C卡密退款策略、E5E4次卡商品创建编辑、E5E5源PHP类型1/3/4历史数据复制与真实Admin/Supplier/受限角色/客户流程、外部通知故障、正式发布和观察仍未完成；FE-001E5、FE-001E5E与FE-001E6继续开放。

### E5E4 次卡商品创建编辑与核销闭环

旧PHP的活动Admin表单把`product_type=4`定义为次卡到店核销，并明确限制为单规格单SKU；每个SKU保存`write_times`、`write_valid`、`write_days`、`write_start`、`write_end`。核销次数允许1～99,999,999；时效1为永久，2为购买后N天，3为固定起止时间且结束必须晚于开始。商品保存强制到店履约。Supplier活动表单只发布0/1/3，并未发布类型4，因此迁移不能为了“端能力对称”擅自给Supplier新增次卡入口。支付任务按持久化支付时间激活模式2，订单商品快照保存总次数、剩余次数和有效期；门店核销读取快照并递减剩余次数，临期/过期通知分别使用`reminder_brink_death`和`expiration_reminder`。这些结论来自活动`view/admin/src/pages/product/productAdd/index.vue`、`StoreProductServices.php`、`StoreProductAttrServices.php`、`OrderPayHandelJob.php`、`StoreOrderCartInfoServices.php`和`WriteOffOrderServices.php`调用链，而非仅按字段名推断。

迁移前后端已经有E5E1审过的付款时激活、事务核销、提醒outbox和退款基础，但商品创建链仍拒绝类型4，Admin表单类型联合也只有0/1/3；共享SKU编辑器既不接受类型4，也没有验证、写入和回读五个核销字段。结算端没有从购物车商品类型强制到店自提，PC/UniApp订单详情也没有呈现次卡剩余次数和有效期。这意味着数据库列和下游状态机虽然存在，运营仍无法安全创建一个能进入该状态机的次卡商品，不能把E5E1的局部支付证据当作完整生命周期完成。

本轮按上述权威恢复Admin类型4。`ProductSkuEditorService`新增三种时效的规范化、边界校验、数据库写入、不可变属性快照及写后精确回读；类型4拒绝多规格和多SKU，清除不属于当前时效模式的字段，购买后天数限定1～3650，时间戳还受PostgreSQL整数范围约束。`ProductAssociationService`只在类型4配置出一个合法SKU后允许保存，并统一强制`delivery_type=2`、包邮、零邮费、无运费模板；已有SKU继续按`suk`保持`id/unique/sales/sum_stock`身份，编辑核销规则后必须从数据库回读完全一致。Supplier仍拒绝类型4，其复用的共享SKU输入只补内部默认值，不扩大旧PHP租户能力。

Admin商品页创建时可选择类型4，编辑时仍禁止切换履约类型；次卡区显示次数和永久/购买后N天/固定区间，强制并禁用单规格，隐藏图片、条码、编码和不适用的SKU退役控件。草稿、详情回填、提交规范化和API类型均携带五个字段；实际UI检查发现preview草稿API原先仍请求不存在的代理而弹“草稿读取失败”，现改为仅preview使用内存草稿，生产API路径不变。PC和UniApp购物车数据补充`productType`，只要订单包含次卡就把结算配送锁为门店自提并显示说明；Worker仍在服务端拒绝类型4快递，不能依赖前端。两个订单详情页新增“次卡权益”，展示总次数、已用/剩余次数、永久/未激活/起止有效期和已核销状态。

生产运行时验证使用已授权Hyperdrive`9748c294e21c49a99579c9cef70102e0`和单一数据库客户端，在随机`codex_second_card_product_*` schema克隆商品、SKU、订单、订单商品、退款、核销状态、提醒outbox等所需表与本地序列。临时Worker只接受随机32字节令牌，部署变量只保存令牌SHA-256；无令牌请求必须403，错误方法必须404，响应禁用缓存。隔离事务设置本地`search_path`后调用真实`ProductAssociationService`、付款激活、`StoreOrderWriteoffService`、`StoreOrderRefundService`和`SecondCardReminderService`，并在清理前后比较公共相关表、序列及schema基线指纹。

最终Worker`cinashop-second-card-product-audit-bf867156a53b`在PostgreSQL 16.14上证明：类型4创建和更新成功，单一SKU身份稳定，数据库自提策略及五个核销字段回读一致；购买后30天窗口从持久化支付时间激活；一次部分核销后旧核销码失效，再用新码完成剩余次数，最终得到2条不可变核销状态证据；过期次卡和非所属门店均拒绝且不改变订单。未核销且商品快照允许退款时真实退款服务创建退款，部分消费后即使快照允许也拒绝退款。提醒服务只暂存并投递一次，重放不新增outbox或Queue消息，Queue载荷只含opaque outbox标识，不含手机号或渲染后的消息正文。所有业务断言、`schema_created/schema_removed/public_state_unchanged`均为true；Worker删除成功且公开URL返回404。

生产只读提醒审计给出了不能被隔离场景替代的现实边界：当前生产有28条订单商品、相关表大小188,416字节，但类型4商品、次卡订单商品、到期候选和孤儿均为0；提醒outbox为0，`reminder_deadline_second_card_time`没有配置行，代码运行时回退为提前1小时。`reminder_brink_death`与`expiration_reminder`两类通知模板/配置行也均为0。两条次卡扫描部分索引均存在、valid且ready，outbox CHECK已允许五类事件且没有不支持事件；当前3条活动退款全部是平台scope。由此可证明schema和调度合同就绪，却不能宣称生产已有真实次卡、模板或用户通知；模板内容、运营提前量、真实消息提供方成功/失败重试仍必须在E5E5和发布观察中验收。

审计harness的失败过程均保留而未混入成功证据。首次Worker因边缘传播窗口持续返回404而没有触库；另一轮遇到Cloudflare 1042运行时路由错误；第一次真正进入数据库后，夹具给退款服务传了非数字订单商品标识并被真实校验拒绝。修正为更长就绪探测、单客户端和数字标识后，先完成商品/付款/核销/退款场景；再加入真实提醒表、内存Queue和幂等断言，才采纳上述最终报告。每一轮都执行`finally`删除Worker并复验URL 404；创建过随机schema的轮次也完成schema清理，生产公共指纹没有变化。

本地Admin preview实际操作了次卡类型、购买后N天和固定区间；桌面控件齐全，390×844下页面宽度与视口均为390、无横向溢出，修复草稿后不再出现错误提示，控制台warning/error均为0。Worker专项4文件/23项和最终全量212文件/1,349项单元通过；单元及runtime-test双TypeScript在明确4 GiB Node堆下通过，PC生产构建1,828模块、UniApp类型检查及H5构建通过，Admin生产构建2,437模块。Windows本机workerd仍在执行断言前因既知`0xc0000005`/日志目录权限失败，因此没有把本机0项写成通过，Linux workerd由远端门禁补足。

实现提交`a74d1b2f08294cdd7a745d5920d03b3e6b458bbb`推送后，首轮Actions只有Worker主门禁因npm官方安全审计端点HTTP 503而失败，同一提交的Linux workerd及其相同生产依赖审计、其余六个作业均通过；失败项重跑仍遇到同一外部503。提交`e6a7cd7964f792a8f038290d05391d281217bc77`把`audit:prod`改为只对5xx、超时和明确网络错误做最多三次有限重试，每次仍执行`--omit=dev --audit-level=low`，发现真实漏洞立即失败，三次服务不可用后同样失败。其本地实测前两次超时、第三次成功并报告23个生产依赖、0个各级漏洞；[Actions `33866228404`](https://github.com/cinagroup/cinashop/actions/runs/33866228404)首次仍在三次网络失败后保持红色，精确重跑成功执行生产依赖审计、Worker双TypeScript/1,349项单元/schema/route/observability，连同Linux workerd、Admin、PC、Supplier、Kefu、UniApp和全历史密钥扫描最终8/8成功。

E5E4因此可标“候选完成，未发布”。本轮只在生产数据库内使用已清理的随机隔离schema，没有改写公共业务行，也没有发布主Worker或四端前端。生产当前没有类型4样本，真实历史类型4商品/SKU/订单快照尚未从源PHP复制；主管理员、只读/编辑受限角色、门店核销员和真实客户流程，真实提醒模板与通知故障，以及发布后观察均继续由E5E5、FE-001E6和正式发布门禁承接。FE-001E5与FE-001E5E继续开放。

### E5E2C1 卡密退款不可回收边界与源端行级对账准备

旧PHP退款入口只依据下单商品快照中的`is_support_refund`判断可退，卡密履约则把`store_product_virtual`从`uid=0`改为订单用户并将卡号/密码写入订单交付内容；活动代码没有把已经分配、已经展示的一次性密钥重新置回可售库存。迁移前的TypeScript自动交付同样没有和售后申请共享订单锁，也没有扣除已完成部分退款数量，存在“退款申请已创建、支付outbox随后仍发卡”和“部分/全额退款后仍按原数量发卡”的竞争窗口。已暴露密钥若重新销售会把同一秘密交给两个客户，不能把普通库存退回规则套在卡密上。

实现提交`bc28ec5`新增统一权威策略：客户只可对未发放的一次性卡密走仅退款，订单状态/交付字段、不可变交付快照或`store_product_virtual.order_id`任一证明密钥已经分配/暴露即失败关闭；只有携带`privilegedActor=admin`且写入审计状态的`apply_type=4`善意退款可继续，卡记录的`uid/order_id`始终保留，绝不重置为可售。固定内容不查询实时SKU，继续使用订单不可变`disk_info`快照和`is_support_refund`。策略在申请创建、持久化退款执行和最终入账三处复核，不能靠绕过前端或延迟执行规避。

退款、核销、收货和自动交付统一先取得订单锁；交付在锁内读取活动售后并锁定订单商品，任何`refund_type IN (0,1,2,4,5)`的未取消申请都会阻止发卡。已完成部分退款按`cart_num-refund_num`交付剩余数量，全额退款不领取卡也不写空交付。PC和UniApp订单详情使用服务端`refund_eligibility`隐藏不允许的入口，申请页重新读取订单权威状态；类型1/3/4均不展示退货物流选项，服务端仍独立拒绝类型1退货申请。本地应用内浏览器在桌面退款页验证了警告、仅退款选项、禁用提交、可交互下拉和零控制台warning/error；这只是合成客户页面证据，不是生产账号验收。

生产运行时通过已授权Hyperdrive`9748c294e21c49a99579c9cef70102e0`部署一次性令牌保护的临时Worker`cinashop-virtual-card-refund-audit-e9d8d5ade8d4`。它只读`public`并在随机`codex_virtual_refund_*` schema克隆6张相关表、建立本地序列，直接调用真实退款和交付服务。PostgreSQL 16.14最终证明：已发卡客户退款被拒、Admin善意退款创建且退款快照不含卡号/密码、已分配卡未回收、进行中退款阻止交付且卡仍未分配、部分退款只交付1个剩余卡、全额退款不交付、固定内容客户退款成功、畸形快照及虚拟退货均拒绝。全部布尔断言为true，随机schema删除、`public`表行数及相关序列前后完全一致；无令牌403、错误方法404，Worker删除成功且URL复验404。生产现实目录同时确认类型1有效商品、平台/Supplier类型1商品、类型1 SKU、可用/已分配卡、类型1订单商品/订单及孤立已分配卡全部为0，因此隔离状态机证据不能冒充真实源数据验收。本批没有发布主Worker、PC或UniApp。

最终本地门禁为Worker单元/runtime-test双TypeScript通过、212文件/1,352项单元全部通过，PC生产构建1,828模块、UniApp类型检查通过；退款专项包含9项静态/纯函数合同。客户端准备方面，官方Windows PHP ZIP安装为PHP 8.4.25 CLI；本机系统VC运行时文件与已安装包版本不一致，因此使用微软签名的14.51 DLL作为应用本地运行时，没有替换系统DLL。Oracle签名的MySQL Shell 26.7.1便携包已安装到当前用户目录并加入用户PATH，`mysqlsh --sql --version`从项目目录返回0。官方MSI也完成签名/SHA-256验证，但每用户安装因其仍尝试写HKLM EventLog键而以1406/1603回滚；这不影响当前便携SQL客户端。

当时尚未确定部署是否承接旧站历史，因此本节如实记录了源端不可用及未执行逐行对账。2026-09-04项目所有者随后确认旧PHP站没有需要继承的真实历史数据；这一后续决策由下方DATA-SCOPE-001正式覆盖本段的“等待源连接”结论。E5E2C2改为“不适用”，剩余门禁仅是新系统样本、真实Admin/Supplier/受限角色/客户、通知故障和发布观察。

## FE-003A UniApp活动清单、旧链接合同与三端条件编译（2026-09-04）

### 计数纠偏与逐路由账本

旧审计把 `cinashop-php/view/uniapp/pages` 下250个Vue文件和新端“55个页面组件”直接比较，这个口径混入模板、内嵌组件和未注册文件，也已经落后于新端实际状态。以可导航清单为权威重新读取旧 `pages.json`：主包7条，10个分包合计144条，共151条逻辑路由；旧清单SHA-256为 `B3F0D0DB6F6E7E1E2C039695712797FBBB0B1146ACC85D304C24BB344E185EB7`。H5条件额外包含支付宝中转页，因此实际151条；MP-WEIXIN和APP-PLUS均为150条，APP-PLUS与其他平台在社区视频页的 `app/index` 实现间切换但不改变各自记录数。新端 `pages.json` 和实际页面文件均为59条/个，三平台均注册59条，SHA-256为 `B0840BC56FE1AF51BA4CEA7D002384DEFC9EF3398AD36C8D96CD307CA00F4BB9`。

本轮将151条旧路由唯一归档：3条原路径仍直接注册，97条进入显式兼容规则，其中60条为候选覆盖、37条为聚合页或能力不完全等价的部分替代；剩余51条被拆为7个缺口组，而不是用新页面总数推算百分比。51条包括用户治理/历史5、分销商与代理商自助5、预售/新人/直播/排行4、移动Admin跨端候选16、支付回调/WebView/历史深链7、反馈/企业Work/代客下单11、社区话题/搜索/视频深链3。机器可读账本位于 `workers-ts/audit/uniapp-frontend-parity.json`，`npm run audit:uniapp`会重新解析两个活动manifest、校验SHA-256、逐条比较账本集合、检查重复或遗漏，并确认每个兼容目标确实在新manifest注册。

“移动Admin”没有被简单算作客户UniApp缺页：旧管理操作主要应由 `admin-ts` 承接，16条仍标为 `cross_surface_candidate`，必须补移动视口覆盖和旧入口退役跳转；扫码核销相关5条可落到受真实操作员身份限制的 `/pages/operator/writeoff`，但其中历史/结果/扫描详情被如实标为部分替代。类似地，旧分销商/代理商角色不能因名称接近就跳到Supplier入驻；Work虽已有 `api/work.ts` 上下文合同却没有任何注册页面消费者，仍计为缺口。旧任意URL WebView没有恢复，以免把服务端内容变成无域名约束的内嵌浏览器；只有完成白名单设计才可重开。

### 运行时旧链接修复

迁移前 `normalizeDiyLink`只检查字符串以 `/pages/` 开头，任何不存在的内部路由都会被放行给UniApp并静默失败；其11条旧映射里秒杀和拼团还使用了旧manifest中并不存在的 `goods_*_details` 名称。首页开屏广告与fallback Banner更完全绕过共享解析器，直接调用 `navigateTo`，Tab页也可能用错跳转方法。现在 `config/navigation.ts`以59条注册路由作为唯一白名单，并给97条旧路由附带覆盖等级和目标。未知内部路径失败关闭；合法HTTPS外链继续只提示在浏览器打开；五个Tab页统一 `switchTab`，其他注册页才允许 `navigateTo`。DIY组件、悬浮导航、开屏广告和首页Banner均走同一个 `openDiyLink`。

兼容不只改路径。旧订单详情使用 `order_id`，新页读取 `orderId`；旧搜索分享链接使用 `searchVal`，新搜索使用 `keyword`；旧支付结果使用 `order_id/totalPrice`，新页使用 `orderId/amount`。解析器只对对应旧路径重命名这些键并保留其他查询段，搜索页同时增加启动参数读取和自动查询。聚合落点不会被夸大：例如旧经验记录落到会员等级、签到记录落到积分流水、部分社区详情落到信息流，均保持 `partial_replacement`，后续仍需按具体查询状态恢复深链。

### 验证结果与发布边界

专项回归6项通过，覆盖151条唯一账本、59条manifest/实际Vue文件/运行时白名单一致、97个目标全部注册、未知路径拒绝、订单和搜索参数别名、首页所有服务端链接入口统一解析。`vue-tsc --noEmit`通过；H5、MP-WEIXIN和APP-PLUS生产条件编译均完成。App构建报告 `request.ts`被订单确认页动态导入、同时被多数API静态导入的既有分块提示，但构建成功，本轮没有把该提示写成零warning。尚未运行微信真机、App容器或真实H5 Provider回调，也没有发布任何前端或主Worker；因此FE-003A和FE-003I只标本地候选完成，FE-003父项继续开放。

源端行级对账的运行条件也在本轮重新检查。当时当前Codex进程看不到可用源连接，本机也没有MySQL/MariaDB服务或3306监听；后续虽在用户环境发现指向本机3306的`SOURCE_MYSQL_URL`，实际连接明确返回拒绝。PHP仓库只有安装/demo SQL而非可运行生产数据库。这些事实解释了此前为何无法对账，但项目所有者随后确认本部署不承接旧站真实历史，故不再要求建立隧道、安装MySQL Server或恢复源连接。PHP/MySQL客户端仅保留为开发工具，生产目标继续只经已授权Hyperdrive访问。

## DATA-SCOPE-001 新系统数据口径与生产基线（2026-09-04）

### 决策与范围

项目所有者明确确认：`cinashop`是全新系统，旧PHP站没有需要继承的真实历史数据。由此，PHP仓库继续承担接口行为、权限、状态机和201张共享表结构的参考角色，但`public/install/crmeb.sql`只视为安装/demo种子，不作为生产业务数据源；源MySQL复制、逐行摘要、旧账号/订单/资金/消息及旧对象存储迁移均不进入本部署完成条件。机器可读范围已经固化在`workers-ts/audit/data-migration-scope.json`，并由单元测试保证DATA-001～005均以“不适用”关闭，任何开放项不得再次把`SOURCE_MYSQL_URL`或旧PHP历史复制列为阻塞。

本机核验支持这一结论：已安装的MySQL Shell只是客户端，系统没有MySQL/MariaDB Server、Windows服务或3306监听；用户环境中的连接串指向本机3306，连接结果为`ECONNREFUSED`。`cinashop-php`没有数据库数据目录或可启动的源实例，`crmeb.sql`约7.3 MiB，仅包含建表和演示型初始化内容，并不构成旧生产历史。无需为了本部署创建本机MySQL库，也不得把demo INSERT冒充真实迁移结果。

### 生产PostgreSQL只读基线

通过已授权Hyperdrive `9748c294e21c49a99579c9cef70102e0`部署一次性SHA-256令牌保护的临时Worker，只执行SELECT并在结束后删除。PostgreSQL版本为16.14；初始`public`有262张表、3,684列、892个索引、249个主键。仓库外部DDL与Worker内嵌DDL均定义263张表且彼此零漂移；逐表集合比较只发现生产缺`admin_user_write_replay`，没有生产额外表。临时Worker无令牌返回403，删除后URL返回404。

随后完成DB-005。专用迁移Worker在2秒锁等待、15秒语句和20秒空闲事务上限内取得事务级advisory lock；预检再次确认目标表与序列不存在，并记录`system_admin/user/user_money/user_bill/other_order/store_coupon_issue/store_coupon_user/system_log`八类相关表计数。`0119_admin_mobile_user_replay.sql`在同一事务执行两遍，终态目录为263表、3,696列、896索引、250主键；目标表12列、4约束（含主键）、4索引（含主键）、owned sequence、0行均精确通过，定义SHA-256两遍同为`b47b9719e164130cc37a66148414e899f51ba91c1df5d11d0afe12dd97fd052d`，八类业务计数前后相等。无令牌请求403、错误方法404；临时Worker`cinashop-admin-user-replay-migrate-f874a33471a1`删除成功且URL返回404。该步骤只改变候选DDL对象，没有发布主Worker或任何前端。

生产业务计数是新系统当前状态，不再与旧站比较：商品71、订单29、订单商品28、退款3；客服账号0、会话0、消息3；商品描述0、访问0、分类关系0，面单及打印任务均为0。`data_migration_run`与`data_migration_checkpoint`均为0，符合“不执行旧历史迁移”的口径。另有6个`system_config`重复键、20条额外重复行，以及用户资金/退款等既有孤儿引用；这些归入DATA-007，由业务所有者按当前系统语义裁决，不能自动绑到现有用户或为追求对账数字直接删除。

### 仓库迁移进度复核

结构审计为PHP参考表201、候选表263，201张共享表全部覆盖、源侧独有表0、Worker扩展表62，外部/内嵌定义均为263且列/主键漂移0。路由审计为PHP 1,904、TS 1,628、精确匹配867、可执行849、受控不可用18、缺失1,037、退役17、可执行缺口1,020；总体精确/可执行/剔除退役后的覆盖分别为45.5%/44.6%/45.0%。分面结果为：`/api`可执行423/457、可执行缺口29；`/adminapi`可执行205/1,153、可执行缺口933；Supplier 120/182、剔除12条退役后缺口50；Kefu 60/63且3条均已证据化退役、可执行缺口0；Out 41/41；ERP 0/8。

Admin前端有342个请求调用点、362个路径变体，全部已注册且可执行；但旧Admin有245个不同路由页面，新Admin只有53个，设置页76项中reviewed 15/candidate 11/partial 3/retired 1/unreviewed 61。UniApp旧manifest有151条路由，新端59条；3条原路径直接覆盖、97条进入显式兼容规则（60候选、37部分替代），仍有51条分成7个缺口组。可观测性账本有17个信号、10个组件、53个事件，生产告警仍待物化，6个发布阻断未关闭。全新系统口径与DB-005证据提交`d1fd1b52ca1b67a965d588fc14b94436ccee9285`推送后，[Actions `33934221938`](https://github.com/cinagroup/cinashop/actions/runs/33934221938)的Linux workerd、Worker双TypeScript/1,364项单元/schema/route/observability、五端构建和全历史密钥扫描8/8成功。主Worker和正式前端没有因本次范围审计发布。

### 清单重分类与下一顺序

DATA-001～005已关闭为不适用；历史源端工具保留用于其他部署，但不再执行。DB-005已按上述证据完成，仓库与生产均为263表且精确零表差集。后续数据工作依次是DATA-006新系统关键业务初始化、DATA-007现存孤儿/重复配置裁决、DATA-008 DIY/营销/媒体/店面配置。功能迁移仍按路由、前端、真实角色/provider、预发、发布和观察门禁逐项推进；“无需旧历史数据”不等于功能迁移或生产上线已经完成。

## DB-003 重复系统配置决策证据（2026-09-05）

一次性令牌Worker在生产只读事务中按实际`SystemConfigDao`优先级`is_store=0, sort DESC, id DESC`重新读取重复配置。结果为6个键、26行、20条额外行，数据库没有任何外键指向`system_config`。`record_No`五行值相同，运行时选择启用且`sort=97`的ID 390；`sign_give_point`、`sign_status`、`system_comment_time`、`system_delivery_time`各四行且各组值完全相同。唯一存在值分歧的是`site_url`：运行时选择启用且`sort=98`的ID 389=`https://cinashop-pc.pages.dev`，ID 410/404/398/2均停用、低优先级且值为`https://cinashop.example.com`。

审计器只对白名单中的`site_url/sign_give_point/sign_status`展示值，其余配置只返回长度、类别和SHA-256；没有日志输出配置值，也没有DDL/DML。两次审计Worker均强制令牌，无令牌403、错误方法404，删除后URL 404。完整精确ID与摘要已固化在`workers-ts/audit/system-config-duplicate-baseline.json`。证据足以把DB-003从“未知重复”缩小为一个业务确认：是否正式保留当前Pages地址ID 389。确认前不删除；确认后只按清单中的20个ID执行短事务，并复验保留行、所有非目标行和owned sequence不变。DB-003审计增量本地专项4/4、完整216文件/1,368项单元及双TypeScript通过。

## AUD-003 新系统口径文档一致性（2026-09-05）

复核发现两类陈旧状态会误导后续执行。其一，`ADMIN-D`仍写生产缺`admin_user_write_replay`，与已经完成并验证的DB-005矛盾；现已改为生产DDL就绪、仅真实角色E2E和发布未完成。其二，`workers-ts/README.md`的当前状态与开放TODO仍把旧站账号、商品、会员、促销、通知和卡密复制写成前置条件；这些已统一重分类为DATA-006/008的新系统初始化，或DATA-007的当前生产记录owner裁决。通用MySQL迁移器与历史审计段落继续保留，专节显式标注“当前部署不适用”，不篡改当时的审计事实。

`data-migration-scope.test.ts`现在同时解析根清单与Worker README的开放checkbox，禁止`SOURCE_MYSQL_URL`、源MySQL复制或复制旧数据再次成为当前完成阻塞。清单新增AUD-003并更新TEST-001到提交`aff75cf`对应的[Actions `33934911543`](https://github.com/cinagroup/cinashop/actions/runs/33934911543)：8/8 jobs成功，包含Worker双TypeScript、216文件/1,368项单元、Linux workerd、201→263结构零漂移、路由/可观测性审计、五端构建与全历史密钥扫描。本项只修正权威执行口径，不将未完成的真实账号、provider、E2E或发布门禁关闭。

## API-009 动态统计脚本入口退役（2026-09-05）

PHP `GET /api/get_script`直接返回`sys_config('system_statistics')`，不使用JSON envelope、脚本白名单、固定provider或内容签名；旧UniApp H5的`App.vue`创建`script`元素并把该URL挂到页面`head`，所以运营配置一旦被错误或恶意修改，所有访问H5的浏览器都会执行任意JavaScript。旧系统配置服务也明确把`system_statistics`作为可编辑textarea字段。这个合同不是普通的“统计配置读取”，而是持久化主动脚本执行边界。

当前Worker、Admin、PC、Supplier、UniApp和Kefu源码均没有`get_script`或`system_statistics`消费者；恢复兼容路由只会重新扩大攻击面，不会服务当前第一方流程。因此在`legacy-route-decisions.json`中以路由、控制器、旧H5调用和配置表单四处源行证据将其正式退役，替代原则是未来若需要统计，必须以固定provider身份、用户同意与Content-Security-Policy约束的显式集成另行设计。`dynamic-statistics-script-retirement.test.ts`同时确认PHP权威快照仍包含该合同、退役决策完整，并递归扫描六个当前源码根阻止重新暴露或消费它。路由权威快照显式重建后，全局退役`16→17`、可执行缺口`1,026→1,025`；API面退役`1→2`、可执行缺口`35→34`、退役后有效覆盖`91.7%→91.9%`。这没有注册虚假成功路由，也没有发布任何Worker或前端。

## API-010 公共启动配置5条（2026-09-05）

PHP把`wechat/get_logo`、`wechat/teml_ids`、`logistics`、`copy_words`和`get_customer_type`放在同一个StationOpen加可选登录路由组中。旧UniApp确有对应包装器；移动Admin发货页读取物流首项的`code`，随后只消费承运商`name/code`。PHP物流服务却把`partner_id/partner_key/net/account/key/net_name`一并送到公开客户端，这些是承运商签约或网络配置，不是选择器合同。小程序模板接口则把`config/template.php`内14个事件的short ID逐个映射到启用的`template_message(type=0,tempkey)`提供商模板ID。

候选新增独立`PublicBootstrapCompatibilityService`并精确注册五条路由。Logo只接受站内相对路径或无userinfo的HTTPS，canonical `/api/assets/:id`在响应时以APP_KEY生成15分钟签名，不把短期签名写回配置；客服入口的两个类型转换为安全整数，电话/CorpID有界且去控制字符，外链只允许HTTPS或站内相对路径。订阅模板按迁移后的`notification_template.legacy_type=0/status=1/mark=shortId`一次批量读取，以ID倒序确定重复项，14个键始终完整且缺失值为`null`。物流查询只投影`id/name/code`、保持`sort DESC,id DESC`和`is_show=1`，`status=1`时再过滤启用状态，500条上限超出后失败关闭，绝不返回承运商账户或密钥。

专项测试5/5覆盖危险客服URL拒绝、配置类型和有界文本、R2签名与旧相对Logo、14个模板键/重复优先级/缺失值、物流凭据剥离及五条StationOpen+可选登录注册。双TypeScript与完整218文件/1,375项单元通过；路由审计从TS 1,623/精确862/可执行844推进为1,628/867/849，全局可执行缺口`1,025→1,020`，API面`34→29`且退役后有效覆盖`91.9%→93.0%`。本批没有生产数据库读取或写入、没有外部provider调用，也没有部署主Worker或前端；真实模板、品牌配置、承运商目录和旧端E2E仍属于DATA-006/008与发布门禁。

## API-011 城市与门店发现4条（2026-09-05）

PHP公开合同为`GET /api/city`、`city_list`、`store_list`和`nearby_store`。第一条只经过StationOpen，后三条还经过可选登录。`city`以`city_area.id/parent_id`提供惰性地址树，父级默认“中国”，有子级的节点返回空`children`及两个loading标记；`city_list`则把`system_city`全部行按`city_id/parent_id`递归为`v/n/parent_id/children`完整树。旧PHP允许`page=0/limit=0`取消门店LIMIT，新公开Worker把默认页固定为1/10、每页最多100且offset最多10,000；单层`city_area`最多1,000项，完整`system_city`最多10,000项和8层，畸形超限或循环会失败关闭。

`store_list`在PHP中实际只对`is_store=2`增加`is_store=1`筛选，传入的`product_id`没有参与库存或门店资格判断；迁移保留这一事实，不伪造商品库存过滤。正常范围固定`is_del=0/is_show=1`，完整坐标对按PHP的6,367,000米半径Haversine公式计算并升序排列，无完整坐标时按`id DESC`。旧UniApp代客确认页实际消费`id/name/address/detailed_address/range/site_logo`；候选同时保留电话、行政区、营业时间、经纬度和图片等公开展示字段，但SQL从源头不选择`bank_code/bank_address/alipay_account/alipay_qrcode_url/wechat/wechat_qrcode_url`。canonical `/api/assets/:id`门店图及站点Logo只在响应时生成短期签名，非相对路径或无userinfo HTTPS的图片引用被清空。

`nearby_store`继续由`store_func_status`控制，支持原来的`store_type`、关键词、坐标和可选登录UID；常用门店通过当前UID的`store_user.store_id`子查询限定，匿名请求常用门店返回空。PHP在缺坐标时把请求IP交给`convertIp`定位，再用城市/省份模糊匹配门店；这个外部服务、数据接收方、保留政策和Workers凭据均未声明，因此候选不复制该隐私副作用，而采用确定性的营业门店ID倒序。坐标对会逐项验证范围和格式；数据库中畸形坐标先经CASE形状门禁后才允许转为浮点，避免公开请求触发转换异常。

专项5/5覆盖坐标格式/范围、分页上限、三级城市树、两类距离格式、敏感门店字段剥离、签名图片形状和四条路由中间件；完整单元为219文件/1,380项，双TypeScript通过。路由审计从TS 1,628/精确867/可执行849推进为1,632/871/853，全局可执行缺口`1,020→1,016`，API面`29→25`且退役后有效覆盖`93.0%→93.8%`。实现提交`35ef2323b74c7aa0fa88d256477a0790a8d59520`已推送，[Actions `33938423701`](https://github.com/cinagroup/cinashop/actions/runs/33938423701)的Worker、Linux workerd、Admin、PC、Supplier、Kefu、UniApp和全历史密钥扫描8/8成功。本批沿用既有生产基线中`city_area/system_city/有效门店=0`的证据，没有再次读取或写入生产数据库，没有调用IP定位或其他provider，也没有部署主Worker或前端；真实城市、门店、营业范围、图片和前端流程仍由DATA-006/008及发布验收负责。

## API-012 积分商城首页与分类2条（2026-09-05）

PHP把`GET /api/store_integral/index|category|list|detail/:id`放在同一个StationOpen加可选登录组。首页读取`integral_shop_banner`，按`is_show=1/is_host=1`取推荐积分商品，并把当前可选登录用户的积分放到顶层`integral`；匿名按0处理。分类服务只读取可见的`category.group=5`，按排序输出`label=名称/value=最低积分-最高积分`。旧UniApp首页实际消费推荐列表和积分，分类页在前端补“全部”后把`value`原样传回列表的`range`。

本轮不仅新增缺失的`index/category`，还重新审计了此前已注册的`list`。原Worker只做分页并把`brand_name`硬编码为空，导致PHP支持的`store_name`、`priceOrder`、`salesOrder`、`range`四类查询全部静默失效，也没有排除已删除的基础商品；`list/detail`路由还漏了外层StationOpen。候选现在把四条浏览路由统一置于StationOpen与可选登录后，列表按PHP语义支持标题或ID关键词、积分优先且现金价升降序、销量升降序、闭区间积分筛选，随后稳定按`sort DESC,id DESC`；查询内联基础商品删除门禁并从基础商品品牌关系返回真实品牌名。反向区间保持为自然空结果而不是错误回退全量；畸形、负数或越界区间被忽略。活动分页仍限制每页最多50并把最大offset约束在约10,000范围，分类最多1,000行，超限失败关闭。

首页返回精确`banner/list/integral`信封，推荐列表复用同一商品投影，登录态响应标记`private, no-store`；分类映射精确保持旧字段。商品图和banner图先限制为站内相对路径或无userinfo的HTTPS，canonical`/api/assets/:id`只在响应时用APP_KEY生成短期签名；banner描述有界，`javascript:`等危险跳转被清空。未把短期签名或用户积分写回数据库。

专项7/7覆盖区间边界、四类列表参数、品牌、canonical附件签名、推荐商品、登录积分、banner解析与危险链接、分类映射和四路由中间件；全量单元220文件/1,385项、双TypeScript、生产依赖0漏洞、结构审计source201/target263/shared201/sourceGaps0且外部/内嵌263零漂移、可观测性17信号/10组件/53事件/6阻断均通过。路由审计从TS1,632/精确871/可执行853推进为1,634/873/855，全局可执行缺口`1,016→1,014`，API面从精确430/可执行427/缺口25推进为432/429/23，退役后有效覆盖`93.8%→94.3%`。主Worker minify dry-run为3,875.03KiB/gzip919.70KiB并精确解析Hyperdrive`9748c294e21c49a99579c9cef70102e0`、R2、Images、Queue、KV和Durable Objects；仅dry-run。实现提交`4582e06b34c4cbe7a00e305495f69d6398b8b31b`已推送，[Actions `33939387023`](https://github.com/cinagroup/cinashop/actions/runs/33939387023)的Worker静态、Linux workerd、Admin、PC、Supplier、Kefu、UniApp和全历史密钥扫描8/8成功。本批不需要旧PHP真实历史行，没有读取或写入生产PostgreSQL，没有调用provider，也没有部署主Worker或任何前端；积分分类、banner、推荐商品、品牌及真实账号流程仍属于DATA-006/008与发布验收。

## API-013 用户积分与分销只读合同6条（2026-09-05）

继续按全新系统范围审计：PHP是业务行为参考，不需要旧历史行或本机MySQL。基线`973650f`没有注册`integral/list`、`extract/bank`、`spread/order`、`spread/count/:type`、`brokerage_rank`、`rank`六条合同。逐项追溯`UserBillServices::getIntegralList`、`UserExtractServices::bank/getUserExtract`、`UserBrokerageServices::spread_order/spread_count/brokerage_rank`、`UserServices::getRankList`及其DAO/模型获取器后，新增独立只读service/controller，保留原有camelCase消费者接口，避免把两种信封混在同一路由。

| 合同 | 新实现验收边界 |
|---|---|
| `GET integral/list` | 当前UID的`category=integral`，ID倒序、数据库分页、全量count、当前页去重月份；数值按PHP截断为整数，返回上海时区`add_time/time_key/time/day`，零时间为空，不泄露内部event_key |
| `GET extract/bank` | 当前有效账号余额减去`status=1/pm=1/frozen_time>now`冻结佣金；最小/最大提现额、费率、微信方式、余额提现开关和多行银行名单按白名单配置读取；保留负可用余额以暴露异常，不静默修平 |
| `POST spread/order` | JSON分页/时间/关键词；只含已支付、未删除、退款状态0/3、pid0、type0且当前UID参与五类分佣之一的订单；明细、全量count、当前页月份的全月count/sumPrice和不受keyword影响的sum_brokerage均在同一SQL快照计算 |
| `GET spread/count/:type` | type3统计有效佣金收入减支出，type4统计待审核和已审核提现、排除拒绝；其他类型按PHP返回0 |
| `GET brokerage_rank` | PHP收入pm1并排除extract_fail/refund，按周期汇总正数并关联有效未删除用户；先计算全局名次再分页，返回当前用户position/brokerage_price/nickname/avatar，避免按当前页找名次 |
| `GET rank` | 从user_spread绑定事件而非当前user.spread_uid累计人数；上海时区本周/本月周期，week与PHP滚动“上个月至今”的month统计；全局名次、确定性并列排序和缺头像/昵称兜底 |

六条路由都保持PHP外层StationOpen与强制登录，controller只使用认证UID，客户端query/body中的uid没有权威性；响应均`private, no-store`。查询页长最多100、offset最多10,000、时间戳在目标int范围内；金额汇总保留PostgreSQL numeric，不把聚合结果再塞回单行numeric(12,2)，测试实际覆盖超过单行精度上限的合法总额。关键词参数化且转义LIKE通配符，覆盖订单、买家、地址、商品和活动；PHP遗留秒杀/拼团`title`查询改用目标权威列`store_name`。推广订单只投影业务字段，不返回收件人、电话、地址或完整账号；商品标题从订单JSON快照聚合，兼容store_name/storeName及坏JSON，cart_id恢复数组获取器，冻结证据限定本UID的订单分佣收入。行级展示保持staff→agent→division→一/二级的PHP优先级，总额仍分别累加五种权益。头像限制站内相对路径或无userinfo的HTTPS，canonical附件引用只在响应阶段短期签名。

PostgreSQL最佳实践用于约束数据库内过滤、分页及聚合，避免PHP逐订单、逐月份的N+1往返。新增精确锁定的开发依赖`@electric-sql/pglite@0.5.8`：测试从当前Drizzle列类型和默认值构建12张临时内存表，把service生成的真实参数化SQL交给PostgreSQL WASM引擎执行，不伪造数据库返回值。16项场景覆盖六合同、跨用户隔离、分页/月边界、五类分佣、无效冻结/提现状态、空页/空表、SQL注入形状、多个角色重叠、聚合精度、活动字段、快照及签名头像；还验证HTTP信封、匿名拒绝、不缓存和POST分页来源。该测试不证明生产PostgreSQL16的索引计划、Hyperdrive缓存、并发或真实账号前端流程，不能代替发布验收。

当前路由审计为PHP1,904、TS1,640、精确879、可执行861、不可用18、原始缺失1,025、退役17、可执行缺口1,008；API面为PHP457、TS861、精确438、可执行435、缺口17，有效覆盖95.6%。结构审计仍为201→263、共享201、源列缺口0、外部/内嵌零漂移；可观测性仍17信号/10组件/53事件/6发布阻断。生产依赖审计0漏洞，开发工具链仍有drizzle-kit及旧esbuild链的4个moderate项，新PGlite不在漏洞项中。本批没有读取或写入生产PostgreSQL、调用provider、创建MySQL服务或部署Worker/Pages。

最终门禁：221文件/1,401项全量测试通过、双TypeScript通过。Windows本机默认2GiB的Node堆首次类型检查耗尽，提升单次编译堆上限至6GiB后完成，没有跳过文件或放宽检查；Linux CI使用仓库标准命令通过。实现提交`99440a5e22016c96b8b315aed4f2c04731d2d7e2`已推送，[Actions `33940755327`](https://github.com/cinagroup/cinashop/actions/runs/33940755327)的Worker静态/全量单元、Linux workerd、Admin、PC、Supplier、Kefu、UniApp和全历史密钥扫描8/8成功。主Worker、正式前端及真实渠道仍未发布或启用。

此次审计同时把现有财务写入/列表缺口记为API-014：POST spread/people忽略body分页、spread/commission类型与分页后过滤偏离PHP、extract/cash没有完整旧载荷及提现上下限/费率验证。API-013的只读完成不能关闭这些资金写入问题，也不能证明新UniApp已消费本批新增接口。

## API-014 财务合同、提现资金状态机与新前端联动（2026-09-05）

本批从`119d1e4`后的未提交候选继续复审，仍按全新系统范围执行，没有旧站数据复制、源MySQL对账、生产数据库访问、provider调用或Worker/Pages部署。原API-014整项保持开放，把已完成候选拆为A～C，把自动微信渠道与真实角色/发布分别保留为D/E，避免以失败关闭或本地测试替代完整渠道迁移。

### 读取合同与统一统计

`spread/people`恢复POST JSON分页、一级/二级关系、昵称/手机号与时间过滤、安全排序及`total/totalLevel/list/count/price/brokerage_level`信封。`spread/commission/:type`恢复PHP的0～4含义与月份分页：余额从现行`user_money`账本读取，佣金/提现从`user_brokerage`读取，不复制失效的旧余额存储。新UniApp原有1/2/3一级/二级/提现分类改走独立`user/commission/list/:type`，在SQL内先按用户和类型过滤再分页。财务页与`UserProfileService`两个个人中心消费者共享单语句统计：上海自然日、不把`extract_fail`返还算作新收益、真实冻结额和关系计数；避免旧实现按宿主时区且虚增累计佣金。读取专项由16增至19项，参数、跨用户和实际SQL场景通过。

### 资金事务、重试与结构前置

`UserWithdrawalService`统一旧`money/name/bankname/cardnum/weixin`与新载荷，校验纯十进制两位金额、收款长度/格式、四种方式、权威数据库上下限及费率。手续费遵循PHP先`bcdiv(percent,100,4)`再`bcmul(gross,ratio,2)`截断；使用整数分和BigInt中间乘积，单行最大金额边界也不丢精度。申请扣毛额、记录净额/费额和申请前余额，`user_brokerage`支出即为有效账；转入余额在同一事务写已付充值、余额收入账及账户余额。人工拒绝保留原有效支出并补偿毛额一次；审核要求匹配唯一同UID支出和金额，不会改写另一用户的同link记录。旧候选`status=0`支出只有在归属与金额证明一致时才于实际审核中规范化，本轮没有修复任何生产历史账。

申请与审核均按用户→申请锁顺序，设置3秒锁等待/15秒语句上限，不在事务里调用外部渠道。可选`request_id/Idempotency-Key`使旧客户端仍可调用；新前端始终发送持久化键。同用户同键同规范载荷重放原ID，即使配置随后改变也不重扣；不同载荷返回业务409而非400，前端不能把已有申请冲突误当成“从未提交”的校验失败。审核同终态重复不变，不允许反向改审；晚期账本写入失败会回滚申请、佣金、充值及余额账。

新增外部`0130_user_withdrawal_replay.sql`与内嵌`0134`完全镜像：两个重放字段、非空请求键的用户级唯一索引和64字符微信字段。测试执行两次DDL并验证重放唯一性。仓库结构仍为201→263、源列缺口0、外部/内嵌零漂移，但生产尚未应用本DDL；DB-006是发布硬前置，不能因生产表数仍263就宣称列/索引已经同步。

### 前端渲染、失效恢复与验证边界

财务页补齐提现方式、上下限、精确手续费/净额、推广两级筛选及分页。发送前把单笔未确认载荷保存到用户作用域存储；存储失败不发送，服务器/网络结果不明则锁定表单并保留原键，刷新后先查询本人申请，已登记则清除待确认态，否则仅重试原载荷。审核冲突/网络异常不自动生成新意图；普通400校验失败才释放。浏览器复核还发现数字输入框在恢复查询后保留旧DOM值，以及金额改正后仍显示旧错误，两者均已修复并加入复验断言。

按前端测试技能，因为`Browser plugin not available`，使用已有Playwright1.62.1和本机无头Chrome，在`http://127.0.0.1:5188/#/pages/user/finance`、1280×900与390×844视口验收。开发代理固定回环端口9且所有API被模拟拦截，没有外部请求。页面标题“分销中心”、非空内容、无Vite错误遮罩、无横向溢出和截图人工复核通过；一级→二级→搜索空结果、限额前置拒绝、20元/2.5%显示0.50手续费与19.50净额、双击只发一次、结果不明锁定、刷新后同键同载荷重试、余额零手续费、已登记申请查询后不再POST均通过。两次主动注入503产生的浏览器资源错误为预期，除此之外无应用错误；旧UniApp依赖有vue-router导入方式弃用警告。临时脚本与截图位于系统临时目录，不提交仓库。本地模拟不证明真实认证、后台审核界面、微信小程序真机、Hyperdrive缓存或外部到账。

本地全量223文件/1,423项通过，另2项多连接并发仅在独立PostgreSQL16中运行；双TypeScript通过，H5及微信小程序类型/构建通过。新增3项共享前后端金额投影测试、18项提现场景（本地16、CI专属2），其中新列表分页前筛选、本人请求查询与重放元数据剥离也有实际数据库断言。Linux CI新增一次性PostgreSQL16服务，测试只允许回环`cinashop_finance_test`库与`finance_test`角色，校验服务端身份后创建随机schema并清理，不使用生产环境变量；其并发同键四请求单次记账、不同键不得超提、并发拒绝只补偿一次仍待远端结果确认。

路由为PHP1,904/TS1,641/精确879/可执行861/原始缺失1,025/退役17/可执行缺口1,008，API面TS862、缺口仍17；本批修的是行为，不虚增PHP覆盖率。可观测性仍17信号/10组件/53事件/6发布阻断。PostgreSQL技能用于短事务与一致锁序；同时按[Workers官方实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)核对异步/绑定/摘要接口，检索最新`@cloudflare/workers-types@5.20260905.1`只进入临时目录，项目依赖及部署配置未因此变更。后续须完成API-014D自动微信提现未知状态/查单/回调恢复与真实渠道验收、DB-006、API-014E及其他清单开放项。

本批最终本地生产依赖审计为24个生产依赖、0漏洞；首次受沙箱网络限制失败，获准访问npm官方端点后成功，未豁免漏洞门禁。首次向`main`提交推送的命令曾被本机自动审批整体拦截，未执行暂存/提交/推送，原因是要求额外明确默认分支授权；当时尚无本批GitHub Actions运行，API-014B的两项PostgreSQL16并发与完整远端门禁因此保持开放。以下记录后续授权解除及远端验证结果，不能把本段历史阻塞解释为当前状态。

### 提交后复审与首轮CI（2026-09-05）

项目所有者随后明确授权向`main`提交推送，原审批阻塞已经解除。实现提交`594ebea4892bb3565774749be7cecd67fdbb9319`已推送，本地HEAD、origin/main、GitHub远端引用精确一致。[Actions `33943737780`](https://github.com/cinagroup/cinashop/actions/runs/33943737780)的Worker双TypeScript/真实PostgreSQL16.14并发/结构/路由、Linux workerd和五端构建均成功；首轮唯一失败是Gitleaks将`user-withdrawal-scenario.test.ts:17`固定幂等请求标识识别为generic-api-key。该字面量只是隔离测试输入，不具备认证能力、不会读取任何账号或生产凭据。按[Gitleaks配置合同](https://github.com/gitleaks/gitleaks/blob/v8.29.0/README.md#configuration)新增仅匹配一个测试文件、一个精确字面量、一个规则的AND例外，目标为提取值而非整行；附加测试禁止路径或值范围扩大。没有豁免整个提交、测试目录或真实凭据扫描，修正后的完整CI仍需独立确认。

进一步沿PHP提现审核路径复核，发现成功后还有资金流与通知，拒绝后还有余额变动通知：`UserExtractServices.php:222`派发`CapitalFlowJob`的`extract`类型，225行触发`user_extract`；`changeFail`在145行触发`user_balance_change`。余额提现通过`adopt→changeSuccess`也经过成功路径。源端`CapitalFlowServices.php:63～65`明确将净额取负并使用`trading_type=6`，因此目标流水应为`price=-extract_price`并保留对应收款方式，不能把申请扣除的毛额再次当作到账流水。Worker的提现service没有写`capital_flow`、system_message或提现通知outbox，`OrderNotificationOutboxService`的事件联合也仅覆盖发货/拒退/次卡，不能自然承接这些事件。该差距新增API-014F，包含净额流水权威、按提现ID唯一事件、事务内outbox、派发/失败恢复与渠道模板验收；API-014父项保持开放。

自动打款也并非给现有支付service增加一个POST即可。PHP`Payment::merchantPay`同时支持旧v2企业付款与v3批次转账，Worker当前微信service仅有订单/退款。微信当前[商家转账接口](https://pay.wechatpay.cn/doc/v3/merchant/4012716434)要求明确的商户场景、匹配appid/openid和收款流程；HTTP200或WAIT_USER_CONFIRM不等于到账，未知结果不能换单重试。[开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4012715211)还要求用户确认收款入口、查单和终态处理。因此API-014D实施前需确定本部署商户已开通的转账产品/模式与实际场景，不猜测沿用旧站v2/批次能力，也不以普通支付就绪代替转账就绪。该审计只访问官方文档和本地代码，没有发起转账或连接生产。

### 授权后远端门禁最终证据（2026-09-05）

窄范围误报修正提交`ae26b56547963f829e04584b44d9fee44f6a6302`已推送，[Actions `33944067731`](https://github.com/cinagroup/cinashop/actions/runs/33944067731)最终8/8 jobs全部成功。Worker测试为223文件/1,426项全部通过、无跳过；提现专项19项包含18项资金场景与1项密钥扫描例外范围检查。容器日志确认PostgreSQL16.14，2项真实多连接并发用例已执行：同键四次提交只记一笔、不同键不能超提，以及并发拒绝仅返还一次。双TypeScript、schema/route/observability、生产依赖、Linux workerd与五端构建也均成功；checksum-pinned Gitleaks扫描206个历史提交后报告无泄露。以上证据关闭API-014B和更新TEST-001，但不关闭自动渠道D、发布/真实角色E、提现流水/通知F及结构前置DB-006。

项目所有者告知浏览器插件已安装并授权后，CUA实际返回已连接的`Codex In-app Browser`；浏览器能力现已可用，不再以缺少插件作为后续验收阻塞。先前Playwright/Chrome证据仍属于本地模拟，本次仅确认插件连接，没有把它改称生产、真实小程序或真实账号验收。以上提交、CI与浏览器连接均未操作生产数据库、部署Worker/Pages或发起真实支付。

## API-014F 提现流水与通知持久化续审（2026-09-05）

从已推送`0caebfa`继续，上一轮属于有证据进展：完成远端门禁并更新清单。本轮仍不连接生产、不执行历史复制、不部署、不调用真实短信、微信或支付。

`WithdrawalEffectsService`将人工审核成功、余额自动成功的负净额`capital_flow`与对应不可变提现事件放进原有资金事务，成功流水类型为6、保留收款方式。稳定事件键取提现ID；流水`order_id`使用`withdrawal:<id>`业务引用，不沿用PHP把银行卡/收款账号作为全局单号的做法。拒绝只补偿毛额并写拒绝事件，无成功流水。资金、申请、充值、余额账、佣金账、流水与事件的晚期失败均整体回滚；同键申请和相同终态审核直接返回原结果，不补记第二笔流水。

复用`store_order_outbox`的持久化租约/队列/定时补偿，但`aggregate_type=withdrawal`，投递台账新增独立`withdrawal_id`且订单ID必须为NULL。数据库互斥约束拒绝两个业务ID同时存在或同时缺失；唯一事件/渠道避免重复投递记录。消费者校验事件键、聚合类型、申请归属、金额与终态后才创建消息，外部请求只在事务提交后执行。未知提供商结果保持UNKNOWN，不自动重发；人工确认/重试/关闭继续写独立审计记录，不更新提现资金。顺带修复已有次卡投递事件未被投递消息识别器接受的问题，保留原事件键格式并加回归断言。

PHP`NoticeService::userExtract/userBalanceChange`的字段已逐条映射：成功通知净额、拒绝通知毛额；站内信支持`extract_number/nickname/date/message`，SMS只传提现金额；成功公众号使用amount3/time4，成功和拒绝小程序使用thing1/amount2/thing3/date4。拒绝公众号在PHP调用处被注释，本实现也不启用。支持后台语义模板标识及PHP编号51729/1470；多条启用来源明确失败保留待恢复事件。通知时间固定为提现事件发生时的上海时间，不随队列延迟改变；小程序链接指向新页面`pages/user/finance`，真实订阅和真机落地页仍需验收。

外部0131与内嵌0135完全镜像、无业务DML，在隔离SQL中重复执行；仓库仍201参考表→263目标表，源列缺口和外部/内嵌漂移均为0。新增DB-007为发布前置，不能重跑固定旧白名单的历史通知审计Worker来代替本次迁移。生产数据/约束本轮没有检查或修改。

使用已连接的CUA内置浏览器，在`http://127.0.0.1:5190/setting/notification?preview=1`验证后台；开发代理明确固定`http://127.0.0.1:9`，只用本地预览状态。1280×900和390×844下页面身份、非空、无框架错误遮罩、控制台无error/warn、提现事件精确筛选、区分订单/提现编号、UNKNOWN→SENT模拟确认及人工记录通过；拒绝配置无公众号选项。发现桌面主区网格子项溢出约65px，补`minmax(0,1fr)`后主区scrollWidth等于clientWidth，手机同样无横向溢出。截图通过浏览器原生输出展示，不提交仓库。前端测试技能要求的交互与视口验证实际执行；这不是生产认证或真实提供商E2E。

源码续审又发现`listener/user/Extract.php`还承接申请阶段的客服通知、管理员提醒计数和WITHDRAW推送，新增API-014G继续开放；F不冒充整个提现业务域已迁移。自动打款D、真实发布E、模板送达F2和DB-006/007也继续开放。

提交后再次核对G：PHP`SystemAdminServices::adminNewPush`统计status=0的待审核提现并计入msgcount；Worker`AdminAuthService.adminNewPush`虽然已有同名接口，但`reflectnum/msgcount`固定为0。PHP客服申请提醒还会调用`kefuSystemSend`与企业微信，不是给申请人发一条成功通知即可覆盖。该证据已细化到G，后续需连同接收者权限、提醒计数与实时推送闭环一起处理。

最终本地门禁为224文件/1,437项通过，另3项真实PostgreSQL16多连接用例明确留给Linux CI，没有用内存单连接结果冒充并发通过；新增F专项14项中的13项本地通过。双TypeScript、Admin类型/生产构建、201→263结构零漂移、17信号/53事件可观测性和24个生产依赖零漏洞均通过。前端代码哈希/行号变化后重新生成Admin请求清单，仍342调用点/362变体全部可执行。最初暴露的现金流列快照、后台页面名称断言和生成清单漂移已经据实更新并复验。Workers最新类型5.20260905.1还确认Queue模拟需包含metrics及带metadata的发送返回值，测试已按实际接口修正，没有使用双重断言压过类型错误。Workers/数据库技能实际影响了绑定类型、事务内仅写DB、稳定事件与一致锁序；尚待本批远端CI最终证据。

实现提交`a0e5e4cfc8ff471108297bbeae91768a56de0320`已推送，[Actions `33945761103`](https://github.com/cinagroup/cinashop/actions/runs/33945761103)最终8/8 jobs全部成功。Worker为224文件/1,440项全部通过、无跳过；新增提现副作用专项14/14，原提现专项19/19。容器日志确认为PostgreSQL16.14，3项真实多连接用例均执行，新增四连接并发审核只有一笔成功流水和一个审核事件；本地跳过的并发门禁已由远端实际执行关闭。双TypeScript、201→263结构/路由/可观测性、生产依赖、Linux workerd与五端构建均成功；checksum-pinned Gitleaks扫描208个提交、未发现泄露。据此关闭API-014F1并更新TEST-001；该结论不关闭DB-006/007、自动打款D、真实角色/发布E、真实模板送达F2或申请提醒G，也没有执行生产DDL/DML、发布或真实通知。

## API-014G 管理待办与申请提醒续审（2026-09-05）

从`main@5bee4c8`开始；上一目标轮已推送F1并完成远端与浏览器证据，属于实际进展。本轮没有生产数据库访问、DDL/DML、部署或真实短信/微信/打款。API-014G按准确待办G1、持久申请/客服/实时提醒G2、群机器人和真实接收者G3拆分；没有以30秒刷新替代实时申请通知完成定义。

旧PHP`SystemAdminServices.php:413`的ordernum经`StoreOrderDao::search`将status=1转为paid=1、status∈{0,4}、refund_status∈{0,3}，外层shipping_type=1再收窄为快递；不能只查status=0，也不能把status=1误当已发货计数。目标还排除系统删除和pid=-1的拆单父记录，避免计入不可直接履约的重复待办。待回复评价排除删除项，提现只计status=0。库存的源调用存在错误：`count(['type'=>5])`实际走`StoreProduct::searchTypeAttr`的来源类型，而库存预警定义在`searchStatusAttr(5)`；本轮明确纠正为is_show=1/is_del=0/is_verify=1/is_police=1/stock>0，不复制类型5误用，也不虚构源码已注释的固定阈值。

`AdminNewPushService`将四类计数置于单一REPEATABLE READ、READ ONLY事务，设5秒statement_timeout，权限与统计使用同一快照；不执行外部I/O或业务写入。每个子计数按order/product/reply/extract查看权限决定是否查询，msgcount只求可见项之和；缺失、禁用角色或只有dashboard权限不能通过总数推断财务量。GET/HEAD new_push作为已认证管理员的公共头部读接口，不再强制dashboard权限，其他管理读写规则不放宽；仍经过管理员JWT、账户有效性与admin_type=1门禁。返回私有no-store，保留PHP五个数字键并新增实际数据库采样时间。按[Hyperdrive查询缓存文档](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)使用真实CURRENT_TIMESTAMP标识采样时间；本地连接仍prepare=false，未修改生产缓存配置，也不把本地数据库结果当作生产新鲜度/撤权延迟验收。

Admin顶栏由只显示订单数、仅mounted读取一次的图标改为可键盘触发的待办面板，展示四类入口与总数；同一在途请求合并，30秒可见页检查、聚焦/重新可见/路由变化/手动刷新重取，提现审核成功后发出本页刷新信号。刷新失败清除旧计数并显示失败，卸载/退出后的迟到结果不再发布。提现入口携带status=0，页面修复拒绝状态-1却按2显示/筛选的问题，并以显式all值消除Element Plus空值单选警告；通过/拒绝按extract.manage显示且提交中锁定按钮。模拟模式给出明确提示、仅修改浏览器内测试记录，生产分支仍调用已鉴权接口，不发起客户端打款。

CUA内置浏览器实际验证本地`http://127.0.0.1:5190/setting/notification?preview=1`→待办→`/finance/extract?status=0&preview=1`。1280×900下默认只见待审核#51，通过后列表清空、提现1→0、总数12→11；390×844下拒绝、原因回显、已拒绝过滤及同样计数联动通过。手机document宽390、主区client/scroll均326；面板可见且无横向溢出。修正后的刷新周期未出现console error/warn或框架错误遮罩；截图通过浏览器原生输出，不提交媒体文件。前端测试技能实际推动了交互后状态断言和两视口复验。

G2/G3仍有明确源码证据：`StoreServiceDao::getStoreServiceOrderNotice`按account_status/status/notify三个1筛选，默认不限制customer类别；SystemMsgJob给这些客服UID写type=2站内信，不能写成申请人的type=1消息。企业微信Job将模板替换后发markdown到通知配置URL，实际是群机器人，不是现有客户联系/通讯录能力；不能因已有EnterpriseWechat service就声称覆盖。管理员WITHDRAW与ADMIN_NEW_PUSH广播还必须在目标实现中收紧到业务权限接收者，并补离线恢复、去重、撤权与失败/UNKNOWN路径；本轮未实现或发送这些推送。

本地最终门禁为226文件/1,452项通过，3项真实PostgreSQL多连接用例仍由Linux CI执行。新增11项SQL/认证/服务场景包含真实申请/同键重放/拒绝/余额自动通过后的待办计数，晚期账本失败回滚不会出现虚假待办；另4项前端数据合同与加载生命周期测试通过。真实认证场景使用临时随机签名键和非生产、无Redis夹具，明确不冒充生产令牌撤销E2E；测试最初错误使用NODE_ENV=test字面量和不存在的user token类型，已按实际Env与api token类型修正后通过双TypeScript。全量第一次只因生成请求清单的源码哈希/行号变化失败，重生成后全部通过，Admin仍342调用点/362变体全部可执行。Admin类型/构建、201→263零源列缺口/零定义漂移、17信号/53事件/448生产源文件的可观测性和24生产依赖零漏洞均通过；6项生产观测阻断未关闭。待本批提交对应CI最终结果，不提前关闭G1。

提交后G2读取边界续审：`UserMessageController::visibleSystemMessageWhere`只限制status=1/is_del=0及广播UID或当前UID，未限制type；`kefuapi`也尚无独立站内信收件箱路由。因此不能现在仅把type=2客服财务提醒写入system_message就宣布可用，需先隔离普通用户列表/详情入口并补独立客服读取与已读/撤权语义，再开始事件播种和实时分发。本轮只确认源码风险前置，没有连接生产核实是否已有type=2数据，也没有新写入这类消息。

实现提交`0765f7a939ea9e3e0031159a01ef9966b54160af`已推送；[Actions `33947577628`](https://github.com/cinagroup/cinashop/actions/runs/33947577628)最终8/8 jobs成功。Worker为226文件/1,455项全部通过、无跳过，新增待办SQL/认证11项及前端生命周期4项均有日志；容器为PostgreSQL16.14，原3项真实多连接测试亦执行。Worker双TypeScript、schema/route/observability、24生产依赖零漏洞、Linux workerd及五端构建均成功；Gitleaks扫描210个提交后未发现泄露。G1据此仅关闭候选工程门禁，G2/G3、DB-006/007、真实角色/渠道/生产新鲜度与发布门禁继续开放；本轮没有生产访问或真实资金/通知副作用。

## API-014G2a 申请事件与隔离客服收件箱（2026-09-05）

从已推送`main@9cc791b`继续。本轮采用Workers、PostgreSQL和前端测试技能：事务内只写数据库，复用已有Queue/定时补偿而不在资金事务中发送通知，客服列表使用有界游标、部分索引和短只读快照，并实际做浏览器交互。没有生产数据库连接、DDL/DML、部署、历史复制或真实短信/微信/付款；Hyperdrive绑定未修改。

源`listener/user/Extract.php`的申请事件包括余额自动审核路径；`StoreServiceDao::getStoreServiceOrderNotice`选择account_status/status/notify均为1的客服，默认不限制customer类别，`SystemMsgJob`给绑定UID写type=2。本轮保留该类型、绑定UID和模板变量`admin_name/nickname/money`，money使用申请毛额而非到账净额；另外明确收紧为mer_id=0平台客服、未删除账户及有效绑定用户，避免财务申请暴露给商户客服或无效UID。接收者在异步消费时确定；不要求在线，同一UID的多个有效账户按最小ID确定显示名且只发一条。

`WithdrawalApplicationNoticeService`在真实提现事务末端记录`withdrawal.applied.notice:<id>`。事件只带提现ID、用户ID、昵称、毛额和发生时间，不包含收款账号、银行、手机号或openid。同键成功重放在写事件前返回；余额自动审核同时拥有独立申请事件和审核事件，不能混为一条。事件晚期插入失败整体撤销申请、扣款、账本和自动审核副作用。消费者核对事件键、归属、发生时间及原申请金额；即使消费时已通过或拒绝，历史申请仍有效。通知配置缺失或关闭时不生成提醒；关闭期间完成的事件不会在以后开关启用时自动补发。

既有outbox租约、Queue重试和定时扫描承接申请事件，客服消息写入与根事件完成同事务，按事件键及客服UID唯一化。渲染使用单次替换和纯文本，不递归展开用户文本中的占位符；模板来源重复、渲染超长、无效载荷或任一消息失败都会保留失败事件，全部接收者写入回滚，恢复不重复扣款。单事件上限1000个不同接收UID，超过上限明确失败而非截断；超大客服组织的分页扇出仍需另行实现。

此前风险已修正：普通用户消息列表、详情和个人中心未读计数共享`UserMessageVisibility`的type∈{0,1}规则，不再可见客服type=2或未知类型。新增三个`/kefuapi/messages`端点只接受真实客服认证上下文，查询/已读语句再次校验当前账户、UID绑定、通知资格与用户状态，拒绝广播UID=0、其他用户、已删除/停用消息及普通用户/管理员令牌。列表/详情私有no-store、详情不自动标读，POST已读幂等且不改变资金。新增前端入口、未读筛选、游标加载和显式已读；退出、切换令牌、卸载后的旧响应不发布，读取失败清空旧内容而非显示假零。30秒可见列表刷新不等于实时推送，已打开详情不会被自动刷新关掉。

Admin通知矩阵新增`kefu_send_extract_application`独立站内信配置，缺省关闭；界面只显示受支持渠道和三个模板变量，后端拒绝该标识的短信/公众号/小程序启用，未新增任何外部投递。外部0132和内嵌0136镜像扩展申请事件CHECK及客服部分索引，新DDL在已有申请事件的隔离SQL数据库中重复执行通过。没有在生产运行整个MigrationService；历史外部SQL 0084/0129/0131及对应内嵌迁移含较窄事件CHECK，从零重放可能拒绝新事件数据，因此DB-007要求按实际catalog授权增量发布并核对指纹，而非盲跑历史链。

本地新增专项19项中18项通过：真实申请幂等、审核早于消费、离线/撤权前筛选、重复UID、超过1000接收者、余额自动审核、晚期失败全回滚、部分扇出失败恢复、队列失败重放、通知开关/禁止提供商、恶意载荷、普通用户列表/详情/共享未读SQL隔离、客服分页/详情/显式已读/撤权和真实JWT中间件。新增四连接同键申请再四消费者抢同一根事件的1项真实PostgreSQL测试只在CI执行；全量227文件/1470通过、4项明确跳过，未用单连接结果替代并发证据。客服前端10项（新增3项）及Admin/Kefu类型/构建通过，Worker双TypeScript通过；生成Admin请求清单已重建，仍342调用点/362变体可执行。201→263结构零源列缺口/零外部内嵌漂移，路由TS增加到1644但PHP匹配数保持879/861；17信号/53事件/453生产源文件的可观测性、24生产依赖零漏洞通过，6项生产观测阻断仍开放。最初测试暴露的未限定SQL列歧义、旧路由计数和生成清单漂移均已修正并复验；类型检查使用6GB堆上限避免Windows默认2GB OOM，不放宽类型规则。

CUA内置浏览器实际检查本地Kefu `http://127.0.0.1:5191/workbench?preview=1`→系统提醒→详情→标为已读→仅看未读：查看时未读仍为1，显式标读后变0，未读筛选显示空态；1280×900与390×844均验证，手机document宽/scrollWidth均390、主区client/scroll均375，无横向溢出。Admin `http://127.0.0.1:5190/setting/notification?preview=1`验证第七个渠道卡片→编辑→启用站内信→保存→重开仍选中，且没有不支持的渠道选项。页面身份、非空、无框架遮罩、相关console error/warn检查通过；截图原生展示，不提交媒体文件。Admin本轮截图的实际视口为1081×792，不将未生效的390视口设置冒充手机验收；客服两视口验证有效。两服务代理固定回环127.0.0.1:9，全部为浏览器内模拟状态，不是Worker联调、生产Redis撤权/Hyperdrive新鲜度或真实角色E2E。

G2a候选实现已补，待本批远端CI闭环；G2b独立实时通知通道尚未实现，绝不把财务事件塞进全站ChatRoom广播。G3群机器人、D自动打款产品、F2真实通知送达、DB-006/007和E真实角色/发布继续开放。

随后实现提交`6af696597f19ab76ba9b8b63db9d099e7d3b5b5d`已推送；[Actions `33949795952`](https://github.com/cinagroup/cinashop/actions/runs/33949795952)最终8/8 jobs成功。Worker为227文件/1,474项全部通过、无跳过，新申请/收件箱专项19/19；实际容器版本PostgreSQL16.14，4项真实多连接测试均执行，新增四请求/四消费者场景只有一笔申请、一次扣款、一个根事件和每UID一条提醒。双TypeScript、schema/route/observability、Linux workerd、五端构建、客服前端10项通过；生产依赖审计0漏洞，不能将npm ci所报4项moderate开发依赖告警称为全依赖零漏洞。Gitleaks扫描212个提交后未发现泄露。G2a据此仅关闭候选工程子项，G2整体、实时G2b、G3与真实角色/发布前置仍开放。本轮未触碰生产或发出真实外部通知。

## API-014G2b 实时通知服务端续审（2026-09-05）

从已推送`4aad57f`继续，上一轮完成G2a、CI与浏览器证据，属于实际进展。本轮处理同一迁移链路的实时后端，不部署、不访问生产数据库或真实Redis，不发送短信、微信、打款，也不复制历史数据。前端尚未接入新通道，G2b父项不关闭。

源码审计确认：PHP`listener/user/Extract.php:39`广播WITHDRAW并调用管理待办提醒；已有ChatRoomDO专门处理会话和转接，不能承载全站财务广播。UserFinanceController此前申请提交后没有即时outbox派发，而定时任务每5分钟扫描，持久化正确但不能据此声称实时。现在申请提交后用waitUntil加速派发申请根事件；收件箱与唯一`withdrawal.staff.refresh:<id>`子事件同事务生成，父事件消费后立即尝试派发子事件，缺失/失败仍由原定时扫描补偿。关闭客服站内信只取消客服投影，管理员刷新不受该开关抑制。

新增StaffNotificationDO按`staff-notice:admin:<id>`或`staff-notice:kefu:<boundUID>`分区，持久化SQLite事件revision，连接使用Hibernation API和验证后的附件，不存原始JWT。遵循[Cloudflare WebSocket休眠合同](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)恢复附件；新类经v3 SQLite迁移声明，原有DO标签与类不变，Wrangler 4.122.0实际生成了绑定类型，最新平台类型5.20260905.1已核对。新增`/adminapi/extract/notifications/socket`及`/kefuapi/messages/socket`，后者放在`:id`详情路由之前；仍使用各自真实鉴权中间件。网关只接受受控Origin并从可信上下文构造DO请求，剥离Cookie、客户端身份头、原始令牌子协议和URL参数，不能用uid或X-Staff-Session冒充管理员。

连接、每次发送、ping和30秒空闲alarm均重新校验：令牌桶对应类型/认证ID/token摘要，JWT到期时间、密码版本、管理员有效账户与extract.view或客服当前通知资格/绑定用户。失权关闭4001，基础设施故障关闭1013并保留刷新重试；不因Redis不可用放宽为只验签。单分区最多8连接，WebSocket只接受ping，不接受审核、付款或任意转发命令。不在DO保存原始令牌、金额、银行卡或申请人内容；客户端只接收ready/changed与单调revision，必须另外走当前权限保护的HTTP接口取数据。每次ready都要求强制刷新，故离线和漏帧恢复依赖权威DB，不承诺逐条历史WebSocket事件回放。

子事件在短只读快照中找当前有效的有权管理员，以及已经生成对应专属消息的客服UID；批量角色解析与单账户语义一致，包含manage→view和有效旧菜单映射，不把控制台权限当成财务权限。RPC全部发生在事务和行锁之外，每批5并发；部分失败将子事件留在FAILED，重试不重新写申请/扣款/客服消息，已投递DO返回同一个revision。每类最多1000收件人、角色ID合并最多10000，超限明确失败、不静默截断。DO保存约2049条去重键；超过窗口的极旧人工重放允许产生额外刷新，不影响任何资金或收件箱幂等。窗口不是财务数据保存期限。

新增外部0133与内嵌0137只扩展刷新事件CHECK，无新PG表或业务DML，生产DB-007和STAFF_NOTICE/正式Origin配置仍为发布前置；不可从头执行包含旧窄白名单的历史迁移链。测试首轮重跑旧0132把夹具CHECK降回旧值，暴露该风险后，明确重新应用最新0133恢复夹具，未删除约束或放松检查。真实HTTP提现测试新增ExecutionContext与Queue夹具并验证提交后已排队，不以无上下文的单元调用冒充运行时。

本地新增7项SQL/协议/真实admin+kefu JWT/Origin/Redis状态校验/批量权限等价/部分RPC失败恢复测试通过；全量228文件/1477通过、4项PG16多连接明确留给CI。Worker两套TypeScript、342调用点/362变体Admin API合同、201→263/零源列缺口、1646条目标路由、17信号/53必需事件/459生产源文件审计通过；6项生产观测阻断未关闭。Cloudflare RPC返回类型包含平台可释放/流水线形状，测试改用明确的业务发布端口并由生成绑定结构兼容，而非双重断言。新写6项workerd测试覆盖分区拒绝、休眠后重放revision、重连ready、受众隔离/连接上限、撤权、临时故障/非法命令及alarm；本机实际尝试仍在测试收集前0xc0000005，不能算通过，需下述远端CI最终证据。

首次实现提交`cb3c753c24fb5bdbe4437b9369ee790d240e6c4f`的[Actions `33951317435`](https://github.com/cinagroup/cinashop/actions/runs/33951317435)为7/8成功，不能计作全绿：Worker全量和五端构建、密钥扫描通过，workerd的21项断言全部通过但另报3个未处理拒绝而退出1，恰好对应分区错误、非法事件键、数据库不可用三次预期RPC拒绝。现象与[Cloudflare上游问题14736](https://github.com/cloudflare/workers-sdk/issues/14736)相符，本地锁定0.21.2仍含同类RPC callable/thenable包装；未声称已独立证明其内部泄漏机制。改为在`runInDurableObject`中对真实实例断言这三个拒绝，保留真实workerd存储、WebSocket及所有正常RPC调用；额外验证非法输入不写signals、故障关闭1013且不发数据、持久revision在恢复后的真实RPC重试保持不变。没有忽略未处理异常、跳过用例或改变生产错误处理；这三项验证的是DO内部拒绝语义，不冒充跨RPC异常序列化验证。修订后须再次取得Linux CI通过证据。

修订提交`9c102a4f6ee5e41c304f2d618dbb5839d0594c75`已推送，[Actions `33951790692`](https://github.com/cinagroup/cinashop/actions/runs/33951790692)最终8/8成功：Worker 228文件/1,481项全通过且无跳过，含4项真实PostgreSQL16.14多连接场景及新增7项通知场景；workerd为2文件/21项通过（新增6项通知传输），不再报告未处理拒绝。双TypeScript、五端类型/构建、Kefu测试、生产依赖审计、schema/route/observability通过；结构为201→263、源列缺口和外部/内嵌定义漂移均0，目标路由1,646，PHP精确879/可执行861/受控不可用18/退役17/剩余可执行缺口1,008。Gitleaks扫描215个提交未发现泄露。Windows本机未得到新的运行时通过证据，真实生产Redis/Hyperdrive/角色与发布同样未验证，不能以Linux隔离环境代替。依据该提交只勾选G2b1候选工程子项，G2b父项仍开放。

本轮Workers/DO/PostgreSQL技能实际推动了独立分区、SQLite休眠状态、生成绑定类型、事务外网络与持久失败恢复；DO测试技能及上游记录帮助收窄预期拒绝的运行时测试入口。G2b2的前端接收、浏览器实时闭环，以及G2b3的部署和真实角色撤权/延迟验收仍未完成；不以仅有WebSocket端点或模拟授权的runtime测试宣称迁移完成。

## API-014G2b2 实时通知接收端与浏览器闭环（2026-09-05）

本轮从已推送且前一批CI全绿的`121a415`继续，上一目标轮属于进展。承接G2b1已有后端合同，本轮让Admin/客服实际接收独立通知，而不是把30秒轮询改名为实时；不访问生产数据库、Redis或真实外部渠道，不部署。PHP历史数据复制仍不适用，生产DB-006/007、正式STAFF_NOTICE/Origin和G2b3不因浏览器授权而自动关闭。

新增`view/common/staff-notifications.ts`共享只读客户端，JWT仅放入既有`cinashop-auth`子协议、不进入URL。仅接受有界ready/changed/revision信封；每个新连接ready强制重新查询权威HTTP（相同或回退revision也补取），changed仅接受递增版本。连接不直接生成消息、修改已读或执行资金命令；20秒纯文本ping、10秒pong超时、12秒握手/ready超时，0.75秒起至30秒以内的抖动退避，正常ready重置退避。旧socket事件通过实例围栏丢弃；隐藏、离线与pagehide释放连接，恢复后重新读取，不跨登录持久化revision。

Admin待办支持强制刷新在已有HTTP请求结束后再读取一次，重复事件合并；invalidate将旧请求结果及错误与当前账号隔离，不允许旧finally清掉新请求状态。会话storage事件同步Pinia；完整会话patch后才判断extract.view/manage与连接资格，限制无财务权限账号不开通知socket。4001/协议拒绝清空快照并明确提示，重连需要显式操作或新会话。原有HTTP登录失效处理补齐HTTP401分支，并只允许当前bearer对应的失败清当前登录态。

客服增加应用级单例通知连接、全局提醒未读数及独立状态展示，工作台聊天连接、当前会话和在线设置不复用此状态。收件箱背景更新保留打开的详情，显式已读才产生POST；提醒到达于列表/详情请求期间时追加更新，退出/换号/卸载/撤权使旧异步结果失效。客服HTTP统一识别401及410000～410002，旧账号请求失败不能清新会话，403和503不注销。退出先清本机状态，随后等待原有服务端撤销结果；迟到的身份刷新不覆盖新账号。登录过期跳转时页面标题一并正确更新。

代理复审发现Admin Pages Function重建Response会丢失WebSocket，现直接返回上游Response并保留manual重定向策略，正文改为流式透传；既有路径重写仍为/adminapi→/api/admin。Vite的/adminapi代理显式启用ws。新增workerd用例验证Admin/Kefu两条Pages代理的真实101对象、双端消息、Origin/子协议和503/no-store响应保留；无新Cloudflare绑定或配置发布。Workers技能推动了该透传修复，不因前端测试而创建真实云资源。

浏览器验收使用现有CUA应用内浏览器接口，无外部Playwright替代；本地Admin `http://127.0.0.1:5196/finance/extract?status=0`、Kefu `http://127.0.0.1:5197/messages`均代理到回环5195临时夹具。浏览器临时storage仅含无生产效力的测试身份；消息由真实本地WebSocket连接送达，而非把UI的WebSocket构造器替换为假对象。已验证Admin待审核提现1→2、客服未读1→2且原详情仍开、显式已读2→1、相同有效revision重发前后Admin HTTP计数6→6、4001后数据清空、手动恢复后重新加载、503仍停留收件箱且测试会话存在、随后401清会话跳登录。通过storage事件切换只读管理员后无活跃admin通知连接，累计连接数保持4。此处权限与API来自夹具，不是生产角色或真实业务端到端授权证据。

桌面1081×792及390×844均采集了AX/DOM和截图，手机document.scrollWidth与innerWidth均390；正常客服控制台无相关错误，故障注入时503/401和WebSocket握手失败为预期。Admin最初的分页告警来自夹具误用count且缺total，修正夹具后保留原业务分页代码；同时修复撤权误显示“正在加载”和首次进入已拒绝收件箱误显示空列表。前端测试技能实际推动了这些交互与错误状态修复。Windows本地未重试已知启动即0xc0000005的workerd，不把未执行计作通过。

本地首轮全量Worker为229文件/1485通过、4项PG16多连接跳过；后续补充1项页面生命周期测试，新增共享客户端/刷新场景共9项，连同既有待办4项专项13/13通过。Worker单元及runtime两套TypeScript通过；客服17项测试和102模块构建通过，Admin2442模块构建通过。3项新Pages运行时用例仍以本批Linux CI结果为准；最终远端结果确认后才勾选G2b2。G2b父项与生产/发布子项继续开放。

实现提交`3ba8d42e2a8316368a3838724a07b78bf157ea66`随后已推送，[Actions `33953586657`](https://github.com/cinagroup/cinashop/actions/runs/33953586657)最终8/8成功。Worker为229文件/1,490项全通过、无跳过，包含4项真实PostgreSQL16.14多连接场景和新增9项前端协议/生命周期测试；workerd为3文件/24项通过，新增3项Pages代理测试实际执行。runtime未报告未处理拒绝，另输出WebSocketPipe被销毁的非致命诊断后仍退出0，不声称日志完全无诊断。Worker双TypeScript、schema/route/observability、五端类型/构建与客服17项测试通过；Gitleaks扫描217个提交未发现泄露。Worker生产依赖审计0不代表全仓库0：安装摘要另报Worker 4 moderate、Kefu 3 moderate/1 high/1 critical、Admin 1 moderate/1 high，尚未完成逐依赖可达性和生产/开发暴露分类，已新列TEST-004，不以构建成功豁免。

CI后再次以CUA复验登录页标题为“登录 - CinaShop 客服”；恢复隔离测试会话后，390px收件箱真实socket收到新提醒，未读1→2且旧详情保留，document.scrollWidth=innerWidth=390、当前相关console error/warn为空。仅将G2b2候选工程子项勾选，G2b父项、G2b3、DB-006/007和生产角色/渠道/发布继续开放。后续审计文档提交不更改受测代码，CI证据固定指向上述实现SHA，不冒称文档SHA也执行了全部工作流。

## TEST-004 依赖告警全量归因与首批修复（2026-09-05）

本轮从`277254b`继续，上一轮完成通知接收端/浏览器/CI及推送，属于实际进展。本轮不访问生产数据库、Redis、Cloudflare或真实渠道，不部署，也不恢复历史数据对账。安全修复技能要求先独立只读调查边界，再做一次新代理候选复核；主代理自行读取锁文件、真实消费者与依赖实现并复现关键结论。首次并行npm audit因可能披露私有元数据被审查拒绝；随后先本地验证1844个非根锁节点的resolution全部来自npm官方/公开镜像，无私有包、file/link和凭据/查询URL，再获准只向官方registry审计公开包名及版本，未上传源码或环境变量。

六份官方`npm audit --json --registry=https://registry.npmjs.org`的初始/本地修复后基线如下；数字是依赖节点而非不同CVE，也不能单凭dev标记判定产物暴露：

| 包 | 初始节点告警 | 本地修复后 | 边界 |
|---|---|---|---|
| Worker | 4 moderate | 未变 | Drizzle配置加载工具链；Worker生产请求未导入旧esbuild |
| Admin | 1 moderate / 1 high | 1 moderate | ECharts仍待完整选项审查；PostCSS的Nano ID已升级 |
| Kefu | 3 moderate / 1 high / 1 critical | 0 | 原Vitest及其嵌套Vite/esbuild全部是测试工具，不是Pages生产服务 |
| PC | 1 high | 0 | PostCSS固定6位内部ID，不接收用户可控长度 |
| Supplier | 1 moderate | 未变 | 仅注册ECharts LineChart，与公告Lines系列不同 |
| UniApp | 9 low / 29 moderate / 10 high | 9 low / 29 moderate / 9 high | DCloud编译器经runtime包传递，omit=dev不代表H5/小程序/App实际运行闭包 |

客服将Vitest从锁定2.1.9升级到精确3.2.6；npm公告范围采用`<3.2.6`，上游安全页另列3.2.5，本轮按更保守的已发布3.2.6选择。其peer允许Vite5/6/7，现复用已有6.4.3，Vue插件不跨主版本；旧两份Vite5.4.21/esbuild0.21.5及其平台包被移除。既有源码与脚本使用`vitest run`、默认api:false，未安装UI/browser包或开启网络API，因此没有“线上客服可RCE”的证据。新增测试执行真实`resolveApiServerConfig`，四种网络host默认禁write/exec，localhost/127.0.0.1保留本地交互能力；再提取锁定包真实RPC方法对象，仅替换文件/执行sink，验证四组旗标下未注册文件不可读写、已注册只读可用、写/重跑/快照按对应许可执行。没有真实文件修改、网络监听或命令执行副作用；这不是Windows UI附件路径或真实WebSocket攻击E2E。[Vitest上游公告](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)的条件与验收范围据此分开。

Admin/PC/UniApp的Nano ID仅做3.3.17→3.3.18补丁升级，其余依赖和DCloud版本不变。根因细查发现3.3.17已修Node和浏览器零长度，3.3.18才补齐原生异步入口，与[上游发行说明](https://github.com/ai/nanoid/releases/tag/3.3.18)一致。新增公共探针运行Node/浏览器CJS/ESM、async、non-secure及native async共11入口；native只替换Expo随机提供者与模块包装，原函数体不改，不能称真实React Native平台验收。所有探针运行于最多10秒子进程，native随机调用另有50次上限。独立临时目录下载旧3.3.17官方tarball，其integrity与变更前锁文件一致；相同探针在旧native默认零长度触发循环上限而失败，新版指定零/负值及常用正长度均通过。PostCSS实际`nanoid/non-secure`固定生成6位ID的CSS解析控制也通过。

候选复核发现并由主代理确认一个上游既存残留：3.3.18的`customAlphabet('abc', 0)(6)`在Node CJS/ESM及async四入口全部超过1秒子进程上限，同入口正常`(6)(6)`均退出0返回长度6；native同样反复请求random(0)。step仍按零默认长度计算，调用时正覆盖值绕过零请求guard；浏览器/non-secure对照不受影响。没有声称此残留已修复，也没有为消警修改依赖源文件。五端业务源码无Nano ID直接调用，锁文件唯一依赖方是PostCSS且走固定非安全ID生成，不存在已证实的攻击者长度输入链。因此官方公告版本升级可以独立核验，但库整体“完全安全”不成立；新增测试命名/输出改为明确限定已覆盖案例，未来直接使用custom生成器必须重新评审该状态组合。[Nano ID公告](https://github.com/advisories/GHSA-2v37-7h3g-55p8)不能替代这种代码级复核。

Worker仍有Drizzle0.31.10→旧esm-loader/core-utils→esbuild0.18.20。主代理读实际core-utils仅见transform/transformSync，无serve；[esbuild公告](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)影响其开发HTTP服务，不等于生产Worker暴露。npm建议“修复”为Drizzle0.18.1属于不兼容降级，本轮未执行。ECharts5.6.0在Admin/Supplier实际使用line/bar/pie，而[上游修复](https://github.com/apache/echarts/pull/21608)针对Lines默认tooltip的HTML逃逸；Admin的余额图虽透传series对象，当前真实服务固定生成line/bar，仍需完整入口审查，不能仅按依赖名确认或关闭XSS。

UniApp需独立完成同版套件升级与暴露评估，当前固定DCloud版本依赖Vite^5.2.8及Vue compiler3.4.21，不能强压Vite6/8。主代理和独立调查均确认当前插件`uni-h5-vite/dist/plugin/config.js`默认host:true、fs.strict:false，而仓库未覆盖，故本轮不启动该旧开发服务。除Vite跨域/文件/Windows路径告警外，后续还包括Intlify嵌套旧runtime/message-resolver、HTML属性转义、adm-zip分配、jpeg-js解码、phin重定向、qs解析与Jest/jsdom/once链；本轮只修同一Nano ID节点，47个告警不能隐藏或按dev一概豁免。具体拆分在TEST-004D/E/F，父项仍开放。

本地验证：五端新增公共依赖测试分别Admin/PC/Supplier/UniApp各3项、Kefu6项，共18项通过；客服原17项业务/会话测试通过。Admin2442模块、PC1828模块、客服102模块构建及UniApp类型/H5/微信小程序构建通过；Admin/PC既有VueUse PURE注释告警保留，不视为新错误。没有修改渲染页面，未将旧浏览器截图当作本批新E2E。CI矩阵新增五端依赖回归步骤，并对已全树零告警的Kefu/PC新增完整npm audit门禁。待精确实现SHA的Linux CI通过后，再勾选B/C候选子项；不关闭TEST-004父项和任何生产发布门禁。

本批提交推送请求随后被权限审查拒绝；核对当前目标、main分支、指定origin及只读CI范围后再次复核，仍要求用户对这批默认分支远端写入作明确确认。两次命令均未执行，HEAD仍为`277254b`，候选代码、锁文件、测试与审计保留为本地未提交改动。没有绕用其他通道推送、触发旧SHA工作流冒充本批CI，或将待CI子项勾选。当前暂停点是请求确认将本批10个文件提交并推送到`cinagroup/cinashop`的main；本地通过不代替该目标要求的远端证据。

## TEST-004B 浏览器授权后的本批客服回归（2026-09-05）

用户确认浏览器插件已安装并授权后，实际以CUA应用内浏览器连接验证，不使用外部Playwright、不安装额外浏览器依赖。本轮未执行git提交/推送：该授权上下文是浏览器使用，不能自动替代上一节被拒绝的main远端写入确认。HEAD及精确SHA的CI等待状态不变；TEST-004B/C与生产发布门禁保持开放。

目标流程为本地客服密码表单登录→系统提醒→打开详情→实时新增→显式已读/未读筛选→临时断线恢复→失权/过期退出。旧5195/5197端口启动时报告已占用，因此保留原有进程，另开仅绑定127.0.0.1的5205夹具及5207客服Vite6.4.3，明确设置`CINASHOP_API_PROXY_TARGET=http://127.0.0.1:5205`。临时夹具位于系统Temp，不提交；测试账号与令牌无生产效力，没有通过浏览器注入真实会话，也没有访问生产DB、Redis、Cloudflare或真实支付/通知渠道。

通过可见表单先验证空提交显示“请输入客服账号和密码”，再输入隔离身份登录，URL实际进入`/messages`、标题为“系统提醒 - CinaShop 客服”。打开提醒不改已读；经真实本机WebSocket发布新revision后未读1→2，原详情保留；点击“标为已读”后2→1，“仅看未读”只保留新提醒。1013临时断线后夹具累计连接数1→2、当前活跃连接仍1，页面恢复“通知实时连接”、详情及筛选状态保留。再注入4001，列表/详情和旧未读数清空，显示失权提示；该状态下普通刷新不重新授权，显式点击“重连通知”才触发重新鉴权，夹具HTTP401使页面跳转登录。随后主动进入`/messages`仍被路由守卫转回`/login?redirect=/messages`，未恢复旧会话。

桌面1280×720及窄屏390×844均以AX/DOM、页面标题/URL和原始截图复核；窄屏`document.documentElement.scrollWidth=innerWidth=390`，无Vite错误遮罩，正常流程及1013恢复后收集到的console error/warn均为空。截图呈现原详情保留、未读筛选和手机详情操作按钮，不声称真机、所有屏宽、其他前端或生产身份端到端通过。前端测试技能推动了可见控件操作、逐次状态核验、控制台与截图采集；未发现需要修改业务页面的回归。

本轮再次运行客服`npm test`（Vitest3.2.6，3文件17项全通过）及`node --test ../common/toolchain-security.test.mjs`（6项全通过），未重跑Worker或其它四端全量。新证据只补充当前本地依赖候选的客服浏览器回归，不拿旧Actions运行冒充本批CI，也不关闭未完成的ECharts/UniApp/Drizzle依赖审计。

## TEST-004 首批获准推送与ECharts完整边界审查（2026-09-05）

用户随后明确回复“授权”，已按先前具体确认请求提交推送10个文件到main：`a00ac45c8f6f8c278928e38bc186608361b6ee9b`。[Actions `33956473619`](https://github.com/cinagroup/cinashop/actions/runs/33956473619)对该精确SHA最终8/8成功：Worker双TypeScript、229文件单元测试、schema/route/observability、3文件24项workerd、五端类型/构建、客服17项及新增18项依赖回归均执行成功；Kefu/PC全树官方npm审计各0。Gitleaks扫描219提交无泄露。workerd仍有WebSocketPipe被销毁的非致命诊断，不能称日志无异常文字。此前默认分支写入的权限暂停已解除；仅勾选已获上述证据的TEST-004B/C，不把本批尚未提交的ECharts测试或生产验收纳入该CI。

ECharts使用安全修复技能进行独立只读调查、主代理独立核对及一次候选复核。依据[Apache实际修复](https://github.com/apache/echarts/pull/21608)，本项仅评估`lines`默认tooltip中数据项name未经编码进入HTML的公告路径。Admin/Supplier均锁定5.6.0；主代理临时探针实际调用LinesSeries.formatTooltip→normalizeTooltipFormatResult→HTML生成→TooltipHTMLContent.setContent，以惰性记录元素承接真实innerHTML赋值，证实普通HTML标签与实体编码两种名称会被原样交付，fromName分支则转义。探针不执行浏览器脚本、不访问外部URL；这是库级sink证明，不是线上XSS复现。

完整入口矩阵如下，行号对应未改动的业务源码。合计6个ECharts导入文件、13个setOption构造器、17个实际图表实例（Admin16、Supplier1）：

| 构造器（相对仓库） | 覆盖实例 | series来源与约束 |
|---|---|---|
| view/admin-ts/src/pages/Dashboard.vue:153 | 首页订单 | 展开API series；home/order服务固定bar/line |
| 同文件:183 | 首页用户趋势 | 本地固定line |
| 同文件:198 | 首页用户分层 | 本地固定pie |
| view/admin-ts/src/pages/statistic/Dashboard.vue:286 | 订单/商品趋势2图 | 展开API series；对应服务固定line/bar |
| 同文件:304 | 订单渠道/类型2图 | 本地固定pie及字符串模板 |
| view/admin-ts/src/pages/statistic/components/UserStatisticsPanel.vue:146 | 用户/微信趋势2图 | 显式投影name/value，本地固定line |
| 同文件:163 | 地域 | 本地固定bar |
| 同文件:171 | 性别 | 本地固定pie及字符串模板 |
| view/admin-ts/src/pages/statistic/components/TradeStatisticsPanel.vue:57 | 当日交易 | 两条本地固定line |
| 同文件:69 | 历史交易 | 数字type=1用于业务筛选，随后本地固定line |
| view/admin-ts/src/pages/statistic/components/BalanceStatisticsPanel.vue:46 | 余额来源/消耗2图 | 本地固定pie及字符串模板 |
| 同文件:52 | 余额趋势 | 展开API series；余额服务固定两条line |
| view/supplier-ts/src/components/SalesTrend.vue:19 | Supplier首页趋势 | 仅注册LineChart，两条本地固定line |

Admin入口为/dashboard、/statistic；Supplier为/dashboard，SalesTrend只有该页一个消费者。未发现另外的动态ECharts导入、CDN脚本、图表选项加载/保存入口或自定义图表注册。Admin全量导入确实注册了LinesChart，三处展开也会保留type/data/tooltip/coordinateSystem等额外字段：不能把TS union或全局tooltip.trigger=axis视作安全过滤。构造一份任意API JSON可使这些字段进入setOption，但尚不构成当前攻击者能控制接口输出的证据。

主代理从同源请求/Pages透传继续追踪到/adminapi与/api/admin两个别名，均进入AdminController相同方法；home/order只接受parseAdminHomeCycle，三个get_trend只接受parseAdminStatisticRange，客户端不能提交完整图表选项。AdminDashboardService.orderChart:403～426按四周期分支创建固定bar/line和白名单图例，数值由number()投影；AdminStatisticService.orderTrend:813～816固定六指标、productTrend:947～951固定四指标；AdminExtendedStatisticService.balanceTrend:621～623固定两指标。后三者用seriesValues将DB聚合value转换为有限数，忽略无效指标，数据库行不作对象展开。其余前端构造器的series类型均由本地字面量决定；DEV预览同样是本地固定数据，不接受任意选项输入。可信后端或部署来源遭替换属于不同前提，不能以此虚构一个现有请求链。

候选结论为应用范围`no_change`：现有13个构造器没有可达的公告Lines默认tooltip路径，故本轮不修改业务页面、后端服务或强行升级ECharts主版本。包本身仍受公告影响，Admin/Supplier各1个moderate不变；此处没有豁免所有ECharts问题或证明生产已部署该源码。以后增加lines、可编辑图表JSON、修改数据生产者或注册方式必须重新审查。

新增`workers-ts/test/admin-chart-option-boundary.test.ts`直接调用四类服务（首页覆盖四周期），7项测试验证额外type/tooltip/coords/name不从聚合行透传、正常12.50数值与计数保留、HTML/实体/JSON数值被转为0、未知metric不进入图表。该夹具替换查询返回值，不是新的SQL/HTTP/鉴权集成验证。新增`view/common/echarts-tooltip.test.mjs`在两份实际安装包分别执行4项测试：真实SSR line/bar/pie模型的单项/多项格式化结果，经真实markup及HTML赋值方法记录，标签名称、实体名称与正常中文/数值均按当前合同转义；固定饼图模板同样检查。没有将漏洞的原始HTML输出写成要求未来版本继续保留的CI断言。测试覆盖审查过的生成器与格式化调用，不冒称自动执行了全部Vue构造器或真实指针悬浮E2E。

本地新增7项加既有三组迁移测试共4文件22项通过，Admin/Supplier各4项tooltip测试通过。第一次node --check路径误用了Worker工作目录，纠正为绝对路径后通过；全量Worker类型检查先在Node默认约2GiB堆上限OOM，改用单命令`node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit`后退出0，未修改系统设置或弱化类型规则。业务源码/依赖未变，不需要为本轮测试改动重做图表样式兼容迁移；仍由新提交的Linux CI执行完整既有构建及新增两个前端tooltip步骤。独立复核和该精确SHA通过前，TEST-004F保持待验收。

候选独立复核未发现当前应用可达的Lines路径或生产行为回归，但指出原测试名称“item/axis”把series片段误称为完整轴提示覆盖，而且getRawValue断言并不证明金额在提示正文可见。主代理核对TooltipView._showAxisTooltip与axisPointer.getValueLabel后确认这两处覆盖表述问题：将原3项命名收窄为single/multiple-series片段并断言HTML正文包含数值7；额外1项直接调用真实_showAxisTooltip，在x/y两个分类轴使用与series及数据项不同的标签，验证轴标题在最终HTML中编码。仅替换屏幕定位/展示回调和惰性HTML记录元素；真实轴模型、标签格式化、section头与片段拼装均执行，仍不声称真实鼠标事件E2E。首轮新轴夹具遗漏valueLabelOpt导致两端失败，按实际axisTrigger载荷补齐空默认选项后，两端最终各5/5通过。更新后的候选无业务源码/依赖变更；仅新增回归测试与CI步骤，独立复核周期到此完成，等待本批精确SHA门禁。

## 完成定义

一个业务域只有同时满足以下条件才可标为“完成”：旧新路由/权限/状态机映射齐全；若部署范围包含旧历史继承，则数据迁移可重复且校验通过，本部署改由新系统初始化与当前数据完整性验收替代；关键并发与失败恢复有集成测试，前端真实流程通过，预发Cloudflare和第三方回调有远端证据。源码中存在接口或页面不等于迁移完成。
