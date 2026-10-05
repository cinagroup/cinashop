# 供应商菜单规则树迁移合同与缺口

2026-09-28 本地增量：新 `/supplier/menu-rules` 页面及双 Admin 前缀的列表、目录、详情 GET 已提供独立 `supplier_menu_rules.view` 只读审阅。列表只取未删除的 type=4 行，可按显示状态和关键词筛选；详情显示行版本、**原始数字角色引用**（包括停用或未分配角色）及规则**可映射**的稳定权限。固定 Supplier 导航目录单列展示，实际账号导航仍按其权限裁剪。旧通用 `/setting/menus*` 路径未因此获得精确覆盖。页面没有编辑控件，旧屏状态为 `partial`，不能当作菜单管理闭环。

服务端另准备独立的 type=4 受控写入协议，写路由以 `supplier_menu_rules.manage` 隔离；数据库能力未按审阅合同安装且通过目录/ACL 检查时，写请求以 503 关闭。该能力不会通过扩张 Admin 对 `system_menus` 的直接 DML 权限来实现。原生 PostgreSQL 安装、受限登录与角色权限回归是启用前门槛；本地代码和测试不代表生产已安装或发布。

旧 Admin `/admin/supplier/supplier/index` 是供应商权限菜单编辑器，不是 `/admin/supplier/menu/list` 的供应商目录。旧路由使用 `admin-supplier-supplier-index`；页面的“添加规则”及“添加子菜单”还使用通用 `setting-system_menus-add` 按钮标识。证据：`cinashop-php/view/admin/src/router/modules/supplier.js:24-32`、`cinashop-php/view/admin/src/pages/supplier/supplierList/index.vue:37-41,110-120`。

## 已确认的旧合同

- 页面按 `type=4` 读取 `GET /adminapi/setting/menus`，按 `is_show=1|0|空` 和关键词筛选树，显示 ID、名称、请求方式与路径、权限标识、页面路由、状态和操作；关键词实际匹配 `menu_name|menu_path|unique_auth|api_url|id|pid`，结果按 `sort DESC,id ASC` 排序后组树。证据：`supplierList/index.vue:14-31,43-120,299-307`、`cinashop-php/app/controller/admin/v1/system/SystemMenus.php:40-47`、`cinashop-php/app/model/system/SystemMenus.php:90-95,142-146`、`cinashop-php/app/dao/system/SystemMenusDao.php:80-84`、`cinashop-php/app/services/system/SystemMenusServices.php:81-86`。
- 表单包含菜单（`auth_type=1`）或接口（`auth_type=2`）、父级路径、名称、`menu_path` 或 `methods+api_url`、`unique_auth`、图标、排序、显示及隐藏路由标志；页面支持根节点、子节点、编辑、显示切换和删除。旧接口由 `Route::resource('menus', ...)` 七个方法/路径，加 `PUT /setting/menus/show/:id` 和 `GET /setting/ruleList` 组成。证据：`supplierList/components/menusFrom.vue:23-69,98-149,161-197,506-550`、`supplierList/index.vue:185-307`、`cinashop-php/route/admin.php:1752,1973-1984`。
- 旧 `system_menus` 的 `type=4` 确有供应商导航节点和接口规则；供应商登录按 type 4 加载菜单与 `unique_auth`。角色 `system_role.rules` 存数字菜单 ID。旧删除拒绝有子节点的菜单；接口规则保存时强制 `is_show=1`。证据：`cinashop-php/public/install/crmeb.sql:9518-9526,9591-9608`、`cinashop-php/app/services/supplier/LoginServices.php:113-121`、`cinashop-php/app/services/system/SystemMenusServices.php:220-225`、`cinashop-php/app/controller/admin/v1/system/SystemMenus.php:93-95,163-165`。
- 旧实现的裸 ID 详情、编辑、删除、显示接口没有验证目标仍为 `type=4`，不能照搬此漏洞。旧 `ruleList(4)` 按非 1 类型选择 `storeapi/` 和门店权限中间件，不是 `supplierapi/`，不能把该下拉结果视为供应商可授权接口目录。证据：`cinashop-php/app/controller/admin/v1/system/SystemMenus.php:108-115,135-165,178-207,230-274`。

## 基线 Worker 缺口与边界（只读增量前）

