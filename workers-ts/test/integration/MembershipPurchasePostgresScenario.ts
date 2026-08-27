import { sql } from "drizzle-orm";
import { createContainerFromDb, createDbFromConnectionString, withTx, type Container, type DbClient } from "../../src/lib/di";
import {
  applyMembershipPayment,
  createMembershipOrder,
} from "../../src/services/user/PaidMembershipService";

const DDL = `
CREATE TABLE "user" (
  uid SERIAL PRIMARY KEY,
  now_money NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  is_money_level SMALLINT DEFAULT 0 NOT NULL,
  is_ever_level SMALLINT DEFAULT 0 NOT NULL,
  overdue_time INTEGER DEFAULT 0 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE member_ship (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) DEFAULT 'month' NOT NULL,
  title VARCHAR(200) DEFAULT '' NOT NULL,
  vip_day INTEGER DEFAULT 0 NOT NULL,
  price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  pre_price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  is_label SMALLINT DEFAULT 0 NOT NULL,
  sort INTEGER DEFAULT 0 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE other_order (
  id SERIAL PRIMARY KEY,
  store_id INTEGER DEFAULT 0 NOT NULL,
  staff_id INTEGER DEFAULT 0 NOT NULL,
  uid INTEGER DEFAULT 0 NOT NULL,
  type SMALLINT DEFAULT 0 NOT NULL,
  order_id VARCHAR(32) DEFAULT '' NOT NULL,
  member_type VARCHAR(10) DEFAULT '' NOT NULL,
  code VARCHAR(20) DEFAULT '' NOT NULL,
  pay_type VARCHAR(32) DEFAULT '' NOT NULL,
  paid SMALLINT DEFAULT 0 NOT NULL,
  pay_price NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  member_price NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  pay_time INTEGER DEFAULT 0 NOT NULL,
  trade_no VARCHAR(50) DEFAULT '' NOT NULL,
  channel_type VARCHAR(10) DEFAULT '' NOT NULL,
  is_free SMALLINT DEFAULT 0 NOT NULL,
  is_permanent SMALLINT DEFAULT 0 NOT NULL,
  overdue_time INTEGER DEFAULT 0 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL,
  vip_day INTEGER DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  money NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  remarks VARCHAR(255) DEFAULT '' NOT NULL
);
CREATE INDEX other_order_order_id ON other_order (order_id);
CREATE TABLE other_order_status (
  oid INTEGER DEFAULT 0 NOT NULL,
  change_type VARCHAR(32) DEFAULT '' NOT NULL,
  change_message VARCHAR(256) DEFAULT '' NOT NULL,
  shop_type SMALLINT DEFAULT 1 NOT NULL,
  change_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE user_bill (
  id SERIAL PRIMARY KEY,
  uid INTEGER DEFAULT 0 NOT NULL,
  link_id VARCHAR(32) DEFAULT '0' NOT NULL,
  pm SMALLINT DEFAULT 0 NOT NULL,
  title VARCHAR(64) DEFAULT '' NOT NULL,
  category VARCHAR(64) DEFAULT '' NOT NULL,
  type VARCHAR(64) DEFAULT '' NOT NULL,
  event_key VARCHAR(64) DEFAULT '' NOT NULL,
  number NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  balance NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  mark VARCHAR(512) DEFAULT '' NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  status SMALLINT DEFAULT 1 NOT NULL,
  take SMALLINT DEFAULT 0 NOT NULL,
  frozen_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE audit_public_snapshot (position VARCHAR(8) PRIMARY KEY, snapshot JSONB NOT NULL);
CREATE TABLE audit_result (id SMALLINT PRIMARY KEY, audit_key VARCHAR(32) NOT NULL, result JSONB NOT NULL);
`;

interface PublicSnapshot {
  user_count: string;
  plan_count: string;
  order_count: string;
  status_count: string;
  bill_count: string;
  user_sequence: string;
  plan_sequence: string;
  order_sequence: string;
  bill_sequence: string;
}

export interface MembershipPurchaseAuditResult {
  authoritative_price: boolean;
  balance_debited_once: boolean;
  balance_bill_once: boolean;
  concurrent_outcomes: string[];
  paid_membership_applied: boolean;
  free_claim_settled: boolean;
  duplicate_free_rejected: boolean;
  free_extended_membership: boolean;
  amount_mismatch_rejected: boolean;
  mismatched_callback_rolled_back: boolean;
  external_callback_idempotent: boolean;
  conflicting_trade_rejected: boolean;
  permanent_membership_applied: boolean;
  insufficient_balance_rolled_back: boolean;
  status_evidence_count: number;
}

