# Admin 跨模块旧路由逐屏代码审计

本批依据 `audit/admin-frontend-inventory.json` 审阅 **18 条此前未分类的业务页**：旧 `routes.js` 两条、`statistic.js` 六条、`finance.js` 四条、`echarts.js` 两条、`frameOut.js` 的 `/admin/login` 一条、`index.js` 首页一条及 `system.js` 对外接口两条。`routes.js` 其余三条已进入 setting/system 台账；`frameOut.js` 的 13 条 `/kefu*` 已进入客服台账。`audit/admin-legacy-cross-module-route-parity.json` 由 `scripts/admin-cross-module-frontend-parity-audit.ts` 生成，逐条记录旧组件和权限、新 Admin 页与 API、已覆盖行为、缺口、证据。生成器固定七份旧路由 SHA、18 条路径及本仓库目标路由/API 注册；CI 不依赖相邻 PHP checkout。旧组件独立变化时仍需人工重审静态行为行号。

| 状态 | 数量 | 主要结论 |
| --- | ---: | --- |
| candidate | 3 | 交易、订单、余额统计的主要视图与旧统计 API 已对应，仍需真实历史数据和口径验收。 |
| partial | 10 | 旧首页、对外 API 账户与接口文档、交易图表页的实时订单计数、首页 DIY、提现、资金记录、管理登录、商品与用户统计有部分屏幕操作。 |
| missing | 4 | 专题装修、充值订单、佣金汇总、平台资金流水没有同等新屏。 |
| retired | 1 | 旧 `echarts/trade/product.vue` 是空模板。旧 `echarts/trade/order.vue` 仍有实时订单状态计数，不能整页退役。 |

容易误判的边界：

- 旧 `/` 首页四类组件包括统计卡、运营快捷入口、订单图和用户图。新 `/dashboard` 接入 `/home/header`、`/home/order`、`/home/user`，但旧快捷入口及各卡片细项仍需核对。
- 旧 `/admin/out` 可管理 API 账户与授权，也可配置外部推送凭据、Token URL、用户/订单/售后回调并测试链接。新 `/system/out` 承接账户与授权，Worker 明确禁用旧推送执行。旧 `/admin/out_interface` 是可编辑的接口文档树；新页仅提供目录和详情浏览，文档写接口返回不可用。
- 旧 `/admin/statistic/capital` 是平台外部现金流，Worker 有 `/flow/get_list`、`/flow/set_mark/:id` 和 `capital_flow` 权限映射，但新路由没有 `/finance/capital-flow`。新 `/finance/bill` 查询 `user_bill`，不能代替平台现金流。旧充值记录包含未付款订单、退款与删除；旧佣金记录按用户聚合，两者也不能由 `user_bill` 简表代替。
- 旧首页装修和专题装修是可视化组件编辑器。新 `/content/dise` 只编辑 JSON 且新建固定为停用 `type=1` 首页合同，不能把专题页或拖拽编排算作已完成。
- 旧管理登录同时有短信登录、忘记密码/手机号流程及图形/拼图校验。新登录的账号密码和品牌素材可用，但这条旧路由只算 partial。
- 旧 `echarts/trade/order.vue` 在挂载时调用 `/order/chart` 并显示八类订单状态实时计数；新 `/order` 有部分状态筛选和匹配总数，`/statistic` 有支付/退款计数，但没有旧八类并列面板或 `/order/chart` 合同，所以整页是 partial。该页 PV/UV 曲线和示例表格单独视为演示内容；`echarts/trade/product.vue` 则是空模板，整页 retired。真实交易和商品统计另由 `/admin/statistic/*` 旧页及新 `/statistic` tab 审阅。
- `/admin/system/log`、`/admin/system/user`、`/admin/setting/system/create` 已由 system/setting 台账审阅，本批按路径去重后不重复计数。

连同此前 content、product、setting、marketing、work、kefu、app、system 八份台账，当前九份互不重叠地覆盖 **237/274 条**，剩余 37 条待分类。分类不是上线完成数；本批没有真实角色浏览器 E2E、生产历史数据比对或部署证据，FE-001D 保持开放，404 项 checklist 分母不变。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-cross-module-frontend-parity-audit.ts --write` 重生成 JSON；运行 `node node_modules/vitest/vitest.mjs run test/admin-cross-module-frontend-parity.test.ts` 定向验证。
