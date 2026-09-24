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
const inventoryFile = resolve(workerRoot, "audit/admin-frontend-inventory.json");
const outputFile = resolve(workerRoot, "audit/admin-legacy-work-route-parity.json");
const oldRouter = "cinashop-php/view/admin/src/router/modules/work.js";
const oldApi = "cinashop-php/view/admin/src/api/work.js";
const targetRouter = "view/admin-ts/src/router/index.ts";
const targetPage = "view/admin-ts/src/pages/operations/EnterpriseWechat.vue";
const targetAdapter = "view/admin-ts/src/api/enterpriseWechat.ts";
const adminRoutes = "workers-ts/src/routes/adminapi.ts";
const controller = "workers-ts/src/controllers/api/v1/AdminEnterpriseWechatController.ts";
const catalog = "workers-ts/src/services/work/EnterpriseWechatCatalogService.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const reviewedRouterSha256 = "9d6dd8ff6a6c1f8adbcf0232cc70af3decf1cbe0b2245a6add7fc6fd85116ce6";
const screens: Record<string, string> = {
  "/operations/work": targetPage,
  "/user": "view/admin-ts/src/pages/user/UserList.vue",
};
const screenPermissions: Record<string, string> = {
  "/operations/work": "enterprise_wechat.view",
  "/user": "user.view",
};

// The old router auth values are a reviewed static snapshot pinned by the hash above.
// CI has only this repository and never reads the sibling PHP checkout.
const legacyAuthByPath: Record<string, string> = {
  "/admin/work/channel_code": "['work-channel-code']",
  "/admin/work/createCode/:id?": "['work-code-create']",
  "/admin/work/client/group_chat": "['work-customer-base']",
  "/admin/work/client/statistical/:id?": "['work-client-statistical']",
  "/admin/work/client/list": "['work-client-list']",
  "/admin/work/auth_group": "['work-auth-group']",
  "/admin/work/welcome": "['work-welcome']",
  "/admin/work/addWelcome/:id?": "['work-addWelcome']",
  "/admin/work/addAuthGroup/:id?": "['work-addAuthGroup']",
  "/admin/work/staffList": "['work-staffList']",
  "/admin/work/client/group": "['work-client-group']",
  "/admin/work/client/add_group": "['work-client-add_group']",
  "/admin/work/client/group_info/:id?": "['work-client-groupInfo']",
  "/admin/work/client/moment": "['work-client-moment']",
  "/admin/work/client/add_moment": "['work-client-add-moment']",
  "/admin/work/client/moment_info/:id?": "['work-client-momentInfo']",
  "/admin/work/group/template": "['work-group-template']",
  "/admin/work/group/add_template": "['work-group-add_template']",
  "/admin/work/group/template_info/:id?": "['work-group-templateInfo']",
  "/admin/work/config": "['admin-work-config']",
};
// First behavior-bearing line in each reviewed old Vue component.
const legacyBehaviorLineByPath: Record<string, number> = {
  "/admin/work/channel_code": 25,
  "/admin/work/createCode/:id?": 20,
  "/admin/work/client/group_chat": 9,
  "/admin/work/client/statistical/:id?": 19,
  "/admin/work/client/list": 49,
  "/admin/work/auth_group": 10,
  "/admin/work/welcome": 11,
  "/admin/work/addWelcome/:id?": 20,
  "/admin/work/addAuthGroup/:id?": 21,
  "/admin/work/staffList": 6,
  "/admin/work/client/group": 12,
  "/admin/work/client/add_group": 21,
  "/admin/work/client/group_info/:id?": 30,
  "/admin/work/client/moment": 12,
  "/admin/work/client/add_moment": 26,
  "/admin/work/client/moment_info/:id?": 24,
  "/admin/work/group/template": 12,
  "/admin/work/group/add_template": 21,
  "/admin/work/group/template_info/:id?": 20,
  "/admin/work/config": 3,
};

const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApis: string[], covered: string, remaining: string, evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate work review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered: covered ? [covered] : [], remaining: [remaining], evidence };
}

add("/admin/work/channel_code", "partial", ["/operations/work"], ["GET /adminapi/work/channel_code"],
  "新目录的渠道码 tab 可分页查看名称、状态、接待成员数和新增客户数。",
  "旧分类/类型筛选、二维码下载、关联客户查看、分类批量设置及状态/删除操作缺失；目标只读，渠道码写接口返回 501。",
  ["workers-ts/src/models/schema/work.ts", "cinashop-php/route/admin.php", "cinashop-php/app/controller/admin/v1/work/ChannelCode.php"]);
