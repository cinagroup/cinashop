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
const marketingConfigFollowup = process.argv.includes("--marketing-config-followup");
const integralBatchFollowup = process.argv.includes("--integral-batch-followup") || marketingConfigFollowup;
const fullGiftRefundFollowup = process.argv.includes("--full-gift-refund-followup") || integralBatchFollowup;
const fullGiftFollowup = process.argv.includes("--full-gift-followup") || fullGiftRefundFollowup;
const nthDiscountFollowup = process.argv.includes("--nth-discount-followup") || fullGiftFollowup;
const fullDiscountFollowup = process.argv.includes("--full-discount-followup") || nthDiscountFollowup;
const timeDiscountFollowup = process.argv.includes("--time-discount-followup") || fullDiscountFollowup;
const activityBackgroundFollowup = process.argv.includes("--activity-background-followup") || timeDiscountFollowup;
const activityFrameFollowup = process.argv.includes("--activity-frame-followup") || activityBackgroundFollowup;
const userPointFollowup = process.argv.includes("--user-point-followup") || activityFrameFollowup;
const lotteryFollowup = process.argv.includes("--lottery-followup") || userPointFollowup;
const inventoryPath = marketingConfigFollowup
  ? "audit/admin-frontend-inventory-marketing-config-followup-20260930.json"
  : integralBatchFollowup
  ? "audit/admin-frontend-inventory-integral-batch-followup-20260930.json"
  : "audit/admin-frontend-inventory.json";
const inventoryFile = resolve(workerRoot, inventoryPath);
const outputFile = resolve(workerRoot, marketingConfigFollowup
  ? "audit/admin-legacy-marketing-route-parity-marketing-config-followup-20260930.json"
  : integralBatchFollowup
  ? "audit/admin-legacy-marketing-route-parity-integral-batch-followup-20260930.json"
  : fullGiftRefundFollowup
  ? "audit/admin-legacy-marketing-route-parity-full-gift-refund-followup-20260930.json"
  : fullGiftFollowup
  ? "audit/admin-legacy-marketing-route-parity-full-gift-followup-20260930.json"
  : nthDiscountFollowup
  ? "audit/admin-legacy-marketing-route-parity-nth-discount-followup-20260930.json"
  : fullDiscountFollowup
  ? "audit/admin-legacy-marketing-route-parity-full-discount-followup-20260930.json"
  : timeDiscountFollowup
  ? "audit/admin-legacy-marketing-route-parity-time-discount-followup-20260930.json"
  : activityBackgroundFollowup
  ? "audit/admin-legacy-marketing-route-parity-activity-background-followup-20260930.json"
  : activityFrameFollowup
  ? "audit/admin-legacy-marketing-route-parity-activity-frame-followup-20260930.json"
  : userPointFollowup
  ? "audit/admin-legacy-marketing-route-parity-user-point-followup-20260928.json"
  : lotteryFollowup ? "audit/admin-legacy-marketing-route-parity-lottery-followup-20260928.json"
  : "audit/admin-legacy-marketing-route-parity.json");
