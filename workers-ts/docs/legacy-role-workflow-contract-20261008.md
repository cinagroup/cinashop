# 旧 Admin 角色创建、编辑与保存合同

本轮承接旧 Admin 的基本角色表单链：GET `setting/role/create`、GET `setting/role/{id}/edit` 和 POST `setting/role/{id}`。完整入口分别位于 `/adminapi/` 与 `/api/admin/` 两个 base；POST 路径 ID 为 0 时创建，正整数时编辑。旧列表合同继续有效。本轮没有修改旧 Vue 页面，不将接口登记、合成 UI 算法或本地 SQL 验证记作完整旧端浏览器、未知写结果恢复、独立启停、删除或发布完成。

旧源实际根为 `C:\cinagroup\cinashop-php`。以下证据来自可见 PHP、仍有活跃入口的旧 Vue、当前 Worker 和实际本地原始日志；没有执行旧 PHP 或 opaque helper，也没有假定运行中的旧库与安装 SQL 完全一致。

## 活跃消费者与原合同

`view/admin/src/api/setting.js:372–377` 的 `roleCreatApi(data)` 将整个 data POST 到相对 `setting/role/${data.id}`；`:384–389` GET `setting/role/${id}/edit`，`:394–399` GET `setting/role/create`。这是页面自己渲染的 Modal、Input、Radio 与 Tree，见 `pages/setting/systemRole/index.vue:94–126`，并非 `$modalForm` 或 form-create DTO。

创建按钮和编辑入口分别在页面 `:40`、`:67`。初始 `formInline` 在 `:192–197` 只有 `role_name:''`、`status:0`、`checked_menus:[]`、`id:0`。但 `add():235–239` 只把 id 改为 0，并不重建对象。编辑 GET 成功后，`:365–372` 用完整 `data.role` 替换 formInline，把其 `rules` 字符串赋给 checked_menus；取消和成功只 reset 已登记的表单字段并清空 checked_menus（`:443–460`）。因此“先编辑再添加”实际可能附带旧 `type`、`relation_id`、`level`、`rules`，不能把这些兼容回显误作客户端写入权限。

CREATE 的成功 data 为 `{menus}`；EDIT 为 `{role,menus}`。旧 `SystemRole.php:53–56,93–100` 返回的 role 是模型 `toArray()`；可见模型没有 rules 的数组 getter，`SystemRole.php` 模型 `:44–46` 仅在赋值时把数组拼为逗号串。安装表 `public/install/crmeb.sql:9701–9711` 有 id/type/relation_id/role_name/rules/level/status 七列，其中 role_name 为 varchar(32)、rules 为 longtext。新 DTO 明确只回这七列，rules 保持数字 ID 逗号字符串。

旧菜单服务 `SystemMenusServices.php:238–254,265–279` 读取 type=1、is_del=0 菜单，调用的 is_show 参数为 0；DAO `SystemMenusDao.php:44–49` 按 sort DESC、id DESC。它构造嵌套 title/id/children，未带 children 的根节点会被旧组树逻辑省略。客户端 `initMenu():400–414` 只对叶子初始化 checked，忽略服务端 disabled 等其它属性；提交 `:432–442` 则收集 `getCheckedAndIndeterminateNodes()` 的 ID。因此嵌套的真实父权限会在只改名称时丢失，或由子节点的半选父状态额外加入。不能用拒绝合法父子组合来掩盖这个损失。

旧提交只验证名称必填、status 是 number、至少选择一个节点（`:200–214,432–441`）；没有客户端层级、realm、正整数、去重或实时授权子集保护。PHP `SystemRole.php:64–84` 只提取名称、status 默认 0、checked_menus，拼为 rules；路径决定创建或更新。创建层级为 actor.level+1，而编辑是通用 ID 更新。旧 auth 服务 `SystemRoleServices.php:92–115` 对未登记 API 存在放行分支。这些旧缺陷不是本轮允许复制的合同。

## 请求、响应与细粒度权限

