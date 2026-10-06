# 积分商品详情与真实购买消费者合同

2026-10-01。本批补齐积分活动指定详情，以及积分商城和悬浮按钮到真实详情的入口。公开接口为 `GET /api/store_integral/detail/:id`，新页面为 `/pages/activity/integralDetail?id=<活动ID>`。本地最终详情与目录原生组 32/32、定向财务回归 12/12、浏览器 retry2 16/16 已有实际成功日志。保留的 19 项独立复验和最终 manifest 仍待根任务确认；本文件不将已编写库存、跳过用例或浏览器模拟算成原生金融/生产验收。

## 旧合同与身份

详情 ID 是 `store_integral.id`，正文读取同一个活动 ID 的 `store_product_description.type=4`。基础商品 ID 为活动的 `product_id`，不能将二者交换，也不能用普通商品详情替代积分详情。旧 PHP 在 [StoreIntegralServices.php](C:/cinagroup/cinashop-php/app/services/activity/integral/StoreIntegralServices.php:246) 读取活动、type 4 正文、标签、保障、DIY 控制、品牌和规格；[getProductAttrDetail 调用](C:/cinagroup/cinashop-php/app/services/activity/integral/StoreIntegralServices.php:291) 同时传入活动 ID、类型 4 和基础商品 ID。旧模型 [getPrice](C:/cinagroup/cinashop-php/app/model/activity/integral/StoreIntegral.php:167) 将基础商品原价绑定到活动详情。

旧前台 [type 4 详情调用](C:/cinagroup/cinashop-php/view/uniapp/pages/activity/goods_details/index.vue:866) 与 [购买入参](C:/cinagroup/cinashop-php/view/uniapp/pages/activity/goods_details/index.vue:1175) 使用活动 ID；[收藏](C:/cinagroup/cinashop-php/view/uniapp/pages/activity/goods_details/index.vue:1126) 使用基础商品 `product_id`。新页面保留这一分工，通过基础商品的现有收藏接口读取和修改收藏状态，不把个人收藏字段加入公开活动快照。

旧 [分享参数](C:/cinagroup/cinashop-php/view/uniapp/pages/activity/goods_details/index.vue:749) 包含 `type`、活动 ID 和 `spid`。新消费者支持严格正整数活动 ID、可选严格正整数 `spid`，以及有界、无重复键的 scene 参数；旧 type 4 详情路径由登记映射落到真实积分详情页。非法 ID、错误活动类型和不明确身份不会退回普通商品详情。

## 公开读取与 DTO

[UserActivityController.integralDetail](C:/cinagroup/cinashop/workers-ts/src/controllers/api/v1/UserActivityController.ts:544) 设置不缓存响应，严格校验正整数 INT32 ID，并将请求环境传入服务。[ActivityService.integralDetail](C:/cinagroup/cinashop/workers-ts/src/services/activity/ActivityService.ts:497) 委托 `IntegralProductReadService`。本批不改变全局兼容错误语义：常规业务验证保留 HTTP 200 的 `status:400`；不可公开的商品保留 HTTP 200 的 `status:404`。实际签名附件路线仍使用其原有 HTTP 404 合同。

DTO 由 [IntegralProductDetailData.ts](C:/cinagroup/cinashop/workers-ts/src/services/activity/IntegralProductDetailData.ts:7) 显式定义，不返回 ORM 原行。

| 区域 | 实际字段与含义 |
| --- | --- |
| `storeInfo` 身份和展示 | `id,productId,storeName,unitName,image,images,description,productType,sales,brandName`；图片为已授权预览，正文为净化后的 HTML |
| `storeInfo` 数量和表单 | `onceNum,num,systemFormId,deliveryType`；表单只给有效引用，不给历史 `customForm` 或客户数据 |
| `storeInfo` 摘要 | `price,otPrice,integral`；现金为精确两位小数字符串，原价来自基础商品；摘要不能代替选中规格报价 |
| `storeInfo` 标签和保障 | `storeLabel[{id,labelName,styleType,color,bgColor,borderColor,icon}]`、`ensure[{id,name,image,desc}]`；仅平台或该供应商有权公开的定义 |
| `storeInfo.specs` | `{name,value,sort}`；只保留显式属性，排序为有符号 INT32；按旧 DIY `showService` 控制展示 |
| `productAttr` | `{id,name,values:string[]}` 规格维度 |
| `skus` | `{id,unique,suk,image,price,otPrice,integral,stock,purchasable,issues}`；`unique` 是活动 type 4 规格身份 |
| `productValue` | 以唯一合法组合为键引用同一 SKU；重复组合不能以最后一条覆盖，也不会生成普通商品兜底 SKU |
| 顶层 | `saleStock,issues,siteName,siteUrl,shareQrcode,productPosterTitle` |