const oldRouter = "cinashop-php/view/admin/src/router/modules/marketing.js";
const newRouter = "view/admin-ts/src/router/index.ts";
const adminRoutes = "workers-ts/src/routes/adminapi.ts";
const permissionRules = "workers-ts/src/services/admin/AdminPermissionService.ts";
const reviewedRouterSha256 = "9b1deadb2081e4326af19b4cafbd78afa943e5b99567362c1773a2e8b99e28ed";
const screens: Record<string, string> = {
  "/coupon": "view/admin-ts/src/pages/coupon/CouponList.vue",
  "/marketing/coupon-templates": "view/admin-ts/src/pages/marketing/CouponTemplates.vue",
  "/activity": "view/admin-ts/src/pages/activity/ActivityList.vue",
  "/activity/integral-batch": "view/admin-ts/src/pages/activity/IntegralBatch.vue",
  "/activity/combinations": "view/admin-ts/src/pages/activity/Combinations.vue",
  "/activity/combination-groups": "view/admin-ts/src/pages/activity/CombinationGroups.vue",
  "/activity/combination-statistics/:id?": "view/admin-ts/src/pages/activity/CombinationStatistics.vue",
  "/activity/seckill-times": "view/admin-ts/src/pages/activity/SeckillTimes.vue",
  "/activity/seckill-activities": "view/admin-ts/src/pages/activity/SeckillActivities.vue",
  "/activity/seckill-statistics/:id?": "view/admin-ts/src/pages/activity/SeckillStatistics.vue",
  "/marketing/lottery": "view/admin-ts/src/pages/activity/LotteryList.vue",
  "/marketing/lottery-records": "view/admin-ts/src/pages/marketing/LotteryRecords.vue",
  "/marketing/activity-frame": "view/admin-ts/src/pages/marketing/ActivityFrameList.vue",
  "/marketing/activity-frame/create/:id?": "view/admin-ts/src/pages/marketing/ActivityFrameForm.vue",
  "/marketing/activity-background": "view/admin-ts/src/pages/marketing/ActivityBackgroundList.vue",
  "/marketing/activity-background/create/:id?": "view/admin-ts/src/pages/marketing/ActivityBackgroundForm.vue",
  "/marketing/time-discounts": "view/admin-ts/src/pages/marketing/TimeDiscountList.vue",
  "/marketing/time-discounts/create/:id?": "view/admin-ts/src/pages/marketing/TimeDiscountForm.vue",
  "/marketing/full-discounts": "view/admin-ts/src/pages/marketing/FullDiscountList.vue",
  "/marketing/full-discounts/create/:id?": "view/admin-ts/src/pages/marketing/FullDiscountForm.vue",
  "/marketing/nth-discounts": "view/admin-ts/src/pages/marketing/NthDiscountList.vue",
  "/marketing/nth-discounts/create/:id?": "view/admin-ts/src/pages/marketing/NthDiscountForm.vue",
  "/marketing/full-gifts": "view/admin-ts/src/pages/marketing/FullGiftList.vue",
  "/marketing/full-gifts/create/:id?": "view/admin-ts/src/pages/marketing/FullGiftForm.vue",
  "/marketing/user-point": "view/admin-ts/src/pages/marketing/IntegralLog.vue",
  "/marketing/point-statistic": "view/admin-ts/src/pages/marketing/PointStatistic.vue",
  "/marketing/sign-rewards": "view/admin-ts/src/pages/marketing/SignRewards.vue",
  "/marketing/sign-day-config": "view/admin-ts/src/pages/marketing/SignDayConfig.vue",
  "/marketing/integral-categories": "view/admin-ts/src/pages/marketing/IntegralCategories.vue",
  "/marketing/recharge-options": "view/admin-ts/src/pages/marketing/RechargeOptions.vue",
  "/marketing/coupon-records": "view/admin-ts/src/pages/marketing/CouponRecords.vue",
  "/content/wechat-qrcode": "view/admin-ts/src/pages/content/WechatQrcode.vue",
};
const permissionKeys: Record<string, string> = {
  "/coupon": "coupon.view / coupon.manage",
  "/marketing/coupon-templates": "coupon_template.view / coupon_template.manage",
  "/activity": "activity.view / activity.manage",
  "/activity/integral-batch": "integral_batch.view / integral_batch.manage",
  "/activity/combinations": "combination.view / combination.manage",
  "/activity/combination-groups": "combination_group.view",
  "/activity/combination-statistics/:id?": "combination_statistics.view",
  "/activity/seckill-times": "seckill_time.view / seckill_time.manage",
  "/activity/seckill-activities": "seckill_activity.view / seckill_activity.manage",
  "/activity/seckill-statistics/:id?": "seckill_statistics.view",
  "/marketing/lottery": "lottery.view / lottery.manage",
  "/marketing/lottery-records": "lottery_record.view / lottery_record.manage",
  "/marketing/activity-frame": "activity_frame.view / activity_frame.manage",
  "/marketing/activity-frame/create/:id?": "activity_frame.view / activity_frame.manage",
  "/marketing/activity-background": "activity_background.view / activity_background.manage",
  "/marketing/activity-background/create/:id?": "activity_background.view / activity_background.manage",
  "/marketing/time-discounts": "time_discount.view / time_discount.manage",
  "/marketing/time-discounts/create/:id?": "time_discount.view / time_discount.manage",
  "/marketing/full-discounts": "full_discount.view / full_discount.manage",
  "/marketing/full-discounts/create/:id?": "full_discount.view / full_discount.manage",
  "/marketing/nth-discounts": "nth_discount.view / nth_discount.manage",
  "/marketing/nth-discounts/create/:id?": "nth_discount.view / nth_discount.manage",
  "/marketing/full-gifts": "full_gift.view / full_gift.manage",
  "/marketing/full-gifts/create/:id?": "full_gift.view / full_gift.manage",
  "/marketing/user-point": "integral_log.view",
  "/marketing/point-statistic": "point_statistic.view",
  "/marketing/sign-rewards": "config.view / config.manage",
  "/marketing/sign-day-config": "sign_day_config.view / sign_day_config.manage",
  "/marketing/integral-categories": "integral_category.view / integral_category.manage",
  "/marketing/recharge-options": "recharge_quota.view / recharge_quota.manage",
  "/marketing/coupon-records": "coupon_record.view",
  "/content/wechat-qrcode": "wechat_qrcode.view / wechat_qrcode.manage",
};
// Shared screens do not imply shared capabilities: export has an independent
// read permission, and template publication also requires source visibility.
const apiPermissionKeys: Record<string, string> = {
  "GET /adminapi/activity/combinations/export": "combination_export.view",
  "GET /adminapi/marketing/user-point/export": "integral_log.export",
  "POST /adminapi/marketing/coupon-template-issues": "coupon_template_issue.manage + coupon_template.view",
  "GET /adminapi/marketing/coupon-issues/:id/claims": "coupon_record.view",
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
const combinationApis = [
  "GET /adminapi/activity/combinations",
  "GET /adminapi/activity/combinations/options",
  "GET /adminapi/activity/combinations/products",
  "GET /adminapi/activity/combinations/products/:productId",
  "GET /adminapi/activity/combinations/:id",
  "POST /adminapi/activity/combinations",
  "PUT /adminapi/activity/combinations/:id",
  "PUT /adminapi/activity/combinations/:id/status",
  "DELETE /adminapi/activity/combinations/:id",
];
const combinationEvidence = [
  "view/admin-ts/src/api/combination.ts",
  "view/admin-ts/src/pages/activity/CombinationImagePicker.vue",
  "workers-ts/src/controllers/api/v1/AdminCombinationController.ts",
  "workers-ts/src/services/admin/AdminCombinationService.ts",
  "workers-ts/src/services/admin/AdminCombinationInput.ts",
  "workers-ts/src/services/admin/AdminCombinationData.ts",
  "workers-ts/src/services/admin/AdminCombinationMediaPolicy.ts",
  "workers-ts/src/routes/v1/index.ts",
  "workers-ts/test/admin-combinations-frontend.test.ts",
  "workers-ts/test/admin-combination.test.ts",
  "workers-ts/test/admin-combination-postgres.test.ts",
  "workers-ts/test/admin-combination-http.test.ts",
  "workers-ts/test/pink-virtual-timeout-postgres.test.ts",
  "workers-ts/test/pink-success-notice-postgres.test.ts",
  "workers-ts/test/combination-refund-policy-postgres.test.ts",
  "workers-ts/test/pink-success-notice-migration.test.ts",
  "workers-ts/audit/combination-browser-20260927.json",
  "workers-ts/audit/combination-native-20260927.json",
  "cinashop-php/app/controller/admin/v1/marketing/combination/StoreCombination.php",
];
const combinationGroupApis = [
  "GET /adminapi/activity/combination-groups/head",
  "GET /adminapi/activity/combination-groups",
  "GET /adminapi/activity/combination-groups/:groupId/members",
];
const combinationStatisticsApis = [
  "GET /adminapi/activity/combination-statistics/:id/head",
  "GET /adminapi/activity/combination-statistics/:id/groups",
  "GET /adminapi/activity/combination-statistics/:id/groups/:groupId/members",
  "GET /adminapi/activity/combination-statistics/:id/orders",
];
const combinationReadEvidence = [
  "view/admin-ts/src/api/combinationStatistics.ts",
  "view/admin-ts/src/pages/activity/combinationReadSession.ts",
  "view/admin-ts/src/pages/activity/CombinationGroupTable.vue",
  "view/admin-ts/src/pages/activity/CombinationMembers.vue",
  "workers-ts/src/controllers/api/v1/AdminCombinationStatisticsController.ts",
  "workers-ts/src/services/admin/AdminCombinationStatisticsService.ts",
  "workers-ts/src/services/admin/AdminCombinationStatisticsInput.ts",
  "workers-ts/src/routes/v1/index.ts",
  "workers-ts/test/admin-combination-statistics.test.ts",
  "workers-ts/test/admin-combination-statistics-postgres.test.ts",
  "workers-ts/test/admin-combination-statistics-http.test.ts",
  "workers-ts/test/admin-combination-statistics-frontend.test.ts",
  "cinashop-php/app/controller/admin/v1/marketing/combination/StoreCombination.php",
  "cinashop-php/app/services/activity/combination/StoreCombinationServices.php",
  "cinashop-php/app/services/activity/combination/StorePinkServices.php",
  "cinashop-php/app/dao/activity/combination/StorePinkDao.php",
  "cinashop-php/app/dao/order/StoreOrderDao.php",
];
const combinationReadRemaining = "仅完成本地只读候选；生产真实角色/配置、公共媒体/R2与真实设备、完整Linux CI及发布后流程仍需验收。三个独立view权限不由combination.manage或activity.manage代授，订单详情还需order.view。本批不新增schema或grants，不宣称支付、退款、虚拟补员或通知消费者因只读屏而闭合；旧泛型团数组接口不计逐屏等价，合成验收不等于生产验收。";
const seckillParentApis = ["GET /adminapi/activity/seckill-activities", "GET /adminapi/activity/seckill-activities/options",
  "GET /adminapi/activity/seckill-activities/products", "GET /adminapi/activity/seckill-activities/products/:productId",
  "GET /adminapi/activity/seckill-activities/:id", "POST /adminapi/activity/seckill-activities",
  "PUT /adminapi/activity/seckill-activities/:id", "PUT /adminapi/activity/seckill-activities/:id/status",
  "DELETE /adminapi/activity/seckill-activities/:id"];
const couponIssueCatalogApis = [
  "GET /adminapi/marketing/coupon-issues",
  "GET /adminapi/marketing/coupon-issues/:id",
  "GET /adminapi/marketing/coupon-issues/:id/copy",
  "GET /adminapi/marketing/coupon-issues/:id/claims",
  "POST /adminapi/marketing/coupon-issues/:id/status",
  "DELETE /adminapi/marketing/coupon-issues/:id",
];
const couponIssueCreateApis = [
  "GET /adminapi/marketing/coupon-issues/options",
  "GET /adminapi/marketing/coupon-issues/products",
  "GET /adminapi/marketing/coupon-issues/:id/copy",
  "POST /adminapi/marketing/coupon-issues",
];
const couponIssueEvidence = [
  "cinashop-php/app/controller/admin/v1/marketing/coupon/StoreCouponIssue.php",
  "cinashop-php/app/services/activity/coupon/StoreCouponIssueServices.php",
  "cinashop-php/app/dao/activity/coupon/StoreCouponIssueDao.php",
  "cinashop-php/app/dao/activity/coupon/StoreCouponIssueUserDao.php",
  "cinashop-php/app/services/activity/coupon/StoreCouponUserServices.php",
  "view/admin-ts/src/api/couponIssue.ts", "workers-ts/src/controllers/api/v1/AdminCouponIssueController.ts",
  "workers-ts/src/services/admin/AdminCouponIssueInput.ts", "workers-ts/src/services/admin/AdminCouponIssueService.ts",
  "workers-ts/src/services/admin/AdminCouponTemplateService.ts", "workers-ts/src/services/activity/ActivityService.ts",
  "workers-ts/src/services/activity/ProductCouponService.ts", "workers-ts/src/services/order/CheckoutCouponTemplateAuthority.ts",
  "workers-ts/test/admin-coupon-issue-input.test.ts", "workers-ts/test/admin-coupon-issue.test.ts",
  "workers-ts/test/admin-coupon-issue-postgres.test.ts", "workers-ts/test/admin-coupon-issue-http.test.ts",
  "workers-ts/test/coupon-manual-claim.test.ts", "workers-ts/test/admin-permission.test.ts",
  "workers-ts/test/admin-coupon-issues-frontend.test.ts", "workers-ts/test/checkout-coupon-management.test.ts",
  "workers-ts/audit/coupon-issue-native-20260927.json", "workers-ts/audit/coupon-issue-browser-20260927.json",
];
const couponIssueRemaining = "本机新增原生四文件38项唯一通过，保留service10/manual12并采用最终完整formal10/HTTP6；既有消费者原生七文件225项、输入/权限/wallet三文件50项与前端47项分别计账，Admin构建及最终166文件dist合成浏览器已通过，不冒充单批原生总数。旧安装和运行权限沿用，本批无新DDL/grants。旧generic经济编辑仅保留兼容与checkout回归，不是旧绑定页编辑合同；优惠券配置页仍missing。会员真实权益与领取渠道、新人注册配置、赠送/自动满赠/关注投递仍须独立验收，保存用途不等于消费者闭合。源模板proof只证明来源，不禁止独立发行启停；app_type非0不支持直接复制，须核对后明确独立新建。未知结果恢复仅GET与人工核对，确认只清本地状态不证明服务端成功/失败，换新UUID可能重复发行，刷新/退出不保存恢复队列。浏览器使用合成API和角色，导航菜单不代替真实servermenu授权；完整Linux CI、真实配置/角色、真实设备/provider与部署发布继续开放。旧模板native/browser/acceptance及其源码、dist、台账capsule保持原字节，不以本批覆盖旧证据。";
const couponTemplateApis = [
  "GET /adminapi/marketing/coupon-templates",
  "GET /adminapi/marketing/coupon-templates/options",
  "GET /adminapi/marketing/coupon-templates/products",
  "GET /adminapi/marketing/coupon-templates/:id/issues",
  "GET /adminapi/marketing/coupon-templates/:id",
  "POST /adminapi/marketing/coupon-templates",
  "POST /adminapi/marketing/coupon-templates/:id/invalidate",
  "DELETE /adminapi/marketing/coupon-templates/:id",
  "POST /adminapi/marketing/coupon-template-issues",
];
const lotteryApis = ["GET /adminapi/lottery/list", "GET /adminapi/lottery/detail/:id", "POST /adminapi/lottery/add", "PUT /adminapi/lottery/edit/:id", "POST /adminapi/lottery/set_status/:id/:status", "DELETE /adminapi/lottery/del/:id"];
const discountApis = ["GET /adminapi/discounts/list", "GET /adminapi/discounts/info/:id", "POST /adminapi/discounts/save", "PUT /adminapi/discounts/set_status/:id/:status", "DELETE /adminapi/discounts/del/:id"];
const qrcodeApis = ["GET /adminapi/wechat_qrcode/list", "GET /adminapi/wechat_qrcode/info/:id", "POST /adminapi/wechat_qrcode/save/:id", "GET /adminapi/wechat_qrcode/statistic/:qid"];

// The route is a navigation surface. A partial target means only some destinations exist.
add("/admin/marketing/home", "partial", ["/coupon", "/activity", "/marketing/lottery", "/content/wechat-qrcode", "/marketing/recharge-options"], [],
  "新 Admin 菜单可进入优惠券、活动、抽奖、公众号渠道码和充值金额配置。",
  "旧营销宫格的促销、签到视觉配置及活动边框/背景等目的地仍缺；没有同等的营销总览。", ["view/admin-ts/src/layouts/AdminLayout.vue"]);

add("/admin/marketing/store_combination/index", "candidate", ["/activity/combinations"], [...combinationApis, "GET /adminapi/activity/combinations/export"],
  "独立拼团目录默认15条，名称/ID、phase和status分开筛选，排除is_del=1并按sort DESC,id DESC；已有详情/编辑/复制/启停/软删合同保持。price取活动主行，ot_price取当前基础商品store_product.ot_price，基础商品缺失仍保留行且划线价为空，不混SKU的ot_price。people仍是成团配置人数；count_people为k_id=0团长原始记录数，count_people_all为全部pink记录含退款/虚拟行，count_people_pink为k_id=0且status=2。新增combination_export.view独立导出，同筛选/排序，旧11列key不变，人数标题明确为开团数/参与记录数；CSV为UTF-8 BOM、完整引用和公式保护，结束时间为Asia/Shanghai。每页最多1000条，全集最多100000行/16MiB、单响应4MiB；每页同一RR READ ONLY事务内精确count与全量cells/当前基础价/pink计数/sort/xmin的SHA-256 snapshot和总CSV字节核算，后续页必须校验相同快照。全部页完成且最终行数/字节数一致才生成本地文件，取消、失败或数据变化不下载部分文件。仅导出角色可使用导出而不读取目录，团记录与统计按各自权限独立跳转。",
  combinationReadRemaining + " 新导出为浏览器本地CSV，保持旧11列操作语义而非Excel二进制格式；phase/status分离保持新合同，不把隐藏项强制归为日期已结束。目录只读新增价格/计数，不改既有创建、SKU快照、额度或历史写身份。",
  [...combinationEvidence, "view/admin-ts/src/api/combinationStatistics.ts", "view/admin-ts/src/utils/combinationCsv.ts",
    "workers-ts/src/controllers/api/v1/AdminCombinationStatisticsController.ts", "workers-ts/src/services/admin/AdminCombinationExportService.ts",
    "workers-ts/test/admin-combination-export.test.ts", "workers-ts/test/admin-combination-statistics-http.test.ts",
    "workers-ts/test/admin-combination-statistics-postgres.test.ts", "workers-ts/test/admin-combination-statistics-frontend.test.ts",
    "cinashop-php/app/services/other/export/ExportServices.php"]);
add("/admin/marketing/store_combination/combina_list", "candidate", ["/activity/combination-groups"], combinationGroupApis,
  "独立全局团目录使用combination_group.view；两卡分别为COUNT(全部pink)与COUNT(k_id=0 AND status=2)，不随列表筛选变化。团列表仅k_id=0，上海日历半开日期范围、团状态、昵称/UID/关联手机号/活动查询，默认15条且独立count，按add_time DESC,id DESC稳定分页。参与记录、当前非退款且uid>0非虚拟记录、虚拟补员分别展示，不冒充付款资格。过期raw status=1仅标pending待结算，GET不执行到期结算或提前推断成败。成员按pink团长ID、同活动且所选团长OR未退款子行分页；退款旧团长、虚拟uid0、注销/缺用户、软删/缺活动和历史cid=0均保留issues，固定活动scope仍须正ID且不得跨活动。订单关联须type3/activity/uid/pink关系及已填写双身份键同时一致，重复匹配、无效关系或删除订单禁用详情；使用业务order_id而非数据库id/key跳转且另验order.view。旧团长晋升后不合并新团，无法证明的replacement为空；头像不签名私有媒体。",
  combinationReadRemaining,
  combinationReadEvidence);
add("/admin/marketing/store_combination/create/:id?/:copy?", "candidate", ["/activity/combinations"], combinationApis,
  "专用完整单来源创建/原位编辑/复制流程，分类含子类和平台单标签筛选，完整source成功后原子替换草稿；编辑与复制锁定来源，复制清活动/SKU身份和已消耗量，按配置总额度预填。名称/简介/单位、多图最多10张、上海起止时间、时效/限购/成团人数/虚拟阈值、分享热门推荐/退款、配送/邮费及所属方模板、SKU图片/拼团价/总额度和只读成本/日常价/库存/重量/体积/编码、富文本与HTML源码齐全。历史SKU身份/退役保持，总额度不能低于已消耗，批量更新先完整验证再原子写草稿；gallery沿attachment独立权限。UUID/revision、会话ABA/迟到取消和未知结果仅GET重读。",
  "本机原生受限角色与实际装配HTTP及生命周期去重155项、既有回归485项、前端39项和CUA合成浏览器已分别验收；155项来自7文件135项通过与修订迁移20项独立终态，旧失败迁移批次不重复计数。虚拟到期成团、成团成功通知、退款/物流/买方配置快照有独立原生证据，开团/参团成功通知不在该证据范围；富文本DOM清理、签名还原与390宽布局有实际浏览器证据。真实配置/角色/provider、完整公共媒体/R2验收、真实设备、完整Linux CI及发布仍开放；合成验收不等于生产验收。全局团记录、独立统计与目录导出由独立只读合同承接，本条不扩充旧生命周期证据。",
  combinationEvidence);
add("/admin/marketing/store_combination/statistics/:id?", "candidate", ["/activity/combination-statistics/:id?"], combinationStatisticsApis,
  "独立可选活动ID统计页使用combination_statistics.view，缺ID时提供选择入口，坏ID/不存在活动拒绝，软删活动保留历史。PHP六卡精确保持：people_count=COUNT(DISTINCT pink.uid)含uid0，spread_count=COUNT(DISTINCT uid WHERE k_id>0)是参团不同UID而非推广归因；start_count为k_id=0原始团长数，success_count再限status=2；pay_price为type=3 AND paid=1 AND pid IN(0,-1)的活动订单SUM(pay_price)十进制字符串，pay_count按同集合DISTINCT uid。支付毛额含后续退款和已删除主单，排除未支付/拆单子单，不能用pink/cart/refund多表联接放大金额。参与团/活动订单两个页签各自15条分页，list/count同完整谓词，状态/名称/手机号/UID/地址/商品与活动搜索使用EXISTS防放大；订单status=0恒为空以保持paid roots。团状态保留raw并将过期1标pending；独立活动scoped成员路由校验活动ID、双订单身份与历史issues，虚拟/删除/缺失订单不得伪造详情链接。汇总、列表、成员可分别失败重试，会话ABA/迟到响应失效；每个响应为有界RR READ ONLY快照、5/2/5秒事务局部期限和private no-store，不触发任何交易消费者。",
  combinationReadRemaining + " 旧源码没有独立图表控件，本页恢复六卡/两页签/成员与订单语义，不以新增图表充抵合同；各响应独立读取，不声称跨汇总与列表请求共享数据库快照。",
  combinationReadEvidence);

add("/admin/marketing/store_coupon/index", "candidate", ["/marketing/coupon-templates"], couponTemplateApis,
  "独立模板目录恢复名称/精确ID与状态筛选、默认15条分页、sort DESC,id DESC和is_del=0，展示范围/面额/门槛/领后有效天数/排序/状态。模板仅创建、立即失效、删除和发布，无编辑/重新启用；旧image字段是商品选择对象，不是素材封面。通用、单品类、指定商品三范围独立校验，分类含完整祖先可见性，选品跨页保留且最多100项/500字符，应用去重校验并排序成规范CSV，创建/发布持范围锁重验。新增store_coupon_template与store_coupon_template_issue两实体；proof关联是归属权威，issue.cid仅兼容，不认领历史孤儿cid；商品关系coupon_id只写新issue.id。发布复制金额/天数/范围到独立发行，普通receive_type=1、新人=2、赠送=3，限量正数或不限量0，领用窗口成对UTC并由上海输入转换，每人限领1。新模板普通手动券为receive_type=1/category=0/app_type=0；本批公共手领取消仅category0限制，另兼容已证明的历史普通category=1，仍拒绝会员/受限渠道及非手领用途；立即失效仅将proof关联发行status=-1，删除仅模板is_del=1，保留已领/已占券、范围与订单。五读取为有界REPEATABLE READ READ ONLY及5/2/5秒期限，private no-store；写入READ COMMITTED、源行锁、revision、actor+UUID+内容摘要与原子审计，发布重放复核proof.sourceRevision。发布同时要求coupon_template_issue.manage和coupon_template.view；仅发布角色稳定页面显示无查看权限；换号过渡GET仍由服务器拒绝并丢弃旧上下文响应。会话ABA/跨tab与迟到响应失效；未知写保留原UUID/body并阻止新写，只GET核对后经人工确认解除。",
  "本机业务55项唯一通过、旧消费者381项唯一通过，均按完整文件替换去重而非单批全绿；结构批59含27项PGlite/静态和32项原生，九路径281表/228序列及零结构差异，页面41、权限28、台账93、类型/构建和最终dist合成浏览器均通过。旧允许面额0/有效日0，新严格面额>0且有效日1..3650；默认状态为有效，旧列表默认全部。DB约束范围形状/正int32/容量，CSV规范排序去重由应用保证。proof.sourceRevision固定来源，不禁止既有发行管理独立编辑；不把新模板页抵作旧发行列表/编辑页或优惠券配置页。新人仍需register_give_coupon等配置，赠送仍需明确渠道；用途flag/full_reduction不代表自动满赠或关注投递闭合。未知结果人工确认仅清本地状态，不是服务端回执，错误确认后新UUID可能重复发行，刷新/退出不保存恢复队列。两表外部0169/内嵌0175与显式窄权限升级不自动应用线上，不认领旧store_coupon或任意cid。完整Linux CI、真实配置/角色、真实设备/渠道与发布继续开放。",
  ["cinashop-php/app/controller/admin/v1/marketing/coupon/StoreCoupon.php", "cinashop-php/app/services/activity/coupon/StoreCouponServices.php",
    "cinashop-php/app/dao/activity/coupon/StoreCouponDao.php", "view/admin-ts/src/api/couponTemplate.ts",
    "workers-ts/src/controllers/api/v1/AdminCouponTemplateController.ts", "workers-ts/src/services/admin/AdminCouponTemplateInput.ts",
    "workers-ts/src/services/admin/AdminCouponTemplateService.ts", "workers-ts/src/models/schema/coupon_templates.ts",
    "workers-ts/src/migrations/couponTemplateCatalog.ts", "workers-ts/migrations/0169_coupon_template_catalog.sql",
    "workers-ts/src/migrations/runCouponTemplateRuntimeUpgrade.ts", "workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts",
    "workers-ts/src/services/activity/ActivityService.ts", "workers-ts/src/services/activity/StoreNewcomerService.ts",
    "workers-ts/src/services/activity/ProductCouponService.ts", "workers-ts/src/services/order/CheckoutCouponTemplateAuthority.ts",
    "workers-ts/test/admin-coupon-template.test.ts", "workers-ts/test/admin-coupon-template-postgres.test.ts",
    "workers-ts/test/admin-coupon-template-http.test.ts", "workers-ts/test/coupon-manual-claim.test.ts",
    "workers-ts/test/coupon-template-catalog.test.ts", "workers-ts/test/runtime-coupon-template-privileges.test.ts",
    "workers-ts/test/admin-coupon-templates-frontend.test.ts", "workers-ts/docs/admin-coupon-template-contract.md",
    "workers-ts/audit/coupon-template-native-20260927.json", "workers-ts/audit/coupon-template-browser-20260927.json"]);
add("/admin/marketing/store_coupon_issue/index", "candidate", ["/coupon"], couponIssueCatalogApis,
  "专用发行目录以is_del=0过滤、id DESC排序、15条分页和同快照独立count恢复名称/精确ID、优惠类型、领取方式与状态筛选；UI默认全部，API省略状态仍默认1，名称中的%/_作为literal搜索。列表超过100条可继续分页，limit<=100/offset<=10000超界明确拒绝。六种读取采用有界REPEATABLE READ READ ONLY、5/2/5秒期限与private no-store，读取失败独立重试。金额/折扣、四范围、普通/会员、领取与使用时间、发行/剩余、规则、排序和proof来源详情明确；历史长标题、未知smallint、异常定义与扩展年份可诊断展示，不要求每条可复制。仅coupon.view不能写；领取记录另需coupon_record.view，精确issue_id且普通券读取store_coupon_issue_user、会员category=2读取store_coupon_user，禁止两表互join，保留重复、null/负UID、缺失及注销用户，头像只允许公共预览。未删除发行允许status=-1独立改0/1，确认说明不恢复源模板；开启校验真实历史定义与范围。软删除只写isDel=1/status=-1，保留scope、store_product_coupon赠券配置、proof、已领/已占券、计数与订单，未来发放由isDel拒绝。revision排除remainCount/xmin/领取历史，但绑定经济字段、范围与proof；READ COMMITTED、发行行锁、actor+UUID+内容指纹和原子system_log回执防重复执行，范围SHARE NOWAIT避免反向锁等待，不持发行锁等待源模板。会话ABA/跨tab/确认与迟到响应失效，未知写保留原UUID/body/商品集合，只GET核对且人工ack不再写入。",
  couponIssueRemaining,
  couponIssueEvidence);
add("/admin/marketing/store_coupon_issue/create/:id?", "candidate", ["/coupon"], couponIssueCreateApis,
  "旧绑定表单恢复为新建与复制为独立发行，无原位经济编辑。面额/折扣、标题、普通category=0/会员category=2、手领/后台发、通用/品类/商品/品牌四范围、门槛、领后1..3650天或固定使用区间、领取窗口、限量正数/不限量0、纯文本规则与启用齐全；sort随复制保留，新建默认0而不虚构旧排序控件。新输入折扣使用1..100整数百分数，85表示8.5折；历史小数可原值复制并明确85.99按85%结算，API仍保留真实十进制合同。新人2/会员发放4仅在相应历史复制用途保留，新人强制不限量，不宣称自动发放已配置。上海日期转换精确UTC，两组起止成对且结束晚于开始。分类与品牌完整可见祖先有界校验、品牌限storeId0；商品跨页完整选择最多100项/CSV500字符，5000项选项上限拒截断，缺失/隐藏/删除或歧义范围不得悄悄复制。copy_input仅提供可完整表达的定义，历史category1映射普通0、status=-1草稿为0；app_type非0返回copy_input=null及明确诊断，POST复制也拒绝降级受众。source_id/source_revision绑定同事务源行锁与版本，复制草稿可明确修改，新发行cid=0/appType=0/receiveLimit=1、无proof/赠送flags，库存从新发行量初始化，不继承旧身份、来源凭证、自动配置、已消耗库存或领取历史。普通手动领取receive_type=1/app_type=0，兼容已证明的历史普通category=1并保留新普通0；会员2、受限appType及receive_type=0/2/3/4仍不能通过公共手领。",
  couponIssueRemaining,
  couponIssueEvidence);
add("/admin/marketing/discount/list", "missing", [], [], "", "旧促销总目录含独立规则列表和状态动作，新 Admin 没有促销规则页面或对应操作合同。");
add("/admin/marketing/discount/give", "missing", [], [], "", "旧满送列表管理赠品/赠券规则，新 Admin 没有该规则目录。");
add("/admin/marketing/discount/add_give/:id?", "missing", [], [], "", "旧满送编辑页的门槛、赠品/赠券和适用范围没有 Admin 写入表单。");
add("/admin/marketing/discount/full_discount", "missing", [], [], "", "旧满减规则目录和状态管理没有 Admin 页面。");
add("/admin/marketing/discount/add_discount/:id?", "missing", [], [], "", "旧满减规则创建/编辑的阶梯门槛和范围没有 Admin 写入表单。");
add("/admin/marketing/discount/add/:id?", "missing", [], [], "", "旧单品折扣编辑页的商品/会员/标签范围没有 Admin 写入表单。");
add("/admin/marketing/discount/pieces_discount", "missing", [], [], "", "旧多件折扣目录没有 Admin 页面或状态操作面。");
add("/admin/marketing/discount/add_pieces/:id?", "missing", [], [], "", "旧多件折扣门槛、折扣和商品范围编辑流程没有 Admin 页面。");
add("/admin/marketing/store_coupon_user/index", "candidate", ["/marketing/coupon-records"], ["GET /adminapi/marketing/coupon-records/list"],
  "独立只读领取记录页按状态、领取人和优惠券名筛选，按 ID 倒序每页 15 条展示旧页十项数据；GET 接口只读取 store_coupon_user 领取实例。",
  "仅完成本地代码映射；真实历史领取记录、受限角色及发布后流程仍待验收。",
  ["cinashop-php/app/services/activity/coupon/StoreCouponUserServices.php", "cinashop-php/app/dao/activity/coupon/StoreCouponUserDao.php",
    "workers-ts/src/services/admin/AdminCouponRecordService.ts", "workers-ts/scripts/data-migration/manifest.ts", "workers-ts/test/admin-coupon-records.test.ts"]);
add("/admin/marketing/coupon/system_config/:type?/:tab_id?", "missing", [], [], "", "旧优惠券动态配置表单没有逐键核验的新专页；不能借 /coupon 的发行列表推定配置已覆盖。");

add("/admin/marketing/store_bargain/index", "partial", ["/activity"], ["GET /adminapi/activity/bargain", ...activityWrite],
  "砍价 tab 可按名称和启停状态筛选、每页20条浏览并显示总数，超过100条可继续翻页；只读角色可浏览，管理角色可编辑、启停和删除。",
  "旧活动时间状态筛选、复制和导出尚未补齐，活动配置和参与统计仍需专门对照；旧默认每页15条，新目录20条。",
  ["workers-ts/src/services/admin/AdminActivityListService.ts", "workers-ts/test/admin-activity-list.test.ts"]);
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
  "秒杀 tab 可按名称和启停状态筛选、每页20条浏览并显示总数，按 sort/id 倒序；管理角色可做基础编辑、状态和删除，统计由独立权限进入。",
  "旧活动时间状态筛选、复制、导出和时段关系仍未完整恢复，新建未选择时段时默认 timeId='1'；旧默认每页15条，新目录20条，名称查询不等同旧全部搜索口径。",
  ["workers-ts/src/services/admin/AdminActivityListService.ts", "workers-ts/test/admin-activity-list.test.ts", "cinashop-php/app/controller/admin/v1/marketing/seckill/StoreSeckill.php"]);
