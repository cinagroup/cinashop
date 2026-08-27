import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  deliveryService,
  expressCompany,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeServiceRecord,
  systemStore,
  user,
} from "@/models/schema";
import { KefuFulfillmentService } from "@/services/kefu/KefuFulfillmentService";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";

const CLONED_TABLES = [
  "user",
  "delivery_service",
  "express_company",
  "store_service_record",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_status",
  "store_order_writeoff",
  "store_pink",
  "system_store",
  "system_store_staff",
  "supplier_flowing_water",
  "store_order_outbox",
] as const;

const PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  user: "uid",
  delivery_service: "id",
  express_company: "id",
  store_service_record: "id",
  store_order: "id",
  store_order_cart_info: "id",
  store_order_refund: "id",
  store_order_status: "id",
  store_order_writeoff: "id",
  store_pink: "id",
  system_store: "id",
  system_store_staff: "id",
  supplier_flowing_water: "id",
  store_order_outbox: "id",
};

const PUBLIC_SEQUENCES: Record<(typeof CLONED_TABLES)[number], string> = {
  user: "user_uid_seq",
  delivery_service: "delivery_service_id_seq",
  express_company: "express_company_id_seq",
  store_service_record: "store_service_record_id_seq",
  store_order: "store_order_id_seq",
  store_order_cart_info: "store_order_cart_info_id_seq",
  store_order_refund: "store_order_refund_id_seq",
  store_order_status: "store_order_status_id_seq",
  store_order_writeoff: "store_order_writeoff_id_seq",
  store_pink: "store_pink_id_seq",
  system_store: "system_store_id_seq",
  system_store_staff: "system_store_staff_id_seq",
  supplier_flowing_water: "supplier_flowing_water_id_seq",
  store_order_outbox: "store_order_outbox_id_seq",
};

const CONFIG_VALUES: Record<string, string> = {
  extract_time: "0",
  brokerage_func_status: "0",
  store_brokerage_statu: "1",
  store_brokerage_price: "0",
  order_give_integral: "0",
  member_func_status: "0",
  order_give_exp: "0",
  member_card_status: "0",
  config_export_temp_id: "audit-template",
  config_export_to_name: "审计发件人",
  config_export_id: "1",
  config_export_to_tel: "13800138000",
  config_export_to_address: "审计发件地址",
};

const CONFIG_ENV: SystemConfigEnv = {
  CONFIG_KV: {
    async get(key) {
      const name = key.startsWith("cfg_") ? key.slice(4) : key;
      return CONFIG_VALUES[name] ?? "";
    },
    async put() {
      throw new Error("isolated audit config cache must remain read-only");
    },
    async delete() {
      throw new Error("isolated audit config cache must remain read-only");
    },
  },
};

interface Fingerprint {
  tables: Record<string, { count: string; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface KefuFulfillmentPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  missing_public_tables: string[];
  production: Record<string, number>;
  isolated: Record<string, boolean>;
}

export interface KefuAuditMarkerReport {
  users: number;
  sessions: number;
  delivery_agents: number;
  stores: number;
  orders: number;
  carts: number;
  refunds: number;
  temporary_schemas: string[];
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Kefu fulfillment integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_kefu_fulfill_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function rejects(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of CLONED_TABLES) {
    const row = (await db.$client.unsafe<Array<{ count: string; digest: string }>>(`
      SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
      FROM public.${identifier(table)} t
    `))[0];
    assertCondition(row, `could not fingerprint public.${table}`);
    tables[table] = row;
  }
  const names = Object.values(PUBLIC_SEQUENCES);
  const rows = await db.$client<Array<{ sequencename: string; last_value: string | null }>>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names})
    ORDER BY sequencename
  `;
  const values = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return { tables, sequences: Object.fromEntries(names.map((name) => [name, values.get(name) ?? null])) };
}

async function productionSummary(db: DbClient): Promise<Record<string, number>> {
  const row = (await db.$client<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::int FROM public.store_order) AS orders,
      (SELECT count(*)::int FROM public.store_order_cart_info) AS carts,
      (SELECT count(*)::int FROM public.store_order_status) AS statuses,
      (SELECT count(*)::int FROM public.store_order_writeoff) AS writeoffs,
      (SELECT count(*)::int FROM public.store_service_record) AS sessions,
      (SELECT count(*)::int FROM public.delivery_service WHERE is_del = 0 AND status = 1) AS active_delivery_agents
  `)[0];
  assertCondition(row, "production summary returned no row");
  return row;
}

