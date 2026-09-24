# 客服旧路由逐屏代码审计

本批从 `audit/admin-frontend-inventory.json` 取旧 `frameOut.js` 中 `surface=page` 的 **13 条 `/kefu*` 路由**。它们虽然列在旧 Admin 路由清单，却同时包含独立客服端和买家客服浮窗；新实现须跨独立 `view/kefu-ts`、`view/pc-ts`、`view/uniapp-ts` 核对。`/admin/kefu/setup` 来自 `user.js`，组件为通用表单且标记为 `auxiliary`，不在 274 页分母内。

`audit/admin-legacy-kefu-route-parity.json` 由 `scripts/admin-kefu-frontend-parity-audit.ts` 生成，逐条保存旧路由与组件、旧身份元信息、新页面、Worker API、目标身份域、已有行为、缺口及源码位置。生成器锁定旧 `frameOut.js` 快照 SHA-256 `88b9a955c75fc95b44fcff0ffe5a75b7f9a631be23a49276fb02db7668b628e6`、13 条路径、目标路由/API 的实际注册，并验证本仓库证据。旧 `meta.auth`/`meta.kefu` 和 Vue 行号是本地逐屏审阅后固定的静态证据；CI 不读取相邻 PHP 仓库。旧组件变化时仍须人工重审行为行号。

| 状态 | 数量 | 依据 |
| --- | ---: | --- |
| candidate | 1 | `/kefu` 登录主流程已由独立客服登录页承接，含密码、一次性扫码、微信授权；仍待真实账号验收。 |
| partial | 12 | 新客服工作台或买家页面承接主视图一部分，但旧富消息、筛选、细节、匿名反馈或订单操作未逐项等价。 |
| missing | 0 | 13 条均有对应新页面承接至少一项核心操作。 |
| retired | 0 | 未找到旧页已失效或可正式退役的证据。 |

容易误判的边界：

- `view/admin-ts` 虽保留 `/kefu` 的客服会话页，管理身份的 `/adminapi/service/sessions`、`chat`、`send` 明确返回 501。真实客服会话在独立 `/kefuapi` 身份域和 `view/kefu-ts` 工作台；不能用管理页的存在证明已迁移。
- 旧移动会话列表和旧 PC 工作台共用新 `/workbench` 响应式页面。它具备注册/游客会话、实时消息、客户分组/标签、订单和商品上下文、部分履约/核销、话术及转接；旧各页的完整筛选、消息卡片、细节字段和远端操作仍须逐项验收。列表首次各取 60 条会话，订单上下文一次请求 20 条。
- 旧 `/kefu/appChat` 和 `/kefu/mobile_user_chat` 是买家端，不是客服员工工作台。新 PC `/service` 和 UniApp `/pages/user/kefu` 承接文字、图片和游客会话；旧商品/订单富消息及携带上下文的入口尚未证明等价。
- 旧 `/kefu/mobile_feedback` 走 `/kefuapi/tourist/feedback`，允许游客在离线时提交。新 UniApp 页面走 `/api/user/service/feedback`，要求登录，所以只记 partial。
- 工作者仍提供部分旧接口，如发货电子面单模板、退款服务等；新工作台未调用或未暴露的接口不计作该旧屏的完整迁移。

前五份台账已分类 **169/274**；本批 13 条后共 **182/274 已分类、92 未分类**。分类数不是已完成的功能数，FE-001D 仍开放。此批只审代码，没有真实客服角色浏览器 E2E、历史数据、生产发布或外部服务验收；总 checklist 的 404 分母和勾选数均不因本审计改变。

在 `workers-ts` 目录运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-kefu-frontend-parity-audit.ts --write` 重生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-kefu-frontend-parity.test.ts` 做定向复核。
