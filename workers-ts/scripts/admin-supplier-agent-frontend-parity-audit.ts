import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "candidate" | "partial" | "missing" | "retired";
type Review = {
  status: Status;
  targetScreens: string[];
  targetApis: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
};
type InventoryRoute = {
  source: string; line: number; path: string; title: string | null;
  component: string; resolvedComponent: string | null; surface: string;
};

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryFile = resolve(workerRoot, "audit/admin-frontend-inventory.json");
const supplierMenuFollowup = process.argv.includes("--supplier-menu-followup");
const supplierClosureFollowup = process.argv.includes("--supplier-closure-followup") || supplierMenuFollowup;
const supplierCashFollowup = process.argv.includes("--supplier-cash-followup") || supplierClosureFollowup;
const supplierOrderStatisticsFollowup = process.argv.includes("--supplier-order-statistics-followup") || supplierCashFollowup;
const supplierCapitalFollowup = process.argv.includes("--supplier-capital-followup") || supplierOrderStatisticsFollowup;
const supplierBillFollowup = process.argv.includes("--supplier-bill-followup") || supplierCapitalFollowup;
const divisionStatisticsFollowup = process.argv.includes("--division-statistics-followup") || supplierBillFollowup;
const outputFile = resolve(workerRoot, supplierMenuFollowup
  ? "audit/admin-legacy-supplier-agent-route-parity-supplier-menu-followup-20260928.json"
  : supplierClosureFollowup
  ? "audit/admin-legacy-supplier-agent-route-parity-supplier-closure-followup-20260928.json"
  : supplierCashFollowup
  ? "audit/admin-legacy-supplier-agent-route-parity-supplier-cash-followup-20260928.json"
  : supplierOrderStatisticsFollowup
    ? "audit/admin-legacy-supplier-agent-route-parity-supplier-order-statistics-followup-20260928.json"
  : supplierCapitalFollowup
    ? "audit/admin-legacy-supplier-agent-route-parity-supplier-capital-followup-20260928.json"
  : supplierBillFollowup
    ? "audit/admin-legacy-supplier-agent-route-parity-supplier-bill-followup-20260928.json"
  : divisionStatisticsFollowup
    ? "audit/admin-legacy-supplier-agent-route-parity-division-statistics-followup-20260928.json"
    : "audit/admin-legacy-supplier-agent-route-parity.json");
const supplierRouter = "src/router/modules/supplier.js";
const agentRouter = "src/router/modules/agent.js";
const routerHashes: Record<string, string> = {
  [supplierRouter]: "441dd080a46a1a841568fdd5b3307fe4d1edb34bc6b32b37f55ee8fa328ff3e8",
  [agentRouter]: "4a4e8da561f2f77a439e4a0da1a01b28fb36fb3da5c4fa1a786af8b01b3b622d",
};
const targetRouter = "view/admin-ts/src/router/index.ts";
const adminRoutes = "workers-ts/src/routes/adminapi.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const oldPhpRoutes = "cinashop-php/route/admin.php";
const screens: Record<string, { file: string; adapter: string; permission: string }> = {
  "/supplier/applications": { file: "view/admin-ts/src/pages/supplier/SupplierApplications.vue", adapter: "view/admin-ts/src/api/supplierApplication.ts", permission: "supplier_application" },
  "/supplier/directory": { file: "view/admin-ts/src/pages/supplier/SupplierDirectory.vue", adapter: "view/admin-ts/src/api/supplierDirectory.ts", permission: "supplier_directory" },
  "/supplier/menu-rules": { file: "view/admin-ts/src/pages/supplier/SupplierMenuRules.vue", adapter: "view/admin-ts/src/api/supplierMenuRules.ts", permission: "supplier_menu_rules" },
  "/supplier/bills": { file: "view/admin-ts/src/pages/supplier/SupplierBills.vue", adapter: "view/admin-ts/src/api/supplierBill.ts", permission: "supplier_bill" },
  "/supplier/capital-flow": { file: "view/admin-ts/src/pages/supplier/SupplierCapitalFlow.vue", adapter: "view/admin-ts/src/api/supplierCapital.ts", permission: "supplier_capital" },
  "/supplier/order-statistics": { file: "view/admin-ts/src/pages/supplier/SupplierOrderStatistics.vue", adapter: "view/admin-ts/src/api/supplierOrderStatistics.ts", permission: "supplier_order_statistics" },
  "/finance/supplier-extract": { file: "view/admin-ts/src/pages/finance/SupplierExtractList.vue", adapter: "view/admin-ts/src/api/finance.ts", permission: "supplier_extract" },
  "/order": { file: "view/admin-ts/src/pages/order/OrderList.vue", adapter: "view/admin-ts/src/api/order.ts", permission: "order" },
  "/refund": { file: "view/admin-ts/src/pages/refund/RefundList.vue", adapter: "view/admin-ts/src/api/refund.ts", permission: "refund" },
  "/agent": { file: "view/admin-ts/src/pages/agent/AgentList.vue", adapter: "view/admin-ts/src/pages/agent/AgentList.vue", permission: "distribution" },
  "/agent/promoter-applications": { file: "view/admin-ts/src/pages/agent/PromoterApplications.vue", adapter: "view/admin-ts/src/api/promoterApplication.ts", permission: "distribution" },
  "/agent/agreement": { file: "view/admin-ts/src/pages/agent/AgentAgreement.vue", adapter: "view/admin-ts/src/api/agentAgreement.ts", permission: "agent_agreement" },
  "/division": { file: "view/admin-ts/src/pages/agent/DivisionManagement.vue", adapter: "view/admin-ts/src/api/division.ts", permission: "division" },
  "/division/statistics": { file: "view/admin-ts/src/pages/agent/DivisionStatistics.vue", adapter: "view/admin-ts/src/api/divisionStatistics.ts", permission: "division_statistics" },
};