add("/admin/work/createCode/:id?", "missing", [], ["POST /adminapi/work/channel_code", "PUT /adminapi/work/channel_code/:id"], "",
  "旧表单配置成员轮值、工作时间、备用员工、欢迎语、客户标签与二维码；新 Admin 无创建/编辑表单，兼容写接口统一返回 501。",
  ["workers-ts/src/models/schema/work.ts"]);
add("/admin/work/client/group_chat", "partial", ["/operations/work"], ["GET /adminapi/work/group_chat", "GET /adminapi/work/group_chat/member/:id"],
  "客户群 tab 可分页查看群名、群主、成员数、退群数和状态。",
  "旧日期筛选、群成员弹窗、同步及跳转单群统计缺失；群成员虽有 Worker API，却没有 Admin 操作入口。",
  ["workers-ts/src/services/work/EnterpriseWechatGroupChatCurrentService.ts", "cinashop-php/route/admin.php", "cinashop-php/app/controller/admin/v1/work/GroupChat.php"]);
add("/admin/work/client/statistical/:id?", "missing", [], [], "",
  "旧页按群 ID 展示新增/退群/当前成员指标、时间曲线和每日明细；新页仅有全局群数汇总，不提供单群统计屏。",
  ["workers-ts/src/services/work/EnterpriseWechatCatalogService.ts", "cinashop-php/route/admin.php", "cinashop-php/app/controller/admin/v1/work/GroupChat.php"]);
add("/admin/work/client/list", "partial", ["/operations/work", "/user"], ["GET /adminapi/work/client", "GET /adminapi/user/list", "GET /adminapi/work/label", "GET /adminapi/work/client/synch", "POST /adminapi/work/client/batchLabel", "PUT /adminapi/work/client/:id"],
  "新企业微信客户 tab 可分页查看脱敏客户；通用用户页可列出商城用户并打开基础详情。",
  "旧企微/非企微双 tab、客服/标签/时间筛选、企微备注和打标签、同步、非企微发券/编辑均未形成同等流程；企微写接口返回 501。",
  ["view/admin-ts/src/pages/user/UserList.vue", "workers-ts/src/services/work/EnterpriseWechatClientCurrentService.ts"]);
add("/admin/work/auth_group", "missing", [], ["GET /adminapi/work/group_chat_auth", "POST /adminapi/work/group_chat_auth", "PUT /adminapi/work/group_chat_auth/:id", "DELETE /adminapi/work/group_chat_auth/:id"], "",
  "旧自动拉群规则目录可查筛选、进入编辑并删除；Worker 只有只读目录 API，新 Admin 七个 tab 无自动拉群入口，写接口返回 501。",
  ["cinashop-php/app/controller/admin/v1/work/GroupChatAuth.php"]);
add("/admin/work/welcome", "partial", ["/operations/work"], ["GET /adminapi/work/welcome", "POST /adminapi/work/welcome", "PUT /adminapi/work/welcome/:id", "DELETE /adminapi/work/welcome/:id"],
  "欢迎语 tab 可分页查看适用范围、内容预览、附件数和排序。",
  "旧新增/编辑/删除及完整附件内容不可操作；兼容写接口返回 501，客户后置动作处置不是欢迎语配置。",
  ["workers-ts/src/services/work/EnterpriseWechatContactActionService.ts"]);
add("/admin/work/addWelcome/:id?", "missing", [], ["POST /adminapi/work/welcome", "PUT /adminapi/work/welcome/:id"], "",
  "旧表单按成员/范围设置欢迎语、图片、链接或小程序素材和排序；新 Admin 没有可保存表单，写接口返回 501。");
add("/admin/work/addAuthGroup/:id?", "missing", [], ["GET /adminapi/work/group_chat_auth", "POST /adminapi/work/group_chat_auth", "PUT /adminapi/work/group_chat_auth/:id"], "",
  "旧表单选择群聊、自动建群、管理员、客户标签及欢迎内容；新 Admin 没有该编辑表单，写接口返回 501。旧 PHP 新建/更新接收字段还不对称，需单独验收。",
  ["cinashop-php/app/controller/admin/v1/work/GroupChatAuth.php"]);
add("/admin/work/staffList", "partial", ["/operations/work"], ["GET /adminapi/work/member", "GET /adminapi/work/tree", "POST /adminapi/work/synchMember"],
  "成员 tab 可分页查看脱敏员工、职务、部门及状态。",
  "旧部门树/员工条件筛选和手动同步未在页面提供；部门树仅有 API，手动同步接口返回 501。",
  ["workers-ts/src/services/work/EnterpriseWechatDepartmentCurrentService.ts", "workers-ts/src/services/work/EnterpriseWechatMemberCurrentService.ts"]);
