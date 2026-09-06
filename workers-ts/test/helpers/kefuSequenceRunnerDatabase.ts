import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { drizzle as drizzleMemory } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DbClient } from "../../src/lib/di";

const prefix = /^cinashop_kefu_runner_[a-f0-9]{32}$/;

export function validateSequenceRunnerTestUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid isolated sequence runner test URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.pathname !== "/cinashop_finance_test" || url.username !== "finance_test"
    || url.search || url.hash) {
    throw new Error("Sequence runner tests require the dedicated loopback finance_test PostgreSQL 16 service");
  }
  return url;
}

// No production fallback: one random database, never public in the shared CI DB.
export async function sequenceRunnerDatabase() {
  const url = process.env.TEST_FINANCE_POSTGRES_URL;
  if (!url) {
    const memory = await PGlite.create();
    return {
      format: "pglite" as const,
      db: drizzleMemory(memory) as unknown as DbClient,
      query: (statement: string) => memory.query(statement),
      exec: (statement: string) => memory.exec(statement),
      close: () => memory.close(),
      withPeer: undefined,
    };
  }
  const base = validateSequenceRunnerTestUrl(url);
  const name = `cinashop_kefu_runner_${randomUUID().replaceAll("-", "")}`;
  if (!prefix.test(name)) throw new Error("Invalid isolated sequence runner database name");
  const options = {
    max: 1, prepare: false, connect_timeout: 5, idle_timeout: 10,
    connection: { options: "-c statement_timeout=30000 -c lock_timeout=3000 -c search_path=public,pg_temp" },
  };
  const coordinator = postgres(base.href, options);
  let client: ReturnType<typeof postgres> | undefined;
  let created = false;
  async function verify(connection: ReturnType<typeof postgres>, database: string) {
    const [row] = await connection`SELECT current_database() AS database, current_user AS role,
      current_setting('server_version_num') AS version`;
    if (row.database !== database || row.role !== "finance_test" || Math.floor(Number(row.version) / 10_000) !== 16)
      throw new Error("Unexpected sequence runner test database identity/version");
  }
  async function close() {
    try {
      await client?.end({ timeout: 5 });
      if (created) {
        if (!prefix.test(name)) throw new Error("Unsafe sequence runner test cleanup target");
        await coordinator.unsafe(`DROP DATABASE "${name}"`);
        const rows = await coordinator`SELECT datname FROM pg_database WHERE datname = ${name}`;
        if (rows.length) throw new Error("Sequence runner test database cleanup not confirmed");
        created = false;
      }
    } finally { await coordinator.end({ timeout: 5 }); }
  }
  try {
    await verify(coordinator, "cinashop_finance_test");
    await coordinator.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const target = new URL(base.href); target.pathname = `/${name}`;
    client = postgres(target.href, options);
    await verify(client, name);
    const checkedClient = client;
    return {
      format: "pg16" as const,
      db: drizzlePostgres(client) as unknown as DbClient,
      query: async (statement: string) => ({ rows: Array.from(await checkedClient.unsafe(statement)) }),
      exec: async (statement: string) => Array.from(await checkedClient.unsafe(statement)),
      close,
      withPeer: async <T>(callback: (peer: { exec: (statement: string) => Promise<postgres.Row[]> }) => Promise<T>) => {
        const peer = postgres(target.href, options);
        try {
          await verify(peer, name);
          return await callback({ exec: async statement => Array.from(await peer.unsafe(statement)) });
        } finally { await peer.end({ timeout: 5 }); }
      },
    };
  } catch (error) { await close(); throw error; }
}
