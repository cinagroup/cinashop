import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import { KefuOrderService } from "@/services/kefu/KefuOrderService";
import { MigrationService } from "@/services/MigrationService";

const TABLES = [
  "store_service_record",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "user",
  "store_product",
  "store_order_invoice",
  "store_order_promotions",
] as const;

const INDEXES = [
  "so_kefu_customer_orders",
  "sor_kefu_customer_refunds",
] as const;

interface Fingerprint {
  count: number;
  digest: string;
}

interface ProductionSummary {
  sessions: number;
  orders: number;
  visible_root_orders: number;
  order_items: number;
  refunds: number;
  users: number;
  invoices: number;
  promotions: number;
}

export interface KefuOrderPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  production: ProductionSummary;
  isolated: Record<string, boolean>;
}

export interface KefuOrderIndexReport {
  server_version: string;
  indexes: string[];
  second_apply_idempotent: boolean;
  public_state_unchanged: boolean;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Kefu order integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_kefu_order_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicFingerprints(db: DbClient) {
  const result: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const row = (await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::int AS count,
             COALESCE(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM public.${identifier(table)} AS t
    `))[0];
    assertCondition(row, `could not fingerprint public.${table}`);
    result[table] = row;
  }
  return result;
}

async function productionSummary(db: DbClient): Promise<ProductionSummary> {
  const row = (await db.$client<Array<ProductionSummary>>`
    SELECT
      (SELECT count(*)::int FROM public.store_service_record) AS sessions,
      (SELECT count(*)::int FROM public.store_order) AS orders,
      (SELECT count(*)::int FROM public.store_order
        WHERE is_system_del = 0 AND is_del = 0 AND store_id = 0 AND pid = 0
          AND refund_type IN (0, 1, 3, 6)) AS visible_root_orders,
      (SELECT count(*)::int FROM public.store_order_cart_info) AS order_items,
      (SELECT count(*)::int FROM public.store_order_refund) AS refunds,
      (SELECT count(*)::int FROM public."user") AS users,
      (SELECT count(*)::int FROM public.store_order_invoice) AS invoices,
      (SELECT count(*)::int FROM public.store_order_promotions) AS promotions
  `)[0];
  assertCondition(row, "production summary returned no row");
  return row;
}

async function setupSchema(db: DbClient, schemaName: string) {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await tx.unsafe(`CREATE TABLE ${schema}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
    }
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service_record
        (id, user_id, to_uid, nickname, avatar, is_tourist, online, type, add_time, update_time, mssage_num, message, message_type)
      VALUES
        (1, 1001, 2001, '审计客户一', '', 0, 1, 1, 1700000000, 1700000100, 0, '', 1),
        (2, 1002, 2002, '审计客户二', '', 0, 1, 1, 1700000000, 1700000100, 0, '', 1)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}."user"
        (uid, account, pwd, real_name, nickname, avatar, phone, group_id, now_money, integral, spread_uid, status)
      VALUES
        (2001, 'audit-customer-1', 'private-password-hash', '审计客户一', '审计客户一', '', '13900002001', 2, 88.50, 168, 0, 1),
        (2002, 'audit-customer-2', 'foreign-password-hash', '审计客户二', '审计客户二', '', '13900002002', 1, 10.00, 8, 0, 1)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product
        (id, pid, store_name, keyword, image, slider_image, price, vip_price, ot_price, stock, sales, sort, is_show, is_del)
      VALUES
        (101, 0, 'Audit Travel Cup', 'cup', '/cup.png', '[]', 79.00, 71.10, 99.00, 20, 10, 3, 1, 0),
        (102, 0, 'Audit Pillow', 'pillow', '/pillow.png', '[]', 49.90, 44.91, 69.00, 12, 8, 2, 1, 0),
        (103, 0, 'Audit Storage Bag', 'bag', '/bag.png', '[]', 35.00, 31.50, 45.00, 9, 6, 1, 1, 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order
        (id, order_id, uid, real_name, user_phone, user_address, total_num, total_price, pay_price,
         paid, status, shipping_type, pay_type, pay_time, add_time, refund_status, refund_type,
         delivery_type, remark, is_del, is_system_del, store_id, pid, "unique", verify_code, user_ip)
      VALUES
        (301, 'audit-order-paid', 2001, '审计客户一', '13900002001', '审计地址一号', 1, 79.00, 79.00,
         1, 0, 1, 'weixin', 1700000510, 1700000500, 0, 0, 'express', '优先发货', 0, 0, 0, 0, 'audit-order-key-301', 'SECRET301', '10.0.0.1'),
        (302, 'audit-order-refund', 2001, '审计客户一', '13900002001', '审计地址一号', 1, 49.90, 44.91,
         1, 0, 1, 'yue', 1700000610, 1700000600, 1, 1, 'express', '', 0, 0, 0, 0, 'audit-order-key-302', 'SECRET302', '10.0.0.2'),
        (303, 'audit-order-unpaid', 2001, '审计客户一', '13900002001', '审计地址一号', 1, 35.00, 35.00,
         0, 0, 1, 'weixin', 0, 1700000700, 0, 0, 'express', '', 0, 0, 0, 0, 'audit-order-key-303', 'SECRET303', '10.0.0.3'),
        (304, 'audit-order-hidden', 2001, '审计客户一', '13900002001', '审计地址一号', 1, 79.00, 79.00,
         1, 0, 1, 'weixin', 1700000810, 1700000800, 0, 0, 'express', '', 0, 1, 0, 0, 'audit-order-key-304', 'SECRET304', '10.0.0.4'),
        (305, 'audit-order-foreign', 2002, '审计客户二', '13900002002', '审计地址二号', 1, 79.00, 79.00,
         1, 0, 1, 'weixin', 1700000910, 1700000900, 0, 0, 'express', '', 0, 0, 0, 0, 'audit-order-key-305', 'SECRET305', '10.0.0.5'),
        (306, 'audit-order-store', 2001, '审计客户一', '13900002001', '审计地址一号', 1, 79.00, 79.00,
         1, 0, 1, 'weixin', 1700001010, 1700001000, 0, 0, 'express', '', 0, 0, 9, 0, 'audit-order-key-306', 'SECRET306', '10.0.0.6'),
        (307, 'audit-order-child', 2001, '审计客户一', '13900002001', '审计地址一号', 1, 79.00, 79.00,
         1, 0, 1, 'weixin', 1700001110, 1700001100, 0, 0, 'express', '', 0, 0, 0, 301, 'audit-order-key-307', 'SECRET307', '10.0.0.7')
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_cart_info
        (id, uid, oid, cart_id, product_id, sku_unique, cart_num, refund_num, surplus_num, cart_info, "unique", add_time)
      VALUES
        (401, 2001, 301, '501', 101, 'red', 1, 0, 1,
         '{"productInfo":{"id":101,"store_name":"Audit Travel Cup","image":"/cup.png","price":"79.00","attrInfo":{"suk":"Red","image":"/cup.png","price":"79.00"}},"truePrice":"79.00","vip_truePrice":"0.00"}',
         'audit-cart-401', 1700000500),
        (402, 2001, 302, '502', 102, 'gray', 1, 1, 0,
         '{"productInfo":{"id":102,"store_name":"Audit Pillow","image":"/pillow.png","price":"49.90","attrInfo":{"suk":"Gray","image":"/pillow.png","price":"49.90"}},"truePrice":"49.90","vip_truePrice":"4.99"}',
         'audit-cart-402', 1700000600),
        (403, 2001, 303, '503', 103, 'blue', 1, 0, 1,
         '{"productInfo":{"id":103,"store_name":"Audit Storage Bag","image":"/bag.png","price":"35.00","attrInfo":{"suk":"Blue","image":"/bag.png","price":"35.00"}},"truePrice":"35.00","vip_truePrice":"0.00"}',
         'audit-cart-403', 1700000700),
        (404, 2002, 305, '504', 101, 'red', 1, 0, 1,
         '{"productInfo":{"id":101,"store_name":"Audit Travel Cup","image":"/cup.png","price":"79.00","attrInfo":{"suk":"Red","image":"/cup.png","price":"79.00"}},"truePrice":"79.00","vip_truePrice":"0.00"}',
         'audit-cart-404', 1700000900)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_refund
        (id, store_order_id, order_id, uid, apply_type, apply_price, refund_type, refund_num,
         refund_price, refunded_price, refund_reason, remark, cart_info, is_cancel, is_del, add_time)
      VALUES
        (901, 302, 'audit-refund-active', 2001, 1, 44.91, 1, 1, 44.91, 0.00, '尺寸不合适', '等待审核',
         '[{"cart_id":"502"}]', 0, 0, 1700001300),
        (902, 301, 'audit-refund-return', 2001, 2, 79.00, 4, 1, 79.00, 0.00, '需要退货', '',
         '[{"cart_id":"501"}]', 0, 0, 1700001200),
        (903, 301, 'audit-refund-done', 2001, 1, 10.00, 6, 1, 10.00, 10.00, '已完成退款', '',
         '[{"cart_id":"501"}]', 0, 0, 1700001100),
        (904, 301, 'audit-refund-cancel', 2001, 1, 9.00, 1, 1, 9.00, 0.00, '已撤销', '',
         '[{"cart_id":"501"}]', 1, 0, 1700001400),
        (905, 305, 'audit-refund-foreign', 2002, 1, 79.00, 1, 1, 79.00, 0.00, '外部客户', '',
         '[{"cart_id":"504"}]', 0, 0, 1700001500),
        (906, 301, 'audit-refund-deleted', 2001, 1, 8.00, 1, 1, 8.00, 0.00, '已删除', '',
         '[{"cart_id":"501"}]', 0, 1, 1700001600)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_invoice
        (id, uid, order_id, invoice_id, name, duty_number, email, invoice_amount, is_del, add_time)
      VALUES (1001, 2001, 301, 1101, '审计抬头', 'AUDIT-TAX', 'audit@example.com', 79.00, 0, 1700000500)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_promotions
        (id, oid, uid, promotions_id, product_id, promotions_price, add_time)
      VALUES (1101, 301, 2001, 1201, 101, 5.00, 1700000500)
    `);
  });
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function indexNames(db: DbClient, schemaName: string): Promise<string[]> {
  const rows = await db.$client<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = ${schemaName}
      AND indexname = ANY(${[...INDEXES]})
    ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'codex_kefu_order_%'
  `)[0]?.count ?? 0;
}

export async function applyKefuOrderIndexes(connectionString: string): Promise<KefuOrderIndexReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_order_index_apply",
  });
  try {
    const before = await publicFingerprints(root);
    const ddl = new MigrationService(createContainerFromDb(root))
      .kefuOrderContextMigrationSqlForVerification();
    const apply = async () => root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL search_path TO public`;
      await tx.unsafe(ddl);
    });
    await apply();
    const first = await indexNames(root, "public");
    await apply();
    const second = await indexNames(root, "public");
    const after = await publicFingerprints(root);
    assertCondition(first.join(",") === [...INDEXES].sort().join(","), `unexpected index set: ${first.join(",")}`);
    assertCondition(JSON.stringify(first) === JSON.stringify(second), "second index apply changed the index set");
    assertCondition(JSON.stringify(before) === JSON.stringify(after), "public business rows changed while applying indexes");
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      indexes: first,
      second_apply_idempotent: true,
      public_state_unchanged: true,
    };
  } finally {
    await root.$client.end({ timeout: 1 });
  }
}

export async function runKefuOrderPostgresScenario(connectionString: string): Promise<KefuOrderPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_order_audit_root",
  });
  const schemaName = randomSchemaName();
  let schemaCreated = false;
  let isolated: DbClient | null = null;
  try {
    const [before, production] = await Promise.all([publicFingerprints(root), productionSummary(root)]);
    await setupSchema(root, schemaName);
    schemaCreated = true;
    isolated = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_kefu_order_audit_isolated",
    });
    const container = createContainerFromDb(isolated);
    const ddl = new MigrationService(container).kefuOrderContextMigrationSqlForVerification();
    await isolated.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${identifier(schemaName)}`);
      await tx.unsafe(ddl);
    });

    const result = await withTx(container, async (tx) => {
      const service = new KefuOrderService(createContainerFromDb(tx));
      const orders = await service.customerOrders(1001, 2001, { limit: "20" });
      const unpaid = await service.customerOrders(1001, 2001, { type: "0", limit: "20" });
      const awaitingShipment = await service.customerOrders(1001, 2001, { type: "1", limit: "20" });
      const productSearch = await service.customerOrders(1001, 2001, { search: "Audit Pillow", limit: "20" });
      const activeRefunds = await service.customerOrders(1001, 2001, { type: "-1", limit: "20" });
      const orderInfo = await service.orderInfo(1001, 301);
      const refundDetail = await service.refundDetail(1001, 901);
      const refundList = await service.refundList(1001, { limit: "20" });
      const foreignListRejected = await rejects(() => service.customerOrders(1001, 2002, {}));
      const foreignOrderRejected = await rejects(() => service.orderInfo(1001, 305));
      const foreignRefundRejected = await rejects(() => service.refundDetail(1001, 905));
      return {
        orders,
        unpaid,
        awaitingShipment,
        productSearch,
        activeRefunds,
        orderInfo,
        refundDetail,
        refundList,
        foreignListRejected,
        foreignOrderRejected,
        foreignRefundRejected,
      };
    });
    const indexes = await indexNames(root, schemaName);
    await isolated.$client.unsafe(`DELETE FROM ${identifier(schemaName)}.store_service_record WHERE user_id = 1001 AND to_uid = 2001`);
    const afterTransfer = await withTx(createContainerFromDb(isolated), async (tx) => {
      const service = new KefuOrderService(createContainerFromDb(tx));
      return {
        listRejected: await rejects(() => service.customerOrders(1001, 2001, {})),
        orderRejected: await rejects(() => service.orderInfo(1001, 301)),
        refundRejected: await rejects(() => service.refundDetail(1001, 901)),
        refundList: await service.refundList(1001, {}),
      };
    });

    const orderIds = result.orders.map((item) => item.id).join(",");
    const activeRefundIds = result.activeRefunds.map((item) => item.id).join(",");
    const serializedOrder = JSON.stringify(result.orderInfo);
    const serializedRefund = JSON.stringify(result.refundDetail);
    const flags = {
      order_list_default_filters_exact: orderIds === "303,302,301",
      php_status_filters_exact:
        result.unpaid.map((item) => item.id).join(",") === "303" &&
        result.awaitingShipment.map((item) => item.id).join(",") === "301",
      product_search_exact: result.productSearch.map((item) => item.id).join(",") === "302",
      type_minus_one_active_refunds_exact: activeRefundIds === "901,902",
      order_detail_contract_safe:
        result.orderInfo.orderInfo.id === 301 && result.orderInfo.orderInfo.invoice?.invoice_id === 1101 &&
        result.orderInfo.orderInfo.promotions_detail?.length === 1 && result.orderInfo.orderInfo.cartInfo.length === 1 &&
        !serializedOrder.includes("verify_code") && !serializedOrder.includes("SECRET301") &&
        !serializedOrder.includes("user_ip") && !serializedOrder.includes("private-password-hash") && !serializedOrder.includes('"pwd"'),
      refund_detail_contract_safe:
        result.refundDetail.orderInfo.id === 901 && result.refundDetail.orderInfo.store_order_sn === "audit-order-refund" &&
        result.refundDetail.orderInfo.cartInfo.length === 1 && !serializedRefund.includes("SECRET302") &&
        !serializedRefund.includes("foreign-password-hash") && !serializedRefund.includes('"pwd"'),
      foreign_customer_closed:
        result.foreignListRejected && result.foreignOrderRejected && result.foreignRefundRejected,
      global_refund_list_assignment_scoped:
        result.refundList.count === 3 && result.refundList.list.map((item) => item.id).join(",") === "901,902,903" &&
        result.refundList.num[1]?.num === 1 && result.refundList.num[4]?.num === 1 && result.refundList.num[6]?.num === 1,
      transfer_revokes_order_context:
        afterTransfer.listRejected && afterTransfer.orderRejected && afterTransfer.refundRejected &&
        afterTransfer.refundList.count === 0 && afterTransfer.refundList.list.length === 0,
      indexes_present: indexes.join(",") === [...INDEXES].sort().join(","),
    };
    for (const [name, value] of Object.entries(flags)) {
      assertCondition(value, `${name}; result=${JSON.stringify(result)} indexes=${indexes.join(",")}`);
    }

    await isolated.$client.end({ timeout: 1 });
    isolated = null;
    await root.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
    schemaCreated = false;
    const after = await publicFingerprints(root);
    const temporarySchemasAfter = await temporarySchemaCount(root);
    assertCondition(JSON.stringify(before) === JSON.stringify(after), "public state changed");
    assertCondition(temporarySchemasAfter === 0, "temporary schema leaked");
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      schema_created: true,
      schema_removed: true,
      temporary_schemas_after: temporarySchemasAfter,
      public_state_unchanged: true,
      production,
      isolated: flags,
    };
  } finally {
    if (isolated) await isolated.$client.end({ timeout: 1 }).catch(() => undefined);
    if (schemaCreated) {
      await root.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`).catch(() => undefined);
    }
    await root.$client.end({ timeout: 1 });
  }
}
