import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ connect: vi.fn(), catalog: vi.fn() }));
vi.mock("postgres", () => ({ default: mock.connect }));
vi.mock("./integration/SystemConfigCatalogRead", () => ({ readSystemConfigCatalog: mock.catalog }));

import worker from "./integration/SystemConfigCatalogAuditWorker";

const runner = readFileSync("scripts/run-system-config-catalog-production-audit.ps1", "utf8");
const config = JSON.parse(readFileSync("test/integration/system-config-catalog-audit.wrangler.jsonc", "utf8"));
const token = "db003-catalog-offline-token";
const marker = "a".repeat(64);
const tokenHash = createHash("sha256").update(token).digest("hex");
const identityNames = ["database", "currentRole", "sessionRole", "backendLogin", "postgres16",
  "readOnly", "repeatableRead", "primary", "databaseOidPresent"];
const checkNames = ["ordinaryPersistentTable", "exactSixteenColumns", "ownerIsNotApp",
  "noRowSecurity", "noTriggers", "noRules", "noInheritance", "noInboundForeignKeys",
  "idSequenceOwned", "appSelectOnly", "maintenanceCatalogDelete"];

function report() {
  return {
    databaseOid: "12345", catalogSha256: "b".repeat(64), columnCount: 16,
    identityChecks: Object.fromEntries(identityNames.map((name) => [name, true])),
    checks: Object.fromEntries(checkNames.map((name) => [name, true])),
    catalogSafe: true, controlSystemAclExecutable: false,
    originIdentityVerified: false, readyForDml: false,
  };
}
function env(expiry = Date.now() + 60_000) {
  return {
    HYPERDRIVE: { connectionString: "postgres://offline.invalid/postgres" },
    AUDIT_TOKEN_SHA256: tokenHash, AUDIT_EXPIRES_AT: String(expiry), RUN_MARKER: marker,
  } as Parameters<typeof worker.fetch>[1];
}
function request(method = "GET", path = "/audit", suppliedToken = token) {
  return new Request(`https://offline.invalid${path}`, {
    method, headers: suppliedToken ? { "X-Audit-Token": suppliedToken } : {},
  });
}
function fakeClient(closeFails = false) {
  const statements: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    statements.push(strings.join("")); return Promise.resolve([]);
  };
  const end = closeFails ? vi.fn().mockRejectedValue(new Error("private close detail")) : vi.fn();
  mock.connect.mockReturnValue({ begin: (fn: (client: typeof tx) => unknown) => fn(tx), end });
  return { statements, end };
}

beforeEach(() => { mock.connect.mockReset(); mock.catalog.mockReset(); mock.catalog.mockResolvedValue(report()); });

