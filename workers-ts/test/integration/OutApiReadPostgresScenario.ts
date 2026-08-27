import { sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  expressCompany,
  outAccount,
  outInterface,
  storeCouponIssue,
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderRefund,
  systemUserLevel,
  user,
} from "@/models/schema";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { AuthException } from "@/utils/errors";

const CLONED_TABLES = [
  "out_account",
  "out_interface",
  "store_order",
  "store_order_cart_info",
  "store_order_invoice",
  "store_order_refund",
  "express_company",
  "store_coupon_issue",
  "system_user_level",
  "user",
] as const;

const PUBLIC_PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  out_account: "id",
  out_interface: "id",
  store_order: "id",
  store_order_cart_info: "id",
  store_order_invoice: "id",
  store_order_refund: "id",
  express_company: "id",
  store_coupon_issue: "id",
  system_user_level: "id",
  user: "uid",
};

const ROUTES = [
  [1, "/outapi/order/list", "/order/list"],
  [2, "/outapi/order/<order_id>", "/order/{order_id}"],
  [3, "/outapi/order/express_list", "/order/express_list"],
  [4, "/outapi/order/split_cart_info/:order_id", "/order/split_cart_info/{order_id}"],
  [5, "/outapi/refund/list", "/refund/list"],
  [6, "/outapi/refund/:order_id", "/refund/{order_id}"],
  [7, "/outapi/coupon/list", "/coupon/list"],
  [8, "/outapi/user_level/list", "/user_level/list"],
  [9, "/outapi/user/list", "/user/list"],
  [10, "/outapi/user/info/:uid", "/user/info/{uid}"],
] as const;

