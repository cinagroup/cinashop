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
  source: string;
  line: number;
  path: string;
  title: string | null;
  component: string;
  resolvedComponent: string | null;
  surface: string;
};

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(workerRoot, "..");
const inventoryFile = resolve(workerRoot, "audit/admin-frontend-inventory.json");
const outputFile = resolve(workerRoot, "audit/admin-legacy-kefu-route-parity.json");
const oldRouter = "cinashop-php/view/admin/src/router/modules/frameOut.js";
const oldApi = "cinashop-php/view/admin/src/api/kefu.js";
const oldKefuRoutes = "cinashop-php/route/kefu.php";
const targetKefuRouter = "view/kefu-ts/src/router/index.ts";
const targetKefuPage = "view/kefu-ts/src/pages/WorkbenchPage.vue";
const targetKefuApi = "view/kefu-ts/src/api/kefu.ts";
const targetKefuRoutes = "workers-ts/src/routes/kefuapi.ts";
const targetKefuController = "workers-ts/src/controllers/kefu/KefuController.ts";
const targetPcRouter = "view/pc-ts/src/router/index.ts";
const targetPcPage = "view/pc-ts/src/pages/service/CustomerService.vue";
const targetPcApi = "view/pc-ts/src/api/customerService.ts";
const targetMobilePage = "view/uniapp-ts/src/pages/user/kefu.vue";
const targetFeedbackPage = "view/uniapp-ts/src/pages/extension/customer_list/feedback.vue";
const targetMobileNavigation = "view/uniapp-ts/src/config/navigation.ts";
const targetV1Routes = "workers-ts/src/routes/v1/index.ts";
const legacyRouterSha256 = "88b9a955c75fc95b44fcff0ffe5a75b7f9a631be23a49276fb02db7668b628e6";

// Reviewed static snapshot of frameOut.js meta.auth / meta.kefu; CI needs no sibling PHP checkout.
const legacyAuth = "auth: true; kefu: true";
const oldBehaviorLine: Record<string, number> = {
  "/kefu": 14,
  "/kefu/mobile_list": 6,
  "/kefu/mobile_chat": 8,
  "/kefu/pc_list": 28,
  "/kefu/orderList/:type?/:toUid?": 18,
  "/kefu/orderDetail/:id?/:goname?": 21,
  "/kefu/orderDelivery/:id?/:orderId?": 17,
  "/kefu/user/index/:uid?/:type?": 11,
  "/kefu/goods/list": 7,
  "/kefu/goods/detail": 7,
  "/kefu/appChat": 24,
  "/kefu/mobile_user_chat": 8,
  "/kefu/mobile_feedback": 11,
};
const screens: Record<string, { file: string; router: string; marker: string; permission: string }> = {
  "/login": { file: "view/kefu-ts/src/pages/LoginPage.vue", router: targetKefuRouter, marker: 'path: "/login"', permission: "kefu_agent.login" },
  "/workbench": { file: targetKefuPage, router: targetKefuRouter, marker: 'path: "/workbench"', permission: "kefu_agent" },
  "/service": { file: targetPcPage, router: targetPcRouter, marker: 'path: "service"', permission: "pc_user_or_visitor" },
  "/pages/user/kefu": { file: targetMobilePage, router: targetMobileNavigation, marker: '"/pages/user/kefu"', permission: "mobile_user_or_visitor" },
  "/pages/extension/customer_list/feedback": { file: targetFeedbackPage, router: targetMobileNavigation, marker: '"/pages/extension/customer_list/feedback"', permission: "mobile_user" },
};
const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApis: string[], covered: string, remaining: string, evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate kefu review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered: covered ? [covered] : [], remaining: remaining ? [remaining] : [], evidence };
}

add("/kefu", "candidate", ["/login"], ["POST /kefuapi/login", "GET /kefuapi/scan/:key", "GET /kefuapi/wechat"],
  "独立客服登录页有账号密码、一次性扫码和微信授权入口；登录后只进入客服身份域。",
  "仍需用真实客服账号、扫码及微信回调做跨端验收；旧版权/站名动态展示没有等量迁移。",
  ["view/kefu-ts/src/stores/auth.ts", "workers-ts/src/middleware/kefu-auth.ts"]);
add("/kefu/mobile_list", "partial", ["/workbench"], ["GET /kefuapi/user/record"],
  "响应式工作台可按已注册/游客会话展示最近消息、未读数并搜索。",
  "旧移动端来源标签、下拉分页和在线/离线状态切换尚未完成等价验收；新工作台当前会话首次各取 60 条。",
  ["view/kefu-ts/src/services/realtime.ts"]);
add("/kefu/mobile_chat", "partial", ["/workbench"], ["GET /kefuapi/service/list", "POST /kefuapi/service/transfer"],
  "工作台可查看和回复会话、上传图片、使用快捷话术并转接给其他客服。",
  "旧移动会话中的订单/商品卡片、独立导航及所有消息类型未逐项证明等价；需真实客服角色实时双端验收。",
  ["view/kefu-ts/src/services/realtime.ts", "workers-ts/src/services/kefu/KefuSocketGateway.ts"]);
