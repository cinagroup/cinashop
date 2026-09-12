import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { drizzle as drizzleMemory } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DbClient } from "../../src/lib/di";

export interface SequenceRunnerPeer {
  db: DbClient;
  pid: number;
  exec: (statement: string) => Promise<postgres.Row[]>;
}

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
      withRuntimeRole: undefined,
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
      current_setting('server_version_num') AS version, pg_backend_pid() AS pid`;
    if (row.database !== database || row.role !== "finance_test" || Math.floor(Number(row.version) / 10_000) !== 16)
      throw new Error("Unexpected sequence runner test database identity/version");
    return Number(row.pid);
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
      withRuntimeRole: async <T>(callback: (peer: SequenceRunnerPeer & { role: string; connectionString: string }) => Promise<T>) => {
        // Real LOGIN rather than SET ROLE on a superuser session: RESET ROLE
        // must not recover maintenance authority. No production fallback.
        await verify(checkedClient, name);
        const role = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw new Error('Invalid isolated runtime role');
        const password = randomUUID().replaceAll('-', '');
        let roleCreated = false;
        let runtime: ReturnType<typeof postgres> | undefined;
        try {
          await checkedClient.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
          roleCreated = true;
          await checkedClient.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
          const runtimeUrl = new URL(target.href); runtimeUrl.username = role; runtimeUrl.password = password;
          runtime = postgres(runtimeUrl.href, { ...options, idle_timeout: 0, max_lifetime: 0 });
          const checkedRuntime = runtime;
          const identity = async () => {
            const [row] = await checkedRuntime`SELECT current_database() AS database,current_user AS role,session_user AS session,
              current_setting('server_version_num') AS version,pg_backend_pid() AS pid`;
            if (row.database !== name || row.role !== role || row.session !== role
              || Math.floor(Number(row.version) / 10_000) !== 16) throw new Error('Unexpected runtime-role test identity');
            return Number(row.pid);
          };
          const pid = await identity();
          const result = await callback({ role, connectionString: runtimeUrl.href, db: drizzlePostgres(runtime), pid,
            exec: async statement => Array.from(await checkedRuntime.unsafe(statement)) });
          if (await identity() !== pid) throw new Error('Runtime-role peer unexpectedly reconnected');
          return result;
        } finally {
          await runtime?.end({ timeout: 5 });
          if (roleCreated) {
            await verify(checkedClient, name);
            // This role was created here and only received grants in this owned
            // database. Remove those grants/owned test objects, then the role.
            await checkedClient.unsafe(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
            const rows = await checkedClient`SELECT oid FROM pg_roles WHERE rolname=${role}`;
            if (rows.length) throw new Error('Isolated runtime role cleanup not confirmed');
          }
        }
      },
      withPeer: async <T>(callback: (peer: SequenceRunnerPeer) => Promise<T>, onnotice?: (notice: postgres.Notice) => void) => {
        // Keep the backend stable while an observer checks pg_blocking_pids.
        const peer = postgres(target.href, { ...options, idle_timeout: 0, max_lifetime: 0,
          ...(onnotice ? { onnotice } : {}) });
        try {
          const pid = await verify(peer, name);
          const result = await callback({ db: drizzlePostgres(peer), pid,
            exec: async statement => Array.from(await peer.unsafe(statement)) });
          if (await verify(peer, name) !== pid) throw new Error("Sequence runner peer unexpectedly reconnected");
          return result;
        } finally { await peer.end({ timeout: 5 }); }
      },
    };
  } catch (error) { await close(); throw error; }
}
