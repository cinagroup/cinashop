import { eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  outAccount,
  outInterface,
  storeOrder,
  storeOrderRefund,
  storeOrderStatus,
  user,
} from "@/models/schema";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";
import { AuthException } from "@/utils/errors";

const CLONED_TABLES = [
  "out_account",
  "out_interface",
  "out_api_audit",
  "store_order",
  "store_order_refund",
  "store_order_status",
  "user",
  "supplier_flowing_water",
] as const;

const PUBLIC_PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  out_account: "id",
  out_interface: "id",
  out_api_audit: "id",
  store_order: "id",
  store_order_refund: "id",
  store_order_status: "id",
  user: "uid",
  supplier_flowing_water: "id",
};

const PUBLIC_SEQUENCE_NAMES: Record<(typeof CLONED_TABLES)[number], string> = {
  out_account: "out_account_id_seq",
  out_interface: "out_interface_id_seq",
  out_api_audit: "out_api_audit_id_seq",
  store_order: "store_order_id_seq",
  store_order_refund: "store_order_refund_id_seq",
  store_order_status: "store_order_status_id_seq",
  user: "user_uid_seq",
  supplier_flowing_water: "supplier_flowing_water_id_seq",
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
};

const TEST_CONFIG_ENV: SystemConfigEnv = {
  CONFIG_KV: {
    async get(key) {
      const name = key.startsWith("cfg_") ? key.slice(4) : key;
      return CONFIG_VALUES[name] ?? "";
    },
    async put() {
      throw new Error("integration config cache must remain read-only");
    },
    async delete() {
      throw new Error("integration config cache must remain read-only");
    },
  },
};
const TEST_ENV = TEST_CONFIG_ENV as unknown as Env;

interface Fingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface OutApiHardeningPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  acl: { writes_allowed: number; missing_permission_rejected: boolean };
  order_remark: {
    first_changed: boolean;
    replay_idempotent: boolean;
    concurrent_serialized: boolean;
    evidence_rows: number;
    evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
  refund_remark: {
    first_changed: boolean;
    replay_idempotent: boolean;
    platform_scope_enforced: boolean;
    evidence_rows: number;
    evidence_redacted: boolean;
  };
  order_receive: {
    first_changed: boolean;
    replay_idempotent: boolean;
    concurrent_single_settlement: boolean;
    platform_scope_enforced: boolean;
    fulfillment_guards_enforced: boolean;
    refund_guard_enforced: boolean;
    evidence_rows: number;
    evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
  audit: {
    inserted: number;
    hashes_truncated_for_admin: boolean;
    raw_identifiers_absent: boolean;
    invalid_hash_rejected_by_service: boolean;
    invalid_hash_rejected_by_database: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out API hardening integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_hardening_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
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
  const names = CLONED_TABLES.map((table) => PUBLIC_SEQUENCE_NAMES[table]);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names})
    ORDER BY sequencename
  `;
  const values = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return { tables, sequences: Object.fromEntries(names.map((name) => [name, values.get(name) ?? null])) };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      const keyName = PUBLIC_PRIMARY_KEYS[table];
      const sequence = `${table}_${keyName}_seq_it`;
      const sequenceName = identifier(sequence);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequenceName}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${identifier(keyName)} SET DEFAULT nextval('${schemaName}.${sequence}'::regclass)`,
      );
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
  await container.db.insert(outInterface).values([
    { id: 1, pid: 0, type: 1, name: "订单备注", method: "PUT", url: "/outapi/order/remark/<order_id>", isDel: 0 },
    { id: 2, pid: 0, type: 1, name: "退款备注", method: "PUT", url: "/refund/remark/:order_id", isDel: 0 },
    { id: 3, pid: 0, type: 1, name: "确认收货", method: "PUT", url: "/order/receive/:order_id", isDel: 0 },
    { id: 4, pid: 0, type: 1, name: "订单发货", method: "PUT", url: "/order/delivery/:order_id", isDel: 0 },
  ]);
  await container.db.insert(outAccount).values({
    id: 1,
    appid: "out-hardening-audit",
    appsecret: "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS",
    apppwd: "legacy-plaintext-must-not-be-used",
    title: "Out hardening audit",
    status: 1,
    rules: "[1,2,3]",
    isDel: 0,
  });
  await container.db.insert(user).values({
    uid: 401,
    account: "out-audit-user",
    nickname: "integration customer",
    phone: "13000000001",
  });
  const orderBase = {
    uid: 401,
    realName: "隔离审计用户",
    userPhone: "13000000001",
    totalNum: 1,
    totalPrice: "10.00",
    payPrice: "10.00",
    paid: 1,
    status: 1,
    shippingType: 1,
    deliveryType: "express",
    refundStatus: 0,
    addTime: now,
    storeId: 0,
    supplierId: 0,
    isDel: 0,
    isSystemDel: 0,
  } as const;
  await container.db.insert(storeOrder).values([
    { ...orderBase, id: 101, orderId: "audit-order-remark", unique: "out-hardening-order", remark: "order-before", status: 0 },
    { ...orderBase, id: 301, orderId: "audit-order-receive", unique: "out-receive-first" },
    { ...orderBase, id: 302, orderId: "audit-receive-concurrent", unique: "out-receive-race" },
    { ...orderBase, id: 303, orderId: "audit-supplier-receive", unique: "out-receive-supplier", storeId: 9 },
    { ...orderBase, id: 304, orderId: "audit-pickup-receive", unique: "out-receive-pickup", shippingType: 2 },
    { ...orderBase, id: 305, orderId: "audit-send-receive", unique: "out-receive-send", deliveryType: "send" },
    { ...orderBase, id: 306, orderId: "audit-refund-receive", unique: "out-receive-refund", refundStatus: 1 },
    { ...orderBase, id: 307, orderId: "audit-rollback-receive", unique: "out-receive-rollback" },
  ]);
  await container.db.insert(storeOrderRefund).values([
    {
      id: 201,
      storeOrderId: 101,
      storeId: 0,
      orderId: "audit-refund-remark",
      uid: 401,
      applyPrice: "5.00",
      refundPrice: "5.00",
      refundNum: 1,
      remark: "refund-before",
      isCancel: 0,
      isDel: 0,
      addTime: now,
    },
    {
      id: 202,
      storeOrderId: 101,
      storeId: 9,
      orderId: "audit-supplier-refund",
      uid: 401,
      applyPrice: "5.00",
      refundPrice: "5.00",
      refundNum: 1,
      remark: "supplier-before",
      isCancel: 0,
      isDel: 0,
      addTime: now,
    },
  ]);
}

