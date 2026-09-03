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
    status: "partial",
    targetScreens: [],
    targetApis: [
      "GET /adminapi/form/index",
      "GET /adminapi/form/info/:id",
      "POST /adminapi/form/save/:id",
      "POST /adminapi/form/update_name/:id",
      "GET /adminapi/form/set_show/:id/:is_show",
      "DELETE /adminapi/form/del/:id",
      "GET /adminapi/form/data/:id",
    ],
    covered: [
      "系统表单定义、组件白名单、提交数据校验和订单不可变快照已迁移",
      "后台 CRUD、启停、数据列表及商品选择接口已迁移",
    ],
    remaining: ["新版 Admin 尚无系统表单列表、拖拽编辑器和提交数据查看页面"],
    evidence: [
      "workers-ts/src/services/system/SystemMetadataService.ts",
      "workers-ts/src/services/order/OrderSystemFormService.ts",
      "workers-ts/test/system-form-migration.test.ts",
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
    status: "partial",
    targetScreens: ["/config/commerce（基础设置）"],
    targetApis: ["GET|POST /adminapi/config/commerce"],
    covered: [
      "站点开关、名称、HTTPS 地址、联系电话和备案号",
      "四类品牌图片地址、悬浮菜单、短视频、商品列表视频和海报标题",
      "HTTPS/站内素材路径校验、短事务、回读、审计与配置缓存失效",
    ],
    remaining: [
      "旧后台轮播登录图和 favicon 上传流程",
      "微信分享三字段尚无新版消费者",
      "旧密码策略和 PHP 参数过滤器尚未由 Worker 原生安全策略替代",
    ],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "workers-ts/src/services/system/AdminCommerceSettingsService.ts",
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
    status: "partial",
    targetScreens: ["/config/commerce（商品与交易）"],
    targetApis: ["GET|POST /adminapi/config/commerce"],
    covered: [
      "7 类未支付/临期小时、自动收货、自动评价和售后期限",
      "退货理由及退货收货人、电话、地址兼容字段",
      "订单取消策略、定时维护、售后期限和退货理由已消费对应配置",
    ],
    remaining: [
      "次卡临期提醒尚无 Worker 消费者",
      "新版订单详情尚未展示平台退货收货人、电话和地址",
    ],
    evidence: [
      "view/admin-ts/src/pages/config/CommerceSettings.vue",
      "workers-ts/src/services/payment/OrderPaymentPolicy.ts",
      "workers-ts/src/services/order/ScheduledMaintenanceService.ts",
      "workers-ts/src/services/order/StoreOrderRefundService.ts",
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
    productionAccess: "Not used. This report is based on local source, static checks, tests, and preview QA.",
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
