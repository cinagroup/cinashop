# Supplier 商品批量设置 — 2026-10-13

本批修复已注册 `POST /supplierapi/product/batch_process` 被错误接到批量上下架处理器的问题。旧页面的 `{type,ids,all,where,data}` 请求没有 `is_show`，因此原 TS 路由会拒绝实际批量设置。恢复第一方 Supplier 页面可见的四项完整流程：分类(type1)、物流(type3)、自定义留言(type7)、运费(type8)，支持选定商品及有界筛选全选。其他批处理类型仍明确拒绝，不声称整个 PHP 通用1～9处理器已经全部迁移。

依据：PHP `route/supplier.php:162`、`app/controller/supplier/product/StoreProduct.php:523`、`app/services/product/product/StoreProductBatchProcessServices.php`、`app/jobs/product/ProductBatchJob.php`、`app/jobs/product/ProductRelationJob.php`。实际消费者是 `view/supplier/src/pages/product/productList/index.vue`、`pages/product/components/batchSet.vue` 与 `src/api/product.js`；菜单仅显示1/3/7/8，保存传五项旧参数。PHP旧队列成功信息只是接受任务；本批用有界同步事务、真实提交前回读和提交后重新读取替代，不返回虚构的排队成功。

| 合同 | 行为 |
|---|---|
| POST `/supplierapi/product/batch_process` | 保留旧五项参数；`all=0` 使用选定 IDs；`all=1` 按当前 Supplier 范围解析 `where`，旧 `ids` 不当作排除列表。现代请求另带 `expected_revision`；旧缺省暂兼容。 |
| GET `/supplierapi/product/product/batch-selection` | 明确现代读取/恢复入口；query `all`、逗号 `ids`、JSON `where`。返回完整 `ids/count/products/relations/revision`，没有业务写入。 |
| type1 `data.cate_id` | 同 Supplier 启用分类及完整有效父链；只更新 `cate_id` 和type1关系，当前 `relation_pid` 与每个商品的上下架状态写入同事务。 |
| type3 `data.delivery_type` | 实物商品物流方式1快递、2自提、3门店配送；只更新该 CSV 字段。 |
| type7 `data.system_form_id` | 使用 `loadActiveOrderSystemForm` 的既有严格表单解析及SHARE NOWAIT协议；0明确关闭，不伪造空表单。只更新引用，既有结算媒体归属和收集规则继续有效。 |
| type8 `data.freight/postage/temp_id` | 包邮1清零金额/模板，固定2金额须正且最多两位小数并清零模板，模板3使用当前 Supplier 有效模板并清零固定金额。复用 `lockShippingTemplateBindings`。 |

所有选择最多100个商品，分类最多20项且存储CSV不超过64字符，已选分类关系最多2000条；请求16KiB、响应256KiB，事务语句5秒/锁等待2秒。查询使用超限哨兵，筛选全选超限明确拒绝整批，不静默处理前100条。旧第一方筛选覆盖关键词（含SKU条码）、分类及直属子级、品牌/商品标签关系、旧状态分组、现代上下架/审核状态、上海日期范围、关联商品与销量排序元数据；`page/limit` 不缩小全选。品牌原链 `BaseDao.withSearchSelect` 即使 `search=false` 也应用主品牌搜索器，随后 `StoreProductDao.search` 再叠加品牌关系条件；本批保留两条件AND，选父品牌不会意外扩选仅主品牌为叶节点的商品。请求提供的 owner 不改变签名归属。未知筛选字段拒绝，绝不执行客户端SQL。当前PHP model/DAO和TS表均无 `show_type` 的实际实现；非空展示终端筛选明确拒绝，不能伪造过滤。

权限按真实 JWT/current Supplier account 建立：GET为 `supplier.product.view`，POST为 `supplier.product.manage`。两入口在认证前设 `private,no-store`，匿名和无权响应也不缓存。写事务按分类scope → 当前账号/Supplier SHARE → 升序role/menu SHARE NOWAIT → 升序bargain源锁 → Supplier商品advisory(731602) → 商品行UPDATE NOWAIT → 引用SHARE NOWAIT执行。分类直接复用既有scope/有效树校验，已冻结分类模块不改。菜单/表单只复用既有列级锁权限，不新设table barrier、ACL或DDL。

