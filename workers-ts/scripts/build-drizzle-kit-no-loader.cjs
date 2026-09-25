// Rebuild the vendored Drizzle tarball from the exact public 0.31.10 package.
// Only its unused @esbuild-kit/esm-loader dependency declaration may differ.
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");

const upstreamIntegrity = "sha512-7OZcmQUrdGI+DUNNsKBn1aW8qSoKuTH7d0mYgSP8bAzdFzKoovxEFnoGQp2dVs82EOJeYycqRtciopszwUf8bw==";
const expectedFiles = [
  "README.md", "api.d.mts", "api.d.ts", "api.js", "api.mjs", "bin.cjs",
  "index.d.mts", "index.d.ts", "index.js", "index.mjs", "package.json", "utils.js", "utils.mjs",
];
const declaration = '\t\t"@esbuild-kit/esm-loader": "^2.5.5",\n';
const archive = process.argv[2] && resolve(process.argv[2]);
if (!archive || !existsSync(archive)) {
  throw new Error("Usage: node scripts/build-drizzle-kit-no-loader.cjs <official-drizzle-kit-0.31.10.tgz>");
}

function integrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}
function run(command, args) {
  const child = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${child.error || child.stderr || child.stdout}`);
  return child.stdout;
}
const sourceIntegrity = integrity(archive);
if (sourceIntegrity !== upstreamIntegrity) throw new Error(`Unexpected upstream Drizzle integrity: ${sourceIntegrity}`);
const temporaryParent = realpathSync(tmpdir());
const temporary = realpathSync(mkdtempSync(join(temporaryParent, "cinashop-drizzle-no-loader-")));
function assertOwnedTemporary() {
  if (dirname(temporary) !== temporaryParent || !/^cinashop-drizzle-no-loader-[A-Za-z0-9]+$/.test(basename(temporary))
    || !existsSync(temporary) || realpathSync(temporary) !== temporary) {
    throw new Error("Refusing to remove an unexpected Drizzle build directory");
  }
}
assertOwnedTemporary();
try {
  const source = join(temporary, "source"), output = join(temporary, "output"), check = join(temporary, "check");
  for (const path of [source, output, check]) mkdirSync(path);
  run("tar", ["-xzf", archive, "-C", source]);
  const packageDir = join(source, "package"), manifestPath = join(packageDir, "package.json");
  const actual = readdirSync(packageDir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedFiles.slice().sort())) throw new Error("Upstream file set changed");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  if (manifest.name !== "drizzle-kit" || manifest.version !== "0.31.10"
    || manifest.dependencies?.["@esbuild-kit/esm-loader"] !== "^2.5.5"
    || original.split(declaration).length !== 2) throw new Error("Upstream Drizzle manifest changed");
  const modified = original.replace(declaration, "");
  const modifiedManifest = JSON.parse(modified);
  if (Object.hasOwn(modifiedManifest.dependencies, "@esbuild-kit/esm-loader")) throw new Error("Old loader remained");
  writeFileSync(manifestPath, modified);

  const npmCli = process.env.npm_execpath || (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : null);
  const command = npmCli ? process.execPath : "npm";
  const args = [...(npmCli ? [npmCli] : []), "pack", packageDir,
    "--pack-destination", output, "--ignore-scripts", "--offline", "--cache", join(temporary, "npm-cache"), "--json"];
  const packed = JSON.parse(run(command, args));
  if (packed.length !== 1 || packed[0].filename !== "drizzle-kit-0.31.10.tgz") throw new Error("Unexpected local pack result");
  const result = join(output, packed[0].filename);
  run("tar", ["-xzf", result, "-C", check]);
  const repackedDir = join(check, "package");
  if (JSON.stringify(readdirSync(repackedDir).sort()) !== JSON.stringify(actual)) throw new Error("Repack changed file set");
  for (const name of actual) {
    const expected = name === "package.json" ? modified : readFileSync(join(packageDir, name));
    const observed = readFileSync(join(repackedDir, name));
    if (!Buffer.from(expected).equals(observed)) throw new Error(`Repack changed ${name}`);
  }
  const destination = join(__dirname, "../vendor/drizzle-kit-0.31.10-no-esm-loader.tgz");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(result, destination);
  process.stdout.write(JSON.stringify({ upstreamIntegrity, packageIntegrity: integrity(destination),
    changed: ["package.json: remove @esbuild-kit/esm-loader ^2.5.5"], destination: basename(destination) }) + "\n");
} finally {
  assertOwnedTemporary();
  rmSync(temporary, { recursive: true, force: true });
}