function account(): AuthenticatedOutAccount {
  return { id: 1, appid: "out-hardening-audit", title: "Out hardening audit", rules: [1, 2, 3] };
}

async function runWrites(container: Container, schemaName: string) {
  const service = new OutApiService(container, TEST_ENV);
  const identity = account();
  const acl = await withTx(container, async (tx) => {
    const scopedService = new OutApiService(createContainerFromDb(tx), TEST_ENV);
    let allowed = 0;
    for (const [method, route] of [
      ["PUT", "/order/remark/{order_id}"],
      ["PUT", "/refund/remark/{order_id}"],
      ["PUT", "/order/receive/{order_id}"],
    ] as const) {
      await scopedService.assertInterfacePermission(identity, method, route);
      allowed += 1;
    }
    let denied = false;
    try {
      await scopedService.assertInterfacePermission(identity, "PUT", "/order/delivery/{order_id}");
    } catch (error) {
      denied = error instanceof AuthException;
    }
    return { writes_allowed: allowed, missing_permission_rejected: denied };
  });

  const orderFirst = await service.updateOrderRemark(identity, "audit-order-remark", "order-first");
  const orderReplay = await service.updateOrderRemark(identity, "audit-order-remark", "order-first");
  const concurrent = await Promise.all([
    service.updateOrderRemark(identity, "audit-order-remark", "order-concurrent-a"),
    service.updateOrderRemark(identity, "audit-order-remark", "order-concurrent-b"),
  ]);
  const { orderRows, orderEvidence } = await withTx(container, async (tx) => ({
    orderRows: await tx.select({ remark: storeOrder.remark }).from(storeOrder).where(eq(storeOrder.id, 101)),
    orderEvidence: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_order_remark")),
  }));
  const beforeRollback = orderRows[0]?.remark ?? "";
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_order_status_failure_probe"
       CHECK ("change_type" <> 'out_order_remark') NOT VALID`,
  ));
  let rollbackFailed = false;
  try {
    await service.updateOrderRemark(identity, "audit-order-remark", "order-must-rollback");
  } catch {
    rollbackFailed = true;
  } finally {
    await container.db.execute(sql.raw(
      `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_order_status_failure_probe"`,
    ));
  }
  const afterRollback = await withTx(container, async (tx) => tx
    .select({ remark: storeOrder.remark }).from(storeOrder).where(eq(storeOrder.id, 101)));

  const refundFirst = await service.updateRefundRemark(identity, "audit-refund-remark", "refund-first");
  const refundReplay = await service.updateRefundRemark(identity, "audit-refund-remark", "refund-first");
  let supplierRejected = false;
  try {
    await service.updateRefundRemark(identity, "audit-supplier-refund", "must-not-change");
  } catch {
    supplierRejected = true;
  }
  const { refundEvidence, supplier } = await withTx(container, async (tx) => ({
    refundEvidence: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_refund_remark")),
    supplier: await tx.select({ remark: storeOrderRefund.remark }).from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, 202)),
  }));

  const receiveFirst = await service.receiveOrder(identity, "audit-order-receive");
  const receiveReplay = await service.receiveOrder(identity, "audit-order-receive");
  const receiveConcurrent = await Promise.all([
    service.receiveOrder(identity, "audit-receive-concurrent"),
    service.receiveOrder(identity, "audit-receive-concurrent"),
  ]);
  const rejectedReceiptIds = [
    "audit-supplier-receive",
    "audit-pickup-receive",
    "audit-send-receive",
    "audit-refund-receive",
  ];
  const receiptRejections = await Promise.all(rejectedReceiptIds.map(async (id) => {
    try {
      await service.receiveOrder(identity, id);
      return false;
    } catch {
      return true;
    }
  }));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_receive_status_failure_probe"
       CHECK ("change_type" <> 'take_delivery') NOT VALID`,
  ));
  let receiptRollbackFailed = false;
  try {
    await service.receiveOrder(identity, "audit-rollback-receive");
  } catch {
    receiptRollbackFailed = true;
  } finally {
    await container.db.execute(sql.raw(
      `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_receive_status_failure_probe"`,
    ));
  }
  const receiptState = await withTx(container, async (tx) => ({
    orders: await tx.select({ id: storeOrder.id, status: storeOrder.status }).from(storeOrder)
      .where(sql`${storeOrder.id} BETWEEN 301 AND 307`),
    evidence: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "take_delivery")),
  }));
  const receiptStatuses = new Map(receiptState.orders.map((row) => [row.id, row.status]));

  return {
    acl,
    order_remark: {
      first_changed: !orderFirst.idempotent,
      replay_idempotent: orderReplay.idempotent,
      concurrent_serialized: concurrent.every((entry) => !entry.idempotent)
        && ["order-concurrent-a", "order-concurrent-b"].includes(orderRows[0]?.remark ?? ""),
      evidence_rows: orderEvidence.length,
      evidence_redacted: orderEvidence.every((row) => !row.changeMessage.includes("order-first") && !row.changeMessage.includes("concurrent")),
      rollback_preserved: rollbackFailed && afterRollback[0]?.remark === beforeRollback,
    },
    refund_remark: {
      first_changed: !refundFirst.idempotent,
      replay_idempotent: refundReplay.idempotent,
      platform_scope_enforced: supplierRejected && supplier[0]?.remark === "supplier-before",
      evidence_rows: refundEvidence.length,
      evidence_redacted: refundEvidence.every((row) => !row.changeMessage.includes("refund-first")),
    },
    order_receive: {
      first_changed: !receiveFirst.idempotent && receiptStatuses.get(301) === 2,
      replay_idempotent: receiveReplay.idempotent,
      concurrent_single_settlement: receiveConcurrent.filter((entry) => entry.idempotent).length === 1
        && receiveConcurrent.filter((entry) => !entry.idempotent).length === 1
        && receiptStatuses.get(302) === 2,
      platform_scope_enforced: receiptRejections[0] && receiptStatuses.get(303) === 1,
      fulfillment_guards_enforced: receiptRejections[1] && receiptRejections[2]
        && receiptStatuses.get(304) === 1 && receiptStatuses.get(305) === 1,
      refund_guard_enforced: receiptRejections[3] && receiptStatuses.get(306) === 1,
      evidence_rows: receiptState.evidence.length,
      evidence_redacted: receiptState.evidence.every((row) =>
        row.changeMessage === "Out API account 1 confirmed order receipt"),
      rollback_preserved: receiptRollbackFailed && receiptStatuses.get(307) === 1,
    },
  };
}

