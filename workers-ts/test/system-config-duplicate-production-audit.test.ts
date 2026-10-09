import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const postgresMock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("postgres", () => ({ default: postgresMock.connect }));

import worker from "./integration/SystemConfigDuplicateAuditWorker";

const source = readFileSync("test/integration/SystemConfigDuplicateAuditWorker.ts", "utf8");
const runner = readFileSync("scripts/run-system-config-duplicate-production-audit.ps1", "utf8");
const config = JSON.parse(readFileSync("test/integration/system-config-duplicate-audit.wrangler.jsonc", "utf8"));
const baseline = JSON.parse(readFileSync("audit/system-config-duplicate-baseline.json", "utf8"));
const token = "db003-offline-fault-test-token";
const tokenHash = createHash("sha256").update(token).digest("hex");
const marker = "a".repeat(64);

function env(expiry = Date.now() + 60_000) {
  return {
    HYPERDRIVE: { connectionString: "postgres://offline.invalid/postgres" },
    AUDIT_TOKEN_SHA256: tokenHash,
    AUDIT_EXPIRES_AT: String(expiry),
    RUN_MARKER: marker,
  } as Parameters<typeof worker.fetch>[1];
}

function request(method = "GET", path = "/audit", suppliedToken = token) {
  return new Request(`https://offline.invalid${path}`, {
    method,
    headers: suppliedToken ? { "X-Audit-Token": suppliedToken } : {},
  });
}

function row(id: number, key: string, value: string, sort: number, status: number) {
  return {
    id, is_store: 0, menu_name: key, type: "input", input_type: "input",
    config_tab_id: 0, parameter: "", upload_type: 1, required: "",
    width: 0, high: 0, value, info: "", description: "", sort, status,
  };
}

function fakeDatabase(rows: ReturnType<typeof row>[], role = "cinashop_app_v1") {
  const statements: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    statements.push(sql);
    if (sql.includes("current_database()")) return [{ database: "postgres", role }];
    if (sql.includes("FROM public.system_config c")) return rows;
    if (sql.includes("FROM pg_constraint")) return [{ count: 0 }];
    if (sql.includes("server_version")) return [{ version: "16.14" }];
    return [];
  };
  const end = vi.fn();
  postgresMock.connect.mockReturnValue({ begin: (fn: (tx: typeof tx) => unknown) => fn(tx), end });
  return { statements, end };
}

beforeEach(() => postgresMock.connect.mockReset());

