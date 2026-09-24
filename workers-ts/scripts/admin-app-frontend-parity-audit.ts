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
const outputFile = resolve(workerRoot, "audit/admin-legacy-app-route-parity.json");
const oldRouter = "cinashop-php/view/admin/src/router/modules/app.js";
const oldApi = "cinashop-php/view/admin/src/api/app.js";
const oldDynamicForm = "cinashop-php/view/admin/src/pages/setting/shop/buildData.js";
const targetRouter = "view/admin-ts/src/router/index.ts";
const targetContent = "view/admin-ts/src/pages/content/WechatContent.vue";
const targetContentAdapter = "view/admin-ts/src/api/wechatContent.ts";
const targetCard = "view/admin-ts/src/pages/content/WechatMemberCard.vue";
const targetCardAdapter = "view/admin-ts/src/api/wechatMemberCard.ts";
const targetUser = "view/admin-ts/src/pages/user/UserList.vue";
const adminRoutes = "workers-ts/src/routes/adminapi.ts";
const contentService = "workers-ts/src/services/wechat/WechatContentService.ts";
const contentController = "workers-ts/src/controllers/api/v1/AdminWechatContentController.ts";
const cardController = "workers-ts/src/controllers/api/v1/AdminWechatMemberCardController.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const reviewedRouterSha256 = "9378bb8e502260093a616e370d3c4c9cfc9549ecac0c1d92e169818d9af691a6";
const screens: Record<string, string> = {
  "/content/wechat": targetContent,
  "/content/wechat-card": targetCard,
};
const screenPermissions: Record<string, string> = {
  "/content/wechat": "wechat_content.view",
  "/content/wechat-card": "wechat_member_card.view",
};

// Legacy meta.auth and behavior lines are reviewed static evidence pinned to app.js.
// A single-checkout CI job never reads the sibling PHP repository.
const legacyAuthByPath: Record<string, string> = {
  "/admin/app/wechat/base": "['app-wechat-base']",
  "/admin/app/wechat_open": "['app-wechat-open']",
  "/admin/app/pc": "['app-pc']",
  "/admin/app/app": "['app-app']",
  "/admin/app/wechat/setting/menus/index": "['application-wechat-menus']",
  "/admin/app/wechat/setting/template/index": "['application-wechat-template']",
  "/admin/app/wechat/wechat_user/user/index": "['wechat-wechat-user-user']",
  "/admin/app/wechat/wechat_user/user/tag": "['wechat-wechat-user-tag']",
  "/admin/app/wechat/wechat_user/user/group": "['wechat-wechat-user-group']",
  "/admin/app/wechat/wechat_user/user/message": "['wechat-wechat-user-message']",
  "/admin/app/wechat/news_category/index": "['wechat-wechat-news-category-index']",
  "/admin/app/wechat/news_category/save/:id?": "['wechat-wechat-news-category-save']",
  "/admin/app/wechat/reply/follow/:key": "['wechat-wechat-reply-subscribe']",
  "/admin/app/wechat/reply/keyword": "['wechat-wechat-reply-keyword']",
  "/admin/app/wechat/reply/keyword/save/:id?": "['wechat-wechat-reply-save']",
  "/admin/app/wechat/reply/index/:key": "['wechat-wechat-reply-default']",
  "/admin/app/routine/routine_template/index": "['routine-routine_template']",
  "/admin/app/routine/download": "['routine-download']",
  "/admin/app/wechat/card": "['wechat-wechat-card']",
  "/admin/app/wechat/reply": "['wechat-wechat-reply-index']",
};
const legacyBehaviorLineByPath: Record<string, number> = {
  "/admin/app/wechat/base": 3,
  "/admin/app/wechat_open": 2,
  "/admin/app/pc": 3,
  "/admin/app/app": 3,
  "/admin/app/wechat/setting/menus/index": 51,
  "/admin/app/wechat/setting/template/index": 25,
  "/admin/app/wechat/wechat_user/user/index": 77,
  "/admin/app/wechat/wechat_user/user/tag": 7,
  "/admin/app/wechat/wechat_user/user/group": 7,
  "/admin/app/wechat/wechat_user/user/message": 13,
  "/admin/app/wechat/news_category/index": 4,
  "/admin/app/wechat/news_category/save/:id?": 53,
  "/admin/app/wechat/reply/follow/:key": 57,
  "/admin/app/wechat/reply/keyword": 26,
  "/admin/app/wechat/reply/keyword/save/:id?": 57,
  "/admin/app/wechat/reply/index/:key": 57,
  "/admin/app/routine/routine_template/index": 25,
  "/admin/app/routine/download": 20,
  "/admin/app/wechat/card": 243,
  "/admin/app/wechat/reply": 7,
};

