import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Route = {
  legacy: { path: string; resolvedComponent: string; source: string; routerSha256: string; auth: string };
  status: "candidate" | "partial" | "missing" | "retired";
  targetScreens: string[];
  targetApis: string[];
  targetPermissions: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
};
type Report = {
  methodology: { scope: string; reviewBasis: string; validationBoundary: string };
  summary: Record<string, number>;
  routes: Route[];
};

const source = (path: string) => readFileSync(path, "utf8");
const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
  legacy: { routes: { path: string; surface: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-marketing-route-parity.json")) as Report;
const businessPaths = inventory.legacy.routes
  .filter((route) => route.surface === "page" && route.path.startsWith("/admin/marketing"))
  .map((route) => route.path);

describe("legacy Admin marketing route parity audit", () => {
  it("reviews the exact 48 business pages and excludes four auxiliary routes", () => {
    expect(businessPaths).toHaveLength(48);
    expect(inventory.legacy.routes.filter((route) => route.path.startsWith("/admin/marketing"))).toHaveLength(52);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({
      legacyRoutes: 48, reviewed: 48, candidate: 18, partial: 15,
      missing: 15, retired: 0, unreviewed: 0,
    });
  });

  it("keeps the four reviewed ledgers disjoint and inside the 274-page authority", () => {
    const content = JSON.parse(source("audit/admin-legacy-content-route-parity.json")) as { routes: { legacyPath: string }[] };
    const product = JSON.parse(source("audit/admin-legacy-product-route-parity.json")) as { routes: { legacyPath: string }[] };
    const setting = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const paths = [
      ...content.routes.map((route) => route.legacyPath),
      ...product.routes.map((route) => route.legacyPath),
      ...setting.routes.map((route) => route.legacy.path),
      ...report.routes.map((route) => route.legacy.path),
    ];
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(paths).toHaveLength(149);
    expect(new Set(paths).size).toBe(149);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("keeps every conclusion traceable to a real legacy component and a permission boundary", () => {
    const routerHash = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/marketing.js")?.sha256;
    expect(routerHash).toMatch(/^[a-f0-9]{64}$/u);
    const generator = source("scripts/admin-marketing-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    expect(generator).toContain("Legacy paths and meta.auth are recorded static review evidence");
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(48);
    for (const route of report.routes) {
      expect(route.legacy.resolvedComponent, route.legacy.path).toContain("cinashop-php/view/admin/src/");
      expect(route.legacy.source, route.legacy.path).toMatch(/marketing\.js:\d+$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(routerHash);
      expect(route.legacy.auth.length, route.legacy.path).toBeGreaterThan(0);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      if (route.status === "missing") expect(route.targetScreens, route.legacy.path).toEqual([]);
      else {
        expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.covered.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.targetPermissions.length, route.legacy.path).toBeGreaterThan(0);
      }
    }
    const undeclaredAuth = report.routes.filter((route) => route.legacy.auth === "not declared in route");
    expect(undeclaredAuth.map((route) => route.legacy.path)).toEqual([
      "/admin/marketing/store_combination/statistics/:id?",
      "/admin/marketing/store_bargain/statistics/:id?",
      "/admin/marketing/store_seckill/statistics/:id?",
    ]);
  });

  it("does not mistake a shared catalog or API-only endpoint for an old screen", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    expect(byPath.get("/admin/marketing/store_coupon/index")?.status).toBe("candidate");
    expect(byPath.get("/admin/marketing/store_coupon_issue/index")?.status).toBe("candidate");
    expect(byPath.get("/admin/marketing/store_coupon_issue/create/:id?")?.status).toBe("candidate");
    const couponRecord = byPath.get("/admin/marketing/store_coupon_user/index");
    expect(couponRecord?.status).toBe("candidate");
    expect(couponRecord?.targetScreens).toEqual(["/marketing/coupon-records"]);
    expect(couponRecord?.targetApis).toEqual(["GET /adminapi/marketing/coupon-records/list"]);
    expect(couponRecord?.targetPermissions).toEqual(["coupon_record.view"]);
    expect(couponRecord?.covered.join(" ")).toContain("store_coupon_user");
    expect(couponRecord?.remaining.join(" ")).toContain("真实历史领取记录");
    const seckillParent = byPath.get("/admin/marketing/store_seckill/list");
    expect(seckillParent?.status).toBe("candidate");
    expect(seckillParent?.targetScreens).toEqual(["/activity/seckill-activities"]);
    expect(seckillParent?.targetPermissions).toEqual(["seckill_activity.view / seckill_activity.manage"]);
    expect(seckillParent?.targetApis).toHaveLength(9);
    expect(seckillParent?.covered.join(" ")).toContain("store_activity(type=1)");
    const seckillCreate = byPath.get("/admin/marketing/store_seckill/create/:id?/:copy?");
    expect(seckillCreate?.status).toBe("candidate");
    for (const capability of ["分类级联含子分类与商品标签筛选", "跨页多选一次添加", "跨商品批量价格/总额度与确认移除", "选品商品类型/分类列", "SKU自身图片", "原子加入本地表单", "已消耗额度下限", "保持历史身份"]) {
      expect(seckillCreate?.covered.join(" ")).toContain(capability);
    }
    expect(seckillCreate?.covered.join(" ")).toContain("公开秒杀列表主图签名，仅证明该列表响应");
    expect(seckillCreate?.remaining.join(" ")).toContain("真实配置/角色");
    expect(seckillCreate?.remaining.join(" ")).toContain("完整商品媒体合同验收");
    expect(seckillCreate?.remaining.join(" ")).toContain("旧动态表单API未注册");
    const seckillTimes = byPath.get("/admin/marketing/store_seckill_data/index");
    expect(seckillTimes?.status).toBe("candidate");
    expect(seckillTimes?.targetScreens).toEqual(["/activity/seckill-times"]);
    expect(seckillTimes?.targetPermissions).toEqual(["seckill_time.view / seckill_time.manage"]);
    expect(seckillTimes?.targetApis).toHaveLength(6);
    expect(seckillTimes?.covered.join(" ")).toContain("store_seckill_time");
    expect(seckillTimes?.covered.join(" ")).toContain("结束当天");
    expect(seckillTimes?.remaining.join(" ")).toContain("父活动目录");
    const seckillStatistics = byPath.get("/admin/marketing/store_seckill/statistics/:id?");
    expect(seckillStatistics?.status).toBe("candidate");
    expect(seckillStatistics?.targetScreens).toEqual(["/activity/seckill-statistics/:id?"]);
    expect(seckillStatistics?.targetPermissions).toEqual(["seckill_statistics.view"]);
    expect(seckillStatistics?.targetApis).toHaveLength(3);
    expect(seckillStatistics?.covered.join(" ")).toContain("已支付主单");
    const signRewards = byPath.get("/admin/marketing/sign_rewards");
    expect(signRewards?.status).toBe("candidate");
    expect(signRewards?.targetScreens).toEqual(["/marketing/sign-rewards"]);
    expect(signRewards?.targetApis).toEqual([
      "GET /adminapi/setting/sign/rewards", "GET /adminapi/setting/sign/add_rewards",
      "GET /adminapi/setting/sign/edit_rewards/:id", "POST /adminapi/setting/sign/save_rewards/:id",
      "DELETE /adminapi/setting/sign/del_rewards/:id",
    ]);
    expect(signRewards?.targetPermissions).toEqual(["config.view / config.manage"]);
    expect(signRewards?.remaining.join(" ")).toContain("生产非空签到规则");
    const integralCategories = byPath.get("/admin/marketing/integral/classify");
    expect(integralCategories?.status).toBe("candidate");
    expect(integralCategories?.targetScreens).toEqual(["/marketing/integral-categories"]);
    expect(integralCategories?.targetPermissions).toEqual(["integral_category.view / integral_category.manage"]);
    expect(integralCategories?.targetApis).toHaveLength(6);
    expect(integralCategories?.covered.join(" ")).toContain("group=5");
    expect(integralCategories?.remaining.join(" ")).toContain("完全包围");
    const recharge = byPath.get("/admin/marketing/balance_recharge");
    expect(recharge?.status).toBe("candidate");
    expect(recharge?.targetScreens).toEqual(["/marketing/recharge-options"]);
    expect(recharge?.targetPermissions).toEqual(["recharge_quota.view / recharge_quota.manage"]);
    expect(recharge?.targetApis).toHaveLength(6);
    expect(recharge?.covered.join(" ")).toContain("user_recharge_quota");
    expect(recharge?.covered.join(" ")).toContain("既有充值订单");
    expect(recharge?.remaining.join(" ")).toContain("setup_recharge");
    expect(byPath.get("/admin/marketing/integral/signIn")?.remaining.join(" ")).toContain("不消费这组旧7天配置");
    const integralLog = byPath.get("/admin/marketing/user_point/index");
    expect(integralLog?.status).toBe("partial");
    expect(integralLog?.targetScreens).toEqual(["/marketing/user-point"]);
    expect(integralLog?.targetApis).toEqual([
      "GET /adminapi/marketing/user-point/logs",
      "GET /adminapi/marketing/user-point/statistics",
    ]);
    expect(integralLog?.targetPermissions).toEqual(["integral_log.view"]);
    expect(integralLog?.covered.join(" ")).toContain("统计卡在初始化时单独加载");
    expect(integralLog?.remaining.join(" ")).toContain("导出");
    const pointStatistic = byPath.get("/admin/marketing/point_statistic");
    expect(pointStatistic?.status).toBe("candidate");
    expect(pointStatistic?.targetScreens).toEqual(["/marketing/point-statistic"]);
    expect(pointStatistic?.targetApis).toHaveLength(4);
    expect(pointStatistic?.targetPermissions).toEqual(["point_statistic.view"]);
    expect(pointStatistic?.covered.join(" ")).toContain("gain 双标签");
    for (const path of [
      "/admin/marketing/store_discounts/index",
      "/admin/marketing/store_discounts/create",
    ]) expect(byPath.get(path)?.status).toBe("candidate");
    for (const path of [
      "/admin/marketing/channel_code",
      "/admin/marketing/channel_code/create/:id?",
      "/admin/marketing/channel_code/statistic/:id?",
    ]) {
      expect(byPath.get(path)?.status).toBe("partial");
      expect(byPath.get(path)?.targetScreens).toContain("/content/wechat-qrcode");
    }
    expect(report.methodology.reviewBasis).toMatch(/API without an Admin operation surface/u);
    expect(report.methodology.validationBoundary).toMatch(/No production data/u);
  });

  it("keeps the accepted complete combination editor contract and historical evidence independent of the new reads", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const create = byPath.get("/admin/marketing/store_combination/create/:id?/:copy?")!;
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
    expect(create.status).toBe("candidate");
    expect(create.targetScreens).toEqual(["/activity/combinations"]);
    expect(create.targetPermissions).toEqual(["combination.view / combination.manage"]);
    expect(create.targetApis).toEqual(combinationApis);
    expect(create.evidence).toContain("workers-ts/src/controllers/api/v1/AdminCombinationController.ts");
    expect(create.evidence).toContain("view/admin-ts/src/api/combination.ts");
    expect(create.targetApis).not.toContain("POST /adminapi/activity/save");
    expect(create.targetApis).not.toContain("GET /adminapi/activity/combinations/export");
    for (const capability of ["编辑与复制锁定来源", "复制清活动/SKU身份和已消耗量", "按配置总额度预填", "完整source成功后原子替换草稿", "历史SKU身份/退役保持", "总额度不能低于已消耗", "批量更新先完整验证再原子写草稿", "gallery沿attachment独立权限", "未知结果仅GET重读"]) {
      expect(create.covered.join(" ")).toContain(capability);
    }
    for (const evidence of ["workers-ts/test/admin-combination-http.test.ts", "workers-ts/test/pink-virtual-timeout-postgres.test.ts", "workers-ts/test/pink-success-notice-postgres.test.ts", "workers-ts/test/combination-refund-policy-postgres.test.ts", "workers-ts/test/pink-success-notice-migration.test.ts", "workers-ts/audit/combination-browser-20260927.json", "workers-ts/audit/combination-native-20260927.json"]) {
      expect(create.evidence).toContain(evidence);
    }
    for (const boundary of ["真实配置/角色/provider", "完整公共媒体/R2验收", "真实设备", "完整Linux CI及发布", "虚拟到期成团、成团成功通知、退款/物流/买方配置快照", "开团/参团成功通知不在该证据范围", "合成验收不等于生产验收", "本条不扩充旧生命周期证据"]) {
      expect(create.remaining.join(" ")).toContain(boundary);
    }
    expect(create.remaining.join(" ")).toContain("本机原生受限角色与实际装配HTTP及生命周期去重155项");
    expect(create.remaining.join(" ")).toContain("富文本DOM清理、签名还原与390宽布局有实际浏览器证据");
    expect(create.remaining.join(" ")).not.toContain("需引用");
    expect(create.remaining.join(" ")).not.toContain("须主任务合成浏览器实测");
  });

  it("maps exactly eight new combination GET contracts across three independent read capabilities and real screens", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const index = byPath.get("/admin/marketing/store_combination/index")!;
    const groups = byPath.get("/admin/marketing/store_combination/combina_list")!;
    const statistics = byPath.get("/admin/marketing/store_combination/statistics/:id?")!;
    const create = byPath.get("/admin/marketing/store_combination/create/:id?/:copy?")!;
    expect(index.targetScreens).toEqual(["/activity/combinations"]);
    expect(index.targetApis).toEqual([...create.targetApis, "GET /adminapi/activity/combinations/export"]);
    expect(index.targetPermissions).toEqual(["combination.view / combination.manage", "combination_export.view"]);
    expect(groups.targetScreens).toEqual(["/activity/combination-groups"]);
    expect(groups.targetPermissions).toEqual(["combination_group.view"]);
    expect(groups.targetApis).toEqual([
      "GET /adminapi/activity/combination-groups/head",
      "GET /adminapi/activity/combination-groups",
      "GET /adminapi/activity/combination-groups/:groupId/members",
    ]);
    expect(statistics.targetScreens).toEqual(["/activity/combination-statistics/:id?"]);
    expect(statistics.targetPermissions).toEqual(["combination_statistics.view"]);
    expect(statistics.targetApis).toEqual([
      "GET /adminapi/activity/combination-statistics/:id/head",
      "GET /adminapi/activity/combination-statistics/:id/groups",
      "GET /adminapi/activity/combination-statistics/:id/groups/:groupId/members",
      "GET /adminapi/activity/combination-statistics/:id/orders",
    ]);
    const addedApis = ["GET /adminapi/activity/combinations/export", ...groups.targetApis, ...statistics.targetApis];
    expect(addedApis).toHaveLength(8); expect(new Set(addedApis).size).toBe(8);
    for (const route of [index, groups, statistics]) {
      expect(route.status).toBe("candidate");
      expect(route.targetScreens).not.toContain("/activity");
      expect(route.targetApis).not.toContain("GET /adminapi/activity/pink/:combinationId");
      expect(route.targetApis).not.toContain("POST /adminapi/activity/save");
      expect(route.evidence).toContain("workers-ts/src/controllers/api/v1/AdminCombinationStatisticsController.ts");
      expect(route.evidence).toContain("view/admin-ts/src/api/combinationStatistics.ts");
      expect(route.evidence).toContain("workers-ts/test/admin-combination-statistics-http.test.ts");
      expect(route.evidence).toContain("workers-ts/test/admin-combination-statistics-postgres.test.ts");
      expect(route.evidence).toContain("workers-ts/test/admin-combination-statistics-frontend.test.ts");
      for (const boundary of ["生产真实角色/配置", "公共媒体/R2", "真实设备", "完整Linux CI及发布", "不新增schema或grants", "不宣称支付、退款、虚拟补员或通知消费者因只读屏而闭合", "旧泛型团数组接口不计逐屏等价", "合成验收不等于生产验收"]) {
        expect(route.remaining.join(" ")).toContain(boundary);
      }
    }
    expect(groups.evidence).toContain("view/admin-ts/src/pages/activity/CombinationGroups.vue");
    expect(statistics.evidence).toContain("view/admin-ts/src/pages/activity/CombinationStatistics.vue");
    const permissionSource = source("src/services/admin/AdminPermissionService.ts");
    for (const key of ["combination_export", "combination_group", "combination_statistics"]) {
      expect(permissionSource).toMatch(new RegExp(`key: "${key}"[^\\n]*manage: false`, "u"));
    }
  });

  it("records precise combination projections and full-file export rather than counting CRUD or generic arrays as parity", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const index = byPath.get("/admin/marketing/store_combination/index")!;
    const groups = byPath.get("/admin/marketing/store_combination/combina_list")!;
    const statistics = byPath.get("/admin/marketing/store_combination/statistics/:id?")!;
    for (const semantic of ["price取活动主行", "ot_price取当前基础商品store_product.ot_price", "基础商品缺失仍保留行", "不混SKU的ot_price", "people仍是成团配置人数",
      "count_people为k_id=0", "count_people_all为全部pink记录含退款/虚拟行", "count_people_pink为k_id=0且status=2",
      "旧11列key不变", "开团数/参与记录数", "Asia/Shanghai", "每页最多1000条", "100000行/16MiB", "单响应4MiB", "SHA-256 snapshot", "后续页必须校验相同快照", "不下载部分文件", "仅导出角色"]) {
      expect(index.covered.join(" ")).toContain(semantic);
    }
    for (const semantic of ["COUNT(全部pink)", "COUNT(k_id=0 AND status=2)", "不随列表筛选变化", "默认15条且独立count", "add_time DESC,id DESC", "过期raw status=1仅标pending",
      "GET不执行到期结算", "所选团长OR未退款子行", "历史cid=0", "固定活动scope仍须正ID", "双身份键同时一致", "业务order_id而非数据库id/key", "另验order.view", "不合并新团"]) {
      expect(groups.covered.join(" ")).toContain(semantic);
    }
    for (const semantic of ["people_count=COUNT(DISTINCT pink.uid)含uid0", "spread_count=COUNT(DISTINCT uid WHERE k_id>0)", "start_count为k_id=0", "success_count再限status=2",
      "type=3 AND paid=1 AND pid IN(0,-1)", "SUM(pay_price)十进制字符串", "pay_count按同集合DISTINCT uid", "支付毛额含后续退款和已删除主单", "排除未支付/拆单子单",
      "参与团/活动订单两个页签", "list/count同完整谓词", "EXISTS防放大", "订单status=0恒为空", "每个响应为有界RR READ ONLY快照", "5/2/5秒", "private no-store"]) {
      expect(statistics.covered.join(" ")).toContain(semantic);
    }
    expect(statistics.remaining.join(" ")).toContain("旧源码没有独立图表控件");
    expect(statistics.remaining.join(" ")).toContain("不声称跨汇总与列表请求共享数据库快照");
    // Anchor the semantic text to the implemented SQL and browser completion
    // guards, so a renamed generic CRUD screen cannot satisfy this review.
    const service = source("src/services/admin/AdminCombinationStatisticsService.ts");
    expect(service).toContain("count(DISTINCT uid)::integer AS people_count");
    expect(service).toContain("o.type=3 AND o.activity_id=${id} AND o.paid=1 AND o.pid IN(0,-1)");
    expect(service).toContain("coalesce(sum(o.pay_price),0.00)::text AS pay_price");
    expect(service).toContain("p.combination_id=${leader.combination_id} AND (p.id=${id} OR (p.k_id=${id} AND p.is_refund=0))");
    expect(service).toContain("p.uid>0 AND p.is_virtual=0 AND p.combination_id>0 AND p.product_id>0");
    const exporter = source("src/services/admin/AdminCombinationExportService.ts");
    for (const implemented of ["COMBINATION_EXPORT_MAX_ROWS = 100_000", "COMBINATION_EXPORT_MAX_BYTES = 16 * 1024 * 1024", "LEFT JOIN store_product base",
      "base.ot_price::text AS current_ot_price", "jsonb_build_array(id,sort,row_version,base_version,cells)", "REPEATABLE READ, READ ONLY", "query.snapshot !== snapshot", "Asia/Shanghai"]) {
      expect(exporter).toContain(implemented);
    }
    const frontend = source("../view/admin-ts/src/api/combinationStatistics.ts");
    expect(frontend).toContain("rows.length !== first.count");
    expect(frontend).toContain("new TextEncoder().encode(csv).byteLength !== first.csv_bytes");
    expect(frontend).toContain("if (!result.has_more)");
  });

  it("keeps the template workflow independent from issuer management and automatic delivery", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const template = byPath.get("/admin/marketing/store_coupon/index")!;
    expect(template.status).toBe("candidate");
    expect(template.targetScreens).toEqual(["/marketing/coupon-templates"]);
    expect(template.targetApis).toEqual([
      "GET /adminapi/marketing/coupon-templates",
      "GET /adminapi/marketing/coupon-templates/options",
      "GET /adminapi/marketing/coupon-templates/products",
      "GET /adminapi/marketing/coupon-templates/:id/issues",
      "GET /adminapi/marketing/coupon-templates/:id",
      "POST /adminapi/marketing/coupon-templates",
      "POST /adminapi/marketing/coupon-templates/:id/invalidate",
      "DELETE /adminapi/marketing/coupon-templates/:id",
      "POST /adminapi/marketing/coupon-template-issues",
    ]);
    expect(template.targetPermissions).toEqual([
      "coupon_template.view / coupon_template.manage", "coupon_template_issue.manage + coupon_template.view",
    ]);
    for (const semantic of ["默认15条分页", "sort DESC,id DESC和is_del=0", "无编辑/重新启用", "image字段是商品选择对象",
      "通用、单品类、指定商品", "最多100项/500字符", "应用去重校验并排序成规范CSV", "store_coupon_template与store_coupon_template_issue",
      "proof关联是归属权威", "不认领历史孤儿cid", "coupon_id只写新issue.id", "普通receive_type=1、新人=2、赠送=3",
      "receive_type=1/category=0/app_type=0", "另兼容已证明的历史普通category=1", "proof关联发行status=-1", "删除仅模板is_del=1", "保留已领/已占券、范围与订单",
      "REPEATABLE READ READ ONLY", "5/2/5秒", "private no-store", "actor+UUID+内容摘要", "proof.sourceRevision",
      "仅发布角色稳定页面显示无查看权限", "换号过渡GET仍由服务器拒绝并丢弃旧上下文响应",
      "未知写保留原UUID/body", "只GET核对后经人工确认解除"]) {
      expect(template.covered.join(" "), semantic).toContain(semantic);
    }
    for (const boundary of ["面额>0且有效日1..3650", "默认状态为有效，旧列表默认全部", "CSV规范排序去重由应用保证",
      "不禁止既有发行管理独立编辑", "register_give_coupon", "不代表自动满赠或关注投递闭合",
      "人工确认仅清本地状态，不是服务端回执", "新UUID可能重复发行", "不保存恢复队列", "显式窄权限升级不自动应用线上",
      "完整Linux CI", "真实配置/角色"]) {
      expect(template.remaining.join(" "), boundary).toContain(boundary);
    }
    expect(byPath.get("/admin/marketing/store_coupon_issue/index")?.status).toBe("candidate");
    expect(byPath.get("/admin/marketing/store_coupon_issue/create/:id?")?.status).toBe("candidate");
    expect(byPath.get("/admin/marketing/coupon/system_config/:type?/:tab_id?")?.status).toBe("missing");
    for (const file of ["workers-ts/src/models/schema/coupon_templates.ts", "workers-ts/src/services/admin/AdminCouponTemplateService.ts",
      "workers-ts/src/controllers/api/v1/AdminCouponTemplateController.ts", "workers-ts/src/migrations/runCouponTemplateRuntimeUpgrade.ts",
      "workers-ts/test/admin-coupon-template-http.test.ts", "workers-ts/test/admin-coupon-templates-frontend.test.ts"]) {
      expect(template.evidence).toContain(file);
    }
    const model = source("src/models/schema/coupon_templates.ts");
    expect(model).toContain("pgTable('store_coupon_template',");
    expect(model).toContain("pgTable('store_coupon_template_issue',");
    const service = source("src/services/admin/AdminCouponTemplateService.ts");
    for (const implemented of ["['create', 'invalidate', 'delete', 'publish']", "REPEATABLE READ, READ ONLY",
      "orderBy(desc(storeCouponTemplate.sort), desc(storeCouponTemplate.id))", "JOIN store_coupon_template_issue p ON p.issue_id=i.id",
      "WHERE p.template_id=${id} ORDER BY i.id FOR UPDATE OF i", "SET status=-1 FROM locked l WHERE i.id=l.id",
      "set({ isDel: 1 })", "couponId: issueId", "sourceRevision: expectedRevision!", "proof.revision !== expectedRevision"]) {
      expect(service, implemented).toContain(implemented);
    }
    const input = source("src/services/admin/AdminCouponTemplateInput.ts");
    expect(input).toContain("new Set(productIds).size !== productIds.length");
    expect(input).toContain(".sort((a, b) => a - b)");
    expect(input).toContain("validDays: integer(body.valid_days, '有效天数', 1, 3650)");
    expect(source("src/controllers/api/v1/AdminCouponTemplateController.ts"))
      .toContain(".assertAuthorized(actor, 'GET', '/adminapi/marketing/coupon-templates')");
    expect(source("src/services/activity/ActivityService.ts"))
      .toContain("issue.receiveType !== 1 || ![0, 1].includes(issue.category) || issue.appType !== 0");
    const frontend = source("../view/admin-ts/src/pages/marketing/CouponTemplates.vue");
    expect(frontend).toContain("canPublish = computed(() => canView.value && has('coupon_template_issue.manage'))");
    expect(frontend).toContain("列表或记录中的相似内容不能单独确认此次操作结果");
    expect(frontend).toContain("apiCouponTemplateIssues(id, { page: 1, limit: 15 }");
    expect(frontend).toContain("uncertainOperation.value === operation");
  });

  it("maps both bound issuer screens to nine dedicated operations and separate claim-history permission", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const catalog = byPath.get("/admin/marketing/store_coupon_issue/index")!;
    const create = byPath.get("/admin/marketing/store_coupon_issue/create/:id?")!;
    for (const route of [catalog, create]) {
      expect(route.status).toBe("candidate");
      expect(route.targetScreens).toEqual(["/coupon"]);
      expect(route.targetApis.some(api => /^\w+ \/adminapi\/coupon\//u.test(api))).toBe(false);
      for (const file of ["view/admin-ts/src/api/couponIssue.ts", "view/admin-ts/src/pages/coupon/CouponList.vue",
        "workers-ts/src/controllers/api/v1/AdminCouponIssueController.ts", "workers-ts/src/services/admin/AdminCouponIssueInput.ts",
        "workers-ts/src/services/admin/AdminCouponIssueService.ts", "workers-ts/test/admin-coupon-issue-postgres.test.ts",
        "workers-ts/test/admin-coupon-issue-http.test.ts", "workers-ts/test/admin-coupon-issues-frontend.test.ts",
        "workers-ts/audit/coupon-issue-native-20260927.json", "workers-ts/audit/coupon-issue-browser-20260927.json"]) {
        expect(route.evidence).toContain(file);
      }
      for (const boundary of ["无新DDL/grants", "旧generic经济编辑仅保留兼容", "优惠券配置页仍missing", "会员真实权益与领取渠道",
        "新人注册配置", "赠送/自动满赠/关注投递", "人工核对", "换新UUID可能重复发行", "不保存恢复队列",
        "完整Linux CI", "真实配置/角色", "真实设备/provider", "部署发布", "capsule保持原字节"]) {
        expect(route.remaining.join(" "), boundary).toContain(boundary);
      }
    }
    expect(catalog.targetApis).toEqual([
      "GET /adminapi/marketing/coupon-issues", "GET /adminapi/marketing/coupon-issues/:id",
      "GET /adminapi/marketing/coupon-issues/:id/copy", "GET /adminapi/marketing/coupon-issues/:id/claims",
      "POST /adminapi/marketing/coupon-issues/:id/status", "DELETE /adminapi/marketing/coupon-issues/:id",
    ]);
    expect(create.targetApis).toEqual([
      "GET /adminapi/marketing/coupon-issues/options", "GET /adminapi/marketing/coupon-issues/products",
      "GET /adminapi/marketing/coupon-issues/:id/copy", "POST /adminapi/marketing/coupon-issues",
    ]);
    expect(new Set([...catalog.targetApis, ...create.targetApis]).size).toBe(9);
    expect(catalog.targetPermissions).toEqual(["coupon.view / coupon.manage", "coupon_record.view"]);
    expect(create.targetPermissions).toEqual(["coupon.view / coupon.manage"]);
    for (const semantic of ["is_del=0", "id DESC", "15条分页", "同快照独立count", "UI默认全部", "literal搜索",
      "limit<=100/offset<=10000", "REPEATABLE READ READ ONLY", "5/2/5秒", "private no-store", "未知smallint",
      "coupon_record.view", "精确issue_id", "store_coupon_issue_user", "category=2读取store_coupon_user", "禁止两表互join",
      "null/负UID", "status=-1独立改0/1", "不恢复源模板", "只写isDel=1/status=-1", "store_product_coupon赠券配置",
      "已领/已占券", "revision排除remainCount/xmin/领取历史", "actor+UUID", "SHARE NOWAIT", "人工ack不再写入"]) {
      expect(catalog.covered.join(" "), semantic).toContain(semantic);
    }
    for (const semantic of ["新建与复制为独立发行，无原位经济编辑", "通用/品类/商品/品牌四范围", "1..3650天或固定使用区间",
      "限量正数/不限量0", "85表示8.5折", "85.99按85%结算", "上海日期转换精确UTC", "完整可见祖先", "storeId0",
      "最多100项/CSV500字符", "5000项选项上限拒截断", "历史category1映射普通0", "app_type非0返回copy_input=null",
      "POST复制也拒绝降级受众", "source_id/source_revision", "cid=0/appType=0/receiveLimit=1", "无proof/赠送flags",
      "不继承旧身份", "兼容已证明的历史普通category=1", "receive_type=0/2/3/4仍不能通过公共手领"]) {
      expect(create.covered.join(" "), semantic).toContain(semantic);
    }
    expect(byPath.get("/admin/marketing/store_coupon/index")?.targetScreens).toEqual(["/marketing/coupon-templates"]);
    expect(byPath.get("/admin/marketing/store_coupon_user/index")?.targetScreens).toEqual(["/marketing/coupon-records"]);
    expect(byPath.get("/admin/marketing/coupon/system_config/:type?/:tab_id?")?.status).toBe("missing");
  });

  it("backs issuer claims with independent history, safe copies and non-destructive state writes", () => {
    const service = source("src/services/admin/AdminCouponIssueService.ts");
    for (const implemented of ["orderBy(desc(storeCouponIssue.id))", "eq(storeCouponIssue.isDel, 0)",
      "const { remainCount: _remaining, ...definition } = row", "proof: state.proof", "if (issue.category === 2)",
      "source: 'owned' as const", "source: 'issue_log' as const", "row_key: `issue-log:${id}:${query.offset + index}`",
      "if (sourceId && row.appType !== 0)", "copy_input: !valid || row.isDel !== 0 || row.appType !== 0 ? null",
      "couponIssueHash({ operation, id, revision: expected, sourceId, sourceRevision, input, status })",
      "for('share', { noWait: true })", "set({ isDel: 1, status: -1 })", "type: 'coupon_issue'"]) {
      expect(service, implemented).toContain(implemented);
    }
    expect(service).not.toMatch(/\.delete\(store(?:CouponProduct|ProductCoupon|CouponUser|CouponTemplateIssue)\)/u);
    const frontend = source("../view/admin-ts/src/pages/coupon/CouponList.vue");
    for (const implemented of ["has('coupon_record.view')", "source_id: source?.id ?? 0", "source_revision: source?.revision ?? null",
      "不会截断或放宽原受众范围", "85.99按85%（8.5折）计算", "保留已领取、占用的优惠券范围、订单及赠券配置",
      "uncertainOperation.value === operation", "不会再次提交", "admin-session-changed"]) {
      expect(frontend, implemented).toContain(implemented);
    }
    const api = source("../view/admin-ts/src/api/couponIssue.ts");
    expect(api).toContain("row.uid === null || signed(row.uid)");
    expect(api).toContain(".every(readDate)");
    expect(api).toContain("row.copy_input !== null");
    expect(source("src/services/admin/AdminPermissionService.ts"))
      .toContain('if (["GET", "HEAD"].includes(method.toUpperCase()) && /^marketing\\/coupon-issues\\/[^/]+\\/claims$/.test(route)) return "coupon_record.view";');
  });

  it("matches its committed report byte for byte when regenerated", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-marketing-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-marketing-route-parity.json"));
  });

  it("dates only the two lottery screen promotions and keeps the legacy ledger reproducible", () => {
    const file = "audit/admin-legacy-marketing-route-parity-lottery-followup-20260928.json";
    const latest = JSON.parse(source(file)) as Report;
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-marketing-frontend-parity-audit.ts", "--lottery-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(file));
    expect(latest.summary).toMatchObject({ legacyRoutes: 48, reviewed: 48,
      candidate: 20, partial: 13, missing: 15, retired: 0, unreviewed: 0 });
    expect(latest.routes.map(route => route.legacy.path)).toEqual(report.routes.map(route => route.legacy.path));
    const changed = latest.routes.filter((route, index) => route.status !== report.routes[index].status);
    expect(changed.map(route => route.legacy.path)).toEqual([
      "/admin/marketing/lottery/index", "/admin/marketing/lottery/recording_list",
    ]);
    const catalog = changed[0];
    expect(catalog.targetScreens).toEqual(["/marketing/lottery"]);
    expect(catalog.covered.join(" ")).toContain("三统计");
    expect(catalog.remaining.join(" ")).toContain("不限期活动");
    const records = changed[1];
    expect(records.targetScreens).toEqual(["/marketing/lottery-records"]);
    expect(records.targetPermissions).toEqual(["lottery_record.view / lottery_record.manage"]);
    expect(records.targetApis).toContain("GET /adminapi/lottery/record/detail/:id");
    expect(records.covered.join(" ")).toContain("只读角色");
    expect(records.remaining.join(" ")).toContain("地址/电话");
  });
});
