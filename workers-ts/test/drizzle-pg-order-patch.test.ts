import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const installed = dirname(require.resolve("drizzle-kit"));
const patch = require("../scripts/patch-drizzle-pg-order.cjs") as {
  hashes: Record<string, string>; before: string; after: string;
  patchSource(name: string, source: string): string;
  patchDirectory(directory: string): { skipped: boolean; changed: string[] };
};

describe("DB-008 pinned PostgreSQL generator ordering", () => {
  it("limits the approved secret-scan exception to two complete public checksum lines", () => {
    const blocks = readFileSync(join(root, "../.gitleaks.toml"), "utf8").split("[[allowlists]]")
      .filter((entry) => entry.includes("Public drizzle-kit 0.31.10 API bundle SHA-256 checksums"));
    expect(blocks).toHaveLength(1);
    const block = blocks[0].replace(/\r\n/g, "\n").trim();
    // Exact configuration guard, not a replacement for the real Gitleaks CI scan.
    expect(block).toBe([
      'description = "Public drizzle-kit 0.31.10 API bundle SHA-256 checksums, verified before patching"',
      'targetRules = ["generic-api-key"]',
      'condition = "AND"',
      'regexTarget = "line"',
      "paths = ['''^workers-ts/scripts/patch-drizzle-pg-order\\.cjs$''']",
      "regexes = [",
      `  '''^\\s*"api\\.js": "${patch.hashes["api.js"]}",$''',`,
      `  '''^\\s*"api\\.mjs": "${patch.hashes["api.mjs"]}",$''',`,
      "]",
    ].join("\n"));
    const [path, ...lines] = Array.from(block.matchAll(/'''([^']+)'''/g), ([, pattern]) => new RegExp(pattern));
    const rule = JSON.parse(block.match(/^targetRules = (.+)$/m)![1]) as string[];
    const matches = (filename: string, line: string, ruleId = "generic-api-key") =>
      rule.includes(ruleId) && path.test(filename) && lines.some((regex) => regex.test(line));
    const filename = "workers-ts/scripts/patch-drizzle-pg-order.cjs";
    const sourceLines = readFileSync(join(root, "scripts/patch-drizzle-pg-order.cjs"), "utf8").split(/\r?\n/);
    for (const name of ["api.js", "api.mjs"]) {
      const line = sourceLines.find((entry) => entry.includes(`"${name}":`))!;
      expect(line).toBeDefined();
      expect(matches(filename, line)).toBe(true);
      expect(matches(filename, line.replace(patch.hashes[name], "0".repeat(64)))).toBe(false);
      expect(matches(filename, line.replace(name, "another-api.js"))).toBe(false);
      expect(matches(filename, line + " unrelated content")).toBe(false);
      expect(matches(filename, "prefix " + line)).toBe(false);
      expect(matches(filename, line, "private-key")).toBe(false);
      for (const otherPath of ["other/" + filename, filename + ".bak", "workers-ts/src/api.js"]) {
        expect(matches(otherPath, line)).toBe(false);
      }
    }
    expect(sourceLines.filter((line) => matches(filename, line))).toHaveLength(2);
  });

  it("patches the original CLI/CJS/ESM once and rejects source/version drift before any write", () => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-drizzle-patch-"));
    try {
      for (const name of Object.keys(patch.hashes)) {
        const source = readFileSync(join(installed, name), "utf8");
        expect(source).toContain(patch.after);
        const original = source.replace(patch.after, patch.before);
        expect(patch.patchSource(name, original)).toBe(source);
        expect(patch.patchSource(name, source)).toBe(source);
        expect(() => patch.patchSource(name, source + "\n// unknown edit")).toThrow("checksum/order drift");
        writeFileSync(join(directory, name), original);
      }
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.31.10" }));
      const last = "api.mjs";
      const valid = readFileSync(join(directory, last), "utf8");
      writeFileSync(join(directory, last), valid + "\n");
      const binBefore = readFileSync(join(directory, "bin.cjs"), "utf8");
      expect(() => patch.patchDirectory(directory)).toThrow("checksum/order drift");
      expect(readFileSync(join(directory, "bin.cjs"), "utf8")).toBe(binBefore);
      writeFileSync(join(directory, last), valid);
      expect(patch.patchDirectory(directory).changed).toEqual(Object.keys(patch.hashes));
      expect(patch.patchDirectory(directory).changed).toEqual([]);
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.31.11" }));
      expect(() => patch.patchDirectory(directory)).toThrow("version changed");
      expect(patch.patchDirectory(join(directory, "omitted-dev-package"))).toEqual({ skipped: true, changed: [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["cjs", "esm"])("executes %s API initial/upgrade/no-op migrations with deployed index semantics", (format) => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-drizzle-api-"));
    const report = join(directory, "audit.json");
    try {
      const environment = { ...process.env };
      const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
      for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key];
      Object.assign(environment, { CI: "1", TSX_DISABLE_CACHE: "1", DATABASE_URL: "postgresql://audit:audit@127.0.0.1:9/audit", CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"), join(root, "test/helpers/drizzleApiAudit.cjs"), format], {
        cwd: root, env: environment, encoding: "utf8", timeout: 60_000, windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`DB-008 ${format}: initial, index/constraint upgrades, tenant FK, full-model no-op passed`);
      const audit = JSON.parse(readFileSync(report, "utf8"));
      expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path: string) => path.includes("/@esbuild-kit/"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
