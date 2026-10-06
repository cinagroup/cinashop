# Admin 跨模块旧路由逐屏代码审计

## 2026-09-28 资金记录账本纠偏回访

旧 `/admin/finance/finance/bill` 的旧 PHP `Finance::list` 经 `UserMoneyServices`、`UserMoneyDao` 读取 `user_money`，此前新 `/finance/bill` 却查询 `user_bill`。这属于数据来源合同错误，早期跨模块台账只把该屏列为筛选和导出不足，未识别来源错配。本批新增独立双前缀 `GET /finance/user-money-ledger`、`/types`、`/export`，页面改用新接口，恢复旧六列、昵称/ID与资金类型及上海时间筛选、20条分页和独立导出授权。原 `/bill/list` 维持原用途。旧 `not_category` 条件因旧表与搜索器均无此字段而不生效；真正生效的四项 `not_type` 被保留。旧导出 XLSX 改为有界完整 CSV，并明确格式差异。

新日期台账为 `audit/admin-legacy-cross-module-route-parity-user-money-ledger-followup-20260928.json`，基于新日期 Admin 清单；跨模块18屏成为 **5 candidate／11 partial／1 missing／1 retired**，全274屏 **73／111／83／7**。旧默认与此前佣金回访 JSON 保留历史原字节，新日期台账纠正资金记录判断。独立[资金记录合同](admin-user-money-ledger-route-contract.md)列明权限、字段及待验收差异。可在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-cross-module-frontend-parity-audit.ts --user-money-ledger-followup --write` 重生成；真实角色和生产财务数据仍未验收。下文为前批历史口径。

## 2026-09-28 佣金记录只读回访

旧 `/admin/finance/finance/commission` 新增独立 `/finance/commissions` 页面，`commission.view` 下按用户列出余额、当前账户佣金、审核中或已通过提现额及其和，恢复昵称/账号/手机号/UID、上海佣金流水时间和当前账户佣金区间筛选、20条分页、用户详情及全部类型的佣金明细。旧 `UserUserBrokerageDao` 实际是 `user LEFT JOIN user_brokerage`，不是另一张 `user_user_brokerage` 表；原有 `/brokerage/list` 只列原始流水，不能代替旧财务屏。

旧表“提现到账佣金”包含审核中、已通过申请的本金**及手续费**，不只是已到账款；列表 `sum_number` 是该提现额加当前 `brokerage_price`，详情 `number` 则独立取四类收入减退款且下限为零。列表日期只决定期间哪些用户有佣金流水，不重算该用户全时段金额。旧 `GROUP BY u.uid` 却直接投未分组的 `b.add_time`，新页明确显示**最近匹配流水时间**，不宣称旧值可唯一复现。旧列表同分钟起止会扩成24小时、不同分钟只计至结束分钟首秒，旧明细还包含结束日次日零点；新页统一采用完整分钟／整日的排他上界，端点附近人数可能变化。明细按 UID、日期和流水 ID 倒序展示所有收支方向，支出金额保留原数值。旧六列导出每批1000条并循环至空页，新合同未实现导出，故该旧屏只从 **missing→partial**，真实角色和历史金额验收仍开放。

独立日期台账为 `audit/admin-legacy-cross-module-route-parity-commission-followup-20260928.json`，基于 `audit/admin-frontend-inventory-commission-followup-20260928.json`；18屏变为 **4 candidate／12 partial／1 missing／1 retired**。默认与前批充值 JSON 保留原字节。本地运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-cross-module-frontend-parity-audit.ts --commission-followup --write` 重生成，`node node_modules/vitest/vitest.mjs run test/admin-cross-module-frontend-parity.test.ts test/admin-all-frontend-parity.test.ts` 做逐路和全集复核。下文是历史回访口径。

## 2026-09-28 充值订单只读回访

旧 `/admin/finance/user_recharge/index` 已从原先的 `missing` 调整为 **partial**：新 `/finance/recharges` 在 `recharge_order.view` 下读取独立 `user_recharge` 订单，覆盖已付/未付列表、上海创建时间与支付状态筛选、用户或订单关键词、20 条分页、已支付订单统计和只读详情。对应 Worker GET 为 `/adminapi/finance/recharge-orders`、`/stats`、`/:id`，并在 `/api/admin` 下提供同一路由合同。新页保留异常记录供核对；这不是 `user_bill` 资金流水的别名。

回访产物是 `audit/admin-legacy-cross-module-route-parity-recharge-followup-20260928.json`，基于 `audit/admin-frontend-inventory-read-followup-20260928.json`；18 条旧路由中 candidate 4、partial 11、missing 2、retired 1。默认 `audit/admin-legacy-cross-module-route-parity.json` 保持原样。**充值退款、未付单删除、导出，以及真实角色浏览器和生产历史数据的筛选、金额、退款口径验收仍开放**，因此不能升为 candidate 或生产验收完成。下文保留原审阅快照的说明，以 dated overlay 为本次充值路由最新判定。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-cross-module-frontend-parity-audit.ts --recharge-followup --write` 重生成回访 JSON；省略 `--recharge-followup` 时仍生成默认旧快照。

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
