import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("test/integration/SystemConfigDuplicateAuditWorker.ts", "utf8");
const runner = readFileSync("scripts/run-system-config-duplicate-production-audit.ps1", "utf8");
const baseline = JSON.parse(
  readFileSync("audit/system-config-duplicate-baseline.json", "utf8"),
) as {
  duplicateKeys: number;
  duplicateRows: number;
  extraRows: number;
  referencingForeignKeys: number;
  decision: { status: string };
  groups: Array<{ key: string; keepId: number; removeIds: number[] }>;
};

describe("system config duplicate production audit", () => {
  it("uses the runtime precedence rule in a read-only transaction", () => {
    expect(worker).toContain("SET TRANSACTION READ ONLY");
    expect(worker).toContain("ORDER BY c.menu_name, c.sort DESC, c.id DESC");
    expect(worker).toContain('runtime_selection_rule: "sort DESC, id DESC"');
    expect(worker).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });

  it("reveals values only for the three explicitly reviewed non-secret keys", () => {
    expect(worker).toContain('["site_url", "sign_give_point", "sign_status"]');
    expect(worker).toContain("SECRET_LIKE_KEY");
    expect(worker).toContain("value_sha256");
    expect(worker).toContain("payload_sha256");
    expect(worker).toContain("SAFE_DISPLAY_KEYS.has(key) ? row.value.slice(0, 512) : null");
    expect(worker).not.toMatch(/console\.(?:log|error)/);
  });

  it("protects and removes the temporary Worker", () => {
    expect(worker).toContain('request.headers.get("X-Audit-Token")');
    expect(worker).toContain("crypto.subtle.timingSafeEqual");
    expect(runner).toContain("no_token_status");
    expect(runner).toContain("wrong_method_status");
    expect(runner).toContain("url_returns_404");
  });

  it("records every exact cleanup target without claiming approval", () => {
    expect(baseline).toMatchObject({
      duplicateKeys: 6,
      duplicateRows: 26,
      extraRows: 20,
      referencingForeignKeys: 0,
      decision: { status: "pending_owner_confirmation" },
    });
    expect(baseline.groups.map((group) => group.key)).toEqual([
      "record_No",
      "sign_give_point",
      "sign_status",
      "site_url",
      "system_comment_time",
      "system_delivery_time",
    ]);
    expect(new Set(baseline.groups.flatMap((group) => [group.keepId, ...group.removeIds])).size).toBe(26);
    expect(baseline.groups.reduce((sum, group) => sum + group.removeIds.length, 0)).toBe(20);
  });
});
