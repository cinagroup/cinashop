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
const outputFile = resolve(workerRoot, "audit/admin-legacy-marketing-route-parity.json");
const oldRouter = "cinashop-php/view/admin/src/router/modules/marketing.js";
const newRouter = "view/admin-ts/src/router/index.ts";
const adminRoutes = "workers-ts/src/routes/adminapi.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const reviewedRouterSha256 = "9b1deadb2081e4326af19b4cafbd78afa943e5b99567362c1773a2e8b99e28ed";
const screens: Record<string, string> = {
  "/coupon": "view/admin-ts/src/pages/coupon/CouponList.vue",
  "/activity": "view/admin-ts/src/pages/activity/ActivityList.vue",
  "/marketing/lottery": "view/admin-ts/src/pages/activity/LotteryList.vue",
  "/content/wechat-qrcode": "view/admin-ts/src/pages/content/WechatQrcode.vue",
};
const permissionKeys: Record<string, string> = {
  "/coupon": "coupon.view / coupon.manage",
  "/activity": "activity.view / activity.manage",
  "/marketing/lottery": "lottery.view / lottery.manage",
  "/content/wechat-qrcode": "wechat_qrcode.view / wechat_qrcode.manage",
};
// Snapshot of meta.auth in marketing.js at the SHA recorded by the inventory.
// Keep this explicit: CI checks out this repository, not the sibling PHP source.
const legacyAuthByPath: Record<string, string> = {
  "/admin/marketing/home": "['admin-marketing-home']",
  "/admin/marketing/store_combination/index": "['marketing-store_combination']",
  "/admin/marketing/store_combination/combina_list": "['marketing-store_combination-combina_list']",
  "/admin/marketing/store_combination/create/:id?/:copy?": "['marketing-store_combination-create']",
  "/admin/marketing/store_combination/statistics/:id?": "not declared in route",
  "/admin/marketing/store_coupon/index": "['marketing-store_coupon']",
  "/admin/marketing/store_coupon_issue/index": "['marketing-store_coupon_issue']",
  "/admin/marketing/store_coupon_issue/create/:id?": "['admin-marketing-store_coupon_issue-create']",
  "/admin/marketing/discount/list": "['marketing-discount-list']",
  "/admin/marketing/discount/give": "['marketing-discount-give']",
  "/admin/marketing/discount/add_give/:id?": "['marketing-discount-add_give']",
  "/admin/marketing/discount/full_discount": "['marketing-discount-full_discount']",
  "/admin/marketing/discount/add_discount/:id?": "['marketing-discount-add_discount']",
  "/admin/marketing/discount/add/:id?": "['marketing-discount-add']",
  "/admin/marketing/discount/pieces_discount": "['marketing-discount-pieces_discount']",
  "/admin/marketing/discount/add_pieces/:id?": "['marketing-discount-add_pieces']",
  "/admin/marketing/store_coupon_user/index": "['marketing-store_coupon_user']",
  "/admin/marketing/coupon/system_config/:type?/:tab_id?": "['admin-order-storeOrder-index']",
  "/admin/marketing/store_bargain/index": "['marketing-store_bargain']",
  "/admin/marketing/store_bargain/bargain_list": "['marketing-store_bargain-bargain_list']",
  "/admin/marketing/store_bargain/create/:id?/:copy?": "['marketing-store_bargain-create']",
  "/admin/marketing/store_bargain/statistics/:id?": "not declared in route",
  "/admin/marketing/store_seckill/index": "['marketing-store_seckill']",
  "/admin/marketing/store_seckill/list": "['marketing-seckill_list']",
  "/admin/marketing/store_seckill_data/index": "['marketing-store_seckill-data']",
  "/admin/marketing/store_seckill/create/:id?/:copy?": "['marketing-store_seckill-create']",
  "/admin/marketing/store_seckill/statistics/:id?": "not declared in route",
  "/admin/marketing/user_point/index": "['marketing-user_point']",
  "/admin/marketing/integral/signIn": "['marketing-integral-sign']",
  "/admin/marketing/point_statistic": "['marketing-point_statistic-index']",
  "/admin/marketing/integral/classify": "['marketing-integral-classify']",
  "/admin/marketing/balance_recharge": "['marketing-balance_recharge']",
  "/admin/marketing/lottery/index": "true",
  "/admin/marketing/lottery/create": "true",
  "/admin/marketing/lottery/recording_list": "['admin-marketing-lottery-recording_list']",
  "/admin/marketing/store_discounts/index": "true",
  "/admin/marketing/store_discounts/create": "true",
  "/admin/marketing/store_integral/index": "['marketing-store_integral']",
  "/admin/marketing/store_integral/create/:id?/:copy?": "['marketing-store_integral-create']",
  "/admin/marketing/store_integral/add_store_integral": "['marketing-store_integral-create']",
  "/admin/marketing/activity_frame": "['admin-marketing-activity_frame']",
  "/admin/marketing/activity_frame/create/:id?": "['marketing-activity_frame-create']",
  "/admin/marketing/activity_background": "['admin-marketing-activity_background']",
  "/admin/marketing/activity_background/create/:id?": "['marketing-activity_background-create']",
  "/admin/marketing/channel_code": "['marketing-channel_code']",
  "/admin/marketing/channel_code/create/:id?": "['marketing-channel_code-create']",
  "/admin/marketing/channel_code/statistic/:id?": "['marketing-channel_code-statistic']",
  "/admin/marketing/sign_rewards": "['admin-marketing-sign_rewards']",
};
const reviews: Record<string, Review> = {};