add("/admin/marketing/store_seckill/list", "candidate", ["/activity/seckill-activities"], seckillParentApis,
  "独立 store_activity(type=1) 父目录恢复名称/精确ID、日期阶段、开启状态及15条分页；展示日期、多场次、参与商品数并进入详情、原位编辑和复制预填。显式启停原子级联全部子商品并提示重开行为，删除原子软删除父/子；独立权限、revision/request_id和审计保持订单/SKU身份。受限app排期行锁和Admin父写权限分别经固定维护forward及真实LOGIN验收。",
  "本地候选未发布；真实配置/角色、完整Linux CI及发布后流程仍待验收。完整创建页已补分类/标签选品、跨页多选、跨商品批量及SKU图片，独立create条目列为本地candidate；父控制器可收取的适用门店不是旧页已提供控件。旧重复PHP动态API不因此恢复。",
  ["workers-ts/docs/admin-seckill-parent-contract.md", "workers-ts/src/services/admin/AdminSeckillActivityService.ts",
    "workers-ts/test/admin-seckill-activity.test.ts", "workers-ts/test/admin-seckill-activity-postgres.test.ts",
    "workers-ts/test/seckill-runtime-login.test.ts", "workers-ts/docs/seckill-runtime-privileges.md"]);
add("/admin/marketing/store_seckill_data/index", "candidate", ["/activity/seckill-times"], [
  "GET /adminapi/activity/seckill-times", "GET /adminapi/activity/seckill-times/:id",
  "POST /adminapi/activity/seckill-times", "PUT /adminapi/activity/seckill-times/:id",
  "PUT /adminapi/activity/seckill-times/:id/status", "DELETE /adminapi/activity/seckill-times/:id",
],
  "独立页管理 store_seckill_time 的标题、起止时间、平台图片、描述和显隐，提供名称/状态查询、20条分页与添加编辑删除；独立权限、revision/request_id及原子审计保护写入。兼容旧HHmm读取，新写HH:mm，上海日内时段允许相邻端点，重叠检查包含隐藏项；删除同时保护未结束父/子ID引用及旧父活动时间对，包含结束当天、未来和隐藏引用。损坏时段可逐项修为合法隐藏，再启用；图库保持独立附件权限，保存稳定引用并签名展示。",
  "仅完成本地候选；真实角色、素材配置、全量Linux CI及发布后流程仍待验收。旧动态表单URL不因此恢复；父活动目录和已补齐五项旧交互的完整创建页由独立父页面承接，分别列为本地candidate。",
  ["cinashop-php/app/services/activity/seckill/StoreSeckillTimeServices.php", "cinashop-php/app/dao/activity/seckill/StoreSeckillTimeDao.php",
    "workers-ts/src/services/admin/AdminSeckillTimeService.ts", "workers-ts/src/controllers/api/v1/AdminSeckillTimeController.ts",
    "workers-ts/src/services/activity/SeckillScheduleService.ts", "workers-ts/src/models/schema/activity.ts"]);
