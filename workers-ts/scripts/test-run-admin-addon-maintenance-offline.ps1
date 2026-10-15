# Offline behavioral checks: the exact runner is copied into an isolated fixture
# repository and executed in a fresh PowerShell process. Git, Wrangler and every
# HTTP endpoint are mocked; no network connection or database access is possible.
[CmdletBinding()]
param(
    [string]$Scenario = 'all',
    [switch]$Child,
    [string]$FixtureRoot,
    [string]$TracePath
)
$ErrorActionPreference = 'Stop'
$taskCases = @(
    'inspect-v2','inspect-v3','apply-v2','apply-v3',
    'mode-neither','mode-both','phase-case-drift','apply-no-fingerprint','inspect-with-fingerprint',
    'source-mismatch','source-dirty','config-main-drift','config-binding-drift',
    'config-armed','config-route','formal-version-drift','formal-settings-drift',
    'formal-version-bindings-drift','hyperdrive-cache-enabled','hyperdrive-route-drift',
    'hyperdrive-service-id-only','hyperdrive-service-id-drift',
    'hyperdrive-login-drift','inventory-incomplete','foreign-prefix','foreign-target',
    'deploy-nonzero','deploy-url-missing','preflight-not-ready','preflight-secondary',
    'preflight-source-drift','preflight-primary-drift','preflight-approval-drift',
    'preflight-get-transient','apply-response-lost','apply-http-503',
    'apply-json-invalid','apply-no-store-missing','apply-commit-unconfirmed',
    'apply-protected-data-changed','postflight-addon-drift','cleanup-marker-drift',
    'cleanup-variable-drift','cleanup-binding-drift','cleanup-version-drift',
    'cleanup-ownership-unavailable','delete-nonzero','control-404-unavailable',
    'public-404-unavailable','cleanup-prefix-remains','formal-postflight-drift',
    'hyperdrive-postflight-drift','hyperdrive-modified-on-drift','hyperdrive-modified-on-microsecond-drift','safe-worker-error','deploy-deadline',
    'deploy-output-oversize','delete-deadline','cli-output-cleanup-failed',
    'actual-stderr-url','actual-output-oversize','actual-running-oversize',
    'actual-cli-nonzero','actual-url-missing'
)
if ($Scenario -cne 'all' -and $taskCases -cnotcontains $Scenario) { throw 'Unknown offline scenario.' }
$taskRunner = Join-Path $PSScriptRoot 'run-admin-addon-maintenance.ps1'

function Assert-Offline {
    param([bool]$Condition,[string]$Message)
    if (-not $Condition) { throw $Message }
}

function Test-ActualBoundedWrapper {
    param([string]$Case,[string]$LocalFixture,[string]$RunnerPath)
    $taskSource = Get-Content -LiteralPath $RunnerPath -Raw
    $taskTokens = $null
    $taskErrors = $null
    $taskAst = [Management.Automation.Language.Parser]::ParseInput($taskSource,[ref]$taskTokens,[ref]$taskErrors)
    $taskFunctions = @($taskAst.FindAll({ param($AstNode) $AstNode -is [Management.Automation.Language.FunctionDefinitionAst] -and $AstNode.Name -ceq 'Invoke-BoundedWrangler' },$true))
    Assert-Offline (@($taskErrors).Count -eq 0 -and $taskFunctions.Count -eq 1) 'The bounded CLI function cannot be extracted.'
    . ([ScriptBlock]::Create($taskFunctions[0].Extent.Text))
    $taskRoot = $LocalFixture
    $taskReceiptDir = $LocalFixture
    $taskCli = Join-Path $LocalFixture 'inert-process.js'
    $taskPidFile = Join-Path $LocalFixture 'inert-process.pid'
    $taskExpectedPublicUrl = 'https://cinashop-aao-v2-maint-0000000000000000.cinagroup.workers.dev'
    $script:taskCliDiagnostics = @{ deploy = [ordered]@{ outcome = 'not-started'; exitCode = $null }; delete = [ordered]@{ outcome = 'not-started'; exitCode = $null } }
    $script:taskProcessTreeUncertain = $false
    $script:taskCliOutputCleanupFailed = $false
    $taskFixtureJs = @'
const fs = require('node:fs');
const scenario = process.argv[3];
fs.writeFileSync(process.argv[4], String(process.pid));
if (scenario === 'actual-stderr-url') {
  process.stderr.write('synthetic-private-cli-log https://cinashop-aao-v2-maint-0000000000000000.cinagroup.workers.dev');
} else if (scenario === 'actual-output-oversize') {
  process.stderr.write('x'.repeat(65537) + 'synthetic-private-cli-log');
} else if (scenario === 'actual-running-oversize') {
  process.stdout.write('x'.repeat(65537) + 'synthetic-private-cli-log');
  setInterval(() => {}, 1000);
} else if (scenario === 'actual-cli-nonzero') {
  process.stderr.write('private-connection-or-sql synthetic-private-token');
  process.exitCode = 1;
} else if (scenario === 'actual-url-missing') {
  process.stdout.write('https://unexpected.invalid synthetic-private-cli-log');
} else throw new Error('Unexpected inert fixture scenario');
'@
    [IO.File]::WriteAllText($taskCli,$taskFixtureJs)
    $taskThrew = $false
    $taskConfirmed = $false
    $taskExceptionMessage = $null
    try { $taskConfirmed = Invoke-BoundedWrangler -Operation deploy -Arguments @($Case,('"' + $taskPidFile + '"')) }
    catch {
        $taskThrew = $true
        Assert-Offline (-not ($_.Exception.Message -match 'synthetic-private-token|private-connection-or-sql|synthetic-private-cli-log')) 'The bounded CLI exception exposed raw process output.'
        $taskExceptionMessage = $_.Exception.Message
    }
    $taskExpectedOutcome = switch ($Case) { 'actual-stderr-url' { 'url-confirmed' }; 'actual-url-missing' { 'url-missing' }; 'actual-cli-nonzero' { 'cli-nonzero' }; default { 'output-oversize' } }
    Assert-Offline ($script:taskCliDiagnostics.deploy.outcome -ceq $taskExpectedOutcome) "$Case process result classification differs ($($script:taskCliDiagnostics.deploy.outcome)): $taskExceptionMessage"
    Assert-Offline ($taskConfirmed -eq ($Case -ceq 'actual-stderr-url')) "$Case accepted or rejected the wrong public URL."
    Assert-Offline ($taskThrew -eq ($Case -in @('actual-cli-nonzero','actual-output-oversize','actual-running-oversize'))) "$Case exception behavior differs."
    Assert-Offline ($script:taskProcessTreeUncertain -eq ($Case -ceq 'actual-running-oversize')) "$Case lost process tree uncertainty."
    Assert-Offline (-not $script:taskCliOutputCleanupFailed -and @(Get-ChildItem -LiteralPath $LocalFixture -File -Filter '*.stdout').Count -eq 0 -and @(Get-ChildItem -LiteralPath $LocalFixture -File -Filter '*.stderr').Count -eq 0) "$Case left private process output."
    Assert-Offline (Test-Path -LiteralPath $taskPidFile) "$Case did not start its inert local process."
    $taskRecordedPid = [int](Get-Content -LiteralPath $taskPidFile -Raw)
    Assert-Offline ($null -eq (Get-Process -Id $taskRecordedPid -ErrorAction SilentlyContinue)) "$Case left its local Node process running."
}