const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApis: string[], covered: string, remaining: string, evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate app review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered: covered ? [covered] : [], remaining: [remaining], evidence };
}

add("/admin/app/wechat/base", "missing", [], [], "",
  "旧页按 wechat 动态表单编辑公众号基础配置；新后台没有同一配置表单，支付就绪卡和通用配置页不能代替公众号配置。", [oldDynamicForm, "view/admin-ts/src/pages/config/CommerceSettings.vue"]);
add("/admin/app/wechat_open", "missing", [], [], "",
  "旧 wxopen 动态表单编辑微信开放平台配置；新后台没有开放平台配置屏或受限字段读写流程。", [oldDynamicForm]);
add("/admin/app/pc", "missing", [], [], "",
  "旧 pc 动态表单编辑 PC 渠道配置；新后台没有按旧配置项核验的 PC 专页，商城前台存在不代表该配置可管理。", [oldDynamicForm, "view/admin-ts/src/pages/config/CommerceSettings.vue"]);
add("/admin/app/app", "missing", [], [], "",
  "旧 app 动态表单编辑 App 渠道配置；新后台没有同等配置屏、渠道签名或版本管理操作面。", [oldDynamicForm]);
add("/admin/app/wechat/setting/menus/index", "missing", [], [], "",
  "旧页编辑一级/二级公众号菜单，含点击关键词、网页和小程序跳转并保存发布；新后台没有菜单编辑/发布屏或同等 Worker 合同。",
  ["cinashop-php/route/admin.php"]);
add("/admin/app/wechat/setting/template/index", "missing", [], [], "",
  "旧页复用模板列表组件，按路径读取公众号模板并提供新增、编辑、启停；新后台没有公众号模板管理屏。", ["cinashop-php/route/admin.php"]);
add("/admin/app/wechat/wechat_user/user/index", "missing", [], ["GET /adminapi/user/list"], "",
  "旧页专管公众号关注用户，支持关注/分组/标签/地域筛选、分组与标签维护、选人发券和图文群发；新 /user 只列商城 user 的手机号/余额/等级，不能作为 wechat_user 管理屏。旧页面所调 app/wechat/user 等 API 未在所查 route/admin.php 中注册，历史可用性需另核。",
  [targetUser, "workers-ts/src/controllers/api/v1/AdminCrudController.ts", "workers-ts/src/models/schema/wechat.ts"]);
add("/admin/app/wechat/wechat_user/user/tag", "missing", [], [], "",
  "旧 tag 路由在共用组件中调用公众号标签的创建、列表、编辑和删除；新通用会员标签并非公众号远端标签，缺少该管理屏。旧 API 未在所查 route/admin.php 注册，历史可用性需另核。",
  ["view/admin-ts/src/pages/label/LabelList.vue"]);
add("/admin/app/wechat/wechat_user/user/group", "missing", [], [], "",
  "旧 group 路由虽复用 tag.vue，却通过路径切换公众号分组 API，含新增、编辑和删除；新 user_group 是商城会员分组，不能替代公众号分组。旧 API 未在所查 route/admin.php 注册，历史可用性需另核。",
  ["view/admin-ts/src/pages/label/LabelList.vue", "workers-ts/src/routes/adminapi.ts"]);
add("/admin/app/wechat/wechat_user/user/message", "missing", [], ["GET /adminapi/wechat/message"], "",
  "旧页调用 app/wechat/action 读取用户行为记录并按时间、用户和操作筛选；新消息历史读取 wechat_message 接收消息，实体与筛选均不同。旧 API 未在所查 route/admin.php 注册，历史可用性需另核。",
  [targetContent, contentService, "workers-ts/src/models/schema/wechat.ts"]);

add("/admin/app/wechat/news_category/index", "partial", ["/content/wechat"], ["GET /adminapi/wechat/news", "GET /adminapi/wechat/news/:id", "DELETE /adminapi/wechat/news/:id", "POST /adminapi/wechat/push"],
  "图文 tab 可搜索、查看摘要、进入编辑并删除图文组。",
  "旧图文组件也被微信用户页复用作选人发送入口，新群发接口明确不可用；新图文目录只取第一页 100 条且没有分页控件。",
  ["cinashop-php/view/admin/src/components/newsCategory/index.vue", contentService]);
