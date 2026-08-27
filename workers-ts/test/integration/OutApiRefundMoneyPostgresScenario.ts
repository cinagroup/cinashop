import { eq, sql } from "drizzle-orm";
import {
  outAccount,
  outInterface,
  storeOrder,
  storeOrderRefund,
  storeOrderStatus,
  user as userTable,
  userBill,
} from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import type { Env } from "@/env";
import {
  OutApiService,
  type AuthenticatedOutAccount,
} from "@/services/out/OutApiService";
import { AuthException } from "@/utils/errors";

const CLONED_TABLES = [
  "out_account",
  "out_interface",
  "user",
  "user_bill",
  "user_brokerage",
  "supplier_flowing_water",
  "supplier_transactions",
  "store_pink",
  "store_order",
  "store_order_cart_info",
  "store_order_invoice",
  "store_order_refund",
  "store_order_refund_payment",
  "store_order_status",
  "store_product",
  "store_product_attr_value",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "user_bill",
  "user_brokerage",
  "supplier_flowing_water",
  "supplier_transactions",
  "store_pink",
  "store_order_refund",
  "store_order_status",
] as const;

interface PublicSnapshot {
  rows: Record<string, number>;
  sequences: Record<string, string | null>;
}

export interface OutApiRefundMoneyPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  acl: {
    route_allowed: boolean;
    missing_permission_rejected: boolean;
  };
  balance_refund: {
    calls_completed: number;
    idempotent_replays: number;
    balance: string;
    refund_type: number;
    refunded_price: string;
    bill_rows: number;
    refund_status_rows: number;
  };
  guards: {
    missing_amount_rejected: boolean;
    partial_same_row_rejected: boolean;
    offscope_rejected: boolean;
    inconsistent_completed_replay_rejected: boolean;
  };
  refusal: {
    first_refused: boolean;
    replay_idempotent: boolean;
    overwrite_rejected: boolean;
    replay_rows: number;
  };
  failure_atomicity: {
    failure_rolled_back: boolean;
    retry_completed: boolean;
    balance: string;
    bill_rows: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `codex_out_refund_money_${Date.now().toString(36)}_${random[0].toString(36)}${random[1].toString(36)}`;
}

function identity(rules = [1]): AuthenticatedOutAccount {
  return { id: 1, appid: "out-refund-money-audit", title: "audit", rules };
}

