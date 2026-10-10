# Offline simulation of the temporary Worker runner. All Cloudflare HTTP and
# Wrangler calls are replaced before the runner is dot-sourced. No network or DB.
[CmdletBinding()]
param(
    [ValidateSet('all','success','deploy-failed','deploy-url-missing','request-failed','request-timeout',
        'header-missing','malformed-json','malformed-shape','worker-catalog-503','temporary-version-drift',
        'formal-postflight-drift','foreign-target','owned-version-transient',
        'cleanup-presence-transient','ownership-read-unavailable',
        'control-404-transient','control-404-unavailable','marker-drift','binding-drift',
        'catalog-identity-drift','catalog-definition-drift','catalog-malformed-number',
        'catalog-malformed-index','formal-settings-binding-drift','formal-version-binding-drift',
        'deploy-hung-after-upload','delete-hung-before-removal','delete-hung-after-removal',
        'deploy-kill-unconfirmed','deploy-output-cleanup-failed','process-tree-timeout',
        'actual-stderr-url','actual-oversize','actual-nonzero-auth','actual-nonzero-stdout-auth','actual-nonzero-rate',
        'actual-nonzero-network','actual-nonzero-private','actual-nonzero-ambiguous',
        'actual-nonzero-oversize')]
    [string]$Scenario = 'all',
    [string]$TracePath
)
$ErrorActionPreference = 'Stop'
$taskRunner = Join-Path $PSScriptRoot 'run-customer-city-binding-fk-current-production-audit.ps1'

