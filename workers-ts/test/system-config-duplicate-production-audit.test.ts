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

const healthyIdentity = {
  database_ok: true, current_role_ok: true, session_role_ok: true,
  backend_login_ok: true, pg16_ok: true, read_only_ok: true,
  repeatable_read_ok: true,
};

function fakeDatabase(rows: ReturnType<typeof row>[], identityPatch: Partial<typeof healthyIdentity> = {}) {
  const statements: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    statements.push(sql);
    if (sql.includes("current_database()")) return [{ ...healthyIdentity, ...identityPatch }];
    if (sql.includes("FROM public.system_config c")) return rows;
    if (sql.includes("FROM pg_constraint")) return [{ count: 0 }];
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
      run_marker: marker, identity: { expected_role: "cinashop_app_v1", ...healthyIdentity },
      table_rows: 3, duplicate_keys: 1, duplicate_rows: 2, extra_rows: 1,
    });
    expect(raw).not.toContain("database_name");
    expect(raw).not.toContain("database_role");
    expect(report.duplicate_groups[0].runtime_selected_id).toBe(389);
    expect(report.duplicate_groups[0].rows[0].matches_expected_site_url).toBe(true);
    expect(report.duplicate_groups[0].rows[1].matches_placeholder_site_url).toBe(true);
    expect(report.duplicate_groups[0].rows[0].type_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.duplicate_groups[0].rows[0].input_type_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.duplicate_groups[0].rows[0]).not.toHaveProperty("type");
    expect(report.duplicate_groups[0].rows[0]).not.toHaveProperty("input_type");
    expect(report.table_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(statements[0]).toContain("REPEATABLE READ READ ONLY");
    expect(statements[1]).toContain("search_path = public, pg_temp");
    const identitySql = statements.find((sql) => sql.includes("current_database()")) ?? "";
    for (const assertion of ["session_user", "pg_stat_activity", "pg_roles", "rolcanlogin",
      "server_version_num", "transaction_read_only", "transaction_isolation"]) {
      expect(identitySql).toContain(assertion);
    }
    expect(statements.some((sql) => sql.includes("LIMIT ?"))).toBe(true);
    expect(statements.every((sql) => !/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(sql))).toBe(true);
    expect(end).toHaveBeenCalledOnce();
  });

  it("fails closed before table reads for each database identity and transaction violation", async () => {
    for (const key of Object.keys(healthyIdentity) as Array<keyof typeof healthyIdentity>) {
      const wrong = fakeDatabase([row(389, "site_url", "x", 98, 1)], { [key]: false });
      expect((await worker.fetch(request(), env())).status).toBe(500);
      expect(wrong.statements.some((sql) => sql.includes("FROM public.system_config c"))).toBe(false);
      expect(wrong.end).toHaveBeenCalledOnce();
    }
  });

  it("fails closed on an overlarge configuration table", async () => {
    const oversized = fakeDatabase(Array.from({ length: 1025 }, (_, i) => row(i + 1, `key_${i}`, "x", 0, 1)));
    expect((await worker.fetch(request(), env())).status).toBe(500);
    expect(oversized.end).toHaveBeenCalledOnce();
  });

  it("fails closed without returning any unknown duplicate key or its values", async () => {
    const database = fakeDatabase([
      row(901, "customer_private_note", "secret-one", 1, 1),
      row(902, "customer_private_note", "secret-two", 0, 0),
    ]);
    const reply = await worker.fetch(request(), env());
    expect(reply.status).toBe(500);
    const raw = await reply.text();
    expect(raw).not.toContain("secret-one");
    expect(raw).not.toContain("customer_private_note");
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("pins the live Worker and app Hyperdrive, requires a clean commit, and treats cleanup failure as failure", () => {
    expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "ba7faa6680cd48d4b3a1d36a7a5fc8f7" }]);
    expect(config.vars).toEqual({ AUDIT_TOKEN_SHA256: "", AUDIT_EXPIRES_AT: "", RUN_MARKER: "" });
    expect(runner).toContain("cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2");
    expect(runner).toContain("git -C $taskRepository status --porcelain=v1");
    expect(runner).toContain("Get-OwnedAuditVersion");
    expect(runner).toContain("$taskMatches[0].text -cne [string]$taskExpectedVarValues[$taskVarName]");
    expect(runner).toContain("$taskHyperdrive.result.caching.disabled -ne $true");
    expect(runner).toContain("$taskHyperdrive.result.caching.disabled -isnot [bool]");
    expect(runner).toContain("$taskModifiedOn -cne $script:taskHyperdriveModifiedOn");
    expect(runner).toContain("Main Worker or app Hyperdrive state changed during DB-003 audit.");
    expect(runner).toContain("$taskControlPlane404");
    expect(runner).toContain("$taskPublic404");
    expect((runner.match(/Invoke-WebRequest -Uri/g) ?? []).length).toBe(4);
    expect((runner.match(/-MaximumRedirection 0/g) ?? []).length).toBe(4);
    expect(runner).toContain("AddMinutes(10)");
    expect(runner).toContain("exit 2");
    expect(runner).not.toMatch(/\b(?:INSERT INTO|UPDATE public|DELETE FROM|ALTER TABLE|DROP TABLE)\b/i);
    expect(runner.indexOf("Assert-AuditReport $taskRawReport")).toBeLessThan(runner.indexOf("$taskReport = ConvertTo-SafeAuditReport $taskRawReport"));
    expect(runner).not.toContain("$taskReport = $taskRawReport");
    expect(runner).toContain("if ($taskFailure -or $taskCleanupFailure -or -not $taskMainUnchanged -or");
    expect(runner).toContain("historicalRowMetadataCompared = $false");
    expect(runner).toContain("originIdentityVerified = $false");
    expect(runner).toContain("readyForDml = $false");
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

  it.skipIf(process.platform !== "win32")("rejects changed deployed variables and Hyperdrive caching offline", () => {
    const offline = String.raw`
      $taskTokens=$null; $taskErrors=$null
      $taskAst=[System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path 'scripts/run-system-config-duplicate-production-audit.ps1'),
        [ref]$taskTokens,[ref]$taskErrors)
      if ($taskErrors.Count) { throw 'runner parse failed' }
      foreach ($taskName in @('Get-FullTrafficVersion','Get-OwnedAuditVersion',
        'Assert-AppHyperdriveCacheDisabled','Assert-AuditReport','ConvertTo-SafeAuditReport')) {
        $taskFunction=$taskAst.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $taskName},$true)
        if (-not $taskFunction) { throw 'runner function missing' }
        Invoke-Expression $taskFunction.Extent.Text
      }
      $taskMarker='a'*64; $taskTokenHash='b'*64; $taskExpiry='1791533000000'
      $taskAppHyperdrive='ba7faa6680cd48d4b3a1d36a7a5fc8f7'
      $taskAppHyperdriveApi='offline-hyperdrive'; $taskTargetApi='offline-worker'
      $script:taskHyperdriveModifiedOn=$null
      $taskExpectedVarValues=@{AUDIT_TOKEN_SHA256=$taskTokenHash;AUDIT_EXPIRES_AT=$taskExpiry;RUN_MARKER=$taskMarker}
      $taskExpectedAuditBindings=@(
        "HYPERDRIVE:hyperdrive:$taskAppHyperdrive",'AUDIT_TOKEN_SHA256:plain_text:',
        'AUDIT_EXPIRES_AT:plain_text:','RUN_MARKER:plain_text:') | Sort-Object
      $script:taskBindings=@(
        @{name='HYPERDRIVE';type='hyperdrive';id=$taskAppHyperdrive},
        @{name='AUDIT_TOKEN_SHA256';type='plain_text';text=$taskTokenHash},
        @{name='AUDIT_EXPIRES_AT';type='plain_text';text=$taskExpiry},
        @{name='RUN_MARKER';type='plain_text';text=$taskMarker})
      $script:cacheDisabled=$true
      $script:taskModifiedOn='2026-10-09T00:00:00Z'
      $script:taskDeployments=@{result=@{deployments=@(
        @{created_on='2026-10-08T00:00:00Z';versions=@(@{percentage=100;version_id='22222222-2222-2222-2222-222222222222'})},
        @{created_on='2026-10-09T00:00:00Z';versions=@(@{percentage=100;version_id='11111111-1111-1111-1111-111111111111'})})}}
      function Invoke-ControlPlane {
        param([string]$Uri)
        if ($Uri -like '*/deployments') { return $script:taskDeployments }
        if ($Uri -eq $taskAppHyperdriveApi) {
          return @{result=@{id=$taskAppHyperdrive;caching=@{disabled=$script:cacheDisabled};modified_on=$script:taskModifiedOn}}
        }
        return @{result=@{annotations=@{'workers/message'=$taskMarker};resources=@{bindings=$script:taskBindings}}}
      }
      if ((Get-OwnedAuditVersion) -ne '11111111-1111-1111-1111-111111111111') { throw 'valid version failed' }
      Assert-AppHyperdriveCacheDisabled
      foreach ($taskName in @('AUDIT_TOKEN_SHA256','AUDIT_EXPIRES_AT','RUN_MARKER')) {
        $taskBinding=@($script:taskBindings | Where-Object name -eq $taskName)[0]
        $taskOriginal=$taskBinding.text; $taskBinding.text='tampered'
        $taskRejected=$false
        try { $null=Get-OwnedAuditVersion } catch { $taskRejected=$true }
        $taskBinding.text=$taskOriginal
        if (-not $taskRejected) { throw 'changed deployed value accepted' }
      }
      $script:cacheDisabled=$false; $taskRejected=$false
      try { Assert-AppHyperdriveCacheDisabled } catch { $taskRejected=$true }
      if (-not $taskRejected) { throw 'cache-enabled Hyperdrive accepted' }
      $script:cacheDisabled='true'; $taskRejected=$false
      try { Assert-AppHyperdriveCacheDisabled } catch { $taskRejected=$true }
      if (-not $taskRejected) { throw 'non-boolean cache setting accepted' }
      $script:cacheDisabled=$true; $script:taskModifiedOn='2026-10-10T00:00:00Z'; $taskRejected=$false
      try { Assert-AppHyperdriveCacheDisabled } catch { $taskRejected=$true }
      if (-not $taskRejected) { throw 'modified Hyperdrive accepted' }
      $script:taskDeployments.result.deployments[0].created_on='2026-10-09T00:00:00Z'
      $taskRejected=$false
      try { $null=Get-FullTrafficVersion $taskTargetApi } catch { $taskRejected=$true }
      if (-not $taskRejected) { throw 'ambiguous latest deployment accepted' }
      $taskRaw=@{table_rows=1;table_sha256=('c'*64);duplicate_keys=1;duplicate_rows=1;
        extra_rows=0;referencing_foreign_keys=0;raw_value='secret-top';duplicate_groups=@(
          @{key='site_url';row_count=1;extra_rows=0;runtime_selected_id=389;
            values_identical=$true;payloads_identical_except_id=$true;raw_value='secret-group';rows=@(
              @{id=389;sort=98;status=1;config_tab_id=0;type_sha256=('d'*64);
                input_type_sha256=('e'*64);value_kind='https_url';value_length=3;
                value_sha256=('f'*64);payload_sha256=('0'*64);
                selected_by_runtime=$true;same_value_as_runtime=$true;
                matches_expected_site_url=$true;matches_placeholder_site_url=$false;
                raw_value='secret-row'})})}
      $taskSafe=ConvertTo-SafeAuditReport $taskRaw | ConvertTo-Json -Depth 30
      if ($taskSafe -match 'secret-' -or $taskSafe -match 'raw_value') { throw 'extra response field leaked' }
      $taskBadIdentity=@{run_marker=$taskMarker;table_sha256=('0'*64);
        identity=@{expected_role='cinashop_app_v1';database_ok='true';current_role_ok=$true;
          session_role_ok=$true;backend_login_ok=$true;pg16_ok=$true;
          read_only_ok=$true;repeatable_read_ok=$true}}
      $taskRejected=$false
      try { Assert-AuditReport $taskBadIdentity }
      catch { $taskRejected=$_.Exception.Message -like '*identity flag*' }
      if (-not $taskRejected) { throw 'non-boolean identity accepted' }
      'offline_runner_fault_checks=8;projection_safe=1'
    `;
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", offline], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("offline_runner_fault_checks=8;projection_safe=1");
  });
});
