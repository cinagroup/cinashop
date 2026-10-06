# Admin 用户与订单旧路由逐屏代码审计

## 2026-09-28 发票订单信息与会员记录补充（本地候选，未发布）

当前以[后续导航清单](../audit/admin-frontend-inventory-invoice-followup-20260928.json)和[用户订单逐屏台账](../audit/admin-legacy-user-order-route-parity-invoice-followup-20260928.json)为准：旧18屏 **3 candidate／15 partial／0 missing／0 retired**；叠加其余十份旧后台台账为274屏 **58／115／94／7**。旧会员记录页补齐会员类型、支付方式及上海购买时间筛选和到期时间展示；卡密/免费共享 `member_type=free`，按 code 是否存在区分，免费支付按旧订单来源与赠送标志判断。原生 PostgreSQL16 的本地规则验证 3/3，真实历史记录与受限角色仍待验收，故为本地 candidate。

发票管理新增按申请行 ID 绑定的只读订单信息接口；`invoice.view` 仅能读取重验支付、UID、根单归属及商品快照后的收货、金额拆分和商品，不获得普通 `order.detail` 的广泛权限。旧票种、抬头筛选恢复为当前已加载页过滤。旧 `all` 字段范围更广，旧 chart 全量计数未重建且旧模板未渲染；创建基线缺失的历史 `0.00` 行仍只读，因此发票屏保持 partial。双前缀原生 PostgreSQL16 本地 15/15、前端运行时 19/19 通过，未执行生产写入。历史日期快照和下面旧结论保留原字节。

## 2026-09-28 平台发票管理补充

以[发票批导航清单](../audit/admin-frontend-inventory-invoice-admin-20260928.json)和[用户订单逐屏台账](../audit/admin-legacy-user-order-route-parity-invoice-admin-20260928.json)为当批口径：旧18屏 **2 candidate／16 partial／0 missing／0 retired**；叠加其他十份旧后台台账为274屏 **57／116／94／7**。旧 `/admin/order/invoice/list` 由独立 `/order/invoice` 承接列表、详情、处理与当前页旧八列 CSV，双前缀 API 读写分别要求 `invoice.view/manage`，不能借 `order.view/manage` 获取税号和银行资料。金额只由当前订单净额与不可变历史证据决定，创建基线缺失的历史 `0.00` 行只读；同一弹窗的完整订单商品/收货/优惠、票种/抬头本页筛选和旧全字段搜索仍缺。旧 chart 请求的全量统计未在旧模板显示，也未作为新页全量统计宣称；新页只报当前页计数。因此本屏从 missing 调整为 partial，生产真实角色、旧记录及税务渠道仍待验收。详见[发票合同](admin-invoice-management-contract.md)。下方付费会员与九键批的数字均为保留的历史口径。

## 2026-09-28 付费会员两键补充

以[付费会员批导航清单](../audit/admin-frontend-inventory-paid-membership-20260928.json)和[新用户订单逐屏台账](../audit/admin-legacy-user-order-route-parity-paid-membership-20260928.json)为最新口径：旧18屏为 **2 candidate／15 partial／1 missing／0 retired**；与其余十份旧后台台账叠加为274屏 **57／115／95／7**。`/config/paid-membership` 通过专用双前缀 GET/POST 和 `config.view/manage` 承接旧 `/admin/user/setup_user` 的付费会员启用与价格两个开关；总开关关闭保留价格原值，价格开关同时控制新业务的会员计价。既有新购卡、卡密兑换、会员页、收货赠积分会员倍数、个人中心和菜单入口均读 SQL 胜出行，旧支付回调未加新阻断；旧 `/api/admin/config/save` 对两键及普通等级九键整批拒绝，避免绕开专用版本和审计。此子域完成仍不等于整页完成：基础资料定义编辑与签到/订单/邀请经验未迁移，`member_price_status` 无旧页启用控件与 Worker 消费者，待退役判断。旧 `/admin/user/recharge/:id` 对应的 `user_recharge_quota` 已由 `/marketing/recharge-options` 操作，台账由 missing 修正为 partial；旧状态筛选、20条分页及动态 gid 界面仍缺，不能升为 candidate。原生153项分四批通过，边界见[两键合同](admin-paid-membership-config-contract.md)。下方九键文字保留其当批口径。

## 2026-09-28 当前增量

当前以[日期版导航清单](../audit/admin-frontend-inventory-20260928.json)和[日期版用户订单逐屏台账](../audit/admin-legacy-user-order-route-parity-20260928.json)为准：旧18屏为 **2 candidate／14 partial／2 missing／0 retired**，旧全Admin仍274屏。新 `/config/level-activation` 已承接旧 `/admin/user/setup_user` 的普通等级激活九键子域，包含只读基础资料选取、必填、积分/整元余额、发行券选择、实际消费解释、历史显式修复与专用 `config.view/manage` 权限。该旧整页仍是 **partial**，因为基础资料定义编辑、经验、价格展示和付费会员选项仍未承接；旧菜单 `user.view` 不授予九键权限。新原生 Admin/App LOGIN 和双前缀 HTTP 共15项、相关回归111项通过，详见[九键合同](admin-level-activation-contract.md)。旧优惠券配置聚合页不在本用户订单分母，仍属营销 missing。

下方保留早期逐屏台账文字和当时的1／14／3分类作为历史基线，不作为当前分布；新台账及生成器使用日期版导航清单，旧 JSON 均未覆写。

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

当前生成器在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-user-order-frontend-parity-audit.ts --write`，重生成日期版 `admin-legacy-user-order-route-parity-20260928.json`；运行 `node node_modules/vitest/vitest.mjs run test/admin-user-order-frontend-parity.test.ts` 做定向复核。旧未带日期 JSON 保持历史字节。
