# Supplier 商品分类完整运营候选 — 2026-10-13

本批将已注册但行为不完整的 Supplier 分类接口统一到 `SupplierProductCategoryService`，恢复列表、选择、动态表单、创建、编辑、移动、递归状态和引用保护删除。原 `SupplierProductManagementService` 的分类方法也委托同一服务，避免旧入口绕过分类规则；商品保存采用同一 Supplier 分类事务锁。没有新列或必需 DDL。

## 旧合同与现代消费者

原依据为 `cinashop-php/route/supplier.php:162-196`、`app/controller/supplier/product/StoreProductCategory.php`、`app/services/product/category/StoreProductCategoryServices.php`、`app/dao/product/category/StoreProductCategoryDao.php` 与 `app/model/product/category/StoreProductCategory.php`。旧 `view/supplier/src/pages/product/productEdit/index.vue` 的“添加分类”调用 `productCreateApi()` 并由 `utils/modalForm.js` 消费 `title/rules/action/method`，完成后刷新 `cascaderList(1)`。

| Supplier 路径（均以 `/supplierapi` 开头） | 本批合同 |
|---|---|
| GET `/product/category` | 按 `pid`（默认0）、`cate_name`、`is_show` 读取 `{list,count}`。节点有启用下级时保留 `children:[],loading:false,_loading:false`，供旧懒加载表格使用。按 `sort DESC,id DESC`。 |
| GET `/product/category/tree/:type` | 启用分类扁平选择；`0` 根级，`1/2` 全层级，父优先且兄弟按旧排序。 |
| GET `/product/category/cascader_list` 及 `/:type` | 启用 Supplier 自有树，`value/label/pid`；仅有后代时包含 `children`。旧 controller 忽略 type 参数，本批0/1/2选择同树。 |
| GET `/product/category/create` | `title/rules/action/method` 新建动态表单，POST分类；含父级、名称、移动图、PC大图、排序和状态。 |
| GET `/product/category/:id` | 同字段编辑动态表单，PUT当前分类；父选项排除自身、后代和最末级；包含确认版本。 |
| POST `/product/category` | 新建当前 Supplier 分类，返回 `{id,revision}`。 |
| PUT `/product/category/:id` | 完整编辑、同父重名保护；移动后同事务重算整棵子树的 `path/level` 和当前 Supplier 商品关系的 `relation_pid`。 |
| DELETE `/product/category/:id` | 拒绝有下级或有效商品引用的分类；成功信封 `data:null`。 |
| PUT `/product/category/set_show/:id/:is_show` | 当前节点及全部后代同步状态，返回 `{updated,revision}`；完整编辑改变状态也走同一递归政策。 |
| GET `/product/category/tree` | 明确现代树入口，保留新 TS 消费者的数组及 `add_time:number`；增加 `big_pic/revision`，节点总含 `children:[]`。 |
| GET `/product/category/:id/detail` | 现代裸详情及确认版本；不伪装成旧编辑表单。 |

上表前9条 PHP可执行源合同因 optional cascader 显式展开成为10个 TS入口，现代扩展2个。当前路由审计静态覆盖只能计新增旧 `create` 路径，不能把已注册接口的行为修复虚记成新增旧 URL 分子。

旧 `PUT /product/category/set_category/:id` 的直系 Supplier controller 没有该方法，父 `crmeb/basic/BaseController` 是 Swoole Loader 密文；仅凭直系缺失不足以证明不可执行，仍不注册、不退役、不计完成。`tree/:type` 的 `sort_list_tier` 全局 helper 未能从可读源确认全部装饰字段；本批按已确认的第一方 `id/cate_name` 扁平消费与层级数据恢复，不能声称密文 helper 每个装饰字段均字节相等。

## 权威与事务

所有分类均固定 `type=2,relation_id=当前签名账号的Supplier`。原 PHP 的列表/表单/更新/删除并未始终绑定租户，本批不复制其平台或其他 Supplier 的裸 ID访问。平台和门店分类也不充当 Supplier 父节点。

分类 scope 使用独立 advisory key `(731703,supplierId)`。分类写入先取 scope 锁，再锁当前管理员/供应商、按 ID锁角色和数字菜单，最后按 ID锁分类；同父查重和整棵有效树校验在锁内进行。商品保存先取同一个 scope 锁，随后才进入原有 bargain/product/SKU/运费模板锁，分类绑定与关系写入不会越过进行中的移动或删除。原 `assertShippingTemplate` 和 `lockShippingTemplateBindings` 协议原样保留。

分类最多三级，按真正的父子关系校验 `path/level`，拒绝自身/后代父级、跨租户父级、移动后超深及历史父链异常；坏树明确503，不静默呈现截断树。启用子级要求父链启用。删除检查当前 Supplier 的有效商品在 `store_product_relation(type=1)` 和历史 `store_product.cate_id` 两代引用；已回收商品保留历史，不把历史引用本身当有效运营关系。管理写入与不含图片/名称正文的 `system_log` 审计同事务，任一步失败全部回滚。

