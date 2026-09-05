import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleMemory } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import type { DbClient } from "@/lib/di";

/** Local memory by default. CI can opt into its dedicated disposable PostgreSQL 16 service only. */
export async function financePostgres(tables: PgTable[]) {
  const url = process.env.TEST_FINANCE_POSTGRES_URL;
  let db: DbClient;
  let exec: (query: string) => Promise<unknown>;
  let close: () => Promise<void>;
  if (url) {
    const target = new URL(url);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/cinashop_finance_test" || target.username !== "finance_test") {
      throw new Error("Finance tests require a dedicated loopback cinashop_finance_test database; production URLs are forbidden");
    }
    const schema = `finance_test_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!/^finance_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid test schema");
    const client = postgres(url, { max: 4, prepare: false, connection: { options: `-c search_path=${schema}` } });
    try {
      const [identity] = await client`select current_database() as database, current_user as role, current_setting('server_version_num') as version`;
      if (identity.database !== "cinashop_finance_test" || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16) {
        throw new Error("Unexpected finance test database identity/version");
      }
      await client.unsafe(`create schema "${schema}"`);
    } catch (error) { await client.end(); throw error; }
    db = drizzlePostgres(client) as unknown as DbClient;
    exec = (query) => client.unsafe(query);
    close = async () => {
      try { await client.unsafe(`drop schema "${schema}" cascade`); } finally { await client.end(); }
    };
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