add("/admin/marketing/store_seckill/create/:id?/:copy?", "candidate", ["/activity/seckill-activities"], seckillParentApis,
  "独立双页签表单恢复上海日期、多场次、限购、氛围图、多个商品和SKU参与/价格/总额度，成本价和划线价只读；服务端继承来源及配送，原位编辑保留子/SKU身份、销量和已消耗额度。复制先读取当前剩余额度预填，再POST新身份；退休移除保留订单/退款引用。分类级联含子分类与商品标签筛选、跨页多选一次添加、跨商品批量价格/总额度与确认移除、选品商品类型/分类列及SKU自身图片均已恢复；逐源权威详情读齐后原子加入本地表单，批量设置先整批校验已消耗额度下限，移除保持历史身份且不复活退休规格。分类列以所属方范围内去重名称展示，与旧父/子路径格式的显示差异单独记录。图片保留稳定引用，按来源或已存子商品所属平台/供应商校验后签名预览；同一图片策略补公开秒杀列表主图签名，仅证明该列表响应。真实Admin/app购买、编辑、关闭及取消恢复均经原生验证。",
  "本地候选未发布；真实配置/角色、生产素材、完整Linux CI及发布验收继续开放。公开秒杀列表主图的本地签名不等于详情、订单快照及完整商品媒体合同验收，旧动态表单API未注册。",
  ["workers-ts/docs/admin-seckill-parent-contract.md", "workers-ts/src/services/admin/AdminSeckillActivityService.ts",
    "workers-ts/src/services/admin/AdminSeckillActivityData.ts", "workers-ts/src/services/admin/AdminSeckillActivityInput.ts",
    "workers-ts/src/services/activity/ProductAssetPolicy.ts", "workers-ts/src/services/activity/ActivityService.ts",
    "workers-ts/test/admin-seckill-activity.test.ts", "workers-ts/test/admin-seckill-activity-postgres.test.ts",
    "workers-ts/test/admin-seckill-activities-frontend.test.ts", "workers-ts/test/seckill-product-media.test.ts",
    "workers-ts/test/seckill-runtime-login.test.ts", "view/admin-ts/src/api/seckillActivity.ts"]);
add("/admin/marketing/store_seckill/statistics/:id?", "candidate", ["/activity/seckill-statistics/:id?"], [
  "GET /adminapi/activity/seckill-statistics/:id/head",
  "GET /adminapi/activity/seckill-statistics/:id/people",
  "GET /adminapi/activity/seckill-statistics/:id/orders",
],
  "独立只读页恢复旧四卡、参与人聚合、订单列表、搜索、状态和15条分页；独立 seckill_statistics.view 权限保护包含个人信息的三组 GET。订单列表和总数均按已支付主单，修正旧页总数筛选不一致；pay_rate 明确标为剩余额度/展示总额度。",
  "订单 tab 的搜索仅覆盖订单快照中的订单号/姓名/电话/UID，未包含旧通用 StoreOrderDao 通过用户、地址、商品及活动标题进行的隐式关联搜索；参与人 tab 仍仅查订单姓名/电话/UID。真实历史订单、受限角色与发布后流程仍待验收。",
  ["cinashop-php/app/services/activity/seckill/StoreSeckillServices.php", "cinashop-php/app/dao/order/StoreOrderDao.php",
    "workers-ts/src/services/admin/AdminSeckillStatisticsService.ts", "view/admin-ts/src/api/seckillStatistics.ts",
    "workers-ts/test/admin-seckill-statistics.test.ts"]);

add("/admin/marketing/user_point/index", "partial", ["/marketing/user-point"],
  ["GET /adminapi/marketing/user-point/logs", "GET /adminapi/marketing/user-point/statistics"],
  "新页按用户 ID/标题、时间及可选精确类型读取分页积分流水，展示同条件的四项统计；旧页有用户 ID/标题和时间筛选，但统计卡在初始化时单独加载，不随筛选刷新。",
  "旧页由 export-userPoint 授权的积分日志导出按钮及逐页 Excel 导出流程未恢复；真实历史流水、受限角色和发布后行为仍待验收。",
  ["cinashop-php/app/services/user/UserBillServices.php", "cinashop-php/app/controller/admin/v1/other/export/ExportExcel.php"]);
