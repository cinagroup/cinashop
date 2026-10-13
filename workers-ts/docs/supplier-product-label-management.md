# Supplier 商品标签流程迁移

本模块恢复供应商商品编辑页的标签选择、动态新增表单和保存关联，并提供当前供应商标签的管理页面。供应商标签的归属是 `store_product_label.type=2`、`relation_id=system_supplier.id`，不是供应商登录账号 ID，也不是平台标签类别。

## PHP 依据与修正边界

原合同位于 sibling `cinashop-php/route/supplier.php`、`app/controller/supplier/product/label/StoreProductLabel.php`、`app/services/product/label/StoreProductLabelServices.php`、对应 DAO/Model 与分类服务。这些标签文件可读，不依赖密文服务或外部提供方。旧第一方消费者是 `view/supplier/src/pages/product/productEdit/index.vue` 的标签选择与“新增标签”，通过 `productStoreLabel` 和 `productLabelAdd` 调用树和动态表单。

| 路径 | 方法 | 本次行为 |
| --- | --- | --- |
| `/supplierapi/product/product_label` | GET | 保留标签组树 DTO，修正合法供应商标签位于平台分组时被旧 TS 过滤的问题 |
| `/supplierapi/product/all_label` | GET | 返回当前供应商的 `[{id,label_name}]`，按 `sort DESC,id DESC` 排序 |
| `/supplierapi/product/label/form` | GET | PHP 动态表单，`title=添加商品标签`、`method=POST`、`action=product/label/0`，分类 select 和最多 20 字的名称 input |
| `/supplierapi/product/label/0` | POST | 新建当前供应商标签，接受 `label_cate`、`label_name` 和可选 `expected_revision` |
| `/supplierapi/product/label/:id` | POST | 编辑当前供应商标签，仅修改名称与分组；保留既有展示样式、颜色、图标、开放状态、排序及创建时间 |
| `/supplierapi/product/label/:id` | DELETE | 删除无引用的当前供应商标签；支持旧调用不携带请求 body，可选现代 `expected_revision` |
| `/supplierapi/product/label/catalog` | GET | 现代管理目录，包括当前供应商标签、合法平台/供应商分组、可选择性及内容 revision |

旧 `all_label` 虽声明了路由，控制器调用 `getList(2, supplierId)`，而可读服务签名为 `getList(array $where)`，会产生 TypeError。它不存在可证明的旧成功响应；本次按同服务的可读 `getAllLabel(2,supplierId)` 实现平面 `id,label_name` 合同，是明确修复旧缺陷，不把原错误计作成功 parity，也不虚构退役。旧第一方商品编辑页使用的是树和动态表单，未发现它调用 `all_label`。

旧新增表单确实使用平台 `category(type=0,relation_id=0,owner_id=0,group=2)` 的分组。合法历史供应商分组为 `type=2,relation_id=当前 Supplier,owner_id=0,group=2`。没有新增分组管理、`style/icon` 写字段或虚构供应商类别。现代商品内新增只显示启用的平台表单分组；管理页保留真实旧表单的分组定义。目录中的失效、未分组标签仍可见，便于明确清理。

选择树允许平台标签，以及当前供应商自有标签位于合法平台分组或本供应商历史分组。外国供应商标签、其他 owner 的分组，以及平台标签错误挂到供应商分组均被隔离。只展示有效标签与分组。`SupplierProductCatalogService` 本次仅修改 labels 查询，不修改品牌选择器。历史 `supplier-product-selection-catalogs.md` 记录的是此前阶段；本文件说明本次修复后的标签范围。

## 归属、权限、引用与事务

所有读路径要求 `supplier.product.view`；旧数字 GET 表单菜单不能提升为写权限。POST 与 DELETE 要求 `supplier.product.manage`。接口注册在真实 `createApp`/Supplier Station 上，并在匿名错误、权限拒绝和成功响应中使用 `Cache-Control: private, no-store`。服务在同一事务开始与结束复核当前 JWT 的账号、密码版本、到期时间、供应商状态及真实角色/菜单权限。写事务固定账号、供应商、角色及菜单权限；菜单/分组锁只需要既有 `UPDATE(id)` 锁权限，不扩大语义 DML。

标签目录使用每供应商 advisory 事务锁，明确限制 2000 标签、1000 分组、2 MiB 返回与有界数据库等待，超限报错而非截断。写入使用真实 label/group 行锁、内容 revision、完整 RETURNING 和回读核对；业务修改与精确审计回执原子提交。失效审计、跳过审计 INSERT、SQL trigger 改写未选字段或审计后改写标签都会回滚。

删除先取得该标签 `FOR UPDATE NOWAIT`，再检查全局 type=3 商品关系、辅助标签关系和商品 `store_label_id` CSV 历史引用，包括失效或异租户引用。历史 CSV 中无法安全解释的 token 保守拒删。审计后重新检查引用与标签不存在，避免 SQL trigger 引入悬空引用。并发商品绑定采用同一真实 label `FOR SHARE NOWAIT` 协议，删除与绑定均不能越过对方的锁事实。

完整商品保存由共享 `SupplierProductLabelBindings.ts` 与 `SupplierProductManagementService` 集成：显式 `store_label_id`/`labelIds` 最多 100 个合法 decimal/PG int ID，锁定可用平台或自有标签与合法有效分组；替换 CSV 与 type=3 关系差集并回读，保留仍存在关系的状态与创建时间。`ProductForm` 未修改标签时省略字段，保留隐藏、未分组或当前选择器未展示的历史关联；明确修改后提交选中 ID。实际商品 POST 路径使用其本身产品写权限，复用同事务 `assertBindingAuthority`，不要求额外虚构标签独立管理权限。

## 第一方页面与验证

`ProductLabels.vue` 支持目录、搜索、分页、动态新增、编辑、带确认删除和结果回读。未知执行结果阻止重复写入，恢复只读取目录核对；身份、权限或筛选代次改变会使待确认与异步结果失效。只读账号显示目录与搜索。商品编辑页通过共享 `SupplierProductLabelPicker.vue` 实现真实内联新增、重新读取目录与树、选中及保存，启用状态与 100 项上限在界面和服务两端执行。

独立本机开发镜像已完成三个完整普通文件共 52 cases：真实 `createApp`+JWT/Station 标签 HTTP 14、实际 Vue SFC 状态 15、选择器回归 23；无 case 过滤。首次选择器夹具 ID 重复的失败日志保留，修正夹具后完整复验通过。完整 `supplier-product-label-native.test.ts` 在独占 PG 16.15 真实 LOGIN 权限上 9/9 通过，包括并发新增、绑定/删除冲突、密码与角色撤回、跨供应商隔离及审计后悬空引用回滚。原生夹具数据库及 roles 清零，集群 STOPPED；独立 `pg_ctl -D` 检查 exit 3。完整供应商 `vue-tsc -p tsconfig.app.json --noEmit` 通过。最终整合的完整文件复验由根线程另行记录，这些开发结果不替代冻结源的最终验收。

浏览器验证使用已安装 Playwright Chromium 与 loopback Vite 独立镜像，接口是明确的本机受控传输，SQL/JWT 证据来自上述真实测试。浏览器证据记录在 repo 外 `supplier-label-browser-verification.json` 与相关截图，包含桌面、手机、只读目录，以及商品表单的内联新增、标签原事实保留、实际保存 payload 与权限撤回。运行前后核对 UNC 与浏览器镜像源哈希；不触及生产、外部 provider 或新数据库 DDL。
