import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "candidate" | "partial" | "missing" | "retired";
type InventoryRoute = { source: string; line: number; path: string; title: string | null; component: string; resolvedComponent: string | null; surface: string };
type Review = { status: Status; targetScreens: string[]; targetApis: string[]; covered: string[]; remaining: string[]; evidence: string[] };
const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(workerRoot, "..");
const userMoneyFollowup = process.argv.includes("--user-money-ledger-followup");
const commissionFollowup = userMoneyFollowup || process.argv.includes("--commission-followup");
const rechargeFollowup = commissionFollowup || process.argv.includes("--recharge-followup");
const inventoryName = userMoneyFollowup
  ? "admin-frontend-inventory-user-money-ledger-followup-20260928.json"
  : commissionFollowup
  ? "admin-frontend-inventory-commission-followup-20260928.json"
  : rechargeFollowup ? "admin-frontend-inventory-read-followup-20260928.json" : "admin-frontend-inventory.json";
const outputName = userMoneyFollowup
  ? "admin-legacy-cross-module-route-parity-user-money-ledger-followup-20260928.json"
  : commissionFollowup
  ? "admin-legacy-cross-module-route-parity-commission-followup-20260928.json"
  : rechargeFollowup ? "admin-legacy-cross-module-route-parity-recharge-followup-20260928.json"
    : "admin-legacy-cross-module-route-parity.json";
