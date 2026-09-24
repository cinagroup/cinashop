# Admin 供应商与代理商旧路由逐屏代码审计

本批以 `audit/admin-frontend-inventory.json` 为权威分母，只核对旧 `src/router/modules/supplier.js` 的 **11** 条业务页面和 `src/router/modules/agent.js` 的 **8** 条业务页面。`/admin/supplier/finance/set` 使用共用表单且在清单中标为 auxiliary，不计入业务页。逐路由的旧组件行为行号、`meta.auth`、新页面/API/权限、已覆盖操作、剩余缺口和证据见 `audit/admin-legacy-supplier-agent-route-parity.json`。该 JSON 由 `scripts/admin-supplier-agent-frontend-parity-audit.ts` 确定性生成。

旧 supplier.js 快照 SHA-256 为 `441dd080a46a1a841568fdd5b3307fe4d1edb34bc6b32b37f55ee8fa328ff3e8`；agent.js 为 `4a4e8da561f2f77a439e4a0da1a01b28fb36fb3da5c4fa1a786af8b01b3b622d`。旧组件与 PHP API 的语义由相邻 `cinashop-php` 源码审阅后固定为静态证据；生成与 CI 测试只读取本仓库，路由快照变化必须重新审计。静态行号不证明相邻 PHP checkout 后续没有变化。

| 状态 | 路由数 | 判定 |
| --- | ---: | --- |
| candidate | 0 | 尚无可宣称旧页面主要工作流均由新页面承接的路由。 |
| partial | 10 | 部分列表、审批或订单操作可用，仍有供应商维度、材料、筛选、导出或下级钻取缺口。 |
| missing | 9 | 主要旧操作没有对应新 Admin 屏，或者仅有 API／不同实体的页面。 |
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
| `/admin/agent/promoter/apply` | missing | Worker 有推广员申请 API，但新 Admin 没有审核屏或材料展示。 |

`GET /adminapi/promoter/apply/examine/:id/:uid/:status` 是一个写入状态的 GET 接口。代码审计发现它原先按 GET 授予 `distribution.view`；本地候选修复已在权限映射中对该路径显式要求 `distribution.manage`，并加定向回归断言，仍待 CI 与真实角色验收。新页缺席本身已足以将旧推广员申请页判为 missing，不能把接口存在算作页面覆盖。

本批 19 条与其他十份逐屏台账的 255 条互不重叠；当前 **274/274 条旧 Admin 页面路由均已完成代码级分类**。这里的“分类”不代表 274 项功能已完成迁移；FE-001D 和 404 个总迁移项的验收门禁保持开放。生产数据、真实角色浏览器验收、供应商财务实转和发布均不在本次代码审计范围。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-supplier-agent-frontend-parity-audit.ts --write` 重生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-supplier-agent-frontend-parity.test.ts` 验证路径、其他十份台账并集、关键语义及字节级确定性。