if (-not $Child) {
    $taskRepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $taskFixtureBase = Join-Path $taskRepositoryRoot '.cache'
    $null = New-Item -ItemType Directory -Path $taskFixtureBase -Force
    $taskSelected = if ($Scenario -ceq 'all') { $taskCases } else { @($Scenario) }
    $taskPassed = 0
    foreach ($taskCase in $taskSelected) {
        $taskFixture = Join-Path $taskFixtureBase ('admin-addon-offline-' + [Guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path (Join-Path $taskFixture 'workers-ts/scripts') -Force
        $null = New-Item -ItemType Directory -Path (Join-Path $taskFixture 'workers-ts/test/integration') -Force
        $null = New-Item -ItemType Directory -Path (Join-Path $taskFixture 'workers-ts/node_modules/wrangler/bin') -Force
        $taskTrace = Join-Path $taskFixture 'calls.txt'
        try {
            Copy-Item -LiteralPath $taskRunner -Destination (Join-Path $taskFixture 'workers-ts/scripts/run-admin-addon-maintenance.ps1')
            foreach ($taskConfig in @('admin-authority-v2-maintenance.wrangler.jsonc','admin-legacy-role-maintenance.wrangler.jsonc')) {
                Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../test/integration/$taskConfig") -Destination (Join-Path $taskFixture "workers-ts/test/integration/$taskConfig")
            }
            [IO.File]::WriteAllText((Join-Path $taskFixture 'workers-ts/node_modules/wrangler/bin/wrangler.js'),'// inert fixture; mocked node never executes this file')
            [IO.File]::WriteAllText((Join-Path $taskFixture 'workers-ts/node_modules/wrangler/package.json'),'{"version":"4.131.0"}')
            if ($taskCase -like 'actual-*') {
                Test-ActualBoundedWrapper -Case $taskCase -LocalFixture $taskFixture -RunnerPath $taskRunner
                "$taskCase`: pass"
                $taskPassed++
                continue
            }
            $taskOutput = @(& pwsh -NoProfile -File $PSCommandPath -Scenario $taskCase -Child -FixtureRoot $taskFixture -TracePath $taskTrace 2>&1)
            $taskExit = $LASTEXITCODE
            $taskOutputText = $taskOutput -join [char]10
            $taskCalls = if (Test-Path -LiteralPath $taskTrace) { @(Get-Content -LiteralPath $taskTrace) } else { @() }
            $taskDeploys = @($taskCalls | Where-Object { $_ -ceq 'deploy-owned' }).Count
            $taskDeletes = @($taskCalls | Where-Object { $_ -ceq 'delete-owned' }).Count
            $taskApplyPosts = @($taskCalls | Where-Object { $_ -ceq 'apply-authorized' }).Count
            $taskBoundaryPosts = @($taskCalls | Where-Object { $_ -ceq 'apply-without-operation' }).Count
            $taskPreflightGets = @($taskCalls | Where-Object { $_ -ceq 'preflight-authenticated' }).Count
            $taskPostflightGets = @($taskCalls | Where-Object { $_ -ceq 'postflight-authenticated' }).Count
            $taskReceiptFiles = @(Get-ChildItem -LiteralPath (Join-Path $taskFixture '.cache') -Recurse -Filter receipt.json -File -ErrorAction SilentlyContinue)
            $taskEarlyFailure = $taskCase -in @('mode-neither','mode-both','phase-case-drift','apply-no-fingerprint','inspect-with-fingerprint',
                'source-mismatch','source-dirty','config-main-drift','config-binding-drift','config-armed','config-route')
            Assert-Offline (-not ($taskOutputText -match 'synthetic-private-token|private-connection-or-sql|private\.database\.invalid|synthetic-private-cli-log')) "$taskCase leaked private data on stdout/stderr."
            if ($taskEarlyFailure) {
                Assert-Offline ($taskExit -eq 1 -and $taskDeploys -eq 0 -and $taskDeletes -eq 0 -and $taskApplyPosts -eq 0 -and $taskCalls.Count -eq 0 -and $taskReceiptFiles.Count -eq 0) "$taskCase did not stop before HTTP and deployment (exit $taskExit, calls $($taskCalls.Count), receipts $($taskReceiptFiles.Count)). Child output: $taskOutputText"
                "$taskCase`: pass"
                $taskPassed++
                continue
            }
            Assert-Offline ($taskReceiptFiles.Count -eq 1) "$taskCase did not emit exactly one receipt (exit $taskExit). Child output: $taskOutputText"
            $taskReceiptText = Get-Content -LiteralPath $taskReceiptFiles[0].FullName -Raw
            $taskReceipt = $taskReceiptText | ConvertFrom-Json -Depth 40 -DateKind String
            Assert-Offline (-not ($taskReceiptText -match 'synthetic-private-token|private-connection-or-sql|private\.database\.invalid|synthetic-private-cli-log')) "$taskCase leaked private data in its receipt."
            Assert-Offline ($taskReceipt.cleanup.ownedLogRemoved -eq $true -and @(Get-ChildItem -LiteralPath $taskFixture -Filter '*wrangler*.log' -Recurse -File).Count -eq 0) "$taskCase left its owned Wrangler log."
            Assert-Offline ($taskApplyPosts -le 1) "$taskCase retried a mutation POST."
            if ($taskCase -in @('inspect-v2','inspect-v3','apply-v2','apply-v3','preflight-get-transient','hyperdrive-service-id-only')) {
                Assert-Offline ($taskExit -eq 0 -and $taskReceipt.stage -ceq 'completed' -and -not $taskReceipt.failure -and $taskDeploys -eq 1 -and $taskDeletes -eq 1) "$taskCase success was not confirmed."
                Assert-Offline ($taskReceipt.cleanup.ownershipVerified -eq $true -and $taskReceipt.cleanup.controlPlaneMissing -eq $true -and $taskReceipt.cleanup.publicMissing -eq $true -and $taskReceipt.cleanup.temporaryPrefixesMissing -eq $true -and $taskReceipt.formalControlPlaneUnchanged -eq $true) "$taskCase accepted incomplete cleanup or formal drift."
                $taskExpectedApply = if ($taskCase -like 'apply-*') { 1 } else { 0 }
                Assert-Offline ($taskApplyPosts -eq $taskExpectedApply -and $taskBoundaryPosts -eq 1) "$taskCase did not distinguish the inert access POST from the authorized apply POST."
                if ($taskExpectedApply -eq 0) {
                    Assert-Offline ($null -eq $taskReceipt.apply -and $null -eq $taskReceipt.postflight -and $taskPostflightGets -eq 0 -and $taskReceipt.mode -ceq 'inspect-only') "$taskCase performed apply work during inspect-only mode."
                } else {
                    Assert-Offline ($taskReceipt.apply.committed -eq $true -and $taskPostflightGets -eq 1 -and $taskReceipt.postflight.maintenance.addon -ceq $(if ($taskCase -ceq 'apply-v3') { 'legacy-role-v3' } else { 'legacy-admin-v2' })) "$taskCase lacks independent addon postflight."
                }
                if ($taskCase -ceq 'preflight-get-transient') { Assert-Offline ($taskPreflightGets -eq 3) 'Read-only transient GET did not retry safely.' }
                if ($taskCase -ceq 'hyperdrive-service-id-only') {
                    $taskExpectedServiceRouteSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('postgres||5432|synthetic-vpc-service|postgres'))).ToLowerInvariant()
                    Assert-Offline ($taskReceipt.hyperdriveBefore.Count -eq 3 -and @($taskReceipt.hyperdriveBefore | Where-Object { $_.routeSha256 -cne $taskExpectedServiceRouteSha }).Count -eq 0) 'The service_id-only route was not fingerprinted for all three LOGINs.'
                }
            } else {
                Assert-Offline ($taskExit -eq 2 -and [bool]$taskReceipt.failure) "$taskCase incorrectly succeeded."
                $taskBeforeDeploy = $taskCase -in @('formal-version-drift','formal-settings-drift','formal-version-bindings-drift',
                    'hyperdrive-cache-enabled','hyperdrive-route-drift','hyperdrive-service-id-drift','hyperdrive-login-drift','inventory-incomplete','foreign-prefix','foreign-target')
                if ($taskBeforeDeploy) {
                    Assert-Offline ($taskDeploys -eq 0 -and $taskDeletes -eq 0 -and $taskApplyPosts -eq 0 -and $taskReceipt.cleanup.attempted -eq $false) "$taskCase deployed or deleted despite preflight drift."
                } else {
                    Assert-Offline ($taskDeploys -eq 1) "$taskCase deployment attempt count differs."
                    $taskUnowned = $taskCase -in @('cleanup-marker-drift','cleanup-variable-drift','cleanup-binding-drift','cleanup-version-drift','cleanup-ownership-unavailable')
                    if ($taskCase -in @('deploy-deadline','deploy-output-oversize')) {
                        Assert-Offline ($taskDeletes -eq 0 -and $taskReceipt.cleanup.processTreeUncertain -eq $true -and $taskReceipt.cleanup.deleted -eq $false) "$taskCase deleted a target after process tree uncertainty."
                    } elseif ($taskCase -ceq 'delete-deadline') {
                        Assert-Offline ($taskDeletes -eq 1 -and $taskReceipt.cleanup.processTreeUncertain -eq $true -and $taskReceipt.cleanup.deleted -eq $false) 'A timed out delete was accepted.'
                    } elseif ($taskUnowned) {
                        Assert-Offline ($taskDeletes -eq 0 -and $taskReceipt.cleanup.deleted -eq $false -and $taskReceipt.cleanup.controlPlaneMissing -eq $false) "$taskCase deleted a target without current ownership proof."
                    } elseif ($taskCase -ceq 'delete-nonzero') {
                        Assert-Offline ($taskDeletes -eq 1 -and $taskReceipt.cleanup.deleted -eq $false -and $taskReceipt.cleanup.controlPlaneMissing -eq $false) 'Unconfirmed delete was accepted.'
                    } else {
                        Assert-Offline ($taskDeletes -eq 1 -and $taskReceipt.cleanup.deleted -eq $true) "$taskCase did not clean its owned target."
                        if ($taskCase -ceq 'control-404-unavailable') {
                            Assert-Offline ($taskReceipt.cleanup.controlPlaneMissing -eq $false -and $taskReceipt.cleanup.publicMissing -eq $false) 'Missing control-plane 404 was accepted.'
                        } elseif ($taskCase -ceq 'public-404-unavailable') {
                            Assert-Offline ($taskReceipt.cleanup.controlPlaneMissing -eq $true -and $taskReceipt.cleanup.publicMissing -eq $false) 'Missing public 404 was accepted.'
                        } elseif ($taskCase -ceq 'cleanup-prefix-remains') {
                            Assert-Offline ($taskReceipt.cleanup.controlPlaneMissing -eq $true -and $taskReceipt.cleanup.publicMissing -eq $true -and $taskReceipt.cleanup.temporaryPrefixesMissing -eq $false) 'Incomplete prefix inventory was accepted.'
                        } else {
                            Assert-Offline ($taskReceipt.cleanup.controlPlaneMissing -eq $true -and $taskReceipt.cleanup.publicMissing -eq $true -and $taskReceipt.cleanup.temporaryPrefixesMissing -eq $true) "$taskCase lacks dual 404 and prefix cleanup."
                        }
                    }
                    $taskMutatingCases = @('apply-response-lost','apply-http-503','apply-json-invalid','apply-no-store-missing','apply-commit-unconfirmed','apply-protected-data-changed','postflight-addon-drift','safe-worker-error')
                    $taskExpectedApply = if ($taskMutatingCases -ccontains $taskCase) { 1 } else { 0 }
                    Assert-Offline ($taskApplyPosts -eq $taskExpectedApply) "$taskCase mutation POST count differs."
                    if ($taskMutatingCases -ccontains $taskCase) {
                        Assert-Offline ($taskPostflightGets -eq 1) "$taskCase did not inspect read-only after the single apply."
                    }
                    if ($taskCase -in @('formal-postflight-drift','hyperdrive-postflight-drift','hyperdrive-modified-on-drift','hyperdrive-modified-on-microsecond-drift')) {
                        Assert-Offline ($taskReceipt.formalControlPlaneUnchanged -eq $false) "$taskCase did not detect formal control-plane drift."
                    }
                    if ($taskCase -ceq 'hyperdrive-modified-on-microsecond-drift') {
                        Assert-Offline ($taskReceipt.hyperdriveBefore.Count -eq 3 -and $taskReceipt.hyperdriveAfter.Count -eq 3 -and @($taskReceipt.hyperdriveBefore | Where-Object { $_.modifiedOn -cne '2026-10-11T00:00:00.000001Z' }).Count -eq 0 -and @($taskReceipt.hyperdriveAfter | Where-Object { $_.modifiedOn -cne '2026-10-11T00:00:00.000002Z' }).Count -eq 0) 'Exact same-second microsecond modification pins were lost.'
                    }
                    if ($taskCase -ceq 'cli-output-cleanup-failed') { Assert-Offline ($taskReceipt.cleanup.ownedOutputRemoved -eq $false) 'Owned CLI output cleanup failure was accepted.' }
                    if ($taskCase -ceq 'safe-worker-error') {
                        Assert-Offline ($taskReceipt.httpFailures.Count -eq 1 -and $taskReceipt.httpFailures[0].httpStatus -eq 503 -and $taskReceipt.httpFailures[0].error -ceq 'outcome unconfirmed; inspect read-only before any further action' -and $taskReceipt.httpFailures[0].stage -ceq 'single_apply' -and $taskReceipt.httpFailures[0].sqlState -ceq '55P03') 'Worker failure receipt lost allowlisted diagnostics.'
                    }
                }
            }
            "$taskCase`: pass"
            $taskPassed++
        } finally {
            # Never delete outside the exact fixture created by this harness.
            $taskResolvedFixture = [IO.Path]::GetFullPath($taskFixture)
            $taskResolvedBase = [IO.Path]::GetFullPath($taskFixtureBase).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
            if (-not $taskResolvedFixture.StartsWith($taskResolvedBase,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $taskResolvedFixture) -notmatch '^admin-addon-offline-[0-9a-f]{32}$') { throw 'Unsafe offline fixture cleanup path.' }
            if (Test-Path -LiteralPath $taskResolvedFixture) { Remove-Item -LiteralPath $taskResolvedFixture -Recurse -Force }
        }
    }
    "$taskPassed/$($taskSelected.Count) offline scenarios passed; no network or database calls."
    exit 0
}

