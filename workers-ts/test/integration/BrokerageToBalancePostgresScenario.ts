import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
  withTx,
} from "@/lib/di";
import { applyBrokerageToBalance } from "@/services/user/UserFinanceService";

const DDL = `
CREATE TABLE "user" (
  uid INTEGER PRIMARY KEY,
  nickname VARCHAR(64) DEFAULT '' NOT NULL,
  user_type VARCHAR(32) DEFAULT '' NOT NULL,
  now_money NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  brokerage_price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  status SMALLINT DEFAULT 1 NOT NULL,
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
CREATE TABLE user_money (
  id SERIAL PRIMARY KEY,
  uid INTEGER DEFAULT 0 NOT NULL,
  link_id VARCHAR(32) DEFAULT '0' NOT NULL,
  type VARCHAR(64) DEFAULT '' NOT NULL,
  title VARCHAR(64) DEFAULT '' NOT NULL,
  number NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  balance NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  pm SMALLINT DEFAULT 0 NOT NULL,
  mark VARCHAR(512) DEFAULT '' NOT NULL,
  status SMALLINT DEFAULT 1 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE user_extract (
  id SERIAL PRIMARY KEY,
  uid INTEGER DEFAULT 0 NOT NULL,
  extract_type VARCHAR(32) DEFAULT '' NOT NULL,
  bank_name VARCHAR(64) DEFAULT '' NOT NULL,
  bank_code VARCHAR(64) DEFAULT '' NOT NULL,
  bank_address VARCHAR(256) DEFAULT '' NOT NULL,
  real_name VARCHAR(64) DEFAULT '' NOT NULL,
  extract_number VARCHAR(64) DEFAULT '' NOT NULL,
  alipay_code VARCHAR(64) DEFAULT '' NOT NULL,
  extract_price NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  extract_fee NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  mark VARCHAR(512) DEFAULT '' NOT NULL,
  balance NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  status SMALLINT DEFAULT 0 NOT NULL,
  fail_msg VARCHAR(255) DEFAULT '' NOT NULL,
  fail_time INTEGER DEFAULT 0 NOT NULL,
  wechat VARCHAR(15) DEFAULT '' NOT NULL,
  qrcode_url VARCHAR(255) DEFAULT '' NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE user_brokerage (
  id SERIAL PRIMARY KEY,
  uid INTEGER DEFAULT 0 NOT NULL,
  link_id VARCHAR(32) DEFAULT '0' NOT NULL,
  pm SMALLINT DEFAULT 0 NOT NULL,
  title VARCHAR(64) DEFAULT '' NOT NULL,
  category VARCHAR(64) DEFAULT '' NOT NULL,
  type VARCHAR(64) DEFAULT '' NOT NULL,
  source_type VARCHAR(64) DEFAULT '' NOT NULL,
  number NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  balance NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  mark VARCHAR(512) DEFAULT '' NOT NULL,
  status SMALLINT DEFAULT 0 NOT NULL,
  take SMALLINT DEFAULT 0 NOT NULL,
  frozen_time INTEGER DEFAULT 0 NOT NULL,
  add_time INTEGER DEFAULT 0 NOT NULL
);
`;

interface PublicSnapshot {
  users: string;
  recharges: string;
  money: string;
  extracts: string;
  brokerage: string;
}

export interface BrokerageToBalancePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  frozen_guard: {
    transfer_succeeded: boolean;
    frozen_amount_preserved: boolean;
    second_transfer_rejected: boolean;
  };
  concurrent_guard: {
    succeeded: number;
    rejected: number;
    single_ledger_set: boolean;
  };
  rollback_guard: {
    injected_failure_rolled_back: boolean;
    retry_succeeded: boolean;
  };
  conservation: {
    users_conserved: boolean;
    recharge_rows: number;
    money_rows: number;
    extract_rows: number;
    conversion_brokerage_rows: number;
    ledger_links_consistent: boolean;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Brokerage-to-balance audit failed: ${message}`);
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const nonce = crypto.randomUUID();
  const rows = await db.$client.unsafe<Array<{ snapshot: PublicSnapshot }>>(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*)::text FROM public."user"),
      'recharges', (SELECT count(*)::text FROM public.user_recharge),
      'money', (SELECT count(*)::text FROM public.user_money),
      'extracts', (SELECT count(*)::text FROM public.user_extract),
      'brokerage', (SELECT count(*)::text FROM public.user_brokerage),
      'nonce', '${nonce}'
    ) - 'nonce' AS snapshot
  `);
  if (!rows[0]) throw new Error("could not capture public brokerage snapshot");
  return rows[0].snapshot;
}