创建/修改接受名称（1～30字）、整数/旧 cascader 数组父级、`pic`、`big_pic`、排序和状态。图片只接受 HTTPS 或安全公共站内路径，暂不承诺私有附件票据或旧 `store/widget.images` iframe 的恢复；输入与安全预览已接入现代 UI。编辑省略图片字段时保留原图。父级数组不能覆盖服务器计算的权威父链。

旧 PHP controller 的创建/编辑 `postMore`（`StoreProductCategory.php:107/142`）将缺省 `is_show` 设为0。本批写服务遵循该合同：旧 POST 未传状态时创建隐藏分类，旧 PUT 未传状态时按隐藏状态完整编辑，不意外启用节点及子树。新建动态表单与现代 UI 可以默认显示，但须显式提交 `is_show=1`；编辑省略状态并不表示保留现状。

分类树的全部内容计算 SHA-256 `revision`，不依赖新DDL。现代前端在编辑、删除、状态写入提交 `expected_revision`；任何同 Supplier 树变化导致旧确认值409并刷新。旧未发送确认值的客户端暂兼容，仍有覆盖陈旧完整编辑的风险。

合法 GET（包括 create/edit 表单）只需 `supplier.product.view`；实际写操作需 `supplier.product.manage`，现代UI写控件和handler也要求manage。将只读动态表单 GET 改为manage会使旧数字GET菜单被错误解释成整个商品域写授权，因此不能借表单读取升级权限。

写服务在 scope 内核验 claims 的 `authVersion=md5(当前密码hash)`、严格expiry、当前账号类型/归属/启停与Supplier状态；审计后再次检查expiry。当前账号/Supplier SHARE锁、已选角色与数字菜单按ID `FOR SHARE NOWAIT` 保持授权到提交。菜单只需已有 `SELECT + UPDATE(id)` 锁权限，不授予菜单内容 DML；权限不足503，冲突409。未新建table barrier或扩大生产ACL。

读取使用 `REPEATABLE READ, READ ONLY` 快照。分类最多1,000条，响应最多2MiB，事务语句最多5秒、锁等待最多2秒；超限明确拒绝。匿名、无权和成功响应均 `private,no-store`。分类写锁只协调本批 Supplier 分类与 Supplier 商品保存；未经本协议的维护SQL或其他业务写入并不被 advisory 锁自动约束，生产接入仍需核查合作写路径。

## 可重复验证与边界

- `test/supplier-product-category-http.test.ts`：真实注册路由、JWT、账号/Supplier/RBAC与Drizzle SQL；默认隔离PGlite，可由专用loopback PG16夹具运行。覆盖旧/现代DTO、完整CRUD、旧创建/编辑缺省隐藏状态、移动后代/关系、两代引用、空body旧删除/状态、CAS、只读/无关角色、跨owner、密码/expiry、数字menu不升级、审计失败回滚、坏树和安全媒体拒绝。
- `test/supplier-product-category-concurrency-postgres.test.ts`：专用随机PG16数据库与四个真实连接，观察 `pg_blocking_pids` 确认争用；涵盖并发父移动、同父重名、真实商品及SKU保存与分类移动/删除的两个提交顺序、password变更、角色/menu撤权前后及真实受限LOGIN仅列级菜单锁权限。没有配置专用原生测试URL时明确不声称并发/ACL通过。
- `test/supplier-product-category-frontend.test.ts`：18项真实Vue setup/HTTP与预览树测试已通过；Supplier 完整应用类型检查 `vue-tsc -p tsconfig.app.json --noEmit` 与生产 build 已通过。Browser plugin absent，regular Playwright本机preview验证桌面1440×1000、手机390×844和只读会话，完成三级新增→编辑移动→同步停用→逐级删除、双图预览、保存按钮可见及写控件隐藏；严格锁文件 `npm ci` 安装 Vue 3.5.42 后再次完整复验，页面身份/非空/无框架overlay通过，console 0错误/0警告。4张截图再次人工复核。预览明确不证明真实数据库引用与权限，临时服务器已停止。

本轮最终统一源码复验：专用PG16分类HTTP **21/21**、原生并发/LOGIN **11/11** 与前端SFC **18/18** 均通过，覆盖最终审计method与旧写合同缺省隐藏状态修正。Worker unit/runtime 完整类型检查、Supplier `vue-tsc -p tsconfig.app.json --noEmit` 与生产 build 均退出0；严格锁文件重装后的桌面、手机及只读 Playwright 流程也全部通过。全批验证与源码证据汇总见 `parallel-product-catalog-migration-20261013.md`。没有生产读写、外部provider调用、提交、推送或部署；父项SUP-002仍包含其他商品类型、批量操作与真实账号发布验收，本批不关闭整个商品迁移。
