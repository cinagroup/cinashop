# Admin work 旧路由逐屏代码审计

本批以 `audit/admin-frontend-inventory.json` 为权威分母，审计 `/admin/work*` 且 `surface=page` 的 **20 条**旧业务路由。`audit/admin-legacy-work-route-parity.json` 由 `scripts/admin-work-frontend-parity-audit.ts` 生成，逐条保留旧路由、组件、`meta.auth`、新 Admin 页面、Worker API、目标权限、已覆盖行为、缺口和源码证据。生成器要求 20 条路径和顺序与清单一致、旧路由 SHA 不变、目标页面/API 注册且本仓库证据文件存在；测试还检查五份台账互不重叠和字节级重生成一致。

旧路由及组件位置来自 `work.js` 的权威快照 SHA-256 `9d6dd8ff6a6c1f8adbcf0232cc70af3decf1cbe0b2245a6add7fc6fd85116ce6`。旧 `meta.auth` 及逐屏 Vue 行号是经本地源码审阅后固定的静态证据。CI 只需本仓库，不读取或要求相邻 `cinashop-php` checkout；快照哈希变化时需重新审计旧权限和行为。旧组件若独立于路由文件变化，仍需人工复核静态行号。

| 状态 | 屏数 | 判断边界 |
| --- | ---: | --- |
| candidate | 0 | 现有 Admin 没有可按旧屏完整操作的企业微信流程。 |
| partial | 8 | 有可用的 Admin 只读目录，但旧筛选、详情、统计或操作缺失。 |
| missing | 12 | 没有承接旧屏主要操作的 Admin 页面；API 单独存在或统一返回 501 不计为页面覆盖。 |
| retired | 0 | 20 条均有旧 Vue 组件，未找到可证明其是无效占位页的证据。 |

主要映射和误判边界：

- 新 `/operations/work` 是单个目录页，提供成员、客户、客户群、渠道码、客户群发、朋友圈和欢迎语七个只读 tab，以及独立的客户后置动作人工处置。目录可分页，常规企业微信同步、创建、编辑、删除、打标签及主动发送没有 Admin 表单；相应兼容写路由返回 `remoteWriteUnavailable`（501）。人工处置只针对 UNKNOWN/DEAD 后置动作，不是旧主动发送流程。
- 旧 `/admin/work/client/list` 同时有企微与非企微客户两个 tab。前者可部分映射到 `/operations/work` 客户目录，后者可部分映射到 `/user` 商城用户列表；新页面不具备旧客服/标签/时间筛选、企微备注、打标签、同步和非企微发券流程。
- 旧 `/admin/work/client/group_chat` 是现有客户群目录；`/admin/work/client/statistical/:id?` 是单群时间趋势和每日新增/退群明细。新群目录与全局群数摘要不能替代单群统计；群成员虽有 Worker API，却没有新 Admin 入口。
- 旧客户群发和客户群群发分别使用 `group_template` 与 `group_template_chat` URL，但共用旧 `GroupTemplate` 控制器和 `work_group_template` 表，以 `type=0/1` 区分。新“群发历史” tab 读取同表且不按 type 分隔，故两条旧列表都是 partial；两类创建和按 ID 送达详情仍 missing。仅凭相似 URL 或标题会误判数据归属及操作覆盖。
- 旧 `/admin/work/auth_group` 的只读 `GET /adminapi/work/group_chat_auth` 已注册，但新页面没有自动拉群 tab。旧新建/编辑表单还含群选择、自动建群、欢迎内容等，不能因只读 API 或 501 写路由将其算作 partial。旧 PHP 新建与更新接收字段不对称，也需要独立验证。
- 旧 `/admin/work/config` 在清单中是 page，实际复用动态表单编辑企业微信 Corp ID、Secret、Token、AES Key 和自建应用配置。新 `/api/work/config` 是企业侧 JS-SDK 签名接口，不是后台管理配置屏。
- 旧部分客户群/渠道码按钮传 query `id`，而 PHP 路由和控制器参数定义有疑点。台账描述代码中的旧页面意图，不据此宣称这些旧按钮已被运行验证。新目录的当前投影数据也受运行时 authority 开关约束，需用真实角色与历史数据复核。

此前 setting 76、content 13、product 12、marketing 48 共 **149** 条已分类；本批后 FE-001D 为 **169/274 已分类、105 未分类**。分类数量不代表功能已覆盖：本批没有 candidate，旧远端写入、统计、配置及跨域生产验收仍开放。FE-001D、真实角色/数据 E2E 和发布验收均不因本文件关闭，404 分母保持原值。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-work-frontend-parity-audit.ts --write` 重新生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-work-frontend-parity.test.ts` 做定向复核。