| 接口 | 当前请求 | 成功 data |
| --- | --- | --- |
| GET `setting/role/create` | 不接受任何 query。 | `{menus:[...]}` |
| GET `setting/role/{id}/edit` | 正整数路径 ID，不接受任何 query。 | `{role:{id,type,relation_id,role_name,rules,level,status},menus:[...]}` |
| POST `setting/role/{id}` | JSON 对象；路径 0 创建，正整数编辑；不接受 query。 | `{id:number,created:boolean}`，消息区分添加与修改。 |

`AdminLegacyRoleController.ts:7–23` 取实际认证设置的 actor ID、密码版本和过期时间，对读写均设置 private/no-store；JSON 解析失败明确校验错误，不转成成功。canonical 注册见 `routes/adminapi.ts:850–852`，v1 同 handler 见 `routes/v1/index.ts:2013–2015`。

GET 要求 `system.legacy_role_form_view`，或单向兼容已有 canonical `system.view`。POST 要求 `system.legacy_role_manage`，或已有 canonical `system.manage`。fine manage 只包含旧角色表单与旧角色列表；原 `system.legacy_role_view` 仍只有名单读取，不能因为旧数字规则获得现代全层级目录或写权限。新权限规则及单向 fallback 在 `AdminPermissionService.ts:280–290,334–338,455–457`。

POST 仅接收 `id,role_name,status,checked_menus,type,relation_id,level,rules`。可选 body.id 必须是与路径一致的整数；名称 trim 后为 1–32 个 Unicode 字符并拒绝控制字符；status 缺省为 0，仅接受数字 0/1，null 不作缺省。checked_menus 是 1–2048 个正整数数字 ID；字符串、空数组、稀疏数组、非法或超界 ID 拒绝。有效重复 ID 去重并按数值升序持久化；rules 编码不超过 16384 字符。type/relation_id/level 只接收有限整数回显，rules 只接收有限字符串回显，四者不决定写入域、层级或权限。未知字段拒绝，见服务 `:29–77`。

路径不接受空、负数、前导零、指数、小数、空白或超出 2147483647 的值；GET edit 不把 0 解释为创建。普通 Validate/NotFound/Auth 仍沿既有 PHP 兼容业务信封；明确冲突 409、容量 503 为真实 HTTP 错误。不要将 `body.status` 和 HTTP 状态混为一谈。

## 无损菜单选择与保留旧权限

新菜单目录只含当前 type=1/access=1/is_del=0、路径可完整表达且 actor 可委派的真实 grant。每个 grant 使用其原正整数 ID，恰好一次，以独立叶子 `{id,pid,title,children:[]}` 返回；pid 保留原值，title 为完整祖先名称路径，排序仍为 sort DESC、id DESC。父权限、子权限、父加子是三个独立合法集合；重新 GET 和只改名称 POST 不得推导、增加或删除真实 grant。

纯结构祖先没有自己的 grant，不作为可选叶子，也不持久化。如果旧请求含结构 ID，只有在它确实是已选 grant 的祖先、且 auth_type=0、API/页面/unique_auth 均为空时才允许规约剔除；结构孤叶、不相关结构或仅结构选择拒绝。所有真实 mapped 或 eligible opaque ID 都必须保留，不能靠“没有现代映射”把旧权限当目录抹掉。

mapped grant 的每个当前 permission key 都必须在 actor 的实时授权集合中。尚未映射但 metadata 合格的 opaque grant 只允许 actor 实时原数字 ID 集合已有成员委派，超级管理员可委派合格 opaque；这不宣称该旧操作的业务实现已迁移。`AdminPermissionService.canRetainOpaqueLegacyMenu:530–565` 明确排除已审计的特殊 ID、身份对、已知权限声明和受保护 API；映射返回空集合的拒绝结果不能再包装成 opaque。service 的正 footprint 与 opaque 两支共享 genuine metadata 校验（`:111–129`）。超级管理员和已有 raw ID 成员也不能绕过此校验。

