import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleMemory } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import type { DbClient } from "@/lib/di";

const ownedTargets = new Map<string, { schema: string; baseUrl: string }>();
const databaseName = /^finance_fixture_[a-f0-9]{32}$/;

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
      const [identity] = await connection`select current_database() as database, current_user as role, current_setting('server_version_num') as version`;
      if (identity.database !== expected || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16) {
        throw new Error("Unexpected finance test database identity/version");
      }
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
      await verify(coordinator, 'cinashop_finance_test');
      // Advisory keys, unlike table names, are database-scoped. A schema alone
      // does not isolate parallel positive scenarios from another fixture's locks.
      await coordinator.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      ownedTargets.set(database, { schema, baseUrl: base.href });
      const target = new URL(base.href); target.pathname = `/${database}`;
      client = postgres(target.href, { max: 4, prepare: false, connect_timeout: 5,
        connection: { options: `-c search_path=${schema}` } });
      await verify(client, database);
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
      const checkedClient = client;
      db = drizzlePostgres(checkedClient) as unknown as DbClient;
      exec = (query) => checkedClient.unsafe(query);
    } catch (error) { await close(); throw error; }
  } else {
    const memory = await PGlite.create();
    db = drizzleMemory(memory) as unknown as DbClient;
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
