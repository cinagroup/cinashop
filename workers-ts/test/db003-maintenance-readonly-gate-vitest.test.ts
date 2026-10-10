import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("DB-003 maintenance preflight Linux collection", () => {
  it("runs all seven offline Node cases with zero skips in the Vitest unit shard", () => {
    const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    const result = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", "test/db003-maintenance-readonly-gate.test.mjs",
    ], { cwd: directory, env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toMatch(/# tests 7(?:\r?\n|$)/);
    expect(result.stdout).toMatch(/# pass 7(?:\r?\n|$)/);
    expect(result.stdout).toMatch(/# fail 0(?:\r?\n|$)/);
    expect(result.stdout).toMatch(/# skipped 0(?:\r?\n|$)/);
  });
});
