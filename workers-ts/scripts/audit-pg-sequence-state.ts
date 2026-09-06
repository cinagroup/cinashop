/** DB-009E5A: sequence generator fixtures on the dedicated loopback PG16 service only. */
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
  const control = postgres(target.href, options), created: string[] = [], records: Array<Record<string, unknown>> = [];
  const safe = (name: string) => /^seq_audit_(cjs|esm)_[a-f0-9]{32}$/.test(name) && name.length <= 63;
  try {
    const [identity] = await control`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num') AS version`;
    if (identity.database !== "cinashop_finance_test" || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16)
      throw new Error("Unexpected sequence test database identity/version; no databases created");
    const require = createRequire(import.meta.url), audit = require("../test/helpers/sequenceStateGeneratorAudit.cjs");
    for (const format of ["cjs", "esm"] as const) {
      const name = `seq_audit_${format}_${randomUUID().replaceAll("-", "")}`;
      if (!safe(name)) throw new Error("Invalid isolated sequence database name");
      await control.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`); created.push(name);
      const isolated = new URL(target.href); isolated.pathname = `/${name}`;
      const client = postgres(isolated.href, options);
      try {
        const [actual] = await client`SELECT current_database() AS database,current_user AS role`;
        if (actual.database !== name || actual.role !== "finance_test") throw new Error("Isolated sequence database identity mismatch");
        const api = format === "cjs" ? require("drizzle-kit/api")
          : await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")), "api.mjs")).href);
        const result = await audit({ api, format: `pg16-${format}`, db: {
          exec: (query: string) => client.unsafe(query),
          query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
        } });
        records.push({ format, serverVersionNum: Number(identity.version), ...result });
      } finally { await client.end({ timeout: 5 }); }
    }
  } finally {
    const errors: Error[] = [];
    try {
      for (const name of created) {
        try {
          if (!safe(name)) throw new Error("Invalid sequence cleanup target");
          await control.unsafe(`DROP DATABASE "${name}"`);
          if ((await control`SELECT datname FROM pg_database WHERE datname=${name}`).length) throw new Error("Sequence database cleanup was not confirmed");
        } catch (error) { errors.push(new Error(`Sequence fixture cleanup failed: ${name}`, { cause: error })); }
      }
    } finally { await control.end({ timeout: 5 }); }
    if (errors.length) throw new AggregateError(errors, "Sequence fixture cleanup incomplete");
  }
  console.log(`SEQUENCE_GENERATOR_AUDIT ${JSON.stringify({ scope: "Generator prerequisites on self-created sequence fixtures; business sequence upgrade remains separate; no production access", records, databasesCreated: created.length, cleanupConfirmed: true })}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Sequence generator audit failed"); process.exitCode = 1; });
