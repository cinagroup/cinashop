/** DB-009E2A generator prerequisite, dedicated loopback PG16 test service only. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { validateTestTarget } from "./orm-ddl-audit";

async function main() {
  const target = validateTestTarget(process.env.TEST_FINANCE_POSTGRES_URL);
  const options = { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 10,
    connection: { statement_timeout: 30_000, lock_timeout: 2_000 } };
  const control = postgres(target.href, options);
  const created: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  try {
    const [identity] = await control`SELECT current_database() AS database, current_user AS role, current_setting('server_version_num') AS version`;
    if (identity.database !== "cinashop_finance_test" || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16)
      throw new Error("Unexpected NOT VALID test database identity/version; no databases created");
    const require = createRequire(import.meta.url);
    const audit = require("../test/helpers/notValidAudit.cjs");
    for (const format of ["cjs", "esm"] as const) {
      const name = `nv_audit_${format}_${randomUUID().replaceAll("-", "")}`;
      if (!/^nv_audit_(cjs|esm)_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid isolated database name");
      await control.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created.push(name);
      const isolated = new URL(target.href);
      isolated.pathname = `/${name}`;
      const client = postgres(isolated.href, options);
      try {
        const [actual] = await client`SELECT current_database() AS database, current_user AS role`;
        if (actual.database !== name || actual.role !== "finance_test") throw new Error("Unexpected isolated database identity");
        const api = format === "cjs" ? require("drizzle-kit/api")
          : await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")), "api.mjs")).href);
        const result = await audit({ api, format: `pg16-${format}`, db: {
          exec: (query: string) => client.unsafe(query),
          query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
        } });
        records.push({ format, serverVersionNum: Number(identity.version), ...result });
      } finally { await client.end(); }
    }
  } finally {
    try {
      for (const name of created) {
        if (!/^nv_audit_(cjs|esm)_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid cleanup target");
        await control.unsafe(`DROP DATABASE "${name}"`);
        if ((await control`SELECT datname FROM pg_database WHERE datname=${name}`).length) throw new Error("Isolated database cleanup failed");
      }
    } finally { await control.end(); }
  }
  console.log(`NOT_VALID_GENERATOR_AUDIT ${JSON.stringify({ scope: "Generator prerequisites on self-created fixtures only; no business constraints migrated and no production access", records, databasesCreated: created.length, cleanupConfirmed: true })}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