add("/admin/work/client/group", "partial", ["/operations/work"], ["GET /adminapi/work/group_template", "POST /adminapi/work/group_template"],
  "群发历史 tab 可分页查看 work_group_template 中客户群发任务的名称、对象类型、成员数和发送状态。",
  "旧页用 type=0 区分客户群发；新 tab 混列两种 type，缺少发送时间/客户类型筛选、送达统计、任务详情、提醒发送、删除和新建；写接口返回 501。",
  ["workers-ts/src/models/schema/work.ts"]);
add("/admin/work/client/add_group", "missing", [], ["POST /adminapi/work/group_template"], "",
  "旧客户群发创建页选择员工、客户标签/时间范围、文本和媒体、立即/定时发送；新 Admin 没有表单，写接口返回 501。");
add("/admin/work/client/group_info/:id?", "missing", [], [], "",
  "旧详情有模板内容、员工/客户送达分页明细和提醒发送；新群发历史 tab 只展示聚合行，未提供按 ID 详情屏。",
  ["workers-ts/src/models/schema/work.ts"]);
add("/admin/work/client/moment", "partial", ["/operations/work"], ["GET /adminapi/work/moment", "POST /adminapi/work/moment", "DELETE /adminapi/work/moment/:id"],
  "朋友圈历史 tab 可分页查看任务名、成员数、发送时间和远端 ID 是否记录。",
  "旧日期筛选、任务详情、删除和新增/投递流程缺失；兼容写接口返回 501。",
  ["workers-ts/src/models/schema/work.ts"]);
add("/admin/work/client/add_moment", "missing", [], ["POST /adminapi/work/moment"], "",
  "旧朋友圈创建页选择发表成员、可见客户/标签、图文链接或媒体及定时发送；新 Admin 没有写入表单，接口返回 501。");
add("/admin/work/client/moment_info/:id?", "missing", [], [], "",
  "旧详情先按任务 ID 取得外部 moment_id，再查看员工发表与送达列表；新目录只显示任务聚合行和失败标记，没有详情入口或明细。");
add("/admin/work/group/template", "partial", ["/operations/work"], ["GET /adminapi/work/group_template"],
  "新群发历史 tab 也列出 work_group_template 中 type=1 的旧客户群群发任务摘要。",
  "旧页用 group_template_chat URL 和 type=1 区分群群发；新 tab 混列 type=0/1，缺少按群主/送达群聊统计、发送时间筛选、详情、提醒发送和删除。",
  ["workers-ts/src/models/schema/work.ts", "cinashop-php/app/controller/admin/v1/work/GroupTemplate.php"]);
add("/admin/work/group/add_template", "missing", [], ["POST /adminapi/work/group_template"], "",
  "旧群群发创建页选择群主、群聊、消息内容及立即/定时发送；新 Admin 无群群发创建表单，通用 group_template 写接口返回 501。");
add("/admin/work/group/template_info/:id?", "missing", [], [], "",
  "旧群群发详情按群主/群聊查看送达与失败记录；新 Admin 无按 ID 的群群发详情和送达明细。");
add("/admin/work/config", "missing", [], [], "",
  "旧动态表单编辑 Corp ID、Secret、Token、AES Key 与自建应用配置；新 Admin 无企业微信配置页。/api/work/config 是企业侧 JS-SDK 签名接口，不能替代管理配置。",
  ["cinashop-php/view/admin/src/pages/setting/shop/buildData.js", "cinashop-php/app/services/system/config/SystemConfigServices.php", "workers-ts/src/routes/v1/index.ts", "workers-ts/src/controllers/api/v1/EnterpriseWechatController.ts"]);

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
  target: { routes: InventoryRoute[] };
};
const routerSnapshot = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/work.js");
if (routerSnapshot?.sha256 !== reviewedRouterSha256) throw new Error("Legacy work router snapshot changed; re-review auth and semantics");
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && route.path.startsWith("/admin/work"));
if (legacyRoutes.length !== 20) throw new Error(`Expected 20 work business routes, found ${legacyRoutes.length}`);
if (new Set(legacyRoutes.map((route) => route.path)).size !== 20) throw new Error("Duplicate legacy work paths");
const inventoryPaths = new Set(legacyRoutes.map((route) => route.path));
for (const path of Object.keys(reviews)) if (!inventoryPaths.has(path)) throw new Error(`Unknown work review: ${path}`);
for (const path of Object.keys(legacyAuthByPath)) if (!inventoryPaths.has(path)) throw new Error(`Unknown work auth: ${path}`);
for (const path of Object.keys(legacyBehaviorLineByPath)) if (!inventoryPaths.has(path)) throw new Error(`Unknown work component evidence: ${path}`);
const targetPaths = new Set(inventory.target.routes.filter((route) => route.surface === "page").map((route) => route.path));
const adminRouteSource = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
const registeredApis = new Set([...adminRouteSource.matchAll(/adminapiRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)]
  .map((match) => `${match[1].toUpperCase()} /adminapi${match[2]}`));