function add(
  path: string,
  status: Status,
  targetScreens: string[],
  targetApis: string[],
  covered: string,
  remaining: string,
  evidence: string[] = [],
) {
  if (reviews[path]) throw new Error(`Duplicate marketing review: ${path}`);
  reviews[path] = {
    status, targetScreens, targetApis,
    covered: covered ? [covered] : [],
    remaining: remaining ? [remaining] : [],
    evidence,
  };
}

const activityWrite = ["POST /adminapi/activity/save", "POST /adminapi/activity/status", "DELETE /adminapi/activity/del/:type/:id"];
const couponApis = ["GET /adminapi/coupon/list", "POST /adminapi/coupon/save", "POST /adminapi/coupon/status/:id", "DELETE /adminapi/coupon/del/:id"];
const lotteryApis = ["GET /adminapi/lottery/list", "GET /adminapi/lottery/detail/:id", "POST /adminapi/lottery/add", "PUT /adminapi/lottery/edit/:id", "POST /adminapi/lottery/set_status/:id/:status", "DELETE /adminapi/lottery/del/:id"];
const discountApis = ["GET /adminapi/discounts/list", "GET /adminapi/discounts/info/:id", "POST /adminapi/discounts/save", "PUT /adminapi/discounts/set_status/:id/:status", "DELETE /adminapi/discounts/del/:id"];
const qrcodeApis = ["GET /adminapi/wechat_qrcode/list", "GET /adminapi/wechat_qrcode/info/:id", "POST /adminapi/wechat_qrcode/save/:id", "GET /adminapi/wechat_qrcode/statistic/:qid"];

// The route is a navigation surface. A partial target means only some destinations exist.
add("/admin/marketing/home", "partial", ["/coupon", "/activity", "/marketing/lottery", "/content/wechat-qrcode"], [],
  "新 Admin 菜单可进入优惠券、活动、抽奖和公众号渠道码。",
  "旧营销宫格的促销、积分日志/分类/签到、充值及活动边框/背景等目的地仍缺；没有同等的营销总览。", ["view/admin-ts/src/layouts/AdminLayout.vue"]);

add("/admin/marketing/store_combination/index", "partial", ["/activity"], ["GET /adminapi/activity/combination", ...activityWrite],
  "拼团 tab 可列出活动并进入新增、编辑、启停和删除。",
  "新目录无分页/旧筛选，BaseDao 因未收到 page 而实际无界查询；详情、复制和专门统计仍缺。",
  ["workers-ts/src/dao/BaseDao.ts", "cinashop-php/app/controller/admin/v1/marketing/combination/StoreCombination.php"]);
add("/admin/marketing/store_combination/combina_list", "partial", ["/activity"], ["GET /adminapi/activity/pink/:combinationId"],
  "拼团 tab 的团列表弹窗能读取指定活动的团记录。",
  "旧独立团列表的查询、订单关联和完整状态操作仍缺。");
add("/admin/marketing/store_combination/create/:id?/:copy?", "partial", ["/activity"], ["POST /adminapi/activity/save"],
  "聚合表单可保存拼团商品、价格、库存、人数和状态等基础字段。",
  "旧活动起止时间、SKU/限购/分享配置和 copy 参数未恢复；完整前端表单提交仍需并发库存/额度边界验收。");
