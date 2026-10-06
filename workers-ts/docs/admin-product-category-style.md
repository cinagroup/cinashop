# 商品分类页面完整合同

本批承接旧 `/admin/setting/pages/product_category` 页面及真实商品分类消费者。旧 PHP 权威为 `C:/cinagroup/cinashop-php/app/services/diy/DiyServices.php` 的 productCategory 默认值（116–117）及 getProductCategoryDiy/saveProductCategoryDiy（587 起）：默认 `level=2,index=1`，读取 `template_name=category,type=3`，使用 `array_merge(default,saved)`。旧样式路由为 `route/admin.php:570,572` 的 GET `diy/get_product_category` 和 POST `diy/save_product_category`；`view/admin/src/api/diy.js:150,160` 的 getCategoryApi/saveCategoryApi 调用这两个地址。`diy/get_category` 是另一个分类目录接口；安装 SQL 菜单 1593 的精确页面路径与 `admin-setting-pages-product_category` 只映射新页面查看权限。`system_config.product_category_level` 是独立旧开关，不是本屏布局值。

完整十种布局由 `view/common/productCategoryStyle.ts` 登记：二级索引 0–5、三级索引 0–3。二/三级索引 0 为分类树；其它八种是商品面板，客户端消费真实商品列表、规格、现有购物车和确认/下单权威。本屏设置服务不计算支付、优惠、运费或库存扣减。

## 读取与写入

两个 Admin 前缀 `/adminapi`、`/api/admin` 共用：

- `GET /config/product-category-style` 返回 `{revision,value:{level,index}|null,configured,editable,issues}`。
- `POST /config/product-category-style/save` 接收完整 `{operationId,revision,level,index}`。
- `GET /config/product-category-style/receipt/:operationId` 返回 actor 绑定 `{operation:'update',id,operationId,payloadHash}`；回执不存在时实际 HTTP 404。

`operationId` 是规范 UUID，revision 和 payloadHash 是 64 位小写十六进制。摘要固定为 `{operation:'update',revision,level,index}`；UUID 不进入摘要。独立权限为 `product_category_style.view/manage`，查看不能写入，通用配置、分类管理或 PC 页面权限不能替代本域管理权。

GET 永不建行。缺记录时显示旧真实默认二级/索引 1，`configured=false`，允许管理员显式首次保存。表级 `status=0/is_show=0` 不会否定 JSON 配置；布局号也不写入这些表开关。正常保存仅更新 value、version、update_time，保留其它列以及有效 JSON 的未知扩展属性。未知数字必须能精确往返 JSON 数值语义；重复键、危险对象键、舍入/溢出/下溢、损坏 JSON、非法布局、规范化名称别名、重复记录、错误 type 或删除身份均明确诊断并拒绝覆盖。历史对象缺少 level/index 时只补缺省字段，然后验证十种合法选择；显式无效值不能借默认值激活。

公开 `/api/v2/diy/product_detail.product_category` 通过相同只读快照权威返回布局与 configured/issues，并保留旧非秘密扩展对象。configured/issues 由当前权威覆盖，历史扩展不能伪造。异常时二级/索引 1 只是显示回退，不代表记录有效，也不进行初始化；其它商品详情页面设置字段保持原行为。

## 并发、未知结果与旁路

读取为 bounded REPEATABLE READ READ ONLY；写入在首个查询前设置 READ COMMITTED，保留更严格的会话超时（上限 statement/lock/idle 为 5/2/5 秒）。写入先取目录 advisory，再检查 actor/UUID journal 重放，再取得 `system_dise` SHARE ROW EXCLUSIVE 表锁和新鲜目录 revision。revision 包含规范化候选记录及 xmin，元数据或隐藏状态改动也使旧版本失效。成功 DML 与 `system_log` 回执在同一事务提交。

仅可确认的 CAS 冲突或目录不允许写入、且均在业务 DML 前决定并已完成事务回滚时，返回实际 HTTP 409/400 与同值 body status，证明码分别为 `PRODUCT_CATEGORY_STYLE_STALE_VERSION` 和 `PRODUCT_CATEGORY_STYLE_REJECTED`，并携带 operation、operationId、payloadHash。客户端必须严格匹配原待定操作。原始请求解析错误、权限错误、UUID/actor/hash 冲突、损坏回执、SQL 错误或传输未知结果不提供这些证明；不能据此清除待定操作。读取新版本后仍须显式确认新 UUID，不能把旧请求悄悄改成新操作。

通用 Dise save/delete 同样先取表锁再取行锁。当前记录的规范化 category 身份（包含错误 type 和空白/大小写别名）禁止通用修改；请求伪造模板/type 字段也不会绕过专用完整版本协议。普通 DIY 页面仍可由原通用接口管理。

## 分类、SKU 和交易边界

`StoreCategoryService` 只投影平台 type0/relation0 的公开三层分类，按实际 pid/level 验证每个祖先，排除隐藏父级、孤儿、循环及其它租户。读取有 3000 条完整平台目录上限；越界报错，不截断为成功。图片由平台附件归属规则验证后签名；旧 Redis 分类树不再承担公开权威。`level_category` 的 id/cid 别名必须为规范正整数；同时提供时必须相同。