- `system_menus` 结构已保留，但 Admin 仅有稳定权限树 `GET /system_menus/tree`，没有 type 4 菜单 CRUD；路由分布快照中上述九条通用旧 Admin 路由仍未注册。这些通用路由还服务其他菜单类型，不能仅因新页出现就全量标为供应商菜单覆盖。证据：`workers-ts/src/models/schema/admin.ts:75-116`、`workers-ts/src/routes/adminapi.ts:746-751`、`workers-ts/src/controllers/api/v1/AdminCrudController.ts:1656-1659`、`workers-ts/audit/route-distribution-supplier-closure-followup-20260928.json`。
- Worker 把 type 4、`auth_type=2` 的数字菜单 ID 解释成稳定供应商权限，并在每次供应商请求时重新计算；供应商页面导航、角色编辑选项则来自固定 `SUPPLIER_PERMISSION_GROUPS`。因此编辑旧行的名称、`menu_path`、排序或显示状态不会自动改变新导航，编辑 `methods/api_url` 却可能立即改变已有子账号的有效授权。证据：`workers-ts/src/services/supplier/SupplierPermissionService.ts:28-41,151-181,245-276,279-294`、`workers-ts/src/middleware/supplier-permission.ts:9-20`、`workers-ts/src/services/supplier/SupplierAdminService.ts:404-418`。
- 现行数据库运行权限把 `system_menus` 作为只读配置，仅允许锁用的 `id` 列 UPDATE；应用运行身份的边界触发器拒绝实质菜单改写、插入和删除。单独增加 Worker CRUD 会在受限运行身份下失败。证据：`workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts:83-94,116-118,128-153,167-179`、`workers-ts/src/migrations/runtimeAdminBoundary.ts:10-41`。
- Admin 的现有 `config` 权限组匹配全部 `setting/`，若原样注册 `/setting/menus`，菜单写入可能被 `config.manage` 误授权；现有 `system_menus/tree` 也属于通用 `system` 组。供应商规则应有独立 `supplier_menu_rules.view/manage`，旧页面菜单 ID 仅在精确 `unique_auth=admin-supplier-supplier-index` 且 `menu_path=/admin/supplier/supplier/index` 时映射查看，不能沿用通用添加规则标识授予写权。证据：`workers-ts/src/services/admin/AdminPermissionService.ts:133-144,272-283,395-413,573-650`。

## 已完成的本地切分与剩余门槛

1. **只读清点已落地**：新 Admin 页面/接口读取 type 4 非删除树、节点详情、稳定权限目录及全部 type 4 角色的原始数字引用；`is_show=0` 可查隐藏节点，跨 type ID 返回不存在。双 Admin 前缀的独立查看权限、只读账号门禁和 `no-store` 已由 HTTP 测试覆盖。这一步只证明可审阅，不声称角色实际生效或恢复编辑。
2. **受控写入协议已在本地验证**：四条写路由独立要求 `supplier_menu_rules.manage`，数据库能力未安装时 503。专用 `SECURITY DEFINER` 函数由受限 NOLOGIN 身份拥有，Admin 登录只获该函数的 `EXECUTE`；普通应用登录无权调用，Admin 直接表 DML 不扩大。函数固定 type=4，校验同类型父级、无环、唯一规则、行版本、已有角色数字引用及子节点，引用中的接口方法/路径/启用语义不能改写，删除为受约束软删。服务端还要求新增或改动接口规则精确对应已注册且受保护的 Supplier 路由，写入和系统日志同事务。原生 PG16 的函数及双前缀 HTTP 已用受限登录验证；这仍是未发布的可选数据库安装，不表示生产已启用。证据：`workers-ts/src/migrations/adminSupplierMenuWriteCapability.ts`、`workers-ts/test/admin-supplier-menu-write-capability.test.ts`、`workers-ts/test/admin-supplier-menu-rules-native-http.test.ts`。
3. **菜单管理体验与实际角色验收仍开放**：前端没有创建、编辑、显隐或删除操作，固定 Supplier 导航不会由 `system_menus` 自动生成。上线前仍须在实际维护身份下安装并复核能力，使用真实受限角色检查 Supplier 登录、角色分配、每请求鉴权与导航显示，确认存量数字规则不会意外扩权；同时完成编辑界面、实际数据规模和发布后验收。未闭环前整屏保持 `partial`。