目录最多 10000 行，以 LIMIT 10001 判超限并返回 503，不截断为完整成功；路径有孤儿、循环或负父 ID时不可表达，已选旧目标明确冲突。可展示 grant 的祖先深度最多 64、标题最多 4096 Unicode 字符；超限返回 503。原生数字 rules 若缺失、混合现代字符串、越权或无法表达，则 EDIT/POST 返回冲突或授权失败，不盲写成空权限。现代字符串规则编辑继续由现代 API 承接，本轮不转换它们。

## 当前身份、作用域与事务

每次 GET/POST 都从数据库复核 actor 为 type=1/relation_id=0、启用未删除、level 0–9，并验证实际密码版本、角色关系、当前规则与 token 到期。目标角色必须 type 0/1、relation_id=0、status 0/1、恰好 actor.level+1；actor level9 的下一层级10合法。不能把现代接口层级上限误用于此旧合同。actor 自己正在使用的角色禁止修改，避免此入口自撤权。CREATE 固定 type0/relation0/nextLevel；EDIT 保留目标原 type，只更新 role_name/rules/status，见服务 `:85–106,179–185,218–243`。

GET 的授权、角色和完整菜单共享 REPEATABLE READ/READ ONLY 快照。POST 使用 READ COMMITTED，锁内重新读取 actor、assigned roles、authority menus、目标及请求目录；actor/角色/菜单共享锁和目标更新锁以 NOWAIT 取得，55P03/40P01 转成受控 409。决定所用的锁由原 withTx 持有到真实 COMMIT；到期在决策后和返回前再次检查。UPDATE/INSERT 必须恰好返回一行并核对全部七列，再真实读回比较，触发器静默跳过、改域或改权限不能假报成功。语句/锁/事务空闲超时分别为5s/2s/5s。

此保护不等于旧客户端未知结果恢复。旧 `handleSubmit()` 只显示成功或错误，没有 operation UUID、durable receipt、提交互斥或自动重试；request plugin `:155–196` 的 HTTP 异常分支甚至没有透传拒绝 Promise。服务不添加自动重试或凭目录重读确认未提交。尤其 CREATE 若响应丢失，不得声称可安全再发；现代恢复协议、独立状态/删除、最后超级管理员/完整管理员写链及整个父 workflow 仍开放。

## 物理源证据

下表 SHA256 是本轮对实际可见文件的本地读取，不是运行旧 PHP 的证明；行号见上文。除当前 Worker 两件外，路径均相对实际旧根。

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| `view/admin/src/pages/setting/systemRole/index.vue` | 12792 | `09cd7ad3f2eaa7ca46b2c1d3c57508a8b582036520988885610b1fca46c87430` |
| `view/admin/src/api/setting.js` | 22820 | `e1f1fe9d8889821e5b9b3ae95dd843168d142620a3fd783868f980474cb011f3` |
| `view/admin/src/plugins/request/index.js` | 6699 | `9dd5ce11bee5aaf3c43c0ca7215993866e1fac85cd444024f37dc576d08644d5` |
| `app/controller/admin/v1/system/SystemRole.php` | 4396 | `840a56aae2b1d48ce7edba94882697d6bab7f643ddca560f07839b8fa10a5b03` |
| `app/services/system/SystemRoleServices.php` | 6642 | `9c85f2b36a3584e6fb87fc79a20a819001a13c5e1490a7a20513794cdf7d906d` |
| `app/services/system/SystemMenusServices.php` | 11026 | `e3c784f7c768f2851f6b3ed6483729752c5477503b9dceafb2eb509670d711b2` |
| `app/dao/system/SystemMenusDao.php` | 3499 | `b1382c0505a02b9b37dcc5d22cb645c0c516c31d2b6506ff7ac04365f7be6280` |
| `app/model/system/SystemRole.php` | 2679 | `ae373d82cdcc211f29419035de96c025c3d6b8e5670e8974a8639c67115eebe4` |
| `app/http/middleware/admin/AdminCkeckRoleMiddleware.php` | 1490 | `61d841ef746d5e8031f9ad4d24bc351c7f742659f8fa0b4d62af8f2ce9e48881` |
| `route/admin.php` | 183912 | `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652` |
| 当前 `workers-ts/src/services/admin/AdminLegacyRoleWorkflowService.ts` | 17330 | `5bda5aa6404e8da9ffb3e1c0bae64524c2732f6ed28f0d3688d8023579fa1d3e` |
| 当前 `workers-ts/src/controllers/api/v1/AdminLegacyRoleController.ts` | 1559 | `459350de7a7148185e6e4a8ba21e322bcc0acc08fda7338c3030e4576207450c` |