add("/kefu/pc_list", "partial", ["/workbench"], ["GET /kefuapi/user/record", "GET /kefuapi/service/list", "POST /kefuapi/service/transfer"],
  "独立桌面工作台有会话、实时消息、客户资料、订单/商品上下文、话术和转接。",
  "旧 PC 右侧菜单的全部改价/退款、富消息及订单操作未逐项等价；管理员会话页调用的 /adminapi/service/* 是 501，不能替代客服身份。",
  ["view/admin-ts/src/pages/kefu/KefuList.vue", "workers-ts/src/controllers/api/v1/AdminController.ts"]);
add("/kefu/orderList/:type?/:toUid?", "partial", ["/workbench"], ["GET /kefuapi/order/list/:uid", "GET /kefuapi/refund/list"],
  "工作台按当前客户列出订单和售后摘要，可搜索订单号或商品。",
  "旧移动订单页的多状态筛选、独立全页分页及核销入口未在该列表等量呈现；工作台每次仅请求 20 条。",
  ["workers-ts/src/services/kefu/KefuOrderService.ts"]);
add("/kefu/orderDetail/:id?/:goname?", "partial", ["/workbench"], ["GET /kefuapi/order/info/:id", "GET /kefuapi/order/refund/detail/:id"],
  "工作台弹窗展示订单/售后明细及部分改价、备注、履约和核销操作。",
  "旧独立页的赠品、虚拟信息、自定义表单、优惠拆项及退款材料未逐字段证明等价。",
  ["view/kefu-ts/src/types/kefu.ts"]);
add("/kefu/orderDelivery/:id?/:orderId?", "partial", ["/workbench"], ["POST /kefuapi/order/delivery/:id", "PUT /kefuapi/order/split_delivery/:id"],
  "工作台可按订单发货，支持快递、配送、虚拟发货和拆单商品数量。",
  "旧发货页的电子面单模板、发货人员等字段及真实物流提交结果未逐项验收；新工作台未调用模板 API。",
  ["workers-ts/src/services/kefu/KefuOrderManagementService.ts"]);
add("/kefu/user/index/:uid?/:type?", "partial", ["/workbench"], ["GET /kefuapi/user/info/:uid", "GET /kefuapi/user/label/:uid", "PUT /kefuapi/user/group/:uid/:id"],
  "工作台客户侧栏有基本资料、分组、标签，并可提交分组与标签修改。",
  "旧独立客户页的全部会员字段和跨会话导航尚未逐项核对；游客仅显示隔离身份。",
  ["workers-ts/src/services/kefu/KefuCoreService.ts"]);
add("/kefu/goods/list", "partial", ["/workbench"], ["GET /kefuapi/product/cart/:uid", "GET /kefuapi/product/visit/:uid", "GET /kefuapi/product/hot/:uid"],
  "工作台商品上下文有已购、浏览、热销三个 tab 及商品搜索。",
  "旧独立商品列表的分页、完整字段和向会话发送商品卡片动作尚未等量呈现。",
  ["workers-ts/src/services/kefu/KefuProductService.ts"]);
add("/kefu/goods/detail", "partial", ["/workbench"], ["GET /kefuapi/product/info/:id"],
  "工作台可从商品上下文打开商品详情弹窗，展示图片、价格、库存和说明。",
  "旧详情页的全部 SKU/规格及购买信息未逐字段比对，也未做历史商品数据验收。",
  ["view/kefu-ts/src/types/kefu.ts"]);
add("/kefu/appChat", "partial", ["/service"], ["GET /kefuapi/tourist/user", "GET /kefuapi/tourist/chat"],
  "PC 买家客服页支持已登录用户和签名游客的会话与实时文字/图片消息。",
  "旧浮窗的商品/订单富消息卡片、内嵌离线反馈及广告位没有在 PC 新页完整承接。",
  [targetPcApi, "view/pc-ts/src/services/customerServiceSocket.ts"]);
add("/kefu/mobile_user_chat", "partial", ["/pages/user/kefu"], ["GET /kefuapi/tourist/user", "GET /kefuapi/tourist/chat"],
  "UniApp 买家客服页支持用户/游客会话、文字/图片消息与实时连接。",
  "旧商品/订单消息卡片、入场携带的商品/订单上下文及一键查看详情未逐项迁移。",
  ["view/uniapp-ts/src/pages/user/kefu.vue"]);
