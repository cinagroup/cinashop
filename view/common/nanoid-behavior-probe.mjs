// Run in a bounded child process: a regressed synchronous generator must not hang CI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2]);
const require = createRequire(resolve(root, "package.json"));
const modules = [];
for (const file of ["index.cjs", "index.browser.cjs", "async/index.cjs", "async/index.browser.cjs", "non-secure/index.cjs"]) {
  modules.push([file, require(resolve(root, file))]);
}
for (const file of ["index.js", "index.browser.js", "async/index.js", "async/index.browser.js", "non-secure/index.js"]) {
  modules.push([file, await import(pathToFileURL(resolve(root, file)).href)]);
}

// Exercise the published React Native function body without installing an Expo runtime.
// Only its two imports/export wrapper are substituted; generator logic stays unchanged.
const nativeSource = readFileSync(resolve(root, "async/index.native.js"), "utf8");
const randomImport = "import { getRandomBytesAsync } from 'expo-random'";
const alphabetImport = "import { urlAlphabet } from '../url-alphabet/index.js'";
const exportLine = "export { nanoid, customAlphabet, random }";
for (const declaration of [randomImport, alphabetImport, exportLine]) assert.ok(nativeSource.includes(declaration));
let nativeRandomCalls = 0;
const nativeModule = new Function("getRandomBytesAsync", "urlAlphabet", nativeSource
  .replace(randomImport, "").replace(alphabetImport, "").replace(exportLine, "return { nanoid, customAlphabet, random }"))(
  async (size) => {
    assert.ok(++nativeRandomCalls <= 50, "native generator failed to terminate");
    return new Uint8Array(size);
  }, "abcdefghijklmnopqrstuvwxyz",
);
modules.push(["async/index.native.js (stubbed randomness)", nativeModule]);

for (const [entry, api] of modules) {
  assert.equal(await api.customAlphabet("abc", 0)(), "", `${entry}: default zero`);
  assert.equal(await api.customAlphabet("abc", 6)(0), "", `${entry}: explicit zero`);
  assert.equal(await api.customAlphabet("abc", 6)(-1), "", `${entry}: negative size`);
  const regular = await api.customAlphabet("abc", 6)();
  assert.match(regular, /^[abc]{6}$/, `${entry}: normal generation`);
  assert.equal((await api.customAlphabet("abc", 6)(9)).length, 9, `${entry}: size override`);
  assert.equal((await api.nanoid(6)).length, 6, `${entry}: fixed-size caller`);
  if (api.customRandom) {
    assert.equal(await api.customRandom("abc", 0, (size) => new Uint8Array(size))(), "", `${entry}: custom randomness zero`);
    assert.equal(await api.customRandom("abc", 6, (size) => new Uint8Array(size))(0), "", `${entry}: custom randomness override`);
  }
}
process.stdout.write(JSON.stringify({ entries: modules.length, coveredZeroAndNegativeCasesTerminate: true, coveredRegularIdsPreserved: true }));
