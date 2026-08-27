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
  storeOrderRefund,
  storeOrderRefundPayment,
  storeOrderStatus,
} from "@/models/schema";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { AuthException } from "@/utils/errors";

const TABLES = [
  "out_account", "out_interface", "store_order", "store_order_refund",
  "store_order_refund_payment", "store_order_status",
] as const;
const SEQUENCES: Record<(typeof TABLES)[number], string> = Object.fromEntries(
  TABLES.map((table) => [table, `${table}_id_seq`]),
) as Record<(typeof TABLES)[number], string>;

interface Fingerprint {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface OutApiRefundDecisionPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  acl: { writes_allowed: number; missing_permission_rejected: boolean };
  agree: Record<string, boolean | number>;
  refuse: Record<string, boolean | number>;
}

function assertCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Out API refund decision integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_refund_decision_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of TABLES) {
    const rows = await db.$client.unsafe<Array<{ count: string; max_id: string | null; digest: string }>>(
      `SELECT count(*)::text AS count, max(t."id")::text AS max_id,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t."id"), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const names = TABLES.map((table) => SEQUENCES[table]);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names}) ORDER BY sequencename
  `;
  const values = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return { tables, sequences: Object.fromEntries(names.map((name) => [name, values.get(name) ?? null])) };
}

async function setup(db: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      const tableName = identifier(table);
      const sequence = `${table}_id_seq_it`;
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequence)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${name}.${sequence}'::regclass)`,
      );
    }
  });
}

async function inSchema<T>(db: DbClient, name: string, fn: (container: Container) => Promise<T>) {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(name)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return fn(createContainerFromDb(tx));
  });
}

function identity(): AuthenticatedOutAccount {
  return { id: 1, appid: "out-refund-decision-audit", title: "audit", rules: [1, 2] };
}

