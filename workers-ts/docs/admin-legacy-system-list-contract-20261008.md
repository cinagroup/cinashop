# 旧 Admin 管理员与角色列表 GET 合同

2026-10-08 后续：旧角色创建/编辑 GET 和基本 POST 保存已由[角色表单与保存合同](legacy-role-workflow-contract-20261008.md)承接，新增独立细权限。下文记录当时的列表批次；其中未实施表单的描述是历史状态，独立启停、删除和完整未知结果恢复仍开放。

本轮仅承接 `GET /adminapi/setting/admin`、`GET /adminapi/setting/role` 及对应 `/api/admin/setting/` 别名。新 `system_admin/directory`、`system_role/directory` 与原数组列表保持各自合同。本轮不承接旧新增、编辑表单、保存、启停或删除，也不因两个路径注册而关闭 `ADM-001`、`FE-001` 或真实账号、生产与发布门禁。

下述旧源实际位于 **`C:\cinagroup\cinashop-php`**；这是本机只读核对的 PHP sibling，不能把隔离工作树旁不存在的相对目录当作旧源缺失。证据为实际文件字节及行号，未执行旧 PHP，也未复制旧文件正文。

## 实际消费者和精确路径

旧 `view/admin/src/router/modules/setting.js:135`、`:144` 仍导入角色、管理员页面。两页分别在 `systemRole/index.vue:230`、`systemAdmin/index.vue:141` 的创建钩子读取列表，分页和搜索继续调用同一个 GET。

| 页面 | 请求包装器 | GET 路径 | 实际消费 |
| --- | --- | --- | --- |
| `view/admin/src/pages/setting/systemAdmin/index.vue:161` | `view/admin/src/api/systemAdmin.js:16` 的 `adminListApi` | `/setting/admin`，由旧请求层的 `apiBaseURL` 加前缀 | `res.data.list`、`res.data.count`；表格读取 `real_name`、`account`、`roles`、`_last_time`、`last_ip`、`status`，操作使用 `id` |
| `view/admin/src/pages/setting/systemRole/index.vue:278` | `view/admin/src/api/setting.js:349` 的 `roleListApi` | `setting/role`，由同一请求层加前缀 | `res.data.list`、`res.data.count`；表格读取 `id`、`role_name`、`rules`、`status` |

旧请求层 `view/admin/src/plugins/request/index.js:54` 使用 `Setting.apiBaseURL`；`:114` 开始处理 `{status,msg,data}` 信封。成功业务状态 200 返回整个信封，因此页面中的 `res.data` 是业务数据，不是 Axios 外层响应。400、400011、400012 会拒绝并保留 `msg`；410000、410001、410002 清登录并跳转。页面失败时关闭 loading、显示 `res.msg`，保留原列表；不将失败替换为空成功。

## 请求、空结果与分页

| 参数 | 管理员列表 | 角色列表 |
| --- | --- | --- |
| 搜索 | `name`；PHP 只匹配账号或姓名，不包含手机号 | `role_name`；匹配角色名称 |
| 角色筛选 | `roles` 为空或一个角色 ID；PHP 使用逗号分隔成员匹配，不能把角色 1 匹配成 11；新 parser 也将 `'0'` 视为无筛选 | 不适用 |
| 状态 | `status=''`、`'0'`、`'1'` | 同左；旧 Select 的 0/1 为字符串 |
| 分页 | `page`、`limit`；旧页面默认 1、20 | 同左 |
| 删除参数 | PHP 控制器读取 `is_del`，但模型固定只查 `is_del=0` | 不适用 |

PHP `BaseServices.php:34` 按 `/d` 取整，缺省为 0/0，超过配置上限时截到 100；`config/database.php:74` 定义 page/limit 键和上限。返回的第三个 `defaultLimit=10` 没被这两个列表服务使用。`SystemAdminDao.php:39` 仅当 page、limit 均非零时分页；`SystemRoleDao.php:53` 直接调用分页。两个 DAO 均没有显式排序。这些是旧实现事实，不是新增实现应保留的无界查询要求。

