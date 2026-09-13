import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import type { DbClient } from "../../src/lib/di";
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './financePostgres';

export function validateFinancePeerUrl(value: string): string {
  return validateFinanceFixtureUrl(value).href;
}

export interface FinancePeer { db: DbClient; pid: number; exec: (query: string) => Promise<unknown> }

/** Reuse ONLY the registered random database/schema owned by a finance fixture.
 * Each peer has one non-expiring connection. A reserved Sql cannot be used here:
 * postgres-js begin() belongs to the root pool, so reserving its only slot would stall Drizzle.
 */
export async function withFinancePeers<T>(observer: DbClient,
  run: (peers: [FinancePeer, FinancePeer, FinancePeer]) => Promise<T>): Promise<T> {
  const url = validateFinancePeerUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? "");
  const [origin] = await observer.select({ schema: sql<string>`current_schema()`, database: sql<string>`current_database()`,
    role: sql<string>`current_user`, version: sql<string>`current_setting('server_version_num')`, pid: sql<number>`pg_backend_pid()` })
    .from(sql`(values (1)) as probe(n)`);
  if (!/^finance_test_[a-f0-9]{32}$/.test(origin.schema) || !ownsFinanceFixtureTarget(origin.database, origin.schema, url) ||
    origin.role !== "finance_test" || Math.floor(Number(origin.version) / 10_000) !== 16) {
    throw new Error("Unexpected finance observer identity/schema/version");
  }
  const peerUrl = new URL(url); peerUrl.pathname = `/${origin.database}`;
  const clients: ReturnType<typeof postgres>[] = [];
  try {
    const connect = async (): Promise<FinancePeer> => {
      const client = postgres(peerUrl.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: `-c search_path=${origin.schema} -c statement_timeout=10000 -c lock_timeout=8000 -c idle_in_transaction_session_timeout=15000` } });
      clients.push(client);
      const [identity] = await client`select current_schema() as schema, current_database() as database,
        current_user as role, current_setting('server_version_num') as version, pg_backend_pid() as pid`;
      if (identity.schema !== origin.schema || identity.database !== origin.database || identity.role !== origin.role ||
        identity.version !== origin.version) throw new Error("Unexpected finance peer identity/schema/version");
      return { db: drizzle(client) as unknown as DbClient, pid: Number(identity.pid), exec: query => client.unsafe(query) };
    };
    const peers: [FinancePeer, FinancePeer, FinancePeer] = [await connect(), await connect(), await connect()];
    if (new Set([origin.pid, ...peers.map(peer => peer.pid)]).size !== 4) throw new Error("Finance peers are not independent backends");
    const result = await run(peers);
    for (const peer of peers) {
      const [identity] = await peer.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) as probe(n)`);
      if (identity.pid !== peer.pid) throw new Error("Finance peer unexpectedly reconnected");
    }
    return result;
  } finally {
    // Force-close after a bounded drain also rolls back a failed test's held locks.
    await Promise.all(clients.map(client => client.end({ timeout: 1 })));
  }
}

export function outcome<T>(work: Promise<T>) {
  return work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

/** A polling pause is not the proof: only PG's exact blocker PID satisfies the barrier. */
export async function waitForFinanceBlock(observer: DbClient, waiter: number, blocker: number): Promise<void> {
  if (!Number.isSafeInteger(waiter) || !Number.isSafeInteger(blocker) || waiter <= 0 || blocker <= 0 || waiter === blocker) {
    throw new Error("Invalid finance backend pair");
  }
  const deadline = performance.now() + 4_000;
  do {
    const [row] = await observer.select({ blockers: sql<number[]>`pg_blocking_pids(${waiter}::int)` }).from(sql`(values (1)) as probe(n)`);
    if (row.blockers.includes(blocker)) return;
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error("Expected PostgreSQL blocker was not observed");
}

export async function waitForFinanceClock(observer: DbClient, deadlineMs: number): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("Invalid finance deadline");
  const timeout = performance.now() + 4_000;
  do {
    const [row] = await observer.select({ expired: sql<boolean>`extract(epoch from clock_timestamp()) * 1000 > ${deadlineMs}` })
      .from(sql`(values (1)) as probe(n)`);
    if (row.expired) return;
    await delay(25);
  } while (performance.now() < timeout);
  throw new Error("PostgreSQL did not reach the test deadline");
}
