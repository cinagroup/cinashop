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