export async function runBrokerageToBalancePostgresScenario(
  connectionString: string,
): Promise<BrokerageToBalancePostgresReport> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const schema = `codex_brokerage_balance_${suffix}`;
  const admin = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_brokerage_balance_admin",
  });
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let schemaCreated = false;
  let schemaRemoved = false;
  let report: Omit<BrokerageToBalancePostgresReport, "schema_removed" | "public_state_unchanged"> | null = null;
  try {
    before = await publicSnapshot(admin);
    await admin.$client.unsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const db = createDbFromConnectionString(connectionString, 4, {
      searchPath: schema,
      applicationName: "cinashop_brokerage_balance_audit",
    });
    const container = createContainerFromDb(db);
    try {
      await withTx(container, async (tx) => {
        await tx.execute(sql.raw(DDL));
        await tx.execute(sql`
          INSERT INTO "user" (uid, nickname, user_type, now_money, brokerage_price) VALUES
            (2100000201, 'Frozen User', 'h5', 10.00, 100.00),
            (2100000202, 'Concurrent User', 'routine', 5.00, 100.00),
            (2100000203, 'Rollback User', 'h5', 8.00, 50.00)
        `);
        await tx.execute(sql`
          INSERT INTO user_brokerage (
            uid, link_id, pm, title, category, type, number, balance, status, frozen_time, add_time
          ) VALUES
            (2100000201, 'income-active', 1, '冻结佣金', 'brokerage', 'one_brokerage', 30.00, 100.00, 1, 1786601000, 1786500000),
            (2100000201, 'income-expired', 1, '已解冻佣金', 'brokerage', 'one_brokerage', 20.00, 100.00, 1, 1786500000, 1786400000)
        `);
      });

      const frozenTransfer = await applyBrokerageToBalance(container, {
        uid: 2100000201,
        amountCents: 7_000,
        orderId: "wxfrozentransfer",
        now: 1_786_600_000,
      });
      let frozenRejected = false;
      try {
        await applyBrokerageToBalance(container, {
          uid: 2100000201,
          amountCents: 1,
          orderId: "wxfrozenrejected",
          now: 1_786_600_001,
        });
      } catch {
        frozenRejected = true;
      }

      const concurrent = await Promise.allSettled([
        applyBrokerageToBalance(container, {
          uid: 2100000202,
          amountCents: 6_000,
          orderId: "wxconcurrentone",
          now: 1_786_600_010,
        }),
        applyBrokerageToBalance(container, {
          uid: 2100000202,
          amountCents: 6_000,
          orderId: "wxconcurrenttwo",
          now: 1_786_600_011,
        }),
      ]);

      await withTx(container, async (tx) => {
        await tx.execute(sql.raw(`
          CREATE FUNCTION fail_transfer_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.uid = 2100000203 AND NEW.type = 'extract_money' THEN
              RAISE EXCEPTION 'forced transfer ledger failure';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER fail_transfer_ledger
            BEFORE INSERT ON user_brokerage
            FOR EACH ROW EXECUTE FUNCTION fail_transfer_ledger();
        `));
      });
      let injectedFailure = false;
      try {
        await applyBrokerageToBalance(container, {
          uid: 2100000203,
          amountCents: 2_500,
          orderId: "wxrollbackfailed",
          now: 1_786_600_020,
        });
      } catch {
        injectedFailure = true;
      }
      const failedStateRows = await withTx(container, (tx) => tx.execute(sql`
        SELECT
          now_money::text AS now_money,
          brokerage_price::text AS brokerage_price,
          (SELECT count(*)::int FROM user_recharge WHERE order_id = 'wxrollbackfailed') AS recharges,
          (SELECT count(*)::int FROM user_money WHERE uid = 2100000203) AS money,
          (SELECT count(*)::int FROM user_extract WHERE uid = 2100000203) AS extracts,
          (SELECT count(*)::int FROM user_brokerage WHERE uid = 2100000203) AS brokerage
        FROM "user" WHERE uid = 2100000203
      `)) as unknown as Array<{
        now_money: string;
        brokerage_price: string;
        recharges: number;
        money: number;
        extracts: number;
        brokerage: number;
      }>;
      const failedState = failedStateRows[0];
      const rollbackClean = Boolean(
        injectedFailure
        && failedState?.now_money === "8.00"
        && failedState.brokerage_price === "50.00"
        && failedState.recharges === 0
        && failedState.money === 0
        && failedState.extracts === 0
        && failedState.brokerage === 0
      );
      await withTx(container, async (tx) => {
        await tx.execute(sql`DROP TRIGGER fail_transfer_ledger ON user_brokerage`);
        await tx.execute(sql`DROP FUNCTION fail_transfer_ledger()`);
      });
      const retry = await applyBrokerageToBalance(container, {
        uid: 2100000203,
        amountCents: 2_500,
        orderId: "wxrollbackretry",
        now: 1_786_600_021,
      });

      const stateRows = await withTx(container, (tx) => tx.execute(sql`
        SELECT
          (SELECT now_money::text FROM "user" WHERE uid = 2100000201) AS frozen_now,
          (SELECT brokerage_price::text FROM "user" WHERE uid = 2100000201) AS frozen_brokerage,
          (SELECT now_money::text FROM "user" WHERE uid = 2100000202) AS concurrent_now,
          (SELECT brokerage_price::text FROM "user" WHERE uid = 2100000202) AS concurrent_brokerage,
          (SELECT now_money::text FROM "user" WHERE uid = 2100000203) AS rollback_now,
          (SELECT brokerage_price::text FROM "user" WHERE uid = 2100000203) AS rollback_brokerage,
          (SELECT count(*)::int FROM user_recharge) AS recharges,
          (SELECT count(*)::int FROM user_money) AS money,
          (SELECT count(*)::int FROM user_extract) AS extracts,
          (SELECT count(*)::int FROM user_brokerage WHERE type = 'extract_money') AS conversion_brokerage,
          (SELECT count(*)::int
             FROM user_recharge r
             JOIN user_money m ON m.link_id = r.id::text AND m.uid = r.uid
             JOIN user_extract e ON e.uid = r.uid AND e.extract_price = r.price AND e.add_time = r.add_time
             JOIN user_brokerage b ON b.link_id = r.id::text AND b.uid = r.uid AND b.type = 'extract_money'
            WHERE r.recharge_type = 'balance' AND r.paid = 1) AS linked_sets,
          (SELECT count(*)::int FROM user_brokerage
            WHERE uid = 2100000201 AND pm = 1 AND status = 1 AND frozen_time > 1786600000) AS frozen_rows
      `)) as unknown as Array<{
        frozen_now: string;
        frozen_brokerage: string;
        concurrent_now: string;
        concurrent_brokerage: string;
        rollback_now: string;
        rollback_brokerage: string;
        recharges: number;
        money: number;
        extracts: number;
        conversion_brokerage: number;
        linked_sets: number;
        frozen_rows: number;
      }>;
      const state = stateRows[0];
      assert(state, "isolated result row missing");
      const succeeded = concurrent.filter((item) => item.status === "fulfilled").length;
      const rejected = concurrent.filter((item) => item.status === "rejected").length;
      const conserved =
        Number(state.frozen_now) + Number(state.frozen_brokerage) === 110
        && Number(state.concurrent_now) + Number(state.concurrent_brokerage) === 105
        && Number(state.rollback_now) + Number(state.rollback_brokerage) === 58;
      assert(frozenTransfer.nowMoney === "80.00" && frozenTransfer.brokeragePrice === "30.00", "frozen transfer result mismatch");
      assert(frozenRejected && state.frozen_rows === 1, "frozen commission guard failed");
      assert(succeeded === 1 && rejected === 1, "concurrent transfer was not single-winner");
      assert(state.concurrent_now === "65.00" && state.concurrent_brokerage === "40.00", "concurrent balances mismatch");
      assert(rollbackClean && retry.nowMoney === "33.00" && retry.brokeragePrice === "25.00", "rollback/retry mismatch");
      assert(conserved, "money was not conserved across account buckets");
      assert(state.recharges === 3 && state.money === 3 && state.extracts === 3, "PHP ledger row counts mismatch");
      assert(state.conversion_brokerage === 3 && state.linked_sets === 3, "ledger links mismatch");

      report = {
        server_version: (await db.$client<{ version: string }[]>`
          SELECT current_setting('server_version') AS version
        `)[0]?.version ?? "unknown",
        schema_created: schemaCreated,
        frozen_guard: {
          transfer_succeeded: frozenTransfer.nowMoney === "80.00" && frozenTransfer.brokeragePrice === "30.00",
          frozen_amount_preserved: state.frozen_rows === 1 && state.frozen_brokerage === "30.00",
          second_transfer_rejected: frozenRejected,
        },
        concurrent_guard: {
          succeeded,
          rejected,
          single_ledger_set: state.concurrent_now === "65.00" && state.concurrent_brokerage === "40.00",
        },
        rollback_guard: {
          injected_failure_rolled_back: rollbackClean,
          retry_succeeded: retry.nowMoney === "33.00" && retry.brokeragePrice === "25.00",
        },
        conservation: {
          users_conserved: conserved,
          recharge_rows: state.recharges,
          money_rows: state.money,
          extract_rows: state.extracts,
          conversion_brokerage_rows: state.conversion_brokerage,
          ledger_links_consistent: state.linked_sets === 3,
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
  if (!report || !before || !after) throw new Error("brokerage-to-balance audit did not produce a report");
  return {
    ...report,
    schema_removed: schemaRemoved,
    public_state_unchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}