add("/admin/marketing/integral/signIn", "missing", [], [], "", "旧积分签到视觉和 sign_day_num 组合数据配置没有新 Admin 编辑页；旧 PHP 与 Worker 当前签到消费者均读取 sign_mode、基础积分及 system_sign_reward，不消费这组旧7天配置，不能把现有签到奖励页当成等价替代。");
add("/admin/marketing/point_statistic", "candidate", ["/marketing/point-statistic"], [
  "GET /adminapi/marketing/point/get_basic",
  "GET /adminapi/marketing/point/get_trend",
  "GET /adminapi/marketing/point/get_channel",
  "GET /adminapi/marketing/point/get_type",
],
"独立只读页按上海日期范围展示当前/累计/消耗积分、积累与消耗趋势及五类来源/消耗分布；沿用旧 gain 双标签及退款退回分类，按 point_statistic.view 独立授权。",
"仅完成本地代码候选；旧 gain 无历史来源判别，3日趋势采用完整聚合而非 PHP 漏日抽样；真实历史数据、受限角色及发布后流程待验收。",
["cinashop-php/app/services/activity/integral/UserPointServices.php", "workers-ts/src/services/admin/AdminPointStatisticService.ts", "workers-ts/test/admin-point-statistic.test.ts"]);
add("/admin/marketing/integral/classify", "candidate", ["/marketing/integral-categories"], [
  "GET /adminapi/marketing/integral-categories", "GET /adminapi/marketing/integral-categories/:id",
  "POST /adminapi/marketing/integral-categories", "PUT /adminapi/marketing/integral-categories/:id",
  "PUT /adminapi/marketing/integral-categories/:id/status", "DELETE /adminapi/marketing/integral-categories/:id",
],
"独立权限页管理 category 表 group=5 的平面积分区间，保留名称/ID和显隐筛选、15条分页、名称/最低积分/最高积分/状态/排序、添加编辑显隐删除；新写合同使用request_id和材料revision，事务内审计及组内串行校验防止同名和闭区间重叠。公开消费者仍输出label/value=min-max，无商品分类ID绑定。",
"仅本地候选，生产范围数据与真实受限角色、完整Linux CI及发布后商城过滤仍待验；新REST不声称恢复旧7条动态表单API。相交判断补齐旧PHP漏掉的完全包围范围，隐藏项同样参与冲突校验；可见项上限1000保护现有公开消费者。名称以PostgreSQL lower判重，常见大小写同名拒绝，但不声称完整复刻MySQL utf8mb4_unicode_ci的重音/Unicode折叠规则。",
["cinashop-php/app/controller/admin/v1/marketing/integral/StoreIntegralCategory.php", "cinashop-php/app/services/activity/integral/StoreIntegralCategoryServices.php", "workers-ts/src/services/activity/ActivityService.ts", "workers-ts/src/services/admin/AdminIntegralCategoryService.ts", "workers-ts/test/admin-integral-category.test.ts", "workers-ts/test/admin-integral-category-postgres.test.ts", "workers-ts/test/admin-integral-categories-frontend.test.ts"]);
add("/admin/marketing/balance_recharge", "candidate", ["/marketing/recharge-options"], [
  "GET /adminapi/marketing/recharge-quotas", "GET /adminapi/marketing/recharge-quotas/:id",
  "POST /adminapi/marketing/recharge-quotas", "PUT /adminapi/marketing/recharge-quotas/:id",
  "PUT /adminapi/marketing/recharge-quotas/:id/status", "DELETE /adminapi/marketing/recharge-quotas/:id",
],
"独立权限页按 user_recharge_quota 动态解析组合组，恢复金额、赠送金额、排序、显隐四字段及添加编辑删除和启用档位预览，按sort/id倒序。新写合同使用request_id和revision、事务内审计及组内锁；套餐选择和订单金额快照同事务，后台更价/下架/删除不改变既有充值订单。正式外部0166/内嵌0172仅在缺组时初始化空元数据与一条迁移审计，保留已有唯一组及业务行，拒绝重复组或新gid认领孤儿档位。",
"仅本地候选，已有数据库须通过维护连接单独执行固定forward runner，不能重跑全量runAll；真实档位配置/受限角色、完整Linux CI及实际充值渠道验收仍待完成。新REST不恢复任意group_data动态表单。总20条仅限制新增，修复旧满20也禁止编辑的行为；金额0.01至100000元沿用Worker购买上限，赠送0至99999999.99元。预览采用新Admin样式，不复刻旧主题手机图或承诺旧固定充值政策文案；旁边setup_recharge辅助设置不属于此页。",
["cinashop-php/view/admin/src/pages/marketing/recharge/index.vue", "cinashop-php/app/services/user/UserRechargeServices.php", "workers-ts/src/services/user/UserFinanceService.ts", "workers-ts/src/services/admin/AdminRechargeQuotaService.ts", "workers-ts/src/services/payment/RechargeQuotaPolicy.ts", "workers-ts/migrations/0166_recharge_quota_group_seed.sql", "workers-ts/src/migrations/runRechargeQuotaGroupSeed.ts", "workers-ts/test/recharge-quota-group-seed.test.ts", "workers-ts/test/recharge-quota-seed-flow.test.ts", "workers-ts/test/recharge-quota-seed-upgrade.test.ts", "workers-ts/test/admin-recharge-quota.test.ts", "workers-ts/test/admin-recharge-quota-postgres.test.ts", "workers-ts/test/admin-recharge-options-frontend.test.ts"]);

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
  "积分商城 tab 可按名称和启停状态筛选、每页20条浏览并显示总数，按 sort/id 倒序；管理角色可做基础编辑、启停和删除。",
  "旧全部筛选、复制和旧商品字段仍缺；旧默认每页15条，新目录20条，名称查询不等同旧全部搜索口径。",
  ["workers-ts/src/services/admin/AdminActivityListService.ts", "workers-ts/test/admin-activity-list.test.ts", "cinashop-php/app/controller/admin/v1/marketing/integral/StoreIntegral.php"]);
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
add("/admin/marketing/sign_rewards", "candidate", ["/marketing/sign-rewards"], [
  "GET /adminapi/setting/sign/rewards", "GET /adminapi/setting/sign/add_rewards",
  "GET /adminapi/setting/sign/edit_rewards/:id", "POST /adminapi/setting/sign/save_rewards/:id",
  "DELETE /adminapi/setting/sign/del_rewards/:id",
],
  "新 Admin 以连续/累积两个页签按天数展示积分与经验，支持每页15条、添加、编辑和确认删除；表单天数上限来自旧服务配置，权限沿用 config.view/manage。",
  "仅完成本地候选；生产非空签到规则、受限角色正反权限、真实签到奖励和发布后浏览器验收仍待完成。",
  ["view/admin-ts/src/api/signRewards.ts", "workers-ts/src/services/system/SystemSignRewardService.ts",
    "workers-ts/test/admin-sign-rewards-frontend.test.ts"]);

if (lotteryFollowup) {
  reviews["/admin/marketing/lottery/index"] = {
    ...reviews["/admin/marketing/lottery/index"],
    status: "candidate",
    covered: ["独立抽奖目录恢复旧每页15条、名称或ID/参与条件/启停/未开始-进行中-已结束筛选及参与次数/去重人数/去重中奖人数三统计；管理角色可编辑、启停和删除，记录入口使用独立查看权限。不限期活动阶段筛选修正旧已结束条件重叠异常；中奖人数按 type>1 计，修正旧 PHP 数值键数组并集吞掉该筛选的缺陷。"],
    remaining: ["仅本地候选；生产历史活动、三统计口径及受限角色/发布后操作尚待验收。旧复制按钮指向的创建页未读取 copy 参数，此无效旧操作不计迁移合同；旧阶段筛选把不限期活动同时列入进行中与已结束，新实现改为互斥。旧中奖人数值还因 PHP 数组并集缺陷可能等于全部参与人数，不宣称字节等价。"],
    evidence: ["view/admin-ts/src/api/lottery.ts", "workers-ts/src/services/activity/LotteryAdminService.ts", "workers-ts/test/admin-lottery-read-contract.test.ts"],
  };
  reviews["/admin/marketing/lottery/recording_list"] = {
    ...reviews["/admin/marketing/lottery/recording_list"],
    status: "candidate",
    targetScreens: ["/marketing/lottery-records"],
    targetApis: ["GET /adminapi/lottery/record/list", "GET /adminapi/lottery/record/list/:id", "GET /adminapi/lottery/record/detail/:id", "POST /adminapi/lottery/record/deliver"],
    covered: ["独立记录页恢复活动/参与条件/奖品类型/用户关键词/中奖时间及处理状态筛选、15条稳定分页和备注/实物发货；只读角色仅见昵称、UID与奖品快照，物流预填只经管理详情接口取得。"],
    remaining: ["仅本地候选；生产孤儿记录、历史奖品类型、只读角色和实际发货流程尚待验收。旧页面收货资料弹窗已被注释，新页不展示地址/电话；发货接口不依赖后台读取收货资料。"],
    evidence: ["view/admin-ts/src/api/lottery.ts", "workers-ts/src/services/activity/LotteryAdminService.ts", "workers-ts/test/admin-lottery-read-contract.test.ts"],
  };
}
if (userPointFollowup) {
  reviews["/admin/marketing/user_point/index"] = {
    ...reviews["/admin/marketing/user_point/index"],
    status: "candidate",
    targetApis: ["GET /adminapi/marketing/user-point/logs", "GET /adminapi/marketing/user-point/statistics", "GET /adminapi/marketing/user-point/export"],
    covered: ["独立积分流水页按旧每页15条展示用户ID/标题与时间筛选、分页流水和四项统计；导出按钮另需 integral_log.export 且页面查看仍需 integral_log.view。导出沿用同一筛选和旧编号、标题、变动后积分、积分变动、备注、用户微信昵称、添加时间七列，按ID稳定排序逐页取得完整结果。每页检验全量快照、行数与CSV字节数，仅完整下载，变化或取消均不生成部分文件；CSV提供公式保护、UTF-8 BOM、100000行/16MiB全集上限。"],
    remaining: ["仅本地候选；新版生成 Excel 可打开的 CSV，而旧页面调用 Excel 导出工具生成 XLSX，文件格式不同。新版四项统计随筛选刷新，旧页只在初始化读取，是有意交互差异。真实历史流水、受限角色、生产规模和发布后下载仍待验收。"],
    evidence: ["cinashop-php/view/admin/src/pages/marketing/userPoint/index.vue", "cinashop-php/app/controller/admin/v1/other/export/ExportExcel.php", "view/admin-ts/src/api/integralLog.ts", "view/admin-ts/src/api/integralLogExport.ts", "workers-ts/src/services/admin/AdminIntegralLogService.ts", "workers-ts/src/services/admin/AdminIntegralLogExportService.ts", "workers-ts/src/controllers/api/v1/AdminIntegralLogController.ts", "workers-ts/test/admin-integral-log-export.test.ts", "workers-ts/test/admin-integral-log-export-http.test.ts", "workers-ts/test/admin-integral-log-frontend.test.ts"],
  };
}
if (activityFrameFollowup) {
  const frameApis = [
    "GET /adminapi/marketing/activity-frame",
    "GET /adminapi/marketing/activity-frame/products",
    "GET /adminapi/marketing/activity-frame/brands",
    "GET /adminapi/marketing/activity-frame/labels",
    "GET /adminapi/marketing/activity-frame/:id",
    "POST /adminapi/marketing/activity-frame",
    "PUT /adminapi/marketing/activity-frame/:id",
    "PATCH /adminapi/marketing/activity-frame/:id/status",
    "DELETE /adminapi/marketing/activity-frame/:id",
  ];
  reviews["/admin/marketing/activity_frame"] = {
    status: "candidate", targetScreens: ["/marketing/activity-frame"], targetApis: frameApis,
    covered: ["独立活动边框目录恢复名称/ID、活动阶段、活动及创建时间筛选、15条分页、参与商品数、启停和确认删除；查看与管理由 activity_frame.view/manage 独立授权。商品列表和推荐列表返回命中的 activity_frame 图片槽位。"],
    remaining: ["仅本地候选；未注册旧 PHP 动态 URL，真实历史活动、选品规模、受限角色与发布后前台显示仍待验收。新写入以 UUID 请求标识及材料版本做幂等/冲突检查。"],
    evidence: ["workers-ts/src/services/admin/AdminActivityFrameService.ts", "workers-ts/src/controllers/api/v1/AdminActivityFrameController.ts", "view/admin-ts/src/api/activityFrame.ts", "view/admin-ts/test/activityFrame.test.ts", "workers-ts/src/services/product/StoreProductService.ts", "workers-ts/test/admin-activity-frame.test.ts", "workers-ts/test/public-product-catalog-promotion-slots.test.ts", "workers-ts/test/public-product-activity-promotion-scope.test.ts"],
  };
  reviews["/admin/marketing/activity_frame/create/:id?"] = {
    status: "candidate", targetScreens: ["/marketing/activity-frame/create/:id?"], targetApis: frameApis,
    covered: ["独立编辑页支持名称、图片、上海活动时间、启停、排序及全商品/指定商品/品牌/标签范围；另可维护排除商品范围，选项跨页选择且编辑回显完整身份。保存后商品列表与显式 promotions_type=5 活动读取均可消费边框。"],
    remaining: ["仅本地候选；旧 UI 不提供排除商品范围，新增此选项为受控扩展，其参与商品数按实际排除结果计算，旧 PHP 对 type3 固定显示 0。图片沿用现有附件能力，不声称旧 PHP 动态表单 URL 精确匹配；生产媒体、历史范围、真实受限角色及发布验收仍待完成。"],
    evidence: ["workers-ts/src/services/admin/AdminActivityFrameService.ts", "workers-ts/src/controllers/api/v1/AdminActivityFrameController.ts", "view/admin-ts/src/api/activityFrame.ts", "view/admin-ts/test/activityFrame.test.ts", "workers-ts/src/services/product/PublicCatalogService.ts", "workers-ts/test/admin-activity-frame.test.ts", "workers-ts/test/public-product-catalog-promotion-slots.test.ts", "workers-ts/test/public-product-activity-promotion-scope.test.ts"],
  };
}

