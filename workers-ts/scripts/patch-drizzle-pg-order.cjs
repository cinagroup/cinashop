// DB-008: drizzle-kit 0.31.10 emits PG foreign keys before their unique indexes.
// Keep the deployed standalone indexes; change only JSON statement ordering in
// the three upstream entry points. Remove/re-audit this patch on any upgrade.
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const hashes = Object.freeze({
  "bin.cjs": "44f5420e63c88e13e750f5233878b054e262c3223bd94eabf6ac05b2ae77abd7",
  "api.js": "5c39a62e2e5fc1554b8e423b1ffe453ccc975e0ccca0090f0cf3210aeb6c49fc",
  "api.mjs": "680719eabea08e3e7155c822adcaf9343b3d9b30a9baea935be8de8069bcee4e",
});
const original = [
  "jsonAddColumnsStatemets", "jsonCreateReferencesForCreatedTables",
  "jsonCreateIndexesForCreatedTables", "jsonCreatedReferencesForAlteredTables",
  "jsonCreateIndexesFoAlteredTables", "jsonDropColumnsStatemets",
  "jsonAlteredCompositePKs", "jsonAddedUniqueConstraints",
  "jsonCreatedCheckConstraints", "jsonAlteredUniqueConstraints", "createViews",
];
const references = ["jsonCreateReferencesForCreatedTables", "jsonCreatedReferencesForAlteredTables"];
const reordered = original.filter((name) => !references.includes(name));
reordered.splice(reordered.indexOf("createViews"), 0, ...references);
const block = (names) => names.map((name) => `      jsonStatements.push(...${name});`).join("\n");
const before = block(original);
const after = block(reordered);
const digest = (source) => createHash("sha256").update(source).digest("hex");

function patchSource(filename, source) {
  const expected = hashes[filename];
  if (!expected) throw new Error(`Unsupported Drizzle entry point: ${filename}`);
  if (digest(source) === expected && source.split(before).length === 2) {
    return source.replace(before, after);
  }
  if (source.split(after).length === 2 && digest(source.replace(after, before)) === expected) return source;
  throw new Error(`Drizzle ${filename} checksum/order drift: re-audit DB-008 before installing`);
}

function patchDirectory(directory) {
  const manifest = join(directory, "package.json");
  // drizzle-kit is dev-only; production-only installs have nothing to patch.
  if (!existsSync(manifest)) return { skipped: true, changed: [] };
  if (JSON.parse(readFileSync(manifest, "utf8")).version !== "0.31.10") {
    throw new Error("Drizzle version changed: re-audit DB-008 before installing");
  }
  // Validate every entry point before writing any; reject unknown partial edits.
  const plan = Object.keys(hashes).map((name) => {
    const path = join(directory, name);
    const source = readFileSync(path, "utf8");
    return { name, path, source, patched: patchSource(name, source) };
  });
  const changed = plan.filter((entry) => entry.source !== entry.patched);
  for (const entry of changed) writeFileSync(entry.path, entry.patched);
  return { skipped: false, changed: changed.map((entry) => entry.name) };
}

module.exports = { hashes, before, after, patchSource, patchDirectory };
if (require.main === module) {
  const result = patchDirectory(join(__dirname, "../node_modules/drizzle-kit"));
  console.log(result.skipped ? "DB-008: dev-only drizzle-kit absent; skipped" : `DB-008: pinned PG ordering verified (${result.changed.length} entry points patched)`);
}