旧服务正常返回 `data={list:[],count:0}` 表示空匹配；有匹配但页码超出末页时可返回 `list=[]` 与非零总 count。响应不要求 `page`、`limit` 或 `total`。新兼容实现默认 1/20，page 1–500、limit 1–100、偏移最多 10000，按 ID 降序稳定分页；明确拒绝重复、未知、非法参数。关键词最多 64 字符，无控制字符，按字面子串搜索并转义 `%`、`_`、反斜杠。默认、有界参数、字面搜索和 DESC 都是明确的安全或确定性差异，不能记作旧 PHP 本来具有的保证。

## 层级与显示字段

PHP 管理员 `SystemAdmin.php:38` 和角色 `SystemRole.php:37` 均把查询 level 设为 **当前管理员 level + 1**。两个模型的标量 `searchLevelAttr` 都执行等值比较；不是 `>=`，也不是展示所有层级。新兼容服务必须依据事务内实时身份和权限决定这一层级，不能只使用迟到的前端状态或旧登录缓存。

管理员 `SystemAdminServices.php:185` 取得分页和 count 后，按角色 ID 查名称；旧 `getRoleArray(['type'=>1])` 没有状态过滤。模型先将数据库 roles 逗号串解为 ID 数组，再由服务转成**角色名称逗号串**供旧标签显示。未知 ID 不解析成名称。`_add_time` 是 `add_time` 的 `Y-m-d H:i:s`，`_last_time` 是同格式的最后登录时间；最后登录秒数为 0 时是空字符串。`config/app.php:38` 指定 `Asia/Shanghai`。`_add_time` 在 add_time 为 0 时仍格式化 epoch，不能一起置空。

兼容服务显式管理员投影为：`id/account/real_name/phone/roles/level/status/last_ip/last_time/add_time/_add_time/_last_time`。其中 roles 必须为展示名称，不可直接返回现代 directory 的角色 ID 字符串。PHP DAO 原来使用 `*`；其模型未在该列表处隐藏密码，因此新增实现只保留安全字段白名单，不复制原始整行、密码或登录凭据。

角色 `SystemRoleServices.php:75` 将原数字菜单 rules 查成 `menu_name`，再拼接为**权限名称逗号串**供列表显示。这与详情表单需要的原始规则 ID、以及现代页面的 `permissionKeys` 都不同。兼容角色投影为 `id/type/relation_id/role_name/rules/level/status`。数字 rules 只读取平台菜单 `type=1`、`is_del=0` 名称；现代已登记符号权限用权限目录的组名和操作中文标签；未迁移数字 ID 显示“未迁移菜单 #ID”，未知符号显示“未识别权限”，不悄悄丢掉历史规则。

## 明确的范围和安全差异

- 管理员列表固定 `admin_type=1`、`is_del=0`，排除删除状态；保留精确下一层级、姓名/账号搜索和角色 ID 成员筛选。手机号仅是返回字段，不新增到旧 `name` 搜索。
- 角色列表与管理员显示名称的角色查询只允许 `type IN (0,1)`、`relation_id=0`、非删除状态。不能为了补齐某个 ID 的名字再查供应商、门店或其他关系。管理员展示关联到跨域、删除或未知角色 ID 时不暴露其名称。
- PHP 角色控制器传 type=0，但模型 `searchTypeAttr` 的 `if ($value)` 忽略 0，旧查询可能没有该类型限制。新增明确的平台范围有意修正这个缺陷；不能继承跨域名称泄漏。平台 type=0 为现代角色，type=1 承接导入历史。
- 计数、当前页、角色名和菜单名在同一有界 `REPEATABLE READ, READ ONLY` 快照中读取。新增只读语义、实时授权、禁止缓存与本地查询超时不是旧 DAO 的保证。
- 原 TEXT rules 过大时明确拒绝：每行最多 16384 字符、每页最多 10000 个去重规则 token；返回服务不可用错误，不截断为看似完整的权限串。原 numeric 规则及现代符号规则的展示不会改变授权来源。
- 旧数字菜单与 API 规则分别授予 `system.legacy_admin_view`、`system.legacy_role_view`，仅承接对应旧 GET。现代 `system.view` 可以单向承接旧 GET，旧能力不能反向授予现代目录、兄弟列表或写权限；两能力可以在权限树中独立选择，委派使用同一单向规则。未实施的旧 create/edit/set_status 和写入口不登记权限。

