# Admin 供应商与代理商旧路由逐屏代码审计

2026-09-28 菜单规则后续快照为 `audit/admin-legacy-supplier-agent-route-parity-supplier-menu-followup-20260928.json`（`--supplier-menu-followup`）：旧 `/admin/supplier/supplier/index` 已有独立 `/supplier/menu-rules` 只读页，双 Admin 前缀的树、权限/导航目录、详情接口以 `supplier_menu_rules.view` 隔离，旧菜单只在精确路径与 `unique_auth` 同时匹配时映射查看。原始数字角色引用包含停用或未分配角色；规则可映射权限与固定 Supplier 导航目录分别呈现，不能称为某账号已获授权。后端 type=4 写路由还受独立数据库能力门禁，未安装即 503；前端尚无编辑流程，旧通用 `setting/menus*` 路由不算精确覆盖。该屏从 **missing→partial**，19屏变成 **9 candidate／10 partial／0 missing／0 retired**。真实角色授权效果、导航/角色规则、生产安装和发布验收仍开放。

2026-09-28 上批增量为 `audit/admin-legacy-supplier-agent-route-parity-supplier-closure-followup-20260928.json`（`--supplier-closure-followup`）：旧入驻申请由新 `/supplier/applications` 补齐上海秒级时间、七字段搜索、全部材料图、只读/管理权限与材料版本确认，申请人与审核锁序统一；旧配置启用时审核事务写不含密码的站内信。旧供应商目录由新 `/supplier/directory` 恢复查询、建档/编辑、启停和受约束软删，旧 `supplierAdd` 表单功能并入该页。旧快捷登录仍缺独立代登录授权和一次性交接，故目录仅 **partial**，建档/编辑屏为 **candidate**。旧 `/admin/agent/agreement` 则有独立 type=2 编辑页，服务端固定协议类型、清洗新旧 HTML 并以版本防覆盖，旧菜单只映射查看；旧无版本 POST 客户端须升级。19屏最新为 **9 candidate／9 partial／1 missing／0 retired**；唯一 missing 的 `/admin/supplier/supplier/index` 是供应商菜单规则树。真实账号、材料、历史内容、受限角色、短信/微信渠道与发布后验收仍开放；本地候选不等于生产完成。

下列基线表格和旧增量段落保留其生成时口径，不代表最新状态。

本批以 `audit/admin-frontend-inventory.json` 为权威分母，只核对旧 `src/router/modules/supplier.js` 的 **11** 条业务页面和 `src/router/modules/agent.js` 的 **8** 条业务页面。`/admin/supplier/finance/set` 使用共用表单且在清单中标为 auxiliary，不计入业务页。逐路由的旧组件行为行号、`meta.auth`、新页面/API/权限、已覆盖操作、剩余缺口和证据见 `audit/admin-legacy-supplier-agent-route-parity.json`。该 JSON 由 `scripts/admin-supplier-agent-frontend-parity-audit.ts` 确定性生成。

2026-09-28 后续快照见 `audit/admin-legacy-supplier-agent-route-parity-division-statistics-followup-20260928.json`（生成参数 `--division-statistics-followup`）。旧 `/admin/agent/statistics` 现有独立 `/division/statistics` 只读视图和 `division_statistics.view`，恢复六卡、日期趋势与代理商／员工分列排行；旧 `pid=>0` 搜索器实际取 `pid>=0`，因此汇总和排行亦计子单，订单数还包含未付单。旧受限代理商排行可能按代理商 UID 跨事业部读取订单，新合同始终与管理员事业部求交集；跨日结束零点改排他，排行最多500行。因此旧屏仍为 **partial**，19屏分布维持 **1 candidate／10 partial／8 missing／0 retired**。原基线 JSON 保留原字节，具体差异见 `docs/admin-division-statistics-read-contract.md`。