if (activityBackgroundFollowup) {
  const backgroundApis = [
    "GET /adminapi/marketing/activity-background",
    "GET /adminapi/marketing/activity-background/products",
    "GET /adminapi/marketing/activity-background/brands",
    "GET /adminapi/marketing/activity-background/labels",
    "GET /adminapi/marketing/activity-background/:id",
    "POST /adminapi/marketing/activity-background",
    "PUT /adminapi/marketing/activity-background/:id",
    "PATCH /adminapi/marketing/activity-background/:id/status",
    "DELETE /adminapi/marketing/activity-background/:id",
  ];
  const evidence = [
    "workers-ts/src/services/admin/AdminActivityBackgroundService.ts",
    "workers-ts/src/controllers/api/v1/AdminActivityBackgroundController.ts",
    "view/admin-ts/src/api/activityBackground.ts", "view/admin-ts/test/activityBackground.test.ts",
    "workers-ts/src/services/product/PublicCatalogService.ts",
    "workers-ts/src/services/activity/V2PromotionCompatibilityService.ts",
    "workers-ts/test/admin-activity-background.test.ts",
    "workers-ts/test/admin-activity-background-http.test.ts",
    "workers-ts/test/public-product-catalog-promotion-slots.test.ts",
  ];
  reviews["/admin/marketing/activity_background"] = {
    status: "candidate", targetScreens: ["/marketing/activity-background"], targetApis: backgroundApis,
    covered: ["独立背景目录恢复名称/ID、阶段、活动及创建时间筛选、15条分页、父商品参与数、启停及确认软删除。双 Admin 前缀由 activity_background.view/manage 独立授权，旧1542/1546菜单精确转换，不借边框或通用活动权限。删除同步软删同促销类型的派生子记录。"],
    remaining: ["仅本地候选；旧 PHP 动态 URL 无精确别名。旧错误按钮复用秒杀权限，现按背景能力控制；跨类型子记录不随背景删除。真实角色、数据规模、媒体与发布验收仍待完成。"],
    evidence,
  };
  reviews["/admin/marketing/activity_background/create/:id?"] = {
    status: "candidate", targetScreens: ["/marketing/activity-background/create/:id?"], targetApis: backgroundApis,
    covered: ["独立创建/编辑恢复背景图片（750×152建议）、名称、上海活动时间、开关、排序和全部/指定父商品/品牌/标签范围；跨页选择确认后采用，写入以管理员+UUID幂等及材料版本校验。普通列表、推荐与商品详情 activity_background 消费同一type6活动。"],
    remaining: ["仅本地候选；type3排除范围是旧UI没有的受控扩展，辅助关系写is_all=1且计数按实际父商品集合。保存拒绝子商品和未审核商品；生产素材、历史范围、真实角色、商品实际渲染和发布后验收仍开放。"],
    evidence,
  };
}

if (timeDiscountFollowup) {
  const discountApis = [
    "GET /adminapi/marketing/time-discounts",
    "GET /adminapi/marketing/time-discounts/products",
    "GET /adminapi/marketing/time-discounts/brands",
    "GET /adminapi/marketing/time-discounts/labels",
    "GET /adminapi/marketing/time-discounts/user-labels",
    "GET /adminapi/marketing/time-discounts/:id",
    "POST /adminapi/marketing/time-discounts",
    "PUT /adminapi/marketing/time-discounts/:id",
    "PATCH /adminapi/marketing/time-discounts/:id/status",
    "DELETE /adminapi/marketing/time-discounts/:id",
  ];
  const evidence = [
    "workers-ts/src/services/admin/AdminTimeDiscountService.ts",
    "workers-ts/src/controllers/api/v1/AdminTimeDiscountController.ts",
    "view/admin-ts/src/api/timeDiscount.ts",
    "view/admin-ts/test/timeDiscount.test.ts",
    "workers-ts/test/admin-time-discount.test.ts",
    "workers-ts/test/admin-time-discount-http.test.ts",
    "workers-ts/docs/admin-time-discount-route-contract.md",
    "workers-ts/audit/admin-time-discount-acceptance-20260930.json",
    "workers-ts/test/order-time-discount-checkout.test.ts",
    "workers-ts/test/order-promotion-paid-labels.test.ts",
    "workers-ts/test/order-promotion-ledger-split.test.ts",
    "workers-ts/test/kefu-promotion-line-projection.test.ts",
    "workers-ts/test/supplier-export-promotion-savings.test.ts",
    "workers-ts/test/supplier-picking-promotion-lines.test.ts",
  ];
  reviews["/admin/marketing/discount/list"] = {
    status: "candidate", targetScreens: ["/marketing/time-discounts"], targetApis: discountApis,
    covered: ["独立限时折扣目录恢复名称与启停筛选、15条分页、活动ID、参与商品数、实付/优惠金额、订单/客户及新老客户统计；按管理权限启停、确认软删除和进入编辑。双Admin前缀各10项接口由time_discount.view/manage独立授权，旧1394/1398菜单精确转换。", "本地真实服务合同已验证普通购物车、确认与建单、优惠叠加、跨SKU每人限购、付后标签、精确促销账本、拆单和连续退款；Kefu订单、供应商导出及配货单读取精确行额。隔离PG16八文件52/52通过，夹具清零且集群停机；桌面与390px合成浏览器API流程通过。"],
    remaining: ["旧动态PHP URL没有精确别名。旧目录复制入口跳转后的创建页未读取copy参数，不能将复制计为完成；真实受限角色、生产规模与统计对账、Linux CI、UniApp原生类型/构建及发布后验收仍开放。UniApp缺少@dcloudio/types；本地验收不等于生产完成。"],
    evidence,
  };
  reviews["/admin/marketing/discount/add/:id?"] = {
    status: "candidate", targetScreens: ["/marketing/time-discounts/create/:id?"], targetApis: discountApis,
    covered: ["独立创建/编辑恢复名称、上海秒级起止时间、整数0–100%折扣（90%即九折）、每人每商品限购、付后用户标签、优惠叠加2/3/5、启停排序及全部/指定父商品和具体SKU/品牌/商品标签范围。跨页选品保留具体SKU，编辑回显退役或物理缺失身份时禁保存；UUID请求与revision保护未知保存、启停和删除。", "本地真实服务合同验证折扣叠加、跨SKU限购、付后标签、精确促销账本、拆单和连续退款，隔离PG16八文件52/52通过；合成浏览器桌面及390px日期弹层通过。"],
    remaining: ["type3排除SKU为受控扩展，不冒充旧UI。旧复制参数在PHP创建页未生效；真实受限角色、生产规模与统计对账、Linux CI、UniApp原生类型/构建及发布后验收仍待核对。UniApp缺少@dcloudio/types；本地候选不勾Checklist。"],
    evidence,
  };
}

if (fullDiscountFollowup) {
  const apis = [
    "GET /adminapi/marketing/full-discounts",
    "GET /adminapi/marketing/full-discounts/products",
    "GET /adminapi/marketing/full-discounts/brands",
    "GET /adminapi/marketing/full-discounts/labels",
    "GET /adminapi/marketing/full-discounts/user-labels",
    "GET /adminapi/marketing/full-discounts/:id",
    "POST /adminapi/marketing/full-discounts",
    "PUT /adminapi/marketing/full-discounts/:id",
    "PATCH /adminapi/marketing/full-discounts/:id/status",
    "DELETE /adminapi/marketing/full-discounts/:id",
  ];
  const evidence = [
    "workers-ts/src/services/admin/AdminFullDiscountService.ts",
    "workers-ts/src/controllers/api/v1/AdminFullDiscountController.ts",
    "view/admin-ts/src/api/fullDiscount.ts",
    "view/admin-ts/test/fullDiscount.test.ts",
    "workers-ts/test/admin-full-discount.test.ts",
    "workers-ts/test/admin-full-discount-http.test.ts",
    "workers-ts/test/order-full-discount-checkout.test.ts",
    "workers-ts/test/order-promotion-quote.test.ts",
    "workers-ts/docs/admin-full-discount-route-contract.md",
    "workers-ts/audit/admin-full-discount-acceptance-20260930.json",
  ];
  reviews["/admin/marketing/discount/full_discount"] = {
    status: "candidate", targetScreens: ["/marketing/full-discounts"], targetApis: apis,
    covered: ["独立满减满折目录恢复名称、启停与满元/满件条件筛选、15条分页、参与商品数、规则说明和支付订单/客户/实付统计；管理者可编辑、确认启停和软删除。双Admin前缀各10项REST接口独立full_discount.view/manage，旧1396/1400菜单须精确auth/path配对。"],
    remaining: ["本地候选，旧动态PHP路径未加精确别名。真实受限角色、生产规模与统计对账、Linux CI及发布仍开放；UniApp原生类型/构建依赖未齐。"],
    evidence,
  };
  reviews["/admin/marketing/discount/add_discount/:id?"] = {
    status: "candidate", targetScreens: ["/marketing/full-discounts/create/:id?"], targetApis: apis,
    covered: ["恢复金额/件数门槛、递增多级阶梯满减或满折、单级循环满减、上海秒级时段、付后用户标签、叠加1/2/5及全部/具体父商品SKU/品牌/商品标签范围；跨页选择/取消、失效身份阻断、UUID重放与revision确认完整。普通购物车/确认/建单消费同type3配置，精确分段、账本、付款标签与拆单退款沿共享金额合同。"],
    remaining: ["排除SKU是旧UI隐藏功能的明确扩展；循环满折未在旧UI开放，新增管理仅提供循环满减。真实受限角色、生产数据、Linux/Hyperdrive及发布验收仍开放，不据本地candidate勾Checklist。"],
    evidence,
  };
}

if (nthDiscountFollowup) {
  const apis = [
    "GET /adminapi/marketing/nth-discounts",
    "GET /adminapi/marketing/nth-discounts/products",
    "GET /adminapi/marketing/nth-discounts/brands",
    "GET /adminapi/marketing/nth-discounts/labels",
    "GET /adminapi/marketing/nth-discounts/user-labels",
    "GET /adminapi/marketing/nth-discounts/:id",
    "POST /adminapi/marketing/nth-discounts",
    "PUT /adminapi/marketing/nth-discounts/:id",
    "PATCH /adminapi/marketing/nth-discounts/:id/status",
    "DELETE /adminapi/marketing/nth-discounts/:id",
  ];
  const evidence = [
    "workers-ts/src/services/admin/AdminNthDiscountService.ts",
    "workers-ts/src/controllers/api/v1/AdminNthDiscountController.ts",
    "view/admin-ts/src/api/nthDiscount.ts",
    "view/admin-ts/test/nthDiscount.test.ts",
    "workers-ts/test/admin-nth-discount.test.ts",
    "workers-ts/test/admin-nth-discount-http.test.ts",
    "workers-ts/test/order-nth-discount-checkout.test.ts",
    "workers-ts/test/order-promotion-quote.test.ts",
    "workers-ts/docs/admin-nth-discount-route-contract.md",
    "workers-ts/audit/admin-nth-discount-acceptance-20260930.json",
  ];
  reviews["/admin/marketing/discount/pieces_discount"] = {
    status: "candidate", targetScreens: ["/marketing/nth-discounts"], targetApis: apis,
    covered: ["独立第N件N折目录恢复名称、启停与第二件半价/买一送一/自定义规则筛选、15条分页、参与商品数、规则说明和支付订单/客户/实付统计；管理者可编辑、确认启停和软删除。双Admin前缀各10项REST接口独立nth_discount.view/manage，旧1397/1401菜单须精确auth/path配对。"],
    remaining: ["本地候选，旧动态PHP路径未加精确别名。真实受限角色、生产规模与统计对账、Linux CI及发布仍开放；UniApp原生类型/构建依赖未齐。"],
    evidence,
  };
  reviews["/admin/marketing/discount/add_pieces/:id?"] = {
    status: "candidate", targetScreens: ["/marketing/nth-discounts/create/:id?"], targetApis: apis,
    covered: ["恢复第二件半价(2,50)、买一送一(2,0)、自定义件数门槛1..99999999与0..100整数百分比，单根type2/threshold_type2/discount_type2；上海秒级时段、付后标签100上限、叠加1/3/5及全部/具体父商品SKU/品牌/商品标签范围。跨页选择/取消、失效身份阻断、UUID重放与revision确认完整。普通购物车/确认/建单按参与总件数达标后最便宜单件仅优惠一次，会员/叠加、精确分段与台账、付款标签、真实履约拆单及连续退款沿同一分币合同。"],
    remaining: ["排除SKU与自定义0%回显是旧UI隐藏输入的明确扩展；更多件不循环打折，第N件管理不提供type2报价未消费的每人限购能力。真实受限角色、生产数据、Linux/Hyperdrive及发布验收仍开放，不据本地candidate勾Checklist。"],
    evidence,
  };
}