add("/kefu/mobile_feedback", "partial", ["/pages/extension/customer_list/feedback"], ["GET /api/user/service/feedback", "POST /api/user/service/feedback"],
  "UniApp 有离线反馈说明、姓名、电话、内容校验和提交表单。",
  "旧 /kefuapi/tourist/feedback 允许游客反馈；新页面要求用户登录，匿名离线反馈入口未等价。",
  ["view/uniapp-ts/src/api/feedback.ts", "workers-ts/src/controllers/api/v1/CustomerServiceCatalogController.ts"]);

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
};
const routerSnapshot = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/frameOut.js");
if (routerSnapshot?.sha256 !== legacyRouterSha256) throw new Error("Legacy frameOut router snapshot changed; re-review kefu auth and semantics");
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && route.source === routerSnapshot.file && route.path.startsWith("/kefu"));
if (legacyRoutes.length !== 13) throw new Error(`Expected 13 kefu business routes, found ${legacyRoutes.length}`);
if (new Set(legacyRoutes.map((route) => route.path)).size !== 13) throw new Error("Duplicate legacy kefu paths");
const sourceFiles = new Map<string, string>();
function content(file: string): string {
  let value = sourceFiles.get(file);
  if (value === undefined) {
    value = readFileSync(resolve(repositoryRoot, file), "utf8");
    sourceFiles.set(file, value);
  }
  return value;
}
const kefuApis = new Set([...content(targetKefuRoutes).matchAll(/kefuapiRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)]
  .map((match) => `${match[1].toUpperCase()} /kefuapi${match[2]}`));
const v1Apis = new Set([...content(targetV1Routes).matchAll(/v1Routes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)]
  .map((match) => `${match[1].toUpperCase()} /api${match[2]}`));
const inventoryPaths = new Set(legacyRoutes.map((route) => route.path));
for (const path of Object.keys(reviews)) if (!inventoryPaths.has(path)) throw new Error(`Unknown kefu review: ${path}`);
for (const path of Object.keys(oldBehaviorLine)) if (!inventoryPaths.has(path)) throw new Error(`Unknown kefu component evidence: ${path}`);
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review) throw new Error(`Missing kefu semantic review: ${route.path}`);
  if (!route.resolvedComponent || !route.resolvedComponent.startsWith("src/pages/kefu/")) throw new Error(`Unexpected kefu component: ${route.path}`);
  if (!review.remaining.length || ((review.status === "candidate" || review.status === "partial") && (!review.covered.length || !review.targetScreens.length))) throw new Error(`Insufficient semantic conclusion: ${route.path}`);
  if (route.line <= 0) throw new Error(`Missing old route provenance: ${route.path}`);
  for (const screen of review.targetScreens) {
    const target = screens[screen];
    if (!target || !content(target.router).includes(target.marker) || !existsSync(resolve(repositoryRoot, target.file))) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  }
  for (const api of review.targetApis) {
    if (!kefuApis.has(api) && !v1Apis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  }
  const behaviorLine = oldBehaviorLine[route.path];
  if (!Number.isSafeInteger(behaviorLine) || behaviorLine < 1) throw new Error(`Missing legacy behavior line: ${route.path}`);
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const evidence = [...new Set([
    oldRouter, oldApi, oldKefuRoutes, componentPath, `${componentPath}:${behaviorLine}`,
    ...review.targetScreens.flatMap((screen) => [screens[screen].router, screens[screen].file]),
    ...review.targetApis.map((api) => api.includes(" /api/") ? targetV1Routes : targetKefuRoutes),
    targetKefuController, targetKefuApi, ...review.evidence,
  ])];
  for (const file of evidence) if (!file.startsWith("cinashop-php/") && !existsSync(resolve(repositoryRoot, file))) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return {
    legacy: { path: route.path, title: route.title, component: route.component, resolvedComponent: componentPath, behaviorSource: `${componentPath}:${behaviorLine}`, source: `${oldRouter}:${route.line}`, routerSha256: legacyRouterSha256, auth: legacyAuth },
    ...review,
    targetPermissions: [...new Set(review.targetScreens.map((screen) => screens[screen].permission))],
    evidence,
  };
});
const statuses: Status[] = ["candidate", "partial", "missing", "retired"];
const counts = Object.fromEntries(statuses.map((status) => [status, routes.filter((route) => route.status === status).length]));
const report = {
  version: 1,
  generatedFrom: "audit/admin-frontend-inventory.json",
  methodology: {
    scope: "Only the 13 surface=page /kefu routes from the pinned frameOut.js router in the authoritative 274-page legacy Admin inventory. /admin/kefu/setup is an auxiliary user.js route outside this denominator.",
    reviewBasis: "Compare each old Vue page and kefuapi workflow with the dedicated Kefu, PC buyer, and UniApp buyer screens and Worker routes. Legacy auth and behavior lines are static review evidence; generation requires only this repository. Admin /kefu's 501 endpoints are not customer-service parity. A matching API or responsive container alone does not establish all old screen behavior.",
    validationBoundary: "Code-only semantic review. No real-role browser E2E, production data, provider integration, deployment, or publication is claimed. FE-001D remains open.",
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