2026-09-28 供应商账单后续快照 `audit/admin-legacy-supplier-agent-route-parity-supplier-bill-followup-20260928.json` 由 `--supplier-bill-followup` 在上一统计快照之上生成。旧 `/admin/supplier/bill/index` 与可选 `:type` 两条路由由独立 `/supplier/bills` 承接，`?status=1|0|-1` 保留状态深链意图；旧日／周／月、供应商、上海创建时间筛选、分组明细和导出均有新只读合同。旧 `status=1` 按完成时间归组而仍以创建时间筛日期，周键为 MySQL `%Y-%u`（日历年加周一首日的 00–53 周），不能替换为 ISO 周年。新页按期间和完整过滤范围重新读取明细及有界导出，保留已删／孤儿供应商的历史流水；旧直接投未分组 `add_time` 的非确定显示及 `GROUP_CONCAT` ID 串改为稳定期间键，旧导出忽略 `supplier_id` 的漏洞不复刻。旧 `ids` 明细／导出 API 参数协议没有用假别名注册到新接口，PHP 精确路由覆盖数不因此增加。代码级状态为 **3 candidate／10 partial／6 missing／0 retired**；真实财务数据、受限角色浏览器及发布验收仍开放。`/admin/supplier/apply` 与 `/admin/agent/apply_list` 复核出日期／关键词／完整材料、默认筛选、权限门禁及切号迟到响应等缺口，继续保持 partial。具体合同见 `docs/admin-supplier-bill-read-contract.md`。

2026-09-28 供应商资金流水快照 `audit/admin-legacy-supplier-agent-route-parity-supplier-capital-followup-20260928.json` 由 `--supplier-capital-followup` 叠加前两批生成。旧 `/admin/supplier/capital/index` 新增独立 `/supplier/capital-flow`，按供应商、上海创建时间及交易单号／交易人查询，ID 倒序每页20条，并导出原八列全量命中记录（新合同最多5000行／2MiB）。仅 `supplier_capital.view` 可读，`supplier_capital.manage` 可改平台 `remark`；旧请求字段 `mark` 实际写入 `remark`，与供应商自用 `mark` 列不同。新写入用旧值确认防并发覆盖，并保护 Worker 拆单／退款血缘。旧页面误传 `date` 而 PHP 接收 `data`，导致旧导出日期条件失效；新页导出与列表共用筛选。`supplier_id=0` 精确指未绑定供应商，只有空值指全部，历史已删／孤儿供应商流水不丢。该屏为 **missing→candidate**，域内19屏现为 **4 candidate／10 partial／5 missing／0 retired**；真实财务历史、受限角色浏览器和发布验收仍开放。具体合同见 `docs/admin-supplier-capital-contract.md`。

2026-09-28 供应商订单统计快照 `audit/admin-legacy-supplier-agent-route-parity-supplier-order-statistics-followup-20260928.json` 由 `--supplier-order-statistics-followup` 叠加前三批生成。旧 `/admin/supplier/orderStatistics/index` 由独立 `/supplier/order-statistics` 承接汇总、营业趋势、五渠道订单数、九类型金额与供应商表，七种上海日期快捷和图表图片保存均有对应操作；六条 GET 双 Admin 前缀只允许 `supplier_order_statistics.view`。旧菜单1455与供应商目录1439共用 uniqueAuth，映射必须限定精确菜单路径。旧 `pid=>0` 搜索器实际为 `pid>=0`，新统计保留子单、排除支付父单；各区块使用原各自删除／退款字段口径。旧不可见四卡、先请求后设置默认日期、表格假分页、稀疏趋势漏数和旧表忽略 `supplier_id` 均明确纠偏。该屏暂按代码级 **missing→candidate** 记录，域内19屏为 **5 candidate／10 partial／4 missing／0 retired**；真实订单历史、受限角色浏览器、生产规模与发布后验收仍开放。详情见 `docs/admin-supplier-order-statistics-contract.md`。

