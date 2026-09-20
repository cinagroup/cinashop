import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleMemory } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import type { DbClient } from "@/lib/di";

const ownedTargets = new Map<string, { schema: string; baseUrl: string; serverHost: string; serverPort: number }>();
const databaseName = /^finance_fixture_[a-f0-9]{32}$/;

/** Match the raw execute row-array contract used by postgres.js, not its wire
 * protocol or concurrency. All SQL, parameters, errors, transaction options and
 * savepoints still execute in PGlite. Native PG16 remains required for locks,
 * independent sessions, privileges and non-transactional sequence behavior. */
function memoryRowArrays<T extends object>(database: T): T {
  return new Proxy(database, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property === 'execute') return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(method, target, args);
        if (!result || typeof result !== 'object' || !('rows' in result) || !Array.isArray(result.rows)) {
          throw Error('Unexpected PGlite raw query result');
        }
        const count = 'rowCount' in result ? result.rowCount : result.rows.length;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
          throw Error('Unexpected PGlite raw row count');
        }
        // Row metadata is derived from the real SQL result; no fabricated rows
        // or catch-and-return-empty behavior. Do not wrap mapped query builders.
        return Object.assign(result.rows, { count });
      };
      if (property === 'transaction') return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing fixture transaction callback');
        return Reflect.apply(method, target, [(tx: object) => callback(memoryRowArrays(tx)), ...options]);
      };
      return method.bind(target);
    },
  });
}

export function validateFinanceFixtureUrl(value: string): URL {
  let target: URL;
  try { target = new URL(value); } catch { throw new Error('Invalid finance fixture test URL'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname)
    || target.pathname !== '/cinashop_finance_test' || target.username !== 'finance_test' || target.search || target.hash) {
    throw new Error('Finance tests require a dedicated loopback cinashop_finance_test database; production URLs are forbidden');
  }
  return target;
}

/** A matching-looking name is insufficient: peers must target this process's
 * successfully created fixture and the unchanged, validated coordinator URL. */
export function ownsFinanceFixtureTarget(database: string, schema: string, baseUrl: string): boolean {
  const owned = ownedTargets.get(database);
  return databaseName.test(database) && owned?.schema === schema && owned.baseUrl === baseUrl;
}
/** Server-side endpoints may be Docker addresses even when the validated client
 * endpoint is loopback. Compare to this process's coordinator, not a CIDR guess. */
export function ownsFinanceFixtureEndpoint(database: string, schema: string, baseUrl: string, host: unknown, port: unknown): boolean {
  const owned = ownedTargets.get(database);
  if (!owned) return false;
  return ownsFinanceFixtureTarget(database, schema, baseUrl) && typeof host === 'string'
    && host === owned.serverHost && typeof port === 'number' && port === owned.serverPort;
}

/** Local memory by default. CI can opt into its dedicated disposable PostgreSQL 16 service only. */
export async function financePostgres(tables: PgTable[]) {
  const url = process.env.TEST_FINANCE_POSTGRES_URL;
  let db: DbClient;
  let exec: (query: string) => Promise<unknown>;
  let close: () => Promise<void>;
  if (url) {
    const base = validateFinanceFixtureUrl(url);
    const database = `finance_fixture_${crypto.randomUUID().replaceAll('-', '')}`;
    const schema = `finance_test_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!databaseName.test(database) || !/^finance_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid test database/schema");
    const coordinator = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5,
      connection: { options: '-c statement_timeout=30000 -c lock_timeout=3000' } });
    let client: ReturnType<typeof postgres> | undefined;
    let created = false;
    let closing: Promise<void> | undefined;
    const verify = async (connection: ReturnType<typeof postgres>, expected: string) => {
      const [identity] = await connection`select current_database() as database, current_user as role, current_setting('server_version_num') as version,
        host(inet_server_addr()) AS server_host,inet_server_port() AS server_port`;
      if (identity.database !== expected || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16) {
        throw new Error("Unexpected finance test database identity/version");
      }
      if (typeof identity.server_host !== 'string' || !identity.server_host || !Number.isSafeInteger(identity.server_port))
        throw Error('Missing finance fixture server identity');
      return identity;
    };
    close = () => closing ??= (async () => {
      try {
        await client?.end({ timeout: 5 });
        if (created) {
          if (!ownsFinanceFixtureTarget(database, schema, base.href)) throw new Error('Unsafe finance fixture cleanup target');
          await verify(coordinator, 'cinashop_finance_test');
          // Never FORCE/disconnect other clients or touch a broad schema/database.
          await coordinator.unsafe(`DROP DATABASE "${database}"`);
          if ((await coordinator`SELECT datname FROM pg_database WHERE datname=${database}`).length) {
            throw new Error('Finance fixture database cleanup not confirmed');
          }
          created = false;
          ownedTargets.delete(database);
        }
      } finally { await coordinator.end({ timeout: 5 }); }
    })();
    try {
      const server = await verify(coordinator, 'cinashop_finance_test');
      // Advisory keys, unlike table names, are database-scoped. A schema alone
      // does not isolate parallel positive scenarios from another fixture's locks.
      await coordinator.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      ownedTargets.set(database, { schema, baseUrl: base.href, serverHost: server.server_host, serverPort: server.server_port });
      const target = new URL(base.href); target.pathname = `/${database}`;
      client = postgres(target.href, { max: 4, prepare: false, connect_timeout: 5,
        connection: { options: `-c search_path=${schema}` } });
      const peer = await verify(client, database);
      if (!ownsFinanceFixtureEndpoint(database, schema, base.href, peer.server_host, peer.server_port))
        throw Error('Finance fixture server changed from coordinator');
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
      const checkedClient = client;
      db = drizzlePostgres(checkedClient) as unknown as DbClient;
      exec = (query) => checkedClient.unsafe(query);
    } catch (error) { await close(); throw error; }
  } else {
    const memory = await PGlite.create();
    // Test-only driver boundary. The application intentionally uses postgres.js;
    // raw results must be adapted before passing the memory driver as DbClient.
    db = memoryRowArrays(drizzleMemory(memory)) as unknown as DbClient;
    exec = (query) => memory.exec(query);
    close = () => memory.close();
  }
  const dialect = new PgDialect();
  try {
    for (const table of tables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map((column) => {
        const initial = column.default;
        const initialSql = initial === undefined ? "" : ` default ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? " not null" : ""}${column.primary ? " primary key" : ""}`;
      });
      await exec(`create table "${definition.name}" (${columns.join(", ")})`);
    }
  } catch (error) { await close(); throw error; }
  return {
    db, exec, close,
    reset: () => exec(`truncate ${tables.map((table) => `"${getTableConfig(table).name}"`).join(", ")} restart identity`),
  };
}