async function missingPublicTables(db: DbClient): Promise<string[]> {
  const expected = ["order_waybill_job", "order_waybill_job_action"];
  const rows = await db.$client<Array<{ table_name: string }>>`
    SELECT table_name
    FROM unnest(${expected}::text[]) AS expected_table(table_name)
    WHERE to_regclass('public.' || table_name) IS NULL
    ORDER BY table_name
  `;
  return rows.map((item) => item.table_name);
}

async function createSchema(db: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      const sequence = identifier(`${table}_id_seq_audit`);
      const key = identifier(PRIMARY_KEYS[table]);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequence}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${key} SET DEFAULT nextval('${name}.${table}_id_seq_audit'::regclass)`,
      );
    }
    // Production currently lacks migration_0098. Manual fulfillment only needs the
    // active-job guard, so the isolated audit supplies exactly that contract while
    // reporting the public-table gap separately.
    await tx.unsafe(`
      CREATE TABLE ${schema}.order_waybill_job (
        id BIGSERIAL PRIMARY KEY,
        root_order_id INTEGER NOT NULL,
        status VARCHAR(16) NOT NULL
      )
    `);
  });
}

function orderSeed(
  id: number,
  uid: number,
  values: Partial<typeof storeOrder.$inferInsert> = {},
): typeof storeOrder.$inferInsert {
  return {
    id,
    orderId: `audit-kefu-order-${id}`,
    uid,
    realName: uid === 2001 ? "审计客户" : "外部客户",
    userPhone: uid === 2001 ? "13900002001" : "13900002002",
    userAddress: "审计收货地址",
    totalNum: 1,
    totalPrice: "20.00",
    payPrice: "20.00",
    paid: 1,
    status: 0,
    shippingType: 1,
    payType: "weixin",
    payTime: 1_700_000_100,
    addTime: 1_700_000_000 + id,
    refundStatus: 0,
    refundType: 0,
    deliveryType: "",
    remark: "",
    isDel: 0,
    isSystemDel: 0,
    storeId: 0,
    supplierId: 0,
    pid: 0,
    unique: `audit-kefu-unique-${id}`,
    verifyCode: "",
    userIp: "127.0.0.1",
    ...values,
  };
}

function cartSeed(
  id: number,
  oid: number,
  cartId: string,
  quantity: number,
  price: string,
  values: Partial<typeof storeOrderCartInfo.$inferInsert> = {},
): typeof storeOrderCartInfo.$inferInsert {
  return {
    id,
    uid: 2001,
    oid,
    cartId,
    productId: id,
    skuUnique: `sku-${id}`,
    cartNum: quantity,
    refundNum: 0,
    surplusNum: quantity,
    splitSurplusNum: quantity,
    splitStatus: 0,
    cartInfo: JSON.stringify({
      cart_num: quantity,
      truePrice: price,
      productInfo: {
        id,
        store_name: `审计商品 ${id}`,
        image: "",
        price,
        truePrice: price,
        attrInfo: { suk: "默认规格", image: "", price },
      },
    }),
    unique: `audit-kefu-cart-${id}`,
    addTime: 1_700_000_000 + id,
    writeTimes: quantity,
    writeSurplusTimes: quantity,
    isWriteoff: 0,
    ...values,
  };
}

async function seed(db: DbClient, name: string): Promise<void> {
  const rootContainer = createContainerFromDb(db);
  await withTx(rootContainer, async (tx) => {
    const container = createContainerFromDb(tx);
    await container.db.insert(user).values([
    { uid: 2001, account: "audit-customer", pwd: "audit-private", nickname: "审计客户", phone: "13900002001", status: 1, isDel: 0 },
    { uid: 2002, account: "audit-foreign", pwd: "audit-foreign", nickname: "外部客户", phone: "13900002002", status: 1, isDel: 0 },
    { uid: 3001, account: "audit-delivery", pwd: "audit-delivery", nickname: "林配送", phone: "13800138001", status: 1, isDel: 0 },
  ]);
  await container.db.insert(storeServiceRecord).values([
    { id: 1, userId: 1001, toUid: 2001, nickname: "审计客户", isTourist: 0, online: 1, type: 1, addTime: 1_700_000_000, updateTime: 1_700_000_100 },
    { id: 2, userId: 1002, toUid: 2002, nickname: "外部客户", isTourist: 0, online: 1, type: 1, addTime: 1_700_000_000, updateTime: 1_700_000_100 },
  ]);
  await container.db.insert(deliveryService).values({
    id: 1,
    uid: 3001,
    type: 0,
    relationId: 0,
    nickname: "林配送",
    phone: "13800138001",
    status: 1,
    isDel: 0,
  });
  await container.db.insert(expressCompany).values([
    { id: 1, code: "SF", name: "顺丰速运", isShow: 1, status: 1, sort: 10 },
    { id: 2, code: "HIDE", name: "隐藏快递", isShow: 0, status: 1, sort: 20 },
  ]);
  await container.db.insert(systemStore).values({
    id: 1,
    name: "审计自提门店",
    isStore: 1,
    isShow: 1,
    isDel: 0,
  });
  await container.db.insert(storeOrder).values([
    orderSeed(101, 2001, { totalNum: 2, totalPrice: "30.00", payPrice: "30.00" }),
    orderSeed(102, 2001),
    orderSeed(103, 2001, { totalNum: 3, totalPrice: "40.00", payPrice: "40.00" }),
    orderSeed(104, 2001, { shippingType: 2, storeId: 1, verifyCode: "100000000104", totalNum: 2 }),
    orderSeed(105, 2002),
    orderSeed(106, 2001),
    orderSeed(107, 2001),
    orderSeed(108, 2001, { type: 6 }),
    orderSeed(109, 2001),
    orderSeed(110, 2001, { shippingType: 2, storeId: 1, verifyCode: "100000000110" }),
  ]);
  await container.db.insert(storeOrderCartInfo).values([
    cartSeed(201, 101, "cart-101-a", 1, "10.00"),
    cartSeed(202, 101, "cart-101-b", 1, "20.00"),
    cartSeed(203, 102, "cart-102", 1, "20.00"),
    cartSeed(204, 103, "cart-103-a", 2, "10.00"),
    cartSeed(205, 103, "cart-103-b", 1, "20.00"),
    cartSeed(206, 104, "cart-104", 2, "10.00"),
    cartSeed(207, 105, "cart-105", 1, "20.00", { uid: 2002 }),
    cartSeed(208, 106, "cart-106", 1, "20.00"),
    cartSeed(209, 107, "cart-107", 1, "20.00"),
    cartSeed(210, 108, "cart-108", 1, "20.00", {
      cartInfo: JSON.stringify({
        truePrice: "20.00",
        productInfo: {
          store_name: "预售审计商品",
          truePrice: "20.00",
          presale_end_time: Math.floor(Date.now() / 1_000) + 3_600,
        },
      }),
    }),
    cartSeed(211, 109, "cart-109", 1, "20.00"),
    cartSeed(212, 110, "cart-110", 1, "20.00"),
  ]);
    await container.db.insert(storeOrderRefund).values({
    id: 1,
    storeOrderId: 106,
    orderId: "audit-refund-open",
    uid: 2001,
    supplierId: 0,
    refundType: 1,
    refundNum: 1,
    refundPrice: "20.00",
    refundedPrice: "0.00",
    isCancel: 0,
    isDel: 0,
    addTime: 1_700_000_500,
    });
  });

  for (const table of CLONED_TABLES) {
    const schema = identifier(name);
    const tableName = identifier(table);
    const key = identifier(PRIMARY_KEYS[table]);
    const sequence = identifier(`${table}_id_seq_audit`);
    await db.$client.unsafe(
      `SELECT setval('${name}.${table}_id_seq_audit'::regclass,
        COALESCE((SELECT max(${key})::bigint + 1 FROM ${schema}.${tableName}), 1), false)`,
    );
    void sequence;
  }
}

async function row<T extends Record<string, unknown>>(db: DbClient, name: string, query: string): Promise<T> {
  const rows = await db.$client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${identifier(name)}`);
    return tx.unsafe<T[]>(query);
  });
  const value = rows[0] as T | undefined;
  assertCondition(value, `query returned no row: ${query}`);
  return value;
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'codex_kefu_fulfill_%'
  `)[0]?.count ?? 0;
}

export async function inspectKefuAuditMarkers(connectionString: string): Promise<KefuAuditMarkerReport> {
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_fulfillment_audit_inspect",
  });
  try {
    const marker = (await db.$client<Array<Omit<KefuAuditMarkerReport, "temporary_schemas">>>`
      SELECT
        (SELECT count(*)::int FROM public."user"
          WHERE (uid, account, phone) IN (
            (2001, 'audit-customer', '13900002001'),
            (2002, 'audit-foreign', '13900002002'),
            (3001, 'audit-delivery', '13800138001')
          )) AS users,
        (SELECT count(*)::int FROM public.store_service_record
          WHERE (id, user_id, to_uid, nickname) IN (
            (1, 1001, 2001, '审计客户'),
            (2, 1002, 2002, '外部客户')
          )) AS sessions,
        (SELECT count(*)::int FROM public.delivery_service
          WHERE id = 1 AND uid = 3001 AND nickname = '林配送' AND phone = '13800138001') AS delivery_agents,
        (SELECT count(*)::int FROM public.system_store
          WHERE id = 1 AND name = '审计自提门店') AS stores,
        (SELECT count(*)::int FROM public.store_order
          WHERE order_id LIKE 'audit-kefu-order-%') AS orders,
        (SELECT count(*)::int FROM public.store_order_cart_info
          WHERE "unique" LIKE 'audit-kefu-cart-%') AS carts,
        (SELECT count(*)::int FROM public.store_order_refund
          WHERE order_id = 'audit-refund-open') AS refunds
    `)[0];
    assertCondition(marker, "audit marker inspection returned no row");
    const schemas = await db.$client<Array<{ schema_name: string }>>`
      SELECT nspname AS schema_name
      FROM pg_namespace
      WHERE nspname LIKE 'codex_kefu_fulfill_%'
      ORDER BY nspname
    `;
    return { ...marker, temporary_schemas: schemas.map((item) => item.schema_name) };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function runKefuFulfillmentPostgresScenario(
  connectionString: string,
): Promise<KefuFulfillmentPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_fulfillment_audit_root",
  });
  const name = schemaName();
  let created = false;
  let isolated: DbClient | null = null;
  try {
    const [before, production, missingTables] = await Promise.all([
      fingerprint(root),
      productionSummary(root),
      missingPublicTables(root),
    ]);
    await createSchema(root, name);
    created = true;
    isolated = createDbFromConnectionString(connectionString, 1, {
      searchPath: name,
      applicationName: "cinashop_kefu_fulfillment_audit_isolated",
    });
    await seed(isolated, name);
    const service = new KefuFulfillmentService(createContainerFromDb(isolated), CONFIG_ENV);

    const [express, agents, config] = await Promise.all([
      service.expressList({ status: "1" }),
      service.deliveryAgents({ limit: "100" }),
      service.deliveryConfig(),
    ]);
    const foreignMessage = await rejects(() => service.deliver(1001, 105, {
      type: 1,
      express_record_type: 1,
      delivery_name: "顺丰速运",
      delivery_code: "SF",
      delivery_id: "FOREIGN",
    }));

    await service.deliver(1001, 101, {
      type: 1,
      express_record_type: 1,
      delivery_name: "顺丰速运",
      delivery_code: "SF",
      delivery_id: "SF-AUDIT-101",
    });
    const manual = await row<{ status: number; delivery_id: string; audit: number; outbox: number }>(isolated, name, `
      SELECT o.status, o.delivery_id,
        (SELECT count(*)::int FROM store_order_status WHERE oid = 101 AND change_type = 'kefu_order_delivery') AS audit,
        (SELECT count(*)::int FROM store_order_outbox WHERE aggregate_id = 101 AND event_type = 'order.delivery.notice') AS outbox
      FROM store_order o WHERE o.id = 101
    `);
    const repeatMessage = await rejects(() => service.deliver(1001, 101, {
      type: 1,
      express_record_type: 1,
      delivery_name: "顺丰速运",
      delivery_code: "SF",
      delivery_id: "SF-AUDIT-101",
    }));

    const refundMessage = await rejects(() => service.deliver(1001, 106, {
      type: 3,
      fictitious_content: "退款订单不得发货",
    }));
    const presaleMessage = await rejects(() => service.deliver(1001, 108, {
      type: 3,
      fictitious_content: "预售尚未结束",
    }));

    await service.deliver(1001, 102, { type: 2, delivery_type: 1, sh_delivery_uid: 3001 });
    const send = await row<{ status: number; delivery_name: string; delivery_id: string; delivery_uid: number; verify_code: string }>(isolated, name, `
      SELECT status, delivery_name, delivery_id, delivery_uid, verify_code
      FROM store_order WHERE id = 102
    `);

    const partialInfo = await service.writeoffCartInfo(11, 1001, 104);
    await service.writeoffByPublicId(11, 1001, partialInfo.order_id, {
      cart_ids: [{ cart_id: "cart-104", cart_num: 1 }],
    });
    const partial = await row<{ status: number; verify_code: string; remaining: number }>(isolated, name, `
      SELECT o.status, o.verify_code, c.write_surplus_times AS remaining
      FROM store_order o JOIN store_order_cart_info c ON c.oid = o.id WHERE o.id = 104
    `);
    const completedInfo = await service.writeoffCartInfo(11, 1001, 104);
    await service.writeoffByPublicId(11, 1001, completedInfo.order_id, {
      cart_ids: [{ cart_id: "cart-104", cart_num: 1 }],
    });
    const completed = await row<{ status: number; verify_code: string; remaining: number; evidence: number; audits: number }>(isolated, name, `
      SELECT o.status, o.verify_code, c.write_surplus_times AS remaining,
        (SELECT count(*)::int FROM store_order_writeoff WHERE oid = 104) AS evidence,
        (SELECT count(*)::int FROM store_order_status WHERE oid = 104 AND change_type = 'kefu_order_writeoff') AS audits
      FROM store_order o JOIN store_order_cart_info c ON c.oid = o.id WHERE o.id = 104
    `);

    const splitPreview = await service.splitCartInfo(1001, 103);
    const split = await service.splitDelivery(1001, 103, {
      type: 1,
      express_record_type: 1,
      delivery_name: "顺丰速运",
      delivery_code: "SF",
      delivery_id: "SF-SPLIT-103",
      cart_ids: [{ cart_id: "cart-103-a", cart_num: 1 }],
    });
    const splitState = await row<{ root_pid: number; children: number; total_num: number; total_pay: string; audit: number; outbox: number }>(isolated, name, `
      SELECT
        (SELECT pid FROM store_order WHERE id = 103) AS root_pid,
        (SELECT count(*)::int FROM store_order WHERE pid = 103) AS children,
        (SELECT sum(total_num)::int FROM store_order WHERE pid = 103) AS total_num,
        (SELECT sum(pay_price)::numeric(12,2)::text FROM store_order WHERE pid = 103) AS total_pay,
        (SELECT count(*)::int FROM store_order_status WHERE oid = 103 AND change_type = 'kefu_order_split_delivery') AS audit,
        (SELECT count(*)::int FROM store_order_outbox WHERE aggregate_id = ${split.order_id}) AS outbox
    `);

    await isolated.$client.unsafe(`
      CREATE FUNCTION ${identifier(name)}.reject_kefu_fulfillment_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.oid = 107 AND NEW.change_type = 'kefu_order_delivery' THEN
          RAISE EXCEPTION 'forced fulfillment audit rollback';
        END IF;
        IF NEW.oid = 110 AND NEW.change_type = 'kefu_order_writeoff' THEN
          RAISE EXCEPTION 'forced writeoff audit rollback';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_kefu_fulfillment_audit
      BEFORE INSERT ON ${identifier(name)}.store_order_status
      FOR EACH ROW EXECUTE FUNCTION ${identifier(name)}.reject_kefu_fulfillment_audit();
    `);
    const fulfillmentRollbackMessage = await rejects(() => service.deliver(1001, 107, {
      type: 1,
      express_record_type: 1,
      delivery_name: "顺丰速运",
      delivery_code: "SF",
      delivery_id: "ROLLBACK-107",
    }));
    const fulfillmentRollback = await row<{ status: number; outbox: number }>(isolated, name, `
      SELECT status,
        (SELECT count(*)::int FROM store_order_outbox WHERE aggregate_id = 107) AS outbox
      FROM store_order WHERE id = 107
    `);
    const writeoffRollbackMessage = await rejects(() => service.writeoffByPublicId(11, 1001, "audit-kefu-order-110", {
      cart_ids: [{ cart_id: "cart-110", cart_num: 1 }],
    }));
    const writeoffRollback = await row<{ status: number; remaining: number; evidence: number }>(isolated, name, `
      SELECT o.status, c.write_surplus_times AS remaining,
        (SELECT count(*)::int FROM store_order_writeoff WHERE oid = 110) AS evidence
      FROM store_order o JOIN store_order_cart_info c ON c.oid = o.id WHERE o.id = 110
    `);

    await isolated.$client.unsafe(
      `DELETE FROM ${identifier(name)}.store_service_record WHERE user_id = 1001 AND to_uid = 2001`,
    );
    const transferMessage = await rejects(() => service.deliver(1001, 109, {
      type: 3,
      fictitious_content: "转接后不得继续履约",
    }));

    const flags = {
      metadata_contract_exact:
        express.length === 1 && express[0]?.code === "SF" && agents.length === 1 && agents[0]?.uid === 3001 &&
        config.express_temp_id === "audit-template" && config.to_add === "审计发件地址",
      foreign_conversation_closed: foreignMessage.includes("不属于当前会话"),
      manual_delivery_atomic:
        manual.status === 1 && manual.delivery_id === "SF-AUDIT-101" && manual.audit === 1 && manual.outbox === 1,
      repeat_delivery_rejected: repeatMessage.includes("已全部发货") || repeatMessage.includes("状态不允许发货"),
      open_refund_guarded: refundMessage.includes("售后"),
      presale_guarded: presaleMessage.includes("预售活动尚未结束"),
      registered_delivery_authoritative:
        send.status === 1 && send.delivery_name === "林配送" && send.delivery_id === "13800138001" &&
        send.delivery_uid === 3001 && /^\d{12}$/.test(send.verify_code),
      partial_writeoff_rotates_code:
        partial.status === 5 && partial.remaining === 1 && /^\d{12}$/.test(partial.verify_code) && partial.verify_code !== "100000000104",
      completed_writeoff_settles_once:
        completed.status === 2 && completed.verify_code === "" && completed.remaining === 0 && completed.evidence === 2 && completed.audits === 2,
      split_delivery_conserves:
        splitPreview.length === 2 && split.split && splitState.root_pid === -1 && splitState.children === 2 &&
        splitState.total_num === 3 && splitState.total_pay === "40.00" && splitState.audit === 1 && splitState.outbox === 1,
      fulfillment_audit_failure_rolls_back:
        fulfillmentRollbackMessage.includes("forced fulfillment audit rollback") &&
        fulfillmentRollback.status === 0 && fulfillmentRollback.outbox === 0,
      writeoff_audit_failure_rolls_back:
        writeoffRollbackMessage.includes("forced writeoff audit rollback") && writeoffRollback.status === 0 &&
        writeoffRollback.remaining === 1 && writeoffRollback.evidence === 0,
      transfer_revokes_fulfillment: transferMessage.includes("不属于当前会话"),
    };
    for (const [key, value] of Object.entries(flags)) {
      assertCondition(value, `${key}; flags=${JSON.stringify(flags)}`);
    }

    await isolated.$client.end({ timeout: 1 });
    isolated = null;
    await root.$client.unsafe(`DROP SCHEMA ${identifier(name)} CASCADE`);
    created = false;
    const after = await fingerprint(root);
    const remaining = await temporarySchemaCount(root);
    assertCondition(JSON.stringify(before) === JSON.stringify(after), "public rows or sequences changed");
    assertCondition(remaining === 0, "temporary schema leaked");
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      schema_created: true,
      schema_removed: true,
      temporary_schemas_after: remaining,
      public_state_unchanged: true,
      missing_public_tables: missingTables,
      production,
      isolated: flags,
    };
  } finally {
    if (isolated) await isolated.$client.end({ timeout: 1 }).catch(() => undefined);
    if (created) {
      await root.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(name)} CASCADE`).catch(() => undefined);
    }
    await root.$client.end({ timeout: 1 });
  }
}