function evidenceExists(file: string): boolean {
  if (file.startsWith("cinashop-php/")) return true;
  return existsSync(resolve(workerRoot, "..", file));
}
function permissionForApi(api: string): string {
  const [method, path] = api.split(" ");
  if (path === "/adminapi/work/client/synch" || path === "/adminapi/work/group_chat/synch" || path === "/adminapi/work/synchMember") return "enterprise_wechat.manage";
  const domain = path.startsWith("/adminapi/work/") ? "enterprise_wechat" : path.startsWith("/adminapi/user/") ? "user" : null;
  if (!domain) throw new Error(`Unmapped API permission: ${api}`);
  return `${domain}.${method === "GET" ? "view" : "manage"}`;
}
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review) throw new Error(`Missing work semantic review: ${route.path}`);
  if (!route.resolvedComponent) throw new Error(`Unresolved legacy work component: ${route.path}`);
  if (!review.remaining.length || !review.remaining[0] || (review.status !== "missing" && !review.covered.length)) throw new Error(`Insufficient semantic conclusion: ${route.path}`);
  if (review.status === "missing" && review.targetScreens.length) throw new Error(`Missing route has target screen: ${route.path}`);
  if ((review.status === "partial" || review.status === "candidate") && !review.targetScreens.length) throw new Error(`Covered route lacks target screen: ${route.path}`);
  if (route.source !== routerSnapshot.file || route.line <= 0) throw new Error(`Unexpected work route provenance: ${route.path}`);
  for (const screen of review.targetScreens) if (!targetPaths.has(screen) || !screens[screen]) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const legacyAuth = legacyAuthByPath[route.path];
  if (!legacyAuth) throw new Error(`Missing work auth review: ${route.path}`);
  const behaviorLine = legacyBehaviorLineByPath[route.path];
  if (!Number.isSafeInteger(behaviorLine) || behaviorLine <= 0) throw new Error(`Missing work component evidence line: ${route.path}`);
  const targetPermissions = [...new Set([
    ...review.targetScreens.map((screen) => screenPermissions[screen]),
    ...review.targetApis.map(permissionForApi),
  ])];
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const evidence = [...new Set([
    `${oldRouter}`, componentPath, `${componentPath}:${behaviorLine}`, oldApi, targetRouter, targetPage, targetAdapter,
    adminRoutes, controller, catalog, permissionRules,
    ...review.targetScreens.map((screen) => screens[screen]),
    ...review.evidence,
  ])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return {
    legacy: { path: route.path, title: route.title, component: route.component, resolvedComponent: componentPath, behaviorSource: `${componentPath}:${behaviorLine}`, source: `${oldRouter}:${route.line}`, routerSha256: reviewedRouterSha256, auth: legacyAuth },
    ...review,
    targetPermissions,
    evidence,
  };
});
const statuses: Status[] = ["candidate", "partial", "missing", "retired"];
const counts = Object.fromEntries(statuses.map((status) => [status, routes.filter((route) => route.status === status).length]));
const report = {
  version: 1,
  generatedFrom: "audit/admin-frontend-inventory.json",
  methodology: {
    scope: "Only the 20 surface=page routes under /admin/work in the authoritative 274-route inventory.",
    reviewBasis: "Compare each pinned legacy component and API workflow with the target Admin page, Worker adminapi contract, data entity and permission map. Legacy paths and meta.auth are static review evidence; generation requires only this repository. An API without an Admin operation surface, including a 501 compatibility route, does not establish screen parity. Shared work_group_template data does not establish separate send workflows or detail parity.",
    validationBoundary: "Code-only semantic review. No production data, provider writes, real-role browser E2E, deployment, or publication is claimed. FE-001D remains open.",
  },
  summary: { legacyRoutes: routes.length, reviewed: routes.length, ...counts, unreviewed: 0 },
  routes,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write")) {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, serialized, "utf8");
  console.log(`Wrote ${outputFile}`);
} else {
  process.stdout.write(serialized);
}
