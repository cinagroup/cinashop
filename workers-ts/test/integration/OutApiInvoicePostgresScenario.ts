import { eq, inArray, sql } from "drizzle-orm";
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
  storeOrderInvoice,
  storeOrderStatus,
} from "@/models/schema";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { AuthException } from "@/utils/errors";

const CLONED_TABLES = [
  "out_account",
  "out_interface",
  "store_order",
  "store_order_invoice",
  "store_order_status",
] as const;

const PUBLIC_SEQUENCE_NAMES: Record<(typeof CLONED_TABLES)[number], string> = {
  out_account: "out_account_id_seq",
  out_interface: "out_interface_id_seq",
  store_order: "store_order_id_seq",
  store_order_invoice: "store_order_invoice_id_seq",
  store_order_status: "store_order_status_id_seq",
};

interface Fingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface OutApiInvoicePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  acl: { writes_allowed: number; missing_permission_rejected: boolean };
  invoice: {
    first_changed: boolean;
    replay_idempotent: boolean;
    newer_change_applied: boolean;
    delayed_replay_preserved_newer_value: boolean;
    concurrent_single_write: boolean;
    platform_scope_enforced: boolean;
    missing_application_rejected: boolean;
    duplicate_application_rejected: boolean;
    association_guard_enforced: boolean;
    replay_evidence_rows: number;
    evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
  invoice_status: {
    issued: boolean;
    replay_idempotent: boolean;
    rejected_after_issue: boolean;
    delayed_replay_preserved_newer_state: boolean;
    concurrent_single_write: boolean;
    replay_evidence_rows: number;
    evidence_redacted: boolean;
    rollback_preserved: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out API invoice integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_invoice_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of CLONED_TABLES) {
    const rows = await db.$client.unsafe<Array<{
      count: string;
      max_id: string | null;
      digest: string;
    }>>(
      `SELECT count(*)::text AS count,
        max(t."id")::text AS max_id,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t."id"), '')) AS digest
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
      const sequence = `${table}_id_seq_it`;
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequence)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${schemaName}.${sequence}'::regclass)`,
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

function account(): AuthenticatedOutAccount {
  return { id: 1, appid: "out-invoice-audit", title: "Out invoice audit", rules: [1, 2] };
}

function orderBase(now: number) {
  return {
    uid: 901,
    realName: "隔离发票用户",
    userPhone: "13800000009",
    totalNum: 1,
    totalPrice: "10.00",
    payPrice: "10.00",
    paid: 1,
    status: 1,
    shippingType: 1,
    refundStatus: 0,
    addTime: now,
    storeId: 0,
    supplierId: 0,
    isDel: 0,
    isSystemDel: 0,
  } as const;
}

function invoiceBase(now: number) {
  return {
    uid: 901,
    category: "order",
    invoiceId: 1,
    headerType: 1,
    type: 1,
    name: "原始抬头",
    dutyNumber: "",
    drawerPhone: "13800000009",
    email: "old@example.invalid",
    tell: "",
    address: "",
    bank: "",
    cardNumber: "",
    isPay: 1,
    isRefund: 0,
    isInvoice: 0,
    invoiceNumber: "",
    invoiceAmount: "10.00",
    remark: "",
    invoiceTime: 0,
    isDel: 0,
    addTime: now,
  } as const;
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(outInterface).values([
    { id: 1, pid: 0, type: 1, name: "修改发票", method: "PUT", url: "/order/invoice/:order_id", isDel: 0 },
    { id: 2, pid: 0, type: 1, name: "修改发票状态", method: "PUT", url: "/order/invoice_status/:order_id", isDel: 0 },
    { id: 3, pid: 0, type: 1, name: "订单备注", method: "PUT", url: "/order/remark/:order_id", isDel: 0 },
  ]);
  await container.db.insert(outAccount).values({
    id: 1,
    appid: "out-invoice-audit",
    appsecret: "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS",
    title: "Out invoice audit",
    status: 1,
    rules: "[1,2]",
    isDel: 0,
  });

  const base = orderBase(now);
  await container.db.insert(storeOrder).values([
    { ...base, id: 1301, orderId: "audit-invoice-first", unique: "out-invoice-first" },
    { ...base, id: 1302, orderId: "audit-invoice-race", unique: "out-invoice-race" },
    { ...base, id: 1303, orderId: "audit-invoice-store", unique: "out-invoice-store", storeId: 9 },
    { ...base, id: 1304, orderId: "audit-invoice-missing", unique: "out-invoice-missing" },
    { ...base, id: 1305, orderId: "audit-invoice-duplicate", unique: "out-invoice-duplicate" },
    { ...base, id: 1306, orderId: "audit-invoice-association", unique: "out-invoice-association" },
    { ...base, id: 1307, orderId: "audit-invoice-rollback", unique: "out-invoice-rollback" },
    { ...base, id: 1311, orderId: "audit-invoice-status-first", unique: "out-invoice-status-first" },
    { ...base, id: 1312, orderId: "audit-invoice-status-race", unique: "out-invoice-status-race" },
    { ...base, id: 1313, orderId: "audit-invoice-status-rollback", unique: "out-invoice-status-rollback" },
  ]);

  const invoice = invoiceBase(now);
  await container.db.insert(storeOrderInvoice).values([
    { ...invoice, id: 6001, orderId: 1301 },
    { ...invoice, id: 6002, orderId: 1302 },
    { ...invoice, id: 6003, orderId: 1303 },
    { ...invoice, id: 6004, orderId: 1305 },
    { ...invoice, id: 6005, orderId: 1305 },
    { ...invoice, id: 6006, orderId: 1306, uid: 999 },
    { ...invoice, id: 6007, orderId: 1307 },
    { ...invoice, id: 6011, orderId: 1311 },
    { ...invoice, id: 6012, orderId: 1312 },
    { ...invoice, id: 6013, orderId: 1313 },
  ]);
}

function personalBody(name: string, phone: string) {
  return {
    header_type: 1,
    type: 1,
    drawer_phone: phone,
    email: `${phone}@example.invalid`,
    name,
    duty_number: "",
    tell: "059112345678",
    address: "生产验证隔离地址",
    bank: "隔离银行",
    card_number: "123456789012",
  };
}

async function rejects(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch {
    return true;
  }
}

async function runAcl(container: Container) {
  return withTx(container, async (tx) => {
    const service = new OutApiService(createContainerFromDb(tx), {} as Env);
    let allowed = 0;
    for (const route of [
      "/order/invoice/{order_id}",
      "/order/invoice_status/{order_id}",
    ]) {
      await service.assertInterfacePermission(account(), "PUT", route);
      allowed += 1;
    }
    let denied = false;
    try {
      await service.assertInterfacePermission(account(), "PUT", "/order/remark/{order_id}");
    } catch (error) {
      denied = error instanceof AuthException;
    }
    return { writes_allowed: allowed, missing_permission_rejected: denied };
  });
}

async function runInvoice(container: Container, schemaName: string) {
  const service = new OutApiService(container, {} as Env);
  const identity = account();
  const firstBody = personalBody("首次抬头", "13800000001");
  const newerBody = personalBody("更新抬头", "13800000002");
  const first = await service.updateOrderInvoice(identity, "audit-invoice-first", firstBody);
  const replay = await service.updateOrderInvoice(identity, "audit-invoice-first", firstBody);
  const newer = await service.updateOrderInvoice(identity, "audit-invoice-first", newerBody);
  const delayed = await service.updateOrderInvoice(identity, "audit-invoice-first", firstBody);
  const concurrent = await Promise.all([
    service.updateOrderInvoice(identity, "audit-invoice-race", personalBody("并发抬头", "13800000003")),
    service.updateOrderInvoice(identity, "audit-invoice-race", personalBody("并发抬头", "13800000003")),
  ]);
  const [scopeRejected, missingRejected, duplicateRejected, associationRejected] = await Promise.all([
    rejects(() => service.updateOrderInvoice(identity, "audit-invoice-store", firstBody)),
    rejects(() => service.updateOrderInvoice(identity, "audit-invoice-missing", firstBody)),
    rejects(() => service.updateOrderInvoice(identity, "audit-invoice-duplicate", firstBody)),
    rejects(() => service.updateOrderInvoice(identity, "audit-invoice-association", firstBody)),
  ]);

  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_invoice_replay_failure_probe"
       CHECK ("change_type" <> 'out_order_invoice') NOT VALID`,
  ));
  const rollbackFailed = await rejects(() => service.updateOrderInvoice(
    identity,
    "audit-invoice-rollback",
    personalBody("回滚抬头", "13800000004"),
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_invoice_replay_failure_probe"`,
  ));

  const state = await withTx(container, async (tx) => ({
    invoices: await tx.select({
      id: storeOrderInvoice.id,
      name: storeOrderInvoice.name,
      drawerPhone: storeOrderInvoice.drawerPhone,
      email: storeOrderInvoice.email,
    }).from(storeOrderInvoice).where(inArray(storeOrderInvoice.id, [6001, 6002, 6007])),
    replay: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_order_invoice")),
    audit: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "invoice")),
  }));
  const invoices = new Map(state.invoices.map((row) => [row.id, row]));
  const evidenceText = JSON.stringify([...state.replay, ...state.audit]);
  return {
    first_changed: !first.idempotent,
    replay_idempotent: replay.idempotent && replay.invoice_id === first.invoice_id,
    newer_change_applied: !newer.idempotent,
    delayed_replay_preserved_newer_value: delayed.idempotent
      && invoices.get(6001)?.name === "更新抬头"
      && invoices.get(6001)?.drawerPhone === "13800000002",
    concurrent_single_write: concurrent.filter((row) => row.idempotent).length === 1
      && concurrent.filter((row) => !row.idempotent).length === 1
      && invoices.get(6002)?.name === "并发抬头",
    platform_scope_enforced: scopeRejected,
    missing_application_rejected: missingRejected,
    duplicate_application_rejected: duplicateRejected,
    association_guard_enforced: associationRejected,
    replay_evidence_rows: state.replay.length,
    evidence_redacted: !evidenceText.includes("首次抬头")
      && !evidenceText.includes("更新抬头")
      && !evidenceText.includes("并发抬头")
      && !evidenceText.includes("1380000000")
      && !evidenceText.includes("example.invalid")
      && !evidenceText.includes("隔离地址")
      && !evidenceText.includes("123456789012"),
    rollback_preserved: rollbackFailed
      && invoices.get(6007)?.name === "原始抬头"
      && invoices.get(6007)?.drawerPhone === "13800000009",
  };
}