if ($Scenario -eq 'all') {
    $taskCases = @('success','deploy-failed','deploy-url-missing','request-failed','request-timeout',
        'header-missing','malformed-json','malformed-shape','worker-catalog-503','temporary-version-drift',
        'formal-postflight-drift','foreign-target','owned-version-transient',
        'cleanup-presence-transient','ownership-read-unavailable',
        'control-404-transient','control-404-unavailable','marker-drift','binding-drift',
        'catalog-identity-drift','catalog-definition-drift','catalog-malformed-number',
        'catalog-malformed-index','formal-settings-binding-drift','formal-version-binding-drift',
        'deploy-hung-after-upload','delete-hung-before-removal','delete-hung-after-removal',
        'deploy-kill-unconfirmed','deploy-output-cleanup-failed','process-tree-timeout',
        'actual-stderr-url','actual-oversize','actual-nonzero-auth','actual-nonzero-stdout-auth','actual-nonzero-rate',
        'actual-nonzero-network','actual-nonzero-private','actual-nonzero-ambiguous',
        'actual-nonzero-oversize')
    foreach ($taskCase in $taskCases) {
        $taskTrace = Join-Path $env:TEMP ('db009g-city-fk-runner-' + [Guid]::NewGuid().ToString('N') + '.txt')
        try {
            $taskOutput = & pwsh -NoProfile -File $PSCommandPath -Scenario $taskCase -TracePath $taskTrace 2>&1
            $taskExit = $LASTEXITCODE
            if ($taskCase -ceq 'process-tree-timeout') {
                $taskProcessEvidence = ($taskOutput -join "`n") | ConvertFrom-Json -Depth 4
                if ($taskExit -ne 0 -or $taskProcessEvidence.deployStopped -ne $true -or
                    $taskProcessEvidence.deleteStopped -ne $true -or
                    $taskProcessEvidence.deployTimeoutMarkedUncertain -ne $true -or
                    $taskProcessEvidence.deleteTimeoutMarkedUncertain -ne $true -or
                    $taskProcessEvidence.ownedOutputRemoved -ne $true) {
                    throw 'Bounded child-tree process test failed.'
                }
                "$taskCase`: pass"
                continue
            }
            if ($taskCase -in @('actual-stderr-url','actual-oversize')) {
                $taskProcessEvidence = ($taskOutput -join "`n") | ConvertFrom-Json -Depth 4
                $taskExpectedReason = if ($taskCase -ceq 'actual-stderr-url') {
                    'url-confirmed'
                } else { 'output-oversize' }
                if ($taskExit -ne 0 -or $taskProcessEvidence.outcome -cne $taskExpectedReason -or
                    $taskProcessEvidence.exitCode -cne '0' -or
                    $taskProcessEvidence.errorCategory -cne 'none' -or
                    $taskProcessEvidence.outputRemoved -ne $true -or
                    $taskProcessEvidence.confirmed -ne ($taskCase -ceq 'actual-stderr-url')) {
                    throw "$taskCase real-stream behavior differs."
                }
                "$taskCase`: pass"
                continue
            }
            if ($taskCase -like 'actual-nonzero-*') {
                $taskProcessEvidence = ($taskOutput -join "`n") | ConvertFrom-Json -Depth 4
                $taskExpectedCategory = switch ($taskCase) {
                    'actual-nonzero-auth' { 'auth-or-permission' }
                    'actual-nonzero-stdout-auth' { 'auth-or-permission' }
                    'actual-nonzero-rate' { 'rate-limit' }
                    'actual-nonzero-network' { 'network' }
                    default { 'unknown' }
                }
                if ($taskExit -ne 0 -or $taskProcessEvidence.outcome -cne 'cli-nonzero' -or
                    $taskProcessEvidence.exitCode -cne '1' -or
                    $taskProcessEvidence.errorCategory -cne $taskExpectedCategory -or
                    $taskProcessEvidence.outputRemoved -ne $true -or
                    $taskProcessEvidence.confirmed -ne $false -or
                    ($taskOutput -join "`n") -match 'private-connection-or-sql|private\.example\.invalid|account-secret') {
                    throw "$taskCase real-process category or privacy behavior differs."
                }
                "$taskCase`: pass"
                continue
            }
            $taskReceipt = ($taskOutput -join "`n") | ConvertFrom-Json -Depth 20
            $taskLogPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".cache/$($taskReceipt.workerName)-wrangler.log"
            if ((Test-Path -LiteralPath $taskLogPath) -or
                $taskReceipt.cleanup.wranglerLogRemoved -ne $true) {
                throw "$taskCase left its owned Wrangler log."
            }
            $taskCalls = if (Test-Path -LiteralPath $taskTrace) {
                @(Get-Content -LiteralPath $taskTrace)
            } else { @() }
            $taskDeletes = @($taskCalls | Where-Object { $_ -ceq 'delete-owned' }).Count
            $taskDeploys = @($taskCalls | Where-Object { $_ -ceq 'deploy-owned' }).Count
            if ($taskCase -in @('success','owned-version-transient','cleanup-presence-transient',
                'control-404-transient')) {
                if ($taskExit -ne 0 -or $taskReceipt.ready -ne $true -or
                    $taskReceipt.diagnostic.outcome -cne 'complete' -or
                    $taskReceipt.deployDiagnostic.outcome -cne 'url-confirmed' -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1) {
                    throw 'Success simulation failed.'
                }
            } elseif ($taskCase -in @('deploy-failed','deploy-url-missing','request-failed','request-timeout',
                'header-missing','malformed-json','malformed-shape','worker-catalog-503',
                'formal-postflight-drift','deploy-hung-after-upload')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true) {
                    throw "$taskCase did not clean up its owned Worker."
                }
                if ($taskCase -ceq 'deploy-hung-after-upload' -and
                    ($taskReceipt.cleanup.processTreeConfirmedStopped -ne $false -or
                     $taskReceipt.failure -cne 'Wrangler process tree needs independent verification; inspect the temporary Worker name.' -or
                     -not $taskReceipt.workerName)) {
                    throw 'Timed-out deployment lost its manual-review target.'
                }
                $taskExpectedDiagnostic = switch ($taskCase) {
                    'request-failed' { @('http-status','503','present','unobserved','unobserved') }
                    'request-timeout' { @('timeout','unobserved','unobserved','unobserved','unobserved') }
                    'header-missing' { @('cache-control','200','absent','unobserved','unobserved') }
                    'malformed-json' { @('json-parse','200','present','unobserved','unobserved') }
                    'malformed-shape' { @('shape','200','present','unobserved','unobserved') }
                    'worker-catalog-503' { @('http-status','503','present','catalog','timeout') }
                }
                if ($taskExpectedDiagnostic -and
                    (@($taskReceipt.diagnostic.outcome,$taskReceipt.diagnostic.httpStatus,
                        $taskReceipt.diagnostic.cacheControl,$taskReceipt.diagnostic.workerStage,
                        $taskReceipt.diagnostic.category) -join '|') -cne
                    ($taskExpectedDiagnostic -join '|')) {
                    throw "$taskCase diagnostic classification differs."
                }
                if (($taskOutput -join "`n") -match 'private-connection-or-sql') {
                    throw "$taskCase leaked a synthetic private marker."
                }
                if ($taskCase -ceq 'deploy-failed' -and
                    ($taskReceipt.deployDiagnostic.outcome -cne 'cli-nonzero' -or
                     $taskReceipt.deployDiagnostic.exitCode -cne '1')) {
                    throw 'Bounded Wrangler failure cause was not retained.'
                }
                if ($taskCase -ceq 'deploy-url-missing' -and
                    ($taskReceipt.deployDiagnostic.outcome -cne 'url-missing' -or
                     $taskReceipt.deployDiagnostic.exitCode -cne '0')) {
                    throw 'Expected temporary URL failure cause was not retained.'
                }
                if ($taskCase -ceq 'deploy-hung-after-upload' -and
                    ($taskReceipt.deployDiagnostic.outcome -cne 'deadline-exceeded' -or
                     $taskReceipt.deployDiagnostic.exitCode -cne 'unobserved')) {
                    throw 'Bounded Wrangler timeout cause was not retained.'
                }
                if ($taskCase -eq 'formal-postflight-drift' -and $taskReceipt.formalUnchanged -ne $false) {
                    throw 'Formal Worker drift was not detected.'
                }
            } elseif ($taskCase -in @('temporary-version-drift','ownership-read-unavailable',
                'marker-drift','binding-drift')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.deleted -ne $false -or
                    $taskReceipt.failure -cne 'Temporary Worker cleanup needs independent verification.') {
                    throw 'Unverified temporary Worker was deleted or accepted.'
                }
            } elseif ($taskCase -eq 'delete-hung-before-removal') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.deleted -ne $false -or
                    $taskReceipt.cleanup.controlPlane404 -ne $false -or
                    $taskReceipt.cleanup.public404 -ne $false -or
                    $taskReceipt.cleanup.processTreeConfirmedStopped -ne $false -or
                    $taskReceipt.failure -cne 'Wrangler process tree needs independent verification; inspect the temporary Worker name.' -or
                    -not $taskReceipt.workerName) {
                    throw 'Hung deletion lacked bounded failure and manual cleanup target.'
                }
            } elseif ($taskCase -eq 'delete-hung-after-removal') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.deleted -ne $false -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true -or
                    $taskReceipt.cleanup.processTreeConfirmedStopped -ne $false -or
                    $taskReceipt.failure -cne 'Wrangler process tree needs independent verification; inspect the temporary Worker name.' -or
                    -not $taskReceipt.workerName) {
                    throw 'Timed-out deletion was treated as success or skipped dual-404 checks.'
                }
            } elseif ($taskCase -eq 'deploy-kill-unconfirmed') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.processTreeConfirmedStopped -ne $false -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true -or
                    $taskReceipt.failure -cne 'Wrangler process tree needs independent verification; inspect the temporary Worker name.' -or
                    -not $taskReceipt.workerName) {
                    throw 'Unterminated child tree was accepted as safe cleanup.'
                }
            } elseif ($taskCase -eq 'deploy-output-cleanup-failed') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.stdoutStderrRemoved -ne $false -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true -or
                    $taskReceipt.failure -cne 'Current city-binding FK audit could not be fully confirmed.') {
                    throw 'Output cleanup error masked the primary bounded deployment failure.'
                }
            } elseif ($taskCase -in @('formal-settings-binding-drift','formal-version-binding-drift')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 0 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.attempted -ne $false) {
                    throw 'Formal binding drift passed preflight or deployed a temporary Worker.'
                }
            } elseif ($taskCase -eq 'foreign-target') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 0 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.attempted -ne $false) {
                    throw 'Pre-existing target was deployed to or deleted.'
                }
            } elseif ($taskCase -eq 'control-404-unavailable') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.controlPlane404 -ne $false -or
                    $taskReceipt.failure -cne 'Temporary Worker cleanup needs independent verification.') {
                    throw 'Unconfirmed control-plane deletion was accepted.'
                }
            } elseif ($taskCase -in @('catalog-identity-drift','catalog-definition-drift')) {
                if ($taskExit -ne 1 -or $taskReceipt.ready -ne $false -or
                    $taskReceipt.audit.audit.catalogMatch -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.public404 -ne $true) {
                    throw 'Incomplete city FK evidence was accepted or not cleaned up.'
                }
            } elseif ($taskCase -in @('catalog-malformed-number','catalog-malformed-index')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeletes -ne 1 -or $taskReceipt.audit -ne $null -or
                    $taskReceipt.cleanup.public404 -ne $true) {
                    throw 'Malformed city FK evidence escaped validation or cleanup.'
                }
            }
            "$taskCase`: pass"
        } finally {
            if (Test-Path -LiteralPath $taskTrace) { Remove-Item -LiteralPath $taskTrace -Force }
        }
    }
    exit 0
}

