// Full current ORM schema plus exact historical duplicate CREATEs; CI separately probes full external history on PG16.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
async function main() {
  const { PGlite } = require("@electric-sql/pglite");
  const api = require("drizzle-kit/api");
  const load = require("tsx/cjs/api").require;
  const models = load("../../src/models/schema/index.ts", __filename);
  const { readCatalog } = load("../../scripts/data-migration/postgres-catalog-audit.ts", __filename);
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../audit/external-duplicate-index-reconciliation.json"), "utf8"));
  const generated = await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models));
  const db = new PGlite();
  try {
    await db.exec(generated.join("\n"));
    await db.exec(manifest.entries.map(e => e.source.sql).join("\n"));
    const result = await require("./externalDuplicateIndexAudit.cjs")({ db, read: () => readCatalog(async query => (await db.query(query)).rows), format: "pglite" });
    assert.equal(result.removedIndexes.length, 5);
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