async function runInvoiceStatus(container: Container, schemaName: string) {
  const service = new OutApiService(container, {} as Env);
  const identity = account();
  const issuedBody = { is_invoice: 1, invoice_number: "00001234", remark: "生产隔离已开票" };
  const rejectedBody = { is_invoice: -1, invoice_number: "", remark: "生产隔离拒绝原因" };
  const first = await service.updateOrderInvoiceStatus(identity, "audit-invoice-status-first", issuedBody);
  const replay = await service.updateOrderInvoiceStatus(identity, "audit-invoice-status-first", issuedBody);
  const rejected = await service.updateOrderInvoiceStatus(identity, "audit-invoice-status-first", rejectedBody);
  const delayed = await service.updateOrderInvoiceStatus(identity, "audit-invoice-status-first", issuedBody);
  const raceBody = { is_invoice: 1, invoice_number: "00005678", remark: "并发开票" };
  const concurrent = await Promise.all([
    service.updateOrderInvoiceStatus(identity, "audit-invoice-status-race", raceBody),
    service.updateOrderInvoiceStatus(identity, "audit-invoice-status-race", raceBody),
  ]);

  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       ADD CONSTRAINT "out_invoice_status_replay_failure_probe"
       CHECK ("change_type" <> 'out_order_invoice_status') NOT VALID`,
  ));
  const rollbackFailed = await rejects(() => service.updateOrderInvoiceStatus(
    identity,
    "audit-invoice-status-rollback",
    { is_invoice: 1, invoice_number: "00009999", remark: "必须回滚" },
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(schemaName)}."store_order_status"
       DROP CONSTRAINT "out_invoice_status_replay_failure_probe"`,
  ));

  const state = await withTx(container, async (tx) => ({
    invoices: await tx.select({
      id: storeOrderInvoice.id,
      isInvoice: storeOrderInvoice.isInvoice,
      invoiceNumber: storeOrderInvoice.invoiceNumber,
      remark: storeOrderInvoice.remark,
    }).from(storeOrderInvoice).where(inArray(storeOrderInvoice.id, [6011, 6012, 6013])),
    replay: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_order_invoice_status")),
    audit: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "invoice_status")),
  }));
  const invoices = new Map(state.invoices.map((row) => [row.id, row]));
  const evidenceText = JSON.stringify([...state.replay, ...state.audit]);
  return {
    issued: !first.idempotent && first.is_invoice === 1,
    replay_idempotent: replay.idempotent && replay.is_invoice === 1,
    rejected_after_issue: !rejected.idempotent && rejected.is_invoice === -1,
    delayed_replay_preserved_newer_state: delayed.idempotent
      && delayed.is_invoice === 1
      && invoices.get(6011)?.isInvoice === -1
      && invoices.get(6011)?.invoiceNumber === "",
    concurrent_single_write: concurrent.filter((row) => row.idempotent).length === 1
      && concurrent.filter((row) => !row.idempotent).length === 1
      && invoices.get(6012)?.isInvoice === 1,
    replay_evidence_rows: state.replay.length,
    evidence_redacted: !evidenceText.includes("00001234")
      && !evidenceText.includes("00005678")
      && !evidenceText.includes("生产隔离已开票")
      && !evidenceText.includes("生产隔离拒绝原因")
      && !evidenceText.includes("并发开票"),
    rollback_preserved: rollbackFailed
      && invoices.get(6013)?.isInvoice === 0
      && invoices.get(6013)?.invoiceNumber === ""
      && invoices.get(6013)?.remark === "",
  };
}

