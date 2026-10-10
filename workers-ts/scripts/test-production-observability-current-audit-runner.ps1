# Offline TEST-003B runner fault matrix. HTTP and Wrangler are replaced in the
# same PowerShell process before the production source is evaluated.
[CmdletBinding()]
param(
    [ValidateSet('all','success','limited-privilege','disabled-tracking','disabled-activity',
        'request-503','request-timeout','header-missing','malformed-json','malformed-shape',
        'invalid-workflow','invalid-count','query-text-leak','business-value-flag',
        'oversized-body','formal-binding-drift','formal-postflight-drift','foreign-target',
        'marker-drift','temporary-binding-drift','temporary-version-drift',
        'deploy-hung-after-upload','delete-hung-before-removal','delete-hung-after-removal',
        'control-404-unavailable','wrangler-log-cleanup-failed',
        'oversized-wrangler-log','local-log-collision','local-config-collision',
        'deploy-unconfirmed-no-delete',
        'process-tree-timeout')]
    [string]$Scenario = 'all',
    [string]$TracePath
)
$ErrorActionPreference = 'Stop'
$taskRunner = Join-Path $PSScriptRoot 'run-production-observability-current-audit.ps1'
$taskFixture = Join-Path $PSScriptRoot 'fixtures/production-observability-current-aggregate.json'