// Old auth and behavior-bearing component lines were reviewed against the pinned PHP checkout.
// This generator deliberately needs no sibling checkout in CI.
const legacy: Record<string, { auth: string; line: number }> = {
  "/admin/supplier/supplier/index": { auth: "['admin-supplier-supplier-index']", line: 303 },
  "/admin/supplier/apply": { auth: "['admin-supplier-apply']", line: 64 },
  "/admin/supplier/menu/list": { auth: "['admin-supplier-menu-list']", line: 188 },
  "/admin/supplier/supplierAdd/:id?": { auth: "['admin-supplier-supplierAdd']", line: 169 },
  "/admin/supplier/orderList/index": { auth: "['admin-supplier-orderList']", line: 348 },
  "/admin/supplier/afterOrder/index": { auth: "['admin-supplier-afterOrder']", line: 539 },
  "/admin/supplier/orderStatistics/index": { auth: "['admin-supplier-supplier_list']", line: 625 },
  "/admin/supplier/capital/index": { auth: "['admin-supplier-capital-index']", line: 56 },
  "/admin/supplier/bill/index": { auth: "['admin-supplier-bill-index']", line: 77 },
  "/admin/supplier/bill/index/:type?": { auth: "['admin-supplier-bill-index']", line: 77 },
  "/admin/supplier/cash/index": { auth: "['admin-supplier-cash-index']", line: 102 },
  "/admin/agent/agent_manage/index": { auth: "['agent-agent-manage']", line: 74 },
  "/admin/agent/agreement": { auth: "['agent-agreement']", line: 24 },
  "/admin/agent/division_list": { auth: "['agent-division-index']", line: 27 },
  "/admin/agent/order": { auth: "['agent-division-order']", line: 90 },
  "/admin/agent/agent_list": { auth: "['agent-division-agent-index']", line: 26 },
  "/admin/agent/statistics": { auth: "['agent-division-statistics']", line: 268 },
  "/admin/agent/apply_list": { auth: "['agent-division-agent-applyList']", line: 67 },
  "/admin/agent/promoter/apply": { auth: "['admin-agent-promoter-apply']", line: 69 },
};

const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApis: string[], covered: string, remaining: string, evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate supplier/agent review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered: covered ? [covered] : [], remaining: [remaining], evidence };
}

add("/admin/supplier/supplier/index", "missing", [], [], "",
  "旧路径实际是供应商菜单/规则树，支持按 supplier 角色添加子菜单和权限规则、编辑、删除、启停；新 /system 只管理平台系统权限，没有供应商规则编辑及授权关系。路由名中的 supplier 不表示供应商目录。",
  ["cinashop-php/view/admin/src/api/systemMenus.js", "view/admin-ts/src/pages/system/SystemList.vue"]);
add("/admin/supplier/apply", "partial", ["/supplier/applications"],
  ["GET /adminapi/supplier/apply/list", "GET /adminapi/supplier/apply/info/:id", "POST /adminapi/supplier/apply/verify/:id", "POST /adminapi/supplier/apply/mark/:id", "DELETE /adminapi/supplier/apply/del/:id"],
  "新页按状态/关键词分页列申请，支持审批、拒绝、内部备注和删除，Worker 审批会创建待激活供应商账号。",
  "旧页可按日期筛选并查看全部资质图片；新页无日期筛选，仅链接首张图片并显示张数，完整材料核验和历史申请数据仍需验收。",
  ["workers-ts/src/controllers/api/v1/SupplierApplicationController.ts"]);
add("/admin/supplier/menu/list", "missing", [], [], "",
  "旧组件实际是已入驻供应商目录，支持查询、启停、手工新增/编辑、删除和快捷登录；新申请页只管理入驻申请，不提供既有供应商目录或快捷登录。",
  ["view/admin-ts/src/pages/supplier/SupplierApplications.vue"]);
add("/admin/supplier/supplierAdd/:id?", "missing", [], [], "",
  "旧新增/编辑表单管理供应商联系人、地址、邮箱、账户、密码、排序和启用状态；新后台没有对应手工建档/编辑表单，申请审批建号不能替代。",
  ["view/admin-ts/src/pages/supplier/SupplierApplications.vue"]);
