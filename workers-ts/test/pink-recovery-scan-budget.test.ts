import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createContainerFromDb, type DbClient } from "../src/lib/di";
import { storeOrder, storeOrderRefund } from "../src/models/schema";
import { pinkCancellationRecoverySnapshot } from "../src/services/activity/PinkCancellationRecoveryService";
import { financePostgres } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Hook = (tx: Tx) => Promise<void>;
// Delegate the actual transaction, optionally injecting SQL at its boundaries.
function observed(db: DbClient, before?: Hook, after?: Hook): DbClient {
  const boundary: Pick<DbClient, "transaction"> = {
    transaction: (callback, config) => db.transaction(async tx => {
      await before?.(tx);
      const result = await callback(tx);
      await after?.(tx);
      return result;
    }, config),
  };
  return new Proxy(db, { get(target, key, receiver) {
    return key === "transaction" ? boundary.transaction : Reflect.get(target, key, receiver);
  } });
}
async function settings(db: Pick<DbClient, "select">) {
  const [row] = await db.select({
    statement: sql<string>`current_setting('statement_timeout')`,
    lock: sql<string>`current_setting('lock_timeout')`,
    idle: sql<string>`current_setting('idle_in_transaction_session_timeout')`,
    isolation: sql<string>`current_setting('transaction_isolation')`,
    readOnly: sql<string>`current_setting('transaction_read_only')`,
  }).from(sql`(values (1)) as probe(n)`);
  return row;
}

describe("B1 read-only cancellation recovery scan budgets", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  async function fixture() {
    f = await financePostgres([storeOrder, storeOrderRefund]);
    return f;
  }
  it.each([
    { statement: 0, lock: 0, idle: 0, expected: { statement: "3s", lock: "500ms", idle: "5s" } },
    { statement: 10000, lock: 8000, idle: 15000, expected: { statement: "3s", lock: "500ms", idle: "5s" } },
    { statement: 2000, lock: 250, idle: 4000, expected: { statement: "2s", lock: "250ms", idle: "4s" } },
  ])("bounds $statement/$lock/$idle, retains stricter limits, restores settings after commit", async input => {
    const { db } = await fixture(), original = await settings(db);
    let verified = false;
    const bounded = observed(db, async tx => {
      // SET only: do not establish a snapshot before SET TRANSACTION in the service.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout='${input.statement}ms'`));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout='${input.lock}ms'`));
      await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout='${input.idle}ms'`));
    }, async tx => {
      expect(await settings(tx)).toEqual({ ...input.expected, isolation: "repeatable read", readOnly: "on" });
      verified = true;
    });
    expect(await pinkCancellationRecoverySnapshot(createContainerFromDb(bounded), 0, 1060000, null))
      .toEqual({ candidates: [], highWater: 0 });
    expect(verified).toBe(true);
    expect(await settings(db)).toEqual(original);
  });

  it("rejects invalid bounds before beginning any transaction", async () => {
    const { db } = await fixture();
    let transactions = 0;
    const container = createContainerFromDb(observed(db, async () => { transactions++; }));
    const invalid: Array<[number, number, number | null]> = [[-1, 1, null], [0, 0, null], [0, 1, 2147483648], [0.5, 1, null]];
    for (const [cursor, time, ceiling] of invalid) {
      await expect(pinkCancellationRecoverySnapshot(container, cursor, time, ceiling)).rejects.toThrow("游标或时间无效");
    }
    expect(transactions).toBe(0);
  });

  it("propagates a SQL failure rather than returning an empty page and restores the connection", async () => {
    const { db } = await fixture(), original = await settings(db);
    const broken = observed(db, undefined, async tx => { await tx.execute(sql`SELECT 1/0`); });
    await expect(pinkCancellationRecoverySnapshot(createContainerFromDb(broken), 0, 1060000, null))
      .rejects.toMatchObject({ cause: { code: "22012" } });
    expect(await settings(db)).toEqual(original);
    expect(await pinkCancellationRecoverySnapshot(createContainerFromDb(db), 0, 1060000, null))
      .toEqual({ candidates: [], highWater: 0 });
  }, 15000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each([null, 100])(
    "PG16 cancels real lock wait with ceiling %s, restores the same backend and succeeds after unlock", async ceiling => {
      const { db } = await fixture();
      await withFinancePeers(db, async ([blocker, reader]) => {
        const original = await settings(reader.db);
        await blocker.exec("BEGIN; LOCK TABLE store_order_refund IN ACCESS EXCLUSIVE MODE");
        try {
          const blocked = outcome(pinkCancellationRecoverySnapshot(createContainerFromDb(reader.db), 0, 1060000, ceiling));
          await waitForFinanceBlock(db, reader.pid, blocker.pid);
          const result = await blocked;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toMatchObject({ cause: { code: "55P03" } });
          expect(await settings(reader.db)).toEqual(original);
        } finally { await blocker.exec("ROLLBACK"); }
        expect(await pinkCancellationRecoverySnapshot(createContainerFromDb(reader.db), 0, 1060000, ceiling))
          .toEqual({ candidates: [], highWater: ceiling ?? 0 });
      });
    }, 15000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))(
    "PG16 enforces the installed statement deadline and rolls back rather than completing the page", async () => {
      const { db } = await fixture();
      await withFinancePeers(db, async ([reader]) => {
        const original = await settings(reader.db);
        // Deliberately slow SQL inside the real scan transaction, not a latency claim for MAX/scan.
        const slow = observed(reader.db, undefined, async tx => { await tx.execute(sql`SELECT pg_catalog.pg_sleep(10)`); });
        await expect(pinkCancellationRecoverySnapshot(createContainerFromDb(slow), 0, 1060000, null))
          .rejects.toMatchObject({ cause: { code: "57014" } });
        expect(await settings(reader.db)).toEqual(original);
      });
    }, 15000);
});