整批当前商品固定 `type=2/relation_id=签名Supplier`；跨owner、平台、门店、缺失及回收站任一目标均使整批失败。沿用成熟 Supplier 运营资格，只允许实物0、卡密1、手工虚拟3；不通过批量关联修改绕过未迁移的履约类型门禁。物流和运费只允许实物。每次只写所选字段，不调用全商品保存来覆盖名称、价格、库存、SKU、媒体及其他元数据。取得商品行锁后用实际数据库整行JSON建立内部baseline，SQL window先限制整批2MiB再返回Worker；业务写入与审计之后分别核对整行，只允许所选项目的确切列变化。完整内部行不进入HTTP DTO。分类关系与内容最小化审计同事务，审计 `INSERT RETURNING` 必须有唯一且匹配actor/owner/type/method/action的实际回执；静默跳过或重写审计、触发器修改未选价格/库存，以及其他回读失败均使整批回滚。

未知执行核对GET使用 READ COMMITTED / READ ONLY，在读取前取得同 Supplier scope锁，等待进行中的本批/商品保存提交后读取新事实；不能用在锁等待之前建立的旧RR快照证明执行失败。真实JWT claims的当前密码/expiry、账号/Supplier、view角色在只读事务前后复核，不在只读事务取行锁。写入复核manage并保持授权行到提交，末尾再检查expiry。商品行NOWAIT不反向等待quote/cart/SKU；引用NOWAIT与既有模板/表单退休规则配合，原支付报价、媒体及表单收集协议不改。未参加scope的维护SQL和其他旧写路径不被advisory锁自动约束。

现代界面先读取目标事实、展示数量/当前值，再确认并提交内容revision；收到成功回执后仍GET原IDs并逐项核对。断网、回执不完整或回读失败保留原IDs和目标草稿，禁止重复提交，只提供重新读取核对；当前值不一致时明确保留未知状态。筛选/选择/路由代次变化不接受旧读取或旧确认；账号与权限撤销、A→B→A切换和卸载清空旧数据并丢弃迟到结果。运费模板分页，表单仅预览字段标题/类型/必填，不显示历史用户提交或未经授权图片。

验证输入已冻结：`supplier-product-batch-http.test.ts`有26项真实路由/JWT/RBAC/Drizzle SQL；首轮旧22项的20通过/2表单失败由夹具未显式启用表单导致，已修夹具，成熟parser不放宽，当前26项仍待统一同源复验。`supplier-product-batch-concurrency-postgres.test.ts`有11项，仅显式专用原生PG16运行，观察真正blocker，覆盖分类移动/删除两个顺序、运费/表单退休、quote侧行锁冲突、scope隔离、授权撤回、密码轮换与未知结果等待提交；该行锁测试不声称完整支付provider流程通过。

`supplier-product-batch-frontend.test.ts`实际Vue SFC/HTTP状态与preview模型 **21/21** 已通过。完整 Supplier `vue-tsc -p tsconfig.app.json --noEmit` 和生产build早期均退出0，之后的最终模板/布局也已重新通过21项SFC；完整最终类型/构建由本批统一验证补录。Browser plugin not available，采用regular Playwright本机 `http://127.0.0.1:5192/products?preview=1`：桌面1440×1000完成全部四项目、筛选全选4项与选定1项，手机390×844完成运费提交与重新读取，表单/成功后的整个dialog均在viewport内，只读会话隐藏批量设置入口。三会话页面身份、非空、无框架overlay及交互均通过，console **0错误/0警告**；4张截图人工复核后修正完成目标数量显示及手机内部滚动，再执行完整浏览器回归通过。证据位于本轮repo外根目录 `supplier-batch-playwright.cjs`、`supplier-batch-desktop.png`、`supplier-batch-mobile-form.png`、`supplier-batch-mobile-verified.png`、`supplier-batch-readonly.png`。早期QA脚本的硬编码数量、默认确认按钮及隐藏原生input定位失败不当作通过；最终完整流程已通过，临时5192服务器已停止。Browser预览仅模拟前端，不替代实际数据库归属/引用/事务证据。没有生产操作、外部provider调用、提交、推送或部署。
