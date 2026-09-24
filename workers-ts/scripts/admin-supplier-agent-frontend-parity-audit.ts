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
const outputFile = resolve(workerRoot, "audit/admin-legacy-supplier-agent-route-parity.json");
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
  "/finance/supplier-extract": { file: "view/admin-ts/src/pages/finance/SupplierExtractList.vue", adapter: "view/admin-ts/src/api/finance.ts", permission: "supplier_extract" },
  "/order": { file: "view/admin-ts/src/pages/order/OrderList.vue", adapter: "view/admin-ts/src/api/order.ts", permission: "order" },
  "/refund": { file: "view/admin-ts/src/pages/refund/RefundList.vue", adapter: "view/admin-ts/src/api/refund.ts", permission: "refund" },
  "/agent": { file: "view/admin-ts/src/pages/agent/AgentList.vue", adapter: "view/admin-ts/src/pages/agent/AgentList.vue", permission: "distribution" },
  "/division": { file: "view/admin-ts/src/pages/agent/DivisionManagement.vue", adapter: "view/admin-ts/src/api/division.ts", permission: "division" },
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
add("/admin/agent/promoter/apply", "missing", [],
  ["GET /adminapi/promoter/apply/list", "GET /adminapi/promoter/apply/examine/:id/:uid/:status", "DELETE /adminapi/promoter/apply/del/:id"], "",
  "旧推广员申请页有列表、材料审阅、通过/拒绝和删除；Worker 已注册申请 API，但新 /agent 没有申请管理 tab 或可执行审核屏。审核接口仍使用 GET；本地候选修复已对该写操作显式要求 distribution.manage，仍需 CI 和真实角色验收。API 注册不能代替旧页面。",
  ["workers-ts/src/controllers/api/v1/PromoterApplicationController.ts", "view/admin-ts/src/pages/agent/AgentList.vue"]);

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
    : path.startsWith("/adminapi/supplier/extract/") ? "supplier_extract"
      : path.startsWith("/adminapi/order/") ? "order"
        : path.startsWith("/adminapi/refund/") ? "refund"
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
