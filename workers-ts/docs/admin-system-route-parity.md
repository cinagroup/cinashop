# Admin system 旧路由逐屏代码审计

本批以 `audit/admin-frontend-inventory.json` 为权威分母，审计 `/admin/system*` 且 `surface=page` 的 **17 条**旧业务路由。`/admin/system.User/list.html` 是辅助组件，不在 274 条业务页分母内；同在旧 `system.js` 的 `/admin/out*` 属另一个路径域，不在本批。`audit/admin-legacy-system-route-parity.json` 由 `scripts/admin-system-frontend-parity-audit.ts` 生成，逐条给出旧路径、组件、`meta.auth`、目标页面/API/权限、已覆盖行为、缺口和证据。

旧路由快照分别来自 `routes.js` SHA-256 `9432b5a0b65c09adaf828dbb7125352eea94c54b444f5197647c59aa40fe13c2` 与 `modules/system.js` SHA-256 `f84e11ebb974799f4cf3da05daa772c9b973c07960ddb6e86fcef823b58cb0ff`。旧 `meta.auth` 和组件行为行号是本地审阅后的静态证据。生成和 CI 只使用本仓库的权威清单及新代码，不依赖相邻 `cinashop-php` checkout；路由快照变化需重新审阅，旧组件独立变化也需人工复核行号。

| 状态 | 路由数 | 具体边界 |
| --- | ---: | --- |
| candidate | 0 | 尚无可按旧屏完整操作并等待生产验证的 system 页面。 |
| partial | 4 | 个人资料可由管理员编辑部分字段、素材中心只处理图片、操作日志只提供固定分页、定时任务只保留历史只读目录。 |
| missing | 12 | 旧屏主要操作无新 Admin 入口；只读或 CRUD API 单独存在不算页面覆盖。 |
| retired | 1 | 旧在线升级页将版本、日期和说明写死，按钮无下载处理器，是静态占位页。 |

重要的语义区别：

- `/admin/system/log` 是本浏览器 `admin/log` Vuex 前端事件及清空操作；新 `/system/log` 是服务端 `system_log` 操作记录。这两类日志不能合并。旧 `/admin/system/maintain/system_log/index` 才能部分映射到新操作日志页；旧时间、管理员、路径与 IP 筛选均未迁移。
- `/admin/system/user` 是当前登录者的个人中心，含头像、手机号验证码和旧密码验证。新 `/system` 是需要 `system.manage` 的管理员列表和编辑弹窗，可以改姓名、手机号、密码，但不提供等价自助流程；受限管理员的旧能力不能据此宣称完成。
- `/admin/system/file` 可管理图片和视频、分类树、重命名及移动。新 `/assets` 有私有 R2 图片上传、分类、搜索与删除；Worker 虽注册移动/重命名 API，页面没有对应操作，视频也未开放。
- `/admin/system/config/system_config_tab/index` 的 `config_class` CRUD API 仍在 Worker，但新 `/config` 是受控配置页导航，不提供旧分类树编辑屏。`.../list/:id?` 是动态配置字段定义和任意键编辑器，不能由少数白名单设置页代替。两屏保持 `missing`。
- `/admin/system/config/system_group/*` 是通用组合数据组及条目编辑器。新业务专用设置读取或编辑少量相关数据，不构成组目录、动态表头和通用条目增删改。
- 旧缓存清理、数据清除、数据库备份/导入、服务器文件编辑和完整性校验是不同维护流程；新素材 CRUD、Worker 缓存失效及平台部署不能代替这些旧屏。代码审计没有调用任何破坏性维护操作。
- `/admin/system/maintain/auth` 处理 CRMEB 商业授权与版权文案/图片。新后台没有该合同；是否正式废止仍待业务决定，因此保持 `missing`，没有推断退休。
- `/admin/system/crontab` 的历史任务名、周期、开关和 Worker 对应状态可在只读 `/operations/legacy-runtime` 查看。旧启停、创建、编辑、删除不会控制当前 Cloudflare scheduled/Queues；`create/:id?` 即使有旧任务详情 API 也没有编辑屏。

此前 setting 76、content 13、product 12、marketing 48、work 20 共 **169** 条已分类；本批后 FE-001D 为 **186/274 已分类、88 未分类**。这个数是逐屏完成语义审阅的数量，并非功能迁移通过数量。FE-001D、真实角色/数据浏览器验收及发布门禁仍开放，404 项 checklist 分母不变。本批没有生产读取、写入或部署。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-system-frontend-parity-audit.ts --write` 可重生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-system-frontend-parity.test.ts` 做定向复核。测试检查 17 条顺序和状态、六份台账与 274 条分母的交集、旧路由来源/新证据，以及字节级重生成一致。