旧 supplier.js 快照 SHA-256 为 `441dd080a46a1a841568fdd5b3307fe4d1edb34bc6b32b37f55ee8fa328ff3e8`；agent.js 为 `4a4e8da561f2f77a439e4a0da1a01b28fb36fb3da5c4fa1a786af8b01b3b622d`。旧组件与 PHP API 的语义由相邻 `cinashop-php` 源码审阅后固定为静态证据；生成与 CI 测试只读取本仓库，路由快照变化必须重新审计。静态行号不证明相邻 PHP checkout 后续没有变化。

| 状态 | 路由数 | 判定 |
| --- | ---: | --- |
| candidate | 1 | 分销员申请页的列表、筛选、分页、审核及删除已有新页面承接；仍需生产历史数据与真实角色验收。 |
| partial | 10 | 部分列表、审批或订单操作可用，仍有供应商维度、材料、筛选、导出或下级钻取缺口。 |
| missing | 8 | 主要旧操作没有对应新 Admin 屏，或者仅有 API／不同实体的页面。 |
| retired | 0 | 这些路由均有实际旧 Vue 页面，没有足够依据认定已退役。 |

| 旧路由 | 状态 | 关键结论 |
| --- | --- | --- |
| `/admin/supplier/supplier/index` | missing | 实际是供应商菜单/规则树，不是供应商目录；新系统菜单不编辑供应商规则。 |
| `/admin/supplier/apply` | partial | 可审、拒、备注、删；旧日期筛选和全部资质图片审阅未在新页提供。 |
| `/admin/supplier/menu/list` | missing | 实际是已入驻供应商目录及启停、建档、删除、快捷登录；新申请列表不是目录。 |
| `/admin/supplier/supplierAdd/:id?` | missing | 缺手工新增/编辑供应商及账号字段。 |
| `/admin/supplier/orderList/index` | partial | 全局订单可看详情/发货；缺供应商过滤与旧供应商订单操作。 |
| `/admin/supplier/afterOrder/index` | partial | 全局退款可审核；缺供应商范围与旧售后筛选。 |
| `/admin/supplier/orderStatistics/index` | missing | 缺供应商订单汇总、趋势、渠道/类型分析。 |
| `/admin/supplier/capital/index` | missing | 缺 `supplier/flowing_water` 流水、导出和备注；平台流水是不同实体。 |
| `/admin/supplier/bill/index` | missing | 缺 `supplier/fund_record` 账单及导出；通用财务账单是不同实体。 |
| `/admin/supplier/bill/index/:type?` | missing | 同一旧组件还有参数预选类型/状态语义；新页未恢复。 |
| `/admin/supplier/cash/index` | partial | 可查阶段金额、审核及登记转账；缺日期/明确供应商筛选和后台备注入口。 |
| `/admin/agent/agent_manage/index` | partial | 新推广人/佣金只读列表不能代替旧下级/订单、导出、二维码、调整上级等操作。 |
| `/admin/agent/agreement` | missing | 旧 `type=2` 推广员协议富文本编辑与新代理商入驻协议是不同文档。 |
| `/admin/agent/division_list` | partial | 事业部 CRUD/状态可用，缺从事业部行钻取下级代理商。 |
| `/admin/agent/order` | partial | 新事业部订单可按事业部/代理商查；缺日期、明细展开和导出。 |
| `/admin/agent/agent_list` | partial | 新代理商/员工角色 CRUD 可用，缺按代理商行查看管理直属员工。 |
| `/admin/agent/statistics` | partial | 有汇总卡和排行；缺旧日期条件及趋势图，尽管 Worker 注册了 trend API。 |
| `/admin/agent/apply_list` | partial | 代理申请可审批/拒绝/删除；新表格没有显示 API 已返回的资质图片。 |
| `/admin/agent/promoter/apply` | candidate | 新 `/agent/promoter-applications` 承接 15 条分页、关键词/状态筛选、通过、拒绝及软删除；新写请求携带申请材料版本，拒绝原因必填，时间明确为 UTC。 |

