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
const outputFile = resolve(workerRoot, "audit/admin-legacy-system-route-parity.json");
const oldRouterHashes: Record<string, string> = {
  "src/router/routes.js": "9432b5a0b65c09adaf828dbb7125352eea94c54b444f5197647c59aa40fe13c2",
  "src/router/modules/system.js": "f84e11ebb974799f4cf3da05daa772c9b973c07960ddb6e86fcef823b58cb0ff",
};
const oldAuthByPath: Record<string, string> = {
  "/admin/system/log": "true",
  "/admin/system/user": "true",
  "/admin/system/file": "['system-file']",
  "/admin/system/maintain/clear/index": "['system-clear']",
  "/admin/system/system_upgradeclient/index": "['system-system-upgradeclient']",
  "/admin/system/maintain/system_log/index": "['system-maintain-system-log']",
  "/admin/system/maintain/system_file/index": "['system-maintain-system-file']",
  "/admin/system/maintain/system_cleardata/index": "['system-maintain-system-cleardata']",
  "/admin/system/maintain/system_databackup/index": "['system-maintain-system-databackup']",
  "/admin/system/maintain/system_file/opendir": "['system-maintain-system-file']",
  "/admin/system/config/system_config_tab/index": "['system-config-system_config-tab']",
  "/admin/system/config/system_config_tab/list/:id?": "['system-config-system_config_tab-list']",
  "/admin/system/config/system_group/index": "['system-config-system_config-group']",
  "/admin/system/config/system_group/list/:id?": "['system-config-system_config-list']",
  "/admin/system/maintain/auth": "['system-maintain-auth']",
  "/admin/system/crontab": "['system-crontab-index']",
  "/admin/system/crontab/create/:id?": "['system-crontab-create']",
};
// First behavior-bearing line reviewed in each old component. CI does not read the sibling PHP checkout.
const oldBehaviorLineByPath: Record<string, number> = {
  "/admin/system/log": 35,
  "/admin/system/user": 183,
  "/admin/system/file": 280,
  "/admin/system/maintain/clear/index": 19,
  "/admin/system/system_upgradeclient/index": 9,
  "/admin/system/maintain/system_log/index": 56,
  "/admin/system/maintain/system_file/index": 16,
  "/admin/system/maintain/system_cleardata/index": 41,
  "/admin/system/maintain/system_databackup/index": 57,
  "/admin/system/maintain/system_file/opendir": 39,
  "/admin/system/config/system_config_tab/index": 68,
  "/admin/system/config/system_config_tab/list/:id?": 96,
  "/admin/system/config/system_group/index": 46,
  "/admin/system/config/system_group/list/:id?": 108,
  "/admin/system/maintain/auth": 149,
  "/admin/system/crontab": 49,
  "/admin/system/crontab/create/:id?": 166,
};
const screenFiles: Record<string, string> = {
  "/system": "view/admin-ts/src/pages/system/SystemList.vue",
  "/assets": "view/admin-ts/src/pages/system/AttachmentLibrary.vue",
  "/system/log": "view/admin-ts/src/pages/system/LogList.vue",
  "/operations/legacy-runtime": "view/admin-ts/src/pages/operations/LegacyRuntimeHistory.vue",
};
const screenPermissions: Record<string, string> = {
  "/system": "system.view",
  "/assets": "attachment.view",
  "/system/log": "log.view",
  "/operations/legacy-runtime": "legacy_runtime.view",
};
const oldApi = "cinashop-php/view/admin/src/api/system.js";
const newRouter = "view/admin-ts/src/router/index.ts";
const newRoutes = "workers-ts/src/routes/adminapi.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const reviews: Record<string, Review> = {};
function add(path: string, status: Status, targetScreens: string[], targetApis: string[], covered: string[], remaining: string[], evidence: string[] = []) {
  if (reviews[path]) throw new Error(`Duplicate system review: ${path}`);
  reviews[path] = { status, targetScreens, targetApis, covered, remaining, evidence };
}

