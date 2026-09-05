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