if (-not $FixtureRoot -or -not $TracePath) { throw 'Child mode requires an isolated fixture and trace.' }
$taskFixtureRunner = Join-Path $FixtureRoot 'workers-ts/scripts/run-admin-addon-maintenance.ps1'
$taskPhase = if ($Scenario -in @('inspect-v3','apply-v3')) { 'LegacyRoleV3' } else { 'AuthorityV2' }
$taskApplyMode = $Scenario -in @('apply-v2','apply-v3','apply-no-fingerprint','preflight-approval-drift',
    'apply-response-lost','apply-http-503','apply-json-invalid','apply-no-store-missing',
    'apply-commit-unconfirmed','apply-protected-data-changed','postflight-addon-drift','safe-worker-error')
$taskPhaseConfig = if ($taskPhase -ceq 'AuthorityV2') { 'admin-authority-v2-maintenance.wrangler.jsonc' } else { 'admin-legacy-role-maintenance.wrangler.jsonc' }
$taskConfigPath = Join-Path $FixtureRoot "workers-ts/test/integration/$taskPhaseConfig"
$taskFixtureConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
switch ($Scenario) {
    'config-main-drift' { $taskFixtureConfig.main = 'UnexpectedWorker.ts' }
    'config-binding-drift' { $taskFixtureConfig.hyperdrive[0].id = '0' * 32 }
    'config-armed' { $taskFixtureConfig.vars.APPLY_ARMED = 'true' }
    'config-route' { $taskFixtureConfig | Add-Member -NotePropertyName routes -NotePropertyValue @('unexpected.invalid/*') }
}
($taskFixtureConfig | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
$env:CLOUDFLARE_API_TOKEN = 'synthetic-private-token'
$script:fixtureSourceSha = 'a' * 40
$script:fixtureSqlSha = 'b' * 64
$script:fixtureApproval = 'c' * 64
$script:fixtureOrigin = 'd' * 64
$script:fixtureMainVersion = 'd44ef519-90ab-4864-b42f-3f0ca76890b2'
$script:fixtureOwnedVersion = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$script:fixtureChangedVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$script:fixtureDeployed = $false
$script:fixtureName = $null
$script:fixtureVariables = @{}
$script:fixtureMarker = $null
$script:fixtureFormalReads = 0
$script:fixtureTemporaryReads = 0
$script:fixtureHyperdriveReads = 0
$script:fixtureInventoryReads = 0
$script:fixturePreflightReads = 0
$script:fixturePostflightReads = 0
$script:fixtureBindings = @(
    @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' },
    @{ name = 'HYPERDRIVE_ADMIN'; type = 'hyperdrive'; id = '446e94a4de0143f58c8e5178ec55db8b' }
)
for ($taskIndex = 1; $taskIndex -le 29; $taskIndex++) { $script:fixtureBindings += @{ name = ('SAFE_{0:D2}' -f $taskIndex); type = 'plain_text' } }
[string[]]$taskBindingProjection = @($script:fixtureBindings | ForEach-Object { '{0}:{1}:{2}:{3}:{4}' -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name })
[Array]::Sort($taskBindingProjection,[StringComparer]::Ordinal)
$taskBindingSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($taskBindingProjection -join [char]10)))).ToLowerInvariant()