function publicRefundOrderId(base: number, offset: number): string {
  return `audit-out-refund-${base + offset}`;
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  fn: (container: Container) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}, public`));
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '3s'"));
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '25s'"));
    return fn(createContainerFromDb(tx));
  });
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client<{ table_name: string; row_count: number }[]>`
    SELECT table_name, row_count::integer
    FROM (
      SELECT 'out_account' AS table_name, count(*) AS row_count FROM public.out_account
      UNION ALL SELECT 'out_interface', count(*) FROM public.out_interface
      UNION ALL SELECT 'user', count(*) FROM public."user"
      UNION ALL SELECT 'user_bill', count(*) FROM public.user_bill
      UNION ALL SELECT 'user_brokerage', count(*) FROM public.user_brokerage
      UNION ALL SELECT 'supplier_flowing_water', count(*) FROM public.supplier_flowing_water
      UNION ALL SELECT 'supplier_transactions', count(*) FROM public.supplier_transactions
      UNION ALL SELECT 'store_pink', count(*) FROM public.store_pink
      UNION ALL SELECT 'store_order', count(*) FROM public.store_order
      UNION ALL SELECT 'store_order_cart_info', count(*) FROM public.store_order_cart_info
      UNION ALL SELECT 'store_order_invoice', count(*) FROM public.store_order_invoice
      UNION ALL SELECT 'store_order_refund', count(*) FROM public.store_order_refund
      UNION ALL SELECT 'store_order_refund_payment', count(*) FROM public.store_order_refund_payment
      UNION ALL SELECT 'store_order_status', count(*) FROM public.store_order_status
      UNION ALL SELECT 'store_product', count(*) FROM public.store_product
      UNION ALL SELECT 'store_product_attr_value', count(*) FROM public.store_product_attr_value
    ) snapshot
    ORDER BY table_name
  `;
  const sequences = await db.$client<{ sequence_name: string; last_value: string | null }[]>`
    SELECT sequence_name,
      CASE WHEN is_called THEN last_value::text ELSE NULL END AS last_value
    FROM (
      SELECT 'user_bill_id_seq' AS sequence_name, last_value, is_called FROM public.user_bill_id_seq
      UNION ALL SELECT 'user_brokerage_id_seq', last_value, is_called FROM public.user_brokerage_id_seq
      UNION ALL SELECT 'supplier_flowing_water_id_seq', last_value, is_called FROM public.supplier_flowing_water_id_seq
      UNION ALL SELECT 'supplier_transactions_id_seq', last_value, is_called FROM public.supplier_transactions_id_seq
      UNION ALL SELECT 'store_pink_id_seq', last_value, is_called FROM public.store_pink_id_seq
      UNION ALL SELECT 'store_order_refund_id_seq', last_value, is_called FROM public.store_order_refund_id_seq
      UNION ALL SELECT 'store_order_status_id_seq', last_value, is_called FROM public.store_order_status_id_seq
    ) snapshot
    ORDER BY sequence_name
  `;
  return {
    rows: Object.fromEntries(rows.map((row) => [row.table_name, row.row_count])),
    sequences: Object.fromEntries(sequences.map((row) => [row.sequence_name, row.last_value])),
  };
}

async function seed(container: Container, base: number): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(outInterface).values({
    id: 1,
    pid: 0,
    type: 1,
    name: "资金退款",
    method: "PUT",
    url: "/refund/:order_id",
    isDel: 0,
  });
  await container.db.insert(outAccount).values({
    id: 1,
    appid: "out-refund-money-audit",
    appsecret: "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS",
    title: "audit",
    status: 1,
    rules: "[1]",
    isDel: 0,
  });

  const fixtures = [
    { offset: 1, amount: "10.00", storeId: 0, type: 1, refunded: "0.00" },
    { offset: 2, amount: "7.00", storeId: 0, type: 1, refunded: "0.00" },
    { offset: 3, amount: "5.00", storeId: 1, type: 1, refunded: "0.00" },
    { offset: 4, amount: "9.00", storeId: 0, type: 6, refunded: "4.00" },
    { offset: 5, amount: "3.00", storeId: 0, type: 1, refunded: "0.00" },
    { offset: 6, amount: "2.00", storeId: 0, type: 1, refunded: "0.00" },
  ] as const;
  await container.db.insert(userTable).values(fixtures.map((fixture) => ({
    uid: base + 100 + fixture.offset,
    nickname: `隔离退款用户${fixture.offset}`,
    nowMoney: "5.00",
    status: 1,
    addTime: now,
  })));
  await container.db.insert(storeOrder).values(fixtures.map((fixture) => ({
    id: base + 1_000 + fixture.offset,
    orderId: `audit-order-${base + fixture.offset}`,
    uid: base + 100 + fixture.offset,
    storeId: fixture.storeId,
    supplierId: 0,
    totalNum: 1,
    totalPrice: fixture.amount,
    payPrice: fixture.amount,
    paid: 1,
    status: 1,
    payType: "yue",
    refundStatus: fixture.type === 6 ? 2 : 1,
    refundType: fixture.type,
    refundPrice: fixture.refunded,
    addTime: now,
  })));
  await container.db.insert(storeOrderRefund).values(fixtures.map((fixture) => ({
    id: base + 2_000 + fixture.offset,
    storeOrderId: base + 1_000 + fixture.offset,
    storeId: fixture.storeId,
    orderId: publicRefundOrderId(base, fixture.offset),
    uid: base + 100 + fixture.offset,
    supplierId: 0,
    applyType: 1,
    refundType: fixture.type,
    refundNum: 1,
    refundPrice: fixture.amount,
    refundedPrice: fixture.refunded,
    refundReason: "生产隔离退款审计",
    addTime: now,
  })));
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function runAcl(container: Container) {
  const service = new OutApiService(container, {} as Env);
  await service.assertInterfacePermission(identity(), "PUT", "/refund/{order_id}");
  let missingPermissionRejected = false;
  try {
    await service.assertInterfacePermission(identity([]), "PUT", "/refund/{order_id}");
  } catch (error) {
    missingPermissionRejected = error instanceof AuthException;
  }
  return { route_allowed: true, missing_permission_rejected: missingPermissionRejected };
}

async function readRefundState(container: Container, base: number, offset: number) {
  const uid = base + 100 + offset;
  const refundId = base + 2_000 + offset;
  const orderId = base + 1_000 + offset;
  const [accounts, refunds, bills, statuses] = await Promise.all([
    container.db.select({ balance: userTable.nowMoney }).from(userTable).where(eq(userTable.uid, uid)),
    container.db.select({ type: storeOrderRefund.refundType, refunded: storeOrderRefund.refundedPrice })
      .from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId)),
    container.db.select({ id: userBill.id }).from(userBill)
      .where(eq(userBill.uid, uid)),
    container.db.select({ type: storeOrderStatus.changeType }).from(storeOrderStatus)
      .where(eq(storeOrderStatus.oid, orderId)),
  ]);
  return {
    balance: accounts[0]?.balance ?? "missing",
    refundType: refunds[0]?.type ?? -1,
    refundedPrice: refunds[0]?.refunded ?? "missing",
    billRows: bills.length,
    refundStatusRows: statuses.filter((row) => row.type === "refund_price").length,
    refusalReplayRows: statuses.filter((row) => row.type === "out_refund_refuse").length,
  };
}

async function runScenario(
  adminDb: DbClient,
  concurrentDbA: DbClient,
  concurrentDbB: DbClient,
  schemaName: string,
  base: number,
) {
  const acl = await withSchema(adminDb, schemaName, runAcl);
  const actor = identity();
  const call = (db: DbClient, offset: number, body: Record<string, unknown>) =>
    withSchema(db, schemaName, (container) =>
      new OutApiService(container, {} as Env).refundPrice(
        actor,
        publicRefundOrderId(base, offset),
        body,
      ));

  const [first, replay] = await Promise.all([
    call(concurrentDbA, 1, { type: 1, refund_price: "10.00" }),
    call(concurrentDbB, 1, { type: 1, refund_price: 10 }),
  ]);
  const balanceState = await withSchema(adminDb, schemaName, (container) =>
    readRefundState(container, base, 1));
  assertCondition(first.completed && replay.completed, "balance refund calls did not complete");
  assertCondition(balanceState.balance === "15.00", "duplicate Out balance refund changed balance twice");
  assertCondition(balanceState.billRows === 1, "duplicate Out balance refund created duplicate bills");
  assertCondition(balanceState.refundStatusRows === 1, "duplicate Out refund created duplicate status rows");

  const missingAmount = await rejects(() => call(adminDb, 2, { type: 1 }));
  const partial = await rejects(() => call(adminDb, 2, { type: 1, refund_price: "3.50" }));
  const offscope = await rejects(() => call(adminDb, 3, { type: 1, refund_price: "5.00" }));
  const inconsistent = await rejects(() => call(adminDb, 4, { type: 1, refund_price: "9.00" }));
  const guardedState = await withSchema(adminDb, schemaName, (container) =>
    readRefundState(container, base, 2));
  assertCondition(guardedState.balance === "5.00" && guardedState.billRows === 0,
    "amount guard changed financial state");

  const refused = await call(adminDb, 5, { type: 2, refuse_reason: "生产隔离拒绝原因" });
  const refusedReplay = await call(adminDb, 5, { type: 2, refuse_reason: "生产隔离拒绝原因" });
  const overwrite = await rejects(() =>
    call(adminDb, 5, { type: 2, refuse_reason: "伪造覆盖原因" }));
  const refusalState = await withSchema(adminDb, schemaName, (container) =>
    readRefundState(container, base, 5));
  assertCondition(refusalState.refundType === 3, "direct refusal did not persist rejected state");

  await adminDb.$client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${identifier(schemaName)}, public`);
    await tx.unsafe(
      `ALTER TABLE ${identifier(schemaName)}."store_order_status" ADD CONSTRAINT "refund_failure_probe" ` +
      `CHECK ("change_type" <> 'refund_price') NOT VALID`,
    );
  });
  const failed = await rejects(() => call(adminDb, 6, { type: 1, refund_price: "2.00" }));
  const failedState = await withSchema(adminDb, schemaName, (container) =>
    readRefundState(container, base, 6));
  await adminDb.$client.begin(async (tx) => {
    await tx.unsafe(
      `ALTER TABLE ${identifier(schemaName)}."store_order_status" DROP CONSTRAINT "refund_failure_probe"`,
    );
  });
  const retry = await call(adminDb, 6, { type: 1, refund_price: "2.00" });
  const retryState = await withSchema(adminDb, schemaName, (container) =>
    readRefundState(container, base, 6));
  assertCondition(failed, "injected refund failure was not propagated");
  assertCondition(
    failedState.balance === "5.00" && failedState.refundType === 1 && failedState.billRows === 0,
    "failed Out refund did not roll back atomically",
  );
  assertCondition(retry.completed && retryState.balance === "7.00" && retryState.billRows === 1,
    "Out refund retry did not complete exactly once");

  return {
    acl,
    balance_refund: {
      calls_completed: [first, replay].filter((result) => result.completed).length,
      idempotent_replays: [first, replay].filter((result) => result.idempotent).length,
      balance: balanceState.balance,
      refund_type: balanceState.refundType,
      refunded_price: balanceState.refundedPrice,
      bill_rows: balanceState.billRows,
      refund_status_rows: balanceState.refundStatusRows,
    },
    guards: {
      missing_amount_rejected: missingAmount,
      partial_same_row_rejected: partial,
      offscope_rejected: offscope,
      inconsistent_completed_replay_rejected: inconsistent,
    },
    refusal: {
      first_refused: refused.refund_type === 3,
      replay_idempotent: refusedReplay.idempotent,
      overwrite_rejected: overwrite,
      replay_rows: refusalState.refusalReplayRows,
    },
    failure_atomicity: {
      failure_rolled_back: failed,
      retry_completed: retry.completed,
      balance: retryState.balance,
      bill_rows: retryState.billRows,
    },
  };
}