基础商品必须已公开、已审核、未删除，且不是 VIP 专用或预售商品。活动必须启用、展示、未删除，并与基础商品的持久化 `type/relationId/productType` 完全一致。平台商品保留平台身份；门店和供应商副本保留自己的基础商品 ID，验证真实所属方及平台父商品的类型和身份，不读取父商品的私有正文或完整 ORM 行。

[IntegralPublicCatalogPolicy.ts](C:/cinagroup/cinashop/workers-ts/src/services/activity/IntegralPublicCatalogPolicy.ts:6) 提供同源公开候选 SQL。它支持真实门店 type 1、供应商 type 2 副本，而不是仅允许 `pid=0` 的平台商品；无有效正 ID、隐藏、孤儿或归属漂移商品不进入目录。候选 SQL 没有正库存条件：公开售罄活动仍可进入详情。

## 库存、报价与安全诊断

每个活动 SKU 按精确组合关联基础商品 type 0 SKU。有效数量取六层最小值：活动库存、活动剩余额度、基础商品库存、活动 SKU 库存、活动 SKU 剩余额度、基础 SKU 库存。正库存且无阻断诊断才 `purchasable=true`；正常售罄保留真实报价、返回库存 0 和不可购状态。单次和累计限购保留既有语义：正 `onceNum` / `num` 生效，0 不新增限制；公共详情不读取用户累计已购量。

退休、缺失或重复基础规格，重复活动组合/令牌，履约类型不一致，坏库存，非法现金或积分，失效表单均有固定诊断。坏 SKU 身份可投影为空字符串并禁用，不能拿去建购物车。坏金额的技术占位 `0.00` / 0 不能解释为免费报价；前端遇到 `sku_money_invalid` 或 `sku_integral_invalid` 显示报价异常并禁止购买。合法纯积分或纯现金规格可以保留，但现金与积分都为 0 的 SKU 不可购。

读取容量明确且不会偷偷截断：活动和基础有效 SKU 各最多 500 项，第 501 项拒绝；规格维度最多 10 个；定义引用最多 100 个；原始 type 4 正文最多 200000 字符且不能有重复正文；正文稳定素材引用最多 1000 个。损坏的可诊断字段可以保留安全只读 DTO；无法返回完整安全 DTO 的容量错误直接失败。

[IntegralCatalogReadability.ts](C:/cinagroup/cinashop/workers-ts/src/services/activity/IntegralCatalogReadability.ts:50) 在调用方的同一个只读快照里，对最多 100 个已公开活动一次批量检查，不逐项执行完整 14 表详情。SKU、维度和正文分别使用 limit+1 / 两条正文哨兵；返回每个活动的诊断 Map，固定本地码为 `activity_sku_capacity,base_sku_capacity,attribute_capacity,description_ambiguous,description_capacity,body_asset_capacity`。目录将这些项标为不可选；合法库存 0 仍可选。

整批正文 UTF8 预算为 2MiB，数据库先判断总预算再决定是否返回正文；超预算使整请求失败，不返回部分成功或空成功。平台展示配置的三个已知键全量读取最多 1000 行，重复配置按 `sort DESC,id DESC` 取权威值；第 1001 行属于整体配置失败。SQL、超时和权限错误向外抛出，不被冒充商品禁用诊断。

## 媒体、快照及分享

详情事务在首次读取前设为 `REPEATABLE READ, READ ONLY`，事务内 statement/lock/idle 超时分别不超过 5/2/5 秒并保留更严格设置。身份、库存、正文、定义、配置和附件元数据使用同一个快照；没有初始化、访问日志、积分扣款、库存修改或后台修复写入。

媒体验证复用既有 `publicProductPictures`：平台与门店使用平台图书馆，供应商允许本方与平台图书馆；必须匹配实际附件模块、文件类型、R2 图片类型、对象键和 MIME。积分专用正文净化还移除非 TAB/LF/CR 的 C0/DEL。正文的 dot-segment、编码、外部 URL 及带旧签名的 assets 命名空间引用被归一成稳定 `/api/assets/N`，或被拒绝；随后仍验证持久化商品 owner。旧有效或过期签名不代表商品归属，也不会直接透传。异属正文附件不获得新签名。