describe("DB-003 catalog-only one-shot audit", () => {
  it("rejects no, wrong and expired tokens before connecting", async () => {
    for (const [suppliedToken, expiry] of [["", Date.now() + 60_000],
      ["wrong", Date.now() + 60_000], [token, Date.now() - 1]] as const) {
      expect((await worker.fetch(request("GET", "/audit", suppliedToken), env(expiry))).status).toBe(403);
    }
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("rejects non-GET, query strings and other paths before connecting", async () => {
    for (const [method, path] of [["POST", "/audit"], ["GET", "/audit?sql=1"],
      ["GET", "/other"]] as const) {
      expect((await worker.fetch(request(method, path), env())).status).toBe(404);
    }
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it("uses a bounded read-only transaction and projects only fixed fields", async () => {
    const db = fakeClient();
    mock.catalog.mockResolvedValue({ ...report(), rawConfigValue: "private config value",
      connectionTarget: "private target", clusterIdentifier: "private cluster" });
    const reply = await worker.fetch(request(), env());
    const raw = await reply.text();
    expect(reply.status).toBe(200);
    expect(reply.headers.get("Cache-Control")).toContain("no-store");
    expect(raw).not.toContain("private");
    expect(JSON.parse(raw)).toMatchObject({ runMarker: marker, columnCount: 16,
      catalogSafe: true, originIdentityVerified: false, readyForDml: false });
    expect(db.statements).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(db.statements).toContain("SET LOCAL statement_timeout = '5s'");
    expect(db.statements.every((sql) => !/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(sql))).toBe(true);
    expect(db.end).toHaveBeenCalledOnce();
  });

  it("fails closed when catalog or close fails without exposing an exception", async () => {
    fakeClient();
    mock.catalog.mockRejectedValue(new Error("private query detail"));
    const queryFailure = await worker.fetch(request(), env());
    expect(queryFailure.status).toBe(500);
    expect(await queryFailure.text()).not.toContain("private");
    fakeClient(true);
    mock.catalog.mockResolvedValue(report());
    const closeFailure = await worker.fetch(request(), env());
    expect(closeFailure.status).toBe(500);
    expect(await closeFailure.text()).not.toContain("private");
  });

  it("refuses a missing catalog gate and never reports DML readiness", async () => {
    fakeClient();
    mock.catalog.mockResolvedValue({ ...report(), catalogSafe: false });
    expect((await worker.fetch(request(), env())).status).toBe(409);
    mock.catalog.mockResolvedValue({ ...report(), readyForDml: true });
    expect((await worker.fetch(request(), env())).status).toBe(500);
  });

  it("pins the reviewed app route and temporary Worker cleanup boundary", () => {
    expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "ba7faa6680cd48d4b3a1d36a7a5fc8f7" }]);
    expect(config.vars).toEqual({ AUDIT_TOKEN_SHA256: "", AUDIT_EXPIRES_AT: "", RUN_MARKER: "" });
    expect(runner).toContain("d44ef519-90ab-4864-b42f-3f0ca76890b2");
    for (const bound of ["git -C $taskRepository status --porcelain=v1", "Get-OwnedAuditVersion",
      "Assert-AppHyperdriveCacheDisabled", "$taskControlPlane404", "$taskPublic404",
      "Remove-Item -LiteralPath $taskLogPath -Force", "AddMinutes(10)", "exit 2"]) {
      expect(runner).toContain(bound);
    }
    expect(runner).not.toMatch(/\b(?:INSERT INTO|UPDATE public|DELETE FROM|ALTER TABLE|DROP TABLE|GRANT )\b/i);
    expect(runner.indexOf("Assert-CatalogReport $taskRawReport"))
      .toBeLessThan(runner.indexOf("$taskReport = ConvertTo-SafeCatalogReport $taskRawReport"));
  });

  if (process.platform === "win32") {
    it("stops before network access without credentials or exact source commit", () => {
      const script = "scripts/run-system-config-catalog-production-audit.ps1";
      const noToken = spawnSync("pwsh", ["-NoProfile", "-File", script, "-ExpectedSourceSha", "0".repeat(40)], {
        cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
      });
      expect(noToken.status).toBe(1);
      expect(noToken.stderr).toContain("Cloudflare API authentication is required");
      const wrongSource = spawnSync("pwsh", ["-NoProfile", "-File", script, "-ExpectedSourceSha", "0".repeat(40)], {
        cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "offline-placeholder" },
      });
      expect(wrongSource.status).toBe(1);
      expect(wrongSource.stderr).toContain("Reviewed source commit mismatch");
    });

    it("rejects binding and cache drift, projects only fixed fields, and requires dual 404", () => {
      const offline = String.raw`
        $tokens=$null; $errors=$null
        $ast=[System.Management.Automation.Language.Parser]::ParseFile(
          (Resolve-Path 'scripts/run-system-config-catalog-production-audit.ps1'),
          [ref]$tokens,[ref]$errors)
        if ($errors.Count) { throw 'runner parse failed' }
        foreach ($name in @('Get-OwnedAuditVersion','Assert-AppHyperdriveCacheDisabled',
          'Assert-CatalogReport','ConvertTo-SafeCatalogReport','Confirm-Dual404')) {
          $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
          if (-not $fn) { throw 'runner function missing' }
          Invoke-Expression $fn.Extent.Text
        }
        $taskMarker='a'*64; $taskTokenHash='b'*64; $taskExpiry='1791533000000'
        $taskAppHyperdrive='ba7faa6680cd48d4b3a1d36a7a5fc8f7'
        $taskTargetApi='offline-worker'; $taskAppHyperdriveApi='offline-hyperdrive'
        $taskExpectedVarValues=@{AUDIT_TOKEN_SHA256=$taskTokenHash;AUDIT_EXPIRES_AT=$taskExpiry;RUN_MARKER=$taskMarker}
        $taskExpectedAuditBindings=@(
          "HYPERDRIVE:hyperdrive:$taskAppHyperdrive",'AUDIT_TOKEN_SHA256:plain_text:',
          'AUDIT_EXPIRES_AT:plain_text:','RUN_MARKER:plain_text:') | Sort-Object
        $script:bindings=@(
          @{name='HYPERDRIVE';type='hyperdrive';id=$taskAppHyperdrive},
          @{name='AUDIT_TOKEN_SHA256';type='plain_text';text=$taskTokenHash},
          @{name='AUDIT_EXPIRES_AT';type='plain_text';text=$taskExpiry},
          @{name='RUN_MARKER';type='plain_text';text=$taskMarker})
        $script:cache=$true; $script:modified='stable'; $script:taskHyperdriveModifiedOn=$null
        function Get-FullTrafficVersion { return '11111111-1111-1111-1111-111111111111' }
        function Invoke-ControlPlane {
          param([string]$Uri)
          if ($Uri -eq $taskAppHyperdriveApi) {
            return @{result=@{id=$taskAppHyperdrive;caching=@{disabled=$script:cache};modified_on=$script:modified}}
          }
          return @{result=@{annotations=@{'workers/message'=$taskMarker};resources=@{bindings=$script:bindings}}}
        }
        $null=Get-OwnedAuditVersion
        Assert-AppHyperdriveCacheDisabled
        $script:bindings[0].id='changed'; $rejected=$false
        try { $null=Get-OwnedAuditVersion } catch { $rejected=$true }
        if (-not $rejected) { throw 'binding drift accepted' }
        $script:bindings[0].id=$taskAppHyperdrive
        $script:bindings[1].text='changed'; $rejected=$false
        try { $null=Get-OwnedAuditVersion } catch { $rejected=$true }
        if (-not $rejected) { throw 'deployed token hash drift accepted' }
        $script:bindings[1].text=$taskTokenHash
        $script:cache=$false; $rejected=$false
        try { Assert-AppHyperdriveCacheDisabled } catch { $rejected=$true }
        if (-not $rejected) { throw 'cache drift accepted' }
        $script:cache=$true; $script:modified='changed'; $rejected=$false
        try { Assert-AppHyperdriveCacheDisabled } catch { $rejected=$true }
        if (-not $rejected) { throw 'origin modification drift accepted' }

        $identity=[pscustomobject]@{database=$true;currentRole=$true;sessionRole=$true;
          backendLogin=$true;postgres16=$true;readOnly=$true;repeatableRead=$true;
          primary=$true;databaseOidPresent=$true}
        $checks=[pscustomobject]@{ordinaryPersistentTable=$true;exactSixteenColumns=$true;
          ownerIsNotApp=$true;noRowSecurity=$true;noTriggers=$true;noRules=$true;
          noInheritance=$true;noInboundForeignKeys=$true;idSequenceOwned=$true;
          appSelectOnly=$true;maintenanceCatalogDelete=$true}
        $value=[pscustomobject]@{runMarker=$taskMarker;databaseOid='12345';
          catalogSha256=('c'*64);columnCount=16;identityChecks=$identity;checks=$checks;
          catalogSafe=$true;controlSystemAclExecutable=$false;
          originIdentityVerified=$false;readyForDml=$false;rawValue='private fixture'}
        Assert-CatalogReport $value
        $safe=ConvertTo-SafeCatalogReport $value | ConvertTo-Json -Depth 12
        if ($safe -match 'private|rawValue') { throw 'response extra leaked' }
        $value.checks.noRules=$false; $rejected=$false
        try { Assert-CatalogReport $value } catch { $rejected=$true }
        if (-not $rejected) { throw 'catalog drift accepted' }

        $taskTargetApi='offline-worker'; $taskUrl='https://offline.invalid'; $taskHeaders=@{}
        $script:controlStatus=404; $script:publicStatus=404
        function Invoke-WebRequest { return @{StatusCode=$script:controlStatus} }
        function Get-PublicResponse { return @{StatusCode=$script:publicStatus} }
        Confirm-Dual404 -MaxAttempts 1 -PauseSeconds 0
        if (-not $taskControlPlane404 -or -not $taskPublic404) { throw 'dual 404 missing' }
        $script:publicStatus=200; $rejected=$false
        try { Confirm-Dual404 -MaxAttempts 1 -PauseSeconds 0 } catch { $rejected=$true }
        if (-not $rejected) { throw 'public endpoint survivor accepted' }
        'offline_runner_faults=7;projection_safe=1;dual404=1'
      `;
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", offline], {
        cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("offline_runner_faults=7;projection_safe=1;dual404=1");
    });

    it("pins full formal settings, immutable version, and deployment metadata", () => {
      const offline = String.raw`
        $tokens=$null; $errors=$null
        $ast=[System.Management.Automation.Language.Parser]::ParseFile(
          (Resolve-Path 'scripts/run-system-config-catalog-production-audit.ps1'),
          [ref]$tokens,[ref]$errors)
        if ($errors.Count) { throw 'runner parse failed' }
        foreach ($name in @('Get-HyperdriveBindings','Get-MainBindingSha','Assert-MainWorker')) {
          $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
          if (-not $fn) { throw 'formal guard missing' }
          Invoke-Expression $fn.Extent.Text
        }
        $taskMainApi='offline-main'
        $taskMainDeployment='11111111-1111-1111-1111-111111111111'
        $taskMainVersion='22222222-2222-2222-2222-222222222222'
        $app='ba7faa6680cd48d4b3a1d36a7a5fc8f7'
        $admin='446e94a4de0143f58c8e5178ec55db8b'
        $taskExpectedMainBindings=@("HYPERDRIVE:$app","HYPERDRIVE_ADMIN:$admin") | Sort-Object
        $script:bindings=@(
          @{name='HYPERDRIVE';type='hyperdrive';id=$app},
          @{name='HYPERDRIVE_ADMIN';type='hyperdrive';id=$admin})
        for ($i=0; $i -lt 29; $i++) {
          $script:bindings += @{name=('FIXTURE_{0:D2}' -f $i);type='plain_text';id=$null;
            namespace_id=$null;class_name=$null}
        }
        $projection=@($script:bindings | ForEach-Object {
          "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
        } | Sort-Object -CaseSensitive)
        $taskMainBindingSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
          [Text.Encoding]::UTF8.GetBytes(($projection -join [string][char]10)))).ToLowerInvariant()
        $script:deploymentDrift=$false; $script:versionDrift=$false
        function Invoke-ControlPlane {
          param([string]$Uri)
          if ($Uri -eq "$taskMainApi/deployments") {
            $id=if($script:deploymentDrift){'changed'}else{$taskMainDeployment}
            return @{result=@{deployments=@(@{id=$id;created_on='2026-10-10T00:00:00Z';
              versions=@(@{percentage=100;version_id=$taskMainVersion})})}}
          }
          if ($Uri -eq "$taskMainApi/settings") { return @{result=@{bindings=$script:bindings}} }
          $rows=if($script:versionDrift){ @($script:bindings | ForEach-Object { $_.Clone() }) }else{$script:bindings}
          if ($script:versionDrift) { $rows[2].id='changed' }
          return @{result=@{resources=@{bindings=$rows}}}
        }
        $good=Assert-MainWorker
        if ($good.deploymentId -cne $taskMainDeployment -or
          $good.bindingSha256 -cne $taskMainBindingSha -or
          $good.versionBindingSha256 -cne $taskMainBindingSha) { throw 'formal pass missing' }
        $script:bindings[2].id='changed'; $rejected=$false
        try { $null=Assert-MainWorker } catch { $rejected=$true }
        if (-not $rejected) { throw 'non-Hyperdrive settings drift accepted' }
        $script:bindings[2].id=$null
        $script:versionDrift=$true; $rejected=$false
        try { $null=Assert-MainWorker } catch { $rejected=$true }
        if (-not $rejected) { throw 'immutable version drift accepted' }
        $script:versionDrift=$false
        $script:deploymentDrift=$true; $rejected=$false
        try { $null=Assert-MainWorker } catch { $rejected=$true }
        if (-not $rejected) { throw 'deployment drift accepted' }
        'formal_guard_faults=3'
      `;
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", offline], {
        cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("formal_guard_faults=3");
    });

    it("bounds Wrangler timeout and output, and treats delete failure as uncertain", () => {
      const offline = String.raw`
        $tokens=$null; $errors=$null
        $ast=[System.Management.Automation.Language.Parser]::ParseFile(
          (Resolve-Path 'scripts/run-system-config-catalog-production-audit.ps1'),
          [ref]$tokens,[ref]$errors)
        if ($errors.Count) { throw 'runner parse failed' }
        $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
          $n.Name -eq 'Invoke-BoundedWrangler'},$true)
        if (-not $fn) { throw 'bounded CLI missing' }
        Invoke-Expression $fn.Extent.Text
        $taskRoot=(Resolve-Path '.').Path
        $taskOutputRoot=Join-Path $taskRoot '.cache/db003-bounded-offline'
        $null=New-Item -ItemType Directory -Force -Path $taskOutputRoot
        $taskName='db003-offline-fixture'; $taskCli='offline-wrangler.js'
        $taskUrl='https://offline.invalid'; $taskDeployDiagnostic=[ordered]@{outcome='not-started';exitCode='unobserved'}
        $taskProcessTreeUncertain=$false; $taskCliOutputCleanupFailed=$false
        $script:mode='success'; $script:waitCalls=0; $script:killed=$false
        function Start-Process {
          param($FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,
            $RedirectStandardError,$WindowStyle,[switch]$PassThru)
          $stdout=if($script:mode -eq 'success'){$taskUrl}else{''}
          $stderr=if($script:mode -eq 'oversize'){'x'*65537}else{''}
          [IO.File]::WriteAllText($RedirectStandardOutput,$stdout)
          [IO.File]::WriteAllText($RedirectStandardError,$stderr)
          $exit=if($script:mode -eq 'delete-failed'){1}else{0}
          $p=[pscustomobject]@{ExitCode=$exit}
          $p | Add-Member ScriptMethod WaitForExit {
            param($milliseconds)
            $script:waitCalls++
            if ($script:mode -eq 'timeout' -and $script:waitCalls -eq 1) { return $false }
            return $true
          }
          $p | Add-Member ScriptMethod Kill { param($entireProcessTree) $script:killed=$true }
          $p | Add-Member ScriptMethod Dispose { }
          return $p
        }
        if (-not (Invoke-BoundedWrangler -Operation deploy -Arguments @('--config','offline'))) {
          throw 'fixed URL not accepted'
        }
        $script:mode='oversize'; $rejected=$false
        try { $null=Invoke-BoundedWrangler -Operation deploy -Arguments @('--config','offline') }
        catch { $rejected=$true }
        if (-not $rejected -or $taskDeployDiagnostic.outcome -cne 'output-oversize') {
          throw 'oversize output accepted'
        }
        $script:mode='timeout'; $script:waitCalls=0; $rejected=$false
        try { $null=Invoke-BoundedWrangler -Operation deploy -Arguments @('--config','offline') -TimeoutMs 100 }
        catch { $rejected=$true }
        if (-not $rejected -or -not $taskProcessTreeUncertain -or -not $script:killed) {
          throw 'timeout process uncertainty accepted'
        }
        $script:mode='delete-failed'; $rejected=$false
        try { $null=Invoke-BoundedWrangler -Operation delete -Arguments @('offline') }
        catch { $rejected=$true }
        if (-not $rejected) { throw 'delete failure accepted' }
        $script:mode='oversize'; $rejected=$false
        try { $null=Invoke-BoundedWrangler -Operation delete -Arguments @('offline') }
        catch { $rejected=$true }
        if (-not $rejected) { throw 'delete output bound missing' }
        if ($taskCliOutputCleanupFailed -or @(Get-ChildItem -LiteralPath $taskOutputRoot -File).Count -ne 0) {
          throw 'owned output not deleted'
        }
        $script:mode='success'
        function Remove-Item { throw 'offline simulated cleanup denial' }
        $rejected=$false
        try { $null=Invoke-BoundedWrangler -Operation deploy -Arguments @('--config','offline') }
        catch { $rejected=$true }
        if (-not $taskCliOutputCleanupFailed) { throw 'cleanup uncertainty accepted' }
        Get-ChildItem -LiteralPath $taskOutputRoot -File | ForEach-Object {
          Microsoft.PowerShell.Management\Remove-Item -LiteralPath $_.FullName -Force
        }
        'bounded_cli_faults=5;owned_output_deleted=1'
      `;
      const result = spawnSync("pwsh", ["-NoProfile", "-Command", offline], {
        cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("bounded_cli_faults=5;owned_output_deleted=1");
    });
  }
});