function schemaName(value: string): string {
  if (!/^codex_member_pay_[a-z0-9_]{8,36}$/.test(value) || value.length > 63) {
    throw new Error("unsafe membership-purchase audit schema name");
  }
  return value;
}

function auditKey(value: string): string {
  if (!/^mpay-[a-z0-9]{10,20}$/.test(value)) throw new Error("invalid membership-purchase audit key");
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Membership-purchase audit failed: ${message}`);
}

function container(connectionString: string, schema: string): Container {
  return createContainerFromDb(createDbFromConnectionString(connectionString, 4, {
    searchPath: schemaName(schema),
    applicationName: "cinashop_member_pay_audit",
  }));
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client.unsafe<Array<{ snapshot: PublicSnapshot }>>(`
    SELECT jsonb_build_object(
      'user_count', (SELECT count(*)::text FROM public."user"),
      'plan_count', (SELECT count(*)::text FROM public.member_ship),
      'order_count', (SELECT count(*)::text FROM public.other_order),
      'status_count', (SELECT count(*)::text FROM public.other_order_status),
      'bill_count', (SELECT count(*)::text FROM public.user_bill),
      'user_sequence', (SELECT last_value::text FROM public.user_uid_seq),
      'plan_sequence', (SELECT last_value::text FROM public.member_ship_id_seq),
      'order_sequence', (SELECT last_value::text FROM public.other_order_id_seq),
      'bill_sequence', (SELECT last_value::text FROM public.user_bill_id_seq)
    ) AS snapshot
  `);
  if (!rows[0]) throw new Error("could not capture public membership-purchase snapshot");
  return rows[0].snapshot;
}

async function publicMarkerCount(db: DbClient, key: string): Promise<number> {
  const rows = await db.$client.unsafe<Array<{ count: number }>>(`
    SELECT (
      (SELECT count(*) FROM public.member_ship WHERE title LIKE $1 || '%') +
      (SELECT count(*) FROM public.other_order WHERE order_id LIKE $1 || '%')
    )::int AS count
  `, [key]);
  return rows[0]?.count ?? -1;
}

export async function setupMembershipPurchaseAudit(connectionString: string, schemaValue: string, keyValue: string) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const admin = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_member_pay_setup" });
  try {
    const exists = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    if (exists[0]?.exists) throw new Error("membership-purchase audit schema already exists");
    const [before, marker] = await Promise.all([publicSnapshot(admin), publicMarkerCount(admin, key)]);
    assert(marker === 0, "public audit marker already exists");
    await admin.$client.unsafe(`CREATE SCHEMA "${schema}"`);
    const scoped = container(connectionString, schema);
    try {
      await withTx(scoped, async (tx) => {
        await tx.execute(sql.raw(DDL));
        await tx.execute(sql`INSERT INTO audit_public_snapshot (position, snapshot) VALUES ('before', ${JSON.stringify(before)}::jsonb)`);
      });
    } finally {
      await scoped.db.$client.end();
    }
    return { schema_created: true, public_marker_count: marker };
  } finally {
    await admin.$client.end();
  }
}

export async function runMembershipPurchaseAudit(connectionString: string, schemaValue: string, keyValue: string): Promise<MembershipPurchaseAuditResult> {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const scoped = container(connectionString, schema);
  const now = 1_786_560_000;
  const paidOrderId = `${key}-paid`;
  const freeOrderId = `${key}-free`;
  const permanentOrderId = `${key}-ever`;
  const insufficientOrderId = `${key}-low`;
  try {
    const ids = await withTx(scoped, async (tx) => {
      await tx.execute(sql`
        INSERT INTO "user" (uid, now_money) VALUES (2100000001, 250.00), (2100000002, 10.00)
      `);
      const plans = await tx.execute(sql`
        INSERT INTO member_ship (type, title, vip_day, price, pre_price, is_label, sort, add_time)
        VALUES
          ('year', ${`${key}-year`}, 365, 199.00, 99.00, 1, 30, ${now}),
          ('free', ${`${key}-free`}, 30, 0.00, 0.00, 0, 20, ${now}),
          ('ever', ${`${key}-ever`}, -1, 599.00, 399.00, 0, 10, ${now})
        RETURNING id, type
      `) as unknown as Array<{ id: number; type: string }>;
      return Object.fromEntries(plans.map((plan) => [plan.type, plan.id])) as Record<string, number>;
    });

    const paid = await createMembershipOrder(scoped, {
      uid: 2100000001,
      planId: ids.year,
      orderId: paidOrderId,
      channel: "h5",
      now,
    });
    const concurrent = await Promise.all([
      applyMembershipPayment(scoped, { uid: 2100000001, orderId: paidOrderId, payType: "yue", debitBalance: true, now: now + 1 }),
      applyMembershipPayment(scoped, { uid: 2100000001, orderId: paidOrderId, payType: "yue", debitBalance: true, now: now + 1 }),
    ]);
    const paidOutcome = concurrent.find((item) => item.outcome === "paid");

    const free = await createMembershipOrder(scoped, {
      uid: 2100000001,
      planId: ids.free,
      orderId: freeOrderId,
      channel: "routine",
      now: now + 2,
    });
    let duplicateFreeRejected = false;
    try {
      await createMembershipOrder(scoped, {
        uid: 2100000001,
        planId: ids.free,
        orderId: `${key}-free2`,
        channel: "routine",
        now: now + 3,
      });
    } catch {
      duplicateFreeRejected = true;
    }

    const permanent = await createMembershipOrder(scoped, {
      uid: 2100000001,
      planId: ids.ever,
      orderId: permanentOrderId,
      channel: "wechat",
      now: now + 4,
    });
    let amountMismatchRejected = false;
    try {
      await applyMembershipPayment(scoped, {
        orderId: permanentOrderId,
        payType: "weixin",
        tradeNo: `${key}-wx`,
        expectedAmountCents: 39_899,
        now: now + 5,
      });
    } catch {
      amountMismatchRejected = true;
    }
    const afterMismatch = await withTx(scoped, async (tx) => tx.execute(sql`
      SELECT paid FROM other_order WHERE order_id = ${permanentOrderId}
    `) as unknown as Array<{ paid: number }>);
    const settled = await applyMembershipPayment(scoped, {
      orderId: permanentOrderId,
      payType: "weixin",
      tradeNo: `${key}-wx`,
      expectedAmountCents: 39_900,
      now: now + 6,
    });
    const replay = await applyMembershipPayment(scoped, {
      orderId: permanentOrderId,
      payType: "weixin",
      tradeNo: `${key}-wx`,
      expectedAmountCents: 39_900,
      now: now + 7,
    });
    let conflictingTradeRejected = false;
    try {
      await applyMembershipPayment(scoped, {
        orderId: permanentOrderId,
        payType: "weixin",
        tradeNo: `${key}-wx-other`,
        expectedAmountCents: 39_900,
        now: now + 8,
      });
    } catch {
      conflictingTradeRejected = true;
    }

    await createMembershipOrder(scoped, {
      uid: 2100000002,
      planId: ids.year,
      orderId: insufficientOrderId,
      channel: "h5",
      now: now + 9,
    });
    let insufficientRejected = false;
    try {
      await applyMembershipPayment(scoped, {
        uid: 2100000002,
        orderId: insufficientOrderId,
        payType: "yue",
        debitBalance: true,
        now: now + 10,
      });
    } catch {
      insufficientRejected = true;
    }

    const rows = await withTx(scoped, async (tx) => tx.execute(sql`
      SELECT
        (SELECT now_money::text FROM "user" WHERE uid = 2100000001) AS balance,
        (SELECT is_money_level FROM "user" WHERE uid = 2100000001) AS is_money_level,
        (SELECT is_ever_level FROM "user" WHERE uid = 2100000001) AS is_ever_level,
        (SELECT overdue_time FROM "user" WHERE uid = 2100000001) AS overdue_time,
        (SELECT count(*)::int FROM user_bill WHERE uid = 2100000001 AND type = 'pay_member') AS bills,
        (SELECT count(*)::int FROM other_order_status) AS statuses,
        (SELECT paid FROM other_order WHERE order_id = ${insufficientOrderId}) AS insufficient_paid,
        (SELECT now_money::text FROM "user" WHERE uid = 2100000002) AS insufficient_balance,
        (SELECT is_money_level FROM "user" WHERE uid = 2100000002) AS insufficient_member
    `) as unknown as Array<{
      balance: string;
      is_money_level: number;
      is_ever_level: number;
      overdue_time: number;
      bills: number;
      statuses: number;
      insufficient_paid: number;
      insufficient_balance: string;
      insufficient_member: number;
    }>);
    const state = rows[0];
    assert(state, "isolated state query returned no row");
    const outcomes = concurrent.map((item) => item.outcome).sort();
    const result: MembershipPurchaseAuditResult = {
      authoritative_price: paid.pay_price === "99.00" && permanent.pay_price === "399.00",
      balance_debited_once: state.balance === "151.00",
      balance_bill_once: state.bills === 1,
      concurrent_outcomes: outcomes,
      paid_membership_applied: concurrent.some((item) => item.outcome === "paid"),
      free_claim_settled: free.paid && free.pay_price === "0.00",
      duplicate_free_rejected: duplicateFreeRejected,
      free_extended_membership: free.overdue_time === Number(paidOutcome?.overdue_time) + 30 * 86_400,
      amount_mismatch_rejected: amountMismatchRejected,
      mismatched_callback_rolled_back: afterMismatch[0]?.paid === 0,
      external_callback_idempotent: settled.outcome === "paid" && replay.outcome === "already-paid",
      conflicting_trade_rejected: conflictingTradeRejected,
      permanent_membership_applied: state.is_money_level === 1 && state.is_ever_level === 1 && state.overdue_time === 0,
      insufficient_balance_rolled_back: insufficientRejected && state.insufficient_paid === 0 && state.insufficient_balance === "10.00" && state.insufficient_member === 0,
      status_evidence_count: state.statuses,
    };
    await withTx(scoped, async (tx) => {
      await tx.execute(sql`INSERT INTO audit_result (id, audit_key, result) VALUES (1, ${key}, ${JSON.stringify(result)}::jsonb)`);
    });
    return result;
  } finally {
    await scoped.db.$client.end();
  }
}

export async function verifyMembershipPurchaseAudit(connectionString: string, schemaValue: string, keyValue: string) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const scoped = container(connectionString, schema);
  const admin = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_member_pay_verify" });
  try {
    const [stored, counts, before, after, marker] = await Promise.all([
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT audit_key, result FROM audit_result WHERE id = 1
      `) as unknown as Array<{ audit_key: string; result: MembershipPurchaseAuditResult }>),
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM "user") AS users,
          (SELECT count(*)::int FROM member_ship) AS plans,
          (SELECT count(*)::int FROM other_order) AS orders,
          (SELECT count(*)::int FROM other_order_status) AS statuses,
          (SELECT count(*)::int FROM user_bill) AS bills
      `) as unknown as Array<{ users: number; plans: number; orders: number; statuses: number; bills: number }>),
      withTx(scoped, async (tx) => tx.execute(sql`
        SELECT snapshot FROM audit_public_snapshot WHERE position = 'before'
      `) as unknown as Array<{ snapshot: PublicSnapshot }>),
      publicSnapshot(admin),
      publicMarkerCount(admin, key),
    ]);
    const result = stored[0]?.result;
    const isolated = counts[0];
    assert(stored[0]?.audit_key === key && result, "stored audit result is missing or mismatched");
    assert(isolated?.users === 2 && isolated.plans === 3 && isolated.orders === 4, "isolated core counts are wrong");
    assert(isolated.statuses === 7 && isolated.bills === 1, "isolated payment evidence counts are wrong");
    for (const [name, value] of Object.entries(result)) {
      if (typeof value === "boolean") assert(value, `${name} is false`);
    }
    assert(JSON.stringify(result.concurrent_outcomes) === JSON.stringify(["already-paid", "paid"]), "concurrent outcomes are wrong");
    assert(result.status_evidence_count === 7, "status evidence count is wrong");
    assert(JSON.stringify(before[0]?.snapshot) === JSON.stringify(after), "public counts or sequences changed");
    assert(marker === 0, "audit marker leaked into public tables");
    return { result, isolated_counts: isolated, public_unchanged: true, public_marker_count: marker };
  } finally {
    await Promise.all([scoped.db.$client.end(), admin.$client.end()]);
  }
}

export async function cleanupMembershipPurchaseAudit(connectionString: string, schemaValue: string, keyValue: string) {
  const schema = schemaName(schemaValue);
  const key = auditKey(keyValue);
  const admin = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_member_pay_cleanup" });
  try {
    const before = await admin.$client.unsafe<Array<{ snapshot: PublicSnapshot }>>(
      `SELECT snapshot FROM "${schema}".audit_public_snapshot WHERE position = 'before'`,
    );
    const after = await publicSnapshot(admin);
    assert(JSON.stringify(before[0]?.snapshot) === JSON.stringify(after), "public state changed before cleanup");
    assert((await publicMarkerCount(admin, key)) === 0, "audit marker exists before cleanup");
    await admin.$client.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    const exists = await admin.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regnamespace($1) IS NOT NULL AS exists",
      [schema],
    );
    return { schema_removed: exists[0]?.exists === false, public_unchanged: true, public_marker_count: await publicMarkerCount(admin, key) };
  } finally {
    await admin.$client.end();
  }
}
