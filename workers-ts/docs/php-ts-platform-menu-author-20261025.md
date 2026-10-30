# PHP → TS：平台权限规则完整作者（2026-10-25）

本批承接固定 PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 的平台 `type=1` 权限规则作者。它是本地实现与验收切片；整个迁移目标仍开放。本批没有部署、连接生产库或调用真实外部账号。

## 已实现行为

入口 `/system/menu-rules`，保留精确旧 URL `/admin/setting/system_menus/index`。原 PHP 的 11 类活跃控件为 `pid`（父级路径的叶 ID）、`auth_type`、`menu_name`、`methods`、`api_url`、`menu_path`、`unique_auth`、`icon`、`sort`、`is_show`、`is_show_path`。页面提供菜单/API 两分支、完整父目录、添加子规则、编辑、显隐、删除确认、搜索与分页、已注册接口目录搜索/重置/拾取、完整 860 项原图标 token 搜索/选择。图标按类型字符串维护，不加载原 IView 字体或远程素材。

目录顺序为 `sort DESC,id ASC`；名称、页面路径、权限标识、API、ID、父ID均可搜索，并保留原 LIKE `%`/`_` 语义。筛选不影响完整父目录。现代界面使用迭代图结构，孤儿和循环组件仍可见；5000节点链不会递归渲染。旧嵌套树/表单在128层以上明确拒绝，完整平面目录仍是修复入口。

`/adminapi` 和 `/api/admin` 两前缀各登记11条精确端点：旧 `setting/menus` resource、create/edit表单、详情、show、`setting/ruleList`，以及现代完整 catalog/owner receipt。旧列表返回树数组，表单提供原 radio options 与 `menu_list.props.data`，旧读写只接受 `type=1`。版本化作者请求提交11项与UUID/完整目录版本；旧无意图调用先读取快照，再经相同写入门禁。旧客户端本身没有持久化UUID，不能冒称拥有现代页面的丢响应恢复能力。

原 `module/controller/action/params/header/is_header/access` 未作为活跃字段重新开放；更新完整保留这些历史值，SQL写后逐列核对。历史负排序、未变化的旧API/页面tuple和另一分支的字段可以保留；新负排序、外域路径、未知图标token、未注册API及不匹配method被拒绝。新/改API需选择当前真实注册且映射稳定权限的单一GET/POST/PUT/DELETE；接口显式保存为显示。未凭原表单提示发明空 `unique_auth` 的自动生成hook。

当前 Admin 导航仍由固定权限目录生成。编辑旧菜单元数据不会加载任意组件、动态注册前端路由或使未迁移页面可访问。

## 权限、引用与数据库能力

读取使用独立 `system_menu_rules.view`；写入同时要求实时 `system_menu_rules.manage` 与 `level=0`。Worker中间件之后，事务再校验平台realm、relation/status/is_del、密码版本、角色历史与JWT期限；授权检查覆盖提交前后，不能依赖过时UI快照。撤销目录授权后，仍可由活身份读取自己的原操作回执。

所有角色行都纳入版本与引用保护，包含停用、未分配、跨scope坏引用，以及保守识别的前导0数字引用（不将它们称为现有效grant）。已引用规则禁止改变 `auth_type/methods/api_url/menu_path/unique_auth` 或删除；名称、图标、排序等非授权元数据仍可改。新分配ID命中悬挂数字角色引用时整事务拒绝。删除保留永久 `is_del=1` 留档，函数不接受显式插入ID或undelete。存在任何活子节点时拒删；显式换父级完整校验父链，并原子更新后代派生path。

新增 `cinashop_admin_platform_menu_write_v1(text,integer,text,jsonb)`，固定type1且仅create/update/show/delete。Admin仅有该函数EXECUTE；`system_menus`无Admin裸INSERT/UPDATE/DELETE/TRUNCATE或sequence权限。独立受限NOLOGIN属主仅持有必要菜单DML/序列和角色SELECT能力。原type4函数、原authority writer、固定全店stage plan字节未改。