add("/admin/marketing/store_combination/statistics/:id?", "partial", ["/activity"], ["GET /adminapi/activity/pink/:combinationId"],
  "可在团列表弹窗读取一部分参与团记录。",
  "旧 statistics/head、list、order 三组统计、订单维度和图表没有等价页面/API。");

add("/admin/marketing/store_coupon/index", "missing", [], [], "",
  "旧页管理 store_coupon 模板并可发券；新 /coupon 读写 store_coupon_issue 发行实例，不管理模板实体。", ["view/admin-ts/src/pages/coupon/CouponList.vue", "workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
add("/admin/marketing/store_coupon_issue/index", "partial", ["/coupon"], couponApis,
  "新页可列出已发行优惠券并做基础编辑、停发和删除。",
  "旧领取方式、数量、范围、复制和领取日志入口仍缺；新列表未过滤 is_del，软删后仍显示历史发行券。",
  ["workers-ts/src/controllers/api/v1/AdminCrudController.ts", "cinashop-php/app/services/activity/coupon/StoreCouponIssueServices.php"]);
add("/admin/marketing/store_coupon_issue/create/:id?", "partial", ["/coupon"], ["POST /adminapi/coupon/save"],
  "新表单可编辑发行券名称、面额、门槛和有效天数。",
  "旧普通/会员券、手领/后台发、商品/品类/品牌范围、数量和使用期字段未在 Admin 表单暴露；Worker 接受部分字段不等于页面覆盖。");
add("/admin/marketing/discount/list", "missing", [], [], "", "旧促销总目录含独立规则列表和状态动作，新 Admin 没有促销规则页面或对应操作合同。");
add("/admin/marketing/discount/give", "missing", [], [], "", "旧满送列表管理赠品/赠券规则，新 Admin 没有该规则目录。");
add("/admin/marketing/discount/add_give/:id?", "missing", [], [], "", "旧满送编辑页的门槛、赠品/赠券和适用范围没有 Admin 写入表单。");
add("/admin/marketing/discount/full_discount", "missing", [], [], "", "旧满减规则目录和状态管理没有 Admin 页面。");
add("/admin/marketing/discount/add_discount/:id?", "missing", [], [], "", "旧满减规则创建/编辑的阶梯门槛和范围没有 Admin 写入表单。");
add("/admin/marketing/discount/add/:id?", "missing", [], [], "", "旧单品折扣编辑页的商品/会员/标签范围没有 Admin 写入表单。");
add("/admin/marketing/discount/pieces_discount", "missing", [], [], "", "旧多件折扣目录没有 Admin 页面或状态操作面。");
add("/admin/marketing/discount/add_pieces/:id?", "missing", [], [], "", "旧多件折扣门槛、折扣和商品范围编辑流程没有 Admin 页面。");
add("/admin/marketing/store_coupon_user/index", "missing", [], [], "", "旧领取记录与用户发券页没有新 Admin 页面；/coupon/list 是发行实例，不是 store_coupon_user 记录。", ["view/admin-ts/src/pages/coupon/CouponList.vue"]);
add("/admin/marketing/coupon/system_config/:type?/:tab_id?", "missing", [], [], "", "旧优惠券动态配置表单没有逐键核验的新专页；不能借 /coupon 的发行列表推定配置已覆盖。");

add("/admin/marketing/store_bargain/index", "partial", ["/activity"], ["GET /adminapi/activity/bargain", ...activityWrite],
  "砍价 tab 可列活动、编辑、启停和删除。",
  "新目录固定前100条且无分页/旧筛选，超过100条会静默漏项；活动配置和参与统计仍需专门对照。",
  ["workers-ts/src/dao/BaseDao.ts"]);
add("/admin/marketing/store_bargain/bargain_list", "partial", ["/activity"], ["GET /adminapi/activity/bargain_users/:bargainId"],
  "砍价明细弹窗可看指定活动的参与记录。",
  "旧参与者目录的查询、详情及订单动作未完整迁入。");
add("/admin/marketing/store_bargain/create/:id?/:copy?", "partial", ["/activity"], ["GET /adminapi/activity/bargain/sku-options", "POST /adminapi/activity/save"],
  "新表单使用权威 SKU 选择并可编辑价格、库存、人数、内容和配送。",
  "旧 copy 参数及全部活动素材/规则字段尚无逐字段等价证据。");
add("/admin/marketing/store_bargain/statistics/:id?", "partial", ["/activity"], ["GET /adminapi/activity/bargain_users/:bargainId"],
  "可由砍价明细弹窗读取部分参与者信息。",
  "旧 statistics/head、list、order 的汇总、趋势和订单报表未恢复。");

add("/admin/marketing/store_seckill/index", "partial", ["/activity"], ["GET /adminapi/activity/seckill", ...activityWrite],
  "秒杀 tab 可列活动并做基础编辑、状态和删除。",
  "新目录无分页/旧筛选，BaseDao 因未收到 page 而实际无界查询；旧时段关系和统计仍缺，新建未选择时段时默认 timeId='1'。",
  ["workers-ts/src/dao/BaseDao.ts", "cinashop-php/app/controller/admin/v1/marketing/seckill/StoreSeckill.php"]);
add("/admin/marketing/store_seckill/list", "missing", [], ["GET /adminapi/activity/seckill_times"], "",
  "旧屏管理含日期、场次、参与商品数、状态与复制的秒杀活动；新时段只读接口及商品 tab 没有这个独立活动目录。");
add("/admin/marketing/store_seckill_data/index", "missing", [], [], "",
  "旧 seckill_data 页管理秒杀幻灯片、描述与启停；新 seckill_times 仅是时段读取，不能代替这块内容配置。", ["workers-ts/src/controllers/api/v1/AdminCrudController.ts"]);
add("/admin/marketing/store_seckill/create/:id?/:copy?", "partial", ["/activity"], ["POST /adminapi/activity/save"],
  "聚合表单可保存秒杀商品、价格、库存和限购等基础值。",
  "旧 SKU、活动时间、场次选择/复制及图文配置未恢复；新建未传 timeId 时默认 '1'，完整表单提交仍需并发库存/额度验收。");
add("/admin/marketing/store_seckill/statistics/:id?", "missing", [], [], "",
  "旧秒杀 head、people、order 统计没有新 Admin 统计页；活动目录和时段只读接口不提供该屏语义。");

add("/admin/marketing/user_point/index", "missing", [], [], "", "旧积分日志按用户/类型列出明细并展示统计，新 Admin 没有积分流水专页。");
add("/admin/marketing/integral/signIn", "missing", [], [], "", "旧积分签到视觉和 group_data 配置没有新 Admin 编辑页。");
add("/admin/marketing/point_statistic", "missing", [], [], "", "旧积分基本、趋势、渠道与类型四组统计没有新 Admin 页面。");
add("/admin/marketing/integral/classify", "missing", [], [], "", "旧积分分类新增、编辑和显隐没有新 Admin 管理页。");
add("/admin/marketing/balance_recharge", "missing", [], [], "", "旧充值金额 group_data 列表/编辑没有新 Admin 页面；支付充值能力不代表运营配置页。");

add("/admin/marketing/lottery/index", "partial", ["/marketing/lottery"], lotteryApis,
  "新抽奖页可按名称、参与条件和启停筛选，列表支持编辑、状态和删除。",
  "旧未开始/进行中/已结束筛选未在新列表提供；真实奖品/运营数据仍待核验。");
add("/admin/marketing/lottery/create", "partial", ["/marketing/lottery"], ["GET /adminapi/lottery/factor_info/:factor", "POST /adminapi/lottery/add", "PUT /adminapi/lottery/edit/:id"],
  "新抽奖弹窗可配置活动与八个奖位并保存或编辑。",
  "旧微信红包和未明确等级奖品不能在新页新建；素材与奖品字段仍需真实数据对照。");
add("/admin/marketing/lottery/recording_list", "partial", ["/marketing/lottery"], ["GET /adminapi/lottery/record/list", "GET /adminapi/lottery/record/list/:id", "POST /adminapi/lottery/record/deliver"],
  "新页中奖记录抽屉可读记录并处理站内商品发货/备注。",
  "旧活动/奖品/用户/时间筛选和完整翻页未恢复；新抽屉固定读取前100条。");

add("/admin/marketing/store_discounts/index", "candidate", ["/activity"], discountApis,
  "优惠套餐 tab 提供类型/状态/名称筛选、分页、详情、启停和删除。",
  "仅完成本地代码映射；真实套餐/SKU、受限角色与发布后流程仍需 FE-001G/H 验收。", ["view/admin-ts/src/pages/activity/DiscountPackageManager.vue", "workers-ts/src/services/activity/AdminDiscountPackageService.ts", "MIGRATION_AUDIT.md"]);
add("/admin/marketing/store_discounts/create", "candidate", ["/activity"], discountApis,
  "新套餐表单支持固定/任选套餐、商品 SKU、限量、有效期、标签、包邮与退款规则的创建和编辑。",
  "仅完成本地代码映射；真实历史套餐、受限角色和订单闭环仍需 FE-001G/H 验收。", ["view/admin-ts/src/pages/activity/DiscountPackageManager.vue", "workers-ts/src/services/activity/AdminDiscountPackageService.ts", "MIGRATION_AUDIT.md"]);

add("/admin/marketing/store_integral/index", "partial", ["/activity"], ["GET /adminapi/activity/integral", ...activityWrite],
  "积分商城 tab 可列积分商品并做基础编辑、启停和删除。",
  "新目录无分页/旧筛选，BaseDao 因未收到 page 而实际无界查询；复制和旧商品字段仍缺。",
  ["workers-ts/src/dao/BaseDao.ts", "cinashop-php/app/controller/admin/v1/marketing/integral/StoreIntegral.php"]);
add("/admin/marketing/store_integral/create/:id?/:copy?", "partial", ["/activity"], ["POST /adminapi/activity/save"],
  "聚合表单可保存积分商品基本价格、积分、库存、排序和状态。",
  "旧 SKU 及多字段积分商品编辑与 copy 参数语义未逐项恢复；完整表单提交仍需并发库存/额度边界验收。");
add("/admin/marketing/store_integral/add_store_integral", "missing", [], [], "",
  "旧批量添加积分商品页没有 Admin 批量操作入口；单件新增弹窗不等于批量流程。");

add("/admin/marketing/activity_frame", "missing", [], [], "", "旧活动边框目录/状态管理没有新 Admin 页面。");
add("/admin/marketing/activity_frame/create/:id?", "missing", [], [], "", "旧活动边框素材、适用范围和编辑保存没有新 Admin 页面。");
add("/admin/marketing/activity_background", "missing", [], [], "", "旧活动背景目录/状态管理没有新 Admin 页面。");
add("/admin/marketing/activity_background/create/:id?", "missing", [], [], "", "旧活动背景素材、适用范围和编辑保存没有新 Admin 页面。");

add("/admin/marketing/channel_code", "partial", ["/content/wechat-qrcode"], qrcodeApis,
  "公众号渠道码页可列目录、分类、状态、扫码用户并请求异步生成。",
  "公众号扫码回调尚未启用，真实远端码/历史扫码及角色验收未完成。");
add("/admin/marketing/channel_code/create/:id?", "partial", ["/content/wechat-qrcode"], ["GET /adminapi/wechat_qrcode/info/:id", "POST /adminapi/wechat_qrcode/save/:id", "POST /adminapi/wechat_qrcode/provision/:id"],
  "公众号渠道码页提供分类选择及新增/编辑、生成任务入口。",
  "旧表单全部用户标签/回复字段及远端生成结果未逐字段和真实渠道验证。");
add("/admin/marketing/channel_code/statistic/:id?", "partial", ["/content/wechat-qrcode"], ["GET /adminapi/wechat_qrcode/statistic/:qid", "GET /adminapi/wechat_qrcode/user_list/:qid"],
  "公众号渠道码页有扫码统计和用户抽屉。",
  "真实扫码回调未启用，历史数据、受限角色和远端二维码/扫码结果仍需验收。");
add("/admin/marketing/sign_rewards", "missing", [], ["GET /adminapi/setting/sign/rewards", "POST /adminapi/setting/sign/save_rewards/:id"], "",
  "Worker 有签到奖励读写合同，但新 Admin 没有签到奖励列表/编辑页面，API-only 不构成整屏覆盖。");

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  legacy: { routes: InventoryRoute[]; routeFiles: { file: string; sha256: string }[] };
  target: { routes: InventoryRoute[] };
};
const routerSnapshot = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/marketing.js");
if (routerSnapshot?.sha256 !== reviewedRouterSha256) throw new Error("Legacy marketing router snapshot changed; re-review PHP route auth and semantics");
const legacyRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && route.path.startsWith("/admin/marketing"));
if (legacyRoutes.length !== 48) throw new Error(`Expected 48 marketing business routes, found ${legacyRoutes.length}`);
if (new Set(legacyRoutes.map((route) => route.path)).size !== 48) throw new Error("Duplicate legacy marketing paths");
const inventoryPaths = new Set(legacyRoutes.map((route) => route.path));
for (const path of Object.keys(reviews)) if (!inventoryPaths.has(path)) throw new Error(`Unknown marketing review: ${path}`);
for (const path of Object.keys(legacyAuthByPath)) if (!inventoryPaths.has(path)) throw new Error(`Unknown marketing auth: ${path}`);
const targetPaths = new Set(inventory.target.routes.filter((route) => route.surface === "page").map((route) => route.path));
const adminRouteSource = readFileSync(resolve(workerRoot, "src/routes/adminapi.ts"), "utf8");
const registeredApis = new Set([...adminRouteSource.matchAll(/adminapiRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/gu)]
  .map((match) => `${match[1].toUpperCase()} /adminapi${match[2]}`));