add("/admin/supplier/orderList/index", "partial", ["/order"], ["GET /adminapi/order/list", "GET /adminapi/order/detail/:id", "POST /adminapi/order/delivery/:id"],
  "新全局订单页可分页查询履约单、查看详情和发货。",
  "旧页按供应商、时间、订单类型、支付和订单状态筛选，并提供供应商订单专有操作；新全局订单查询无 supplier_id 条件，也没有旧筛选和供应商范围的完整操作集。",
  ["workers-ts/src/services/admin/AdminOrderReadService.ts"]);
add("/admin/supplier/afterOrder/index", "partial", ["/refund"],
  ["GET /adminapi/refund/list", "GET /adminapi/refund/detail/:id", "POST /adminapi/refund/operations/execute/:id", "POST /adminapi/refund/operations/receipt"],
  "新全局退款页可检索、查看退款申请并执行受控审核/退款流程。",
  "旧供应商售后页按供应商、日期、退款状态和订单筛选，并显示所属供应商；新退款页与读取合同没有供应商筛选，供应商维度售后工作台尚未恢复。",
  ["workers-ts/src/app.ts", "workers-ts/src/routes/admin-refund-operations.ts", "workers-ts/src/services/admin/AdminRefundReadService.ts"]);
add("/admin/supplier/orderStatistics/index", "missing", [], [], "",
  "旧页按供应商与日期显示订单汇总、趋势、渠道/类型分析及供应商统计表；新通用统计页没有 supplier/home 这些供应商维度指标与图表。",
  ["view/admin-ts/src/pages/statistic/Dashboard.vue"]);
add("/admin/supplier/capital/index", "missing", [], [], "",
  "旧页是 supplier/flowing_water 供应商资金流水，含供应商/日期/订单筛选、导出和备注；新平台流水与通用账单不是该实体，没有对应供应商流水管理屏。",
  ["view/admin-ts/src/pages/finance/BillList.vue"]);
add("/admin/supplier/bill/index", "missing", [], [], "",
  "旧 supplier/fund_record 账单按日/周/月、供应商、时间和状态查询详情及导出；新 /finance/bill 是平台/用户账单，缺供应商 fund_record 合同和页面。",
  ["view/admin-ts/src/pages/finance/BillList.vue"]);
add("/admin/supplier/bill/index/:type?", "missing", [], [], "",
  "旧同组件以可选 :type 参数预选 supplier/fund_record 的账单状态或类型，仍可查详情与导出；新财务账单不读取供应商 fund_record，也不实现该路由参数语义。",
  ["view/admin-ts/src/pages/finance/BillList.vue"]);
add("/admin/supplier/cash/index", "partial", ["/finance/supplier-extract"],
  ["GET /adminapi/supplier/extract/list", "POST /adminapi/supplier/extract/verify/:id", "POST /adminapi/supplier/extract/save_transfer/:id", "POST /adminapi/supplier/extract/mark/:id"],
  "新提现页按阶段、关键词和方式分页，显示阶段金额，并可审批/拒绝与登记实际转账凭证。",
  "旧页还可按供应商和日期筛选并修改后台备注；新 Worker 有 mark API，但新页面未暴露备注操作，且无明确供应商/日期筛选。",
  ["workers-ts/src/controllers/api/v1/AdminSupplierFinanceController.ts"]);