本批修复了两条实际跨端边界：全局文章净化原先会保留正文 BEL/DEL，使前端严格解析整页失败；积分专用净化现在移除这些文本控制字符，保留正常空白，不改变全局文章服务。正文 `/a/../api/assets/N`、编码路径及外部 URL 的 assets 路径原先可能未进入精确素材集合；现在先归一，再进入同一归属验证和新签名。真实 HTTP 用例检查本方三种别名获得新签名、异属别名即使带旧有效签名也移除，以及过期旧签名不保留；目录正文引用容量计数复用同一个专用净化函数。

附件在只读事务内验证，提交后才使用 APP_KEY 签名；没有 provider 或图片 HTTP 请求，也不在详情读取时读取 R2 对象。原始正文 200000 字符上限与签名后输出上限有区别：消费者允许净化/签名后的 2MiB 输出预算。真实 HTTP 用例覆盖 200000 字节原始正文含控制字符和稳定素材，签名后输出超过原始长度但仍小于 2MiB；另通过实际附件路线验证本地 R2 get 边界。

`siteUrl` 唯一来源是 `Env.PUBLIC_H5_ORIGIN`。它只接受最多 255 字符的规范 HTTPS DNS origin，不含 userinfo、端口、路径、query 或 hash，原字符串须与解析出的 origin 完全一致。缺失或非法返回空串，前端说明分享链接不可生成。SQL `site_url`、API_BASE 和请求 Host 都不提供分享权威；本地 vars 的批准值与生产正式部署状态须分别验收。

## 前端真实消费与结算

[apiIntegralDetail](C:/cinagroup/cinashop/view/uniapp-ts/src/api/activity.ts:10) 先验证活动 ID，再严格解析显式 DTO；图库、规格图片和正文再经过前端媒体/HTML 边界。积分商城弹层与 [指定详情页](C:/cinagroup/cinashop/view/uniapp-ts/src/pages/activity/integralDetail.vue:1) 共用 [useIntegralPurchase](C:/cinagroup/cinashop/view/uniapp-ts/src/composables/useIntegralPurchase.ts:11) 和 [integralPurchase](C:/cinagroup/cinashop/view/common/integralPurchase.ts:122) 选择、数量和精确金额逻辑，不复制兑换结算。

实际提交为基础商品 `productId`、活动 `activityId`、活动规格 `unique`、`cartNum`、`type:4`、`new:1`，进入现有 cart → confirmation → order create → payment 链。购物车将活动组合映射到基础 SKU；建单和支付继续使用选中 SKU 的现金及积分，并重新验证库存、累计限购、余额和积分。公开详情和前端显示不替代事务中的金融判断。

登录返回重新读取商品；路由切换、隐藏/卸载和身份改变使旧响应失效。加购结果未知不会自动再次加购；成功获得的 cart ID 在结算跳转失败时继续复用。表单引用交由真实确认页填写，基础商品收藏使用现有独立接口。

H5 分享以当前网页 origin 构造商品 URL，APP/MP 的网页分享及海报使用公共 DTO 中规范 `siteUrl`，保留当前账号的推荐人参数。APP 微信分享源码调用 Uni provider 能力并显示失败；MP 使用真实详情 path。客户端海报的二维码是 H5 商品网页 URL，不能称为微信正式小程序码。本地浏览器已验证真实 canvas 生成可导出的普通 URL 二维码海报；它没有证明微信正式小程序码、真机分享/provider 或真实相册授权。这些项目以及生产 origin 配置仍属外部验收范围。

## 测试库存与证据边界

新读测试库存为 32 项：`integral-product-detail.test.ts` 8 个纯投影用例、`integral-product-detail-postgres.test.ts` 17 个真实 SQL 用例、`integral-product-detail-http.test.ts` 7 个注册应用 HTTP 用例。这个“32 项库存”与下表的“32 项最终原生组”是不同集合，不能相加；后者包含新读的 24 个 SQL/HTTP 用例和目录的 8 个 SQL/HTTP 用例。