async function runAudit(container: Container) {
  const service = new OutApiService(container, TEST_ENV);
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const digestC = "c".repeat(64);
  await service.recordAccessAudit({
    account: account(),
    method: "PUT",
    routeTemplate: "/order/remark/{order_id}",
    operation: "write",
    resourceHash: digestA,
    queryFields: "dry_run,fields",
    ipHash: digestB,
    userAgentHash: digestC,
    outcome: "success",
    resultCode: 200,
    durationMs: 17,
  });
  let invalidService = false;
  try {
    await service.recordAccessAudit({
      account: account(), method: "GET", routeTemplate: "/user/info/{uid}", operation: "read",
      resourceHash: "raw-resource-id", queryFields: "", ipHash: digestB,
      userAgentHash: "", outcome: "success", resultCode: 200, durationMs: 1,
    });
  } catch {
    invalidService = true;
  }
  const admin = await service.adminAuditList({ page: 1, limit: 20 });
  const rawText = JSON.stringify(admin);
  return {
    inserted: admin.count,
    hashes_truncated_for_admin: admin.list[0]?.resource_hash === digestA.slice(0, 16)
      && admin.list[0]?.ip_hash === digestB.slice(0, 16),
    raw_identifiers_absent: !rawText.includes("audit-order-remark")
      && !rawText.includes("13000000001") && !rawText.includes(digestA),
    invalid_hash_rejected_by_service: invalidService,
  };
}

