# Admin 用户与订单旧路由逐屏代码审计

本批以 `audit/admin-frontend-inventory.json` 的 274 条 `surface=page` 为权威分母，只审计旧 `src/router/modules/user.js` 的 **12 条**和 `src/router/modules/order.js` 的 **6 条**业务页。通用表单等辅助组件不纳入本批，其他路由由现有领域台账审阅。`audit/admin-legacy-user-order-route-parity.json` 由 `scripts/admin-user-order-frontend-parity-audit.ts` 生成，逐项记录旧路由、组件、`meta.auth`、目标 Admin 页/API/权限、已覆盖行为、缺口与源文件证据。

旧路由快照分别为 `user.js` SHA-256 `006d0e7ee1691bb696b694de425d07b28b829fbeaea90b5e248030651789ba76`、`order.js` SHA-256 `e081f68ac965cc276ba83471482e3658496a3f711e86716c359e965d2b19aefd`。旧组件行为行号和权限是本地代码审阅后的静态证据。生成及 CI 只读取本仓库的权威清单与新代码，不要求相邻的 `cinashop-php` checkout；若旧路由或旧组件发生变化，需重新核对静态证据。

| 状态 | 路由数 | 审阅边界 |
| --- | ---: | --- |
| candidate | 1 | 线下收银订单：列表、查询、收银码和逐单凭据核验可在新页操作，仍需旧记录、设备及角色验收。 |
| partial | 14 | 订单、子单、售后、旧任务、用户、等级、标签、付费会员及用户设置已有部分新界面；多项旧筛选和操作仍缺。 |
| missing | 3 | 发票管理、用户分组编辑、充值组合数据配置没有对应新 Admin 页面。 |
| retired | 0 | 没有依据把本批业务页判为已废止。 |

关键语义差异：

- 旧订单总表和子订单表是两个可操作视图。新 `/order` 能读取主单、子单并处理部分履约，但缺少旧多维筛选、部分改价/备注/批量/导出等操作，均为 `partial`。
- 旧 `/admin/order/offline` 与新 `/order/offline` 均处理收银订单列表、订单号/用户/时间查询及 H5/小程序收银码。新页增加支付凭据验证，但旧支付标记本身不是资金到账证据，因此状态为 `candidate`，真实记录和扫码设备验收未完成。
- 新 `/refund` 有列表、详情及版本化的退款操作合同。旧 `/refund/refund/:id`、`/refund/refuse/:id` 返回 410，不能将这些旧写路径算作迁移；旧原因、日期、申请类型和 ERP 流程也未完全覆盖，故为 `partial`。
- 旧发票页有统计、开票详情/操作及导出，新 Admin 无发票管理屏；旧用户分组虽有 Worker CRUD，新 Admin 无管理屏；旧充值配置复用通用组合数据页，新人赠余额和调整个人余额均不能代替套餐配置。这三条为 `missing`。
- 旧队列任务弹窗具备下载、重试、停止和清除操作；新 `/operations/legacy-runtime` 只读历史任务与日志。当前 Worker Queue/outbox 的状态来源也不能当作旧 PHP 任务重放能力。
- 旧用户列表有批量标签/分组/等级、发券、积分与时长调整、导出及多维筛选；新 `/user` 只有基本查询、详情和余额调整。会员等级任务、标签分类及企业微信同步也尚未恢复。
- 新付费会员页分为套餐、卡批次、记录、权益、协议等 tab。历史卡密码不回显或导出是有意的安全收口，旧卡密页仍只能判 `partial`；权益素材与富文本编辑、会员记录时间/类型筛选及协议所见即所得编辑也存在差异。
- 旧用户设置同屏管理注册、新人、会员等级及付费会员选项；新 `/config/newcomer` 只覆盖注册与新人礼相关配置。

本批新增 **18 条逐屏分类**，不代表 18 条功能迁移通过。现有全部路由台账合并为 **274 条记录、274 条不同路径**，与权威业务页分母一致。定向测试核对本批与其他路由台账无交集、全集恰为 274 条权威业务页、旧路由快照和新代码证据、关键语义区别，以及生成结果字节一致。FE-001D、真实角色/数据浏览器验收及发布门禁仍开放；本批未执行生产写入或部署。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-user-order-frontend-parity-audit.ts --write` 重生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-user-order-frontend-parity.test.ts` 做定向复核。