## 本轮之外

`GET setting/admin/create`、`GET setting/admin/:id/edit`、`GET setting/role/create`、`GET setting/role/:id/edit` 仍是独立表单合同；旧 POST/PUT/DELETE 保存、启停和删除仍需完整锁内防自锁、最后超级管理员与角色引用保护，以及可核对的写入结果。列表中的可见按钮或数据显示不证明这些操作已迁移。个人中心、历史菜单完整映射、旧端真实账号、生产数据规模、Hyperdrive、真机和发布验收也不由本轮两个 GET 抵扣。

## 旧源字节证据

下表均相对实际旧源根 `C:\cinagroup\cinashop-php`，SHA-256 为本轮只读核对时对完整文件实际字节计算；不是 Git blob ID 或未来收据。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `route/admin.php`（列表及资源注册见 1754、1986、2005） | 183912 | `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652` |
| `view/admin/src/api/systemAdmin.js:16` | 1773 | `18aa0fa23e4fe380a6c97e8614d0dfc03bc9e90893e69012c36aab968e1126ab` |
| `view/admin/src/api/setting.js:349` | 22820 | `e1f1fe9d8889821e5b9b3ae95dd843168d142620a3fd783868f980474cb011f3` |
| `view/admin/src/pages/setting/systemAdmin/index.vue:161` | 8658 | `a4ec4bf084e37534b0b6517b86f5a3b6118b51897c9cd75a418ebd4b22f850be` |
| `view/admin/src/pages/setting/systemRole/index.vue:278` | 12792 | `09cd7ad3f2eaa7ca46b2c1d3c57508a8b582036520988885610b1fca46c87430` |
| `view/admin/src/router/modules/setting.js:135` | 22602 | `e9ce32dba8609dbeef18438a9e9e14d0081844c5c4e783edbc1a374eb1cee554` |
| `view/admin/src/plugins/request/index.js:114` | 6699 | `9dd5ce11bee5aaf3c43c0ca7215993866e1fac85cd444024f37dc576d08644d5` |
| `app/controller/admin/v1/system/admin/SystemAdmin.php:38` | 5655 | `ae777610e24a042fead49dd46905edf38f907c99a14f154e53e8acd3050ec8f7` |
| `app/controller/admin/v1/system/SystemRole.php:37` | 4396 | `840a56aae2b1d48ce7edba94882697d6bab7f643ddca560f07839b8fa10a5b03` |
| `app/services/system/admin/SystemAdminServices.php:185` | 18386 | `968cde386e8c74721de5ab32bf860dbadd16c60d0ed5a87652fb7f12322c9998` |
| `app/services/system/SystemRoleServices.php:75` | 6642 | `9c85f2b36a3584e6fb87fc79a20a819001a13c5e1490a7a20513794cdf7d906d` |
| `app/dao/system/admin/SystemAdminDao.php:39` | 3656 | `1456d05c17a35d7f0e8079b4bdcf197e396c25bb8df8f0a0e0c3a2294881c689` |
| `app/dao/system/SystemRoleDao.php:53` | 1736 | `7fd7a2257e6d4de43f6dbb2d2919d46aba4928886a4b8b2711e104612135132c` |
| `app/model/system/admin/SystemAdmin.php:49`（搜索器见 74、88、124、146） | 4116 | `b8ea9a43378831b768c81c443a43e0e66a3e07cf69cc0c89c63d6ce355ae2f69` |
| `app/model/system/SystemRole.php:54`（状态、层级见 74、86） | 2679 | `ae373d82cdcc211f29419035de96c025c3d6b8e5670e8974a8639c67115eebe4` |
| `app/model/system/SystemMenus.php:122` | 5526 | `0f37db41e2b2b63c8626f1eccd12d8f06b3e1dff1a5431081efcfed3e1898955` |
| `app/services/BaseServices.php:34` | 14915 | `c56396bf827787d5ab8d80bfa70687697582abfe3b3cd1c6ce43867b7b80b7e9` |
| `config/database.php:74` | 3418 | `7eddd37e76e5ef96fd2f32a3923b6a5878cdf8e4754e4ff16dec28b7762b3d7f` |
| `config/app.php:38` | 1807 | `2fb949c2609d813c05ae974aef4379957decc2be6ad56d56be822c264820cfb3` |

