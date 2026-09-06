// DB-008: drizzle-kit 0.31.10 emits PG foreign keys before their unique indexes.
// DB-009E2A also preserves explicit NOT VALID CHECK/FK metadata during generation.
// All three upstream entry points are checksum-pinned. Re-audit on any upgrade.
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { edits, rewrite } = require("./drizzle-pg-not-valid-patch.cjs");
const { edits: sequenceEdits } = require("./drizzle-pg-sequence-patch.cjs");

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

function reconstructOriginal(filename, source) {
  const expected = hashes[filename];
  if (!expected) throw new Error(`Unsupported Drizzle entry point: ${filename}`);
  if (digest(source) === expected) return source;
  // Accept the exact previously audited ordering-only patch as an upgrade input.
  const ordered = source.replace(after, before);
  if (digest(ordered) === expected) return ordered;
  try {
    const prior = rewrite(source, sequenceEdits(filename), true);
    const restored = rewrite(prior, edits(filename), true).replace(after, before);
    if (digest(restored) === expected && rewrite(rewrite(restored.replace(before, after), edits(filename)), sequenceEdits(filename)) === source) return restored;
  } catch { /* Also accept the exact previously audited NOT VALID patch below. */ }
  try {
    const restored = rewrite(source, edits(filename), true).replace(after, before);
    if (digest(restored) === expected && rewrite(restored.replace(before, after), edits(filename)) === source) return restored;
  } catch { /* Reject unknown partial edits below, before writing any bundle. */ }
  throw new Error(`Drizzle ${filename} checksum/order drift: re-audit DB-008 before installing`);
}

// Derive accepted complete variants only from the checksum-verified upstream.
// Each input still needs a full digest AND byte-for-byte match. This avoids
// repeatedly reconstructing multi-megabyte bundles for every refusal probe.
const verified = new Map();
function originalSource(filename, source) {
  if (!hashes[filename]) throw new Error(`Unsupported Drizzle entry point: ${filename}`);
  if (!verified.has(filename)) {
    const original = reconstructOriginal(filename, source);
    const ordered = original.replace(before, after);
    const notValid = rewrite(ordered, edits(filename));
    const patched = rewrite(notValid, sequenceEdits(filename));
    verified.set(filename, { original, patched,
      variants: new Map([original, ordered, notValid, patched].map(value => [digest(value), value])) });
  }
  const known = verified.get(filename);
  if (known.variants.get(digest(source)) !== source)
    throw new Error(`Drizzle ${filename} checksum/order drift: re-audit DB-008 before installing`);
  return known.original;
}

function patchSource(filename, source) {
  originalSource(filename, source);
  return verified.get(filename).patched;
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

module.exports = { hashes, before, after, originalSource, patchSource, patchDirectory };
if (require.main === module) {
  const result = patchDirectory(join(__dirname, "../node_modules/drizzle-kit"));
  console.log(result.skipped ? "DB-008: dev-only drizzle-kit absent; skipped" : `DB-008: pinned PG ordering verified (${result.changed.length} entry points patched)`);
}