if (fullGiftFollowup) {
  const apis = [
    "GET /adminapi/marketing/full-gifts", "GET /adminapi/marketing/full-gifts/products",
    "GET /adminapi/marketing/full-gifts/coupons", "GET /adminapi/marketing/full-gifts/brands",
    "GET /adminapi/marketing/full-gifts/labels", "GET /adminapi/marketing/full-gifts/user-labels",
    "GET /adminapi/marketing/full-gifts/:id", "POST /adminapi/marketing/full-gifts",
    "PUT /adminapi/marketing/full-gifts/:id", "PATCH /adminapi/marketing/full-gifts/:id/status",
    "DELETE /adminapi/marketing/full-gifts/:id",
  ];
  const evidence = [
    "workers-ts/src/services/admin/AdminFullGiftService.ts",
    "workers-ts/src/controllers/api/v1/AdminFullGiftController.ts",
    "view/admin-ts/src/api/fullGift.ts", "view/admin-ts/test/fullGift.test.ts",
    "workers-ts/test/admin-full-gift.test.ts", "workers-ts/test/admin-full-gift-http.test.ts",
    "workers-ts/docs/admin-full-gift-route-contract.md",
    "workers-ts/audit/admin-full-gift-acceptance-20260930.json",
  ];
  const remaining = ["普通购物车、确认与建单、赠品库存/池预留、未付取消、付款赠券归属及积分重放已有本地合同；仅完整未发货原单的原子退款为服务器内部候选，当前公开售后报价/创建入口统一拒绝满送。部分退款、拆单、已发货及仅剩赠品的售后权益适配仍开放，因此两屏只记partial。真实受限角色、生产统计、Linux/Hyperdrive、UniApp原生构建及发布仍开放。"];
  reviews["/admin/marketing/discount/give"] = {
    status: "partial", targetScreens: ["/marketing/full-gifts"], targetApis: apis,
    covered: ["独立满送目录提供名称/状态/金额或件数门槛筛选、15条分页、参与商品及规则描述、付款订单/客户/实付统计与编辑、确认启停/软删除；双Admin前缀各11项REST，独立full_gift.view/manage，旧1395/1399仅精确auth/path配对。"],
    remaining, evidence,
  };
  reviews["/admin/marketing/discount/add_give/:id?"] = {
    status: "partial", targetScreens: ["/marketing/full-gifts/create/:id?"], targetApis: apis,
    covered: ["恢复type4平台根、上海日期、付后标签、金额/件数门槛、最高满足阶梯或单层循环；每层可配置额外积分、赠券活动总池及具体赠品SKU总池。循环积分/赠品乘达标次数，券每活动一份；池编辑保留已用/预留与历史身份，UUID重放和revision确认。适用全部、指定父商品/SKU、品牌或商品标签；旧注释叠加/排除及无消费者的限购不开放。"],
    remaining, evidence,
  };
  if (fullGiftRefundFollowup) {
    for (const path of ["/admin/marketing/discount/give", "/admin/marketing/discount/add_give/:id?"]) {
      const review = reviews[path];
      review.covered.push("客户公开退款与Admin报价/创建/执行接通严格满送原始未发货整单，服务端锁内选择持久v2，全部购买与赠品数量、全实付、具体券实例及原赠积分均需相符。等待精确order.paid后置事件COMPLETED，报价和执行同查8组件固定退款/发票目录与所需权限；余额/渠道恢复沿同一原子finalizer，不新增履约子单。");
      review.remaining = ["部分数量或少退金额、拆单、已发货、退货验收及仅剩赠品的权益适配仍开放，因此两屏保持partial。独立受限数据库LOGIN本地验证不代替真实部署角色、付款渠道、生产统计、Linux/Hyperdrive、UniApp原生构建及发布验收。"];
      review.evidence.push("workers-ts/src/services/order/OrderPromotionGiftRefund.ts",
        "workers-ts/src/services/order/WholeOrderFullGiftRefundCatalog.ts",
        "workers-ts/src/services/order/StoreOrderRefundService.ts",
        "workers-ts/test/order-full-gift-refund-http.test.ts",
        "workers-ts/test/runtime-promotion-gift-refund.test.ts",
        "workers-ts/docs/full-gift-refund-entry.md",
        "workers-ts/audit/admin-full-gift-refund-entry-acceptance-20260930.json");
    }
  }
}