function Write-Trace { param([string]$Value) Add-Content -LiteralPath $TracePath -Value $Value }
function git {
    $CommandArgs = @($args)
    if ($CommandArgs.Count -ne 4 -or $CommandArgs[0] -cne '-C' -or $CommandArgs[1] -cne $FixtureRoot) { throw 'Unexpected mock git call.' }
    $global:LASTEXITCODE = 0
    if ($CommandArgs[2] -ceq 'rev-parse' -and $CommandArgs[3] -ceq 'HEAD') {
        if ($Scenario -ceq 'source-mismatch') { return ('e' * 40) }
        return $script:fixtureSourceSha
    }
    if ($CommandArgs[2] -ceq 'status' -and $CommandArgs[3] -ceq '--porcelain=v1') {
        if ($Scenario -ceq 'source-dirty') { return ' M protected-admin.ts' }
        return
    }
    throw 'Unexpected mock git operation.'
}
function Start-Sleep { param([int]$Seconds) Write-Trace "get-delay-$Seconds" }
function New-Response {
    param([int]$Status,[object]$Body=$null,[bool]$NoStore=$true)
    [pscustomobject]@{ StatusCode = $Status; Content = if ($null -eq $Body) { '' } else { $Body | ConvertTo-Json -Depth 40 -Compress }; Headers = if ($NoStore) { @{ 'Cache-Control' = @('no-store') } } else { @{} } }
}
function New-ApiResponse { param([object]$Result) New-Response -Status 200 -Body @{ success = $true; result = $Result } }
function New-Preflight {
    param([bool]$Postflight=$false)
    $taskAddon = if ($Postflight) { if ($taskPhase -ceq 'LegacyRoleV3') { 'legacy-role-v3' } else { 'legacy-admin-v2' } } else { 'none' }
    if ($Postflight -and $Scenario -ceq 'postflight-addon-drift') { $taskAddon = 'unexpected-addon' }
    $taskRoleEvidence = @{ ready = $true; identity = @{ primary = $true; originSha256 = $script:fixtureOrigin }; addon = $taskAddon }
    $taskEvidence = @{
        operation = if ($taskPhase -ceq 'AuthorityV2') { 'admin-authority-install-v1-and-legacy-v2' } else { 'admin-legacy-role-install-v3' }
        ready = $true; sourceSha = $script:fixtureSourceSha; installSqlSha256 = $script:fixtureSqlSha
        runMarker = $script:fixtureMarker; applyArmed = $taskApplyMode; fingerprint = $script:fixtureApproval
        target = @{ database = 'postgres'; maintenance = 'postgres'; app = 'cinashop_app_v1'; admin = 'cinashop_admin_v1' }
        maintenance = $taskRoleEvidence; app = @{ ready = $true; identity = @{ primary = $true; originSha256 = $script:fixtureOrigin } }
        admin = @{ ready = $true; identity = @{ primary = $true; originSha256 = $script:fixtureOrigin } }
    }
    if (-not $Postflight) {
        switch ($Scenario) {
            'preflight-not-ready' { $taskEvidence.ready = $false }
            'preflight-secondary' { $taskEvidence.app.identity.primary = $false }
            'preflight-source-drift' { $taskEvidence.sourceSha = 'e' * 40 }
            'preflight-primary-drift' { $taskEvidence.admin.identity.originSha256 = 'e' * 64 }
            'preflight-approval-drift' { $taskEvidence.fingerprint = 'e' * 64 }
        }
    }
    return $taskEvidence
}
function Invoke-WebRequest {
    param([string]$Uri,[string]$Method='Get',[hashtable]$Headers,[switch]$SkipHttpErrorCheck,[int]$TimeoutSec)
    if ($Method -cne 'Get' -and $Method -cne 'Post') { throw 'Unexpected mock HTTP method.' }
    if ($Uri -match '/workers/scripts/cinashop-api/deployments$') {
        Write-Trace 'formal-deployments-read'
        $script:fixtureFormalReads++
        $taskVersion = if ($Scenario -ceq 'formal-version-drift' -or ($Scenario -ceq 'formal-postflight-drift' -and $script:fixtureFormalReads -gt 1)) { $script:fixtureChangedVersion } else { $script:fixtureMainVersion }
        return New-ApiResponse @{ deployments = @(@{ id = 'formal-fixed-deployment'; created_on = '2026-10-11T00:00:00Z'; versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/(settings|versions/d44ef519-90ab-4864-b42f-3f0ca76890b2)$') {
        Write-Trace 'formal-bindings-read'
        $taskSuffix = $Matches[1]
        $taskBindings = $script:fixtureBindings
        if (($Scenario -ceq 'formal-settings-drift' -and $taskSuffix -ceq 'settings') -or ($Scenario -ceq 'formal-version-bindings-drift' -and $taskSuffix -cne 'settings')) {
            $taskBindings = @($script:fixtureBindings | ForEach-Object { if ($_.name -ceq 'SAFE_01') { @{ name = 'DRIFT'; type = 'plain_text' } } else { $_ } })
        }
        if ($taskSuffix -ceq 'settings') { return New-ApiResponse @{ bindings = $taskBindings } }
        return New-ApiResponse @{ resources = @{ bindings = $taskBindings } }
    }
    if ($Uri -match '/hyperdrive/configs/(?<id>[0-9a-f]{32})$') {
        Write-Trace 'hyperdrive-read'
        $script:fixtureHyperdriveReads++
        $taskId = $Matches.id
        $taskUser = switch ($taskId) { '9748c294e21c49a99579c9cef70102e0' { 'postgres' }; 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' { 'cinashop_app_v1' }; '446e94a4de0143f58c8e5178ec55db8b' { 'cinashop_admin_v1' }; default { throw 'Unexpected Hyperdrive ID.' } }
        $taskHost = if ($Scenario -ceq 'hyperdrive-route-drift' -and $taskUser -ceq 'cinashop_admin_v1') { 'other.private.database.invalid' } else { 'private.database.invalid' }
        $taskCacheDisabled = $Scenario -cne 'hyperdrive-cache-enabled' -and -not ($Scenario -ceq 'hyperdrive-postflight-drift' -and $script:fixtureHyperdriveReads -gt 3)
        if ($Scenario -ceq 'hyperdrive-login-drift') { $taskUser = 'unexpected_login' }
        $taskModifiedOn = if ($Scenario -ceq 'hyperdrive-modified-on-drift' -and $script:fixtureHyperdriveReads -gt 3) { '2026-10-11T01:00:00.000001Z' }
            elseif ($Scenario -ceq 'hyperdrive-modified-on-microsecond-drift' -and $script:fixtureHyperdriveReads -gt 3) { '2026-10-11T00:00:00.000002Z' }
            else { '2026-10-11T00:00:00.000001Z' }
        $taskOrigin = @{ database = 'postgres'; user = $taskUser; scheme = 'postgres'; host = $taskHost; port = 5432 }
        if ($Scenario -in @('hyperdrive-service-id-only','hyperdrive-service-id-drift')) {
            $taskServiceId = if ($Scenario -ceq 'hyperdrive-service-id-drift' -and $taskUser -ceq 'cinashop_admin_v1') { 'synthetic-vpc-other' } else { 'synthetic-vpc-service' }
            $taskOrigin = @{ database = 'postgres'; user = $taskUser; scheme = 'postgres'; service_id = $taskServiceId; port = 5432 }
        }
        return New-ApiResponse @{ id = $taskId; modified_on = $taskModifiedOn; origin = $taskOrigin; caching = @{ disabled = $taskCacheDisabled } }
    }
    if ($Uri -match '/workers/scripts$') {
        Write-Trace 'worker-inventory-read'
        $script:fixtureInventoryReads++
        $taskInventory = @(@{ id = 'cinashop-api' })
        if ($Scenario -ceq 'foreign-prefix' -or ($Scenario -ceq 'cleanup-prefix-remains' -and $script:fixtureInventoryReads -gt 1)) { $taskInventory += @{ id = 'cinashop-aao-v3-maint-foreign' } }
        $taskCount = $taskInventory.Count
        if ($Scenario -ceq 'inventory-incomplete') { $taskCount++ }
        return New-Response -Status 200 -Body @{ success = $true; result = $taskInventory; result_info = @{ total_count = $taskCount } }
    }
    if ($Uri -match '/workers/scripts/(?<name>cinashop-aao-v[23]-maint-[0-9a-f]{16})(?<suffix>/.*)?$') {
        $taskSuffix = $Matches.suffix
        if (-not $taskSuffix) {
            Write-Trace 'temporary-presence-read'
            if ($Scenario -ceq 'foreign-target') { return New-Response -Status 200 }
            if ($script:fixtureDeployed) { return New-Response -Status 200 }
            if ($script:fixtureName -and $Scenario -ceq 'control-404-unavailable') { return New-Response -Status 503 }
            return New-Response -Status 404
        }
        if (-not $script:fixtureDeployed) { throw 'Mock queried an absent temporary Worker.' }
        if ($taskSuffix -ceq '/deployments') {
            Write-Trace 'temporary-deployment-read'
            $script:fixtureTemporaryReads++
            $taskVersion = if ($Scenario -ceq 'cleanup-version-drift' -and $script:fixtureTemporaryReads -gt 1) { $script:fixtureChangedVersion } else { $script:fixtureOwnedVersion }
            return New-ApiResponse @{ deployments = @(@{ created_on = '2026-10-11T00:00:00Z'; versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
        }
        if ($taskSuffix -match '^/versions/[0-9a-f-]{36}$') {
            Write-Trace 'temporary-version-read'
            if ($Scenario -ceq 'cleanup-ownership-unavailable' -and $script:fixtureTemporaryReads -gt 1) { return New-Response -Status 503 }
            $taskMarker = if ($Scenario -ceq 'cleanup-marker-drift' -and $script:fixtureTemporaryReads -gt 1) { 'foreign-marker' } else { $script:fixtureMarker }
            $taskTemporaryBindings = @(
                @{ name = 'HYPERDRIVE_MAINTENANCE'; type = 'hyperdrive'; id = '9748c294e21c49a99579c9cef70102e0' },
                @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' },
                @{ name = 'HYPERDRIVE_ADMIN'; type = 'hyperdrive'; id = '446e94a4de0143f58c8e5178ec55db8b' }
            )
            foreach ($taskKey in $script:fixtureVariables.Keys) {
                $taskText = if ($Scenario -ceq 'cleanup-variable-drift' -and $script:fixtureTemporaryReads -gt 1 -and $taskKey -ceq 'SOURCE_SHA') { 'e' * 40 } else { $script:fixtureVariables[$taskKey] }
                $taskTemporaryBindings += @{ name = $taskKey; type = 'plain_text'; text = $taskText }
            }
            if ($Scenario -ceq 'cleanup-binding-drift' -and $script:fixtureTemporaryReads -gt 1) { $taskTemporaryBindings[0].id = 'e' * 32 }
            return New-ApiResponse @{ annotations = @{ 'workers/message' = $taskMarker }; resources = @{ bindings = $taskTemporaryBindings } }
        }
        throw 'Unexpected temporary control-plane endpoint.'
    }
    if ($Uri -match '^https://(?<name>cinashop-aao-v[23]-maint-[0-9a-f]{16})\.cinagroup\.workers\.dev(?<path>.*)$') {
        $taskPath = $Matches.path
        if (-not $script:fixtureDeployed) {
            Write-Trace 'public-absence-read'
            if ($Scenario -ceq 'public-404-unavailable') { return New-Response -Status 403 }
            return New-Response -Status 404
        }
        if (-not $Headers.ContainsKey('X-Audit-Token')) { Write-Trace 'anonymous-read'; return New-Response -Status 403 }
        $taskAuthSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Headers['X-Audit-Token']))).ToLowerInvariant()
        if ($taskAuthSha -cne $script:fixtureVariables.AUDIT_TOKEN_SHA256) { throw 'Unexpected audit token.' }
        if ($taskPath -ceq '/preflight?sql=none') { Write-Trace 'query-refused'; return New-Response -Status 404 }
        if ($taskPath -ceq '/apply' -and $Method -ceq 'Get') { Write-Trace 'wrong-method-refused'; return New-Response -Status 405 }
        if ($taskPath -ceq '/apply' -and $Method -ceq 'Post') {
            if (-not $Headers.ContainsKey('X-Migration-Operation')) { Write-Trace 'apply-without-operation'; return New-Response -Status $(if ($taskApplyMode) { 400 } else { 403 }) }
            Write-Trace 'apply-authorized'
            if (-not $taskApplyMode -or $script:fixtureVariables.APPLY_ARMED -cne 'true' -or $Headers['X-Preflight-SHA256'] -cne $script:fixtureApproval -or $Headers['X-Migration-Operation'] -cne $(if ($taskPhase -ceq 'AuthorityV2') { 'admin-authority-install-v1-and-legacy-v2' } else { 'admin-legacy-role-install-v3' })) { throw 'Unexpected authorized apply request.' }
            if ($Scenario -ceq 'apply-response-lost') { throw [TimeoutException]::new('private-connection-or-sql') }
            if ($Scenario -ceq 'apply-http-503') { return New-Response -Status 503 -Body @{ error = 'private-connection-or-sql'; secret = 'synthetic-private-token' } }
            if ($Scenario -ceq 'safe-worker-error') { return New-Response -Status 503 -Body @{ error = 'outcome unconfirmed; inspect read-only before any further action'; stage = 'single_apply'; sqlState = '55P03'; private = 'private-connection-or-sql' } }
            if ($Scenario -ceq 'apply-json-invalid') { $taskInvalid = New-Response -Status 200; $taskInvalid.Content = '{private-connection-or-sql'; return $taskInvalid }
            $taskApplied = @{ operation = $Headers['X-Migration-Operation']; committed = ($Scenario -cne 'apply-commit-unconfirmed'); sourceSha = $script:fixtureSourceSha; installSqlSha256 = $script:fixtureSqlSha; runMarker = $script:fixtureMarker; approvedPreflightFingerprint = $script:fixtureApproval; protectedDataObservationUnchanged = ($Scenario -cne 'apply-protected-data-changed') }
            return New-Response -Status 200 -Body $taskApplied -NoStore ($Scenario -cne 'apply-no-store-missing')
        }
        if ($Method -cne 'Get') { throw 'Unexpected maintenance method.' }
        if ($taskPath -ceq '/preflight') {
            Write-Trace 'preflight-authenticated'
            $script:fixturePreflightReads++
            if ($Scenario -ceq 'preflight-get-transient' -and $script:fixturePreflightReads -le 2) { return New-Response -Status 503 }
            return New-Response -Status 200 -Body (New-Preflight)
        }
        if ($taskPath -ceq '/postflight') { Write-Trace 'postflight-authenticated'; $script:fixturePostflightReads++; return New-Response -Status 200 -Body (New-Preflight -Postflight $true) }
        throw 'Unexpected maintenance path.'
    }
    throw 'Unexpected mock URL; real HTTP is disabled.'
}
function node {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
    if ($CommandArgs.Count -lt 2 -or $CommandArgs[0] -cne (Join-Path $FixtureRoot 'workers-ts/node_modules/wrangler/bin/wrangler.js')) { throw 'Unexpected mock Node target.' }
    if ($CommandArgs[1] -ceq 'deploy') {
        $taskNameIndex = [Array]::IndexOf($CommandArgs,'--name')
        $taskMarkerIndex = [Array]::IndexOf($CommandArgs,'--message')
        if ($taskNameIndex -lt 0 -or $taskMarkerIndex -lt 0) { throw 'Deployment omitted ownership fields.' }
        $script:fixtureName = $CommandArgs[$taskNameIndex+1]
        $script:fixtureMarker = $CommandArgs[$taskMarkerIndex+1]
        $taskExpectedPrefix = if ($taskPhase -ceq 'AuthorityV2') { 'cinashop-aao-v2-maint-' } else { 'cinashop-aao-v3-maint-' }
        if ($script:fixtureName -cnotmatch ('^' + $taskExpectedPrefix + '[0-9a-f]{16}$')) { throw 'Incorrect phase namespace.' }
        for ($taskArg = 0; $taskArg -lt $CommandArgs.Count; $taskArg++) {
            if ($CommandArgs[$taskArg] -ceq '--var') {
                $taskPair = $CommandArgs[$taskArg+1].Split(':',2)
                if ($script:fixtureVariables.ContainsKey($taskPair[0])) { throw 'Duplicate fixed deployment variable.' }
                $script:fixtureVariables[$taskPair[0]] = $taskPair[1]
            }
        }
        if ($script:fixtureVariables.Count -ne 7 -or $script:fixtureVariables.SOURCE_SHA -cne $script:fixtureSourceSha -or $script:fixtureVariables.EXPECTED_INSTALL_SQL_SHA256 -cne $script:fixtureSqlSha -or $script:fixtureVariables.RUN_MARKER -cne $script:fixtureMarker -or $script:fixtureVariables.APPLY_ARMED -cne $(if ($taskApplyMode) { 'true' } else { 'false' }) -or $script:fixtureVariables.APPROVED_PREFLIGHT_SHA256 -cne $(if ($taskApplyMode) { $script:fixtureApproval } else { '0' * 64 })) { throw 'Deployment variables do not match the requested operation.' }
        Write-Trace 'deploy-owned'
        $script:fixtureDeployed = $true
        [IO.File]::WriteAllText($env:WRANGLER_LOG_PATH,'synthetic-private-cli-log')
        $global:LASTEXITCODE = if ($Scenario -ceq 'deploy-nonzero') { 1 } else { 0 }
        if ($Scenario -ceq 'deploy-nonzero') { return 'private-connection-or-sql' }
        if ($Scenario -ceq 'deploy-url-missing') { return 'https://unexpected.invalid' }
        return "https://$($script:fixtureName).cinagroup.workers.dev"
    }
    if ($CommandArgs[1] -ceq 'delete') {
        if (-not $script:fixtureDeployed -or $CommandArgs[2] -cne $script:fixtureName) { throw 'Deletion was not restricted to the owned Worker.' }
        Write-Trace 'delete-owned'
        $global:LASTEXITCODE = if ($Scenario -ceq 'delete-nonzero') { 1 } else { 0 }
        if ($global:LASTEXITCODE -eq 0) { $script:fixtureDeployed = $false }
        return 'private-connection-or-sql'
    }
    throw 'Unexpected mock Node command.'
}
$taskArguments = @{
    Phase = $taskPhase; ExpectedSourceSha = $script:fixtureSourceSha
    ExpectedInstallSqlSha256 = $script:fixtureSqlSha; ExpectedApiVersionId = $script:fixtureMainVersion
    ExpectedApiBindingsSha256 = $taskBindingSha
}
if ($Scenario -ceq 'phase-case-drift') { $taskArguments.Phase = 'authorityv2' }
if ($Scenario -ceq 'mode-neither') { }
elseif ($Scenario -ceq 'mode-both') { $taskArguments.InspectOnly = $true; $taskArguments.Apply = $true; $taskArguments.ApprovedPreflightFingerprint = $script:fixtureApproval }
elseif ($taskApplyMode) { $taskArguments.Apply = $true; if ($Scenario -cne 'apply-no-fingerprint') { $taskArguments.ApprovedPreflightFingerprint = $script:fixtureApproval } }
else { $taskArguments.InspectOnly = $true; if ($Scenario -ceq 'inspect-with-fingerprint') { $taskArguments.ApprovedPreflightFingerprint = $script:fixtureApproval } }
# Replace only the process wrapper, leaving the runner's source, validation,
# transaction dispatch and cleanup logic intact. The real wrapper's process and
# output bounds are exercised separately with inert local Node fixtures.
$taskRunnerSource = Get-Content -LiteralPath $taskFixtureRunner -Raw
$taskParseTokens = $null
$taskParseErrors = $null
$taskRunnerAst = [Management.Automation.Language.Parser]::ParseInput($taskRunnerSource,[ref]$taskParseTokens,[ref]$taskParseErrors)
$taskWrapperDefinitions = @($taskRunnerAst.FindAll({ param($AstNode)
    $AstNode -is [Management.Automation.Language.FunctionDefinitionAst] -and $AstNode.Name -ceq 'Invoke-BoundedWrangler'
},$true))
if (@($taskParseErrors).Count -ne 0 -or $taskWrapperDefinitions.Count -ne 1) { throw 'The reviewed process wrapper is missing or invalid.' }
$taskWrapperMock = @'
function Invoke-BoundedWrangler {
    param([ValidateSet('deploy','delete')][string]$Operation,[string[]]$Arguments)
    $script:taskCliDiagnostics[$Operation].outcome = 'start-attempted'
    $taskOutput = & node $taskCli $Operation @Arguments
    if (($Operation -ceq 'deploy' -and $Scenario -in @('deploy-deadline','deploy-output-oversize')) -or
        ($Operation -ceq 'delete' -and $Scenario -ceq 'delete-deadline')) {
        $script:taskCliDiagnostics[$Operation].outcome = if ($Scenario -ceq 'deploy-output-oversize') { 'output-oversize' } else { 'deadline-exceeded' }
        $script:taskProcessTreeUncertain = $true
        throw 'Synthetic bounded process interruption.'
    }
    $script:taskCliDiagnostics[$Operation].exitCode = [string]$LASTEXITCODE
    $script:taskCliDiagnostics[$Operation].outcome = if ($LASTEXITCODE -eq 0) { 'cli-zero' } else { 'cli-nonzero' }
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic Wrangler operation failed.' }
    if ($Scenario -ceq 'cli-output-cleanup-failed' -and $Operation -ceq 'deploy') {
        $script:taskCliOutputCleanupFailed = $true
        throw 'Synthetic owned CLI output cleanup failed.'
    }
    if ($Operation -ceq 'deploy') {
        $taskConfirmed = ($taskOutput -join [char]10) -cmatch [regex]::Escape($taskExpectedPublicUrl)
        $script:taskCliDiagnostics[$Operation].outcome = if ($taskConfirmed) { 'url-confirmed' } else { 'url-missing' }
        return [bool]$taskConfirmed
    }
    return $true
}
'@
$taskWrapperExtent = $taskWrapperDefinitions[0].Extent
$taskRunnerSource = $taskRunnerSource.Remove($taskWrapperExtent.StartOffset,$taskWrapperExtent.EndOffset - $taskWrapperExtent.StartOffset).Insert($taskWrapperExtent.StartOffset,$taskWrapperMock)
[IO.File]::WriteAllText($taskFixtureRunner,$taskRunnerSource)
. $taskFixtureRunner @taskArguments
exit $LASTEXITCODE