当前 `AdminPermissionService.ts` 59336 bytes、SHA256 `dc56fc639d358fd4830e46773da4509980c44116d9c053b6fab2b5b1178b2ffb`。最终整批 Source 输入及 raw receipts 由本批 validation 另行绑定；不能用旧提交 CI 证明本轮源码。

## 最终本地验证与信用边界

已物理读取最终 business03 stdout/execution：PGlite/Hono 1文件23项通过，含五个真实 ID 回传组合、echo/scope、细权限隔离、特殊 metadata 拒绝、结构祖先、当前身份变化和10000/10001容量；它不是真实 PostgreSQL 或完整旧 Vue 浏览器。业务01真实失败记录保留，business02通过但因Controller类型修复后重验被替代，不重复计数。

Root 的 regression01 实际退出0、5文件63项；audit-regression01 实际退出0、2文件7项。最终 business03 23项、native02 4项均退出0，共 **97唯一项（23+63+7+4）**。两套标准 Worker unit-types02/runtime-types02 完整 noEmit 均实际退出0，stdout/stderr各0；runtime结束于2026-10-08T10:35:24.101Z。薄静审不算测试，未将历史执行再计一次。

两套 types01 曾均实际退出2：Controller :15/:22 的 path param 类型为 string|undefined。Root 仅在这两处增加 `?? ''`，共12 bytes，缺省值仍由严格 parser 拒绝，正常已注册路径不变；其余生产源码哈希保持。types01失败、business01失败及被替代business02/native01原始记录保留。类型修复前Controller1547 bytes/SHA256 `838bdea479541657730f779aaf9dacda9b352be6fa3709d09a5a8b749b136163` 是历史输入，不冒充最终源码。

最终 native02 为本机PG16.15/version160015、独有 tlEv3X/port62777。真实SELECT-only LOGIN验证GET的RR READ ONLY；App/Admin两个独立LOGIN经实际 runtime middleware/controller 完成受限写入，App直写42501拒绝。P-only/C-only/P+C由实际GET→旧leaf初始化规则→实际POST验证精确数字规则不变。实际POST遇未提交assigned-role或authority-menu撤权时NOWAIT受控409、其提交后再次拒绝；另一真实service callback已完成而COMMIT未发的屏障，通过两个revoker的pg_blocking_pids同时证明决定锁保持到真实保存事务提交，三表全行只出现声明的创建及两项独立撤权变化。测试没有替换原SQL或返回结果，也没有以固定fixture PID冒充新保存会话；它是local Hono实际middleware/controller，非完整main mount或旧Vue浏览器。

native02 stdout记录 fixtures remaining=0、自停；Root独立pg-stopped-status02实际exit3/no server running，检查2026-10-08T10:37:24.959Z。native01的rvvj1N/port50228同样自停并有独立status3，保留为被替代执行。两份native stdout中的finally对已提交事务ROLLBACK产生25P01 warning原样保留，未声称日志零警告或将其吞掉。未读取真实生产角色或调用provider。

Root 两个原审计 CLI 实际退出0：PHP1904／Worker2349；917精确匹配中896可执行、21受控不可用；987未匹配减17有据退役为970可行动缺口，有效覆盖47.5%。Admin902；API11／Supplier49／ERP8、Kefu/Out0。旧 GET create/edit 与 POST 三个精确 URL 实际补齐，另有三个 v1 别名，不能把六个注册入口说成六个旧缺口。当前 Admin602调用／633变体全部注册可执行，未注册/未解析/受控不可用均0；这不是业务或生产验收。