async function seed(container: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await container.db.insert(outInterface).values([
    { id: 1, pid: 0, type: 1, name: "同意退货", method: "PUT", url: "/refund/agree/:order_id", isDel: 0 },
    { id: 2, pid: 0, type: 1, name: "拒绝售后", method: "PUT", url: "/refund/refuse/:order_id", isDel: 0 },
    { id: 3, pid: 0, type: 1, name: "资金退款", method: "PUT", url: "/refund/:order_id", isDel: 0 },
  ]);
  await container.db.insert(outAccount).values({
    id: 1, appid: "out-refund-decision-audit",
    appsecret: "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS",
    title: "audit", status: 1, rules: "[1,2]", isDel: 0,
  });
  const order = {
    uid: 951, realName: "隔离售后用户", userPhone: "13800000009", totalNum: 1,
    totalPrice: "10.00", payPrice: "10.00", paid: 1, status: 1, shippingType: 1,
    refundStatus: 1, refundType: 2, addTime: now, storeId: 0, supplierId: 0,
    isDel: 0, isSystemDel: 0,
  } as const;
  const ids = [1401, 1402, 1403, 1404, 1405, 1406, 1407, 1411, 1412, 1413, 1414];
  await container.db.insert(storeOrder).values(ids.map((id) => ({
    ...order,
    id,
    orderId: `audit-refund-decision-order-${id}`,
    unique: `out-refund-decision-${id}`,
    ...(id === 1403 ? { storeId: 9 } : {}),
  })));
  const refund = {
    storeId: 0, uid: 951, supplierId: 0, applyType: 2, applyPrice: "10.00",
    refundType: 0, refundNum: 1, refundPrice: "10.00", refundedPrice: "0.00",
    refundReason: "隔离售后", isCancel: 0, isDel: 0, addTime: now,
  } as const;
  await container.db.insert(storeOrderRefund).values(ids.map((id) => ({
    ...refund,
    id: id + 5600,
    storeOrderId: id,
    orderId: `audit-refund-decision-${id}`,
    ...(id === 1403 ? { storeId: 9 } : {}),
    ...(id === 1404 ? { applyType: 1 } : {}),
    ...(id === 1405 ? { supplierId: 8 } : {}),
    ...(id === 1414 ? { isCancel: 1 } : {}),
  })));
  await container.db.insert(storeOrderRefundPayment).values({
    id: 9001,
    refundId: 7006,
    storeOrderId: 1406,
    provider: "wechat",
    outRefundNo: "CNSR7006",
    providerStatus: "PROCESSING",
    requestAmount: 1000,
    totalAmount: 1000,
    addTime: now,
    updateTime: now,
  });
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function runAcl(container: Container) {
  return withTx(container, async (tx) => {
    const service = new OutApiService(createContainerFromDb(tx), {} as Env);
    let allowed = 0;
    for (const route of ["/refund/agree/{order_id}", "/refund/refuse/{order_id}"]) {
      await service.assertInterfacePermission(identity(), "PUT", route);
      allowed += 1;
    }
    let denied = false;
    try { await service.assertInterfacePermission(identity(), "PUT", "/refund/{order_id}"); }
    catch (error) { denied = error instanceof AuthException; }
    return { writes_allowed: allowed, missing_permission_rejected: denied };
  });
}

async function runDecisions(container: Container, name: string) {
  const service = new OutApiService(container, {} as Env);
  const actor = identity();
  const first = await service.agreeRefundReturn(actor, "audit-refund-decision-1401");
  const replay = await service.agreeRefundReturn(actor, "audit-refund-decision-1401");
  const refusedAfterAgree = await service.refuseRefund(actor, "audit-refund-decision-1401", {
    refund_reason: "同意后重新审核拒绝",
  });
  const delayed = await service.agreeRefundReturn(actor, "audit-refund-decision-1401");
  const agreeRace = await Promise.all([
    service.agreeRefundReturn(actor, "audit-refund-decision-1402"),
    service.agreeRefundReturn(actor, "audit-refund-decision-1402"),
  ]);
  const guards = await Promise.all([1403, 1404, 1405, 1406, 1414].map((id) =>
    rejects(() => service.agreeRefundReturn(actor, `audit-refund-decision-${id}`))));

  const refuseBody = { refund_reason: "生产隔离拒绝原因" };
  const refused = await service.refuseRefund(actor, "audit-refund-decision-1411", refuseBody);
  const refuseReplay = await service.refuseRefund(actor, "audit-refund-decision-1411", refuseBody);
  const overwriteRejected = await rejects(() => service.refuseRefund(
    actor, "audit-refund-decision-1411", { refund_reason: "伪造覆盖原因" },
  ));
  const refuseRace = await Promise.all([
    service.refuseRefund(actor, "audit-refund-decision-1412", { refund_reason: "并发拒绝原因" }),
    service.refuseRefund(actor, "audit-refund-decision-1412", { refund_reason: "并发拒绝原因" }),
  ]);

  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}."store_order_status" ADD CONSTRAINT "agree_probe"
     CHECK ("change_type" <> 'out_refund_agree') NOT VALID`,
  ));
  const agreeRollback = await rejects(() => service.agreeRefundReturn(actor, "audit-refund-decision-1407"));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}."store_order_status" DROP CONSTRAINT "agree_probe"`,
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}."store_order_status" ADD CONSTRAINT "refuse_probe"
     CHECK ("change_type" <> 'out_refund_refuse') NOT VALID`,
  ));
  const refuseRollback = await rejects(() => service.refuseRefund(
    actor, "audit-refund-decision-1413", { refund_reason: "必须回滚原因" },
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}."store_order_status" DROP CONSTRAINT "refuse_probe"`,
  ));

  const state = await withTx(container, async (tx) => ({
    refunds: await tx.select({
      id: storeOrderRefund.id, refundType: storeOrderRefund.refundType,
      refuseReason: storeOrderRefund.refuseReason,
    }).from(storeOrderRefund).where(inArray(storeOrderRefund.id, [7001, 7002, 7007, 7011, 7012, 7013])),
    orders: await tx.select({
      id: storeOrder.id, refundStatus: storeOrder.refundStatus, refundType: storeOrder.refundType,
    }).from(storeOrder).where(inArray(storeOrder.id, [1401, 1402, 1407, 1411, 1412, 1413])),
    agreeEvidence: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_refund_agree")),
    refuseEvidence: await tx.select().from(storeOrderStatus)
      .where(eq(storeOrderStatus.changeType, "out_refund_refuse")),
  }));
  const refunds = new Map(state.refunds.map((row) => [row.id, row]));
  const orders = new Map(state.orders.map((row) => [row.id, row]));
  const evidence = JSON.stringify([...state.agreeEvidence, ...state.refuseEvidence]);
  return {
    agree: {
      first_changed: !first.idempotent,
      replay_idempotent: replay.idempotent,
      delayed_replay_preserved_refusal: !refusedAfterAgree.idempotent && delayed.idempotent
        && delayed.refund_type === 4 && refunds.get(7001)?.refundType === 3,
      concurrent_single_write: agreeRace.filter((row) => row.idempotent).length === 1,
      platform_and_state_guards: guards.every(Boolean),
      evidence_rows: state.agreeEvidence.length,
      rollback_preserved: agreeRollback && refunds.get(7007)?.refundType === 0
        && orders.get(1407)?.refundType === 2,
    },
    refuse: {
      first_changed: !refused.idempotent,
      replay_idempotent: refuseReplay.idempotent,
      reason_overwrite_rejected: overwriteRejected,
      concurrent_single_write: refuseRace.filter((row) => row.idempotent).length === 1,
      evidence_rows: state.refuseEvidence.length,
      evidence_redacted: !evidence.includes("同意后重新审核拒绝")
        && !evidence.includes("生产隔离拒绝原因") && !evidence.includes("并发拒绝原因"),
      rollback_preserved: refuseRollback && refunds.get(7013)?.refundType === 0
        && refunds.get(7013)?.refuseReason === "" && orders.get(1413)?.refundType === 2,
    },
  };
}