if ($Scenario -ceq 'all') {
    $taskCases = @('success','limited-privilege','disabled-tracking','disabled-activity',
        'request-503','request-timeout','header-missing','malformed-json','malformed-shape',
        'invalid-workflow','invalid-count','query-text-leak','business-value-flag',
        'oversized-body','formal-binding-drift','formal-postflight-drift','foreign-target',
        'marker-drift','temporary-binding-drift','temporary-version-drift',
        'deploy-hung-after-upload','delete-hung-before-removal','delete-hung-after-removal',
        'control-404-unavailable','wrangler-log-cleanup-failed',
        'oversized-wrangler-log','local-log-collision','local-config-collision',
        'deploy-unconfirmed-no-delete',
        'process-tree-timeout')
    foreach ($taskCase in $taskCases) {
        $taskTrace = Join-Path $env:TEMP ('test003b-offline-' + [Guid]::NewGuid().ToString('N') + '.txt')
        try {
            $taskOutput = & pwsh -NoProfile -File $PSCommandPath -Scenario $taskCase -TracePath $taskTrace 2>&1
            $taskExit = $LASTEXITCODE
            $taskEvidence = ($taskOutput -join "`n") | ConvertFrom-Json -Depth 30
            if ($taskCase -ceq 'process-tree-timeout') {
                if ($taskExit -ne 0 -or $taskEvidence.deployStopped -ne $true -or
                    $taskEvidence.deleteStopped -ne $true -or
                    $taskEvidence.deployTimeoutMarkedUncertain -ne $true -or
                    $taskEvidence.deleteTimeoutMarkedUncertain -ne $true -or
                    $taskEvidence.ownedOutputRemoved -ne $true) {
                    throw 'Bounded process child-tree matrix failed.'
                }
                "$taskCase`: pass"
                continue
            }
            $taskCalls = if (Test-Path -LiteralPath $taskTrace) {
                @(Get-Content -LiteralPath $taskTrace)
            } else { @() }
            $taskDeploys = @($taskCalls | Where-Object { $_ -ceq 'deploy-attempt' }).Count
            $taskDeletes = @($taskCalls | Where-Object { $_ -ceq 'delete-owned' }).Count
            $taskSamples = @($taskCalls | Where-Object { $_ -ceq 'sample-once' }).Count
            $taskExpectedExit = if ($taskCase -ceq 'success') { 0 }
                elseif ($taskCase -in @('limited-privilege','disabled-tracking','disabled-activity')) { 1 }
                else { 2 }
            if ($taskExit -ne $taskExpectedExit -or $taskEvidence.ready -ne ($taskExpectedExit -eq 0)) {
                throw "$taskCase exit or readiness differs: $taskExit."
            }
            if ($taskCase -in @('foreign-target','formal-binding-drift',
                'local-log-collision','local-config-collision')) {
                if ($taskDeploys -ne 0 -or $taskDeletes -ne 0 -or $taskSamples -ne 0 -or
                    $taskEvidence.cleanup.attempted -ne $false) {
                    throw "$taskCase deployed despite preflight failure."
                }
            } else {
                if ($taskDeploys -ne 1 -or $taskEvidence.cleanup.attempted -ne $true) {
                    throw "$taskCase did not attempt exactly one owned deploy."
                }
                if ($taskCase -in @('marker-drift','temporary-binding-drift',
                    'temporary-version-drift','delete-hung-before-removal')) {
                    if ($taskDeletes -ne 0 -or $taskEvidence.cleanup.deleted -ne $false) {
                        throw "$taskCase deleted an unverified or still-present Worker."
                    }
                } elseif ($taskCase -ceq 'deploy-unconfirmed-no-delete') {
                    if ($taskDeletes -ne 0 -or $taskEvidence.cleanup.deleted -ne $false -or
                        $taskEvidence.cleanup.controlPlane404 -ne $true -or
                        $taskEvidence.cleanup.public404 -ne $true) {
                        throw 'Unconfirmed deployment was treated as an owned deletion.'
                    }
                } elseif ($taskCase -ceq 'control-404-unavailable') {
                    if ($taskDeletes -ne 1 -or $taskEvidence.cleanup.controlPlane404 -ne $false -or
                        $taskEvidence.failure -cne 'Temporary Worker cleanup needs independent verification.') {
                        throw 'Unavailable control plane was treated as absence.'
                    }
                } elseif ($taskDeletes -ne 1 -or
                    $taskEvidence.cleanup.controlPlane404 -ne $true -or
                    $taskEvidence.cleanup.public404 -ne $true) {
                    throw "$taskCase did not confirm owned cleanup and dual 404."
                }
            }
            if ($taskCase -in @('success','limited-privilege','disabled-tracking',
                'disabled-activity','request-503','request-timeout','header-missing',
                'malformed-json','malformed-shape','invalid-workflow','invalid-count',
                'query-text-leak','business-value-flag','oversized-body','formal-postflight-drift',
                'wrangler-log-cleanup-failed') -and $taskSamples -ne 1) {
                throw "$taskCase did not issue exactly one authenticated sample."
            }
            if ($taskCase -in @('success','limited-privilege','disabled-tracking','disabled-activity')) {
                if ($taskEvidence.diagnostic.outcome -cne 'complete' -or
                    $taskEvidence.sampleRequestCount -ne 1 -or
                    $taskEvidence.aggregate.safety.queryTextReturned -ne $false -or
                    $taskEvidence.aggregate.safety.businessValuesReturned -ne $false -or
                    $taskEvidence.cleanup.generatedConfigRemoved -ne $true -or
                    $taskEvidence.cleanup.wranglerLogRemoved -ne $true) {
                    throw "$taskCase aggregate or cleanup differs."
                }
            }
            if ($taskCase -ceq 'limited-privilege' -and
                $taskEvidence.aggregate.limitations -cnotcontains 'monitoring_privilege_unavailable') {
                throw 'Limited privilege was not reported.'
            }
            if ($taskCase -ceq 'disabled-tracking' -and
                $taskEvidence.aggregate.limitations -cnotcontains 'track_counts_disabled') {
                throw 'Disabled tracking was not reported.'
            }
            if ($taskCase -in @('deploy-hung-after-upload','delete-hung-before-removal',
                'delete-hung-after-removal') -and
                ($taskEvidence.cleanup.processTreeConfirmedStopped -ne $false -or
                -not $taskEvidence.workerName)) {
                throw 'Wrangler timeout was not marked uncertain with an owned target.'
            }
            if ($taskCase -ceq 'wrangler-log-cleanup-failed') {
                if ($taskEvidence.cleanup.wranglerLogRemoved -ne $false -or
                    $taskEvidence.failure -cne 'Owned Wrangler log or generated config cleanup needs independent verification.' -or
                    @($taskEvidence.cleanup.retainedLocalFiles | Where-Object kind -eq 'wrangler_log').Count -ne 1) {
                    throw 'Owned Wrangler log failure was hidden.'
                }
                # Only this synthetic scenario leaves a uniquely named owned log.
                $taskOwnedLog = Join-Path (Split-Path -Parent $PSScriptRoot) ".cache/$($taskEvidence.workerName)-wrangler.log"
                if (Test-Path -LiteralPath $taskOwnedLog) {
                    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $taskOwnedLog -Force
                }
            }
            if ($taskCase -ceq 'oversized-wrangler-log' -and
                ($taskEvidence.cleanup.wranglerLogSizeBounded -ne $false -or
                $taskEvidence.cleanup.wranglerLogBytes -ne 1048577 -or
                $taskEvidence.cleanup.wranglerLogSha256 -ne $null -or
                $taskEvidence.cleanup.wranglerLogRemoved -ne $true -or
                $taskEvidence.failure -cne 'Owned Wrangler log inspection exceeded reviewed bounds or failed.')) {
                throw 'Oversized owned Wrangler log was not bounded and removed.'
            }
            if ($taskCase -in @('marker-drift','temporary-binding-drift',
                'temporary-version-drift','deploy-hung-after-upload',
                'deploy-unconfirmed-no-delete',
                'delete-hung-before-removal','delete-hung-after-removal',
                'control-404-unavailable')) {
                $taskHeldConfig = Join-Path (Split-Path -Parent $PSScriptRoot) ".cache/$($taskEvidence.workerName).wrangler.jsonc"
                if ($taskEvidence.cleanup.generatedConfigRetainedForRecovery -ne $true -or
                    $taskEvidence.cleanup.generatedConfigRemoved -ne $false -or
                    @($taskEvidence.cleanup.retainedLocalFiles | Where-Object {
                        $_.kind -ceq 'generated_config' -and $_.path -ceq $taskHeldConfig
                    }).Count -ne 1 -or -not (Test-Path -LiteralPath $taskHeldConfig -PathType Leaf)) {
                    throw "$taskCase did not retain its token-free recovery config."
                }
                $taskHeldBody = Get-Content -Raw -LiteralPath $taskHeldConfig
                if ($taskHeldBody -match 'synthetic-offline-token|fixtureSecret') {
                    throw "$taskCase retained sensitive data in its recovery config."
                }
                Microsoft.PowerShell.Management\Remove-Item -LiteralPath $taskHeldConfig -Force
            }
            if ($taskCase -in @('local-log-collision','local-config-collision')) {
                $taskCollisionLeaf = if ($taskCase -ceq 'local-log-collision') {
                    'cinashop-observability-current-audit-aaaaaaaaaaaaaaaa-wrangler.log'
                } else { 'cinashop-observability-current-audit-bbbbbbbbbbbbbbbb.wrangler.jsonc' }
                $taskCollisionPath = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) '.cache') $taskCollisionLeaf
                if ($taskEvidence.cleanup.localPathsOwned -ne $false -or
                    -not (Test-Path -LiteralPath $taskCollisionPath -PathType Leaf) -or
                    (Get-Content -Raw -LiteralPath $taskCollisionPath) -cne 'foreign-local-file') {
                    throw "$taskCase removed or claimed a foreign local path."
                }
                Microsoft.PowerShell.Management\Remove-Item -LiteralPath $taskCollisionPath -Force
            }
            if (($taskOutput -join "`n") -match 'private-connection-or-sql|fixtureSecret|SELECT \* FROM') {
                throw "$taskCase leaked private mock material."
            }
            "$taskCase`: pass"
        } finally {
            if (Test-Path -LiteralPath $taskTrace) {
                Microsoft.PowerShell.Management\Remove-Item -LiteralPath $taskTrace -Force
            }
        }
    }
    exit 0
}

