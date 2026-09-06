const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { PGlite } = require("@electric-sql/pglite");
const assert = require("node:assert/strict");
const { sql } = require("drizzle-orm");
async function main() {
  const format = process.argv[2];
  if (!["cjs", "esm"].includes(format)) throw new Error("Expected cjs or esm API");
  const api = format === "cjs" ? require("drizzle-kit/api")
    : await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")), "api.mjs")).href);
  for (const [core, prefix, tableFunction, columnFunction] of [
    ["mysql-core", "MySQL", "mysqlTable", "int"], ["sqlite-core", "SQLite", "sqliteTable", "integer"],
  ]) {
    const dialect = require(`drizzle-orm/${core}`);
    const table = dialect[tableFunction]("ordinary", { amount: dialect[columnFunction]() },
      () => [dialect.check("ordinary_ck", sql`amount >= 0`)]);
    const generate = api[`generate${prefix}DrizzleJson`];
    const migrate = api[`generate${prefix}Migration`];
    const previous = await generate({});
    const current = await generate({ table });
    const ddl = await migrate(previous, current);
    assert.equal(ddl.length, 1);
    assert.ok(ddl[0].includes("CHECK(amount >= 0)"));
    assert.equal(ddl[0].includes("NOT VALID"), false);
    assert.deepEqual(await migrate(current, await generate({ table }, current.id)), []);
  }
  const db = new PGlite();
  try { await require("./notValidAudit.cjs")({ api, db, format }); }
  finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