add("/admin/agent/agent_manage/index", "partial", ["/agent"], ["GET /adminapi/spread/list", "GET /adminapi/brokerage/list"],
  "新分销页提供推广人及佣金的只读列表。",
  "旧推广人页还按日期/昵称查询、查看下级与订单、导出、生成公众号/小程序/H5 二维码、调整上级及赠送等级；新页缺这些操作，且新 spread/list 的人群口径需与旧 agent/index 核对。",
  ["workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
add("/admin/agent/agreement", "missing", [], [], "",
  "旧富文本页读取并保存 agent/get_agent_agreement 与 set_agent_agreement 的 type=2 推广员协议；新运行时内容的代理商入驻协议是另一文档，不能替代旧协议编辑。",
  ["cinashop-php/view/admin/src/api/user.js", "cinashop-php/app/controller/admin/v1/agent/AgentManage.php", "view/admin-ts/src/pages/config/RuntimeContent.vue"]);
add("/admin/agent/division_list", "partial", ["/division"],
  ["GET /adminapi/agent/division/list", "GET /adminapi/agent/division/detail/:uid", "POST /adminapi/agent/division/save", "PUT /adminapi/agent/division/status/:uid/:status", "DELETE /adminapi/agent/division/del/:uid"],
  "新事业部页可按角色类型列出事业部，创建/编辑管理员和事业部，启停、解除角色。",
  "旧事业部行可逐级查看所辖代理商并按上级切入管理；新页只有全局类型 tab，缺同一事业部行的下级钻取及旧查询/导出细节。",
  ["workers-ts/src/controllers/api/v1/AdminDivisionController.ts"]);
add("/admin/agent/order", "partial", ["/division"],
  ["GET /adminapi/agent/division/order/list", "GET /adminapi/agent/division/option", "GET /adminapi/agent/division/agent_option/:divisionId"],
  "新事业部订单 tab 可按事业部/代理商及关键词查订单、金额和三级佣金。",
  "旧订单页有日期筛选、明细展开和导出；新 tab 未暴露这些操作，不能完成旧订单复核流程。",
  ["workers-ts/src/controllers/api/v1/AdminDivisionController.ts"]);
add("/admin/agent/agent_list", "partial", ["/division"],
  ["GET /adminapi/agent/division/list", "POST /adminapi/agent/division_agent/save", "POST /adminapi/agent/division_staff/save", "PUT /adminapi/agent/division/status/:uid/:status", "DELETE /adminapi/agent/division/del/:uid"],
  "新角色 tab 可按代理商/员工类型列出、创建、编辑、启停和解除角色，并在员工表单选择上级代理商。",
  "旧代理商目录可从单行查看和管理其直属员工；新页缺按代理商行的下级钻取与员工关联视图。",
  ["workers-ts/src/controllers/api/v1/AdminDivisionController.ts"]);
add("/admin/agent/statistics", "partial", ["/division"],
  ["GET /adminapi/agent/division/statistics", "GET /adminapi/agent/division/ranking", "GET /adminapi/agent/division/trend"],
  "新事业部页展示总量卡与业绩排行。",
  "旧统计页可选日期并绘制业绩趋势；新页无日期条件和趋势图。Worker 虽注册 trend API，新页面没有调用，不能据 API 判为整屏覆盖。",
  ["workers-ts/src/controllers/api/v1/AdminDivisionController.ts"]);
add("/admin/agent/apply_list", "partial", ["/division"],
  ["GET /adminapi/agent/division/apply/list", "POST /adminapi/agent/division/apply/examine/save", "DELETE /adminapi/agent/division/apply/del/:id"],
  "新代理申请 tab 可按状态/关键词分页，审批、拒绝和删除。",
  "旧申请可审阅上传的证明材料；新 API 有 images 字段但新表格不显示材料，审核依据展示不完整。",
  ["workers-ts/src/controllers/api/v1/AdminDivisionController.ts"]);
add("/admin/agent/promoter/apply", "candidate", ["/agent/promoter-applications"],
  ["GET /adminapi/promoter/apply/list", "POST /adminapi/promoter/apply/examine/:id/:uid/:status", "DELETE /adminapi/promoter/apply/del/:id"],
  "独立申请审核屏按状态/姓名/UID/昵称/电话筛选、每页15条ID倒序，展示申请资料、状态、UTC申请/审核时间与拒绝原因；distribution.view只读，distribution.manage可确认通过、填写拒绝原因及软删。新POST审核和带JSON的DELETE提交行版本，锁后拒绝过期材料，重复结果不改时间/日志；申请与资格写入及脱敏管理员日志同事务。",
  "真实申请资料、受限角色及发布后业务仍待验收。旧页重复电话列合并，原images插槽未配置为实际表列，不据此伪称有图片合同；新拒绝原因必填与UTC标识为明确扩展。旧GET审核与无请求体DELETE保留兼容，但没有新UI的行版本确认，跨代旧确认风险仍需协调退流。",
  ["workers-ts/src/controllers/api/v1/PromoterApplicationController.ts", "workers-ts/src/services/agent/PromoterApplicationService.ts", "workers-ts/test/admin-promoter-application.test.ts", "workers-ts/test/admin-promoter-application-postgres.test.ts", "workers-ts/test/admin-promoter-applications-frontend.test.ts"]);

if (divisionStatisticsFollowup) {
  reviews["/admin/agent/statistics"] = {
    status: "partial",
    targetScreens: ["/division/statistics"],
    targetApis: [
      "GET /adminapi/agent/division/statistics-screen/summary",
      "GET /adminapi/agent/division/statistics-screen/trend",
      "GET /adminapi/agent/division/statistics-screen/ranking",
    ],
    covered: ["独立只读统计页恢复六张全期卡、上海日期趋势（单日小时、2–31日逐日、32–92日每三日单点、长区间逐月）及代理商／员工分列排行；独立 division_statistics.view，受限角色按事业部限制数据。"],
    remaining: ["旧 PHP 受限代理商排行把代理商 UID 当作事业部 ID 查询订单及下级，可能跨事业部读数；新合同强制与当前事业部求交集，并按管理员 level 拒绝未绑定事业部的普通角色。旧跨日范围包含结束日次日零点，新合同使用排他上界；无界旧排行改为500行硬上限。这些安全/边界差异有意不复刻，真实角色与历史数据、生产规模、完整 Linux CI 和发布后验收仍开放。"],
    evidence: [
      "cinashop-php/view/admin/src/api/statistic.js",
      "workers-ts/src/services/admin/AdminDivisionStatisticsScreenService.ts",
      "workers-ts/docs/admin-division-statistics-read-contract.md",
      "view/admin-ts/src/pages/agent/DivisionStatistics.vue",
      "view/admin-ts/src/api/divisionStatistics.ts",
      "workers-ts/test/admin-division-statistics-read-postgres.test.ts",
      "workers-ts/test/admin-division-statistics-frontend.test.ts",
    ],
  };
}

if (supplierBillFollowup) {
  const billApis = [
    "GET /adminapi/supplier/bill-screen/suppliers",
    "GET /adminapi/supplier/bill-screen/groups",
    "GET /adminapi/supplier/bill-screen/details",
    "GET /adminapi/supplier/bill-screen/export",
  ];
  const billEvidence = [
    "workers-ts/src/services/admin/AdminSupplierBillScreenService.ts",
    "workers-ts/src/controllers/api/v1/AdminSupplierBillScreenController.ts",
    "workers-ts/docs/admin-supplier-bill-read-contract.md",
  ];
  reviews["/admin/supplier/bill/index"] = {
    status: "candidate",
    targetScreens: ["/supplier/bills"],
    targetApis: billApis,
    covered: ["独立供应商账单页按供应商、上海日期和日／周／月分页汇总流水，可打开同组明细并导出完整有界清单；默认状态含待结算、已结算和无效记录，且保留软删／孤儿供应商的历史流水。supplier_bill.view 独立授权，明细与导出按供应商、状态、期间及日期条件重新校验。"],
    remaining: ["旧 GROUP BY 直接投非确定性 add_time 和无序 ID 串，新页改显示稳定期间键并避免依赖可能截断的 GROUP_CONCAT；旧导出忽略 supplier_id，只在客户端传来的 ID 串内导出，新页改为同范围有界全量导出。真实财务历史、受限角色浏览器、生产规模及发布后验收仍开放。"],
    evidence: billEvidence,
  };
  reviews["/admin/supplier/bill/index/:type?"] = {
    status: "candidate",
    targetScreens: ["/supplier/bills"],
    targetApis: billApis,
    covered: ["同一账单工作台可用 status 查询深链承接旧 :type 状态意图；status=1 按 finish_time 分组与排序，其余状态按 add_time，日期条件始终筛 add_time；日／周／月及明细／导出与无参页共用同一受限合同。"],
    remaining: ["旧路径参数改由新页 status 查询参数承载；稳定期间键、导出供应商隔离及容量上限是对旧非确定分组与 ID 串截断／越界导出的受控纠偏。真实财务历史、受限角色浏览器、生产规模及发布后验收仍开放。"],
    evidence: billEvidence,
  };
  reviews["/admin/supplier/apply"].remaining = ["旧页按上海 add_time 日期筛选、七字段关键词、展示全部资质图片并支持重置及删除末页回退；新页仅搜三个字段、展示首图且重提不刷新 add_time。新页也缺只读按钮门禁、切号／迟到响应隔离及审核时申请材料版本校验，旧审核通知未迁入。故保留 partial。"];
  reviews["/admin/agent/apply_list"].remaining = ["旧页默认全部状态、每页15条，展示区域代理名称、邀请码及全部证明图片；新 tab 默认待审、每页20条，缺上述列和材料，时间随浏览器时区显示，且缺 division.view/manage 前端门禁、切号与迟到审核保护。旧 DAO 搜索不存在的 agent_name 列属旧缺陷，不复刻。故保留 partial。"];
}

if (supplierCapitalFollowup) {
  reviews["/admin/supplier/capital/index"] = {
    status: "candidate",
    targetScreens: ["/supplier/capital-flow"],
    targetApis: [
      "GET /adminapi/supplier/capital-screen/suppliers",
      "GET /adminapi/supplier/capital-screen/list",
      "GET /adminapi/supplier/capital-screen/export",
      "PUT /adminapi/supplier/capital-screen/remark/:id",
    ],
    covered: ["独立供应商流水页按供应商、上海创建时间及交易单号／交易人筛选，ID倒序每页20条，显示原交易、收支、供应商、交易人、类型、支付方式和平台备注；同范围有界八列导出。supplier_capital.view 可读、supplier_capital.manage 才能修改平台 remark，写入使用旧值确认并保护系统拆单血缘，不触碰供应商自用 mark。"],
    remaining: ["旧导出未设条数上限，新合同超过容量明确拒绝；旧备注无版本并可覆盖系统血缘，新写法冲突后重读且禁止修改已识别的机器血缘。已软删用户的原始关键词搜索可能匹配其身份，新合同作隐私收紧。真实流水历史、受限角色浏览器、生产规模及发布后验收仍开放。"],
    evidence: [
      "workers-ts/src/services/admin/AdminSupplierCapitalScreenService.ts",
      "workers-ts/src/controllers/api/v1/AdminSupplierCapitalScreenController.ts",
      "workers-ts/docs/admin-supplier-capital-contract.md",
    ],
  };
}

if (supplierOrderStatisticsFollowup) {
  reviews["/admin/supplier/orderStatistics/index"] = {
    status: "candidate",
    targetScreens: ["/supplier/order-statistics"],
    targetApis: [
      "GET /adminapi/supplier/order-statistics-screen/suppliers",
      "GET /adminapi/supplier/order-statistics-screen/summary",
      "GET /adminapi/supplier/order-statistics-screen/trend",
      "GET /adminapi/supplier/order-statistics-screen/channel",
      "GET /adminapi/supplier/order-statistics-screen/type",
      "GET /adminapi/supplier/order-statistics-screen/supplier-table",
    ],
    covered: ["独立 Admin 供应商订单统计页按供应商与上海日期显示汇总卡、营业趋势、五种来源订单数、九种订单类型金额及供应商统计表；服务端按独立 supplier_order_statistics.view 授权，表格有界分页，时间与筛选对所有区块同步。旧 pid=>0 经搜索器是 pid>=0，包含子单但排除 pid=-1 支付父单；各区块按旧实际退款和删除口径分别计算。"],
    remaining: ["旧四卡因页面数组未填充而不可见、默认日期初始化晚于首个请求、表格未真正分页，32–92日稀疏轴丢数据及跨月末步进可跳月；新页明确修复展示与聚合，使用有界分页和日期范围。旧供应商表忽略 supplier_id，新页依实际筛选隔离；旧趋势仅能另存为图片，没有 CSV/Excel 合同。真实供应商订单历史、受限角色浏览器、生产规模及发布后验收仍开放。"],
    evidence: [
      "workers-ts/src/services/admin/AdminSupplierOrderStatisticsScreenService.ts",
      "workers-ts/src/controllers/api/v1/AdminSupplierOrderStatisticsScreenController.ts",
      "workers-ts/docs/admin-supplier-order-statistics-contract.md",
    ],
  };
}

if (supplierCashFollowup) {
  reviews["/admin/supplier/cash/index"] = {
    status: "candidate",
    targetScreens: ["/finance/supplier-extract"],
    targetApis: [
      "GET /adminapi/supplier/extract/suppliers",
      "GET /adminapi/supplier/extract/list",
      "POST /adminapi/supplier/extract/verify/:id",
      "POST /adminapi/supplier/extract/save_transfer/:id",
      "POST /adminapi/supplier/extract/mark/:id",
    ],
    covered: ["供应商提现页恢复供应商、上海申请时间、独立审核与转账状态、收款方式筛选和15条分页；显示待审核、待转账、已转账及可提现金额，并可审核、登记实际转账、编辑与供应商端共享的备注。历史已删供应商记录仍可读，备注以原值确认防并发覆盖，supplier_extract.view/manage 分离，旧菜单1578只映射查看。"],
    remaining: ["旧全部供应商可提现汇总把0当作供应商ID，可能漏减历史提现；新合同按全部供应商净流水减未拒绝提现纠偏。旧动态转账表单改为原生弹窗，不冒充其精确PHP路由。真实财务历史、受限角色浏览器、实际转账、生产规模及发布后验收仍开放。"],
    evidence: [
      "workers-ts/src/services/admin/AdminSupplierFinanceService.ts",
      "workers-ts/src/controllers/api/v1/AdminSupplierFinanceController.ts",
      "workers-ts/docs/admin-supplier-extract-contract.md",
    ],
  };
}

if (supplierClosureFollowup) {
  reviews["/admin/supplier/apply"] = {
    status: "candidate",
    targetScreens: ["/supplier/applications"],
    targetApis: ["GET /adminapi/supplier/apply/list", "GET /adminapi/supplier/apply/info/:id",
      "POST /adminapi/supplier/apply/verify/:id", "POST /adminapi/supplier/apply/mark/:id",
      "DELETE /adminapi/supplier/apply/del/:id"],
    covered: ["申请屏恢复上海秒级日期、状态和七字段搜索，完整资质图、审核、备注与软删；读写分权并隔离切号迟到请求。审核与用户重提统一加锁顺序，行版本指纹阻止过期材料被审核，按旧通知开关在事务中写无明文密码的站内信。"],
    remaining: ["旧客户端写请求没有 expected_version，需升级新管理页；旧 PHP 按宽松比较处理 status=0 可能失效，新页明确筛待审核。旧审批还可触发已配置的短信/微信通知，本批只恢复站内信；真实申请材料、通知渠道、受限角色浏览器及发布后验收仍开放。"],
    evidence: ["workers-ts/src/services/supplier/SupplierApplicationService.ts",
      "workers-ts/test/admin-supplier-application-contract.test.ts",
      "workers-ts/test/admin-supplier-application-postgres.test.ts",
      "workers-ts/test/admin-supplier-application-http.test.ts",
      "workers-ts/test/admin-supplier-applications-frontend.test.ts"],
  };
  const directoryApis = ["GET /adminapi/supplier/supplier", "GET /adminapi/supplier/supplier/cities",
    "GET /adminapi/supplier/supplier/:id", "POST /adminapi/supplier/supplier",
    "PUT /adminapi/supplier/supplier/:id", "PUT /adminapi/supplier/supplier/set_status/:id/:status",
    "DELETE /adminapi/supplier/supplier/:id"];
  const directoryEvidence = ["workers-ts/src/services/admin/AdminSupplierDirectoryService.ts",
    "workers-ts/src/controllers/api/v1/AdminSupplierDirectoryController.ts",
    "workers-ts/test/admin-supplier-directory-service-postgres.test.ts",
    "workers-ts/test/admin-supplier-directory-frontend.test.ts"];
  reviews["/admin/supplier/menu/list"] = {
    status: "partial", targetScreens: ["/supplier/directory"], targetApis: directoryApis,
    covered: ["独立目录页恢复已入驻供应商的名称查询、分页、状态、软删和手工建档/编辑；主账号与供应商同事务绑定，编辑和状态操作校验记录修订，删除限制未完成订单并保留历史财务，独立 supplier_directory.view/manage。"],
    remaining: ["旧快捷登录通过空密码绕过停用状态；新 Worker 不开放该路径，未来需独立代登录授权、一次性交接和审计。旧目录删除会物理清理部分商品/附件，新实现保留历史并停止公开展示；真实账号、订单和受限角色仍待验收。"],
    evidence: directoryEvidence,
  };
  reviews["/admin/supplier/supplierAdd/:id?"] = {
    status: "candidate", targetScreens: ["/supplier/directory"], targetApis: directoryApis,
    covered: ["供应商目录内的建档/编辑表单恢复联系人、电话、邮箱、省市区街道、地址、备注、排序、启停、主账号和密码字段；校验与事务绑定保证新建账号唯一，编辑空密码保留旧哈希，修改需版本与原账号双确认。"],
    remaining: ["旧独立 supplierAdd 深链接改为目录内弹窗；旧客户端不带 expected_revision/expected_account 时不可直接写。真实地址层级、账号历史和发布后验收仍开放。"],
    evidence: directoryEvidence,
  };
  reviews["/admin/agent/agreement"] = {
    status: "candidate", targetScreens: ["/agent/agreement"],
    targetApis: ["GET /adminapi/agent/get_agent_agreement", "POST /adminapi/agent/set_agent_agreement/:id"],
    covered: ["独立分销说明页读写固定 type=2 协议，保留启停与 HTML 编辑；服务端清洗新旧正文，公开协议、推广员申请和旧 v2 消费者均投影安全内容。写入用 revision 防双窗口覆盖，旧菜单仅映射查看，不能通过 body.id/type 改写会员协议。"],
    remaining: ["旧 Admin POST 仅提交 content/status，需升级新页面携带 revision；清洗可能移除历史危险标签。真实历史富文本、受限角色浏览器和发布后验收仍开放。"],
    evidence: ["workers-ts/src/services/admin/AdminAgentAgreementService.ts",
      "workers-ts/test/admin-agent-agreement-http.test.ts",
      "view/admin-ts/src/pages/agent/AgentAgreement.vue"],
  };
}

if (supplierMenuFollowup) {
  reviews["/admin/supplier/supplier/index"] = {
    status: "partial", targetScreens: ["/supplier/menu-rules"],
    targetApis: ["GET /adminapi/supplier/menu-rules", "GET /adminapi/supplier/menu-rules/catalog",
      "GET /adminapi/supplier/menu-rules/:id"],
    covered: ["独立页面只读清点 type=4 非删除供应商菜单/接口规则、显示状态与原始角色数字引用，并把规则可映射的稳定权限和固定 Supplier 导航目录分开呈现；双 Admin 前缀及独立 supplier_menu_rules.view。"],
    remaining: ["前端尚无创建、编辑、显隐与删除；后台写路由在独立数据库能力未就绪时返回 503，真实环境安装、受限角色及导航影响仍须验收。新导航不由 system_menus 生成，不能把只读规则清点当作旧动态菜单编辑闭环。"],
    evidence: ["workers-ts/docs/admin-supplier-menu-rules-gap.md",
      "workers-ts/src/services/admin/AdminSupplierMenuRuleService.ts",
      "workers-ts/src/migrations/adminSupplierMenuWriteCapability.ts",
      "workers-ts/test/admin-supplier-menu-rules-read.test.ts",
      "workers-ts/test/admin-supplier-menu-rules-http.test.ts",
      "workers-ts/test/admin-supplier-menu-write-capability.test.ts",
      "workers-ts/test/admin-supplier-menu-rules-frontend.test.ts"],
  };
}

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
  target: { routes: InventoryRoute[] };
};
for (const [file, hash] of Object.entries(routerHashes)) {
  if (inventory.legacy.routeFiles.find((item) => item.file === file)?.sha256 !== hash) throw new Error(`Legacy router snapshot changed: ${file}`);
}
const routesInScope = inventory.legacy.routes.filter((route) => route.surface === "page" && (route.source === supplierRouter || route.source === agentRouter));
if (routesInScope.length !== 19) throw new Error(`Expected 19 supplier/agent business routes, found ${routesInScope.length}`);
const scopedPaths = new Set(routesInScope.map((route) => route.path));
if (scopedPaths.size !== 19) throw new Error("Duplicate supplier/agent inventory paths");
for (const map of [reviews, legacy]) for (const path of Object.keys(map)) if (!scopedPaths.has(path)) throw new Error(`Review outside scope: ${path}`);
const targetPaths = new Set(inventory.target.routes.filter((route) => route.surface === "page").map((route) => route.path));
const adminRouteSource = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
const registeredApis = new Set([...adminRouteSource.matchAll(/adminapiRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)]
  .map((match) => `${match[1].toUpperCase()} /adminapi${match[2]}`));
const refundOperationSource = readFileSync(resolve(workerRoot, "src/routes/admin-refund-operations.ts"), "utf8");
for (const match of refundOperationSource.matchAll(/adminRefundOperationRoutes\.(get|post|put|delete)\(\s*'([^']+)'/gu)) {
  registeredApis.add(`${match[1].toUpperCase()} /adminapi/refund/operations${match[2]}`);
}
function permissionForApi(api: string): string {
  const [method, path] = api.split(" ");
  if (path === "/adminapi/promoter/apply/examine/:id/:uid/:status") return "distribution.manage";
  const domain = path.startsWith("/adminapi/supplier/apply/") ? "supplier_application"
    : path.startsWith("/adminapi/supplier/menu-rules") ? "supplier_menu_rules"
    : path.startsWith("/adminapi/supplier/supplier") ? "supplier_directory"
      : path.startsWith("/adminapi/agent/get_agent_agreement") || path.startsWith("/adminapi/agent/set_agent_agreement/") ? "agent_agreement"
    : path.startsWith("/adminapi/supplier/bill-screen/") ? "supplier_bill"
      : path.startsWith("/adminapi/supplier/capital-screen/") ? "supplier_capital"
        : path.startsWith("/adminapi/supplier/order-statistics-screen/") ? "supplier_order_statistics"
    : path.startsWith("/adminapi/supplier/extract/") ? "supplier_extract"
      : path.startsWith("/adminapi/order/") ? "order"
        : path.startsWith("/adminapi/refund/") ? "refund"
        : path.startsWith("/adminapi/agent/division/statistics-screen/") ? "division_statistics"
          : path.startsWith("/adminapi/agent/division") ? "division"
            : path.startsWith("/adminapi/spread/") || path.startsWith("/adminapi/brokerage/") || path.startsWith("/adminapi/promoter/") ? "distribution" : null;
  if (!domain) throw new Error(`Unmapped supplier/agent API permission: ${api}`);
  return `${domain}.${method === "GET" ? "view" : "manage"}`;
}
function evidenceExists(file: string): boolean {
  if (file.startsWith("cinashop-php/")) return true;
  return existsSync(resolve(workerRoot, "..", file));
}
const routes = routesInScope.map((route) => {
  const review = reviews[route.path];
  const old = legacy[route.path];
  if (!review || !old || !route.resolvedComponent || route.line <= 0) throw new Error(`Incomplete supplier/agent review: ${route.path}`);
  if (!review.remaining.length || !review.remaining[0]) throw new Error(`No remaining-gap conclusion: ${route.path}`);
  if (review.status === "missing" ? review.targetScreens.length > 0 || review.covered.length > 0 : review.targetScreens.length === 0 || review.covered.length === 0) throw new Error(`Inconsistent coverage: ${route.path}`);
  for (const screen of review.targetScreens) if (!targetPaths.has(screen) || !screens[screen]) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const oldRouter = `cinashop-php/view/admin/${route.source}`;
  const oldApi = route.source === supplierRouter ? "cinashop-php/view/admin/src/api/supplier.js" : "cinashop-php/view/admin/src/api/agent.js";
  const behaviorSource = `${componentPath}:${old.line}`;
  const evidence = [...new Set([
    oldRouter, componentPath, behaviorSource, oldApi, oldPhpRoutes, targetRouter, adminRoutes, permissionRules,
    ...review.targetScreens.flatMap((screen) => [screens[screen].file, screens[screen].adapter]),
    ...review.evidence,
  ])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  const targetPermissions = [...new Set([
    ...review.targetScreens.map((screen) => `${screens[screen].permission}.view`),
    ...review.targetApis.map(permissionForApi),
  ])];
  return {
    legacy: {
      path: route.path, title: route.title, component: route.component, resolvedComponent: componentPath,
      behaviorSource, source: `${oldRouter}:${route.line}`, routerSha256: routerHashes[route.source],
      parentAuth: route.source === agentRouter ? "true" : null, auth: old.auth,
    },
    ...review, targetPermissions, evidence,
  };
});
const statuses: Status[] = ["candidate", "partial", "missing", "retired"];
const counts = Object.fromEntries(statuses.map((status) => [status, routes.filter((route) => route.status === status).length]));
const report = {
  version: 1,
  generatedFrom: "audit/admin-frontend-inventory.json",
  methodology: {
    scope: "Only the 11 supplier.js and 8 agent.js surface=page business routes in the authoritative 274-page inventory. The supplier/finance/set commonForm auxiliary route is excluded.",
    reviewBasis: "Compare pinned legacy Vue behavior, auth, PHP API and data entity with actual target Admin operations, registered Worker routes and target permission. Legacy auth and behavior lines are static reviewed evidence; generation requires only this repository. A similar page title or API alone cannot establish screen parity.",
    validationBoundary: "Code-only semantic review. No production data, historical supplier/agent reconciliation, real-role browser E2E, financial transfer, deployment or publication is claimed. FE-001D remains open.",
  },
  summary: { legacyRoutes: routes.length, reviewed: routes.length, ...counts, unreviewed: 0 },
  routes,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write")) {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, serialized, "utf8");
  console.log(`Wrote ${outputFile}`);
} else process.stdout.write(serialized);