| 验证集合 | 当前实际结果 | 证据 |
| --- | --- | --- |
| 最终详情 SQL 17 + HTTP 7、目录 SQL 5 + HTTP 3 | 32/32 通过，4 文件，wrapper exit 0；fixture remaining 0、集群停止 | [原生日志](C:/cinagroup/cinashop/.cache/integral-detail-native-detail-catalog-final-20261001.log)、[执行元数据](C:/cinagroup/cinashop/.cache/integral-detail-native-detail-catalog-final-20261001.metadata.json) |
| 定向既有真实财务回归 | 12/12 通过，293 项明确跳过，4 文件，wrapper exit 0；不宣称完整 305 项已执行 | [财务日志](C:/cinagroup/cinashop/.cache/integral-detail-finance-regression-20261001.log)、[执行元数据](C:/cinagroup/cinashop/.cache/integral-detail-finance-regression-20261001.metadata.json) |
| 真浏览器 retry2 | 16/16 场景通过，wrapper exit 0，errors/pageErrors/routeErrors/unknown 均 0；不计入 SQL/pure 唯一数 | [浏览器日志](C:/cinagroup/cinashop/.cache/integral-detail-browser-retry2-20261001.log)、[执行元数据](C:/cinagroup/cinashop/.cache/integral-detail-browser-retry2-20261001.metadata.json) |
| 保留的独立集合 | 19/19 通过：详情 pure 8、选择器 pure 4、旧目录 SQL 4 + HTTP 3；独立 green，wrapper exit 0 | [独立日志](C:/cinagroup/cinashop/.cache/integral-detail-native-retained-final-20261001.log)、[执行元数据](C:/cinagroup/cinashop/.cache/integral-detail-native-retained-final-20261001.metadata.json) |

核心 51 项（39 SQL/HTTP + 12 pure）加独立财务 12 项，共 63/63 通过（51 SQL/HTTP + 12 pure）。另有4组实际前端运行时81/81和6文件审计/兼容回归53/53，共197项唯一通过；293项财务未选中及37项未接数据库的权限用例共330项明确排除。初始19个通过用例含7个旧目录SQL/HTTP，不能全部标为pure；原生重复运行不重复累计。最终source/raw摘要和独立核验见[本批冻结验收](../audit/integral-product-detail-acceptance-20261001.json)。

详情服务直接读取 14 张业务/配置表：`store_integral,store_product,store_product_attr,store_product_attr_value,store_product_description,store_product_label,store_product_ensure,store_brand,system_attachment,system_store,system_supplier,system_dise,system_config,system_form`。独立 [integralProductReadFixture](C:/cinagroup/cinashop/workers-ts/test/helpers/integralProductReadFixture.ts:14) 加 `user` 共 15 表，支持真实可选用户 JWT。夹具建立实际 ORM 列、默认值、主键和普通/唯一索引，使用 PG16 独立非 owner LOGIN，并只授予当前生产 app/Admin 权限计划中已存在的 SELECT 交集。它不是完整 282 表 commissioning，也不声称覆盖所有迁移约束、生产角色整套 DML 或 Hyperdrive。

原生范围包括真实当前/会话角色、拒 DDL 和活动写入、完整安全 DTO、六层库存、归属与副本、金额边界、历史冲突/退休、容量和整批预算、实际并发写入后的 RR 对照、真实 transaction-local 超时，以及 no fetch / 行数据不变。HTTP 使用真实应用、真实 JWT 和本地 R2 对象边界；没有 mock 商品/owner/金融服务。首轮供应商默认 admin_id 撞真实唯一索引的 setup 失败日志及修改前文件保留，不解释为业务缺陷红线或成功用例。

现有金融回归复用 `admin-integral-batch-postgres.test.ts` 的真实统一建单/支付/outbox/退款，及 `checkout-confirmation-rules.test.ts`、`checkout-line-finance.test.ts`、`checkout-member-evidence.test.ts`。选中现金 4.25、积分 10、数量 2 的规格，确认和订单须是现金 8.50、积分 20；实际余额支付、outbox 幂等、退款和两层库存恢复由金融服务证明，不能由本只读夹具推断。

浏览器场景检查真实 DOM、响应式布局、规格/数量交互、收藏关联基础商品、canvas 海报、路由替换和过期响应、加购防重复、共享商城弹层、FAB type 4 入口及目录禁用诊断；其 API 拦截/本地替身边界与原生 PG 财务证明分开。浏览器的加购/结算操作不表示已经发生真实付款、积分扣减或退款，也不表示调用过正式支付或分享 provider。

不新增生产 DDL 或角色授权；未部署上线，生产实际角色、权限配置与 origin 仍待部署验收，不把本地 SELECT 交集、SQL/R2 边界或浏览器替身当作生产流量、真机或正式 provider 验证。最终全部数字、执行日志、清理证明与 source/raw 哈希以冻结 manifest 为准。