本批外部 Q 根为 `C:\Users\cina\.codex\visualizations\2026\09\26\01a0db11-74a0-7cc2-b1f9-ee3b8653056a\checklist-route-contracts-20261008\legacy-role-workflow`。最终业务、原生、类型原始execution/stdout/stderr均在Q；被替代业务02的原始日志另位于 `C:\cinagroup\cinashop\.cache\admin-system-implementation-20261008\admin-legacy-role-business02`。

| 原始实际证据 | bytes | SHA256 |
| --- | ---: | --- |
| Q `business03.stdout.txt` | 4637 | `1acd27e57e1cda3ef20bf1a63764d3e3dd0de2f23a58f427be3d2f20cf2ff233` |
| Q `business03.execution.json` | 537 | `e73b6c3e638749e4aa0a5ba544644abd9318328a31c376b678f9a73834b4eb5f` |
| Q `native02.stdout.txt` | 3671 | `6824aa843b547c753c7f37b7347c4887a367de468ffd2a5e51dfbab03249aff9` |
| Q `native02.execution.json` | 556 | `850b5ae3c1b979f63ac9bf9a82d67d85947d13c5750e8ce70d8ed8f1b1d88946` |
| Q `pg-stopped-status02.json` | 534 | `dff79c171cc38687b69a9196e8f430181c24458fc206f0d169358d833aadb97b` |
| Q `unit-types02.execution.json` | 422 | `d1996557718ebbc357a432ef20a4d03a031460096644fcdfeb2fce55e0ba7890` |
| Q `runtime-types02.execution.json` | 469 | `f68ced58e7210c4c24b51622f38e9454c9c47cc30de9450a882f5b1198865b0d` |
| Q `regression01.stdout.txt` | 275 | `b140a6b2376f9672c6282dd3b9486026b6e0cf4bbccaf398d1b151c9b406c07a` |
| Q `regression01.execution.json` | 694 | `26ccda19a85dc447aec9483773ec5b9c16a907471966350e5822c735c9f34d10` |
| Q `audit-regression01.stdout.txt` | 270 | `3dbe6d3fb138daa36b9a8e416a4013f7279ff4829cd4dae998b6cf142157710d` |
| Q `audit-regression01.execution.json` | 559 | `eda4ccd4c12ef71bc97555933dce953166776213b5ea0896a4706b927977e383` |
| Q `route01.json` | 1300501 | `ec42a39090c83be1d787fa2fd8bbda564ee82d1eeb3e3a944e8b1e0fcf3b2d32` |
| Q `route01.execution.json` | 398 | `6bfc7630387e19d9c35e860d31efc8555589654e546f3dcb27b995484080849a` |
| Q `api01.json` | 380116 | `9d6cbd183efa710df3d29cd80c69d24c8385bc6e286f05049b68a48cc036d301` |
| Q `api01.execution.json` | 418 | `9cb6b41340b2d93078881fcf7f4307b60f3065f5b12eaa894f328dfa20587d37` |

以上已完成命令的 stderr 均0 bytes，SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。页面与 Uni 账本未改，Checklist仍404总项/249完成/155开放，全部复选行保持。完整 Admin/角色工作流父项、原客户端未知结果恢复、独立启停/删除、真实生产角色与数据、provider/设备/Hyperdrive、当前 Linux CI、推送和部署不由本轮证明。

实际路由与当前前端快照见 [route distribution](../audit/route-distribution-legacy-role-workflow-followup-20261008.json)、[Admin consumers](../audit/admin-frontend-api-contracts-legacy-role-workflow-followup-20261008.json)。Root在这三份文档冻结后汇总原始收据与最终Source输入的入口为[本批验证收据](../audit/admin-legacy-role-workflow-validation-20261008.json)；本合同不预填commit/push/deploy。
