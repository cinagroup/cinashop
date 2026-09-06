const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
async function main() {
  const format=process.argv[2];
  if(!["cjs","esm"].includes(format)) throw new Error("Expected cjs or esm API");
  const api=format==="cjs"?require("drizzle-kit/api"):await import(pathToFileURL(join(dirname(require.resolve("drizzle-kit")),"api.mjs")).href);
  const models=require("tsx/cjs/api").require("../../src/models/schema/index.ts",__filename);
  const report=await require("./checkStateAudit.cjs")({api,models,format});
  console.log("CHECK_STATE_LOCAL_AUDIT "+JSON.stringify({format,...report}));
}
main().catch(error=>{console.error({message:error.message,code:error.code,stack:error.stack});process.exitCode=1;});