if (-not $TracePath) { throw 'A local trace path is required for one scenario.' }
if ($Scenario -ceq 'process-tree-timeout') {
    $taskSource = Get-Content -Raw -LiteralPath $taskRunner
    $taskTokens = $null
    $taskParseErrors = $null
    $taskAst = [System.Management.Automation.Language.Parser]::ParseInput(
        $taskSource,[ref]$taskTokens,[ref]$taskParseErrors)
    $taskDefinitions = @($taskAst.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Invoke-BoundedWrangler' },$true))
    if (@($taskParseErrors).Count -ne 0 -or $taskDefinitions.Count -ne 1) {
        throw 'Production bounded process function changed.'
    }
    . ([ScriptBlock]::Create($taskDefinitions[0].Extent.Text))
    $taskRoot = Split-Path -Parent $PSScriptRoot
    $taskCache = Join-Path $taskRoot '.cache'
    $null = New-Item -ItemType Directory -Force -Path $taskCache
    $taskName = 'db009g-offline-' + [Guid]::NewGuid().ToString('N')
    $taskCli = Join-Path $taskCache "$taskName-fixture.cjs"
    $taskFixture = @'
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath,
  ['-e', `setInterval(() => {}, 1000); // ${process.argv[4]}`],
  { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(process.argv[3], String(child.pid));
setInterval(() => {}, 1000);
'@
    [IO.File]::WriteAllText($taskCli,$taskFixture)
    $taskResults = [ordered]@{ deployStopped = $false; deleteStopped = $false;
        deployTimeoutMarkedUncertain = $false; deleteTimeoutMarkedUncertain = $false;
        ownedOutputRemoved = $false }
    $script:taskDeployDiagnostic = [ordered]@{ outcome = 'not-started'; exitCode = 'unobserved';
        errorCategory = 'unobserved' }
    try {
        foreach ($taskOperation in @('deploy','delete')) {
            $taskPidFile = Join-Path $taskCache "$taskName-$taskOperation-child.pid"
            $taskMarker = "db009g-child-$taskName-$taskOperation"
            $taskStarted = [Diagnostics.Stopwatch]::StartNew()
            $taskTimedOut = $false
            $script:taskProcessTreeUncertain = $false
            try {
                $null = Invoke-BoundedWrangler -Operation $taskOperation `
                    -Arguments @($taskPidFile,$taskMarker) -TimeoutMs 500
            } catch [TimeoutException] { $taskTimedOut = $true }
            $taskStarted.Stop()
            if (-not $taskTimedOut -or -not $script:taskProcessTreeUncertain -or
                $taskStarted.ElapsedMilliseconds -gt 10000 -or
                ($taskOperation -ceq 'deploy' -and
                 ($script:taskDeployDiagnostic.outcome -cne 'deadline-exceeded' -or
                   $script:taskDeployDiagnostic.exitCode -cne 'unobserved' -or
                   $script:taskDeployDiagnostic.errorCategory -cne 'unobserved')) -or
                -not (Test-Path -LiteralPath $taskPidFile)) {
                throw 'Owned local process did not mark its bounded timeout uncertain.'
            }
            $taskResults["${taskOperation}TimeoutMarkedUncertain"] = $true
            $taskChildPid = [int](Get-Content -Raw -LiteralPath $taskPidFile)
            Start-Sleep -Milliseconds 300
            $taskStillAlive = Get-Process -Id $taskChildPid -ErrorAction SilentlyContinue
            if ($taskStillAlive) {
                # This PID came from the just-created, uniquely named local
                # fixture. Stop it before reporting a failed tree-kill test.
                Stop-Process -Id $taskChildPid -Force -ErrorAction SilentlyContinue
                throw 'Bounded wrapper left a child process running.'
            }
            $taskResults["${taskOperation}Stopped"] = $true
            Remove-Item -LiteralPath $taskPidFile -Force
        }
        $taskLeftovers = @(Get-ChildItem -LiteralPath $taskCache -File -Filter "$taskName-*.stdout") +
            @(Get-ChildItem -LiteralPath $taskCache -File -Filter "$taskName-*.stderr")
        $taskResults.ownedOutputRemoved = $taskLeftovers.Count -eq 0
    } finally {
        if (Test-Path -LiteralPath $taskCli) { Remove-Item -LiteralPath $taskCli -Force }
    }
    $taskResults | ConvertTo-Json -Compress
    exit 0
}
if ($Scenario -in @('actual-stderr-url','actual-oversize') -or
    $Scenario -like 'actual-nonzero-*') {
    $taskSource = Get-Content -Raw -LiteralPath $taskRunner
    $taskTokens = $null
    $taskParseErrors = $null
    $taskAst = [System.Management.Automation.Language.Parser]::ParseInput(
        $taskSource,[ref]$taskTokens,[ref]$taskParseErrors)
    $taskDefinitions = @($taskAst.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Invoke-BoundedWrangler' },$true))
    if (@($taskParseErrors).Count -ne 0 -or $taskDefinitions.Count -ne 1) {
        throw 'Production bounded process function changed.'
    }
    . ([ScriptBlock]::Create($taskDefinitions[0].Extent.Text))
    $taskRoot = Split-Path -Parent $PSScriptRoot
    $taskCache = Join-Path $taskRoot '.cache'
    $null = New-Item -ItemType Directory -Force -Path $taskCache
    $taskName = 'db009g-stream-' + [Guid]::NewGuid().ToString('N')
    $taskUrl = "https://$taskName.cinagroup.workers.dev"
    $taskCli = Join-Path $taskCache "$taskName-fixture.cjs"
    $taskFixture = @'
if (process.argv[2] !== 'deploy') process.exit(9);
const scenario = process.argv[4];
const privateText = 'private-connection-or-sql https://private.example.invalid account-secret';
if (scenario === 'actual-oversize') process.stderr.write('x'.repeat(65537));
else if (scenario === 'actual-nonzero-oversize') {
  process.stderr.write('Authentication error ' + 'x'.repeat(65537) + privateText);
  process.exitCode = 1;
} else if (scenario.startsWith('actual-nonzero-')) {
  if (scenario === 'actual-nonzero-stdout-auth') {
    process.stdout.write('Authentication error ' + privateText);
    process.stderr.write(privateText);
    process.exitCode = 1;
  } else {
    process.stdout.write(privateText);
    const message = {
      'actual-nonzero-auth': 'Authentication error',
      'actual-nonzero-rate': 'rate limited',
      'actual-nonzero-network': 'ECONNRESET',
      'actual-nonzero-private': 'opaque failure',
      'actual-nonzero-ambiguous': 'Authentication error ECONNRESET'
    }[scenario];
    process.stderr.write(message + ' ' + privateText);
    process.exitCode = 1;
  }
} else process.stderr.write(process.argv[3]);
'@
    [IO.File]::WriteAllText($taskCli,$taskFixture)
    $script:taskDeployDiagnostic = [ordered]@{ outcome = 'not-started'; exitCode = 'unobserved';
        errorCategory = 'unobserved' }
    $taskConfirmed = $false
    $taskThrown = $false
    try {
        try {
            $taskConfirmed = Invoke-BoundedWrangler -Operation deploy -Arguments @($taskUrl,$Scenario)
        } catch { $taskThrown = $true }
        $taskOutputRemoved = @(Get-ChildItem -LiteralPath $taskCache -File -Filter "$taskName-deploy-*.stdout").Count -eq 0 -and
            @(Get-ChildItem -LiteralPath $taskCache -File -Filter "$taskName-deploy-*.stderr").Count -eq 0
        if ($Scenario -ceq 'actual-stderr-url' -and ($taskThrown -or -not $taskConfirmed)) {
            throw 'Bounded deployment did not accept an exact URL on stderr.'
        }
        if ($Scenario -ceq 'actual-oversize' -and (-not $taskThrown -or $taskConfirmed)) {
            throw 'Bounded deployment accepted oversized stderr.'
        }
        [ordered]@{ confirmed = [bool]$taskConfirmed;
            outcome = $script:taskDeployDiagnostic.outcome;
            exitCode = $script:taskDeployDiagnostic.exitCode;
            errorCategory = $script:taskDeployDiagnostic.errorCategory;
            outputRemoved = [bool]$taskOutputRemoved } | ConvertTo-Json -Compress
    } finally {
        if (Test-Path -LiteralPath $taskCli) { Remove-Item -LiteralPath $taskCli -Force }
    }
    exit 0
}
$env:CLOUDFLARE_API_TOKEN = 'synthetic-local-test-token'
$script:deployed = $false
$script:workerName = $null
$script:marker = $null
$script:formalReadCount = 0
$script:temporaryReadCount = 0
$script:versionReadCount = 0
$script:presenceReadCount = 0
$script:absenceReadCount = 0
$script:mainVersion = 'd44ef519-90ab-4864-b42f-3f0ca76890b2'
$script:ownedVersion = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$script:changedVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$script:bindings = @(
    @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' },
    @{ name = 'HYPERDRIVE_ADMIN'; type = 'hyperdrive'; id = '446e94a4de0143f58c8e5178ec55db8b' }
)
for ($taskIndex = 1; $taskIndex -le 29; $taskIndex++) {
    $script:bindings += @{ name = ('SAFE_{0:D2}' -f $taskIndex); type = 'plain_text' }
}
function New-Response {
    param([int]$Status,[object]$Body=$null,[bool]$NoStore=$true)
    [pscustomobject]@{
        StatusCode = $Status
        Content = if ($null -eq $Body) { '' } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        Headers = if ($NoStore) { @{ 'Cache-Control' = @('no-store') } } else { @{} }
    }
}
function New-ApiResponse {
    param([object]$Result)
    New-Response -Status 200 -Body @{ success = $true; result = $Result }
}
function Start-Sleep { param([int]$Seconds) }
function Invoke-WebRequest {
    param([string]$Uri,[string]$Method='GET',[hashtable]$Headers,
        [switch]$SkipHttpErrorCheck,[int]$TimeoutSec)
    if ($Method -cne 'GET' -and $Method -cne 'POST') { throw 'Unexpected mock HTTP method.' }
    if ($Uri -match '/workers/scripts/cinashop-api/deployments$') {
        $script:formalReadCount++
        $taskVersion = if ($Scenario -eq 'formal-postflight-drift' -and $script:formalReadCount -ge 2) {
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        } else { $script:mainVersion }
        return New-ApiResponse @{ deployments = @(@{ id = 'main-deployment';
            created_on = '2026-10-09T00:00:00Z'; versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/settings$') {
        $taskFormalBindings = @($script:bindings)
        if ($Scenario -eq 'formal-settings-binding-drift') {
            $taskFormalBindings = @($script:bindings | ForEach-Object {
                if ($_.name -ceq 'SAFE_01') { @{ name = 'DRIFT_01'; type = 'plain_text' } }
                else { $_ }
            })
        }
        return New-ApiResponse @{ bindings = $taskFormalBindings }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/versions/d44ef519-90ab-4864-b42f-3f0ca76890b2$') {
        $taskFormalBindings = @($script:bindings)
        if ($Scenario -eq 'formal-version-binding-drift') {
            $taskFormalBindings = @($script:bindings | ForEach-Object {
                if ($_.name -ceq 'SAFE_01') { @{ name = 'DRIFT_01'; type = 'plain_text' } }
                else { $_ }
            })
        }
        return New-ApiResponse @{ resources = @{ bindings = $taskFormalBindings } }
    }
    if ($Uri -match '/workers/scripts/(?<name>cinashop-city-binding-fk-current-audit-[0-9a-f]{16})(?<suffix>/.*)?$') {
        $taskSuffix = $Matches.suffix
        if (-not $taskSuffix) {
            if (-not $script:deployed -and $script:workerName -and
                $Scenario -in @('control-404-transient','control-404-unavailable')) {
                $script:absenceReadCount++
                if ($Scenario -eq 'control-404-unavailable') { return New-Response -Status 503 }
                if ($script:absenceReadCount -eq 1) { return New-Response -Status 200 }
                if ($script:absenceReadCount -eq 2) { return New-Response -Status 429 }
                if ($script:absenceReadCount -eq 3) { return New-Response -Status 503 }
                if ($script:absenceReadCount -eq 4) { throw 'Synthetic transport interruption.' }
            }
            if ($script:deployed -and $Scenario -eq 'cleanup-presence-transient') {
                $script:presenceReadCount++
                if ($script:presenceReadCount -eq 1) { return New-Response -Status 404 }
                if ($script:presenceReadCount -eq 2) { return New-Response -Status 429 }
                if ($script:presenceReadCount -eq 3) { return New-Response -Status 503 }
                if ($script:presenceReadCount -eq 4) { throw 'Synthetic transport interruption.' }
            }
            if ($Scenario -eq 'foreign-target' -or $script:deployed) { return New-Response -Status 200 }
            return New-Response -Status 404
        }
        if (-not $script:deployed) { throw 'Mock queried an absent temporary Worker.' }
        if ($taskSuffix -eq '/deployments') {
            $script:temporaryReadCount++
            $taskVersion = if ($Scenario -eq 'temporary-version-drift' -and $script:temporaryReadCount -ge 2) {
                $script:changedVersion
            } else { $script:ownedVersion }
            return New-ApiResponse @{ deployments = @(@{ id = 'temporary-deployment';
                created_on = '2026-10-09T00:00:00Z'; versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
        }
        if ($taskSuffix -match '^/versions/(?<version>[0-9a-f-]{36})$') {
            if ($Scenario -in @('owned-version-transient','ownership-read-unavailable')) {
                $script:versionReadCount++
                if ($Scenario -eq 'ownership-read-unavailable') { return New-Response -Status 503 }
                if ($script:versionReadCount -eq 1) { return New-Response -Status 404 }
                if ($script:versionReadCount -eq 2) { return New-Response -Status 429 }
                if ($script:versionReadCount -eq 3) { return New-Response -Status 503 }
                if ($script:versionReadCount -eq 4) { throw 'Synthetic transport interruption.' }
            }
            $taskMarker = if ($Scenario -eq 'marker-drift' -and $script:temporaryReadCount -ge 2) {
                'foreign-marker'
            } else { $script:marker }
            $taskBindingId = if ($Scenario -eq 'binding-drift' -and $script:temporaryReadCount -ge 2) {
                '00000000000000000000000000000000'
            } else { 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' }
            return New-ApiResponse @{ annotations = @{ 'workers/message' = $taskMarker };
                resources = @{ bindings = @(
                    @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = $taskBindingId },
                    @{ name = 'AUDIT_TOKEN_SHA256'; type = 'plain_text' },
                    @{ name = 'AUDIT_EXPIRES_AT'; type = 'plain_text' }
                ) } }
        }
        throw 'Unexpected temporary control-plane endpoint.'
    }
    if ($Uri -match '^https://cinashop-city-binding-fk-current-audit-[0-9a-f]{16}\.cinagroup\.workers\.dev(?<path>.*)$') {
        if (-not $script:deployed) { return New-Response -Status 404 }
        $taskPath = $Matches.path
        if (-not $Headers.ContainsKey('X-Audit-Token')) { return New-Response -Status 403 }
        if ($taskPath -cne '/city-binding-fk') { return New-Response -Status 404 }
        if ($Method -cne 'GET') { return New-Response -Status 405 }
        if ($Scenario -eq 'request-timeout') { throw [System.TimeoutException]::new('private-connection-or-sql') }
        if ($Scenario -eq 'request-failed') { return New-Response -Status 503 }
        if ($Scenario -eq 'worker-catalog-503') {
            return New-Response -Status 503 -Body @{ error = 'audit failed'; stage = 'catalog';
                category = 'timeout'; unrelated = 'private-connection-or-sql' }
        }
        if ($Scenario -eq 'header-missing') { return New-Response -Status 200 -NoStore $false }
        if ($Scenario -eq 'malformed-json') {
            $taskInvalid = New-Response -Status 200
            $taskInvalid.Content = '{private-connection-or-sql'
            return $taskInvalid
        }
        if ($Scenario -eq 'malformed-shape') {
            return New-Response -Status 200 -Body @{ scope = 'unexpected';
                identityMatch = $true; ready = $true; unrelated = 'private-connection-or-sql' }
        }
        $taskTable = [ordered]@{
            estimatedRows = '30'; liveRowsEstimate = '30'; modificationsSinceAnalyze = '0';
            heapBytes = '8192'; indexBytes = '8192'; totalBytes = '16384';
            lastAnalyzeMs = $null; lastAutoanalyzeMs = $null
        }
        if ($Scenario -eq 'catalog-malformed-number') {
            $taskTable.estimatedRows = '30 private-records'
        }
        $taskAudit = [ordered]@{
            scope = 'city-binding-fk-metadata-only'; identityMatch = $true;
            catalogMatch = $true; readyForIndexDecision = $false;
            tables = [ordered]@{
                customer_city_delivery_attempt = $taskTable;
                customer_city_delivery_binding = $taskTable
            };
            foreignKey = [ordered]@{ name = 'ccdbinding_attempt_fk'; exact = $true };
            indexes = [ordered]@{
                catalogSha256 = 'a' * 64; count = 4; leadingAny = 0;
                leadingUsableNonpartial = 0; leadingUsablePartial = 0; expression = 0
            }
        }
        if ($Scenario -eq 'catalog-malformed-index') { $taskAudit.indexes.catalogSha256 = 'invalid' }
        if ($Scenario -in @('catalog-identity-drift','catalog-definition-drift')) {
            $taskAudit.catalogMatch = $false
            $taskAudit.tables = $null
            $taskAudit.foreignKey = $null
            $taskAudit.indexes = $null
            if ($Scenario -eq 'catalog-identity-drift') { $taskAudit.identityMatch = $false }
        }
        $taskReady = $Scenario -notin @('catalog-identity-drift','catalog-definition-drift')
        return New-Response -Status 200 -Body @{ scope = 'city-binding-fk-current-app';
            ready = $taskReady; readyForIndexDecision = $false; audit = $taskAudit }
    }
    throw 'Unexpected mock URL.'
}
function node {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
    if ($CommandArgs.Count -lt 2 -or $CommandArgs[0] -notmatch 'wrangler\.js$') {
        throw 'Unexpected mock Wrangler invocation.'
    }
    if ($CommandArgs[1] -ceq 'deploy') {
        $taskNameIndex = [Array]::IndexOf($CommandArgs, '--name')
        $taskMarkerIndex = [Array]::IndexOf($CommandArgs, '--message')
        if ($taskNameIndex -lt 0 -or $taskMarkerIndex -lt 0) { throw 'Missing deploy ownership arguments.' }
        $script:workerName = $CommandArgs[$taskNameIndex + 1]
        $script:marker = $CommandArgs[$taskMarkerIndex + 1]
        $script:deployed = $true
        Add-Content -LiteralPath $TracePath -Value 'deploy-owned'
        if ($env:WRANGLER_LOG_PATH) {
            [IO.File]::WriteAllText($env:WRANGLER_LOG_PATH,'synthetic-private-cli-log')
        }
        if ($Scenario -eq 'deploy-failed') { $global:LASTEXITCODE = 1; return 'simulated deployment error' }
        if ($Scenario -eq 'deploy-url-missing') {
            $global:LASTEXITCODE = 0
            return 'https://unexpected.invalid'
        }
        $global:LASTEXITCODE = 0
        return "https://$script:workerName.cinagroup.workers.dev"
    }
    if ($CommandArgs[1] -ceq 'delete') {
        if (-not $script:deployed -or $CommandArgs[2] -cne $script:workerName) {
            throw 'Deletion was not limited to the owned temporary Worker.'
        }
        $script:deployed = $false
        Add-Content -LiteralPath $TracePath -Value 'delete-owned'
        $global:LASTEXITCODE = 0
        return
    }
    throw 'Unexpected mock Wrangler command.'
}

# The production runner pins a real release fingerprint. Substitute only the
# synthetic binding digest in this in-memory offline execution; assert that
# the reviewed production pin and path expression are present first.
$taskSource = Get-Content -Raw -LiteralPath $taskRunner
$taskProductionSha = '85dcd3bd1cc2f2a6a836ed9913c2fb5f7f46dd03540894585b75be399cfe36be'
$taskRootExpression = '$taskRoot = Split-Path -Parent $PSScriptRoot'
if ([regex]::Matches($taskSource,[regex]::Escape($taskProductionSha)).Count -ne 1 -or
    [regex]::Matches($taskSource,[regex]::Escape($taskRootExpression)).Count -ne 1) {
    throw 'Reviewed production fingerprint or runner path expression changed.'
}
$taskProjection = @($script:bindings | ForEach-Object {
    "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
} | Sort-Object -CaseSensitive)
$taskMockSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes(($taskProjection -join "`n")))).ToLowerInvariant()
$taskSource = $taskSource.Replace($taskProductionSha,$taskMockSha).Replace(
    $taskRootExpression,'$taskRoot = Split-Path -Parent $taskRunnerDir')
$taskTokens = $null
$taskParseErrors = $null
$taskAst = [System.Management.Automation.Language.Parser]::ParseInput(
    $taskSource,[ref]$taskTokens,[ref]$taskParseErrors)
$taskBoundedDefinitions = @($taskAst.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-BoundedWrangler' },$true))
if (@($taskParseErrors).Count -ne 0 -or $taskBoundedDefinitions.Count -ne 1) {
    throw 'Reviewed bounded Wrangler function is missing or invalid.'
}
$taskMockBounded = @'
function Invoke-BoundedWrangler {
    param([ValidateSet('deploy','delete')][string]$Operation,[string[]]$Arguments,
        [int]$TimeoutMs = 0)
    if ($Operation -ceq 'deploy') { $script:taskDeployDiagnostic.outcome = 'start-attempted' }
    if ($Operation -ceq 'delete' -and $Scenario -ceq 'delete-hung-before-removal') {
        Add-Content -LiteralPath $TracePath -Value 'delete-attempt-hung'
        $script:taskProcessTreeUncertain = $true
        throw [TimeoutException]::new('Synthetic bounded deletion deadline.')
    }
    $taskOutput = & node $taskCli $Operation @Arguments
    if ($Operation -ceq 'deploy') {
        $script:taskDeployDiagnostic.exitCode = [string]$LASTEXITCODE
        $script:taskDeployDiagnostic.outcome = if ($LASTEXITCODE -eq 0) { 'cli-zero' } else { 'cli-nonzero' }
    }
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic Wrangler operation failed.' }
    if ($Operation -ceq 'deploy' -and $Scenario -ceq 'deploy-hung-after-upload') {
        $script:taskDeployDiagnostic.outcome = 'deadline-exceeded'
        $script:taskDeployDiagnostic.exitCode = 'unobserved'
        $script:taskProcessTreeUncertain = $true
        throw [TimeoutException]::new('Synthetic bounded deployment deadline.')
    }
    if ($Operation -ceq 'deploy' -and $Scenario -ceq 'deploy-kill-unconfirmed') {
        $script:taskDeployDiagnostic.outcome = 'deadline-exceeded'
        $script:taskDeployDiagnostic.exitCode = 'unobserved'
        $script:taskProcessTreeUncertain = $true
        throw [TimeoutException]::new('Synthetic child-tree termination failure.')
    }
    if ($Operation -ceq 'deploy' -and $Scenario -ceq 'deploy-output-cleanup-failed') {
        $script:taskCliOutputCleanupFailed = $true
        throw [InvalidOperationException]::new('Synthetic Wrangler failure with output cleanup error.')
    }
    if ($Operation -ceq 'delete' -and $Scenario -ceq 'delete-hung-after-removal') {
        $script:taskProcessTreeUncertain = $true
        throw [TimeoutException]::new('Synthetic bounded deletion deadline.')
    }
    if ($Operation -ceq 'deploy') {
        $taskUrlFound = $taskOutput -cmatch [regex]::Escape($taskUrl)
        $script:taskDeployDiagnostic.outcome = if ($taskUrlFound) {
            'url-confirmed'
        } else { 'url-missing' }
        return [bool]$taskUrlFound
    }
    return $true
}
'@
$taskDefinition = $taskBoundedDefinitions[0].Extent
$taskSource = $taskSource.Remove($taskDefinition.StartOffset,
    $taskDefinition.EndOffset-$taskDefinition.StartOffset).Insert(
    $taskDefinition.StartOffset,$taskMockBounded)
$taskRunnerDir = $PSScriptRoot
. ([ScriptBlock]::Create($taskSource))
exit $LASTEXITCODE