列表的 cid 查询自身及真实子孙，sid 查询二级自身和子级，tid 查询精确三级关系；以真实关系表和父级公开条件为准，陈旧 CSV path 不扩大筛选。参数拒绝重复、NaN、负数、非规范数及冲突父子条件。`is_big` 保留图片模式语义，不用来扩大商品归属。分页有界，count/list、会员权益及当前访客购物车数量在同一 RR 快照读取。

普通商品详情通过 `OrdinaryProductReadData` 显式选择公共字段，要求商品已审核/上架/未删除、真实门店或供应商可见；副本还要求同类型平台父商品公开。SKU 最多 500 条，规格最多 10 维，每维最多 100 个定义值。仅 active SKU 可供新购买；空/重复 unique、重复组合、维度不匹配、损坏 JSON 或非法报价明确拒绝，不能退回商品根价格、零价或旧敏感 `get_attr` 字段。有合法 CSV 规格兼容；JSON-looking 损坏值不会当 CSV 猜测。

返回真实 productAttr 以及安全 SKU unique/suk/image/stock/price/ot_price/vip_price/member_price/price_type/level_name/cart_num。金额为精确 decimal 字符串，selected SKU 会员价复用现有 checkout 运算及权益；库存取商品和 SKU 的较小值，零库存仍可阅读。不存在成本、结算价、条码、卡密、佣金或原始后台对象。媒体在同一快照验证持久化 owner，详情签名在事务结束后完成，不外呼媒体/配送 provider。

cart_button 对特殊商品、预售、系统表单或历史自定义表单关闭；这些商品进入适当详情流程。普通 inline 购买读取安全详情选定真实 SKU，再调用现有 cart add/num/delete 和确认/下单协议；目录价格、列表库存和页面布局不能授权交易。收藏与购物车数量只属于当前 uid。

会员报价读取 SQL 配置和真实权益，不依赖 KV。完整购物车仍调用既有首单促销读取，该读取依赖六个 newcomer/first_order KV 配置键；本批没有迁移这一其它业务权威。KV 故障时会员详情及会员旧属性报价仍可读，完整购物车报错且不写业务/配置行，不回退成忽略促销的成功报价。分类页 mini-cart 读取失败须显示错误；写入未知结果不能据读取失败解除待定请求。

## 本地验证状态

新增五个测试文件库存为 36 项：7 项纯协议、29 项真实 SQL/HTTP（Admin9、HTTP8、公共读取4、商品消费者8）。有限只读夹具组合 27 张真实 ORM 表，App 只获既有 SELECT 交集，Admin 获当前生产 profile 的精确交集；它不是生产权限验证或完整 commissioning。消费者末例另外使用完整 282 表迁移及当前真实 commissioning、独立 LOGIN，执行安全 SKU → cart add/set/delete → 实际 checkout，未调用支付或 provider。

首轮 7 项纯测试通过、29 项在同一夹具初始化序列冲突失败；失败 log/meta 与原始源码已单独保留。普通规格种子 id2 修复后仍保留原表/索引/序列校准和真实 ACL。第二次 28 项通过、8 项失败：通用配置 GET 抢先匹配专用 v1 路由、普通启用 DIY 的删除保护，以及两个多 SKU 数组断言。已保留原始失败证据并窄修：专用路由先注册；普通 DIY 显式停用后才删除；两 SKU 分别验证精确金额、库存和快照。第三次专项真实执行 36/36 通过、0 跳过，记录于 `.cache/product-category-style-native-retry2-20261002.log` 及 metadata；双 Admin 前缀和完整 282 表的真实 cart/checkout 用例均包含在该集合，失败和重复执行不另加唯一数。

旧九文件库存 129 项，按实际 case 主体分为 107 项 SQL 与 22 项纯/runtime/static（夹具初始化本身不充当 SQL 证明）。初次 128 通过、1 失败，是上述完整购物车促销 KV 边界；已保存原始失败并修正该 case 的准确合同，保留故障、零会员 KV、精确六个非会员键、无写入和快照不变断言，原生复验已在 `.cache/product-category-style-native-regression-retry2-20261002.log` 完成 129/129、0 跳过；新增专项与旧回归合计 165 个唯一用例（136 项实际 SQL/HTTP、29 项纯协议/runtime/static）。KV spy 的 overloaded 类型另行明确验证 string 键并收窄，保留全部六键、故障与零写入断言；修改后的原生 129 项及 Worker unit 类型检查均已通过。浏览器与最终冻结证据见本批独立验收记录。

旧有限夹具补充当前安全投影必需表；两个旧 DAO spy 换成真实 SQL 故障与独立 PID/RR 慢读者证据。PC 适配器从真实 SQL 返回值测试，规格价格区间由真实 SKU 决定。旧支付/退款财务证据不因浏览器或页面布局模拟而扩大；未 commit、push、部署或授予生产新权限。最终全部计数和结果以冻结 manifest 为准。