add("/admin/system/log", "missing", [], [], [], [
  "旧页读取 admin/log Vuex 的本浏览器前端事件，支持清空并提示去控制台看详情；新 /system/log 是服务端 system_log 操作记录，不收集或展示前端事件。",
], ["cinashop-php/view/admin/src/store/modules/admin/modules/log.js", screenFiles["/system/log"]]);
add("/admin/system/user", "partial", ["/system"], ["GET /adminapi/system_admin/list", "POST /adminapi/system_admin/save"], [
  "新管理员页可查看账号、姓名、手机号，并由有管理权限的角色编辑姓名、手机号和密码。",
], [
  "旧个人中心是登录者自助头像、姓名、手机号验证码及旧密码校验流程；新页为全员管理员编辑，无个人中心入口、头像或同等自助验证，受限管理员无法按旧流程修改。",
], ["cinashop-php/view/admin/src/api/user.js", screenFiles["/system"]]);
add("/admin/system/file", "partial", ["/assets"], [
  "GET /adminapi/file/file", "GET /adminapi/file/category", "POST /adminapi/file/upload", "POST /adminapi/file/file/delete",
], [
  "新素材中心提供图片分类、名称搜索、预览、安全上传和删除，并使用私有 R2 临时签名。",
], [
  "旧页可在图片/视频间切换、上传视频、预览视频、批量移动与重命名并管理分类树；新页只接受图片，移动/重命名虽有 Worker API，却没有页面操作。",
], ["cinashop-php/view/admin/src/api/uploadPictures.js", "view/admin-ts/src/api/attachment.ts", "workers-ts/src/controllers/system/AttachmentController.ts"]);
add("/admin/system/maintain/clear/index", "missing", [], [], [], [
  "旧页发起 system/refresh_cache/cache 与 system/refresh_cache/log 清理；新 Admin 无缓存/日志清理屏，也没有对应已注册的 Worker 操作。",
]);
add("/admin/system/system_upgradeclient/index", "retired", [], [], [
  "旧组件把版本 1.5、2020-07-15、示例更新说明和下载按钮写死，未导入 API、未绑定下载处理器；它不是可工作的在线升级流程。",
], [], ["cinashop-php/view/admin/src/pages/system/systemUpgradeclient/index.vue:9"]);
add("/admin/system/maintain/system_log/index", "partial", ["/system/log"], ["GET /adminapi/log/list"], [
  "新操作日志页可分页显示服务端日志 ID、操作人、动作、IP 和时间。",
], [
  "旧页按时间、管理员、链接和 IP 筛选并显示路径、行为与类型；新页只有固定分页、无筛选，字段及历史 system_log 形状也未完成逐项验收。",
], [screenFiles["/system/log"], "workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
add("/admin/system/maintain/system_file/index", "missing", [], [], [], [
  "旧页读取 system/file 的文件路径、校验码与访问/修改时间；新素材目录是业务附件，不提供应用文件完整性校验报告。",
]);
add("/admin/system/maintain/system_cleardata/index", "missing", [], [], [], [
  "旧页可替换上传资源域名、预热营销库存并按 temp/recycle/store/order/kefu/wechat/article/user/attachment/system 清理数据；新 Admin 无对应受控维护流程。此类破坏性按钮不能以普通删除或缓存失效冒充。",
]);
add("/admin/system/maintain/system_databackup/index", "missing", [], [], [], [
  "旧页列数据库表与备份文件，提供表结构、备份、优化、修复、导入、下载和删除；新 Admin/Worker 无等价数据库备份与恢复管理屏。",
]);
add("/admin/system/maintain/system_file/opendir", "missing", [], [], [], [
  "旧页浏览服务器目录并用 CodeMirror 读取、编辑和保存文件；Worker/R2 素材中心不暴露服务器代码文件读写，且无文件编辑屏。",
]);
add("/admin/system/config/system_config_tab/index", "missing", [], [
  "GET /adminapi/config_class", "POST /adminapi/config_class", "PUT /adminapi/config_class/:id", "DELETE /adminapi/config_class/:id",
], [], [
  "旧页按状态/名称搜索树形配置分类，可增删改和切换状态；Worker 保留 config_class CRUD，但新 /config 只导向受控配置页，没有配置分类列表或编辑入口。API 单独存在不等于屏幕迁移。",
], ["view/admin-ts/src/pages/ConfigList.vue", "workers-ts/src/services/system/SystemMetadataService.ts"]);
add("/admin/system/config/system_config_tab/list/:id?", "missing", [], [], [], [
  "旧页按 tab_id 列出任意配置项，创建六类输入字段并编辑值、状态和删除；新 /config 的白名单专用页不提供该通用字段定义/管理流程。",
], ["view/admin-ts/src/pages/ConfigList.vue", "workers-ts/src/services/system/SystemMetadataService.ts"]);
add("/admin/system/config/system_group/index", "missing", [], [], [], [
  "旧页搜索数据组 KEY/名称/简介并可创建、编辑、删除及跳转明细；新 Admin 无通用数据组目录或组定义编辑页。",
], ["cinashop-php/view/admin/src/pages/system/group/components/groupFrom.vue", "view/admin-ts/src/pages/ConfigList.vue"]);
add("/admin/system/config/system_group/list/:id?", "missing", [], [], [], [
  "旧页以 gid 和动态表头管理组数据条目，可新增、编辑、启停、删除；新版只有部分业务专用配置消费，未提供通用组数据编辑器。",
], ["view/admin-ts/src/pages/ConfigList.vue"]);
add("/admin/system/maintain/auth", "missing", [], [], [], [
  "旧商业授权页读取 CRMEB 授权/版本、向供应商申请授权并编辑版权文案/图片；新 Admin 无该供应商授权与版权管理流程。迁移是否正式废止仍需业务决定，不能仅凭平台变更判 retired。",
], ["view/admin-ts/src/pages/config/CommerceSettings.vue"]);
add("/admin/system/crontab", "partial", ["/operations/legacy-runtime"], [
  "GET /adminapi/system/timer/task", "GET /adminapi/system/timer/index",
], [
  "新迁移运行历史页可搜索并查看 PHP system_timer 名称、标识、源开关/周期、最近执行时间及 Worker 对应状态。",
], [
  "旧目录可分页、新建、编辑、删除和启停 PHP 定时任务；新页明确只读，Worker 调度由 Cloudflare Queues/scheduled handler 独立驱动，旧开关不控制运行任务。",
], ["view/admin-ts/src/api/legacyRuntime.ts", "workers-ts/src/controllers/api/v1/AdminLegacyRuntimeController.ts", "workers-ts/src/services/system/LegacyRuntimeCatalogService.ts"]);
add("/admin/system/crontab/create/:id?", "missing", [], [
  "GET /adminapi/system/timer/task", "GET /adminapi/system/timer/one/:id",
], [], [
  "旧表单选择任务、周期（分钟至年）并保存或更新；新 API 仅返回任务名与旧记录详情，新 Admin 无创建/编辑表单，也不能配置 Worker scheduled 任务。",
], ["view/admin-ts/src/pages/operations/LegacyRuntimeHistory.vue"]);

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
  target: { routes: InventoryRoute[] };
};
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && route.path.startsWith("/admin/system"));
if (legacyRoutes.length !== 17) throw new Error(`Expected 17 system business pages, got ${legacyRoutes.length}`);
if (new Set(legacyRoutes.map((route) => route.path)).size !== 17) throw new Error("Duplicate system business path");
for (const [file, sha256] of Object.entries(oldRouterHashes)) {
  if (inventory.legacy.routeFiles.find((item) => item.file === file)?.sha256 !== sha256) {
    throw new Error(`Legacy router snapshot changed: ${file}; re-review auth and behavior`);
  }
}
const legacyPaths = new Set(legacyRoutes.map((route) => route.path));
for (const map of [reviews, oldAuthByPath, oldBehaviorLineByPath]) {
  for (const path of Object.keys(map)) if (!legacyPaths.has(path)) throw new Error(`Unknown system review path: ${path}`);
}
const targetPaths = new Set(inventory.target.routes.filter((route) => route.surface === "page").map((route) => route.path));
const adminRouteSource = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
const registeredApis = new Set([...adminRouteSource.matchAll(/adminapiRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)]
  .map((match) => `${match[1].toUpperCase()} /adminapi${match[2]}`));