const inventoryFile = resolve(workerRoot, `audit/${inventoryName}`);
const outputFile = resolve(workerRoot, `audit/${outputName}`);
const targetRouter = "view/admin-ts/src/router/index.ts";
const targetApis = "workers-ts/src/routes/adminapi.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const legacyHashes: Record<string, string> = {
  "src/router/routes.js": "9432b5a0b65c09adaf828dbb7125352eea94c54b444f5197647c59aa40fe13c2",
  "src/router/modules/statistic.js": "caca56271cc861e0a1bb6c5bbb00d1271fb9c20d7b6535014bbf4a3c0640e93f",
  "src/router/modules/finance.js": "03e5ca60c72930a0aee0d0d52b76a97c231b41ca86174d9de8853b46628a92a0",
  "src/router/modules/echarts.js": "802b0c43086a708e236580a94958b037bf30c27795f5e4fe05144537762afbaa",
  "src/router/modules/frameOut.js": "88b9a955c75fc95b44fcff0ffe5a75b7f9a631be23a49276fb02db7668b628e6",
  "src/router/modules/index.js": "17c65f8061218397fa3ace2d4763760bb9dbdaac500f5695ed74fabf21c405c6",
  "src/router/modules/system.js": "f84e11ebb974799f4cf3da05daa772c9b973c07960ddb6e86fcef823b58cb0ff",
};
const legacyAuth: Record<string, string> = {
  "/": "['admin-index-index']",
  "/admin/out": "['admin-out']",
  "/admin/out_interface": "['admin-out-interface']",
  "/admin/pages/diy": "['admin-setting-pages-diy']",
  "/admin/pages/special/diy": "['setting-diy-special-diy']",
  "/admin/echarts/trade/order": "['admin-order-storeOrder-index']",
  "/admin/echarts/trade/product": "['admin-order-storeOrder-index']",
  "/admin/finance/user_extract/index": "['finance-user_extract']",
  "/admin/finance/user_recharge/index": "['finance-user-recharge']",
  "/admin/finance/finance/bill": "['finance-finance-bill']",
  "/admin/finance/finance/commission": "['finance-finance-commission']",
  "/admin/login": "public",
  "/admin/statistic/product": "inherited auth: true",
  "/admin/statistic/user": "inherited auth: true",
  "/admin/statistic/transaction": "inherited auth: true",
  "/admin/statistic/capital": "['admin-statistic-capital']",
  "/admin/statistic/order": "inherited auth: true",
  "/admin/statistic/balance": "inherited auth: true",
};
const behaviorLines: Record<string, number> = {
  "/": 5, "/admin/out": 49, "/admin/out_interface": 17,
  "/admin/pages/diy": 31, "/admin/pages/special/diy": 21,
  "/admin/echarts/trade/order": 174, "/admin/echarts/trade/product": 1,
  "/admin/finance/user_extract/index": 16, "/admin/finance/user_recharge/index": 16,
  "/admin/finance/finance/bill": 14, "/admin/finance/finance/commission": 15,
  "/admin/login": 119, "/admin/statistic/product": 4, "/admin/statistic/user": 10,
  "/admin/statistic/transaction": 4, "/admin/statistic/capital": 14,
  "/admin/statistic/order": 8, "/admin/statistic/balance": 8,
};
const screens: Record<string, { file: string; marker: string; permission: string }> = {
  "/dashboard": { file: "view/admin-ts/src/pages/Dashboard.vue", marker: 'path: "dashboard"', permission: "dashboard.view" },
  "/order": { file: "view/admin-ts/src/pages/order/OrderList.vue", marker: 'path: "order"', permission: "order.view" },
  "/system/out": { file: "view/admin-ts/src/pages/system/ExternalApi.vue", marker: 'path: "system/out"', permission: "external_api.view/external_api.manage" },
  "/login": { file: "view/admin-ts/src/pages/Login.vue", marker: 'path: "/login"', permission: "public_login" },
  "/config/forms": { file: "view/admin-ts/src/pages/config/SystemForms.vue", marker: 'path: "config/forms"', permission: "config.view/config.manage" },
  "/content/dise": { file: "view/admin-ts/src/pages/content/DiseList.vue", marker: 'path: "content/dise"', permission: "dise.view/dise.manage" },
  "/finance/extract": { file: "view/admin-ts/src/pages/finance/ExtractList.vue", marker: 'path: "finance/extract"', permission: "extract.view/extract.manage" },
  "/finance/bill": { file: "view/admin-ts/src/pages/finance/BillList.vue", marker: 'path: "finance/bill"', permission: "bill.view" },
  "/finance/capital-flow": { file: "view/admin-ts/src/pages/finance/CapitalFlowList.vue", marker: 'path: "finance/capital-flow"', permission: "capital_flow.view/capital_flow.manage" },
  "/finance/recharges": { file: "view/admin-ts/src/pages/finance/RechargeOrders.vue", marker: 'path: "finance/recharges"', permission: "recharge_order.view" },
  "/finance/commissions": { file: "view/admin-ts/src/pages/finance/CommissionRecords.vue", marker: 'path: "finance/commissions"', permission: "commission.view" },
  "/statistic": { file: "view/admin-ts/src/pages/statistic/Dashboard.vue", marker: 'path: "statistic"', permission: "statistic.view" },
};
const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApisForRoute: string[], covered: string, remaining: string, evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate cross-module review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis: targetApisForRoute, covered: covered ? [covered] : [], remaining: [remaining], evidence };
}

add("/", "partial", ["/dashboard"], ["GET /adminapi/home/header", "GET /adminapi/home/order", "GET /adminapi/home/user"],
  "新控制台列出经营统计卡、订单周期趋势、近 30 天新增用户与购买用户分层，并加载待办提醒。",
  "旧 gridMenu 的运营快捷入口与旧首页组件筛选/卡片细项未逐项迁移核对；需用生产数据核对图表和统计口径。",
  ["cinashop-php/view/admin/src/pages/index/components/gridMenu.vue", "view/admin-ts/src/api/auth.ts", "workers-ts/src/controllers/api/v1/AdminController.ts"]);
