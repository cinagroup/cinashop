import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "candidate" | "partial" | "missing" | "retired" | "unreviewed";

interface InventoryRoute {
  source: string;
  line: number;
  path: string;
  title: string | null;
  component: string;
  surface: string;
}

interface Inventory {
  legacy: { routes: InventoryRoute[] };
}

interface Review {
  status: Status;
  targetScreens: string[];
  targetApis: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, "..");
const inventoryFile = resolve(workerRoot, "audit", "admin-frontend-inventory.json");
const outputFile = resolve(workerRoot, "audit", "admin-legacy-setting-route-parity.json");

const reviews: Record<string, Review> = {
  "/admin/setting/system/create": {
    status: "candidate",
    targetScreens: ["/config/forms（新增/编辑表单）"],
    targetApis: [
      "GET /adminapi/form/index",
      "GET /adminapi/form/info/:id",
      "POST /adminapi/form/save/:id",
      "POST /adminapi/form/update_name/:id",
      "GET|PUT /adminapi/form/set_show/:id/:is_show",
      "DELETE /adminapi/form/del/:id",
      "GET /adminapi/form/data/:id",
    ],
    covered: [
      "系统表单定义、组件白名单、提交数据校验和订单不可变快照已迁移",
      "后台 CRUD、启停、数据列表及商品选择接口已迁移",
      "新版 Admin 提供10类受控组件、拖拽/按钮排序、字段设置和用户端预览",
      "兼容旧编辑器按时间戳键保存的对象形状，并按时间戳恢复组件顺序",
      "保存时拒绝未知组件、重复ID、重复/越界选项及无效默认值",
    ],
    remaining: ["需在获批窗口对生产历史模板形状及真实商品下单做只读/端到端核验"],
    evidence: [
      "view/admin-ts/src/pages/config/SystemForms.vue",
      "cinashop-php/view/admin/src/store/modules/admin/modules/mobildConfig.js:26",
      "cinashop-php/view/admin/src/pages/setting/systemForm/create.vue:667",
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/services/order/OrderSystemFormService.ts",
      "workers-ts/test/system-form-migration.test.ts",
    ],
  },
  "/admin/setting/system_form": {
    status: "candidate",
    targetScreens: ["/config/forms"],
    targetApis: [
      "GET /adminapi/form/index",
      "GET /adminapi/form/info/:id",
      "POST /adminapi/form/save/:id",
      "GET|PUT /adminapi/form/set_show/:id/:is_show",
      "DELETE /adminapi/form/del/:id",
    ],
    covered: [
      "名称/状态筛选、15条分页、新增、编辑、启停和删除",
      "列表不加载完整模板JSON，详情按需读取且所有响应禁止缓存",
      "停用和删除前检查仍关联的商品、秒杀、拼团、砍价和积分商品",
      "写入使用短事务、固定锁、精确回读和不含表单内容的管理员审计",
    ],
    remaining: ["需用生产历史引用关系验证停用/删除保护"],
    evidence: [
      "view/admin-ts/src/pages/config/SystemForms.vue",
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/controllers/api/v1/AdminCrudController.ts",
      "workers-ts/migrations/0128_system_form_reference_indexes.sql",
    ],
  },
  "/admin/setting/system_form/data": {
    status: "candidate",
    targetScreens: ["/config/forms（提交数据抽屉）"],
    targetApis: ["GET /adminapi/form/data/:id"],
    covered: [
      "按用户、来源、关联ID和提交时间筛选并20条分页",
      "模板字段逐项安全文本展示，不执行HTML或加载外部图片",
      "最多5000条的CSV导出并防止公式注入",
      "含手机号的响应设置 private, no-store",
    ],
    remaining: ["需对生产提交量、历史异常JSON和受限角色做只读验收"],
    evidence: [
      "view/admin-ts/src/pages/config/SystemForms.vue",
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/controllers/api/v1/AdminCrudController.ts",
    ],
  },
  "/admin/setting/system_config": {
    status: "partial",
    targetScreens: [
      "/config",
      "/config/commerce",
      "/config/newcomer",
      "/config/runtime-content",
    ],
    targetApis: [
      "GET|POST /adminapi/config/commerce",
      "GET|POST /adminapi/config/user/register",
      "GET|POST /adminapi/config/runtime_content",
    ],
    covered: [
      "以字段白名单拆分商城运行、新人运营与客户端内容三类专用设置",
      "服务端 config.view/config.manage 权限隔离",
      "通用配置页不读取整表或返回支付、微信及第三方凭据",
    ],
    remaining: [
      "旧动态配置分类仍有大量业务域未逐项迁移",
      "通用配置分类和任意键编辑器因越权覆盖与凭据泄露风险保持停用",
    ],
    evidence: [
      "view/admin-ts/src/pages/ConfigList.vue",
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/config/NewcomerSettings.vue",
      "view/admin-ts/src/pages/config/RuntimeContent.vue",
    ],
  },
  "/admin/setting/shop/base": {
    status: "candidate",
    targetScreens: ["/config/commerce（基础设置）"],
    targetApis: [
      "GET|POST /adminapi/config/commerce",
      "GET /api/site_config",
      "GET /api/share",
    ],
    covered: [
      "站点开关、名称、HTTPS 地址、联系电话和备案号",
      "四类品牌图片、登录轮播图、favicon、悬浮菜单、短视频、商品列表视频和海报标题",
      "素材中心选择/上传后只保存稳定R2引用，公开消费时生成短期签名",
      "Admin登录页消费轮播图与登录LOGO，Admin和PC动态应用favicon与站点品牌",
      "微信分享三字段由新版/api/share提供，并由UniApp首页分享钩子及PC元信息消费",
      "管理员登录使用4 KiB正文上限、来源/账号双层Durable Object限流和统一失败响应",
      "固定12位新管理员密码/bcrypt cost 12、响应安全头及字段白名单取代旧可编辑过滤开关",
      "HTTPS/站内素材路径校验、短事务、回读、审计与配置缓存失效",
    ],
    remaining: ["需在发布后用生产历史素材引用、真实微信分享与限流响应做只读/端到端验收"],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/Login.vue",
      "view/pc-ts/src/layouts/DefaultLayout.vue",
      "view/uniapp-ts/src/pages/index/index.vue",
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
      "workers-ts/src/services/system/PublicBrandingService.ts",
      "workers-ts/src/middleware/admin-login-security.ts",
      "workers-ts/src/middleware/security-headers.ts",
    ],
  },
  "/admin/setting/shop/product": {
    status: "candidate",
    targetScreens: ["/config/commerce（商品与交易）", "/product"],
    targetApis: ["GET|POST /adminapi/config/commerce", "GET /adminapi/product/list?status=5"],
    covered: [
      "警戒库存阈值读写",
      "阈值变更时同步重算商品和普通 SKU 的 is_police，并同步 is_sold",
      "原商品 status=5 库存预警筛选契约保持可执行",
    ],
    remaining: ["需在获批窗口对生产商品量验证 5 秒事务上限"],
    evidence: [
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
      "workers-ts/src/models/searchers/product.ts",
    ],
  },
  "/admin/setting/document": {
    status: "candidate",
    targetScreens: ["/setting/print"],
    targetApis: [
      "GET /adminapi/print/list",
      "GET /adminapi/print/form/:id",
      "POST /adminapi/print/save/:id",
      "POST|PUT /adminapi/print/set_status/:id/:status",
      "DELETE /adminapi/print/del/:id",
    ],
    covered: [
      "名称关键词和打印平台筛选",
      "15 条分页",
      "新增、编辑、启停、删除和就绪状态",
      "平台作用域 supplier_id=0 与供应商作用域隔离",
      "提供商密钥只写不回显",
    ],
    remaining: ["需在获批窗口对生产 Hyperdrive 做只读数据形状核验"],
    evidence: [
      "view/admin-ts/src/pages/setting/PrintOperations.vue",
      "workers-ts/src/services/system/PrintDocumentManagementService.ts",
    ],
  },
  "/admin/setting/document/config": {
    status: "retired",
    targetScreens: [],
    targetApis: [],
    covered: ["确认旧页面是误复制的商品规格代码，不是可工作的单据设置"],
    remaining: [],
    evidence: [
      "legacy component imports productSpecsList but calls undefined isShowApi/userLabelAddApi and deletes product/specs/:id",
    ],
  },
  "/admin/setting/document/content": {
    status: "candidate",
    targetScreens: ["/setting/print（打印内容弹窗）"],
    targetApis: [
      "GET /adminapi/print/content/:id",
      "POST /adminapi/print/save_content/:id",
    ],
    covered: [
      "标题、配送、备注、商品、运费、优惠、支付、订单、自定义内容开关",
      "规格编码依赖商品明细",
      "二维码站内路径和 50 字底部提示",
      "小票实时预览",
    ],
    remaining: ["需用真实打印机做物理小票版式验收"],
    evidence: [
      "view/admin-ts/src/pages/setting/PrintOperations.vue",
      "workers-ts/src/services/system/PrintDocumentManagementService.ts",
    ],
  },
  "/admin/setting/shop/trade": {
    status: "candidate",
    targetScreens: ["/config/commerce（商品与交易）", "/refund", "UniApp /pages/order/refundDetail"],
    targetApis: ["GET|POST /adminapi/config/commerce", "GET /adminapi/refund/detail/:id", "GET /api/order/refund/detail/:id"],
    covered: [
      "7 类未支付/临期小时、自动收货、自动评价和售后期限",
      "退货理由及退货收货人、电话、地址兼容字段",
      "订单取消策略、定时维护、售后期限和退货理由已消费对应配置",
      "次卡按上海时区扫描临期与过期窗口，经Queue、事务外箱及幂等投递发送短信和站内信",
      "次卡提醒沿用旧is_advent_sms/is_expire_sms标志及reminder_brink_death/expiration_reminder通知标识",
      "售后详情按门店、供应商、平台顺序解析退货收件信息，并在新版Admin和UniApp状态4/5展示",
    ],
    remaining: [
      "生产当前无次卡行、提醒配置及两类通知模板，无法验证真实临期/过期投递与失败重试",
      "生产3条有效售后均为平台范围但没有状态4/5，且平台退货姓名、电话、地址均未配置",
      "需配置生产通知/退货信息，并用真实短信、Queue、平台/门店/供应商售后及受限角色完成E2E",
    ],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/refund/RefundList.vue",
      "view/uniapp-ts/src/pages/order/refundDetail.vue",
      "workers-ts/src/services/payment/OrderPaymentPolicy.ts",
      "workers-ts/src/services/order/ScheduledMaintenanceService.ts",
      "workers-ts/src/services/order/SecondCardReminderService.ts",
      "workers-ts/src/services/order/OrderNotificationOutboxService.ts",
      "workers-ts/src/services/order/RefundReturnContactService.ts",
      "workers-ts/src/services/order/StoreOrderRefundService.ts",
      "workers-ts/migrations/0129_second_card_reminder_indexes.sql",
      "workers-ts/test/integration/SecondCardReminderAuditWorker.ts",
      "workers-ts/test/second-card-reminder-migration.test.ts",
    ],
  },
  "/admin/setting/shop/pay": {
    status: "partial",
    targetScreens: ["/config/commerce（支付设置）"],
    targetApis: ["GET|POST /adminapi/config/commerce"],
    covered: [
      "余额功能、余额支付、微信、支付宝和线下支付业务开关",
      "同时展示数据库开关与当前 Worker Secret 组合后的实际可用状态",
      "页面、响应和操作日志均不包含支付私钥、证书或 API Key",
    ],
    remaining: [
      "微信商户号和证书序列号仍需受控配置入口或部署期注入策略",
      "旧 pay_routine_open/pay_routine_mchid 分支尚未形成新版明确契约",
      "密钥输入从 Admin 退休，继续由 Cloudflare Secret 管理",
    ],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "workers-ts/src/services/payment/PaymentReadinessService.ts",
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
    ],
  },
  "/admin/setting/shop/agreemant": {
    status: "candidate",
    targetScreens: ["/config/runtime-content（政策与入驻协议）"],
    targetApis: [
      "GET /adminapi/setting/get_user_agreement/:type",
      "POST /adminapi/setting/set_user_agreement/:type",
      "GET|POST /adminapi/config/runtime_content",
    ],
    covered: [
      "隐私、用户、注销、供应商入驻和代理商入驻五类协议",
      "兼容旧 user_agreement/:type 公共读取契约",
      "Admin 不执行或 v-html 预览协议 HTML",
    ],
    remaining: ["需在获批窗口对生产 legacy_cache 五类键做只读形状核验"],
    evidence: [
      "view/admin-ts/src/pages/config/RuntimeContent.vue",
      "workers-ts/src/services/system/LegacyContentService.ts",
    ],
  },
  "/admin/setting/shop/division": {
    status: "candidate",
    targetScreens: ["/config/commerce（事业部）", "/division"],
    targetApis: [
      "GET|POST /adminapi/config/commerce",
      "GET /adminapi/agent/division/list",
      "GET /adminapi/agent/division/apply/list",
    ],
    covered: [
      "事业部团队和代理商自助申请两个旧开关",
      "关闭团队时禁止保存开启的申请开关",
      "客户端入口按两个开关和当前用户事业部身份共同判定",
      "事业部成员、代理商、员工、分佣与申请审核使用独立管理页",
    ],
    remaining: ["需在获批窗口对生产开关与已有事业部角色做只读一致性核验"],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "view/admin-ts/src/pages/agent/DivisionManagement.vue",
      "workers-ts/src/services/product/PublicCatalogService.ts",
    ],
  },
  "/admin/setting/notification/index": {
    status: "partial",
    targetScreens: ["/setting/notification"],
    targetApis: [
      "GET /adminapi/notification/order-config",
      "GET /adminapi/notification/list",
      "GET /adminapi/notification/deliveries",
    ],
    covered: ["四类订单通知渠道矩阵、提供商模板目录与持久投递台账"],
    remaining: [
      "旧 system_notification type=1 会员消息目录",
      "旧 system_notification type=2 平台消息目录",
      "短信、公众号、模板消息和企业微信渠道总览",
    ],
    evidence: [
      "view/admin-ts/src/pages/setting/NotificationList.vue",
      "workers-ts/src/services/order/OrderNotificationAdminService.ts",
    ],
  },
  "/admin/setting/notification/notificationEdit": {
    status: "partial",
    targetScreens: ["/setting/notification"],
    targetApis: [
      "PUT /adminapi/notification/order-config/:mark",
      "POST /adminapi/notification/save",
    ],
    covered: ["四类订单通知的站内、短信、微信开关编辑"],
    remaining: [
      "按旧消息目录逐项编辑",
      "企业微信渠道编辑",
      "远端模板同步的安全替代流程",
    ],
    evidence: [
      "view/admin-ts/src/pages/setting/NotificationList.vue",
      "workers-ts/src/services/order/OrderNotificationAdminService.ts",
    ],
  },
};