add("/admin/app/wechat/news_category/save/:id?", "partial", ["/content/wechat"], ["GET /adminapi/wechat/news/:id", "POST /adminapi/wechat/news"],
  "新图文弹窗可创建/编辑 1–8 篇文章的标题、作者、摘要、封面地址、正文、排序和状态。",
  "旧页提供素材选择和富文本编辑器；新页只用地址输入和纯文本框，历史媒体与排版编辑需逐项验收。",
  ["view/admin-ts/src/pages/content/WechatContent.vue", contentService]);
add("/admin/app/wechat/reply/follow/:key", "partial", ["/content/wechat"], ["GET /adminapi/wechat/reply", "POST /adminapi/wechat/keyword/:id"],
  "新自动回复 tab 可读取并编辑 subscribe 关注回复的文字、已有图片/语音素材或图文首篇。",
  "旧编辑器可上传新素材并选择多图文；新回复仅选已迁移素材/首篇文章，公众号外部回调投递仍未验收。",
  [contentService]);
add("/admin/app/wechat/reply/keyword", "partial", ["/content/wechat"], ["GET /adminapi/wechat/keyword", "GET /adminapi/wechat/code_reply/:id", "POST /adminapi/wechat/code_reply/:id/provision", "PUT /adminapi/wechat/keyword/set_status/:id/:status", "DELETE /adminapi/wechat/keyword/:id"],
  "新 tab 可按关键词/类型搜索、查看、启停、删除，并通过队列生成回复二维码。",
  "新页面只取第一页 100 条且无分页控件；旧图片/语音上传与真实公众号触发/扫码结果仍待验收。",
  ["workers-ts/src/controllers/api/v1/AdminWechatQrcodeController.ts", contentService]);
add("/admin/app/wechat/reply/keyword/save/:id?", "partial", ["/content/wechat"], ["GET /adminapi/wechat/keyword/:id", "POST /adminapi/wechat/keyword/:id"],
  "新弹窗可新增/编辑关键词、回复类型、内容与状态并拒绝重复关键词。",
  "旧表单可上传新的图片/语音并选图文内容；新页限制为已迁移素材或图文首篇，外部响应链未验证。",
  [contentService]);
add("/admin/app/wechat/reply/index/:key", "partial", ["/content/wechat"], ["GET /adminapi/wechat/reply", "POST /adminapi/wechat/keyword/:id"],
  "新自动回复 tab 可读取并编辑 default 无效关键词回复。",
  "旧编辑器的上传与多图文选择未恢复，真实公众号默认回复投递链未完成验收。", [contentService]);
add("/admin/app/routine/routine_template/index", "missing", [], [], "",
  "旧复用组件在小程序路径下管理订阅模板列表、新增/编辑、启停及一键同步；新后台没有小程序订阅模板管理屏。",
  ["cinashop-php/route/admin.php"]);
add("/admin/app/routine/download", "missing", [], [], "",
  "旧页编辑小程序 AppID、Secret、客服和授权配置，并下载小程序码及按直播开关选择的源码包；新后台只有零散授权设置，没有下载/构建交付流程。",
  ["view/admin-ts/src/pages/config/NewcomerSettings.vue", "cinashop-php/route/admin.php"]);
add("/admin/app/wechat/card", "partial", ["/content/wechat-card"], ["GET /adminapi/wechat/card", "GET /adminapi/wechat/card/summary", "GET /adminapi/wechat/card/users", "POST /adminapi/wechat/card"],
  "新迁移目录可分页审阅已导入的卡配置、领取与激活历史，远端标识脱敏。",
  "旧卡片样式、品牌、权益和微信远端制卡可编辑提交；新页只读，兼容 POST 返回 501，激活/回调未恢复。",
  ["workers-ts/src/services/wechat/WechatMemberCardCatalogService.ts"]);