## 验证状态

**本批本地验证完成，未发布。** 实际 PHP/旧 Vue 字节与服务投影、parser、平台名称范围互核；另两次独立只读审查确认旧规则没有扩大现代读取范围。实际运行结果和当前源码 SHA-256 见[本批验证收据](../audit/admin-legacy-system-list-validation-20261008.json)，日志保留在收据中的本任务绝对路径。

| 最终计入的验证 | 数量 | 实际结果 |
| --- | ---: | --- |
| 旧列表业务与两能力隔离 | 23 | 17项PGlite/Hono业务＋6项权限：JWT、两别名、下一层级、DTO、参数、只读边界、权限互斥、现代读取/写入拒绝与事务内复核；最终两测试文件退出0 |
| 既有权限、现代目录、批量通知回归 | 43 | 24＋12＋7项，实际49项执行退出0；其中6项旧权限被上行最终重跑替代，不重复计数 |
| 原生PG16列表与既有FAB权限 | 8 | 3项独立LOGIN列表并发＋3项FAB真实SQL＋2项FAB规则，零跳过、退出0 |
| 原Admin调用审计与PHP注释解析 | 7 | 新快照由当前源码重算一致，原断言不变；退出0 |

当前唯一测试合计 **81项**，各组不等同于81项SQL效果。列表原生测试在真实count完成后，等待另一连接的事务实际提交，再读取行和名称；同一`REPEATABLE READ, READ ONLY`快照保留原值，新调用读取提交后值。实际验证PG16、同数据库/不同PID、受限LOGIN，非登录列UPDATE报42501；仅有登录字段UPDATE权限的连接在列表只读事务内报25006，整事务回滚后后续读取有效。`FINANCE_LOCAL_FIXTURES remaining=0`与`FINANCE_LOCAL_STOPPED`均实际输出，另`pg_ctl status`确认退出3/无服务运行；本地集群数据和日志保留。

两套原Worker完整类型检查最终均退出0，使用项目既有`--max-old-space-size=8192`配置。首次遗漏该配置导致默认Node堆耗尽/退出134，第二次发现两个新增测试的transaction/Node URL类型错误/退出2；均保留原日志，修正测试的真实类型后重跑23项业务/权限及两套类型，不削弱断言。早期16/17项执行及旧目录迭代结果不重复计入当前81项。

原路由CLI实际退出0：Worker2338／PHP1904，旧URL可执行892／可行动缺口974，有效覆盖47.3%；Admin缺口906。原Admin调用CLI实际退出0：602处调用／633变体全注册可执行，未解析、未注册和受控不可用均0。[路由分布](../audit/route-distribution-legacy-system-list-followup-20261008.json)和[Admin调用快照](../audit/admin-frontend-api-contracts-legacy-system-list-followup-20261008.json)保留本轮结果。本批前端源码未改，无新增构建或浏览器信用；原页面盘点与Uni发布账本CLI实际结果记录在验证收据。

Checklist维持404总项／249完成／155开放；原写入、表单、旧完整登录/菜单、真实生产账号和规模、Hyperdrive、Linux新提交CI及发布仍开放。当前本地PG证明不抵扣这些合同，旧CI或生产发布不计本批信用。