add("/admin/out", "partial", ["/system/out"], ["GET /adminapi/system_out/index", "POST /adminapi/system_out/save", "GET /adminapi/system_out/interface/list"],
  "新对外接口页可筛选、新建、编辑、启停和删除 API 账户，按接口树授权，并以一次性密钥轮换替代明文重显。",
  "旧推送开关、推送账号/密码、Token URL、用户/订单/售后回调及测试链接未迁移；Worker 的 set_up/text_out_url 明确返回不可用，旧明文凭据也不能原样复用。",
  ["view/admin-ts/src/api/externalApi.ts", "workers-ts/src/controllers/api/v1/AdminOutApiController.ts"]);
add("/admin/out_interface", "partial", ["/system/out"], ["GET /adminapi/system_out/interface/list", "GET /adminapi/system_out/interface/info/:id"],
  "新对外接口页的接口目录和详情抽屉可查看方法、URL、描述及请求/返回示例，并标出运行时状态。",
  "旧接口文档页可新增分类与接口、改名、编辑方法/参数/示例、保存或删除；Worker 文档写接口明确为只读不可用，新页也无编辑流程。",
  ["view/admin-ts/src/api/externalApi.ts", "workers-ts/src/controllers/api/v1/AdminOutApiController.ts"]);

add("/admin/pages/diy", "partial", ["/content/dise"], ["GET /adminapi/dise/list", "POST /adminapi/dise/save"],
  "新 DIY 目录可列出、建立并编辑首页合同的 value JSON，按旧字段保存。",
  "旧拖拽装修组件、页面预览、默认首页切换及小程序码入口未在新 Admin 提供可视化流程；新建默认停用。",
  ["view/admin-ts/src/pages/content/DiseList.vue", "workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
add("/admin/pages/special/diy", "missing", [], ["GET /adminapi/dise/list"], "",
  "旧专题页有独立装修、保存和重置；新 DIY 目录的新建动作固定 type=1 首页合同，没有专题页可视化编辑入口。",
  ["view/admin-ts/src/pages/content/DiseList.vue"]);
add("/admin/echarts/trade/order", "partial", ["/order", "/statistic"], ["GET /adminapi/order/chart", "GET /adminapi/order/list", "GET /adminapi/statistic/order/get_basic"],
  "旧页挂载时请求一次 GET /order/chart；服务端实际为 all/unpaid/unshipped/untake/unevaluate/complete 六项赋值。新订单页和只读 Worker /order/chart 以当前有效履约单口径提供六数；订单统计 tab 另有支付与退款统计。",
  "旧 PHP 默认仅平台、pid 0/-1 且含用户删除行；新页跨平台/门店/供应商统计未删除的当前履约单和拆单子单，需用历史数据核对范围差异。旧页的退款中/已退款标签读取 refunding/refund，但服务端对应赋值已注释；日期控件仅本地绑定，时间回调为空，类型/状态选择未重新请求计数。旧 PV/UV 曲线、固定卡片和 John Brown 样例表格仅是演示内容。",
  ["cinashop-php/view/admin/src/api/order.js:28", "cinashop-php/view/admin/src/pages/echarts/trade/order.vue:71", "cinashop-php/view/admin/src/pages/echarts/trade/order.vue:174", "cinashop-php/view/admin/src/pages/echarts/trade/order.vue:227", "cinashop-php/view/admin/src/pages/echarts/trade/order.vue:231", "cinashop-php/app/common/controller/Order.php:56", "cinashop-php/app/services/order/StoreOrderServices.php:1040", "cinashop-php/app/services/order/StoreOrderServices.php:1097", "cinashop-php/app/services/order/StoreOrderServices.php:1101", "workers-ts/src/services/admin/AdminOrderReadService.ts", "view/admin-ts/src/api/order.ts", "view/admin-ts/src/pages/statistic/Dashboard.vue"]);
add("/admin/echarts/trade/product", "retired", [], [], "",
  "旧组件仅空 template 和 name='product'，没有商品查询、图表或操作；真实商品统计另由 /admin/statistic/product 承担。",
  ["cinashop-php/view/admin/src/pages/echarts/trade/product.vue:1", "view/admin-ts/src/pages/statistic/Dashboard.vue"]);
add("/admin/finance/user_extract/index", "partial", ["/finance/extract"], ["GET /adminapi/extract/list", "POST /adminapi/extract/status/:id"],
  "新提现审核页可按状态列出申请，并按 extract.manage 通过或拒绝。",
  "旧日期/提现方式/账号筛选、统计卡、收款二维码、编辑收款资料、备注及无效状态动作未在新页等量呈现。",
  ["view/admin-ts/src/api/finance.ts"]);
if (rechargeFollowup) {
  add("/admin/finance/user_recharge/index", "partial", ["/finance/recharges"],
    ["GET /adminapi/finance/recharge-orders", "GET /adminapi/finance/recharge-orders/stats", "GET /adminapi/finance/recharge-orders/:id"],
    "独立充值订单页按 user_recharge 读取已付及未付订单，提供上海创建时间、支付状态、昵称/手机/UID/订单号筛选、20 条分页、已付本金与已记录退款等统计及只读详情；列表保留异常记录供核对，读取要求 recharge_order.view。",
    "旧页的充值退款、未付单删除和导出未迁移；真实角色浏览器与生产历史数据的筛选、金额和退款口径仍需验收，因此只读覆盖保持 partial。",
    ["view/admin-ts/src/pages/finance/RechargeOrders.vue", "view/admin-ts/src/api/rechargeOrders.ts", "workers-ts/src/services/admin/AdminRechargeOrderService.ts", "workers-ts/src/controllers/api/v1/AdminRechargeOrderController.ts"]);
} else {
  add("/admin/finance/user_recharge/index", "missing", [], ["GET /adminapi/bill/list"], "",
    "旧充值订单目录含已付/未付、充值单号、充值统计、退款和删除；新资金流水仅列已入账 user_bill，不能展示未付充值单或做充值退款。",
    ["view/admin-ts/src/pages/finance/BillList.vue", "workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
}
if (userMoneyFollowup) {
  add("/admin/finance/finance/bill", "candidate", ["/finance/bill"],
    ["GET /adminapi/finance/user-money-ledger", "GET /adminapi/finance/user-money-ledger/types", "GET /adminapi/finance/user-money-ledger/export"],
    "资金记录页改从旧表 user_money 读取，恢复昵称/用户ID、资金类型、上海时间筛选和每页20条分页；类型目录从同一账本产生。导出沿用旧会员ID、昵称、金额、类型、备注、创建时间六列，独立 bill.export，旧页面与列表/类型数字规则只映射 bill.view。",
    "旧 XLSX 导出改为 Excel 可打开的有界 CSV；负源金额/NaN/异常 pm 拒绝整份导出，列表仍可审阅。旧 PHP 在结束值恰为午夜时会自动多包含一天，新页采用明确上海时间终点；包含 LIKE 通配符的搜索词改按字面匹配。旧 URL 没有精确兼容别名。需以真实受限角色和代表性资金数据核对筛选、金额、导出规模及发布后行为，本地候选不等于生产验收。",
    ["view/admin-ts/src/api/userMoneyLedger.ts", "workers-ts/src/controllers/api/v1/AdminUserMoneyLedgerController.ts",
      "workers-ts/src/services/admin/AdminUserMoneyLedgerService.ts", "workers-ts/src/services/admin/AdminUserMoneyLedgerExportService.ts"]);
} else {
  add("/admin/finance/finance/bill", "partial", ["/finance/bill"], ["GET /adminapi/bill/list"],
    "新资金流水页分页列出 user_bill，显示用户、类型、收支金额、余额和备注。",
    "旧昵称/ID、时间、业务类型筛选及导出缺失；新页只筛收入/支出。",
    ["view/admin-ts/src/api/finance.ts", "workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
}
if (commissionFollowup) {
  add("/admin/finance/finance/commission", "partial", ["/finance/commissions"],
    ["GET /adminapi/finance/commissions", "GET /adminapi/finance/commissions/:uid", "GET /adminapi/finance/commissions/:uid/records"],
    "独立只读佣金记录页按用户与佣金流水提供昵称/账号/ID、上海时间和账户佣金范围筛选、20 条分页、当前账户佣金加审核中/已通过提现额汇总、用户详情及佣金明细；需 commission.view。",
    "旧导出全页循环仍缺；旧 GROUP BY u.uid 直接投 b.add_time 不确定，新页以最新匹配流水时间显式定义；旧列表同分钟日期扩为24小时、不同分钟只到结束分钟首秒，旧明细结束日还包含次日零点，新页改用完整分钟/整日排他上界；“提现到账”旧列实际包含审核中与手续费，真实角色和历史金额口径待验，故保持 partial。",
    ["view/admin-ts/src/pages/finance/CommissionRecords.vue", "view/admin-ts/src/api/commissionRecords.ts", "workers-ts/src/services/admin/AdminCommissionReadService.ts", "workers-ts/src/controllers/api/v1/AdminCommissionReadController.ts"]);
} else {
  add("/admin/finance/finance/commission", "missing", [], ["GET /adminapi/bill/list"], "",
    "旧页按用户汇总总佣金、账户佣金、提现到账佣金，并有用户明细和导出；新 user_bill 流水不是按用户聚合的佣金账本页面。",
    ["view/admin-ts/src/pages/finance/BillList.vue"]);
}
add("/admin/login", "partial", ["/login"], ["POST /adminapi/login"],
  "新管理端有账号密码登录、动态品牌素材和限流。",
  "旧页的短信登录、忘记密码/手机号重置和图形/拼图校验分支未由新登录屏承接。",
  ["view/admin-ts/src/stores/auth.ts", "view/admin-ts/src/api/publicBranding.ts"]);
add("/admin/statistic/product", "partial", ["/statistic"], ["GET /adminapi/statistic/product/get_basic", "GET /adminapi/statistic/product/get_product_ranking", "GET /adminapi/statistic/product/get_excel"],
  "新商品统计 tab 有基础指标、趋势、经营排行和 CSV 导出。",
  "旧排行可展开商品详情与更多筛选；新 tab 只显示排行行，旧导出与历史数据口径仍需核对。",
  ["view/admin-ts/src/api/statistic.ts", "cinashop-php/view/admin/src/pages/statistic/product/components/productRanking.vue"]);
add("/admin/statistic/user", "partial", ["/statistic"], ["GET /adminapi/statistic/user/get_basic", "GET /adminapi/statistic/user/get_region", "GET /adminapi/statistic/user/get_excel"],
  "新用户统计 tab 包含基础、趋势、微信、地域、性别和 CSV 导出。",
  "旧页面渠道及付费分析的全部切换/字段未逐项验证，历史统计和导出口径需真实数据对照。",
  ["view/admin-ts/src/pages/statistic/components/UserStatisticsPanel.vue", "view/admin-ts/src/api/statistic.ts"]);
add("/admin/statistic/transaction", "candidate", ["/statistic"], ["GET /adminapi/statistic/trade/top_trade", "GET /adminapi/statistic/trade/bottom_trade"],
  "新交易统计 tab 使用对应 top/bottom API，展示今日、月度及交易概况，并支持 CSV 导出。",
  "仍需以旧生产数据核对各支付/退款口径、图表时区和导出结果；代码分类不等于上线验收。",
  ["view/admin-ts/src/pages/statistic/components/TradeStatisticsPanel.vue", "view/admin-ts/src/api/statistic.ts"]);
add("/admin/statistic/capital", "candidate", ["/finance/capital-flow"], ["GET /adminapi/flow/get_list", "POST /adminapi/flow/set_mark/:id"],
  "新平台资金流水页使用独立 capital_flow 账本，可按交易类型、订单/昵称/电话/UID及时间区间筛选，分页显示旧列，并在 capital_flow.manage 权限下编辑备注。",
  "仍需真实角色浏览器验收及代表性资金流水数据核对，尤其时间边界、权限与备注保存结果；代码候选不等于生产验收。",
  ["workers-ts/src/controllers/api/v1/AdminCapitalFlowController.ts", "workers-ts/src/services/finance/CapitalFlowService.ts", "view/admin-ts/src/api/finance.ts", "view/admin-ts/src/pages/finance/capitalFlowRange.ts"]);
add("/admin/statistic/order", "candidate", ["/statistic"], ["GET /adminapi/statistic/order/get_basic", "GET /adminapi/statistic/order/get_channel", "GET /adminapi/statistic/order/get_type"],
  "新订单统计 tab 有支付/退款/优惠指标、营业趋势、来源和类型分布，对应旧统计 API。",
  "仍需用真实订单核对渠道归因、退款口径、统计日期边界和旧图表显示。",
  ["view/admin-ts/src/api/statistic.ts"]);
add("/admin/statistic/balance", "candidate", ["/statistic"], ["GET /adminapi/statistic/balance/get_basic", "GET /adminapi/statistic/balance/get_channel", "GET /adminapi/statistic/balance/get_type"],
  "新余额统计 tab 有当前余额、累计收入/支出、趋势及来源/消耗分布，对应旧统计 API。",
  "仍需用旧生产流水核对有效状态、分类和历史余额口径。",
  ["view/admin-ts/src/pages/statistic/components/BalanceStatisticsPanel.vue", "view/admin-ts/src/api/statistic.ts"]);

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as { legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] } };
for (const [file, sha] of Object.entries(legacyHashes)) {
  if (inventory.legacy.routeFiles.find((entry) => entry.file === file)?.sha256 !== sha) throw new Error(`Legacy router snapshot changed: ${file}`);
}
const alreadyReviewed = new Set(["/admin/system/log", "/admin/system/user", "/admin/setting/system/create"]);
const routeCounts: Record<string, number> = { "src/router/routes.js": 2, "src/router/modules/statistic.js": 6, "src/router/modules/finance.js": 4, "src/router/modules/echarts.js": 2, "src/router/modules/frameOut.js": 1, "src/router/modules/index.js": 1, "src/router/modules/system.js": 2 };
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && route.source in routeCounts && !alreadyReviewed.has(route.path)
  && (route.source !== "src/router/modules/frameOut.js" || route.path === "/admin/login")
  && (route.source !== "src/router/modules/system.js" || ["/admin/out", "/admin/out_interface"].includes(route.path)));
for (const [file, expected] of Object.entries(routeCounts)) {
  const found = legacyRoutes.filter((route) => route.source === file).length;
  if (found !== expected) throw new Error(`Expected ${expected} page routes from ${file}, found ${found}`);
}
if (legacyRoutes.length !== 18 || new Set(legacyRoutes.map((route) => route.path)).size !== 18) throw new Error("Expected 18 unique unreviewed cross-module business routes");
const pathSet = new Set(legacyRoutes.map((route) => route.path));
for (const path of Object.keys(reviews)) if (!pathSet.has(path)) throw new Error(`Unknown cross-module review: ${path}`);
for (const path of Object.keys(legacyAuth)) if (!pathSet.has(path)) throw new Error(`Unknown cross-module auth: ${path}`);
for (const path of Object.keys(behaviorLines)) if (!pathSet.has(path)) throw new Error(`Unknown cross-module behavior line: ${path}`);
const routerText = readFileSync(resolve(repositoryRoot, targetRouter), "utf8");
const apiText = readFileSync(resolve(repositoryRoot, targetApis), "utf8");
const registeredApis = new Set([...apiText.matchAll(/adminapiRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)].map((match) => `${match[1].toUpperCase()} /adminapi${match[2]}`));
if (userMoneyFollowup) {
  const requiredEvidence: Array<[string, string[]]> = [
    ["workers-ts/src/services/admin/AdminUserMoneyLedgerService.ts", ["USER_MONEY_LEDGER_EXCLUDED_TYPES", ".from(userMoney)", "FROM user_money"]],
    ["workers-ts/src/services/admin/AdminUserMoneyLedgerExportService.ts", ["USER_MONEY_EXPORT_HEADER", "WITH filtered AS MATERIALIZED", "FROM user_money"]],
    ["workers-ts/src/services/admin/AdminPermissionService.ts", ["bill.export", "finance-finance-bill", "export/userfinance"]],
    ["view/admin-ts/src/api/userMoneyLedger.ts", ["/finance/user-money-ledger", "csv_bytes", "snapshot"]],
    ["view/admin-ts/src/pages/finance/BillList.vue", ["apiUserMoneyLedger", "bill.export", "collectUserMoneyExport"]],
  ];
  for (const [file, markers] of requiredEvidence) {
    const contents = readFileSync(resolve(repositoryRoot, file), "utf8");
    for (const marker of markers) if (!contents.includes(marker)) throw new Error(`Incomplete user-money ledger evidence: ${file} lacks ${marker}`);
  }
}
function evidenceExists(file: string): boolean {
  if (file.startsWith("cinashop-php/")) return true;
  return existsSync(resolve(repositoryRoot, file));
}
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review || !route.resolvedComponent || !legacyAuth[route.path] || !behaviorLines[route.path]) throw new Error(`Incomplete review: ${route.path}`);
  if (!review.remaining.length || !review.remaining[0]) throw new Error(`Missing conclusion: ${route.path}`);
  if (["candidate", "partial"].includes(review.status) && (!review.covered.length || !review.targetScreens.length)) throw new Error(`Covered route lacks screen: ${route.path}`);
  if (["missing", "retired"].includes(review.status) && review.targetScreens.length) throw new Error(`Uncovered route claims target screen: ${route.path}`);
  for (const screen of review.targetScreens) {
    if (!screens[screen] || !routerText.includes(screens[screen].marker) || !evidenceExists(screens[screen].file)) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  }
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const legacyRouter = `cinashop-php/view/admin/${route.source}`;
  const component = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const evidence = [...new Set([legacyRouter, component, `${component}:${behaviorLines[route.path]}`, targetRouter, targetApis, permissionRules,
    ...review.targetScreens.map((screen) => screens[screen].file), ...review.evidence])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return {
    legacy: { path: route.path, title: route.title, component: route.component, resolvedComponent: component, behaviorSource: `${component}:${behaviorLines[route.path]}`, source: `${legacyRouter}:${route.line}`, routerSha256: legacyHashes[route.source], auth: legacyAuth[route.path] },
    ...review,
    targetPermissions: [...new Set(review.targetScreens.map((screen) => screens[screen].permission))],
    evidence,
  };
});
const statuses: Status[] = ["candidate", "partial", "missing", "retired"];
const counts = Object.fromEntries(statuses.map((status) => [status, routes.filter((route) => route.status === status).length]));
const report = {
  version: 1,
  generatedFrom: `audit/${inventoryName}`,
  methodology: {
    scope: "The 18 as-yet-unreviewed surface=page routes from routes.js (2), statistic.js (6), finance.js (4), echarts.js (2), only /admin/login from frameOut.js (1), index.js (1), and system.js (2). Three other routes.js pages already belong to the setting/system ledgers; Kefu frameOut pages belong to the kefu ledger.",
    reviewBasis: "Compare behavior-bearing old Vue components and APIs against actual target Admin screens, registered Worker APIs, data entities and permissions. Static old auth and component lines are pinned to seven router hashes; generation requires only this repository. An API-only route or similarly named screen does not establish parity. Empty or hard-coded demo screens are retired only with source evidence.",
    validationBoundary: "Code-only semantic review; no real-role browser E2E, representative data reconciliation, production deployment, or publication is claimed. Functional acceptance stays open.",
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
