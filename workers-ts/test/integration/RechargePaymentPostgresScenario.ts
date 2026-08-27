import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
  withTx,
} from "@/lib/di";
import { applyRechargePayment } from "@/services/payment/RechargePaymentService";

const DDL = `
CREATE TABLE "user" (
  uid INTEGER PRIMARY KEY,
  now_money NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  is_del SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE user_recharge (
  id SERIAL PRIMARY KEY,
  store_id INTEGER DEFAULT 0 NOT NULL,
  uid INTEGER DEFAULT 0 NOT NULL,
  staff_id INTEGER DEFAULT 0 NOT NULL,
  order_id VARCHAR(32) DEFAULT '' NOT NULL,
  trade_no VARCHAR(100) DEFAULT '' NOT NULL,
  price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  give_price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  recharge_type VARCHAR(32) DEFAULT '' NOT NULL,
  auth_code VARCHAR(50) DEFAULT '' NOT NULL,
  paid SMALLINT DEFAULT 0 NOT NULL,
  pay_time INTEGER DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL,
  refund_price NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  channel_type VARCHAR(255) DEFAULT '' NOT NULL,
  remarks VARCHAR(255) DEFAULT '' NOT NULL
);
CREATE INDEX ur_order_id_lookup ON user_recharge (order_id);
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
`;

interface PublicSnapshot {
  users: string;
  recharges: string;
  bills: string;
}

export interface RechargePaymentPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  concurrent_callback: {
    paid: number;
    already_paid: number;
    balance: string;
    bill_rows: number;
    trade_no_recorded: boolean;
    replay_idempotent: boolean;
  };
  rejected_callbacks: {
    wrong_amount_rolled_back: boolean;
    conflicting_trade_rejected: boolean;
    duplicate_order_rejected: boolean;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Recharge-payment audit failed: ${message}`);
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows = await db.$client.unsafe<Array<{ snapshot: PublicSnapshot }>>(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*)::text FROM public."user"),
      'recharges', (SELECT count(*)::text FROM public.user_recharge),
      'bills', (SELECT count(*)::text FROM public.user_bill)
    ) AS snapshot
  `);
  if (!rows[0]) throw new Error("could not capture public payment snapshot");
  return rows[0].snapshot;
}

