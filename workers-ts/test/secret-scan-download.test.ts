import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("secret scan download remains bounded and fail-closed", () => {
  it("retries only the pinned artifact GET, retaining digest verification before extraction and full-history scan", () => {
    const workflow = readFileSync("../.github/workflows/workers-runtime-linux.yml", "utf8");
    const block = workflow.split("  secret-scan:")[1];
    expect(block).toBeTruthy();
    expect(block).toContain("fetch-depth: 0");
    expect(block).toContain("curl --fail --location --silent --show-error");
    expect(block).toContain("--retry 3 --retry-all-errors --retry-max-time 120");
    expect(block).toContain("--connect-timeout 10 --max-time 40");
    expect(block).toContain('--output "$archive"');
    expect(block).toContain('GITLEAKS_VERSION: "8.29.0"');
    expect(block).toContain('GITLEAKS_LINUX_X64_SHA256: "39e07ad810336fd0ae80d0bd61c60d0521f628173e7583583b5df4a38738522c"');
    const ordered = ["curl --fail", "sha256sum --check", "tar -xzf", 'gitleaks" version', 'gitleaks" git --redact --verbose --no-banner'];
    const offsets = ordered.map(value => block.indexOf(value));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(block).not.toMatch(/continue-on-error|\|\|\s*true|--insecure|--exit-code\s+0/);
  });
});