if (integralBatchFollowup) {
  reviews["/admin/marketing/store_integral/add_store_integral"] = {
    status: "candidate",
    targetScreens: ["/activity/integral-batch"],
    targetApis: [
      "GET /adminapi/activity/integral-batch/products",
      "GET /adminapi/activity/integral-batch/products/:productId",
      "POST /adminapi/activity/integral-batch",
      "GET /adminapi/activity/integral-batch/receipts/:requestId",
    ],
    covered: [
      "独立 Admin 批量页提供15条分页、分类/标签/关键词选择、跨页多商品多SKU草稿、现金/积分/正数兑换次数及规格图片编辑，保留成本/真实库存等只读字段；独立 integral_batch.view/manage 按确切旧933路径+auth或935 POST API授权，单件931及通用activity.manage不授批量管理。",
      "一个事务从可信平台/门店/供应商及有效副本的真实type0规格新建全部type4积分商品，继承配送/图片/说明/规格及履约字段，保留所有已有积分商品且创建不扣基础库存；revision拒绝过期来源，完整system_log回执、全局UUID/actor绑定和规范payload_hash支持同body重放与未知提交只读恢复。",
      "当前消费者按所选真实SKU的积分与现金判断结算，积分根摘要采用最低积分SKU及其对应现金；库存按基础商品/规格与积分商品/规格两层同步扣减。本批原生PG16共77/77通过，涵盖真实双前缀JWT/独立Admin LOGIN、来源与图片负例、克隆、原子回滚、并发、所选SKU真实兑换及一次性取消/退款恢复；前端10项单元检查、桌面/窄屏合成浏览器7组交互及Worker双TS检查已通过。",
    ],
    remaining: [
      "candidate仅表示本地代码级批量流程覆盖；本地角色与合成API浏览器通过不能外推为生产证明。生产角色/历史数据与规模、Linux CI/Hyperdrive、真实环境角色浏览器E2E、UniApp原生构建及发布仍未验收，尚未部署；旧marketing/integral/batch动态PHP URL没有新增兼容别名。",
    ],
    evidence: [
      "view/admin-ts/src/api/integralBatch.ts",
      "workers-ts/src/services/admin/AdminIntegralBatchData.ts",
      "workers-ts/src/services/admin/AdminIntegralBatchService.ts",
      "workers-ts/src/controllers/api/v1/AdminIntegralBatchController.ts",
      "workers-ts/src/controllers/api/v1/AdminCrudController.ts",
      "workers-ts/src/routes/v1/index.ts",
      "workers-ts/src/services/activity/ActivityService.ts",
      "workers-ts/src/services/activity/ActivityOrderSkuService.ts",
      "workers-ts/test/admin-integral-batch.test.ts",
      "workers-ts/test/admin-integral-batch-postgres.test.ts",
      "workers-ts/test/admin-integral-batch-http.test.ts",
      "workers-ts/test/runtime-integral-batch-privileges.test.ts",
      "workers-ts/test/helpers/integralBatchFixture.ts",
      "workers-ts/docs/admin-integral-batch.md",
      "cinashop-php/app/services/activity/integral/StoreIntegralServices.php",
      "cinashop-php/app/services/product/sku/StoreProductAttrServices.php",
      "cinashop-php/public/install/crmeb.sql",
    ],
  };
}

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
if (userPointFollowup) {
  const path = "/marketing/user-point/export";
  const v1RouteSource = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  if (!adminRouteSource.includes(`adminapiRoutes.get("${path}"`)
    || !v1RouteSource.includes(`v1Routes.get("/admin${path}"`)) {
    throw new Error("Integral-log export must be registered under both Admin prefixes");
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const pageSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/pages/marketing/IntegralLog.vue"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/integralLogExport.ts"), "utf8");
  for (const [label, source, token] of [
    ["permission", permissionSource, 'integral_log.export'],
    ["page", pageSource, 'integral_log.export'],
    ["API adapter", adapterSource, path],
  ]) {
    if (!source.includes(token)) throw new Error(`Integral-log export ${label} evidence missing`);
  }
  for (const file of ["workers-ts/src/services/admin/AdminIntegralLogExportService.ts",
    "workers-ts/src/controllers/api/v1/AdminIntegralLogController.ts",
    "workers-ts/test/admin-integral-log-export.test.ts",
    "workers-ts/test/admin-integral-log-export-http.test.ts",
    "workers-ts/test/admin-integral-log-frontend.test.ts"]) {
    if (!existsSync(resolve(workerRoot, "..", file))) throw new Error(`Integral-log export evidence missing: ${file}`);
  }
}
if (activityFrameFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [
    ["get", "/marketing/activity-frame"],
    ["get", "/marketing/activity-frame/products"],
    ["get", "/marketing/activity-frame/brands"],
    ["get", "/marketing/activity-frame/labels"],
    ["get", "/marketing/activity-frame/:id"],
    ["post", "/marketing/activity-frame"],
    ["put", "/marketing/activity-frame/:id"],
    ["patch", "/marketing/activity-frame/:id/status"],
    ["delete", "/marketing/activity-frame/:id"],
  ]) {
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${suffix}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${suffix}"`)) {
      throw new Error(`Activity-frame ${method.toUpperCase()} ${suffix} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/activityFrame.ts"), "utf8");
  const catalogSource = readFileSync(resolve(workerRoot, "src/services/product/StoreProductService.ts"), "utf8");
  const activitySource = readFileSync(resolve(workerRoot, "src/controllers/api/v1/ProductController.ts"), "utf8");
  if (!permissionSource.includes('key: "activity_frame"')
    || !adapterSource.includes("/marketing/activity-frame")
    || !catalogSource.includes("decorateCatalogProducts")
    || !activitySource.includes("promotionType")) {
    throw new Error("Activity-frame permission, Admin adapter, or public consumer evidence missing");
  }
}
if (activityBackgroundFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [
    ["get", ""], ["get", "/products"], ["get", "/brands"], ["get", "/labels"], ["get", "/:id"],
    ["post", ""], ["put", "/:id"], ["patch", "/:id/status"], ["delete", "/:id"],
  ]) {
    const path = `/marketing/activity-background${suffix}`;
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}"`)) {
      throw new Error(`Activity-background ${method.toUpperCase()} ${path} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/activityBackground.ts"), "utf8");
  if (!permissionSource.includes('key: "activity_background"')
    || !adapterSource.includes("/marketing/activity-background")) {
    throw new Error("Activity-background permission or Admin adapter evidence missing");
  }
}
if (timeDiscountFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [
    ["get", ""], ["get", "/products"], ["get", "/brands"], ["get", "/labels"],
    ["get", "/user-labels"], ["get", "/:id"], ["post", ""], ["put", "/:id"],
    ["patch", "/:id/status"], ["delete", "/:id"],
  ]) {
    const path = `/marketing/time-discounts${suffix}`;
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}"`)) {
      throw new Error(`Time-discount ${method.toUpperCase()} ${path} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/timeDiscount.ts"), "utf8");
  if (!permissionSource.includes('key: "time_discount"')
    || !permissionSource.includes('route === "/admin/marketing/discount/list"')
    || !adapterSource.includes("/marketing/time-discounts")) {
    throw new Error("Time-discount permission or Admin adapter evidence missing");
  }
}
if (fullDiscountFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [
    ["get", ""], ["get", "/products"], ["get", "/brands"], ["get", "/labels"],
    ["get", "/user-labels"], ["get", "/:id"], ["post", ""], ["put", "/:id"],
    ["patch", "/:id/status"], ["delete", "/:id"],
  ]) {
    const path = `/marketing/full-discounts${suffix}`;
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}"`)) {
      throw new Error(`Full-discount ${method.toUpperCase()} ${path} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/fullDiscount.ts"), "utf8");
  if (!permissionSource.includes('key: "full_discount"')
    || !permissionSource.includes('route === "/admin/marketing/discount/full_discount"')
    || !adapterSource.includes("/marketing/full-discounts")) {
    throw new Error("Full-discount permission or Admin adapter evidence missing");
  }
}
if (nthDiscountFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [
    ["get", ""], ["get", "/products"], ["get", "/brands"], ["get", "/labels"],
    ["get", "/user-labels"], ["get", "/:id"], ["post", ""], ["put", "/:id"],
    ["patch", "/:id/status"], ["delete", "/:id"],
  ]) {
    const path = `/marketing/nth-discounts${suffix}`;
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}"`)) {
      throw new Error(`Nth-discount ${method.toUpperCase()} ${path} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/nthDiscount.ts"), "utf8");
  if (!permissionSource.includes('key: "nth_discount"')
    || !permissionSource.includes('route === "/admin/marketing/discount/pieces_discount"')
    || !adapterSource.includes("/marketing/nth-discounts")) {
    throw new Error("Nth-discount permission or Admin adapter evidence missing");
  }
}
if (fullGiftFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [
    ["get", ""], ["get", "/products"], ["get", "/coupons"], ["get", "/brands"],
    ["get", "/labels"], ["get", "/user-labels"], ["get", "/:id"], ["post", ""],
    ["put", "/:id"], ["patch", "/:id/status"], ["delete", "/:id"],
  ]) {
    const path = `/marketing/full-gifts${suffix}`;
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}"`)) {
      throw new Error(`Full-gift ${method.toUpperCase()} ${path} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/fullGift.ts"), "utf8");
  if (!permissionSource.includes('key: "full_gift"')
    || !permissionSource.includes('route === "/admin/marketing/discount/give"')
    || !adapterSource.includes("/marketing/full-gifts")) {
    throw new Error("Full-gift permission or Admin adapter evidence missing");
  }
}
if (integralBatchFollowup) {
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of [["get", "/products"], ["get", "/products/:productId"],
    ["post", ""], ["get", "/receipts/:requestId"]]) {
    const path = `/activity/integral-batch${suffix}`;
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}"`)) {
      throw new Error(`Integral-batch ${method.toUpperCase()} ${path} missing from one Admin prefix`);
    }
  }
  const permissionSource = readFileSync(resolve(workerRoot, "src/services/admin/AdminPermissionService.ts"), "utf8");
  const adapterSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/api/integralBatch.ts"), "utf8");
  const pageSource = readFileSync(resolve(workerRoot, "../view/admin-ts/src/pages/activity/IntegralBatch.vue"), "utf8");
  if (!permissionSource.includes('key: "integral_batch"') || !permissionSource.includes('marketing/integral/batch')
    || !permissionSource.includes('/admin/marketing/store_integral/add_store_integral')
    || !adapterSource.includes('/activity/integral-batch') || !pageSource.includes('integral_batch.manage')) {
    throw new Error("Integral-batch permission, exact legacy authority, API adapter or page evidence missing");
  }
}
if (marketingConfigFollowup) {
  const path = "/marketing/sign-day-config";
  const endpoints = [["get", ""], ["get", "/receipts/:requestId"], ["get", "/:id"],
    ["post", ""], ["put", "/:id"], ["patch", "/:id/status"], ["delete", "/:id"]];
  const v1Source = readFileSync(resolve(workerRoot, "src/routes/v1/index.ts"), "utf8");
  for (const [method, suffix] of endpoints) {
    if (!adminRouteSource.includes(`adminapiRoutes.${method}("${path}${suffix}"`)
      || !v1Source.includes(`v1Routes.${method}("/admin${path}${suffix}"`)) {
      throw new Error(`Sign-day ${method.toUpperCase()} ${path}${suffix} missing from one Admin prefix`);
    }
  }
  reviews["/admin/marketing/integral/signIn"] = {
    status: "candidate", targetScreens: [path],
    targetApis: endpoints.map(([method, suffix]) => `${method.toUpperCase()} /adminapi${path}${suffix}`),
    covered: ["独立签到天数组管理恢复固定 sign_day_num 的文字标签、正整数积分、排序、显示/隐藏、添加/编辑/删除；最多7条含隐藏，历史附加JSON键在编辑时保留。按真实config_name查组，空组首次明确添加才初始化固定元数据；CAS、UUID和原子审计回执支持原意图核对。独立sign_day_config.view/manage，旧154精确auth/path只映射查看，不泛授通用组合或真实签到奖励写权限。"],
    remaining: ["仅本地候选、未发布。该组与旧PHP一样不参与实际发奖；真实签到继续消费sign_mode、基础积分与system_sign_reward，不能把本页保存解释为修改奖励算法。新预览以CSS展示主题和本组已存数据，旧六色手机图是静态素材；不宣称旧静态像素或真实商城消费者等价。生产历史组/真实受限角色、Linux/Hyperdrive、发布仍待验收。"],
    evidence: ["workers-ts/docs/admin-marketing-config-legacy-source-20260930.md",
      "workers-ts/docs/admin-sign-day-config.md", "workers-ts/src/services/admin/AdminSignDayConfigService.ts",
      "workers-ts/src/services/admin/AdminSignDayConfigInput.ts", "workers-ts/src/controllers/api/v1/AdminSignDayConfigController.ts",
      "view/admin-ts/src/api/signDayConfig.ts", "view/admin-ts/test/signDayConfig.test.ts",
      "workers-ts/test/admin-sign-day-config.test.ts", "workers-ts/test/admin-sign-day-config-http.test.ts",
      "workers-ts/test/admin-sign-day-config-postgres.test.ts", "workers-ts/test/runtime-sign-day-config-privileges.test.ts",
      "workers-ts/src/migrations/runSignDayConfigRuntimeUpgrade.ts", "workers-ts/src/migrations/runtimeSignDayGroupLockBoundary.ts",
      "workers-ts/src/migrations/signDayConfigRuntimeCatalog.ts", "workers-ts/test/runtime-sign-day-config-upgrade.test.ts"],
  };
  reviews["/admin/marketing/coupon/system_config/:type?/:tab_id?"] = {
    status: "retired", targetScreens: [], targetApis: [],
    covered: ["只退役无菜单/页面链接的错名孤儿别名，不退役配置实体。旧type/pid默认0实际首表为站点tab26，GET/保存复用通用配置服务且不限定优惠券；安装无专属coupon tab/menu。真实四个赠券键分别由新人运营、普通等级激活配置与真实消费者承接，不新增虚构coupon配置域，也不从旧订单meta.auth泛授配置写权限。"],
    remaining: ["静态源证据不能证明线上自定义菜单或书签无人使用；部署仍需核对历史入口。本次不把背后通用settings差异清零：tab26的验证码有效期、微信登录昵称头像策略、全场包邮及五个系统安全键仍分别归注册/配送/系统安全合同；generic保存API存在不等于有专用页面或消费者。真实系统设置台账继续partial。"],
    evidence: ["workers-ts/docs/admin-marketing-config-legacy-source-20260930.md",
      "view/admin-ts/src/pages/config/NewcomerSettings.vue", "view/admin-ts/src/pages/config/LevelActivationSettings.vue",
      "view/admin-ts/src/pages/config/CommerceSettings.vue", "workers-ts/src/services/activity/AdminNewcomerService.ts",
      "workers-ts/src/services/admin/AdminLevelActivationService.ts", "workers-ts/src/services/activity/StoreNewcomerService.ts",
      "workers-ts/src/services/user/UserLevelService.ts", "workers-ts/src/services/system/AdminConfigBatchService.ts"],
  };
  reviews["/admin/marketing/home"].remaining = ["旧营销宫格总览仍无独立新页面；各目的地按专用合同计账，砍价/积分单件编辑、满送售后和真实渠道码仍有部分缺口，不能借菜单导航推定营销总览已完成。"];
}
const registeredApis = new Set([...adminRouteSource.matchAll(/adminapiRoutes\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gu)]
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
  const targetPermissions = [...new Set([
    ...review.targetScreens.map((screen) => permissionKeys[screen]),
    ...review.targetApis.flatMap((api) => apiPermissionKeys[api] ? [apiPermissionKeys[api]] : []),
  ])];
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
  generatedFrom: inventoryPath,
  methodology: {
    scope: "Only the 48 surface=page routes under /admin/marketing in the authoritative 274-route inventory; four commonForm auxiliary routes are excluded.",
    reviewBasis: "Compare the legacy PHP component and API observations pinned to marketing.js SHA-256 with the target Admin route/page, Worker adminapi contract, and permission map. Legacy paths and meta.auth are recorded static review evidence; generation requires only this repository. An API without an Admin operation surface does not establish screen parity. Candidate means local code-level workflow coverage only; partial records a material subset; missing records no viable target Admin screen. Do not infer domain coverage from /activity or a shared title.",
    validationBoundary: marketingConfigFollowup
      ? "Fixed sign_day_num Admin management and orphan coupon alias retirement are local, unpublished follow-ups. Native PostgreSQL/JWT/restricted-LOGIN, frontend and synthetic browser evidence is recorded separately in admin-marketing-config-acceptance-20260930.json. The seven-row editor does not change actual sign reward consumers. No production history/roles, Linux CI/Hyperdrive, real-role browser, deployment or publication acceptance is claimed; existing settings and marketing partial contracts remain open."
      : integralBatchFollowup
      ? "Integral-batch is a local code-level workflow candidate: all 77 native PG16 cases passed, including actual dual-prefix JWT, independent Admin LOGIN, source/media refusals, atomic cloning/receipt rollback, concurrency, selected-SKU checkout/direct exchange and once-only cancellation/refund inventory recovery. Frontend 10-case checks, seven desktop/mobile synthetic-browser interaction groups and both Worker TypeScript checks passed. The chain retains the prior full-gift public-refund follow-up. No production roles/data, provider, real-role browser E2E, Linux CI/Hyperdrive, scale, native UniApp build, deployment or publication acceptance is claimed."
      : fullGiftRefundFollowup
      ? "Bounded full-gift whole-order public refund and independent LOGIN acceptance are recorded in admin-full-gift-refund-entry-acceptance-20260930.json. Both screens remain partial while partial/split/delivered and gift-only remainder entitlement adapters are unfinished. No production roles, provider, Hyperdrive, scale, native UniApp build or publication acceptance is claimed."
      : fullGiftFollowup
      ? "Full-gift Admin and order consumer work is recorded separately in admin-full-gift-acceptance-20260930.json. These two screens remain partial while public refund admission, partial/split/delivered gift entitlement adapters remain unfinished. No production-role, scale, Linux CI, Hyperdrive, UniApp native build, deployment or publication claim; FE-001D and FE-001G/H remain open."
      : nthDiscountFollowup
      ? "Local nth-piece discount Admin and real-service contract candidate. Native PostgreSQL and synthetic-browser evidence is recorded in admin-nth-discount-acceptance-20260930.json. Production statistics reconciliation, real-role browser E2E, Linux CI, Hyperdrive, UniApp native type/build and publication remain open; FE-001D and FE-001G/H remain open."
      : fullDiscountFollowup
      ? "Local full-discount Admin and real-service contract candidate. Precise native PostgreSQL and synthetic-browser evidence is recorded in admin-full-discount-acceptance-20260930.json. Production statistics reconciliation, real-role browser E2E, Linux CI, Hyperdrive, UniApp native type/build and publication remain open; FE-001D and FE-001G/H remain open."
      : timeDiscountFollowup
      ? "Local Admin and real-service contract candidate with isolated PG16 52/52 and synthetic browser API evidence. No production statistics reconciliation, real-role browser E2E, Linux CI, UniApp native type/build, deployment, or publication is claimed. FE-001D and FE-001G/H remain open."
      : "Code-only semantic review. No production data, provider, real-role browser E2E, deployment, or publication is claimed. FE-001D and FE-001G/H remain open.",
  },
  summary: { legacyRoutes: routes.length, reviewed: routes.length, ...counts, unreviewed: 0 },
  routes,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes("--write") && !process.argv.includes("--stdout-only")) {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, serialized, "utf8");
  console.log(`Wrote ${outputFile}`);
} else {
  process.stdout.write(serialized);
}