export async function runOutApiHardeningPostgresScenario(
  connectionString: string,
): Promise<OutApiHardeningPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_out_hardening_root" });
  const scoped = createDbFromConnectionString(connectionString, 4, {
    searchPath: schemaName,
    applicationName: "cinashop_out_hardening_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let writes: Awaited<ReturnType<typeof runWrites>> | undefined;
  let audit: Awaited<ReturnType<typeof runAudit>> | undefined;
  let invalidDatabase = false;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await fingerprint(root);
    await setupSchema(root, schemaName);
    created = true;
    await withSchema(scoped, schemaName, (container) => seed(container));
    const scenarioContainer = createContainerFromDb(scoped);
    writes = await runWrites(scenarioContainer, schemaName);
    audit = await withSchema(scoped, schemaName, (container) => runAudit(container));
    try {
      await scoped.$client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
        await tx`INSERT INTO out_api_audit
          (out_account_id, appid_snapshot, method, route_template, operation,
           resource_hash, query_fields, ip_hash, user_agent_hash, outcome,
           result_code, duration_ms, add_time)
          VALUES (1, 'audit', 'GET', '/order/{order_id}', 'read',
                  'not-a-digest', '', '', '', 'success', 200, 1, 1)`;
      });
    } catch {
      invalidDatabase = true;
    }
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
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_hardening_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      prefixCount = state[0]?.prefix_count ?? -1;
      after = await fingerprint(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }

  assertCondition(writes && audit, "scenario report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(writes.acl.writes_allowed === 3 && writes.acl.missing_permission_rejected, "write ACL diverged");
  assertCondition(writes.order_remark.first_changed && writes.order_remark.replay_idempotent, "order replay diverged");
  assertCondition(writes.order_remark.concurrent_serialized && writes.order_remark.evidence_rows === 3, "order concurrency evidence diverged");
  assertCondition(writes.order_remark.evidence_redacted && writes.order_remark.rollback_preserved, "order evidence or rollback diverged");
  assertCondition(writes.refund_remark.first_changed && writes.refund_remark.replay_idempotent, "refund replay diverged");
  assertCondition(writes.refund_remark.platform_scope_enforced && writes.refund_remark.evidence_rows === 1, "refund scope or evidence diverged");
  assertCondition(writes.refund_remark.evidence_redacted, "refund evidence leaked remark content");
  assertCondition(writes.order_receive.first_changed && writes.order_receive.replay_idempotent, "receipt replay diverged");
  assertCondition(writes.order_receive.concurrent_single_settlement, "receipt concurrency diverged");
  assertCondition(writes.order_receive.platform_scope_enforced, "receipt platform scope diverged");
  assertCondition(writes.order_receive.fulfillment_guards_enforced, "receipt fulfillment guard diverged");
  assertCondition(writes.order_receive.refund_guard_enforced, "receipt refund guard diverged");
  assertCondition(writes.order_receive.evidence_rows === 2 && writes.order_receive.evidence_redacted, "receipt evidence diverged");
  assertCondition(writes.order_receive.rollback_preserved, "receipt rollback diverged");
  assertCondition(audit.inserted === 1 && audit.hashes_truncated_for_admin && audit.raw_identifiers_absent, "audit projection diverged");
  assertCondition(audit.invalid_hash_rejected_by_service && invalidDatabase, "invalid audit digest was accepted");
  assertCondition(removed && prefixCount === 0, "temporary schema cleanup failed");
  assertCondition(unchanged, "public tables or sequences changed during isolated scenario");

  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    ...writes,
    audit: { ...audit, invalid_hash_rejected_by_database: invalidDatabase },
  };
}
