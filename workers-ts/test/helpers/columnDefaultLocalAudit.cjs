// Socket-denied full-model default upgrade through each actual Drizzle API entry.
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
async function main() {
  const format = process.argv[2];
  if (!["cjs", "esm"].includes(format)) throw new Error("Expected cjs or esm API");
  const api = format === "cjs" ? require("drizzle-kit/api") : await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")), "api.mjs")).href);
  const models = require("tsx/cjs/api").require("../../src/models/schema/index.ts", __filename);
  await require("./columnDefaultAudit.cjs")({ api, models, format });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
