# Supplier 商品选择目录增量 — 2026-10-13

本批恢复三个只读注册：`GET /supplierapi/product/product_label`、`GET /supplierapi/product/brand/cascader_list`、`GET /supplierapi/product/brand/cascader_list/:type`。标签组/标签树与品牌 cascader 沿用旧页面字段和两种品牌选择模式。它们仍要求 Supplier 登录及 `supplier.product.view`，`manage` 包含查看能力；租户只来自签名账号当前数据库关系，query/header 不能覆盖。

## PHP 与第一方调用依据

- `cinashop-php/route/supplier.php:166`：标签目录；`:247`：品牌 optional type 路由。
- `cinashop-php/app/controller/supplier/product/label/StoreProductLabel.php::tree_list()` 调用 `getProductLabelTreeList()`；`app/services/product/label/StoreProductLabelCateServices.php::GROUP` 为 **2**，并非通用商品分类或参数模版。
- `app/services/product/label/StoreProductLabelServices.php::getProductLabelTreeList()` 生成标签组的 `id/value/label_cate/label_name/label/relation_id/type`，标签叶保留旧列及 `label/value`；`BaseServices::get_tree_children()` 按 `label_cate` 挂载。
- `app/model/product/label/StoreProductLabel.php::getAddTimeAttr()` 将标签叶 `add_time` 格式化为 `Y-m-d H:i:s`，`config/app.php:38` 指定 `Asia/Shanghai`。新DTO按同一命名时区格式化，包括 epoch=0 以及历史夏令时。
- `app/controller/supplier/product/StoreBrand.php::cascader_list($type = 1)` 与 `app/services/product/brand/StoreBrandServices.php::cascaderList()`：默认/`1` 前置 `{value:0,label:"顶级品牌"}` 且只保留前两级；`2` 不加顶级选项，返回完整树。品牌节点为 `value/label/pid`，仅非叶节点含 `children`。
- `view/supplier/src/api/product.js:139` 调用标签树；`:239` 调用默认品牌树；`:335` 调用 `/2`。旧路径与字段不是由新页面名称猜测。
- 标签、分类及品牌 DAO 都按 `sort DESC,id DESC` 读取，本批保留该顺序。

## 隔离与明确收紧

原标签服务只读取默认平台标签组，却没有为标签查询加 owner 限制，历史 Supplier 标签若错挂平台组也会被展示。新读取包含平台 `(type=0,relation_id=0)` 与当前 Supplier `(type=2,relation_id=supplierId)` 的启用标签组，标签必须同时满足 `label_cate=category.id`、同 `type`、同 `relation_id`，以及 `status=1/is_show=1`。标签组 `group=2/is_show=1`；空组明确返回 `children:[]`。别的 Supplier、门店类型、错误关系、停用/隐藏、孤儿以及错挂标签均不返回。Supplier 自有组可见是对原目录遗漏的修正，不声称复刻其全局泄漏行为。

`store_brand` 没有 Supplier owner tuple，只有 `store_id`。本批只提供 `store_id=0,is_show=1,is_del=0` 的平台品牌；不把门店编号解释成 Supplier 编号。树只从平台 `pid=0` 开始，隐藏/删除/门店父节点下的记录、孤儿和环都不能提升成新的根。默认/`1` 与 `/2` 保留上述两种模式；其他 type 值返回业务 `status=400`（沿用兼容层 HTTP 200 envelope），旧 PHP 对任意非1值都返回完整树的宽松行为不再支持。

标签目录在同一 `REPEATABLE READ, READ ONLY` 事务读取分类与叶节点，品牌也用只读快照。事务语句超时最多5秒；不修改目录、不读取供应商账户资料、不写历史关系。分类最多1,000、标签最多5,000、品牌最多1,000、完整品牌深度最多16、响应最多2MiB；超限返回503且不伪装为完整数组。所有成功、拒绝和匿名响应设置 `private,no-store`，避免缓存租户目录或身份失败。

`all_label` 暂不恢复：原 Supplier controller 的 `allLabel()` 调用 `getList(2,supplierId)`，而实际 service 的 `getList(array $where)` 合同不符。本批既不把另一个 `getAllLabel()` 结果伪装成已核对合同，也不修改既有退役台账。标签写入、标签表单、Supplier 前端接入、真实角色/历史数据验收与发布仍是独立工作。

## 验证

`test/supplier-product-catalog.test.ts` 使用真实注册 Supplier 路由、JWT、数据库账号/角色/租户推导及实际 Drizzle SQL，只有 Redis token persistence 被替代；数据库默认隔离 PGlite，可按现有测试夹具用专用 loopback PostgreSQL16运行，绝不回退生产。覆盖两家 Supplier、平台目录、同owner JOIN、门店品牌、失效父节点/环、排序/DTO及同序 `id DESC`、epoch=0/历史夏令时、默认与`/1`/`/2`模式、manage 包含 view、成功/拒绝响应缓存策略、权限撤销及账号换租户、停用 Supplier/账号、匿名/无关角色、非法类型和容量/层级/字节超限。外部 fetch 禁止。

2026-10-13 已独立执行完整测试文件，PGlite **23/23 通过、退出0**。使用本机源码副本与原 `vitest.config.ts`，命令为 `node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/supplier-product-catalog.test.ts --maxWorkers=1`，仅当前测试进程清除 `TEST_FINANCE_POSTGRES_URL`。服务、controller、测试、Supplier router、config、package/lock 共七个关键文件执行前后与来源 SHA256 一致；完整依赖输入证明由本轮统一验证报告保留。首次 UNC 入口无法解析 vite，首次本机沙箱入口发生 `realpath EPERM`，二者没有执行案例；同参数本机提权重跑实际通过，首败与重跑日志均保留。Native PG16 与全工程类型结果由统一验证记录另列，不把 PGlite 结果当作原生锁/权限证明。

没有生产读取、提交、推送、部署或实际旧端浏览器验收。本批只作为 SUP-002 的一个目录候选增量，不能据此关闭整个商品迁移父项。
