const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { PGlite } = require("@electric-sql/pglite");
(async () => {
  const format = process.argv[2];
  if (!["cjs", "esm"].includes(format)) throw new Error("Expected cjs or esm");
  const api = format === "cjs" ? require("drizzle-kit/api") : await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")), "api.mjs")).href);
  const db = new PGlite();
  try { console.log("SEQUENCE_GENERATOR_LOCAL " + JSON.stringify(await require("./sequenceStateGeneratorAudit.cjs")({ api, db, format }))); }
  finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