export async function runRechargePaymentPostgresScenario(
  connectionString: string,
): Promise<RechargePaymentPostgresReport> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const schema = `codex_recharge_pay_${suffix}`;
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_recharge_pay_admin",
  });
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let schemaCreated = false;
  let schemaRemoved = false;
  let report: Omit<RechargePaymentPostgresReport, "schema_removed" | "public_state_unchanged"> | null = null;
  try {
    before = await publicSnapshot(admin);
    await admin.$client.unsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const db = createDbFromConnectionString(connectionString, 4, {
      searchPath: schema,
      applicationName: "cinashop_recharge_pay_audit",
    });
    const container = createContainerFromDb(db);
    try {
      // Hyperdrive may not preserve a custom startup search_path. Keep every
      // schema-dependent query in withTx(), which applies SET LOCAL explicitly.
      await withTx(container, async (tx) => {
        await tx.execute(sql.raw(DDL));
        await tx.execute(sql`
          INSERT INTO "user" (uid, now_money) VALUES (2100000101, 10.00), (2100000102, 20.00)
        `);
        await tx.execute(sql`
          INSERT INTO user_recharge (
            uid, order_id, price, give_price, recharge_type, paid, add_time
          ) VALUES
            (2100000101, 'czauditconcurrent', 100.00, 25.00, 'weixinh5', 0, 1786500000),
            (2100000102, 'czauditwrongamount', 50.00, 0.00, 'weixinh5', 0, 1786500000),
            (2100000102, 'czauditduplicate', 30.00, 0.00, 'weixinh5', 0, 1786500000),
            (2100000102, 'czauditduplicate', 30.00, 0.00, 'weixinh5', 0, 1786500000)
        `);
      });

      const settled = await Promise.all([
        applyRechargePayment(container, {
          orderId: "czauditconcurrent",
          payType: "weixin",
          tradeNo: "wx-audit-trade-1",
          expectedAmountCents: 10_000,
          now: 1_786_500_100,
        }),
        applyRechargePayment(container, {
          orderId: "czauditconcurrent",
          payType: "weixin",
          tradeNo: "wx-audit-trade-1",
          expectedAmountCents: 10_000,
          now: 1_786_500_101,
        }),
      ]);
      const replay = await applyRechargePayment(container, {
        orderId: "czauditconcurrent",
        payType: "weixin",
        tradeNo: "wx-audit-trade-1",
        expectedAmountCents: 10_000,
        now: 1_786_500_102,
      });

      let wrongAmountRejected = false;
      try {
        await applyRechargePayment(container, {
          orderId: "czauditwrongamount",
          payType: "weixin",
          tradeNo: "wx-audit-wrong",
          expectedAmountCents: 4_999,
          now: 1_786_500_103,
        });
      } catch {
        wrongAmountRejected = true;
      }
      let conflictingTradeRejected = false;
      try {
        await applyRechargePayment(container, {
          orderId: "czauditconcurrent",
          payType: "weixin",
          tradeNo: "wx-audit-conflict",
          expectedAmountCents: 10_000,
          now: 1_786_500_104,
        });
      } catch {
        conflictingTradeRejected = true;
      }
      let duplicateOrderRejected = false;
      try {
        await applyRechargePayment(container, {
          orderId: "czauditduplicate",
          payType: "weixin",
          tradeNo: "wx-audit-duplicate",
          expectedAmountCents: 3_000,
          now: 1_786_500_105,
        });
      } catch {
        duplicateOrderRejected = true;
      }

      const state = await withTx(container, (tx) => tx.execute(sql`
        SELECT
          (SELECT now_money::text FROM "user" WHERE uid = 2100000101) AS balance,
          (SELECT paid FROM user_recharge WHERE order_id = 'czauditconcurrent') AS paid,
          (SELECT trade_no FROM user_recharge WHERE order_id = 'czauditconcurrent') AS trade_no,
          (SELECT count(*)::int FROM user_bill WHERE link_id = 'czauditconcurrent') AS bills,
          (SELECT paid FROM user_recharge WHERE order_id = 'czauditwrongamount') AS wrong_paid,
          (SELECT now_money::text FROM "user" WHERE uid = 2100000102) AS wrong_balance
      `)) as unknown as Array<{
        balance: string;
        paid: number;
        trade_no: string;
        bills: number;
        wrong_paid: number;
        wrong_balance: string;
      }>;
      const row = state[0];
      assert(row, "isolated result row missing");
      assert(row.balance === "135.00", "recharge amount and gift were not credited exactly once");
      assert(row.paid === 1 && row.trade_no === "wx-audit-trade-1", "provider evidence missing");
      assert(row.bills === 1, "recharge ledger was not idempotent");
      assert(row.wrong_paid === 0 && row.wrong_balance === "20.00", "rejected callback changed funds");
      assert(wrongAmountRejected && conflictingTradeRejected && duplicateOrderRejected, "invalid callback accepted");

      report = {
        server_version: (await db.$client<{ version: string }[]>`
          SELECT current_setting('server_version') AS version
        `)[0]?.version ?? "unknown",
        schema_created: schemaCreated,
        concurrent_callback: {
          paid: settled.filter((item) => item.outcome === "paid").length,
          already_paid: settled.filter((item) => item.outcome === "already-paid").length,
          balance: row.balance,
          bill_rows: row.bills,
          trade_no_recorded: row.trade_no === "wx-audit-trade-1",
          replay_idempotent: replay.outcome === "already-paid" && row.bills === 1,
        },
        rejected_callbacks: {
          wrong_amount_rolled_back: wrongAmountRejected && row.wrong_paid === 0 && row.wrong_balance === "20.00",
          conflicting_trade_rejected: conflictingTradeRejected,
          duplicate_order_rejected: duplicateOrderRejected,
        },
      };
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  } finally {
    try {
      if (schemaCreated) {
        await admin.$client.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
        schemaRemoved = true;
      }
      after = await publicSnapshot(admin);
    } finally {
      await admin.$client.end({ timeout: 5 });
    }
  }
  if (!report || !before || !after) throw new Error("recharge-payment audit did not produce a report");
  return {
    ...report,
    schema_removed: schemaRemoved,
    public_state_unchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}