export async function runOutApiInvoicePostgresScenario(
  connectionString: string,
): Promise<OutApiInvoicePostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_invoice_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 6, {
    searchPath: schemaName,
    applicationName: "cinashop_out_invoice_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let acl: Awaited<ReturnType<typeof runAcl>> | undefined;
  let invoice: Awaited<ReturnType<typeof runInvoice>> | undefined;
  let invoiceStatus: Awaited<ReturnType<typeof runInvoiceStatus>> | undefined;
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
    const container = createContainerFromDb(scoped);
    acl = await runAcl(container);
    invoice = await runInvoice(container, schemaName);
    invoiceStatus = await runInvoiceStatus(container, schemaName);
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
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_invoice_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      prefixCount = state[0]?.prefix_count ?? -1;
      after = await fingerprint(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }

  assertCondition(acl && invoice && invoiceStatus, "scenario report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(acl.writes_allowed === 2 && acl.missing_permission_rejected, "write ACL diverged");
  assertCondition(invoice.first_changed && invoice.replay_idempotent, "invoice replay diverged");
  assertCondition(
    invoice.newer_change_applied && invoice.delayed_replay_preserved_newer_value,
    "invoice delayed replay diverged",
  );
  assertCondition(invoice.concurrent_single_write, "invoice concurrency diverged");
  assertCondition(
    invoice.platform_scope_enforced
      && invoice.missing_application_rejected
      && invoice.duplicate_application_rejected
      && invoice.association_guard_enforced,
    "invoice scope or association guard diverged",
  );
  assertCondition(invoice.replay_evidence_rows === 3 && invoice.evidence_redacted, "invoice evidence diverged");
  assertCondition(invoice.rollback_preserved, "invoice rollback diverged");
  assertCondition(invoiceStatus.issued && invoiceStatus.replay_idempotent, "invoice status replay diverged");
  assertCondition(
    invoiceStatus.rejected_after_issue && invoiceStatus.delayed_replay_preserved_newer_state,
    "invoice status transition or delayed replay diverged",
  );
  assertCondition(invoiceStatus.concurrent_single_write, "invoice status concurrency diverged");
  assertCondition(
    invoiceStatus.replay_evidence_rows === 3 && invoiceStatus.evidence_redacted,
    "invoice status evidence diverged",
  );
  assertCondition(invoiceStatus.rollback_preserved, "invoice status rollback diverged");
  assertCondition(removed && prefixCount === 0, "temporary schema cleanup failed");
  assertCondition(unchanged, "public tables or sequences changed during isolated scenario");

  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    acl,
    invoice,
    invoice_status: invoiceStatus,
  };
}