export async function runOutApiRefundMoneyPostgresScenario(
  connectionString: string,
): Promise<OutApiRefundMoneyPostgresReport> {
  const schemaName = makeSchemaName();
  const schemaIdentifier = identifier(schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_refund_money_audit",
  });
  const concurrentDbA = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_refund_money_audit_a",
  });
  const concurrentDbB = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_refund_money_audit_b",
  });
  const clients = [adminDb.$client, concurrentDbA.$client, concurrentDbB.$client];
  let created = false;
  let schemaRemoved = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let report: Omit<OutApiRefundMoneyPostgresReport,
    "server_version" | "schema_created" | "schema_removed" | "public_state_unchanged"> | undefined;
  let serverVersion = "unknown";

  try {
    const versions = await adminDb.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await publicSnapshot(adminDb);
    await adminDb.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '25s'`;
      await tx.unsafe(`CREATE SCHEMA ${schemaIdentifier}`);
      for (const table of CLONED_TABLES) {
        const tableIdentifier = identifier(table);
        await tx.unsafe(
          `CREATE TABLE ${schemaIdentifier}.${tableIdentifier} ` +
          `(LIKE public.${tableIdentifier} INCLUDING ALL)`,
        );
      }
      for (const table of LOCAL_SEQUENCE_TABLES) {
        const tableIdentifier = identifier(table);
        const sequenceIdentifier = identifier(`${table}_id_seq_it`);
        await tx.unsafe(`CREATE SEQUENCE ${schemaIdentifier}.${sequenceIdentifier}`);
        await tx.unsafe(
          `ALTER SEQUENCE ${schemaIdentifier}.${sequenceIdentifier} ` +
          `OWNED BY ${schemaIdentifier}.${tableIdentifier}."id"`,
        );
        await tx.unsafe(
          `ALTER TABLE ${schemaIdentifier}.${tableIdentifier} ALTER COLUMN "id" ` +
          `SET DEFAULT nextval('${schemaName}.${table}_id_seq_it'::regclass)`,
        );
      }
    });
    created = true;
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const base = 1_550_000_000 + (random[0] % 20_000_000);
    await withSchema(adminDb, schemaName, (container) => seed(container, base));
    report = await runScenario(adminDb, concurrentDbA, concurrentDbB, schemaName, base);
  } finally {
    try {
      if (created) {
        await adminDb.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '25s'`;
          await tx.unsafe(`DROP SCHEMA ${schemaIdentifier} CASCADE`);
        });
      }
      const rows = await adminDb.$client<{ removed: boolean }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS removed
      `;
      schemaRemoved = rows[0]?.removed === true;
      after = await publicSnapshot(adminDb);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 })));
    }
  }

  assertCondition(report, "Out money refund scenario did not produce a report");
  assertCondition(before && after, "public refund snapshots are missing");
  assertCondition(schemaRemoved, "temporary Out money refund schema was not removed");
  const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicStateUnchanged, "public business rows or sequences changed");
  return {
    server_version: serverVersion,
    schema_created: true,
    ...report,
    schema_removed: schemaRemoved,
    public_state_unchanged: publicStateUnchanged,
  };
}