if (-not $TracePath) { throw 'Local trace path required.' }
if ($Scenario -ceq 'process-tree-timeout') {
    $taskSource = Get-Content -Raw -LiteralPath $taskRunner
    $taskTokens = $null; $taskParseErrors = $null
    $taskAst = [Management.Automation.Language.Parser]::ParseInput(
        $taskSource,[ref]$taskTokens,[ref]$taskParseErrors)
    $taskDefinitions = @($taskAst.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Invoke-BoundedWrangler' },$true))
    if (@($taskParseErrors).Count -ne 0 -or $taskDefinitions.Count -ne 1) {
        throw 'Reviewed bounded Wrangler function missing.'
    }
    . ([ScriptBlock]::Create($taskDefinitions[0].Extent.Text))
    $taskRoot = Split-Path -Parent $PSScriptRoot
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot '.cache')
    $taskName = 'test003b-offline-' + [Guid]::NewGuid().ToString('N')
    $taskCli = Join-Path $taskRoot ".cache/$taskName-fixture.cjs"
    $taskNodeFixture = @'
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(process.argv[3], String(child.pid));
setInterval(() => {}, 1000);
'@
    [IO.File]::WriteAllText($taskCli,$taskNodeFixture)
    $taskResults = [ordered]@{ deployStopped = $false; deleteStopped = $false;
        deployTimeoutMarkedUncertain = $false; deleteTimeoutMarkedUncertain = $false;
        ownedOutputRemoved = $false }
    try {
        foreach ($taskOperation in @('deploy','delete')) {
            $taskPidFile = Join-Path $taskRoot ".cache/$taskName-$taskOperation-child.pid"
            $script:taskProcessTreeUncertain = $false
            $taskTimedOut = $false
            try {
                $null = Invoke-BoundedWrangler -Operation $taskOperation `
                    -Arguments @($taskPidFile) -TimeoutMs 500
            } catch [TimeoutException] { $taskTimedOut = $true }
            if (-not $taskTimedOut -or -not $script:taskProcessTreeUncertain -or
                -not (Test-Path -LiteralPath $taskPidFile)) {
                throw 'Bounded process did not prove uncertain timeout.'
            }
            $taskResults["${taskOperation}TimeoutMarkedUncertain"] = $true
            $taskChildPid = [int](Get-Content -Raw -LiteralPath $taskPidFile)
            Start-Sleep -Milliseconds 300
            if (Get-Process -Id $taskChildPid -ErrorAction SilentlyContinue) {
                Stop-Process -Id $taskChildPid -Force -ErrorAction SilentlyContinue
                throw 'Bounded process left its child running.'
            }
            $taskResults["${taskOperation}Stopped"] = $true
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $taskPidFile -Force
        }
        $taskLeftovers = @(Get-ChildItem -LiteralPath (Join-Path $taskRoot '.cache') -File |
            Where-Object { $_.Name -like "$taskName-*.stdout" -or
                $_.Name -like "$taskName-*.stderr" })
        $taskResults.ownedOutputRemoved = $taskLeftovers.Count -eq 0
    } finally {
        if (Test-Path -LiteralPath $taskCli) {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $taskCli -Force
        }
    }
    $taskResults | ConvertTo-Json -Compress
    exit 0
}

$env:CLOUDFLARE_API_TOKEN = 'synthetic-offline-token'
$script:deployed = $false
$script:workerName = $null
$script:marker = $null
$script:formalReadCount = 0
$script:temporaryReadCount = 0
$script:mainVersion = 'cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2'
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
    [pscustomobject]@{ StatusCode = $Status;
        Content = if ($null -eq $Body) { '' } else { $Body | ConvertTo-Json -Depth 30 -Compress };
        Headers = if ($NoStore) { @{ 'Cache-Control' = @('private, no-store, max-age=0') } } else { @{} } }
}
function New-ApiResponse { param([object]$Result)
    New-Response -Status 200 -Body @{ success = $true; result = $Result }
}
function Start-Sleep { param([int]$Seconds) }
function Invoke-WebRequest {
    param([string]$Uri,[string]$Method='GET',[hashtable]$Headers,
        [switch]$SkipHttpErrorCheck,[int]$TimeoutSec)
    if ($Uri -match '/workers/scripts/cinashop-api/deployments$') {
        $script:formalReadCount++
        $taskVersion = if ($Scenario -ceq 'formal-postflight-drift' -and
            $script:formalReadCount -ge 2) { $script:changedVersion } else { $script:mainVersion }
        return New-ApiResponse @{ deployments = @(@{ id = 'main-deployment';
            created_on = '2026-10-10T00:00:00Z';
            versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/settings$') {
        $taskBindings = @($script:bindings)
        if ($Scenario -ceq 'formal-binding-drift') {
            $taskBindings = @($script:bindings | ForEach-Object {
                if ($_.name -ceq 'SAFE_01') { @{ name = 'DRIFT_01'; type = 'plain_text' } }
                else { $_ }
            })
        }
        return New-ApiResponse @{ bindings = $taskBindings }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/versions/cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2$') {
        return New-ApiResponse @{ resources = @{ bindings = @($script:bindings) } }
    }
    if ($Uri -match '/workers/scripts/(?<name>cinashop-observability-current-audit-[0-9a-f]{16})(?<suffix>/.*)?$') {
        $taskSuffix = $Matches.suffix
        if (-not $taskSuffix) {
            if (-not $script:deployed -and $script:workerName -and
                $Scenario -ceq 'control-404-unavailable') { return New-Response -Status 503 }
            if ($Scenario -ceq 'foreign-target' -or $script:deployed) { return New-Response -Status 200 }
            return New-Response -Status 404
        }
        if (-not $script:deployed) { throw 'Mock read an absent temporary Worker.' }
        if ($taskSuffix -ceq '/deployments') {
            $script:temporaryReadCount++
            $taskVersion = if ($Scenario -ceq 'temporary-version-drift' -and
                $script:temporaryReadCount -ge 2) { $script:changedVersion } else { $script:ownedVersion }
            return New-ApiResponse @{ deployments = @(@{ id = 'temporary-deployment';
                created_on = '2026-10-10T00:00:00Z';
                versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
        }
        if ($taskSuffix -match '^/versions/[0-9a-f-]{36}$') {
            $taskMarker = if ($Scenario -ceq 'marker-drift' -and
                $script:temporaryReadCount -ge 2) { 'foreign-marker' } else { $script:marker }
            $taskBinding = if ($Scenario -ceq 'temporary-binding-drift' -and
                $script:temporaryReadCount -ge 2) { '00000000000000000000000000000000' }
                else { 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' }
            return New-ApiResponse @{ annotations = @{ 'workers/message' = $taskMarker };
                resources = @{ bindings = @(
                    @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = $taskBinding },
                    @{ name = 'AUDIT_TOKEN_SHA256'; type = 'plain_text' },
                    @{ name = 'AUDIT_EXPIRES_AT'; type = 'plain_text' }
                ) } }
        }
        throw 'Unexpected temporary control-plane endpoint.'
    }
    if ($Uri -match '^https://cinashop-observability-current-audit-[0-9a-f]{16}\.cinagroup\.workers\.dev(?<path>.*)$') {
        if (-not $script:deployed) { return New-Response -Status 404 }
        $taskPath = $Matches.path
        if (-not $Headers.ContainsKey('X-Audit-Token')) { return New-Response -Status 403 }
        if ($taskPath -cne '/observability') { return New-Response -Status 404 }
        if ($Method -cne 'GET') { return New-Response -Status 405 }
        Add-Content -LiteralPath $TracePath -Value 'sample-once'
        if ($Scenario -ceq 'request-timeout') {
            throw [TimeoutException]::new('private-connection-or-sql')
        }
        if ($Scenario -ceq 'request-503') {
            return New-Response -Status 503 -Body @{ error = 'audit failed'; stage = 'sample';
                category = 'timeout'; extra = 'private-connection-or-sql' }
        }
        if ($Scenario -ceq 'header-missing') { return New-Response -Status 200 -NoStore $false }
        if ($Scenario -ceq 'malformed-json') {
            $taskReply = New-Response -Status 200
            $taskReply.Content = '{private-connection-or-sql'
            return $taskReply
        }
        $taskAudit = Get-Content -Raw -LiteralPath $taskFixture | ConvertFrom-Json -Depth 30
        $taskAudit.generatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        switch ($Scenario) {
            'limited-privilege' { $taskAudit.ready = $false;
                $taskAudit.statementStatistics.authorized = $false;
                $taskAudit.statementStatistics.aggregate = $null; $taskAudit.activity = $null }
            'disabled-tracking' { $taskAudit.ready = $false;
                $taskAudit.settings.track_counts = 'off' }
            'disabled-activity' { $taskAudit.ready = $false;
                $taskAudit.settings.track_activities = 'off'; $taskAudit.activity = $null }
            'malformed-shape' { $taskAudit | Add-Member -NotePropertyName unrelated -NotePropertyValue 'fixtureSecret' }
            'invalid-workflow' { $taskAudit.workflowStatus[0].status = 'private-connection-or-sql' }
            'invalid-count' { $taskAudit.workflowStatus[0].rows = '1 private-connection-or-sql' }
            'query-text-leak' { $taskAudit.statementStatistics | Add-Member -NotePropertyName query -NotePropertyValue 'SELECT * FROM private' }
            'business-value-flag' { $taskAudit.safety.businessValuesReturned = $true }
        }
        if ($Scenario -ceq 'oversized-body') {
            $taskAudit | Add-Member -NotePropertyName unrelated -NotePropertyValue ('x' * 140000)
        }
        return New-Response -Status 200 -Body $taskAudit
    }
    throw 'Unexpected mocked HTTP endpoint.'
}
function Remove-Item {
    param([string]$LiteralPath,[switch]$Force)
    if ($Scenario -ceq 'wrangler-log-cleanup-failed' -and
        $LiteralPath -like '*-wrangler.log') { throw 'Synthetic owned log removal failure.' }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force
}

$taskSource = Get-Content -Raw -LiteralPath $taskRunner
$taskProductionSha = '85dcd3bd1cc2f2a6a836ed9913c2fb5f7f46dd03540894585b75be399cfe36be'
$taskRootExpression = '$taskRoot = Split-Path -Parent $PSScriptRoot'
$taskCliExpression = '$taskCli = Join-Path $taskRoot ''node_modules/wrangler/bin/wrangler.js'''
if ([regex]::Matches($taskSource,[regex]::Escape($taskProductionSha)).Count -ne 1 -or
    [regex]::Matches($taskSource,[regex]::Escape($taskRootExpression)).Count -ne 1 -or
    [regex]::Matches($taskSource,[regex]::Escape($taskCliExpression)).Count -ne 1) {
    throw 'Production runner source pins or root expression changed.'
}
$taskProjection = @($script:bindings | ForEach-Object {
    "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
} | Sort-Object -CaseSensitive)
$taskMockSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes(($taskProjection -join "`n")))).ToLowerInvariant()
$taskSource = $taskSource.Replace($taskProductionSha,$taskMockSha).Replace(
    $taskRootExpression,'$taskRoot = Split-Path -Parent $taskRunnerDir').Replace(
    $taskCliExpression,'$taskCli = $taskRunner')
if ($Scenario -in @('local-log-collision','local-config-collision')) {
    $taskNameExpression = '$taskName = ''cinashop-observability-current-audit-'' + [Guid]::NewGuid().ToString(''N'').Substring(0, 16)'
    if ([regex]::Matches($taskSource,[regex]::Escape($taskNameExpression)).Count -ne 1) {
        throw 'Production random Worker expression changed.'
    }
    $taskSuffix = if ($Scenario -ceq 'local-log-collision') {
        'aaaaaaaaaaaaaaaa'
    } else { 'bbbbbbbbbbbbbbbb' }
    $taskSource = $taskSource.Replace($taskNameExpression,
        "`$taskName = 'cinashop-observability-current-audit-$taskSuffix'")
    $taskCollisionLeaf = if ($Scenario -ceq 'local-log-collision') {
        'cinashop-observability-current-audit-aaaaaaaaaaaaaaaa-wrangler.log'
    } else { 'cinashop-observability-current-audit-bbbbbbbbbbbbbbbb.wrangler.jsonc' }
    $taskCollisionDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.cache'
    $null = New-Item -ItemType Directory -Force -Path $taskCollisionDir
    [IO.File]::WriteAllText((Join-Path $taskCollisionDir $taskCollisionLeaf),'foreign-local-file')
}
$taskTokens = $null; $taskParseErrors = $null
$taskAst = [Management.Automation.Language.Parser]::ParseInput(
    $taskSource,[ref]$taskTokens,[ref]$taskParseErrors)
$taskBounded = @($taskAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-BoundedWrangler' },$true))
if (@($taskParseErrors).Count -ne 0 -or $taskBounded.Count -ne 1) {
    throw 'Reviewed production bounded wrapper missing.'
}
$taskMockBounded = @'
function Invoke-BoundedWrangler {
    param([ValidateSet('deploy','delete')][string]$Operation,[string[]]$Arguments,
        [int]$TimeoutMs = 0)
    if ($Operation -ceq 'deploy') {
        $taskNameIndex = [Array]::IndexOf($Arguments,'--name')
        $taskMarkerIndex = [Array]::IndexOf($Arguments,'--message')
        if ($taskNameIndex -lt 0 -or $taskMarkerIndex -lt 0) { throw 'Missing ownership arguments.' }
        $script:workerName = $Arguments[$taskNameIndex + 1]
        $script:marker = $Arguments[$taskMarkerIndex + 1]
        $taskConfigBody = Get-Content -Raw -LiteralPath $taskConfig | ConvertFrom-Json -Depth 12
        if ($taskConfigBody.name -cne $script:workerName -or
            $taskConfigBody.workers_dev -ne $true -or
            $taskConfigBody.hyperdrive[0].id -cne 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' -or
            $taskConfigBody.main -cne '../test/integration/ProductionObservabilityAuditWorker.ts' -or
            (Get-Content -Raw -LiteralPath $taskConfig).Contains('9748c294e21c49a99579c9cef70102e0')) {
            throw 'Generated config did not use the current formal binding.'
        }
        Add-Content -LiteralPath $TracePath -Value 'deploy-attempt'
        if ($Scenario -ceq 'deploy-unconfirmed-no-delete') {
            throw 'Synthetic Wrangler nonzero before control-plane visibility.'
        }
        $script:deployed = $true
        Add-Content -LiteralPath $TracePath -Value 'deploy-owned'
        if ($Scenario -ceq 'deploy-hung-after-upload') {
            $script:taskProcessTreeUncertain = $true
            throw [TimeoutException]::new('Synthetic deployment deadline.')
        }
        if ($Scenario -ceq 'wrangler-log-cleanup-failed') {
            [IO.File]::WriteAllText($env:WRANGLER_LOG_PATH,'fixtureSecret')
        }
        if ($Scenario -ceq 'oversized-wrangler-log') {
            [IO.File]::WriteAllText($env:WRANGLER_LOG_PATH,('x' * 1048577))
        }
        return "https://$script:workerName.cinagroup.workers.dev"
    }
    if ($Operation -ceq 'delete') {
        if ($Arguments[0] -cne $script:workerName -or -not $script:deployed) {
            throw 'Delete did not target the owned Worker.'
        }
        if ($Scenario -ceq 'delete-hung-before-removal') {
            $script:taskProcessTreeUncertain = $true
            throw [TimeoutException]::new('Synthetic deletion deadline.')
        }
        $script:deployed = $false
        Add-Content -LiteralPath $TracePath -Value 'delete-owned'
        if ($Scenario -ceq 'delete-hung-after-removal') {
            $script:taskProcessTreeUncertain = $true
            throw [TimeoutException]::new('Synthetic deletion deadline.')
        }
        return $true
    }
    throw 'Unexpected Wrangler operation.'
}
'@
$taskSpan = $taskBounded[0].Extent
$taskSource = $taskSource.Remove($taskSpan.StartOffset,
    $taskSpan.EndOffset-$taskSpan.StartOffset).Insert($taskSpan.StartOffset,$taskMockBounded)
$taskRunnerDir = $PSScriptRoot
. ([ScriptBlock]::Create($taskSource))
exit $LASTEXITCODE