function evidenceExists(file: string): boolean {
  if (file.startsWith("cinashop-php/")) return true;
  return existsSync(resolve(workerRoot, "..", file));
}
function apiPermission(api: string): string {
  const [method, path] = api.split(" ");
  const domain = path.startsWith("/adminapi/system_admin/") ? "system"
    : path.startsWith("/adminapi/file/") ? "attachment"
      : path.startsWith("/adminapi/config_class") ? "config"
        : path.startsWith("/adminapi/system/timer/") ? "legacy_runtime"
          : path.startsWith("/adminapi/log/") ? "log" : null;
  if (!domain) throw new Error(`Unmapped system API permission: ${api}`);
  return `${domain}.${method === "GET" ? "view" : "manage"}`;
}
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review || !route.resolvedComponent) throw new Error(`Missing system semantic review or old component: ${route.path}`);
  if (!review.covered.length && !review.remaining.length) throw new Error(`Missing conclusion: ${route.path}`);
  if ((review.status === "partial" || review.status === "candidate") && (!review.covered.length || !review.targetScreens.length || !review.remaining.length)) {
    throw new Error(`Insufficient covered system review: ${route.path}`);
  }
  if (review.status === "missing" && review.targetScreens.length) throw new Error(`Missing system page claims replacement: ${route.path}`);
  if (review.status === "retired" && (review.targetScreens.length || review.remaining.length)) throw new Error(`Invalid retired system page: ${route.path}`);
  for (const screen of review.targetScreens) if (!targetPaths.has(screen) || !screenFiles[screen]) throw new Error(`Unregistered target page: ${route.path} -> ${screen}`);
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const auth = oldAuthByPath[route.path];
  const behaviorLine = oldBehaviorLineByPath[route.path];
  if (!auth || !Number.isSafeInteger(behaviorLine) || behaviorLine <= 0) throw new Error(`Missing old auth or behavior evidence: ${route.path}`);
  const routerSha256 = oldRouterHashes[route.source];
  if (!routerSha256 || route.line <= 0) throw new Error(`Unexpected system router source: ${route.path}`);
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const oldRouter = `cinashop-php/view/admin/${route.source}`;
  const evidence = [...new Set([
    oldRouter, componentPath, `${componentPath}:${behaviorLine}`, oldApi, newRouter, newRoutes, permissionRules,
    ...review.targetScreens.map((screen) => screenFiles[screen]), ...review.evidence,
  ])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return {
    legacy: {
      path: route.path, title: route.title, component: route.component,
      resolvedComponent: componentPath, behaviorSource: `${componentPath}:${behaviorLine}`,
      source: `${oldRouter}:${route.line}`, routerSha256, auth,
    },
    ...review,
    targetPermissions: [...new Set([...review.targetScreens.map((screen) => screenPermissions[screen]), ...review.targetApis.map(apiPermission)])],
    evidence,
  };
});
const statuses: Status[] = ["candidate", "partial", "missing", "retired"];
const counts = Object.fromEntries(statuses.map((status) => [status, routes.filter((route) => route.status === status).length]));
const report = {
  version: 1,
  generatedFrom: "audit/admin-frontend-inventory.json",
  methodology: {
    scope: "Only the 17 surface=page routes under /admin/system in the authoritative 274-page inventory. /admin/system.User/list.html is auxiliary and excluded; /admin/out* belongs to a different path domain.",
    reviewBasis: "Compare each pinned old Vue component, meta.auth and API workflow with the target Admin router, operation surface, Worker route, data contract and permission map. Old route/auth/line evidence is a static reviewed snapshot; CI reads only this repository. An API-only endpoint or a similarly named page does not establish screen parity. Retired requires evidence that the old page was inert or a mock.",
    validationBoundary: "Code-only semantic review. No production role, data, browser E2E, backup/restore, destructive maintenance, deployment or publication is claimed. FE-001D remains open.",
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