export async function runOutApiRefundDecisionPostgresScenario(
  connectionString: string,
): Promise<OutApiRefundDecisionPostgresReport> {
  const name = schemaName();
  const schema = identifier(name);
  const root = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_out_refund_decision_root" });
  const scoped = createDbFromConnectionString(connectionString, 6, {
    searchPath: name, applicationName: "cinashop_out_refund_decision_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let acl: Awaited<ReturnType<typeof runAcl>> | undefined;
  let decisions: Awaited<ReturnType<typeof runDecisions>> | undefined;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`SELECT current_setting('server_version') AS server_version`;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await fingerprint(root);
    await setup(root, name);
    created = true;
    await inSchema(scoped, name, seed);
    const container = createContainerFromDb(scoped);
    acl = await runAcl(container);
    decisions = await runDecisions(container, name);
  } finally {
    try {
      if (created) await root.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      });
      const state = await root.$client<{ removed: boolean; count: number }[]>`
        SELECT to_regnamespace(${name}) IS NULL AS removed,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_refund_decision_%') AS count
      `;
      removed = state[0]?.removed === true;
      prefixCount = state[0]?.count ?? -1;
      after = await fingerprint(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }
  assertCondition(acl && decisions, "scenario report missing");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(acl.writes_allowed === 2 && acl.missing_permission_rejected, "ACL diverged");
  assertCondition(
    decisions.agree.first_changed && decisions.agree.replay_idempotent
      && decisions.agree.delayed_replay_preserved_refusal
      && decisions.agree.concurrent_single_write && decisions.agree.platform_and_state_guards
      && decisions.agree.evidence_rows === 2 && decisions.agree.rollback_preserved,
    "agree decision diverged",
  );
  assertCondition(
    decisions.refuse.first_changed && decisions.refuse.replay_idempotent
      && decisions.refuse.reason_overwrite_rejected && decisions.refuse.concurrent_single_write
      && decisions.refuse.evidence_rows === 3 && decisions.refuse.evidence_redacted
      && decisions.refuse.rollback_preserved,
    "refuse decision diverged",
  );
  assertCondition(removed && prefixCount === 0 && unchanged, "cleanup or public fingerprint diverged");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    acl,
    agree: decisions.agree,
    refuse: decisions.refuse,
  };
}