function evidenceExists(file: string): boolean {
  // The old PHP paths are provenance strings from the pinned inventory snapshot.
  // Only target-repository files can be checked in a single-checkout CI job.
  if (file.startsWith("cinashop-php/")) return true;
  return existsSync(resolve(workerRoot, "..", file));
}
const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path];
  if (!review) throw new Error(`Missing marketing semantic review: ${route.path}`);
  if (!route.resolvedComponent) throw new Error(`Unresolved legacy marketing component: ${route.path}`);
  if (!review.remaining.length || (review.status !== "missing" && !review.covered.length)) throw new Error(`Insufficient semantic conclusion: ${route.path}`);
  if (review.status === "missing" && review.targetScreens.length) throw new Error(`Missing route has target screen: ${route.path}`);
  if (review.status === "candidate" && !review.targetScreens.length) throw new Error(`Candidate has no target screen: ${route.path}`);
  if (route.source !== routerSnapshot.file || route.line <= 0) throw new Error(`Unexpected marketing route provenance: ${route.path}`);
  for (const screen of review.targetScreens) if (!targetPaths.has(screen) || !screens[screen]) throw new Error(`Unregistered target screen: ${route.path} -> ${screen}`);
  for (const api of review.targetApis) if (!registeredApis.has(api)) throw new Error(`Unregistered target API: ${route.path} -> ${api}`);
  const legacyAuth = legacyAuthByPath[route.path];
  if (!legacyAuth) throw new Error(`Missing marketing auth review: ${route.path}`);
  const targetPermissions = [...new Set(review.targetScreens.map((screen) => permissionKeys[screen]))];
  const componentPath = `cinashop-php/view/admin/${route.resolvedComponent}`;
  const evidence = [...new Set([
    componentPath, oldRouter, newRouter, adminRoutes, permissionRules,
    ...review.targetScreens.map((screen) => screens[screen]),
    ...(review.targetScreens.includes("/activity") ? ["workers-ts/src/controllers/api/v1/AdminCrudController.ts"] : []),
    ...review.evidence,
  ])];
  for (const file of evidence) if (!evidenceExists(file)) throw new Error(`Missing evidence file: ${route.path} -> ${file}`);
  return {
    legacy: { path: route.path, title: route.title, component: route.component, resolvedComponent: componentPath, source: `${oldRouter}:${route.line}`, routerSha256: reviewedRouterSha256, auth: legacyAuth },
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
    scope: "Only the 48 surface=page routes under /admin/marketing in the authoritative 274-route inventory; four commonForm auxiliary routes are excluded.",
    reviewBasis: "Compare the legacy PHP component and API observations pinned to marketing.js SHA-256 with the target Admin route/page, Worker adminapi contract, and permission map. Legacy paths and meta.auth are recorded static review evidence; generation requires only this repository. An API without an Admin operation surface does not establish screen parity. Candidate means local code-level workflow coverage only; partial records a material subset; missing records no viable target Admin screen. Do not infer domain coverage from /activity or a shared title.",
    validationBoundary: "Code-only semantic review. No production data, provider, real-role browser E2E, deployment, or publication is claimed. FE-001D and FE-001G/H remain open.",
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