interface PublicFingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface OutApiReadPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  acl: {
    allowed_routes: number;
    missing_permission_rejected: boolean;
  };
  orders: {
    visible: number;
    deleted_hidden: boolean;
    items: number;
    worker_snapshot_parsed: boolean;
    php_snapshot_parsed: boolean;
    private_fields_present: boolean;
    invoice_present: boolean;
    status_name: string;
    date_filter_matched: boolean;
    split_rows: number;
    express_rows: number;
  };
  refunds: {
    visible: number;
    selected_items: number;
    selected_cart_only: boolean;
    detail_matched: boolean;
  };
  catalog: {
    coupons: number;
    coupon_time: string;
    levels: number;
  };
  users: {
    visible: number;
    deleted_hidden: boolean;
    detail_matched: boolean;
    pii_contract_present: boolean;
    credential_fields_absent: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out API read integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_read_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicFingerprint(db: DbClient): Promise<PublicFingerprint> {
  const tables: PublicFingerprint["tables"] = {};
  for (const table of CLONED_TABLES) {
    const key = identifier(PUBLIC_PRIMARY_KEYS[table]);
    const rows = await db.$client.unsafe<Array<{ count: string; max_id: string | null; digest: string }>>(
      `SELECT count(*)::text AS count,
        max(t.${key})::text AS max_id,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.${key}), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const names = CLONED_TABLES.map((table) => `${table}_${PUBLIC_PRIMARY_KEYS[table]}_seq`);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names})
    ORDER BY sequencename
  `;
  const values = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(names.map((name) => [name, values.get(name) ?? null])),
  };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const name = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`);
    }
  });
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(outInterface).values(ROUTES.map(([id, url]) => ({
    id,
    pid: 0,
    type: 1,
    name: `out-read-${id}`,
    method: "GET",
    url,
    isDel: 0,
  })));
  await container.db.insert(outAccount).values({
    id: 1,
    appid: "out-read-audit",
    appsecret: "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS",
    apppwd: "legacy-plaintext-must-not-be-used",
    title: "Out read audit",
    status: 1,
    rules: JSON.stringify(ROUTES.map(([id]) => id)),
    isDel: 0,
  });
  await container.db.insert(storeOrder).values([
    {
      id: 101,
      orderId: "audit-order-visible",
      tradeNo: "audit-trade-visible",
      uid: 401,
      realName: "审计收货人",
      userPhone: "13000000001",
      userAddress: "隔离 schema 1号",
      totalNum: 2,
      totalPrice: "29.75",
      payPrice: "27.75",
      couponPrice: "2.00",
      paid: 1,
      payType: "weixin",
      payTime: now - 30,
      addTime: now - 60,
      status: 1,
      shippingType: 1,
      deliveryType: "express",
      deliveryName: "审计快递",
      deliveryCode: "AUDIT",
      deliveryId: "AUDIT-TRACK-1",
      unique: "out-read-visible",
      storeId: 0,
      isDel: 0,
      isSystemDel: 0,
    },
    {
      id: 102,
      orderId: "audit-order-deleted",
      uid: 402,
      realName: "已删除订单",
      userPhone: "13000000002",
      totalNum: 1,
      totalPrice: "1.00",
      payPrice: "1.00",
      addTime: now,
      unique: "out-read-deleted",
      storeId: 0,
      isDel: 1,
      isSystemDel: 0,
    },
  ]);
  await container.db.insert(storeOrderCartInfo).values([
    {
      id: 201,
      oid: 101,
      uid: 401,
      cartId: "501",
      productId: 701,
      skuUnique: "WORKER01",
      cartNum: 1,
      surplusNum: 1,
      splitSurplusNum: 1,
      unique: "outreadcartworker000000000000001",
      cartInfo: JSON.stringify({
        product: { storeName: "Worker 快照商品", image: "worker.png" },
        sku: { suk: "蓝色", price: "12.50" },
      }),
    },
    {
      id: 202,
      oid: 101,
      uid: 401,
      cartId: "502",
      productId: 702,
      skuUnique: "LEGACY01",
      cartNum: 1,
      surplusNum: 1,
      splitSurplusNum: 1,
      unique: "outreadcartlegacy000000000000001",
      cartInfo: JSON.stringify({
        productInfo: {
          store_name: "PHP 快照商品",
          image: "php.png",
          attrInfo: { suk: "红色", price: "17.25" },
        },
      }),
    },
  ]);
  await container.db.insert(storeOrderInvoice).values({
    id: 301,
    uid: 401,
    orderId: 101,
    invoiceId: 1,
    name: "审计发票",
    dutyNumber: "AUDIT-TAX-1",
    email: "audit@example.invalid",
    cardNumber: "AUDIT-INVOICE-ACCOUNT",
    isDel: 0,
  });
  await container.db.insert(storeOrderRefund).values({
    id: 351,
    storeOrderId: 101,
    orderId: "audit-refund-visible",
    uid: 401,
    applyType: 2,
    applyPrice: "17.25",
    refundType: 4,
    refundNum: 1,
    refundPrice: "17.25",
    refundPhone: "13000000001",
    refundReason: "隔离审计",
    cartInfo: JSON.stringify({ cartIds: [202] }),
    isCancel: 0,
    isDel: 0,
    addTime: now,
  });
  await container.db.insert(expressCompany).values({
    id: 361,
    code: "AUDIT",
    name: "审计快递",
    sort: 10,
    isShow: 1,
    status: 1,
  });
  await container.db.insert(storeCouponIssue).values({
    id: 371,
    couponTitle: "审计优惠券",
    couponType: 1,
    type: 1,
    couponPrice: "5.00",
    useMinPrice: "20.00",
    day: 7,
    status: 1,
    isDel: 0,
    sort: 10,
  });
  await container.db.insert(systemUserLevel).values({
    id: 381,
    name: "审计会员",
    grade: 1,
    discount: "90.00",
    isShow: 1,
    isDel: 0,
  });
  await container.db.insert(user).values([
    {
      uid: 401,
      account: "out-read-user",
      pwd: "credential-must-not-leak",
      cardId: "card-id-secret",
      addIp: "192.0.2.10",
      lastIp: "192.0.2.11",
      uniqid: "uniqid-must-not-leak",
      barCode: "barcode-must-not-leak",
      randCode: 987654,
      realName: "审计用户",
      nickname: "Out Read Audit",
      phone: "13000000001",
      nowMoney: "88.00",
      brokeragePrice: "9.00",
      integral: 100,
      status: 1,
      level: 381,
      isDel: 0,
    },
    {
      uid: 402,
      account: "deleted-out-user",
      nickname: "已删除用户",
      phone: "13000000002",
      status: 1,
      isDel: 1,
    },
  ]);
}

async function runReads(container: Container) {
  const service = new OutApiService(container, {} as Env);
  const account: AuthenticatedOutAccount = {
    id: 1,
    appid: "out-read-audit",
    title: "Out read audit",
    rules: ROUTES.map(([id]) => id),
  };
  let allowed = 0;
  for (const [, , route] of ROUTES) {
    await service.assertInterfacePermission(account, "GET", route);
    allowed += 1;
  }
  let denied = false;
  try {
    await service.assertInterfacePermission(account, "GET", "/product/list");
  } catch (error) {
    denied = error instanceof AuthException;
  }

  const now = Math.floor(Date.now() / 1_000);
  const [orders, order, filteredOrders, splitRows, expressRows] = await Promise.all([
    service.orderList({ page: 1, limit: 1_000, keyword: "audit-order" }),
    service.orderInfo("audit-order-visible"),
    service.orderList({ start_time: now - 600, end_time: now + 600, paid: 1 }),
    service.splitCartInfo("audit-order-visible"),
    service.expressList(),
  ]);
  const [refunds, refund, coupons, levels, users, userInfo] = await Promise.all([
    service.refundList({ page: 1, limit: 1_000, order_id: "audit-refund" }),
    service.refundInfo("audit-refund-visible"),
    service.couponList({ page: 1, limit: 1_000, coupon_title: "审计" }),
    service.userLevelList({ page: 1, limit: 1_000, title: "审计" }),
    service.userList({ page: 1, limit: 1_000, uid: "401,402" }),
    service.userInfo(401),
  ]);

  const orderItems = order.items;
  const userText = JSON.stringify({ users, userInfo });
  const secrets = [
    "credential-must-not-leak",
    "card-id-secret",
    "192.0.2.10",
    "192.0.2.11",
    "uniqid-must-not-leak",
    "barcode-must-not-leak",
    "987654",
  ];
  const result = {
    acl: {
      allowed_routes: allowed,
      missing_permission_rejected: denied,
    },
    orders: {
      visible: orders.count,
      deleted_hidden: orders.count === 1 && orders.list.every((entry) => entry.order_id !== "audit-order-deleted"),
      items: orderItems.length,
      worker_snapshot_parsed: orderItems.some((item) => item.store_name === "Worker 快照商品" && item.price === "12.50"),
      php_snapshot_parsed: orderItems.some((item) => item.store_name === "PHP 快照商品" && item.price === "17.25"),
      private_fields_present: order.user_phone === "13000000001" && order.user_address === "隔离 schema 1号",
      invoice_present: order.invoice?.duty_number === "AUDIT-TAX-1",
      status_name: order.status_name,
      date_filter_matched: filteredOrders.count === 1,
      split_rows: splitRows.length,
      express_rows: expressRows.length,
    },
    refunds: {
      visible: refunds.count,
      selected_items: refund.items.length,
      selected_cart_only: refund.items.length === 1 && refund.items[0]?.cart_id === "502",
      detail_matched: refund.order_id === "audit-refund-visible" && refund.refund_type_name === "同意退货",
    },
    catalog: {
      coupons: coupons.count,
      coupon_time: String(coupons.list[0]?.coupon_time ?? ""),
      levels: levels.count,
    },
    users: {
      visible: users.count,
      deleted_hidden: users.count === 1 && users.list[0]?.uid === 401,
      detail_matched: userInfo.data.uid === 401,
      pii_contract_present: users.list[0]?.phone === "13000000001" && users.list[0]?.now_money === "88.00",
      credential_fields_absent: secrets.every((secret) => !userText.includes(secret)),
    },
  };

  assertCondition(result.acl.allowed_routes === ROUTES.length, "not every read route passed ACL matching");
  assertCondition(result.acl.missing_permission_rejected, "missing route permission was accepted");
  assertCondition(result.orders.visible === 1 && result.orders.deleted_hidden, "order visibility diverged");
  assertCondition(result.orders.items === 2, "order cart projection is incomplete");
  assertCondition(result.orders.worker_snapshot_parsed && result.orders.php_snapshot_parsed, "cart snapshot compatibility diverged");
  assertCondition(result.orders.private_fields_present && result.orders.invoice_present, "authorized order contract is incomplete");
  assertCondition(result.orders.status_name === "待收货", "order status label diverged");
  assertCondition(result.orders.date_filter_matched && result.orders.split_rows === 2, "order filters or split list diverged");
  assertCondition(result.orders.express_rows === 1, "express list diverged");
  assertCondition(result.refunds.visible === 1 && result.refunds.selected_cart_only && result.refunds.detail_matched, "refund projection diverged");
  assertCondition(result.catalog.coupons === 1 && result.catalog.coupon_time === "7天" && result.catalog.levels === 1, "coupon or level list diverged");
  assertCondition(result.users.visible === 1 && result.users.deleted_hidden && result.users.detail_matched, "user visibility diverged");
  assertCondition(result.users.pii_contract_present && result.users.credential_fields_absent, "user projection leaked credentials or lost required PII");
  return result;
}

export async function runOutApiReadPostgresScenario(
  connectionString: string,
): Promise<OutApiReadPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_read_audit_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_out_read_audit_main",
  });
  let created = false;
  let removed = false;
  let before: PublicFingerprint | undefined;
  let after: PublicFingerprint | undefined;
  let temporarySchemasAfter = -1;
  let readReport: Awaited<ReturnType<typeof runReads>> | undefined;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await publicFingerprint(root);
    await setupSchema(root, schemaName);
    created = true;
    await withSchema(scoped, schemaName, (container) => seed(container));
    readReport = await withSchema(scoped, schemaName, (container) => runReads(container));
  } finally {
    try {
      if (created) {
        await root.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const state = await root.$client<{ schema_removed: boolean; prefix_count: number }[]>`
        SELECT
          to_regnamespace(${schemaName}) IS NULL AS schema_removed,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_read_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      temporarySchemasAfter = state[0]?.prefix_count ?? -1;
      after = await publicFingerprint(root);
    } finally {
      await Promise.all([
        root.$client.end({ timeout: 1 }),
        scoped.$client.end({ timeout: 1 }),
      ]);
    }
  }
  assertCondition(readReport, "read report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(removed, "temporary schema was not removed");
  assertCondition(temporarySchemasAfter === 0, "temporary schema prefix has leftovers");
  assertCondition(unchanged, "public tables or sequences changed during isolated scenario");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: temporarySchemasAfter,
    public_state_unchanged: unchanged,
    ...readReport,
  };
}