const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as Inventory;
const legacyRoutes = inventory.legacy.routes.filter((route) => (
  route.surface === "page" && route.path.startsWith("/admin/setting")
));
if (legacyRoutes.length !== 76) {
  throw new Error(`Expected 76 legacy setting business routes, found ${legacyRoutes.length}`);
}
if (new Set(legacyRoutes.map((route) => route.path)).size !== legacyRoutes.length) {
  throw new Error("Legacy setting route inventory contains duplicate paths");
}

const routes = legacyRoutes.map((route) => {
  const review = reviews[route.path] ?? {
    status: "unreviewed" as const,
    targetScreens: [],
    targetApis: [],
    covered: [],
    remaining: ["尚未逐屏比对旧页面、接口、权限、数据边界与交互"],
    evidence: [],
  };
  return {
    legacy: {
      path: route.path,
      title: route.title,
      component: route.component,
      source: `${route.source}:${route.line}`,
    },
    ...review,
  };
});

const statuses: Status[] = ["candidate", "partial", "missing", "retired", "unreviewed"];
const statusCounts = Object.fromEntries(statuses.map((status) => [
  status,
  routes.filter((route) => route.status === status).length,
])) as Record<Status, number>;
const report = {
  version: 1,
  generatedFrom: "audit/admin-frontend-inventory.json",
  methodology: {
    scope: "Legacy Admin business-page routes under /admin/setting.",
    status: {
      candidate: "Local code and UI evidence cover the reviewed legacy workflow; production verification may remain.",
      partial: "A useful subset exists, but material legacy workflow or channel coverage is absent.",
      missing: "Reviewed route has no viable target replacement.",
      retired: "Reviewed legacy route is intentionally not migrated because it is broken, duplicated, or obsolete.",
      unreviewed: "Inventory only; no semantic parity conclusion has been made.",
    },
    productionAccess: "A token-protected temporary Worker used the configured Hyperdrive for REPEATABLE READ / READ ONLY aggregate and EXPLAIN checks, then applied the bounded second-card outbox whitelist and two partial indexes after size/event preconditions; it verified an idempotent second pass and unchanged business-row aggregates, and was deleted. No main Worker or frontend was deployed.",
  },
  summary: {
    legacyRoutes: routes.length,
    reviewed: routes.length - statusCounts.unreviewed,
    ...statusCounts,
  },
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