分销员申请的新页面与菜单使用 `/agent/promoter-applications`。查看需要 `distribution.view`，通过、拒绝及删除需要 `distribution.manage`；只读账号不显示写操作，直接调用操作处理函数也有权限检查。页面展示申请 ID、用户 UID、昵称、姓名、电话、申请状态、申请/审核时间及拒绝原因。旧页重复的电话列不再重复；旧组件虽然定义了 `images` 插槽，但没有对应表格列，不能将未配置的图片展示当成必须迁移的材料审阅功能。

`GET /adminapi/promoter/apply/list` 返回 `{ list, count, page, limit }`，默认每页 15 条、按申请 ID 倒序，状态为全部 `all` 或 `0/1/2`。关键词按字面内容搜索姓名、UID、昵称与电话，支持服务端总数及翻页；单页上限 100，偏移上限 10000。时间沿用服务端 `YYYY-MM-DD HH:mm:ss` 字符串，页面明确标注 UTC，未审核时间显示空占位。列表加载失败有可见错误和重新读取入口；切页、筛选或切换账号立即清理旧行，并隔离迟到响应。分页在加载时卸载，避免清空总数触发组件回到第一页。

新页面通过 `POST /adminapi/promoter/apply/examine/:id/:uid/:status` 审核，只提供申请中记录的通过/拒绝按钮。通过有明确确认；拒绝必须填写 1–1000 字原因并确认，这是相对旧页的受控增强。列表每行返回不透明的 `revision`，新 POST 携带确认时的该版本；拒绝额外提交 `refusal_reason`。`DELETE /adminapi/promoter/apply/del/:id` 同样携带确认时的 `revision`，仅软删除申请，不取消用户已获得的分销资格。删除末页最后一条后会读取有效的前一页。材料已重提或版本过期时必须重新读取并重新确认，前端不会自动换用新版本重试写入；网络错误或结果不明时也只重新读取状态。确认、提交及响应均校验当前会话与列表请求代次，防止切换账号或查询后继续旧操作。

旧 `GET /adminapi/promoter/apply/examine/:id/:uid/:status` 仍是有写入副作用的兼容入口，显式要求 `distribution.manage`；它与不带请求体的旧 DELETE 均保留兼容，缺少新页面使用的 `revision` 材料版本保护。不能据新页面的乐观并发检查，推断旧入口也具有同等保护。新页面不使用 GET 写入或无版本删除。

本轮验证包括 `test/admin-promoter-applications-frontend.test.ts` 的 12 项真实 Vue/Axios 运行时测试、Admin 类型检查与完整构建，以及后端原生 PostgreSQL 4 个测试文件 31/31 通过、零跳过。前端覆盖权限、分页筛选、失败重读、拒绝原因、版本传递、删除回页、迟到响应及 A→B→A 会话更换；原生数据库测试验证写入与并发边界。已通过内置浏览器 CUA 操作确认只读账号隐藏写操作、31 条数据按每页 15 条分页、搜索、审批及拒绝原因必填。随后完成末页删除回退、列表失败重试、响应丢失后仅重读、状态筛选及1440×900/390×844布局验证；修正窄屏固定操作列挤压身份信息，最终无页面横向溢出及控制台error/warn。两阶段65次合成API请求中仅3次审核POST、2次DELETE，响应丢失场景只发一次审核POST。服务和测试tab均已关闭，截图与请求记录见[本地验收证据](../audit/admin-promoter-application-local-smoke.md)。这些证据不能替代生产历史申请和真实角色权限验收。

本批 19 条与其他十份逐屏台账的 255 条互不重叠；当前 **274/274 条旧 Admin 页面路由均已完成代码级分类**。这里的“分类”不代表 274 项功能已完成迁移；FE-001D 和 404 个总迁移项的验收门禁保持开放。生产数据、真实角色浏览器验收、供应商财务实转和发布均不在本次范围。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-supplier-agent-frontend-parity-audit.ts --write` 重生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-supplier-agent-frontend-parity.test.ts` 验证路径、其他十份台账并集、关键语义及字节级确定性。