describe("DB-003 production read-only audit candidate", () => {
  it("rejects missing, wrong and expired tokens before opening a database connection", async () => {
    for (const [tokenInput, expiry] of [
      ["", Date.now() + 60_000], ["wrong-token", Date.now() + 60_000],
      [token, Date.now() - 1],
    ] as const) {
      const reply = await worker.fetch(request("GET", "/audit", tokenInput), env(expiry));
      expect(reply.status).toBe(403);
      expect(reply.headers.get("Cache-Control")).toContain("no-store");
    }
    expect(postgresMock.connect).not.toHaveBeenCalled();
  });

  it("rejects wrong method and query strings before opening a database connection", async () => {
    expect((await worker.fetch(request("POST"), env())).status).toBe(404);
    expect((await worker.fetch(request("GET", "/audit?sql=none"), env())).status).toBe(404);
    expect(postgresMock.connect).not.toHaveBeenCalled();
  });

  it("uses one bounded repeatable-read snapshot and never returns raw configuration values", async () => {
    const secret = "offline-secret-never-in-response";
    const { statements, end } = fakeDatabase([
      row(2, "site_url", "https://cinashop.example.com", 0, 0),
      row(389, "site_url", "https://cinashop-pc.pages.dev", 98, 1),
      row(900, "pay_private_key", secret, 0, 1),
    ]);
    const reply = await worker.fetch(request(), env());
    expect(reply.status).toBe(200);
    const raw = await reply.text();
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("https://cinashop.example.com");
    expect(raw).not.toContain("https://cinashop-pc.pages.dev");
    const report = JSON.parse(raw);
    expect(report).toMatchObject({
      run_marker: marker, database_name: "postgres", database_role: "cinashop_app_v1",
      table_rows: 3, duplicate_keys: 1, duplicate_rows: 2, extra_rows: 1,
    });
    expect(report.duplicate_groups[0].runtime_selected_id).toBe(389);
    expect(report.duplicate_groups[0].rows[0].matches_expected_site_url).toBe(true);
    expect(report.duplicate_groups[0].rows[1].matches_placeholder_site_url).toBe(true);
    expect(report.table_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(statements[0]).toContain("REPEATABLE READ READ ONLY");
    expect(statements[1]).toContain("search_path = public, pg_temp");
    expect(statements.some((sql) => sql.includes("LIMIT ?"))).toBe(true);
    expect(statements.every((sql) => !/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(sql))).toBe(true);
    expect(end).toHaveBeenCalledOnce();
  });

  it("fails closed on wrong database role or an overlarge configuration table", async () => {
    const wrong = fakeDatabase([row(389, "site_url", "x", 98, 1)], "postgres");
    expect((await worker.fetch(request(), env())).status).toBe(500);
    expect(wrong.statements.some((sql) => sql.includes("FROM public.system_config c"))).toBe(false);
    expect(wrong.end).toHaveBeenCalledOnce();
    const oversized = fakeDatabase(Array.from({ length: 1025 }, (_, i) => row(i + 1, `key_${i}`, "x", 0, 1)));
    expect((await worker.fetch(request(), env())).status).toBe(500);
    expect(oversized.end).toHaveBeenCalledOnce();
  });

  it("fails closed if a newly duplicated key looks like a credential", async () => {
    const database = fakeDatabase([
      row(901, "pay_private_key", "secret-one", 1, 1),
      row(902, "pay_private_key", "secret-two", 0, 0),
    ]);
    const reply = await worker.fetch(request(), env());
    expect(reply.status).toBe(500);
    expect(await reply.text()).not.toContain("secret-one");
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("pins the live Worker and app Hyperdrive, requires a clean commit, and treats cleanup failure as failure", () => {
    expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "ba7faa6680cd48d4b3a1d36a7a5fc8f7" }]);
    expect(config.vars).toEqual({ AUDIT_TOKEN_SHA256: "", AUDIT_EXPIRES_AT: "", RUN_MARKER: "" });
    expect(runner).toContain("cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2");
    expect(runner).toContain("git -C $taskRepository status --porcelain=v1");
    expect(runner).toContain("Get-OwnedAuditVersion");
    expect(runner).toContain("$taskControlPlane404");
    expect(runner).toContain("$taskPublic404");
    expect(runner).toContain("AddMinutes(10)");
    expect(runner).toContain("exit 2");
    expect(runner).not.toMatch(/\b(?:INSERT INTO|UPDATE public|DELETE FROM|ALTER TABLE|DROP TABLE)\b/i);
    expect(source).not.toContain("display_value");
    expect(baseline.decision.status).toBe("pending_owner_confirmation");
    expect(baseline.groups.reduce((sum: number, group: { removeIds: number[] }) => sum + group.removeIds.length, 0)).toBe(20);
  });

  it.skipIf(process.platform !== "win32")("fails before network access without a token or with an unreviewed commit", () => {
    const script = "scripts/run-system-config-duplicate-production-audit.ps1";
    const sourceSha = "1578baba7df3d0a7fdf9620f068a8eb20986e01a";
    const noToken = spawnSync("pwsh", ["-NoProfile", "-File", script, "-ExpectedSourceSha", sourceSha], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
    });
    expect(noToken.status).toBe(1);
    expect(noToken.stderr).toContain("Cloudflare API authentication is required");
    const wrongCommit = spawnSync("pwsh", ["-NoProfile", "-File", script, "-ExpectedSourceSha", "0".repeat(40)], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "offline-placeholder" },
    });
    expect(wrongCommit.status).toBe(1);
    expect(wrongCommit.stderr).toContain("Reviewed source commit mismatch");
  });
});