add("/admin/app/wechat/reply", "partial", ["/content/wechat"], ["GET /adminapi/wechat/reply", "GET /adminapi/wechat/keyword", "POST /adminapi/wechat/keyword/:id"],
  "新公众号内容页将关注、关键词和默认回复集中在同一可操作 tab。",
  "旧三项导航下的完整素材上传、图文选择和公众号回调响应尚未恢复或验收；关键词目录也缺可见翻页。",
  [contentService]);

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
  target: { routes: InventoryRoute[] };
};
const routerSnapshot = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/app.js");
if (routerSnapshot?.sha256 !== reviewedRouterSha256) throw new Error("Legacy app router snapshot changed; re-review auth and semantics");
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && route.path.startsWith("/admin/app/"));
if (legacyRoutes.length !== 20) throw new Error(`Expected 20 app business routes, found ${legacyRoutes.length}`);
if (new Set(legacyRoutes.map((route) => route.path)).size !== 20) throw new Error("Duplicate legacy app paths");
const inventoryPaths = new Set(legacyRoutes.map((route) => route.path));
for (const path of Object.keys(reviews)) if (!inventoryPaths.has(path)) throw new Error(`Unknown app review: ${path}`);
for (const path of Object.keys(legacyAuthByPath)) if (!inventoryPaths.has(path)) throw new Error(`Unknown app auth: ${path}`);
for (const path of Object.keys(legacyBehaviorLineByPath)) if (!inventoryPaths.has(path)) throw new Error(`Unknown app behavior evidence: ${path}`);
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
  const domain = path.startsWith("/adminapi/wechat/card") ? "wechat_member_card"
    : path.startsWith("/adminapi/wechat/") ? "wechat_content"
      : path.startsWith("/adminapi/user/") ? "user" : null;
  if (!domain) throw new Error(`Unmapped app API permission: ${api}`);
  return `${domain}.${method === "GET" ? "view" : "manage"}`;
}
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review) throw new Error(`Missing app semantic review: ${route.path}`);
  if (!route.resolvedComponent) throw new Error(`Unresolved legacy app component: ${route.path}`);
  if (!review.remaining.length || !review.remaining[0] || (review.status !== "missing" && !review.covered.length)) throw new Error(`Insufficient semantic conclusion: ${route.path}`);
  if (review.status === "missing" && review.targetScreens.length) throw new Error(`Missing route has target screen: ${route.path}`);
  if ((review.status === "partial" || review.status === "candidate") && !review.targetScreens.length) throw new Error(`Covered route lacks target screen: ${route.path}`);
  if (route.source !== routerSnapshot.file || route.line <= 0) throw new Error(`Unexpected app route provenance: ${route.path}`);
  for (const screen of review.targetScreens) if (!targetPaths.has(screen) || !screens[screen]) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const legacyAuth = legacyAuthByPath[route.path];
  if (!legacyAuth) throw new Error(`Missing app auth review: ${route.path}`);
  const behaviorLine = legacyBehaviorLineByPath[route.path];
  if (!Number.isSafeInteger(behaviorLine) || behaviorLine <= 0) throw new Error(`Missing app component line: ${route.path}`);
  const targetPermissions = [...new Set([
    ...review.targetScreens.map((screen) => screenPermissions[screen]),
    ...review.targetApis.map(permissionForApi),
  ])];
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const evidence = [...new Set([
    oldRouter, componentPath, `${componentPath}:${behaviorLine}`, oldApi, targetRouter, adminRoutes, permissionRules,
    ...review.targetScreens.map((screen) => screens[screen]),
    ...review.targetScreens.flatMap((screen) => screen === "/content/wechat" ? [targetContentAdapter, contentController] : [targetCardAdapter, cardController]),
    ...review.evidence,
  ])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return {
    legacy: { path: route.path, title: route.title, component: route.component, resolvedComponent: componentPath, behaviorSource: `${componentPath}:${behaviorLine}`, source: `${oldRouter}:${route.line}`, routerSha256: reviewedRouterSha256, parentAuth: "['admin-app']", auth: legacyAuth },
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
    scope: "Only the 20 surface=page routes under /admin/app/ in the authoritative 274-route inventory.",
    reviewBasis: "Compare pinned legacy Vue behavior, app.js route auth and app.js API calls with the target Admin operation surface, Worker API entity, and target permission. Legacy paths and meta.auth are static reviewed evidence; generation requires only this repository. An API, same-looking title, generic user screen, or frontend runtime alone does not establish old Admin screen parity.",
    validationBoundary: "Code-only semantic review. No production data, WeChat provider writes, real-role browser E2E, deployment, or publication is claimed. FE-001D remains open.",
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