写入与角色作者采用相同staff/role → menu锁序，NOWAIT冲突明确409。catalog强检查函数原字节、属主、ACL、表形状和回执addon；系统菜单若有用户trigger，只接受经原 `inspectRuntimeAdminBoundary` 完整核验的唯一既有边界trigger，其它新增/禁用/替换均不接受。未安装或漂移时页面显示只读状态，HTTP请求不执行DDL或修复grant。

独立显式维护入口为 `runAdminPlatformMenuWriteUpgrade(db,{database,app,admin,maintenance,owner})`。仅PG16、精确已有运行profile、独立maintenance/App/Admin身份、受限NOLOGIN owner可安装；维护锁、实际DDL/GRANT、前后catalog/ACL验证同事务提交。实际中断验证证明DDL/GRANT失败会回滚。生产安装需另行维护执行；本批只在隔离测试库运行。

独立 `admin_platform_menu_operation` 存储actor/UUID/operation/menuID/payload hash/revision/时间，不存token、表单正文或密码。Admin仅SELECT/INSERT，App无权限，UPDATE/DELETE/TRUNCATE受不可变trigger保护。同事务完成菜单变更、完整回读和回执校验；同UUID/actor/操作/正文摘要只重放。页面在发请求前先持久化原意图，未知结果暂停新写；404只允许用户主动原样重试，不表示未应用。只有已完成回滚的精确业务拒绝才返回匹配的not-applied proof。

完整目录超过5000项、角色超过10000项或规则合计4MiB时关闭写入并明确拒绝，不静默截断。

## 验证与证据

最终唯一选测 **2780项**：前端564（57本域+507相邻页面/Pages proxy）、后端/来源2214（66本域实际SQL/Hono/JWT+2148来源/相邻，其中146本域来源）、原生PG16两项（本域与个人中心维护回归）。本域新增270项。重复排查、失败轮次和同一用例的再次运行不累加。

- Admin vue-tsc、Worker strict tsc、Vite build及新鲜API audit均通过。API目录从717/755增加到 **723调用点/761路径变体**，761全部已注册且可执行，unresolved/unregistered/controlledUnavailable均0。
- 实际PGlite执行catalog、受限角色/函数/trigger SQL、事务与注册Hono/JWT；唯一driver端口为session authorization，不能称独立LOGIN。单独PG16.14临时集群证明真实独立LOGIN、最小ACL、维护中断回滚、staff/menu锁冲突、服务四动作/回执重放、永久留档及漂移拒绝；fixture残留0，集群均停止。
- 实际Vue SFC以 `cacheHandlers:true` 编译，调用真实模板发行的native/Element回调，覆盖快速连续输入、编辑/类型/父级/筛选/来源/会话/路由/卸载ABA、摘要await、未知结果/缺失/错配回执和精确持久化清除。
- 构建后GUI用已安装Playwright/Chrome验证（Browser插件未提供），地址 `http://127.0.0.1:5211/admin/setting/system_menus/index`，1365×960、375×900、320×900。流程：旧alias→历史负sort编辑/脱离DOM旧按钮→菜单+完整图标→API拾取→显隐/删除→引用拒绝→丢响应回执恢复→窄屏。八张最终截图逐一检查；无Vue warning/pageerror。控制台仅有受控引用拒绝HTTP400与注入的ERR_FAILED各1；两条现有通知WebSocket使用明确本地端口，不连接外部服务。

本域来源证明 `workers-ts/audit/platform-menu-source-binding-20261025.json`：SHA256 `038ff45fc1a72a0fa79f0c956883a0a4dca7b19268d32aece8ecc2c59b9b9bce`。它绑定32份既有文件完整前后像、19份新增源、11份完整固定PHP原件（含860图标），保留1694份既有dated证据及10份关键实现原字节。新增外层读取适配可逆组合回已接受profile/异常页/浏览器日志/配置分类及更早来源；20个前驱测试只调整导入，不删断言或负例，不重写历史helper/proof。

完整本地工作与日志保留于 `/tmp/cinashop-platform-menu-author`。下一批只读准备为快递公司目录同步及账号作者闭环；35份全源与SHA已保存，不计本域实现或验收。
