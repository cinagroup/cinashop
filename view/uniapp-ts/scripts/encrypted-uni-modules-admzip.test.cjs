const assert = require("node:assert/strict");
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const test = require("node:test");

const AdmZip = require("adm-zip");
const dcloud = require("@dcloudio/uni-cli-shared/dist/uni_modules.js");
const { uniDecryptUniModulesPlugin } = require("@dcloudio/uni-cli-shared/dist/vite/plugins/uts/uni_modules.js");

const EXPECTED_DCLOUD = "3.0.0-4020920240930001";
const EXPECTED_ADM_ZIP = "0.5.18";
const inputDir = resolve("src");

function ownedFixture(t) {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, "cinashop-admzip-"));
  t.after(() => {
    const actual = realpathSync(root);
    const child = relative(base, actual);
    assert.ok(child && !child.startsWith(".." + sep) && child !== ".." && !isAbsolute(child));
    assert.match(basename(actual), /^cinashop-admzip-/);
    rmSync(actual, { recursive: true, force: true });
  });
  return root;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// addFile normalizes entry names. Replace both ZIP header names with the exact
// adversarial bytes so this exercises extraction of an untrusted downloaded ZIP.
function rawNamedZip(name, data = "isolated marker") {
  const safe = "a".repeat(Buffer.byteLength(name));
  const zip = new AdmZip();
  zip.addFile(safe, Buffer.from(data));
  const bytes = zip.toBuffer();
  const replacement = Buffer.from(name);
  assert.equal(replacement.length, Buffer.byteLength(safe));
  let patched = 0;
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    const sig = bytes.readUInt32LE(offset);
    const header = sig === 0x04034b50 ? { len: 26, name: 30 } :
      sig === 0x02014b50 ? { len: 28, name: 46 } : null;
    if (!header || bytes.readUInt16LE(offset + header.len) !== replacement.length) continue;
    const start = offset + header.name;
    if (bytes.subarray(start, start + safe.length).toString() !== safe) continue;
    replacement.copy(bytes, start);
    patched++;
  }
  assert.equal(patched, 2, "both local and central ZIP names must be changed");
  assert.equal(new AdmZip(bytes).getEntries()[0].entryName, name);
  return bytes;
}

test("locked DCloud CLI has the audited encrypted-module extraction entrypoint", () => {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.packages["node_modules/@dcloudio/uni-cli-shared"].version, EXPECTED_DCLOUD);
  assert.equal(lock.packages["node_modules/adm-zip"].version, EXPECTED_ADM_ZIP);
  assert.equal(require("@dcloudio/uni-cli-shared/package.json").version, EXPECTED_DCLOUD);
  assert.equal(require("adm-zip/package.json").version, EXPECTED_ADM_ZIP);
  const source = readFileSync(require.resolve("@dcloudio/uni-cli-shared/dist/uni_modules.js"), "utf8");
  assert.match(source, /const zip = new AdmZip\(downloadFile\);\s*zip\.extractAllTo\(cacheDir, true\)/);
});

test("current source has no encrypted uni_modules; real DCloud discovery would not upload", (t) => {
  assert.deepEqual(dcloud.findEncryptUniModules(inputDir), {});
  const root = ownedFixture(t);
  const plugin = join(root, "uni_modules", "synthetic-encrypted");
  mkdirSync(join(plugin, "encrypt"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ version: "1.0.0" }));
  assert.deepEqual(Object.keys(dcloud.findEncryptUniModules(root)), ["synthetic-encrypted"]);
  mkdirSync(join(plugin, "utssdk"));
  assert.deepEqual(dcloud.findEncryptUniModules(root), {});
});

test("actual DCloud plugin calls cloud compilation only for UniApp X", async () => {
  const oldCheck = dcloud.checkEncryptUniModules;
  const saved = Object.fromEntries(["UNI_INPUT_DIR", "UNI_APP_X", "UNI_COMPILE_TARGET"].map(key => [key, process.env[key]]));
  const calls = [];
  try {
    dcloud.checkEncryptUniModules = async (...args) => { calls.push(args); return {}; };
    process.env.UNI_INPUT_DIR = inputDir;
    process.env.UNI_COMPILE_TARGET = "";
    process.env.UNI_APP_X = "false";
    await uniDecryptUniModulesPlugin().configResolved();
    assert.equal(calls.length, 0);
    process.env.UNI_APP_X = "true";
    await uniDecryptUniModulesPlugin().configResolved();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], inputDir);
    assert.equal(calls[0][1]["uni-app-x"], true);
  } finally {
    dcloud.checkEncryptUniModules = oldCheck;
    for (const [name, value] of Object.entries(saved)) restoreEnv(name, value);
  }
});

test("downloaded ZIP traversal and absolute names stay inside an isolated cache", (t) => {
  const root = ownedFixture(t);
  const outside = join(root, "outside.txt");
  const absolute = join(root, "absolute.txt").replaceAll("\\", "/");
  const names = ["../outside.txt", "..\\outside.txt", "inner/../../outside.txt", absolute];
  for (const [index, name] of names.entries()) {
    const cache = join(root, `cache-${index}`);
    mkdirSync(cache);
    const zip = new AdmZip(rawNamedZip(name));
    try { zip.extractAllTo(cache, true); } // same arguments as the locked DCloud CLI
    catch (error) {
      // A Windows drive-qualified name can be rejected as an invalid child
      // path instead of being rebased into the cache.
      assert.equal(name, absolute);
      assert.ok(["ENOENT", "EINVAL"].includes(error.code), String(error));
    }
    assert.equal(existsSync(outside), false, name);
    assert.equal(existsSync(join(root, "absolute.txt")), false, name);
    assert.ok(zip.getEntries().length === 1);
  }
});

test("ZIP symlink metadata is not materialized as a filesystem link", (t) => {
  const root = ownedFixture(t);
  const cache = join(root, "cache");
  mkdirSync(cache);
  const zip = new AdmZip();
  zip.addFile("archive-link", Buffer.from("../outside"));
  const bytes = zip.toBuffer();
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  bytes.writeUInt16LE(0x031e, central + 4); // Unix creator
  bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38); // symlink file type
  assert.equal((new AdmZip(bytes).getEntries()[0].attr >>> 16) & 0o170000, 0o120000);
  new AdmZip(bytes).extractAllTo(cache, true);
  const extracted = join(cache, "archive-link");
  assert.equal(lstatSync(extracted).isSymbolicLink(), false);
  assert.equal(readFileSync(extracted, "utf8"), "../outside");
});

test("preexisting cache link behavior is reported only within the disposable fixture", (t) => {
  const root = ownedFixture(t);
  const cache = join(root, "cache");
  const outside = join(root, "outside");
  mkdirSync(cache); mkdirSync(outside);
  const link = join(cache, "link");
  try { symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlink creation unavailable on this host");
    throw error;
  }
  const zip = new AdmZip();
  zip.addFile("link/marker.txt", Buffer.from("fixture only"));
  zip.extractAllTo(cache, true);
  const followed = existsSync(join(outside, "marker.txt"));
  // This is a dependency/cache trust-boundary observation, not a claim that
  // this repository currently invokes cloud compilation or has such a link.
  process.stdout.write("ADMZIP_PREEXISTING_LINK_AUDIT " + JSON.stringify({ followed }) + "\n");
  assert.equal(dirname(realpathSync(link)), root);
});
